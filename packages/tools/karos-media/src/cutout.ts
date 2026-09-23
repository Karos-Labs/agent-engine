import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.0.0 — new (2026-09-23): a product lifted off its studio background.
const TOOL_VERSION = "1.0.0";

export type CutoutOutcome =
  | { ok: true; data: Uint8ClampedArray; bbox: { x: number; y: number; w: number; h: number }; coverage: number }
  | { ok: false; reason: string };

/**
 * Removes a UNIFORM background from an RGBA frame: the studio shot of a
 * product on white, grey or a flat colour.
 *
 * ## Why only uniform, and why say so
 *
 * The Karos Labs reference lifts a Liquid Death can off its ground and sets it
 * on the plate; a product photographed on a seamless background is the common
 * case for a client's own catalogue. A general segmentation model is not
 * available in this deployment, and a heuristic that "tries" on a busy
 * photograph returns a ragged hole where the product should be. So this reads
 * the frame's border first and REFUSES, with the measured reason, when the
 * border is not one colour; a refusal leaves the caller its photograph.
 *
 * ## How
 *
 * The background colour is the per-channel median of the border. Every pixel
 * connected to the border within `tolerance` of it is background (a flood
 * fill, so a white label on the product survives as long as the product's own
 * outline separates it from the edge). Foreground pixels touching the
 * background within twice the tolerance are feathered, so the edge does not
 * read as cut with scissors.
 *
 * SELF-CONTAINED ON PURPOSE: no imports, no helpers, no constants outside its
 * body. The tool passes this function's source to the browser, which is what
 * decodes JPEG and WebP here, so anything it closed over would be undefined
 * there.
 */
export function removeUniformBackground(input: Uint8ClampedArray | number[], width: number, height: number, tolerance = 28): CutoutOutcome {
  const data = new Uint8ClampedArray(input);
  const total = width * height;
  if (width < 16 || height < 16 || data.length !== total * 4) return { ok: false, reason: `not a usable frame (${width}x${height})` };

  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
  const channel = (c: number): number => {
    const values = border.map((i) => data[i * 4 + c]!).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  };
  const bg = [channel(0), channel(1), channel(2)];
  const dist = (i: number): number => {
    const dr = data[i * 4]! - bg[0]!;
    const dg = data[i * 4 + 1]! - bg[1]!;
    const db = data[i * 4 + 2]! - bg[2]!;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const uniform = border.filter((i) => dist(i) <= tolerance).length / border.length;
  if (uniform < 0.9) {
    return { ok: false, reason: `the background is not one colour (only ${Math.round(uniform * 100)}% of the border is within ${tolerance} of its median); a cutout needs a studio shot` };
  }

  const isBackground = new Uint8Array(total);
  const queue: number[] = [];
  for (const i of border) {
    if (!isBackground[i] && dist(i) <= tolerance) {
      isBackground[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % width;
    const y = (i - x) / width;
    const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
    for (const n of neighbours) {
      if (n >= 0 && !isBackground[n] && dist(n) <= tolerance) {
        isBackground[n] = 1;
        queue.push(n);
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let foreground = 0;
  for (let i = 0; i < total; i++) {
    const x = i % width;
    const y = (i - x) / width;
    if (isBackground[i]) {
      data[i * 4 + 3] = 0;
      continue;
    }
    foreground++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const touches = (x > 0 && isBackground[i - 1]) || (x < width - 1 && isBackground[i + 1]) || (y > 0 && isBackground[i - width]) || (y < height - 1 && isBackground[i + width]);
    if (touches) {
      const d = dist(i);
      if (d < tolerance * 2) data[i * 4 + 3] = Math.round((data[i * 4 + 3]! * (d - tolerance)) / tolerance);
    }
  }

  const coverage = foreground / total;
  if (coverage < 0.02) return { ok: false, reason: `almost nothing is left after the background (${(coverage * 100).toFixed(1)}% of the frame); the subject may be the same colour as the ground` };
  if (coverage > 0.9) return { ok: false, reason: `the subject fills ${(coverage * 100).toFixed(0)}% of the frame; there is no background to lift it off` };
  return { ok: true, data, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, coverage };
}

export const CutoutInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Paths in and out are relative to it and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as the other media tools do."),
  image: z.string().min(1).describe("Repo-relative path to the product photograph (PNG, JPEG or WebP)."),
  tolerance: z.number().int().min(4).max(80).default(28).describe("How far from the background colour a pixel may be and still count as background."),
});
export type CutoutInput = z.input<typeof CutoutInputSchema>;

export interface CutoutResult {
  /** Repo-relative path to a transparent PNG trimmed to the subject. */
  path: string;
  width: number;
  height: number;
  /** Share of the ORIGINAL frame the subject covered. */
  coverage: number;
}

/** Decodes, cuts out and re-encodes one image. Injectable so tests never launch Chromium. */
export type CutoutRunner = (bytes: Buffer, mimeType: string, tolerance: number) => Promise<{ ok: true; png: Buffer; width: number; height: number; coverage: number } | { ok: false; reason: string }>;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * The default runner: Chromium decodes (so JPEG and WebP work with no image
 * library), `removeUniformBackground` runs in the page, and the canvas
 * encodes the trimmed transparent PNG.
 */
async function chromiumRunner(bytes: Buffer, mimeType: string, tolerance: number): ReturnType<CutoutRunner> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A string, not a function: this package compiles without the DOM
    // library, and the page is the only place `Image` and `canvas` exist.
    const script = `(async () => {
      const cut = (${removeUniformBackground.toString()});
      const img = new Image();
      img.src = ${JSON.stringify(`data:${mimeType};base64,${bytes.toString("base64")}`)};
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(img, 0, 0);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const outcome = cut(frame.data, canvas.width, canvas.height, ${tolerance});
      if (!outcome.ok) return outcome;
      context.putImageData(new ImageData(outcome.data, canvas.width, canvas.height), 0, 0);
      const out = document.createElement("canvas");
      out.width = outcome.bbox.w;
      out.height = outcome.bbox.h;
      out.getContext("2d").drawImage(canvas, outcome.bbox.x, outcome.bbox.y, outcome.bbox.w, outcome.bbox.h, 0, 0, outcome.bbox.w, outcome.bbox.h);
      return { ok: true, png: out.toDataURL("image/png").split(",")[1], width: out.width, height: out.height, coverage: outcome.coverage };
    })()`;
    const answer = (await page.evaluate(script)) as { ok: true; png: string; width: number; height: number; coverage: number } | { ok: false; reason: string };
    if (!answer.ok) return answer;
    return { ok: true, png: Buffer.from(answer.png, "base64"), width: answer.width, height: answer.height, coverage: answer.coverage };
  } finally {
    await browser.close();
  }
}

/**
 * `media.cutout` — a product lifted off a uniform studio background, as a
 * transparent PNG trimmed to the subject, so a plate can set the object on its
 * own ground (the Karos Labs reference's Liquid Death can).
 *
 * A busy background is a `content_fail` with the measured reason, never a
 * ragged cutout; the caller keeps the photograph.
 */
export function createCutout(options: { runner?: CutoutRunner } = {}) {
  const runner = options.runner ?? chromiumRunner;
  return defineTool<CutoutInput, CutoutResult>({
    name: "media.cutout",
    description:
      "Lifts a product off a UNIFORM studio background (white, grey or one flat colour) and returns a transparent PNG trimmed to the subject. A photograph whose background is not one colour is refused with the measured reason rather than cut badly.",
    version: TOOL_VERSION,
    inputSchema: CutoutInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof CutoutInputSchema>;
      const root = path.resolve(input.repoRoot);
      const source = path.resolve(root, input.image);
      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(root, relDir);
      if (!source.startsWith(root + path.sep) || !absDir.startsWith(root + path.sep)) {
        return toolingError(`media.cutout: a path escaped repoRoot (image="${input.image}", runId="${input.runId}")`);
      }
      const mimeType = MIME[path.extname(source).toLowerCase()];
      if (mimeType === undefined) return contentFail(`media.cutout: ${input.image} is not a PNG, JPEG or WebP`);

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(source);
      } catch (error) {
        return contentFail(`media.cutout: could not read ${input.image}: ${(error as Error).message}`);
      }

      let outcome: Awaited<ReturnType<CutoutRunner>>;
      try {
        outcome = await runner(bytes, mimeType, input.tolerance);
      } catch (error) {
        return toolingError(`media.cutout: the browser could not process ${input.image}: ${(error as Error).message}`);
      }
      if (!outcome.ok) return contentFail(`media.cutout: ${input.image}: ${outcome.reason}`);

      const stem = `${path.basename(source, path.extname(source))}-cutout.png`;
      try {
        await fs.mkdir(absDir, { recursive: true });
        await fs.writeFile(path.join(absDir, stem), outcome.png);
      } catch (error) {
        return toolingError(`media.cutout: could not write the cutout: ${(error as Error).message}`);
      }
      return success<CutoutResult>({ path: `${relDir}/${stem}`, width: outcome.width, height: outcome.height, coverage: outcome.coverage });
    },
  });
}
