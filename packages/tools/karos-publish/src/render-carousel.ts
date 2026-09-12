import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { measureSlidePng, type SlideMetrics, type SlideProbe } from "./slide-metrics.js";

/**
 * 1.1.0 — `measure` and `probe`. Both default off, so every existing caller
 * gets byte-identical behaviour and an unchanged result shape.
 *
 * 1.2.0 — `metrics` gains the CONTENT mask (`contentOccupiedShare`,
 * `largestEmptyContentRect`, `largestEmptyContentRectShare`). Additive: a
 * caller reading the 1.1.0 fields reads the same numbers. See
 * `slide-metrics.ts`'s "CONTENT vs DECORATION" comment for why a second mask
 * exists — a decorative ground field satisfied the first one on its own.
 *
 * 1.3.0 — `probe.overflow` gains a BLOCK-START limb. The result shape is
 * unchanged, but the meaning of the field is not: a page whose content
 * escapes the TOP of its parent now reports `overflow: true` where it used to
 * report clean, because `scrollHeight` describes an overflow region that only
 * grows downward. Not additive — a caller that gates on `probe.overflow` will
 * see slides fail that used to pass, and those slides were always broken. See
 * `probePage`'s "THE BLOCK-START LIMB" comment.
 *
 * 1.3.1 — NO BEHAVIOUR CHANGE, and the patch digit is the point. The only
 * edit was `probePage`'s "WHAT IS STILL BLIND" comment, which records the
 * 48-render sweep that decided AGAINST a third limb on the inline axis (all
 * 30 escapes are `.diamond`, hung 3-4px for optical alignment). A rendered
 * slide measures identically on 1.3.0 and 1.3.1.
 *
 * It is bumped anyway because `check-tool-versions.ts` compares a tool file
 * against the PREVIOUS COMMIT on the branch, not against `origin/main` — so
 * running the gate locally with `--base origin/main` passed while CI, which
 * passes the push's before-sha, failed. The gate is right to be strict: it
 * cannot read a diff and know a change was inert, and a rule with an
 * "obviously harmless" exemption stops being a rule. A patch digit is the
 * honest way to satisfy it — semver already means "nothing a caller can
 * observe moved", which is exactly the claim being made here.
 */
const TOOL_VERSION = "1.3.1";

// n/template/fields/images have no existing TSDoc to transcribe (SCRUM-293 flag) — descriptions
// below synthesized from fillTemplate's/validateRenderInputs' usage of each field.
export const SlideSchema = z.object({
  n: z.number().int().positive().describe("This slide's position number in the carousel."),
  template: z.string().min(1).describe("Repo-relative path (under templateDir) of this slide's HTML template."),
  fields: z.record(z.string(), z.string()).default({}).describe("Model-authored copy substituted into the template's {{key}} slots, HTML-escaped before insertion."),
  images: z.record(z.string(), z.string()).default({}).describe("Repo-relative image paths substituted into the template's {{image:key}} slots."),
  htmlFragments: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Pre-assembled markup for {{html:key}} slots — a list archetype's rows, a comparison's columns. Distinct from fields because fields is escaped and this is not: only the calling agent's own fragment builder writes here, never a model directly.",
    ),
  measure: z
    .object({
      groundHex: z.string().optional().describe("This slide's ground token (`--bg`). Anchors the measurement: on a full-bleed photograph the modal colour IS the photograph, and a flat-background share against a photograph's dominant tone means nothing."),
      accentHex: z.string().optional().describe("This slide's resolved accent. Without it accentShare is 0 — an accent cannot be measured against an accent nobody named."),
      foregroundHex: z
        .string()
        .optional()
        .describe(
          "This slide's foreground token, accepted so a caller can pass the whole token triple it already holds. No emitted metric anchors on it: ink is measured as 'not the ground', because a photograph and a scrim are ink too, not only glyph colour.",
        ),
    })
    .optional()
    .describe("The palette this slide was built from, used only when `measure` is set on the input. Purely an anchor — it never changes what is rendered."),
});
export type Slide = z.infer<typeof SlideSchema>;

export const CanvasSchema = z.object({
  w: z.number().int().positive().default(1080).describe("Canvas width in pixels."),
  h: z.number().int().positive().default(1440).describe("Canvas height in pixels."),
  scale: z.number().default(2).describe("Must be exactly 2 — the QA PNG floor depends on it (legacy render.mjs's hard requirement, ported verbatim)."),
  slides_min: z.number().int().default(6).describe("Minimum expected slide count for this carousel."),
  slides_max: z.number().int().default(8).describe("Maximum expected slide count for this carousel."),
});

export const RenderCarouselInputSchema = z.object({
  // client/postId have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from usage.
  client: z.string().min(1).describe("The client this carousel is being rendered for."),
  postId: z.string().min(1).describe("This post's id, used to namespace rendered output."),
  /** Repo-relative directory holding the slide HTML templates. */
  templateDir: z.string().min(1).describe("Repo-relative directory holding the slide HTML templates."),
  /** Repo-relative directory PNGs are written to. */
  outDir: z.string().min(1).describe("Repo-relative directory PNGs are written to (when no mediaStore is configured)."),
  /** Repo root every `templateDir`/`outDir`/image path is resolved and bounds-checked against. */
  repoRoot: z.string().min(1).describe("Repo root every templateDir/outDir/image path is resolved and bounds-checked against."),
  slides: z.array(SlideSchema).min(1).describe("The carousel's slides, in order, each rendered from its own template."),
  canvas: CanvasSchema.default(() => ({ w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 })).describe("Render canvas dimensions and slide-count bounds."),
  readyFlag: z
    .string()
    .min(1)
    .default("__CAROUSEL_READY__")
    .describe("The window flag (or document.body.dataset.ready value) the renderer polls for before screenshotting each slide."),
  measure: z
    .boolean()
    .optional()
    .describe(
      "Measure each slide's rendered pixels (see slide-metrics.ts) and return the numbers on that slide's rendered[] entry. Free — no model call, ~200ms per slide — and it runs on the screenshot buffer this tool already holds, which with a mediaStore configured is the only place those bytes ever exist.",
    ),
  probe: z
    .boolean()
    .optional()
    .describe("Run one page.evaluate per slide in the page already open, reporting overflow, offscreen boxes, element count, text-box share and the font families actually resolved. Also free."),
});
export type RenderCarouselInput = z.infer<typeof RenderCarouselInputSchema>;

export interface RenderCarouselResult {
  rendered: Array<{
    n: number;
    /** A signed GCS URL when `mediaStore` is configured and signing succeeded, `gcsUri` when it didn't, or a local filesystem path when no `mediaStore` was supplied at all. */
    path: string;
    /** `gs://<bucket>/...` — always populated alongside `path` when `mediaStore` is configured, even if `path` itself holds a (possibly time-limited) signed URL, so a caller has a durable reference to fall back to. */
    gcsUri?: string;
    /** Present only when the input asked for `measure` AND the PNG was readable. */
    metrics?: SlideMetrics;
    /** Why measurement produced nothing, when it was asked for and did not. A fact for the caller's ledger, never a render failure: an unreadable PNG is a tooling oddity, not an editorial verdict. */
    measureFailure?: string;
    /** Present only when the input asked for `probe` and the page answered. */
    probe?: SlideProbe;
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

// The callbacks below run inside the Chromium page (Playwright serializes and executes them
// in-browser), never in this Node process — this package's tsconfig has no DOM lib, so `window`/
// `document` are declared locally rather than pulling a full DOM lib in for three call sites.
declare const window: Record<string, unknown>;
interface ProbeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
interface ProbeElement {
  tagName: string;
  id: string;
  className: unknown;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  children: { length: number };
  textContent: string | null;
  parentElement: ProbeElement | null;
  getBoundingClientRect(): ProbeRect;
}
declare const document: {
  body?: { dataset?: Record<string, string> };
  fonts: { ready: Promise<unknown> };
  querySelectorAll(selector: string): ProbeElement[];
};
declare function getComputedStyle(element: ProbeElement): { fontFamily: string; overflow: string; position: string };

function readyFlagCheck(flag: string): boolean {
  return window[flag] === true || document.body?.dataset?.["ready"] === flag;
}

function fontsReady(): Promise<unknown> {
  return document.fonts.ready;
}

/**
 * The DOM half of a slide's measurement, in ONE `page.evaluate` in the page
 * the renderer already has open. Free, and it sees three things no PNG can:
 *
 * - `overflow`, which is the only reliable signal for the templates that size
 *   their display type from an in-page `textContent.length` breakpoint. A
 *   Hebrew string of the same length as an English one has a different
 *   rendered width, so that breakpoint can pick a size that spills its box —
 *   and the pixels then show nothing except a few clipped edge pixels.
 *   `overflow` has TWO limbs, and the second one is not optional: see
 *   "THE BLOCK-START LIMB" below. `scrollHeight` is blind in one direction,
 *   and a plate shipped through that blind spot with its headline printed
 *   on top of its own kicker.
 * - `offscreen`, boxes escaping the canvas entirely, which is invisible in a
 *   screenshot by definition.
 * - `fontFamiliesUsed`, the first real evidence that a script font LOADED
 *   rather than that its `<link>` was emitted.
 *
 * Selectors are truncated to six because they exist to name a culprit in a
 * steer sentence, not to enumerate a DOM.
 *
 * EXPORTED so it can be tested without a browser. Playwright serialises this
 * function by its source and runs it in the page, so it closes over nothing
 * at module scope — every helper and constant it uses is declared inside it,
 * and exporting it does not change a byte of what Chromium executes. A test
 * that installs a fake `document`/`getComputedStyle` on the global exercises
 * the same body; without that, this logic would only ever run where Chromium
 * is installed, and would be untested everywhere else.
 */
export function probePage(canvas: { n: number; w: number; h: number }): {
  n: number;
  overflow: boolean;
  overflowing: string[];
  offscreen: string[];
  elementCount: number;
  textBoxShare: number;
  fontFamiliesUsed: string[];
} {
  const describe = (element: ProbeElement): string => {
    const tag = String(element.tagName || "").toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const cls = typeof element.className === "string" && element.className.trim() !== "" ? `.${element.className.trim().split(/\s+/)[0]}` : "";
    return `${tag}${id}${cls}`;
  };

  // `<script>` and `<style>` are text-bearing leaves with a computed font
  // family and no pixels. Counting them would put a font nothing renders in
  // into `fontFamiliesUsed` — which is the field the script-font check reads.
  const nonVisual = ["script", "style", "head", "meta", "link", "title", "noscript", "template"];

  const all = document.querySelectorAll("*");
  const overflowing: string[] = [];
  const offscreen: string[] = [];
  const families: string[] = [];
  let textArea = 0;

  for (const element of all) {
    const tag = String(element.tagName || "").toLowerCase();
    if (nonVisual.indexOf(tag) !== -1) continue;

    const rect = element.getBoundingClientRect();
    let spills = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;

    // ── THE BLOCK-START LIMB ────────────────────────────────────────────
    //
    // `scrollWidth`/`scrollHeight` describe the SCROLLABLE OVERFLOW REGION,
    // which by specification starts at the padding box's block-start edge
    // and only ever grows away from it. Content pushed out of the TOP of
    // its parent is not in that region and cannot change either number, so
    // the limb above is structurally blind to upward escape.
    //
    // That is not a theoretical gap. `headline-focus.html` had a `.copy`
    // block that was `flex: 0 1 auto; min-block-size: 0` under
    // `justify-content: flex-end`: when the statement ran past its field the
    // flex algorithm shrank the box below its own content and the excess
    // spilled out of the block-start edge. At the reviewer's `l` type scale
    // the headline rendered 155px above its parent, on top of the kicker
    // rail, with the hairline rule running through the glyphs — and the
    // probe reported `scrollHeight 478 === clientHeight 478`, clean. A
    // calibration test that rendered exactly that plate passed.
    //
    // Three exclusions, each of them a real layout idiom and not a defect:
    //
    //  * a parent that is not `overflow: visible` has already declared what
    //    happens to content leaving it (and a clipped child is a different
    //    finding, one the pixels do show at the bleed band);
    //  * an ABSOLUTELY POSITIONED child is placed, not laid out — the
    //    bundled grounds deliberately bleed a display numeral 210px off the
    //    block-start corner, and that is art direction;
    //  * a 2px tolerance, because a display face's glyph box routinely sits
    //    a subpixel or two above its line box.
    //
    // WHAT IS STILL BLIND, MEASURED RATHER THAN ASSUMED. `scrollWidth` has
    // the identical gap on the INLINE axis: the overflow region grows away
    // from the inline-start edge, so a box escaping the inline-START of its
    // parent (left in ltr, right in rtl) leaves `scrollWidth ===
    // clientWidth`. There is no third limb here because the gap was measured
    // before deciding. Swept across all eight bundled templates x s/m/l x
    // ltr/rtl (48 renders, 2026-09-12), an inline-start limb at this same 2px
    // tolerance would report 30 escapes — and all 30 are `.diamond`, the list
    // and comparison bullet hung 3-4px outside its row for optical
    // alignment, which is typography doing its job. A limb that fires only on
    // deliberate hanging punctuation would be switched off within a week, and
    // a switched-off limb is worse than a documented gap. If an inline escape
    // ever ships, it will be one of real size: add the limb then, with a
    // tolerance above the hang (measured at 4px here) rather than at 2.
    const parent: ProbeElement | null = element.parentElement ?? null;
    if (!spills && parent !== null && rect.height > 0 && typeof parent.getBoundingClientRect === "function") {
      const placed = getComputedStyle(element).position === "absolute" || getComputedStyle(element).position === "fixed";
      if (!placed && getComputedStyle(parent).overflow === "visible") {
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.height > 0 && rect.top < parentRect.top - 2) spills = true;
      }
    }
    if (spills && overflowing.length < 6) overflowing.push(describe(element));
    if (rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.top < -1 || rect.right > canvas.w + 1 || rect.bottom > canvas.h + 1)) {
      if (offscreen.length < 6) offscreen.push(describe(element));
    }
    // A TEXT-BEARING LEAF: an element with words and no element children.
    // Summing every ancestor's box instead would report a share over 1 and
    // mean nothing.
    const text = (element.textContent ?? "").trim();
    if (element.children.length === 0 && text !== "") {
      textArea += rect.width * rect.height;
      const family = String(getComputedStyle(element).fontFamily || "").split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      if (family !== undefined && family !== "" && families.indexOf(family) === -1) families.push(family);
    }
  }

  return {
    n: canvas.n,
    overflow: overflowing.length > 0,
    overflowing,
    offscreen,
    elementCount: all.length,
    textBoxShare: Math.min(1, textArea / (canvas.w * canvas.h)),
    fontFamiliesUsed: families.sort(),
  };
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
    description:
      "Renders each slide's HTML template to a PNG via headless Chromium, uploading to GCS when a mediaStore is configured or writing to outDir on local disk otherwise. A typed-outcome port of legacy render.mjs's three-way exit contract: a bad/escaping path is a tooling failure, a missing image is a content failure, never confused. Optionally (measure/probe, both free) reports what each rendered slide actually contains — flat-background and ink shares, the largest empty rectangle, imagery/device/text coverage, and a DOM probe for overflow and resolved font families.",
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
          // The directory is created here, not left to the PNG write further
          // down: that mkdir used to be the first thing to touch `outDir`, so
          // writing the page before it turned a not-yet-existing output
          // directory into a tooling error and a degraded run.
          await fs.mkdir(resolvedOutDir, { recursive: true });
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

          /*
           * MEASURED HERE, ON THE BUFFER IN HAND, BEFORE IT IS PERSISTED.
           *
           * This is not a convenience — it is the only place the bytes exist.
           * With a `mediaStore` configured, `persistRenderedSlide` uploads the
           * buffer and returns a (possibly time-limited) signed URL; no local
           * PNG is ever written, so a separate "read the slide PNGs back and
           * measure them" step would have to re-download what this process
           * was already holding, and would be unable to do even that once the
           * signature expired.
           *
           * `canvas.scale` is validated as EXACTLY 2 by `validateRenderInputs`
           * above, so every measured PNG is 2160x2880 against the 1080x1440
           * design canvas and the metric's cell grid is fixed rather than
           * assumed. If that ever changes, `measureSlidePng` refuses a size
           * that is not an integer multiple rather than reporting numbers off
           * a different grid.
           */
          let metrics: SlideMetrics | undefined;
          let measureFailure: string | undefined;
          if (input.measure === true) {
            const outcome = measureSlidePng(buffer, {
              design: { w: input.canvas.w, h: input.canvas.h },
              expected: {
                ...(slide.measure?.groundHex !== undefined ? { ground: slide.measure.groundHex } : {}),
                ...(slide.measure?.accentHex !== undefined ? { accent: slide.measure.accentHex } : {}),
              },
            });
            if (outcome.ok) metrics = outcome.metrics;
            else measureFailure = outcome.reason;
          }

          // AFTER the screenshot, deliberately: nothing the probe reads can
          // then have perturbed the pixels that were measured.
          let probe: SlideProbe | undefined;
          if (input.probe === true) {
            try {
              probe = await page.evaluate(probePage, { n: slide.n, w: input.canvas.w, h: input.canvas.h });
            } catch {
              // The probe is diagnostic. A page that will not answer it still
              // rendered, and a render must not fail on its own instrumentation.
              probe = undefined;
            }
          }

          const outPath = path.join(resolvedOutDir, `slide-${slide.n}.png`);
          const objectPath = `instagram/${input.client}/${input.postId}/slide-${slide.n}.png`;
          const persisted = await persistRenderedSlide(buffer, outPath, objectPath, mediaStore);
          rendered.push({
            n: slide.n,
            ...persisted,
            ...(metrics !== undefined ? { metrics } : {}),
            ...(measureFailure !== undefined ? { measureFailure } : {}),
            ...(probe !== undefined ? { probe } : {}),
          });
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
