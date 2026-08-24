import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const SlideSchema = z.object({
  n: z.number().int().positive(),
  template: z.string().min(1),
  fields: z.record(z.string(), z.string()).default({}),
  images: z.record(z.string(), z.string()).default({}),
  /**
   * Pre-assembled markup for `{{html:key}}` slots — a list archetype's rows,
   * a comparison's columns. Distinct from `fields` because `fields` is escaped
   * and this is not: only the calling agent's own fragment builder writes
   * here, never a model directly. See `fillTemplate`.
   */
  htmlFragments: z.record(z.string(), z.string()).default({}),
});
export type Slide = z.infer<typeof SlideSchema>;

export const CanvasSchema = z.object({
  w: z.number().int().positive().default(1080),
  h: z.number().int().positive().default(1440),
  /** Must be exactly 2 — the QA PNG floor depends on it (legacy `render.mjs`'s hard requirement, ported verbatim). */
  scale: z.number().default(2),
  slides_min: z.number().int().default(6),
  slides_max: z.number().int().default(8),
});

export const RenderCarouselInputSchema = z.object({
  client: z.string().min(1),
  postId: z.string().min(1),
  /** Repo-relative directory holding the slide HTML templates. */
  templateDir: z.string().min(1),
  /** Repo-relative directory PNGs are written to. */
  outDir: z.string().min(1),
  /** Repo root every `templateDir`/`outDir`/image path is resolved and bounds-checked against. */
  repoRoot: z.string().min(1),
  slides: z.array(SlideSchema).min(1),
  canvas: CanvasSchema.default(() => ({ w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 })),
  readyFlag: z.string().min(1).default("__CAROUSEL_READY__"),
});
export type RenderCarouselInput = z.infer<typeof RenderCarouselInputSchema>;

export interface RenderCarouselResult {
  rendered: Array<{
    n: number;
    /** A signed GCS URL when `mediaStore` is configured and signing succeeded, `gcsUri` when it didn't, or a local filesystem path when no `mediaStore` was supplied at all. */
    path: string;
    /** `gs://<bucket>/...` — always populated alongside `path` when `mediaStore` is configured, even if `path` itself holds a (possibly time-limited) signed URL, so a caller has a durable reference to fall back to. */
    gcsUri?: string;
  }>;
}

/**
 * `assertInside` (legacy `render.mjs`): every path is repo-relative only —
 * refuses absolute paths and URL-shaped strings, refuses paths that escape
 * `root` via `..`. Ported verbatim as the tooling half of the renderer's
 * three-way outcome contract (RFC-03 §4): a bad path is a TOOLING failure
 * (`legacy exit 2`), never mistaken for a content problem.
 */
export function assertInside(root: string, rel: string, what: string): string {
  if (path.isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:\/\//i.test(rel)) {
    throw new Error(`${what} must be a repo-relative path, got "${rel}"`);
  }
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`${what} escapes the repo root: "${rel}"`);
  }
  return resolved;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escapes a field value for insertion as HTML text content.
 *
 * `fields` carries MODEL-AUTHORED copy — a headline, a pull-quote, a
 * takeaway. Substituting that raw (which this did until 2026-08) means a
 * headline containing `&` or `<` either breaks the markup or injects into it:
 * "Q4 & Q1" silently renders as an entity-less parse error, and anything
 * angle-bracketed becomes live DOM in a page this renderer then screenshots.
 * Neither is hypothetical once a slide's copy is generated rather than
 * hand-written, and the archetype library multiplies the number of fields
 * this applies to.
 *
 * A template that genuinely needs markup in a slot asks for it explicitly via
 * `{{html:key}}` — see `fillTemplate`.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Three substitution forms, deliberately distinct:
 *
 * - `{{key}}`      — escaped text. The default, and what every model-authored
 *                    field uses.
 * - `{{html:key}}` — raw markup, for a fragment THIS CODEBASE assembled
 *                    (a list's rows, a comparison's two columns). The caller
 *                    is responsible for having escaped the text inside it;
 *                    `buildFragment` in the instagram-agent's `slides-data.ts`
 *                    is the only producer today, and it escapes per value.
 * - `{{image:key}}`— a `file://` URL for a bounds-checked local image path.
 *
 * Splitting escaped from raw is what lets the archetype templates hold real
 * structure (rows, columns) without making every copy field an injection
 * point.
 */
function fillTemplate(
  html: string,
  fields: Record<string, string>,
  imagePaths: Record<string, string>,
  htmlFragments: Record<string, string> = {},
): string {
  let filled = html;
  // Fragments first: a fragment may itself contain `{{key}}` slots that the
  // escaped pass below should then fill (a row template reusing `accentColor`).
  for (const [key, fragment] of Object.entries(htmlFragments)) {
    filled = filled.replaceAll(`{{html:${key}}}`, fragment);
  }
  for (const [key, value] of Object.entries(fields)) {
    filled = filled.replaceAll(`{{${key}}}`, escapeHtmlText(value));
  }
  for (const [key, absolutePath] of Object.entries(imagePaths)) {
    filled = filled.replaceAll(`{{image:${key}}}`, `file://${absolutePath.replace(/\\/g, "/")}`);
  }
  // Any `{{...}}` slot the caller supplied nothing for is emptied rather than
  // left in the pixels. One archetype template legitimately has optional
  // slots (a stat's source line, a headline's kicker), and a literal
  // "{{sourceLine}}" screenshotted onto a client's carousel is the worst of
  // the available outcomes.
  filled = filled.replace(/\{\{(?:html:|image:)?[A-Za-z0-9_]+\}\}/g, "");
  return filled;
}

/**
 * Validates every slide's paths and required files WITHOUT touching
 * Playwright/Chromium — the path-guard + missing-file half of the legacy
 * renderer's `--self-test` mode, which deliberately runs Chromium-free.
 * Distinguishes the two failure classes the legacy contract requires never
 * be confused: a bad/escaping path is TOOLING (`toolingError`, legacy exit
 * 2); a well-formed path to a file that doesn't exist is CONTENT
 * (`contentFail`, legacy exit 1 — "the post had no viable image" is a real
 * content problem, not a bug in the renderer).
 */
export async function validateRenderInputs(
  input: RenderCarouselInput,
): Promise<{ ok: true; resolvedTemplateDir: string; resolvedOutDir: string } | { ok: false; kind: "tooling" | "content"; reason: string }> {
  if (input.canvas.scale !== 2) {
    return { ok: false, kind: "tooling", reason: `canvas.scale must be exactly 2, got ${input.canvas.scale} — the QA PNG floor depends on it` };
  }

  let resolvedTemplateDir: string;
  let resolvedOutDir: string;
  try {
    resolvedTemplateDir = assertInside(input.repoRoot, input.templateDir, "templateDir");
    resolvedOutDir = assertInside(input.repoRoot, input.outDir, "outDir");
  } catch (err) {
    return { ok: false, kind: "tooling", reason: err instanceof Error ? err.message : String(err) };
  }

  for (const slide of input.slides) {
    let templatePath: string;
    try {
      templatePath = assertInside(resolvedTemplateDir, slide.template, `slide ${slide.n} template`);
    } catch (err) {
      return { ok: false, kind: "tooling", reason: err instanceof Error ? err.message : String(err) };
    }
    if (!(await fileExists(templatePath))) {
      return { ok: false, kind: "tooling", reason: `slide ${slide.n}: template "${slide.template}" not found — a missing template is a tooling failure, not a content one` };
    }

    for (const [key, imageRel] of Object.entries(slide.images)) {
      let imagePath: string;
      try {
        imagePath = assertInside(input.repoRoot, imageRel, `slide ${slide.n} image "${key}"`);
      } catch (err) {
        return { ok: false, kind: "tooling", reason: err instanceof Error ? err.message : String(err) };
      }
      if (!(await fileExists(imagePath))) {
        return { ok: false, kind: "content", reason: `slide ${slide.n}: image "${key}" at "${imageRel}" does not exist — no viable picture holds the whole post` };
      }
    }
  }

  return { ok: true, resolvedTemplateDir, resolvedOutDir };
}

/**
 * `publish.renderCarousel` (RFC-03 §4, step 08) — a typed-outcome port of
 * legacy `render.mjs`'s three-way exit contract (`0` rendered / `1` content
 * failure / `2` tooling failure), mapped onto `success` / `content_fail` /
 * `tooling_error` so a broken render can never be recorded as a content
 * verdict and vice versa. Chromium/Playwright is imported lazily, inside
 * this function, specifically so `validateRenderInputs` above (the
 * `--self-test` equivalent) can run in environments without Playwright
 * installed. Font-loading (`document.fonts.ready`) is awaited AFTER the
 * ready-flag wait, deliberately, so a font-load failure never ships a
 * fallback face.
 */

// The two callbacks below run inside the Chromium page (Playwright serializes and executes them
// in-browser), never in this Node process — this package's tsconfig has no DOM lib, so `window`/
// `document` are declared `any` locally rather than pulling a full DOM lib in for two call sites.
declare const window: Record<string, unknown>;
declare const document: { body?: { dataset?: Record<string, string> }; fonts: { ready: Promise<unknown> } };

function readyFlagCheck(flag: string): boolean {
  return window[flag] === true || document.body?.dataset?.["ready"] === flag;
}

function fontsReady(): Promise<unknown> {
  return document.fonts.ready;
}

/**
 * Persists one rendered slide's PNG bytes: uploads to `mediaStore` when one
 * is configured (the deliverable then carries a durable `gs://` reference —
 * and a signed URL too, when the runtime can sign one — instead of a local
 * scratch path that wouldn't survive past this process), or writes to
 * `outPath` on local disk otherwise (unit tests and any environment with no
 * `GCS_MEDIA_BUCKET` configured — Task 3's "mock/local fallbacks remain
 * functional"). Split out from `execute` below so it's testable without a
 * real Chromium page in front of it.
 */
export async function persistRenderedSlide(
  buffer: Buffer,
  outPath: string,
  objectPath: string,
  mediaStore: GcsArtifactStoreLike | undefined,
): Promise<{ path: string; gcsUri?: string }> {
  if (!mediaStore) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, buffer);
    return { path: outPath };
  }
  const { gcsUri, signedUrl } = await mediaStore.upload(objectPath, buffer, { contentType: "image/png" });
  return { path: signedUrl ?? gcsUri, gcsUri };
}

/**
 * `mediaStore`, when supplied, routes every rendered PNG through GCS instead
 * of `outDir` (Task 1: "store GCS URLs... instead of local scratch paths") —
 * omit it (the default) to keep the exact prior local-disk behavior.
 */
export function createRenderCarousel(mediaStore?: GcsArtifactStoreLike) {
  return defineTool<RenderCarouselInput, RenderCarouselResult>({
    name: "publish.renderCarousel",
    version: TOOL_VERSION,
    inputSchema: RenderCarouselInputSchema,
    async execute(input) {
      const validation = await validateRenderInputs(input);
      if (!validation.ok) {
        return validation.kind === "tooling" ? toolingError(validation.reason) : contentFail(validation.reason);
      }
      const { resolvedTemplateDir, resolvedOutDir } = validation;

      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        return toolingError(`playwright is not installed/available: ${err instanceof Error ? err.message : String(err)}`);
      }

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: input.canvas.w, height: input.canvas.h },
          deviceScaleFactor: input.canvas.scale,
        });

        const rendered: RenderCarouselResult["rendered"] = [];
        for (const slide of input.slides) {
          const templatePath = assertInside(resolvedTemplateDir, slide.template, `slide ${slide.n} template`);
          const html = await fs.readFile(templatePath, "utf8");

          const resolvedImages: Record<string, string> = {};
          for (const [key, imageRel] of Object.entries(slide.images)) {
            resolvedImages[key] = assertInside(input.repoRoot, imageRel, `slide ${slide.n} image "${key}"`);
          }

          const filled = fillTemplate(html, slide.fields, resolvedImages, slide.htmlFragments);

          /*
           * THE PAGE IS NAVIGATED TO, NOT SET.
           *
           * `page.setContent(filled)` leaves the document's URL as
           * `about:blank`, and Chromium refuses to load `file://`
           * sub-resources from a document that is not itself `file://`. Every
           * hero image was therefore blocked — and the template's
           * `onerror="this.style.display='none'"` hid the broken image exactly
           * as designed for a genuinely missing photo, so the failure had no
           * symptom at all: the render succeeded, the QA gate passed, the slide
           * came out looking like a deliberate text-only design, and a live
           * prep run's carousel had all eight slides flat despite Tier 0, the
           * harvesters and generation all having supplied vetted images.
           *
           * Writing the filled HTML beside the PNG and navigating to it gives
           * the document a `file://` origin, which is allowed to load `file://`
           * images. It lands in `resolvedOutDir` — already bounds-checked and
           * already where this step writes — and is removed after the
           * screenshot, so a run leaves the same artifacts it always did.
           */
          const pagePath = path.join(resolvedOutDir, `slide-${slide.n}.html`);
          await fs.writeFile(pagePath, filled, "utf8");
          try {
            await page.goto(`file://${pagePath.replace(/\\/g, "/")}`, { waitUntil: "load" });
          } finally {
            // Removed even if navigation threw: the catch below turns that into
            // a tooling error, and leaving half-written pages behind would make
            // the next run's output directory ambiguous.
            await fs.rm(pagePath, { force: true });
          }
          // These callbacks run inside the browser page (serialized by Playwright), not in this
          // Node process — this file's tsconfig has no DOM lib, so `window`/`document` are typed `any`
          // via the ambient declarations below rather than pulling in a full DOM lib for one call site.
          await page.waitForFunction(readyFlagCheck, input.readyFlag);
          await page.evaluate(fontsReady);

          const buffer = await page.screenshot();
          const outPath = path.join(resolvedOutDir, `slide-${slide.n}.png`);
          const objectPath = `instagram/${input.client}/${input.postId}/slide-${slide.n}.png`;
          const persisted = await persistRenderedSlide(buffer, outPath, objectPath, mediaStore);
          rendered.push({ n: slide.n, ...persisted });
        }

        return success<RenderCarouselResult>({ rendered });
      } catch (err) {
        return toolingError(`publish.renderCarousel: rendering failed — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await browser.close();
      }
    },
  });
}
