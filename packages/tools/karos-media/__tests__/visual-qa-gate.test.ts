import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { computeToolCostUsd, type GateVerdict } from "@agent-engine/core";
import {
  VisualQaGateInputSchema,
  VisualQaReportSchema,
  createKarosMediaTools,
  createVisualQaGate,
  visualQaFailures,
  type VisionAnalysisClient,
  type VisionPart,
  type VisualQaExpectations,
  type VisualQaReport,
} from "../src/index.js";

/**
 * `video.visualQaGate` — the vision model watches the finished clip.
 *
 * Outcome layering is the thing to get right here (RFC-01 §6): a content
 * verdict, pass or fail, is a `success` outcome carrying the `GateVerdict`,
 * and only a broken review is a `tooling_error` outcome. The tests assert
 * both layers on every branch, because a gate that reported `content_fail`
 * at the wrong layer would either hold a run over an editorial note or let
 * a broken review count as a judgment.
 */

const CTX = { ctx: {} as never };
const TINY_MP4 = Buffer.from("AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64");

const GOOD_REPORT: VisualQaReport = {
  overallScore: 8.5,
  hookLandsInFirstTwoSeconds: true,
  captions: { present: true, legible: true, syncedToSpeech: true },
  artifacts: [],
  brandFrameIntact: true,
  looksAiGenerated: "no",
  notes: ["pacing is tight"],
  beats: [],
};

function expectations(overrides: Partial<VisualQaExpectations> = {}): VisualQaExpectations {
  return { topic: "AI agents and junior developers", captionsExpected: true, voiceoverExpected: true, format: "commentary-clip", ...overrides };
}

/** The vision model, stubbed like `visual-patterns.test.ts` does — and capturing the whole request so the clip part can be asserted. */
function recordingVision(
  response: string | Error | { blockReason: string },
  usage: { promptTokenCount?: number; candidatesTokenCount?: number } | null = { promptTokenCount: 24_000, candidatesTokenCount: 180 },
) {
  const requests: Array<{ model: string; parts: VisionPart[]; config?: Record<string, unknown> }> = [];
  const client: VisionAnalysisClient = {
    models: {
      async generateContent(request) {
        requests.push({ model: request.model, parts: request.contents.flatMap((c) => c.parts), ...(request.config ? { config: request.config } : {}) });
        if (response instanceof Error) throw response;
        if (typeof response === "object") return { promptFeedback: { blockReason: response.blockReason }, ...(usage ? { usageMetadata: usage } : {}) };
        return {
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
          ...(usage ? { usageMetadata: usage } : {}),
        };
      },
    },
  };
  return { client, requests };
}

let dir: string;
let clipPath: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vqa-"));
  clipPath = path.join(dir, "final.mp4");
  await fs.writeFile(clipPath, TINY_MP4);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** The input as a caller sends it — parsed so Zod applies `minimumScore`'s default, exactly what `defineTool` does at runtime. */
function qaInput(raw: z.input<typeof VisualQaGateInputSchema>) {
  return VisualQaGateInputSchema.parse(raw);
}

function verdictOf(outcome: unknown): GateVerdict {
  const o = outcome as { status: string; result?: GateVerdict };
  expect(o.status).toBe("success");
  return o.result!;
}

describe("video.visualQaGate — request shape", () => {
  it("sends a small local clip as inlineData with the right mimeType, alongside the editor prompt", async () => {
    const { client, requests } = recordingVision(JSON.stringify(GOOD_REPORT));
    const tool = createVisualQaGate({ client });
    const outcome = await tool.execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(verdictOf(outcome).verdict).toBe("pass");

    expect(requests).toHaveLength(1);
    const [textPart, clipPart] = requests[0]!.parts;
    expect(textPart).toMatchObject({ text: expect.stringContaining("senior short-form video editor") });
    expect((textPart as { text: string }).text).toContain("AI agents and junior developers");
    expect(clipPart).toEqual({ inlineData: { mimeType: "video/mp4", data: TINY_MP4.toString("base64") } });
    expect(requests[0]!.config).toEqual({ responseMimeType: "application/json" });
    expect(requests[0]!.model).toBe("gemini-2.5-flash");
  });

  it("prefers fileData for a gcsUri even when a local path is also given", async () => {
    const { client, requests } = recordingVision(JSON.stringify(GOOD_REPORT));
    await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, gcsUri: "gs://bucket/runs/r1/final.mp4", expectations: expectations() }), CTX);
    expect(requests[0]!.parts[1]).toEqual({ fileData: { fileUri: "gs://bucket/runs/r1/final.mp4", mimeType: "video/mp4" } });
  });

  it("a clip over the inline ceiling with no gcsUri is a tooling_error, not a silent skip", async () => {
    const { client, requests } = recordingVision(JSON.stringify(GOOD_REPORT));
    const outcome = await createVisualQaGate({ client, maxInlineBytes: 8 }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toMatch(/too large for inline review and no gcsUri given/);
    expect(requests).toHaveLength(0);
  });

  it("honours the model option and VIDEO_QA_MODEL, in that order", async () => {
    const a = recordingVision(JSON.stringify(GOOD_REPORT));
    await createVisualQaGate({ client: a.client, env: { VIDEO_QA_MODEL: "gemini-2.5-pro" } }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(a.requests[0]!.model).toBe("gemini-2.5-pro");
    const b = recordingVision(JSON.stringify(GOOD_REPORT));
    await createVisualQaGate({ client: b.client, model: "explicit", env: { VIDEO_QA_MODEL: "gemini-2.5-pro" } }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(b.requests[0]!.model).toBe("explicit");
  });

  it("the input schema demands at least one of videoPath/gcsUri and defaults minimumScore to 7", () => {
    expect(VisualQaGateInputSchema.safeParse({ expectations: expectations() }).success).toBe(false);
    const parsed = VisualQaGateInputSchema.parse({ gcsUri: "gs://b/c.mp4", expectations: expectations() });
    expect(parsed.minimumScore).toBe(7);
  });
});

describe("video.visualQaGate — verdicts", () => {
  it("passes a clean report with every field rendered as evidence", async () => {
    const { client } = recordingVision(JSON.stringify(GOOD_REPORT));
    const verdict = verdictOf(await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX));
    expect(verdict.verdict).toBe("pass");
    expect(verdict.toolVersion).toBe("1.2.0");
    expect((verdict as { evidence: string[] }).evidence).toEqual([
      "overallScore: 8.5",
      "hookLandsInFirstTwoSeconds: true",
      "captions.present: true",
      "captions.legible: true",
      "captions.syncedToSpeech: true",
      "artifacts: none",
      "brandFrameIntact: true",
      "looksAiGenerated: no",
      "note: pacing is tight",
    ]);
  });

  it("fails below minimumScore — the default 7, and a caller-raised bar", async () => {
    const six = { ...GOOD_REPORT, overallScore: 6 };
    const { client } = recordingVision(JSON.stringify(six));
    const verdict = verdictOf(await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX));
    expect(verdict.verdict).toBe("content_fail");
    expect((verdict as { reason: string }).reason).toMatch(/score 6 is below the minimum 7/);

    const strict = recordingVision(JSON.stringify(GOOD_REPORT));
    const strictVerdict = verdictOf(await createVisualQaGate({ client: strict.client }).execute(qaInput({ videoPath: clipPath, expectations: expectations(), minimumScore: 9 }), CTX));
    expect(strictVerdict.verdict).toBe("content_fail");
  });

  it("fails an obviously AI-looking clip and a caption-less clip when captions were expected; passes the latter when they were not", () => {
    const base = { expectations: VisualQaGateInputSchema.parse({ gcsUri: "gs://b/c.mp4", expectations: expectations() }).expectations, minimumScore: 7 };
    expect(visualQaFailures({ ...GOOD_REPORT, looksAiGenerated: "obviously" }, base)).toEqual(["the clip obviously looks AI-generated"]);
    expect(visualQaFailures({ ...GOOD_REPORT, looksAiGenerated: "slightly" }, base)).toEqual([]);

    const noCaptions = { ...GOOD_REPORT, captions: { present: false, legible: false, syncedToSpeech: false } };
    expect(visualQaFailures(noCaptions, base)).toEqual(["captions were expected but none are present"]);
    expect(visualQaFailures(noCaptions, { ...base, expectations: { ...base.expectations, captionsExpected: false } })).toEqual([]);
  });

  it("scores each beat's footage against its line when the beats are given, names weak ones in evidence, and ignores a beat the caller never named", async () => {
    const beats = [
      { index: 1, start: 0, end: 4, narration: "Your round got smaller. Good." },
      { index: 2, start: 4, end: 10, narration: "A small round forces you to pick one thing." },
    ];
    const report = { ...GOOD_REPORT, beats: [{ index: 1, relevance: 9, note: "an empty desk under a line about focus" }, { index: 2, relevance: 3, note: "a concert under a line about a boardroom" }, { index: 7, relevance: 10, note: "invented" }] };
    const { client, requests } = recordingVision(JSON.stringify(report));
    const outcome = await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations({ format: "original-short", beats }) }), CTX);
    const verdict = verdictOf(outcome) as { verdict: string; evidence: string[]; beats?: Array<{ index: number; relevance: number }> };
    expect(verdict.verdict).toBe("pass");
    expect(verdict.beats).toEqual([
      { index: 1, relevance: 9, note: "an empty desk under a line about focus" },
      { index: 2, relevance: 3, note: "a concert under a line about a boardroom" },
    ]);
    expect(verdict.evidence).toContain("beat 2 relevance: 3 (a concert under a line about a boardroom)");
    // The prompt named every beat with its window and asked for the per-beat shape.
    const prompt = JSON.stringify(requests[0]);
    expect(prompt).toContain('Beat 2 (4.0s–10.0s): \\"A small round forces you to pick one thing.\\"');
    expect(prompt).toContain('\\"beats\\": [{\\"index\\": 1, \\"relevance\\": 0-10');
    // Without beats: no per-beat ask, no beats on the verdict.
    const plain = recordingVision(JSON.stringify(GOOD_REPORT));
    const plainVerdict = verdictOf(await createVisualQaGate({ client: plain.client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX)) as { beats?: unknown[] };
    expect(plainVerdict.beats).toEqual([]);
    expect(JSON.stringify(plain.requests[0])).not.toContain("relevance");
  });

  it("an artefact alone fails neither format since 2026-09-09: it lowers the score and is carried in evidence", () => {
    // Until then any artefact failed an original-short outright, a rule written
    // for generated plates. Original shorts are stock footage and stills now,
    // where "artefact" is a compression quirk the human at the gate should see,
    // not a reason to send the clip back before they do.
    const flicker = { ...GOOD_REPORT, artifacts: ["flicker at 0:04"] };
    const parsed = VisualQaGateInputSchema.parse({ gcsUri: "gs://b/c.mp4", expectations: expectations({ format: "original-short" }) });
    expect(visualQaFailures(flicker, parsed)).toEqual([]);
    const commentary = VisualQaGateInputSchema.parse({ gcsUri: "gs://b/c.mp4", expectations: expectations({ format: "commentary-clip" }) });
    expect(visualQaFailures(flicker, commentary)).toEqual([]);
  });

  it("a fenced JSON answer is accepted; a malformed one is a content_fail verdict that says the MODEL failed to answer", async () => {
    const fenced = recordingVision("```json\n" + JSON.stringify(GOOD_REPORT) + "\n```");
    expect(verdictOf(await createVisualQaGate({ client: fenced.client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX)).verdict).toBe("pass");

    const broken = recordingVision("I think it looks fine overall.");
    const verdict = verdictOf(await createVisualQaGate({ client: broken.client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX));
    expect(verdict.verdict).toBe("content_fail");
    expect((verdict as { evidence: string[] }).evidence[0]).toMatch(/did not parse as the requested JSON shape/);
  });

  it("a blocked prompt is a content_fail verdict carrying the block reason", async () => {
    const { client } = recordingVision({ blockReason: "SAFETY" });
    const verdict = verdictOf(await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX));
    expect(verdict.verdict).toBe("content_fail");
    expect((verdict as { reason: string }).reason).toContain("SAFETY");
  });

  it("a client that throws is a tooling_error OUTCOME, never a verdict", async () => {
    const { client } = recordingVision(new Error("503 UNAVAILABLE"));
    const outcome = await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("503 UNAVAILABLE");
  });

  it("reports not_available without a client, and the report schema is strict about the enum", async () => {
    const outcome = await createVisualQaGate({}).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(outcome.status).toBe("not_available");
    expect(VisualQaReportSchema.safeParse({ ...GOOD_REPORT, looksAiGenerated: "maybe" }).success).toBe(false);
  });
});

describe("video.visualQaGate — billing and wiring", () => {
  it("reports the captured token counts against the two video-qa SKUs, priced above $0", async () => {
    const { client } = recordingVision(JSON.stringify(GOOD_REPORT), { promptTokenCount: 30_000, candidatesTokenCount: 200 });
    const outcome = await createVisualQaGate({ client }).execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    const usage = (outcome as unknown as { usage: Array<{ model: string; unit: string; quantity: number }> }).usage;
    expect(usage).toEqual([
      { model: "gemini-2.5-flash-video-qa-input-token", unit: "input-token", quantity: 30_000 },
      { model: "gemini-2.5-flash-video-qa-output-token", unit: "output-token", quantity: 200 },
    ]);
    expect(computeToolCostUsd(usage)).toBeGreaterThan(0);
  });

  it("is registered by createKarosMediaTools on the videoQaClient option, and not_available when that is null", async () => {
    const { client, requests } = recordingVision(JSON.stringify(GOOD_REPORT));
    const registry = createKarosMediaTools({ env: {}, generationClient: null, videoGenerationClient: null, visionClient: null, scraper: null, videoQaClient: client });
    const outcome = await registry["video.visualQaGate"]!.execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX);
    expect(verdictOf(outcome).verdict).toBe("pass");
    expect(requests).toHaveLength(1);

    const off = createKarosMediaTools({ env: {}, generationClient: null, videoGenerationClient: null, visionClient: null, scraper: null, videoQaClient: null });
    expect((await off["video.visualQaGate"]!.execute(qaInput({ videoPath: clipPath, expectations: expectations() }), CTX)).status).toBe("not_available");
  });
});
