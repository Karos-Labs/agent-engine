import { z } from "zod";
import type { GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { DEFAULT_VISION_MODEL, type VisionAnalysisClient, type VisionPart } from "./visual-patterns.js";

// 1.0.0 — new (2026-09-24, RFC-26 Phase 2): a vision model reads each
// harvested exemplar's frames and grades its CRAFT, separately from its
// engagement, and records its design DNA. Frames are copied to the media
// bucket first, because Instagram's CDN links are signed and expire.
// 1.0.1: every input property carries a description (the registry test); no behaviour change.
// 1.1.0 (2026-09-25): grades are calibrated on the benchmark accounts' breakouts (calibrateCraft), raw kept alongside; an exemplar is a breakout or top quarter with calibrated craft 4+.
// 1.2.0 (2026-09-26, owner reference covers): the cover vocabulary names the
// looks the owner's high-like references use and the renderer is growing
// (annotated-photo, doodle, ui-collage, object-on-ground, abstract-3d), and a
// new `coverIdea` records WHAT the cover shows about the post: the two
// highest-liked references drew the post's idea literally (a scale for "hype
// vs reality", two bunches side by side for "how to choose"). A value the
// judge was not asked for still reads as `other`, so older entries parse.
const TOOL_VERSION = "1.2.0";

const MAX_IMAGE_BYTES = 4_000_000;
const RATE_LIMIT_RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

export const JudgeExemplarsInputSchema = z.object({
  posts: z
    .array(
      z.object({
        ref: z.string().min(1).describe("The caller's handle for this post (its URL), echoed back."),
        handle: z.string().min(1),
        role: z.enum(["client", "competitor", "reference"]),
        format: z.enum(["carousel", "reel", "single"]),
        frames: z.array(z.string().url()).min(1).max(20),
        hook: z.string().default(""),
        likes: z.number().int().min(0).default(0),
        comments: z.number().int().min(0).default(0),
        views: z.number().int().min(0).optional(),
        percentile: z.number().min(0).max(1).optional(),
        outlier: z.boolean().optional().describe("The harvest's breakout flag: 2x (3x for a reel) its own account's median."),
      }),
    )
    .min(1)
    .max(40)
    .describe("Harvested posts to judge (from research.harvestInstagramExemplars), each with its frames' image URLs."),
  framesPerPost: z.number().int().min(1).max(8).default(5).describe("Cover plus the next frames. A carousel's craft shows by slide 5."),
  concurrency: z.number().int().min(1).max(8).default(4).describe("Posts judged at once; bounded because the Vertex quota is shared."),
  minCraft: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(4)
    .describe(
      "CALIBRATED craft an exemplar needs besides its engagement: 4 = strong next to the benchmark accounts' own breakouts, which `calibrateCraft` anchors at 4.",
    ),
});
export type JudgeExemplarsInput = z.input<typeof JudgeExemplarsInputSchema>;

/**
 * The categories a post's DNA is read into. Every list ends in `other`: the
 * first live run (2026-09-24) came back with "moodboard", "none" and "split",
 * and a closed enum threw the whole judgement away for one unfamiliar word.
 */
export const DNA_VALUES = {
  coverType: ["photo-full-bleed", "photo-framed", "person", "product", "typographic", "illustration", "screenshot", "logo", "collage", "moodboard", "annotated-photo", "doodle", "ui-collage", "object-on-ground", "abstract-3d", "other"],
  coverIdea: ["literal-metaphor", "side-by-side", "bold-claim", "big-number", "question", "person", "product-shot", "topic-photo", "other"],
  picturePlacement: ["full-bleed", "inset", "split", "none", "mixed", "other"],
  textDensity: ["none", "low", "medium", "high"],
  typeStyle: ["serif", "sans", "mixed", "script", "mono", "none", "other"],
  emphasis: ["highlight-block", "colour-word", "underline", "weight", "hero-element", "none", "other"],
  device: ["figure", "quote", "list", "comparison", "chart", "none", "other"],
  groundStyle: ["flat-light", "flat-dark", "brand-colour", "photo", "texture", "gradient", "split", "other"],
  hookPattern: ["question", "number", "contrarian", "how-to", "list", "statement", "story", "other"],
} as const;

/** An enum that reads an unfamiliar value as `other` (or `none`) instead of failing the post. */
function lenientEnum<const T extends readonly [string, ...string[]]>(values: T) {
  const fallback = (values.includes("other" as T[number]) ? "other" : values[0]) as T[number];
  return z.preprocess((v) => (typeof v === "string" && (values as readonly string[]).includes(v.toLowerCase()) ? v.toLowerCase() : fallback), z.enum(values));
}

/** What one post's frames are made of. Every field is a CATEGORY a template can act on, never prose to copy. */
export const DesignDnaSchema = z.object({
  coverType: lenientEnum(DNA_VALUES.coverType),
  coverIdea: lenientEnum(DNA_VALUES.coverIdea),
  picturePlacement: lenientEnum(DNA_VALUES.picturePlacement),
  elementGroupsPerSlide: z.coerce.number().int().min(0).max(12),
  textDensity: lenientEnum(DNA_VALUES.textDensity),
  typeStyle: lenientEnum(DNA_VALUES.typeStyle),
  emphasis: lenientEnum(DNA_VALUES.emphasis),
  device: lenientEnum(DNA_VALUES.device),
  groundStyle: lenientEnum(DNA_VALUES.groundStyle),
  palette: z.preprocess((v) => (Array.isArray(v) ? v.filter((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/u.test(c)).slice(0, 5) : []), z.array(z.string())),
  hookPattern: lenientEnum(DNA_VALUES.hookPattern),
});
export type DesignDna = z.infer<typeof DesignDnaSchema>;

const JudgementSchema = z.object({
  craft: z.coerce.number().int().min(1).max(5),
  craftReason: z.string().min(1),
  dna: DesignDnaSchema,
  standout: z.string().min(1).describe("The one thing this post does that a template could learn."),
});

export interface JudgedExemplar {
  ref: string;
  handle: string;
  role: "client" | "competitor" | "reference";
  /** The calibrated grade (see `calibrateCraft`); what `exemplar` reads. */
  craft: number;
  /** What the vision model said, before calibration. */
  rawCraft: number;
  craftReason: string;
  standout: string;
  dna: DesignDna;
  /** `gs://` paths of the copied frames (reference-only), when a media store is configured. */
  storedFrames: string[];
  /** Kept as an exemplar: a breakout (or top quarter) of its own account AND calibrated craft >= `minCraft`. Popular but plain posts are "what this audience rewards", never a look to copy. */
  exemplar: boolean;
}

export interface CraftCalibration {
  /** Benchmark posts the scale was anchored on: reference accounts' breakouts (their top quarter when fewer than three broke out). */
  anchors: number;
  anchorMedianRaw?: number;
  /** Added to every raw grade in this run, 0..2. */
  shift: number;
  note: string;
}

/** Where a proven benchmark post belongs on the scale: "strong". */
export const ANCHOR_CRAFT = 4;
const MAX_SHIFT = 2;

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Anchors the judge's scale on the benchmark accounts' proven hits
 * (2026-09-25). The first live run graded @reputeforge, the owner's
 * ground-truth account, mostly 2-3 out of 5: the model's idea of "strong"
 * was stricter than the market's and the owner's. A reference account's
 * breakout is, by definition, a post both the owner and that audience chose,
 * so the scale is moved until those posts sit at `ANCHOR_CRAFT`. The shift is
 * only ever upward and at most `MAX_SHIFT`, is applied to every post in the
 * run alike (the ORDER the model gave is kept), and is recorded with the raw
 * grade so it can be audited.
 */
export function calibrateCraft(posts: ReadonlyArray<{ role: string; rawCraft: number; outlier?: boolean | undefined; percentile?: number | undefined }>): CraftCalibration {
  const references = posts.filter((p) => p.role === "reference");
  let anchors = references.filter((p) => p.outlier === true);
  if (anchors.length < 3) anchors = references.filter((p) => p.outlier === true || (p.percentile ?? 0) >= 0.75);
  if (anchors.length < 3) return { anchors: anchors.length, shift: 0, note: "fewer than three benchmark breakouts were judged, so the raw scale stands" };
  const anchorMedianRaw = medianOf(anchors.map((a) => a.rawCraft));
  const shift = Math.max(0, Math.min(MAX_SHIFT, Math.round(ANCHOR_CRAFT - anchorMedianRaw)));
  return {
    anchors: anchors.length,
    anchorMedianRaw,
    shift,
    note:
      shift === 0
        ? `benchmark breakouts already sit at ${anchorMedianRaw} raw, so the raw scale stands`
        : `benchmark breakouts sat at ${anchorMedianRaw} raw; every grade in this run moved up ${shift} so they sit at ${ANCHOR_CRAFT}`,
  };
}

export interface JudgeExemplarsResult {
  calibration: CraftCalibration;
  judged: JudgedExemplar[];
  failures: Array<{ ref: string; reason: string }>;
  model: string;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

async function fetchFrame(fetchImpl: typeof fetch, url: string): Promise<{ bytes: Buffer; mimeType: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    return { error: `fetch failed: ${(error as Error).message}` };
  }
  if (!response.ok) return { error: `fetch returned ${response.status} (an expired CDN link reads as 403)` };
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) return { error: `content-type "${mimeType}" is not an image` };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return { error: `unusable size ${bytes.byteLength}` };
  return { bytes, mimeType };
}

/** The prompt. It asks for categories, and says plainly that popularity is not craft. */
export function judgeInstructions(post: z.output<typeof JudgeExemplarsInputSchema>["posts"][number], shown: number): string {
  return [
    `You are a senior social designer judging one Instagram ${post.format} from @${post.handle} (${shown} frame(s) shown, in swipe order).`,
    "Judge CRAFT only: hierarchy, legibility at feed size, restraint (three or four element groups), picture quality and cropping, type pairing, colour discipline, and whether the cover stops a scroll.",
    "Engagement is NOT craft. A post can be popular and plain, or beautiful and ignored; grade what you see.",
    "craft: 1 = amateur, 2 = template-default, 3 = competent, 4 = strong, 5 = reference-grade.",
    "dna: the categories that describe how the frames are BUILT (read them from the pixels, not the caption).",
    "standout: one sentence naming the single transferable technique (e.g. 'one highlighted word per headline in the brand colour'). Never a topic.",
    post.hook.length > 0 ? `The caption's first line, for hookPattern only: "${post.hook.slice(0, 160)}"` : "No caption line was supplied; hookPattern reads the cover's headline.",
    "coverType: annotated-photo = a photo with drawn labels or arrows pointing into it; doodle = hand-drawn line illustration or handwritten type; ui-collage = product screens or UI cards arranged around the headline; object-on-ground = one isolated object or cutout on a plain ground beside or above the type; abstract-3d = an abstract rendered form (glass, gradient, glow) as the hero.",
    "coverIdea: what the cover SHOWS about the post. literal-metaphor = the picture draws the post's claim (a scale for a trade-off, a maze for complexity); side-by-side = two things compared in one frame; bold-claim = the headline alone carries it; big-number = one figure dominates; topic-photo = a picture merely related to the subject.",
    `Allowed dna values (use exactly one of each list): ${Object.entries(DNA_VALUES).map(([k, v]) => `${k}=${v.join("|")}`).join("; ")}; elementGroupsPerSlide is an integer; palette is up to five #rrggbb colours.`,
    'Return JSON: {"craft":n,"craftReason":"...","standout":"...","dna":{"coverType":"...","coverIdea":"...","picturePlacement":"...","elementGroupsPerSlide":n,"textDensity":"...","typeStyle":"...","emphasis":"...","device":"...","groundStyle":"...","palette":["#rrggbb"],"hookPattern":"..."}}',
  ].join("\n");
}

/**
 * `media.judgeExemplars` — RFC-26 Phase 2.
 *
 * For each harvested post: copy its first `framesPerPost` frames to the media
 * bucket (reference-only: nothing downstream may republish them), then ask a
 * vision model for a craft grade and a design-DNA record. `exemplar` is the
 * conjunction the RFC defines: top quarter of its own account AND craft 4+.
 */
export function createJudgeExemplars(options: { client?: VisionAnalysisClient | undefined; model?: string; fetchImpl?: typeof fetch; mediaStore?: GcsArtifactStoreLike | undefined; backoffMs?: number }) {
  // 5s, 10s, 15s between retries of a 429; a test passes 0.
  const backoffMs = options.backoffMs ?? 5_000;
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return defineTool<JudgeExemplarsInput, JudgeExemplarsResult>({
    name: "media.judgeExemplars",
    description:
      "A vision model grades the CRAFT (1-5, separate from engagement) of harvested Instagram posts and records each one's design DNA (cover type, cover idea, picture placement, element groups, text density, type, emphasis, device, ground, palette, hook pattern). Frames are copied to the media bucket first, reference-only. Marks exemplar = top quarter of its account AND craft 4+.",
    version: TOOL_VERSION,
    inputSchema: JudgeExemplarsInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof JudgeExemplarsInputSchema>;
      if (options.client === undefined) return notAvailable("media.judgeExemplars: no vision backend configured — set GEMINI_VERTEX_PROJECT_ID");
      const client = options.client;
      const judged: JudgedExemplar[] = [];
      const failures: Array<{ ref: string; reason: string }> = [];
      let promptTokens = 0;
      let outputTokens = 0;

      const judgeOne = async (post: (typeof input.posts)[number], index: number): Promise<void> => {
        const parts: VisionPart[] = [];
        const storedFrames: string[] = [];
        const frames = post.frames.slice(0, input.framesPerPost);
        const images: VisionPart[] = [];
        for (const [f, url] of frames.entries()) {
          const got = await fetchFrame(fetchImpl, url);
          if ("error" in got) continue;
          images.push({ inlineData: { data: got.bytes.toString("base64"), mimeType: got.mimeType } });
          if (options.mediaStore !== undefined) {
            const ext = got.mimeType === "image/png" ? "png" : got.mimeType === "image/webp" ? "webp" : "jpg";
            const objectPath = `clients/${ctx.clientSlug}/exemplars/frames/${post.handle}-${index}-${f + 1}.${ext}`;
            try {
              await options.mediaStore.upload(objectPath, got.bytes, { contentType: got.mimeType });
              storedFrames.push(`gs://${options.mediaStore.bucketName}/${objectPath}`);
            } catch {
              /* a failed copy loses the archive, not the judgement */
            }
          }
        }
        if (images.length === 0) {
          failures.push({ ref: post.ref, reason: "no frame could be fetched (Instagram CDN links expire; harvest and judge in the same run)" });
          return;
        }
        parts.push({ text: judgeInstructions(post, images.length) }, ...images);
        let text: string | undefined;
        // A 429 is the shared Vertex quota, not this post: 5 of 20 posts in
        // the first live run were lost to it. Back off and retry, bounded.
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await client.models.generateContent({ model, contents: [{ role: "user", parts }], config: { responseMimeType: "application/json" } });
            promptTokens += response.usageMetadata?.promptTokenCount ?? 0;
            outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
            text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
            break;
          } catch (error) {
            const message = (error as Error).message;
            if (attempt < RATE_LIMIT_RETRIES && /429|RESOURCE_EXHAUSTED|Resource exhausted/iu.test(message)) {
              await sleep(backoffMs * (attempt + 1));
              continue;
            }
            failures.push({ ref: post.ref, reason: `vision call failed: ${message.slice(0, 200)}` });
            return;
          }
        }
        const parsed = (() => {
          try {
            return JudgementSchema.safeParse(JSON.parse(stripCodeFence(text ?? "")));
          } catch {
            return undefined;
          }
        })();
        if (parsed === undefined || !parsed.success) {
          failures.push({ ref: post.ref, reason: "the judgement did not parse as the requested shape" });
          return;
        }
        const j = parsed.data;
        judged.push({
          ref: post.ref,
          handle: post.handle,
          role: post.role,
          craft: j.craft,
          rawCraft: j.craft,
          craftReason: j.craftReason,
          standout: j.standout,
          dna: j.dna,
          storedFrames,
          exemplar: false,
          ...(post.outlier !== undefined ? { outlier: post.outlier } : {}),
          ...(post.percentile !== undefined ? { percentile: post.percentile } : {}),
        } as JudgedExemplar & { outlier?: boolean; percentile?: number });
      };

      const queue = input.posts.map((post, index) => ({ post, index }));
      const workers = Array.from({ length: Math.min(input.concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) await judgeOne(next.post, next.index);
      });
      await Promise.all(workers);

      if (judged.length === 0) return toolingError(`media.judgeExemplars: no post could be judged — ${failures.map((f) => f.reason).slice(0, 3).join("; ")}`);
      const calibration = calibrateCraft(judged as Array<JudgedExemplar & { outlier?: boolean; percentile?: number }>);
      const final: JudgedExemplar[] = (judged as Array<JudgedExemplar & { outlier?: boolean; percentile?: number }>).map(({ outlier, percentile, ...j }) => {
        const craft = Math.min(5, j.rawCraft + calibration.shift);
        const proven = outlier === true || (percentile ?? 0) >= 0.75;
        return { ...j, craft, exemplar: proven && craft >= input.minCraft };
      });
      final.sort((a, b) => Number(b.exemplar) - Number(a.exemplar) || b.craft - a.craft);
      return success<JudgeExemplarsResult>({ calibration, judged: final, failures, model }, [
        { model: "gemini-3.8-flash-vision-analysis-input-token", unit: "input-token", quantity: promptTokens },
        { model: "gemini-3.8-flash-vision-analysis-output-token", unit: "output-token", quantity: outputTokens },
      ]);
    },
  });
}
