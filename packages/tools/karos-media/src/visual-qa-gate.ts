import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { stripCodeFence, type VisionAnalysisClient, type VisionPart } from "./visual-patterns.js";

// 1.1.0 (2026-09-09): an original short is stock footage and stills, not
// generated video — the rubric stops treating real footage as a defect, the
// hook counts as landed when it has started within two seconds, and an
// artefact lowers the score instead of failing the clip outright.
const TOOL_VERSION = "1.1.0";

/**
 * `video.visualQaGate` — a vision model WATCHES the finished clip before it
 * reaches the human gate.
 *
 * Every other gate in the clip pipeline (`cut_check`, `graphic_qa`,
 * `brand_assets_check`) reads numbers off the file: durations, pixel
 * coverage, alpha channels. None of them can see that a generated plate's
 * hands morph, that the hook line landed four seconds late, or that the
 * captions drifted off the speech. Those are exactly the defects that make a
 * TikTok read as machine-made, and until now the only thing catching them
 * was the reviewer. This gate asks Gemini the questions a senior short-form
 * editor would ask and turns the answers into a `GateVerdict`, so a bad clip
 * goes back to the producer (bounded by `maxRevisions`) instead of to a
 * person.
 *
 * ## Outcome layering (RFC-01 §6, `karos-video/src/gate-helpers.ts`)
 *
 * A content verdict — pass OR content_fail — travels as a `success` outcome
 * carrying the `GateVerdict`; only a broken review (client threw, clip
 * unreadable, too large with nowhere to stage it) is a `tooling_error`
 * outcome. A model response that does not parse as the requested JSON is
 * reported as `content_fail` with the parse error in evidence rather than as
 * a tooling error: the spec chose that so an unreadable review sends the
 * clip back rather than holding the run, and the evidence line says
 * plainly that the model, not the clip, is what failed to answer.
 *
 * ## Billing
 *
 * Per token, off `usageMetadata`, against the two `gemini-2.5-flash-video-qa-*`
 * SKUs — a distinct id from the visual-pattern rows for the same model, so a
 * run's cost report tells "read the client's old posts" apart from "QA'd the
 * clip we just rendered".
 */

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export const VisualQaExpectationsSchema = z.object({
  topic: z.string().min(1).max(400).describe("What the clip is about, so the reviewer can judge whether the footage and hook serve it."),
  hookLine: z.string().max(300).optional().describe("The opening line the clip is meant to land in its first two seconds."),
  captionsExpected: z.boolean().describe("Whether burned-in captions should be present. A caption-free clip fails when this is true."),
  voiceoverExpected: z.boolean().describe("Whether a voiceover should be audible; steers the caption-sync check."),
  brandColors: z.array(z.string().regex(HEX6)).optional().describe("The client's palette (hex6), so an off-brand frame is noticed."),
  language: z.string().optional().describe("BCP-47 language the captions/voiceover should be in."),
  format: z
    .enum(["commentary-clip", "original-short"])
    .describe("Which pipeline produced it. An `original-short` is stock footage and stills under a voice; a `commentary-clip` is cut from licensed source footage. Since 2026-09-09 neither is judged for generation artefacts as a hard rule: an artefact lowers the score and is reported in evidence."),
});
export type VisualQaExpectations = z.infer<typeof VisualQaExpectationsSchema>;

export const VisualQaGateInputSchema = z
  .object({
    videoPath: z.string().min(1).optional().describe("Path to the rendered clip. Sent inline when it is at or under the inline ceiling (18 MB)."),
    gcsUri: z.string().regex(/^gs:\/\/.+/).optional().describe("A `gs://` copy of the clip. Preferred when present — Vertex reads it directly, whatever its size."),
    expectations: VisualQaExpectationsSchema.describe("What the clip is supposed to be — topic, hook, whether captions/voiceover are expected, brand palette, language, format — so the reviewer judges against intent, not taste."),
    minimumScore: z.number().min(1).max(10).default(7).describe("The overall score below which the clip is sent back."),
  })
  .refine((value) => value.videoPath !== undefined || value.gcsUri !== undefined, {
    message: "at least one of videoPath or gcsUri is required",
    path: ["videoPath"],
  });
export type VisualQaGateInput = z.infer<typeof VisualQaGateInputSchema>;

/** What the model is asked to return. Parsed strictly — a malformed review is reported, never coerced into a verdict. */
export const VisualQaReportSchema = z.object({
  overallScore: z.number().min(1).max(10),
  hookLandsInFirstTwoSeconds: z.boolean(),
  captions: z.object({
    present: z.boolean(),
    legible: z.boolean(),
    syncedToSpeech: z.boolean(),
  }),
  artifacts: z.array(z.string()).default([]),
  brandFrameIntact: z.boolean(),
  looksAiGenerated: z.enum(["no", "slightly", "obviously"]),
  notes: z.array(z.string()).default([]),
});
export type VisualQaReport = z.infer<typeof VisualQaReportSchema>;

export interface VisualQaGateOptions {
  /** The vision model. Absent → `not_available` per call, never a construction-time throw. */
  client?: VisionAnalysisClient | undefined;
  /** Model id (`VIDEO_QA_MODEL`). The default is the priced, in-catalogue one. */
  model?: string | undefined;
  env?: Record<string, string | undefined>;
  /** Vertex's inline request ceiling is ~20 MB for the whole request; 18 MB leaves room for the prompt. Tests lower it. */
  maxInlineBytes?: number;
}

export const DEFAULT_VIDEO_QA_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_INLINE_BYTES = 18 * 1024 * 1024;

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Gemini requires a `mimeType` on both inline and file parts; a clip with an unknown extension is refused rather than labelled mp4 and hoped for. */
function videoMimeFor(location: string): string | undefined {
  return VIDEO_MIME_BY_EXTENSION[path.extname(location.split("?")[0]!).toLowerCase()];
}

function buildReviewPrompt(expectations: VisualQaExpectations): string {
  const brief: string[] = [
    "You are a senior short-form video editor reviewing a TikTok before it is published. Watch the whole clip, sound on.",
    "",
    "What this clip is supposed to be:",
    `- Topic: ${expectations.topic}`,
    `- Format: ${expectations.format === "original-short" ? "an original short: real stock footage and photographs under a voiceover, one shot per beat. Real footage is the intent, not a defect. Judge whether each shot fits what is being said at that moment; footage unrelated to the narration is the main failure to look for." : "a commentary clip cut from licensed source footage — judge the edit, not the source's own production quality"}`,
    expectations.hookLine !== undefined
      ? `- The opening line: "${expectations.hookLine}". hookLandsInFirstTwoSeconds is true when this line has STARTED (spoken or on screen) within the first two seconds; it does not have to finish by then.`
      : "- The hook must have started (spoken or on screen) within the first two seconds.",
    `- Burned-in captions expected: ${expectations.captionsExpected ? "yes" : "no"}`,
    `- Voiceover expected: ${expectations.voiceoverExpected ? "yes" : "no"}`,
    expectations.language !== undefined ? `- Language of captions/speech: ${expectations.language}` : undefined,
    expectations.brandColors !== undefined && expectations.brandColors.length > 0
      ? `- Brand colours the frame (bars, header, caption styling) should use: ${expectations.brandColors.join(", ")}`
      : undefined,
    "",
    "Answer with JSON only, no prose outside it, in exactly this shape:",
    "{",
    '  "overallScore": 1-10 (10 = publish as-is; 7 = acceptable; below 7 = send back),',
    '  "hookLandsInFirstTwoSeconds": true|false,',
    '  "captions": {"present": true|false, "legible": true|false, "syncedToSpeech": true|false},',
    '  "artifacts": ["only genuine defects you saw: morphing, warped hands or faces, flicker, frozen frames, black frames, letterboxing inside the frame"],',
    '  "brandFrameIntact": true|false (bars/header/logo present, not cropped or covered),',
    '  "looksAiGenerated": "no"|"slightly"|"obviously",',
    '  "notes": ["anything else the editor should hear, one observation per line"]',
    "}",
    "",
    "Be exact and unforgiving: an artefact you are unsure about belongs in notes, not artifacts; an artefact you saw belongs in artifacts even if brief.",
    "If captions are absent, set present=false and legible=false and syncedToSpeech=false.",
  ].filter((line): line is string => line !== undefined);
  return brief.join("\n");
}

/** Every field of the report as one evidence line, so a reviewer (or the producer's revision prompt) sees the whole picture, not just the failing rule. */
function renderEvidence(report: VisualQaReport): string[] {
  return [
    `overallScore: ${report.overallScore}`,
    `hookLandsInFirstTwoSeconds: ${report.hookLandsInFirstTwoSeconds}`,
    `captions.present: ${report.captions.present}`,
    `captions.legible: ${report.captions.legible}`,
    `captions.syncedToSpeech: ${report.captions.syncedToSpeech}`,
    `artifacts: ${report.artifacts.length > 0 ? report.artifacts.join("; ") : "none"}`,
    `brandFrameIntact: ${report.brandFrameIntact}`,
    `looksAiGenerated: ${report.looksAiGenerated}`,
    ...report.notes.map((note) => `note: ${note}`),
  ];
}

/** The gate's rules, pure so the thresholds are testable without a client. Returns the reasons the clip fails, or none. */
export function visualQaFailures(report: VisualQaReport, input: Pick<VisualQaGateInput, "expectations" | "minimumScore">): string[] {
  const reasons: string[] = [];
  if (report.overallScore < input.minimumScore) {
    reasons.push(`overall score ${report.overallScore} is below the minimum ${input.minimumScore}`);
  }
  if (report.looksAiGenerated === "obviously") {
    reasons.push("the clip obviously looks AI-generated");
  }
  if (input.expectations.captionsExpected && !report.captions.present) {
    reasons.push("captions were expected but none are present");
  }
  return reasons;
}

export function createVisualQaGate(options: VisualQaGateOptions = {}) {
  const env = options.env ?? {};
  const model = options.model ?? env["VIDEO_QA_MODEL"]?.trim() ?? DEFAULT_VIDEO_QA_MODEL;
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;

  return defineTool<VisualQaGateInput, GateVerdict>({
    name: "video.visualQaGate",
    description:
      "Has a vision model watch the finished TikTok as a senior short-form editor would — hook timing, caption presence/legibility/sync, rendering artefacts, brand frame, how AI-made it looks — and returns a GateVerdict. content_fail below the minimum score, on an obviously-generated look, on missing expected captions, or on any artefact in an original short. Reports not_available when no vision client is configured.",
    version: TOOL_VERSION,
    inputSchema: VisualQaGateInputSchema,
    async execute(input) {
      const client = options.client;
      if (client === undefined) {
        return notAvailable("video QA is not configured for this deployment (no Vertex project) — the clip proceeds to the human gate unreviewed");
      }

      // The clip part. `gcsUri` wins whenever it is given: Vertex reads the
      // object itself, so size stops mattering and no bytes transit here.
      let clipPart: VisionPart;
      if (input.gcsUri !== undefined) {
        const mimeType = videoMimeFor(input.gcsUri) ?? "video/mp4";
        clipPart = { fileData: { fileUri: input.gcsUri, mimeType } };
      } else {
        const videoPath = input.videoPath!;
        const mimeType = videoMimeFor(videoPath);
        if (mimeType === undefined) {
          return toolingError(`video.visualQaGate: "${videoPath}" has no recognised video extension — refused, never guessed`);
        }
        let size: number;
        try {
          size = (await fs.stat(videoPath)).size;
        } catch (error) {
          return toolingError(`video.visualQaGate: cannot read the clip at ${videoPath} — ${(error as Error).message}`);
        }
        if (size === 0) {
          return toolingError(`video.visualQaGate: the clip at ${videoPath} is empty`);
        }
        if (size > maxInlineBytes) {
          return toolingError(
            `video.visualQaGate: clip too large for inline review and no gcsUri given (${size} bytes, inline ceiling ${maxInlineBytes})`,
          );
        }
        clipPart = { inlineData: { mimeType, data: (await fs.readFile(videoPath)).toString("base64") } };
      }

      let responseText: string | undefined;
      let promptTokens = 0;
      let outputTokens = 0;
      let blockReason: string | undefined;
      try {
        const response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: buildReviewPrompt(input.expectations) }, clipPart] }],
          config: { responseMimeType: "application/json" },
        });
        promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
        outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
        blockReason = response.promptFeedback?.blockReason;
        responseText = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? undefined;
      } catch (error) {
        return toolingError(`video.visualQaGate: the vision model call failed — ${(error as Error).message}`);
      }

      const usage = [
        { model: "gemini-2.5-flash-video-qa-input-token", unit: "input-token", quantity: promptTokens },
        { model: "gemini-2.5-flash-video-qa-output-token", unit: "output-token", quantity: outputTokens },
      ];

      if (blockReason) {
        return success<GateVerdict>(
          {
            verdict: "content_fail",
            evidence: [`the vision model refused to review this clip (${blockReason})`],
            reason: `the vision model blocked the review: ${blockReason}`,
            toolVersion: TOOL_VERSION,
          },
          usage,
        );
      }

      if (responseText === undefined || responseText.trim().length === 0) {
        return success<GateVerdict>(
          {
            verdict: "content_fail",
            evidence: ["the vision model returned no text — the review did not happen, the clip was not judged"],
            reason: "the vision model returned no review text",
            toolVersion: TOOL_VERSION,
          },
          usage,
        );
      }

      let report: VisualQaReport;
      try {
        report = VisualQaReportSchema.parse(JSON.parse(stripCodeFence(responseText)));
      } catch (error) {
        return success<GateVerdict>(
          {
            verdict: "content_fail",
            evidence: [`the vision model's review did not parse as the requested JSON shape — ${(error as Error).message.slice(0, 400)}`],
            reason: "the vision model's review was malformed; the clip could not be judged",
            toolVersion: TOOL_VERSION,
          },
          usage,
        );
      }

      const evidence = renderEvidence(report);
      const failures = visualQaFailures(report, input);
      if (failures.length > 0) {
        return success<GateVerdict>({ verdict: "content_fail", evidence, reason: failures.join("; "), toolVersion: TOOL_VERSION }, usage);
      }
      // The billed units, spelled out at the success return (the shape
      // `cost-accuracy-golden.test.ts` reads for) — the same two SKUs the
      // early returns above report through `usage`.
      return success<GateVerdict>({ verdict: "pass", evidence, toolVersion: TOOL_VERSION }, [
        { model: "gemini-2.5-flash-video-qa-input-token", unit: "input-token", quantity: promptTokens },
        { model: "gemini-2.5-flash-video-qa-output-token", unit: "output-token", quantity: outputTokens },
      ]);
    },
  });
}
