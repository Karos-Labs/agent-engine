import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { DEFAULT_VISION_MODEL, type VisionAnalysisClient } from "./visual-patterns.js";

// 1.0.0 — new (2026-09-26): where named things sit in a picture, so a slide can
// label them with an arrow (the owner's grapes reference: "sour, unripe" and
// "sweet, ripe" pointing into one photograph of two bunches).
const TOOL_VERSION = "1.0.0";

const RATE_LIMIT_RETRIES = 3;
const MAX_IMAGE_BYTES = 8_000_000;
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const LocateInImageInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The image path is resolved inside it."),
  image: z.string().min(1).describe("Repo-relative path of the picture to read."),
  targets: z.array(z.string().min(1).max(60)).min(1).max(3).describe("What to find, in the words the slide uses (e.g. 'the bunch with the brown stem')."),
});
export type LocateInImageInput = z.infer<typeof LocateInImageInputSchema>;

/** A box in the picture's own coordinates, each edge 0..1 of its width or height. */
export interface LocatedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface LocatedTarget {
  target: string;
  found: boolean;
  confidence: number;
  box?: LocatedBox;
}
export interface LocateInImageResult {
  located: LocatedTarget[];
  model: string;
}

export const LOCATE_INSTRUCTIONS =
  'Find each named thing in the picture. Reply with JSON only: {"items":[{"target":"<as given>","found":true|false,"confidence":0..1,"box_2d":[ymin,xmin,ymax,xmax]}]}, one item per target in the order given. box_2d is integers 0-1000 of the picture\'s height and width, tight around the thing. found is false, with no box, when the thing is not clearly visible; never guess.';

/** Gemini's `box_2d` ([ymin, xmin, ymax, xmax], 0-1000) as a 0..1 box, or undefined when it is not a real box. */
export function boxFrom2d(raw: unknown): LocatedBox | undefined {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  const [ymin, xmin, ymax, xmax] = (raw as number[]).map((v) => Math.max(0, Math.min(1000, v)) / 1000) as [number, number, number, number];
  if (xmax - xmin < 0.02 || ymax - ymin < 0.02) return undefined;
  return { x0: xmin, y0: ymin, x1: xmax, y1: ymax };
}

async function readLocal(repoRoot: string, relative: string): Promise<{ data: string; mimeType: string } | { error: string }> {
  const root = path.resolve(repoRoot);
  const abs = path.resolve(repoRoot, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { error: "path escapes repoRoot" };
  const mimeType = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (mimeType === undefined) return { error: `unsupported image extension "${path.extname(abs)}"` };
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(abs);
  } catch (error) {
    return { error: `could not read the file: ${(error as Error).message}` };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return { error: `unusable size ${bytes.byteLength}` };
  return { data: bytes.toString("base64"), mimeType };
}

export function createLocateInImage(options: { client?: VisionAnalysisClient; model?: string; backoffMs?: number } = {}) {
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const backoffMs = options.backoffMs ?? 2000;
  return defineTool<LocateInImageInput, LocateInImageResult>({
    name: "media.locateInImage",
    description:
      "Find where up to three named things sit in one picture (a box per thing, 0..1 of the picture, with a confidence), so a slide can label them with an arrow. One vision call; a thing that is not clearly visible comes back found: false.",
    version: TOOL_VERSION,
    inputSchema: LocateInImageInputSchema,
    async execute(args) {
      const client = options.client;
      if (client === undefined) return notAvailable<LocateInImageResult>("no Vertex credential is configured for vision");
      const loaded = await readLocal(args.repoRoot, args.image);
      if ("error" in loaded) return toolingError<LocateInImageResult>(`could not read ${args.image}: ${loaded.error}`);
      let text: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await client.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ inlineData: loaded }, { text: `${LOCATE_INSTRUCTIONS}\n\nTargets:\n${args.targets.map((t, i) => `${i + 1}. ${t}`).join("\n")}` }] }],
            config: { responseMimeType: "application/json" },
          });
          text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
          break;
        } catch (error) {
          const message = (error as Error).message;
          if (attempt < RATE_LIMIT_RETRIES && /429|RESOURCE_EXHAUSTED|Resource exhausted/iu.test(message)) {
            await sleep(backoffMs * (attempt + 1));
            continue;
          }
          return toolingError<LocateInImageResult>(`locate call failed: ${message.slice(0, 200)}`);
        }
      }
      let items: unknown[];
      try {
        const parsed = JSON.parse((text ?? "").replace(/^```(?:json)?\s*|\s*```$/gu, "")) as { items?: unknown };
        items = Array.isArray(parsed.items) ? parsed.items : [];
      } catch {
        return toolingError<LocateInImageResult>("the locate reply was not JSON");
      }
      const located: LocatedTarget[] = args.targets.map((target, i) => {
        const item = (items[i] ?? {}) as Record<string, unknown>;
        const box = item["found"] === true ? boxFrom2d(item["box_2d"]) : undefined;
        const confidence = typeof item["confidence"] === "number" ? Math.max(0, Math.min(1, item["confidence"])) : 0;
        return box === undefined ? { target, found: false, confidence } : { target, found: true, confidence, box };
      });
      return success({ located, model });
    },
  });
}
