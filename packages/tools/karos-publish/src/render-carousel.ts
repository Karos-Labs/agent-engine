import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { measureSlidePng, type SlideMetrics, type SlideProbe } from "./slide-metrics.js";
import { placeAutoMarkBadge } from "./mark-placement.js";

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
 *
 * 1.5.0 — RFC-21's typography instrument. ONE thing moves on the wire and
 * it is additive: `probe.displayTypeScale`, the largest rendered font size
 * on the plate as a fraction of frame height.
 *
 * The MINOR digit rather than a patch, and the drift guard is right to have
 * asked. A caller CAN observe this: `interest-floor.ts`'s `plateSubject`
 * reads it to decide whether a plate earns a quiet region, so a telemetry
 * record made before this change and one made after are answering different
 * questions about the same plate. That is precisely what a version exists to
 * distinguish.
 *
 * Why the DOM and not the pixels: contrast and imagery were both already
 * measured and type scale had no instrument at all, so one enormous
 * confident line and the same words at caption size were indistinguishable
 * to every clause in the floor. Three pixel proxies were tried for it and
 * all three failed their controls (RFC-21 §2.5-§2.6.2), the last because
 * `edgeDensity` is dominated by imagery share rather than by glyph size. The
 * document knows the answer exactly; there was no reason to keep guessing.
 *
 * 1.4.0 — RFC-17's measurement half. Four things move on the wire, all of
 * them additive: `slide.measure.markHexes` (a new input, forwarded as
 * `expected.marks`); `slide.measure.foregroundHex`, which used to anchor
 * nothing and is now forwarded as `expected.ink` — limb (iv) of the mark
 * definition and the anchor for `groundInkContrast`; five new `metrics`
 * fields (`markedShare`, `markColourCount`, `contentCentroid`,
 * `contentBBox`, `groundInkContrast`); and two new `probe` fields
 * (`markRuns`, `markRunsPainted`).
 *
 * MINOR rather than PATCH because `foregroundHex` changed MEANING: a caller
 * that has been passing it as documentation now gets three numbers computed
 * from it. Nothing a caller reads today reports a different value — the
 * existing metrics and probe fields are untouched — so it is not a MAJOR.
 *
 * This file is the only `TOOL_VERSION` RFC-17 touches. `slide-metrics.ts`
 * declares none of its own — every metric it gained rides out on this tool's
 * wire, so this is where the bump belongs — and `karos-publish`'s three other
 * versioned tools (`draft`, `schedule`, `status`) are unchanged by it. The
 * push gate diffs against the previous PUSH rather than against `origin/main`.
 *
 * 1.5.1 — NOTHING MOVES ON THE WIRE. The only edit is `chromium.launch()`,
 * which now passes `{ channel }` when `KAROS_BROWSER_CHANNEL` is set and
 * `{}` — the previous call, exactly — when it is not. That variable is
 * unset in CI and in prep, so every render this tool performs for a real
 * caller launches the same pinned Playwright build it launched on 1.5.0, and
 * every threshold in `interest-floor.ts` still faces the browser it was
 * calibrated against. It is set only on a developer machine, where
 * Playwright's installer leaves `chromium_headless_shell` missing and the
 * render tests self-skip. See the comment at the launch site.
 *
 * A patch digit for the same reason 1.3.1 carried one: the gate compares a
 * tool file against the previous push and cannot read a diff to know a change
 * was inert on the wire. Semver already means "nothing a caller can observe
 * moved", which is exactly the claim being made here.
 *
 * 1.9.0 — `fitStep`. ONE new optional key on `probe`, read off
 * `document.body[data-fit-step]`, which `_ds-fit.js` has written since the
 * design system shipped and which no production file has ever read. Every
 * other number is byte-identical: the read happens before the element walk,
 * touches nothing in it, and is wrapped in a `try` so a caller with a fake
 * DOM and no `body` reads exactly what it read at 1.8.0.
 *
 * MINOR rather than PATCH under this file's own rule: a caller can observe
 * the key, and a run record made after this change answers a question a
 * record made before it cannot -- "did this plate have to shrink its type to
 * fit, and by how much". The ladder knew; nothing asked.
 *
 * 1.6.0 — RFC-22's collision instrument, and the type-step set. Three things
 * move on the wire and all three are additive: a new optional input
 * `reservedZone`, and a new per-slide result `geometry` carrying
 * `collisions` and `fontSizeSteps`. `probe` is BYTE-IDENTICAL to 1.5.1 —
 * `probePage` is not touched — which is why the new reads live in their own
 * function and their own field rather than as extra `SlideProbe` keys. A
 * caller reading only 1.5.1 fields reads the same numbers.
 *
 * MINOR rather than PATCH because a caller can observe the new field, and
 * because a run record made before this change cannot answer a question a
 * record made after it can: "did anything on this plate print on top of
 * anything else". That question had NO instrument. `probePage` has walked
 * every element with `getBoundingClientRect()` since 1.1.0 and has always
 * reported a box leaving its parent; it has never once reported two boxes in
 * the same pixels, which is how geektime's brand disc shipped on top of its
 * own series badge for eight slides while `08a2` reported the mark present,
 * correctly cornered and at 7.04 contrast.
 *
 * ## 1.7.0 — the watch list stops being furniture-only
 *
 * MINOR again, and for the same reason: a record made under 1.6.0 cannot
 * answer a question a 1.7.0 record can. `COLLISION_WATCH_CLASSES` shipped
 * holding eight names, all of them brand furniture, so the first real defect
 * the instrument was aimed at was one it was constitutionally unable to see —
 * the closer's CTA set on top of `.brand-handle`, which is a furniture-versus-
 * CONTENT pair. The list now also carries the prose and object classes the
 * eight bundled archetypes actually declare. `probe` and every 1.6.0 field are
 * byte-identical; `geometry.collisions` can only grow.
 *
 * ## 1.8.0 — an inline box leaves the block-start limb
 *
 * MINOR for the same reason again, and the reason is worth stating precisely
 * because this one makes the instrument report LESS. `probePage`'s block-start
 * limb treated an inline box's rect as a layout result. It is not: the rect is
 * the union of the box's line fragments, sized by the face's ascent and
 * descent rather than by `line-height`, so a display face at 46px in a 51.5px
 * line box reports a 57px rect starting 3px above the block containing it — at
 * every size, in every plate. That turned ordinary typography into `clipped`
 * on 72 of the mark sweep's renders, and a wider tolerance would only move the
 * type size at which it happened again.
 *
 * So `clipped` is now ABSENT where a 1.7.0 record would have carried it, for
 * the same plate and the same copy. Nothing else moved: every other field is
 * byte-identical, `inline-block` and `inline-flex` stay in scope because they
 * really are laid out as boxes, and the probe's shape widens by one optional
 * `display`, which only the limb above reads.
 *
 * Bumped separately from the commit that made the change: the push gate caught
 * a version left at 1.7.0 while the judgement under it changed, which is the
 * gate doing exactly its job.
 */
/*
 * 1.10.0 (2026-09-23): `markRunsPainted` gains a third limb. The emphasis
 * `underline` and `double` marks are now a text decoration placed from the
 * baseline (on Inter + Heebo the old fixed-offset band struck through the
 * Hebrew letters), so a run whose computed `text-decoration-line` includes
 * `underline` counts as painted. Every other field is unchanged.
 */
/*
 * 1.11.0 (2026-09-23): before the screenshot, a `.mark-badge[data-at="auto"]`
 * is placed by `placeAutoMarkBadge` (one extra low-quality screenshot per slide
 * that carries one). Nothing else moves; a slide without a badge renders
 * exactly as before.
 */
/*
 * 1.12.0 (2026-09-25, owner feedback round WS-09): every render uploads under
 * its own key, `instagram/<client>/<postId>/<renderKey>/slide-<n>.png`. Objects
 * were overwritten in place at `…/<postId>/slide-<n>.png`, so a SHORTER
 * re-render (a merge after the interest floor) left the previous render's last
 * slide in the prefix: Kindly Yours shipped slides 7 and 8 byte-identical, and
 * 29 orphaned `slide-8.png` objects sit in the prep bucket. The key defaults to
 * a hash of the slides data (a resumed render lands on the same objects); a
 * caller may pass its own. Local `outDir` files are unchanged.
 */
const TOOL_VERSION = "1.12.0";

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
          "This slide's foreground token (`--fg`), forwarded as measurement's `expected.ink`. The ink SHARES are still measured as 'not the ground' (a photograph and a scrim are ink too, not only glyph colour) — this token anchors three different numbers: limb (iv) of markedShare/markColourCount, which is what stops a heavy display stroke's interior reading as a highlighter swatch, and groundInkContrast. Supplied rather than inferred because inferring it off the frame's histogram picked a decoration's tint and reported 2.54 for a pair that really measures 15.84.",
        ),
      markHexes: z
        .array(z.string())
        .max(6)
        .optional()
        .describe(
          "The mark colours this slide was painted with, at most six (the kit's accent ring is six). Forwarded as measurement's `expected.marks` for a band sweep to join declared colours to measured bins; markedShare and markColourCount are deliberately defined WITHOUT it, because a within-tolerance-of-an-expected-hex test passes on antialiased glyph fringes.",
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
  renderKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .optional()
    .describe("Namespaces this render's uploaded objects so a shorter re-render never leaves an older slide behind. Defaults to a hash of the slides data."),
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
  reservedZone: z
    .object({
      x: z.number().nonnegative().describe("Left edge in CSS px, in the design canvas's own coordinates (1080x1440), already resolved for this slide's writing direction."),
      y: z.number().nonnegative().describe("Top edge in CSS px."),
      w: z.number().positive().describe("Width in CSS px."),
      h: z.number().positive().describe("Height in CSS px."),
    })
    .optional()
    .describe(
      "The rectangle the brand mark owns, which no other watched element may enter. Read only when `probe` is true. Resolved by the CALLER, not here: the zone's corner depends on the writing direction and on the placement plan, both of which live in the agent. Omitted means no zone is declared and only element-to-element collisions are reported.",
    ),
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
    /** 1.11.0: where an auto-placed brand mark badge went, and every candidate's cost or refusal. Absent on a slide with no badge. */
    markPlacement?: { chosen: string; costs: Record<string, number | string> };
    /** Present only when the input asked for `probe` and the page answered. */
    probe?: SlideProbe;
    /**
     * The second in-page read (1.6.0): collision and the distinct type-step
     * set. Gated on the SAME `probe: true` input — it is the same kind of
     * free DOM fact from the same open page, and a second input flag would
     * only create a state where a caller asked for DOM facts and got some of
     * them.
     *
     * Separate from `probe` rather than folded into it so this release stays
     * strictly additive: see {@link probeGeometry}'s own comment.
     */
    geometry?: SlideGeometry;
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
/** This render's object namespace (1.12.0): the caller's key, else a hash of the slides it renders. */
export function renderKeyFor(input: Pick<RenderCarouselInput, "renderKey" | "slides">): string {
  return input.renderKey ?? createHash("sha256").update(JSON.stringify(input.slides)).digest("hex").slice(0, 12);
}

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
  /**
   * Typed OPTIONAL for the same reason the four RFC-17 `getComputedStyle`
   * reads below are: a fake DOM in a Chromium-free test supplies only what
   * the case under test needs, and `probeGeometry` is the only caller. Every
   * read of it is guarded.
   */
  getAttribute?(name: string): string | null;
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
declare function getComputedStyle(element: ProbeElement): {
  fontFamily: string;
  overflow: string;
  position: string;
  // The four RFC-17 reads. Typed optional because a FAKE `getComputedStyle`
  // in a Chromium-free test supplies only what the case under test needs, and
  // a probe that throws on a partial style object would be untestable in
  // exactly the environment it was exported to be testable in.
  fontSize?: string;
  backgroundImage?: string;
  /** 2026-09-23: the underline and double marks draw as a text decoration. */
  textDecorationLine?: string;
  backgroundClip?: string;
  webkitBackgroundClip?: string;
  color?: string;
  /** Read only by `probeGeometry`: a `visibility: hidden` box still HAS a rect, and two of them are not a collision. */
  visibility?: string;
  /** Read only by `probeGeometry`'s alignment-column set: the INLINE START edge is `left` in `ltr` and `right` in `rtl`. */
  direction?: string;
  /** Read only by the block-start limb, to leave INLINE boxes out of it — see there. Optional for the same fake-style reason as the four above. */
  display?: string;
};

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
 * - `markRuns`/`markRunsPainted`, the same kind of evidence for the emphasis
 *   stylesheet: the document asked for N marked runs and the computed styles
 *   paint M of them. See "MARK RUNS" in the loop below.
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
  markRuns: number;
  markRunsPainted: number;
  /**
   * Which rung of the fit ladder this plate came to rest on: 0, 1 or 2, and
   * `undefined` when the ladder did not run at all.
   *
   * ## Why this had to become a reported number
   *
   * `_ds-fit.js` measures the laid-out boxes and shrinks the type a step at a
   * time until the plate fits, and it stops at two. Its own comment says what
   * the last rung means: *"a plate that still does not fit at step 2 is a
   * copy-length problem that the content-weight floor should refuse rather
   * than something type can hide"*. It has always written the answer to
   * `document.body[data-fit-step]` so that *"a render check, the interest
   * floor and a failing test can all see which rung was used"*.
   *
   * Nothing read it. The attribute appears in the eight plate templates, in
   * `_ds-fit.js` and in ONE test, and in no production file at all -- so a
   * plate that had shrunk its type as far as the system allows was
   * indistinguishable from one that set at its natural size, and the owner
   * found the difference by reading the shipped carousel: *"there are slides
   * with too much copy for one slide and type that is too small"*.
   *
   * `undefined` rather than 0 when the attribute is absent, and the
   * distinction is load-bearing: 0 is the ladder reporting that nothing
   * needed shrinking, and absent is a Template Studio plate that carries no
   * ladder. Treating the second as the first would silently report every
   * custom template as perfectly fitted.
   */
  fitStep?: number;
  /**
   * The largest rendered font size on the plate, as a FRACTION OF FRAME
   * HEIGHT. 0 when nothing text-bearing rendered.
   *
   * ## Why a plate needs this measured
   *
   * Every emptiness clause in `interest-floor.ts` asks how much of the frame
   * is COVERED, and the owner's correction of 2026-09-14 is that covered is
   * not the same as interesting: *"the difference between clean design and
   * bad design is not the absence of interest, it is the absence of noise.
   * Interest comes from bold typography, excellent contrast and strong
   * visuals -- not from extra layers, random gradients or invented numbers."*
   *
   * Contrast is already measured (`groundInkContrast`) and visuals are
   * already measured (`imageryOrDeviceShare`). **Typography was the one of
   * the three with no instrument at all**, so a plate carrying one enormous
   * confident line and a plate carrying the same words at caption size were
   * indistinguishable to every clause in the system.
   *
   * Read from the DOM rather than inferred from pixels because it is a fact
   * the document already knows exactly, and every pixel proxy tried for it
   * has failed its controls (RFC-21 §2.5-2.6.2: three separators dead, the
   * last of them because `edgeDensity` is dominated by imagery share rather
   * than by glyph size).
   */
  displayTypeScale: number;
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

  // The fit ladder's own verdict, off the body. Defensive to a fault because
  // this function runs in three places: Chromium via Playwright, a fake DOM in
  // this package's tests, and a fake DOM in the agent's. Two of the three have
  // supplied no `document.body` for the whole life of the probe, and a probe
  // that throws returns no metrics at all rather than one fewer.
  let fitStep: number | undefined;
  try {
    const body: unknown = (document as unknown as { body?: unknown }).body;
    const raw =
      body !== null && typeof body === "object" && typeof (body as { getAttribute?: unknown }).getAttribute === "function"
        ? (body as { getAttribute: (name: string) => string | null }).getAttribute("data-fit-step")
        : null;
    // `Number("")` is 0, and an empty attribute is not a ladder reporting
    // that nothing needed shrinking — it is an attribute nothing wrote.
    const parsed = raw === null || String(raw).trim() === "" ? Number.NaN : Number(raw);
    if (isFinite(parsed)) fitStep = parsed;
  } catch {
    fitStep = undefined;
  }

  const all = document.querySelectorAll("*");
  const overflowing: string[] = [];
  const offscreen: string[] = [];
  const families: string[] = [];
  let textArea = 0;
  let maxFontPx = 0;
  let markRuns = 0;
  let markRunsPainted = 0;

  for (const element of all) {
    const tag = String(element.tagName || "").toLowerCase();
    if (nonVisual.indexOf(tag) !== -1) continue;

    // ── MARK RUNS: proof that the emphasis STYLESHEET arrived ───────────
    //
    // The DOM half of RFC-17 §5.6, and it answers a question no PNG can. A
    // run is emitted by a first-party fragment builder whatever happens, so
    // `markRuns` counts what the document ASKED for; `markRunsPainted` counts
    // what a computed style actually draws. The two coming apart means one
    // thing only — `markCssBlock()` did not reach `extraHeadHtml` — and no
    // redraft can fix that, which is why the clause it feeds steers a
    // re-render.
    //
    // The class is read off `className` rather than through
    // `element.matches(".mk")` deliberately. `className` is already parsed
    // three lines away in `describe`, it is the one property this probe's
    // fake-DOM tests already supply, and `matches` on an SVG element inside a
    // device fragment is a live source of surprises. Same answer, no new DOM
    // surface.
    //
    // FIVE KINDS, TWO PAINTING MECHANISMS. `block`, `underline`, `swish` and
    // `double` all draw a gradient behind or under the run, so
    // `backgroundImage !== "none"` catches them. The `ink` kind — the one the
    // dark-ground case is forced onto, because a pastel swatch behind
    // near-white type is illegible — puts the gradient IN the glyphs with
    // `background-clip: text` and a transparent `color`, and on that one the
    // background image is also set, so the first limb already catches it. The
    // second limb exists for a flat-colour implementation of the same kind,
    // where there is no image to find and the only evidence is the clip plus
    // a see-through colour.
    const className = typeof element.className === "string" ? element.className : "";
    if (className !== "" && ` ${className.trim().replace(/\s+/g, " ")} `.indexOf(" mk ") !== -1) {
      markRuns += 1;
      const style = getComputedStyle(element);
      const image = String(style.backgroundImage ?? "none");
      const clip = String(style.backgroundClip ?? style.webkitBackgroundClip ?? "border-box");
      const colour = String(style.color ?? "").replace(/\s+/g, "");
      const seeThrough = colour === "transparent" || colour === "rgba(0,0,0,0)";
      // 2026-09-23: the rules (`underline`, `double`) are a text decoration,
      // placed from the baseline, so the third limb reads that.
      const decorated = String(style.textDecorationLine ?? "none").includes("underline");
      if ((image !== "" && image !== "none") || (clip === "text" && seeThrough) || decorated) markRunsPainted += 1;
    }

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
    //
    // A FOURTH EXCLUSION, AND IT IS NOT A TOLERANCE PROBLEM. An INLINE box's
    // rect is not a layout result — it is the union of its line fragments,
    // sized by the face's own ascent and descent rather than by `line-height`.
    // A display face at 46px in a 51.5px line box reports a 57px rect that
    // starts 3px above the block that contains it, at EVERY size, in EVERY
    // plate: measured on this tree, an emphasis run (`span.mk`, `span.mk-t`)
    // inside `.mk-runs` escaped by exactly that, and the 2px tolerance turned
    // ordinary typography into `clipped` on 72 of the mark sweep's renders.
    // Raising the tolerance only moves the size at which it happens again,
    // because the overshoot scales with the type. An inline box cannot escape
    // its parent in the sense this limb is about: the LINE BOX owns the
    // layout, and the ink above it is the same ink the block would paint with
    // no span there at all. `inline-block` and `inline-flex` ARE laid out as
    // boxes and stay in scope.
    const parent: ProbeElement | null = element.parentElement ?? null;
    if (!spills && parent !== null && rect.height > 0 && typeof parent.getBoundingClientRect === "function") {
      const display = getComputedStyle(element).display;
      const placed = getComputedStyle(element).position === "absolute" || getComputedStyle(element).position === "fixed";
      const inlineLevel = display === "inline" || display === "contents";
      if (!placed && !inlineLevel && getComputedStyle(parent).overflow === "visible") {
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
      const style = getComputedStyle(element);
      const family = String(style.fontFamily || "").split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      if (family !== undefined && family !== "" && families.indexOf(family) === -1) families.push(family);
      // `parseFloat` rather than a unit-aware parse: a computed `fontSize`
      // is always in px, and a fake style object in a Chromium-free test
      // supplies whatever the case needs. A leaf with no rendered box is
      // skipped so a hidden heading cannot claim the plate is bold.
      if (rect.width > 0 && rect.height > 0) {
        const px = parseFloat(String(style.fontSize ?? ""));
        if (isFinite(px) && px > maxFontPx) maxFontPx = px;
      }
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
    markRuns,
    markRunsPainted,
    displayTypeScale: canvas.h > 0 ? maxFontPx / canvas.h : 0,
    ...(fitStep === undefined ? {} : { fitStep }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The second DOM read: collision, and the type-step set
// ─────────────────────────────────────────────────────────────────────────

/**
 * The classes `probeGeometry` watches for collision.
 *
 * NOT every element on the plate. A collision list over the whole document
 * would be thousands of pairs of nested and deliberately-stacked boxes (every
 * scrim sits on every ground by design), and a list that long is a list
 * nobody reads. These eight are the furniture that is placed ABSOLUTELY, in
 * corners, by rules that were each written without knowing about the others —
 * which is exactly the population where two things end up in the same pixels.
 *
 * `brand-logo` is the class `buildBrandLogoBodyHtml` actually emits today;
 * `brand-mark` and `eyebrow` are the names RFC-22 §4.3 renames the furniture
 * to. BOTH spellings are watched on purpose, so this instrument sees the
 * defect on the templates as they stand (the geektime white disc printed on
 * top of `.brand-badge`, clipping `{ FIELD NOTES }` to `{ FIELD` on all eight
 * slides) AND keeps seeing it after the rename — a watch list that has to be
 * edited in the same commit as a rename is a watch list that goes blind in
 * the commit after it.
 *
 * ## AND THE CONTENT, which 1.6.0 left off and which is half the question
 *
 * The eight names above are all FURNITURE. A list that holds only furniture
 * can report furniture landing on furniture and nothing else — so the first
 * defect this instrument was pointed at after it shipped was one it could not
 * see: on the karoslabs closer the CTA's third line printed directly on top of
 * `.brand-handle` (`mono-display`, an eight-slide English carousel, a
 * 108-character CTA), both strings legible, both ruined, and `probeGeometry`
 * reported zero collisions because `.cl-cta` was not a name it knew.
 *
 * The second half of the list is therefore the prose and object classes the
 * eight bundled archetypes actually carry, grepped out of the template set
 * rather than invented: a furniture-versus-content collision is the common
 * case precisely because the furniture is placed ABSOLUTELY and the content is
 * laid out in flow, so neither rule can see the other.
 *
 * Three deliberate absences. `#takeaway` is not here because it is spelled
 * `class="headline" id="takeaway"` and `headline` already watches it — the
 * probe matches CLASSES, so an id in this list would be a dead entry that
 * looked like coverage. `.pg-index` is not here for the same reason from the
 * other direction: every template marks it `aria-hidden="true"`, and this
 * probe skips `aria-hidden` boxes by design, so the name would read as
 * coverage it can never deliver (the closer's own foot strip is reserved in
 * CSS instead). `.hero`, `.bg`, `.ground`, `.scrim` and the bands are
 * not here because they are full-bleed layers that share pixels with the copy
 * BY DESIGN; the ancestor/descendant exclusion does not cover a sibling scrim,
 * and adding them would bury every real pair under eight guaranteed ones.
 *
 * Still warn-only for every pair that does not name the brand mark (the agent
 * splits them at `08a2`), so widening the list cannot hold a run — it can only
 * let the reviewer and the judge see what is actually on top of what.
 */
export const COLLISION_WATCH_CLASSES: readonly string[] = [
  // Furniture (1.6.0).
  "brand-logo",
  "brand-mark",
  "brand-badge",
  "eyebrow",
  "brand-handle",
  "kicker",
  "headline",
  "figure",
  // Content (1.7.0) — closer, cover/slide/headline-focus, stat callout,
  // list, quote card, comparison card, in that order.
  "cl-question",
  "cl-cta",
  "cl-recap",
  "body-text",
  "hf-headline",
  "num-figure",
  "num-label",
  "num-body",
  "source-line",
  "me-head",
  "me-rows",
  "quote-text",
  "quote-attr",
  "cmp-head",
  "cmp-label",
  "cmp-body",
  "cmp-foot-text",
];

/**
 * How deep two boxes must be into each other before it counts, in CSS px.
 *
 * Measured, not chosen: the 48-render sweep recorded in `probePage`'s "WHAT
 * IS STILL BLIND" comment found `.diamond`, the list/comparison bullet, hung
 * 3-4px outside its row for optical alignment across every bundled template.
 * Type does the same thing to itself constantly — a display face's glyph box
 * routinely sits a px or two into its neighbour's margin. 4px is the top of
 * that measured band, so the first thing this can report is an intrusion
 * larger than any deliberate hang in the tree. The geektime disc overlaps its
 * badge by ~120px, so the threshold is nowhere near the case it exists for.
 */
export const COLLISION_MIN_PX = 4;

/**
 * The three groups whose rendered area is a plate's SUBJECT, for
 * `probeGeometry`'s `subjectBoxes`.
 *
 * Copied from the agent's own `probeSubjectBoxes` (`interest-floor.ts`), which
 * is where the argument lives and where `cover-subject.test.ts` proved the
 * numbers in real Chromium. It is copied rather than imported for the reason
 * every constant in this file's page bodies is: a tool must not depend on an
 * agent, and a body that is serialised into the page may close over nothing.
 *
 * What is deliberately ABSENT is the point of the read: `.ground`, `.scrim`,
 * `.cov-field` and `.stat-band` are not subjects. **A gradient is what a boring
 * cover carries instead of a subject**, so a measurement that counted it would
 * pass exactly the plate the clause exists to refuse.
 *
 * `.hero` rather than `img`: a tag name would count the brand logo disc, and
 * `cover.html`'s `onerror` REMOVES the element when the photograph failed to
 * load, so the class is present exactly when a picture actually rendered.
 */
export const SUBJECT_BOX_GROUPS = {
  hero: [".hero"],
  device: [".dv", ".cov-device", ".sl-device", ".cl-recap"],
  graphic: ["svg", "canvas", ".cl-art"],
} as const;

/** The pseudo-selector used for the other half of a reserved-zone intrusion, so `a`/`b` read the same way for both kinds. */
export const RESERVED_ZONE_SELECTOR = "[reserved-zone]";

export const ProbeCollisionSchema = z.object({
  a: z.string().describe("The first box, named the way `overflowing`/`offscreen` name theirs — `tag#id.first-class`."),
  b: z.string().describe("The second box, or `[reserved-zone]` when this is an element intruding into a declared reserved rectangle rather than onto another element."),
  overlapPx: z
    .number()
    .describe(
      "How DEEP the two boxes are into each other: the SMALLER of the two intersection dimensions, in CSS px. Deliberately not the intersection AREA — a 2px-deep overlap along a 600px shared edge is 1,200px² and is a rounding artefact, while a 120px-deep overlap of a small disc onto a label is the defect. Depth is the number a human means by 'they overlap by N pixels'.",
    ),
});
export type ProbeCollision = z.infer<typeof ProbeCollisionSchema>;

export const SlideGeometrySchema = z.object({
  n: z.number().int().positive().describe("The slide this read belongs to."),
  collisions: z
    .array(ProbeCollisionSchema)
    .describe(
      "Pairs of visible, non-`aria-hidden` watch-list boxes sharing pixels more than COLLISION_MIN_PX deep, deepest first. Empty is the normal answer. A pair naming the brand mark is a finding this phase; everything else is warn-only until we have a false-positive rate.",
    ),
  fontSizeSteps: z
    .array(z.number())
    .describe(
      "The DISTINCT rendered font sizes on the plate, in px, largest first, rounded to whole px. `displayTypeScale` reports only the largest, which cannot tell one confident line over quiet body copy from six sizes competing — and 'how many type steps does this plate use' is the question a type-contrast clause has to ask.",
    ),
  alignmentColumns: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "How many DISTINCT inline start edges the plate's text leaves sit on, to the nearest 4px. One is a ranged-left plate; two is a deliberate indent; five is a plate whose elements were each placed without reference to the others. Reporting-only — see the agent's ALIGNMENT_COLUMN_CEILING.",
    ),
  subjectBoxes: z
    .object({
      hero: z.number().describe("Share of the canvas covered by `.hero` boxes — the photograph, present exactly when one rendered (`onerror` removes the element)."),
      device: z.number().describe("Share covered by the drawn device (`.dv`, `.cov-device`, `.sl-device`, `.cl-recap`)."),
      graphic: z.number().describe("Share covered by drawn graphics (`svg`, `canvas`, `.cl-art`)."),
    })
    .describe(
      "What the plate is CARRYING, by area, in three groups. Grounds, scrims and fields (`.ground`, `.scrim`, `.cov-field`, `.stat-band`) are deliberately NOT subjects: a gradient is what a cover carries INSTEAD of a subject, which is the whole reason this read exists.",
    ),
});
export type SlideGeometry = z.infer<typeof SlideGeometrySchema>;

/**
 * The SECOND in-page read, answering the two questions `probePage` has never
 * been able to answer.
 *
 * ## Why a second function rather than more fields on `probePage`
 *
 * `probePage`'s return shape is `SlideProbe`, which is defined by
 * `SlideProbeSchema` in `slide-metrics.ts` and asserted round-trippable by
 * `render-carousel-measure.test.ts`. Adding fields there would mean either
 * two sources of truth for that shape or a schema edit in a file this change
 * has no business touching. Keeping the new reads in their own function and
 * their own result field makes 1.6.0 strictly additive: `probe` is
 * byte-identical to 1.5.1 for every existing caller, and the new numbers
 * arrive beside it rather than inside it.
 *
 * ## Collision, which is not overflow
 *
 * `probePage` has walked every element with `getBoundingClientRect()` since
 * 1.1.0 and has ALWAYS been able to tell that a box left its parent. It has
 * never once been able to tell that two boxes are in the same pixels. That is
 * how geektime's brand disc shipped printed on top of its own series badge
 * for eight consecutive slides while `08a2` reported the mark as
 * `present: true, corner: "top-start", groundContrast: 7.04` — every
 * instrument green, the badge reading `{ FIELD`, and the human gate
 * approving it. Overflow asks "did this box stay inside its parent";
 * collision asks "is anything else already here", and no amount of the first
 * answers the second.
 *
 * ## The reserved zone
 *
 * A corner PREFERENCE is not a reservation: it moved the mark away from the
 * badge only while the code that computed `hasSeriesBadge` was right about
 * the badge. `reserved` lets the caller declare the rectangle the mark owns,
 * and any other watched box that enters it is reported against
 * {@link RESERVED_ZONE_SELECTOR}. That limb fires even when the mark itself
 * did not render — thepitchbydeel has no `logoUrl` at all — which is the
 * whole point of a zone: it is reserved whether or not the tenant showed up.
 *
 * ## Exclusions, each of them a real layout idiom
 *
 * - **zero-area** boxes, and `visibility: hidden` ones: they have rects and
 *   no pixels;
 * - **`aria-hidden="true"`**: the scrims and grounds are stacked on purpose
 *   and say so;
 * - **ancestor/descendant pairs**: a `.headline` inside a `.figure` shares
 *   pixels with it by definition, and reporting containment as collision
 *   would bury the one pair that matters.
 *
 * EXPORTED, and closing over NOTHING at module scope — the watch list and
 * the threshold arrive as arguments precisely so the module-level constants
 * above stay the single source of truth while Playwright still serialises
 * this function by its source. Same discipline as `probePage`.
 */
export function probeGeometry(arg: {
  n: number;
  /** Class names WITHOUT the leading dot — {@link COLLISION_WATCH_CLASSES}. */
  watch: readonly string[];
  /** {@link COLLISION_MIN_PX}. */
  minOverlapPx: number;
  /** The rectangle no element but the brand mark may enter, in CSS px. Omitted when the caller declares none. */
  reserved?: { x: number; y: number; w: number; h: number };
  /** Which watch classes OWN `reserved` and so are not intruders in it. Ignored when `reserved` is absent. */
  reservedOwners?: readonly string[];
  /** The design canvas, in CSS px — `subjectBoxes` is a SHARE of it. */
  w: number;
  h: number;
  /**
   * Tag names and `.class` selectors, in three groups, whose rendered area is
   * the plate's SUBJECT. Passed in rather than closed over for the same reason
   * `watch` is: this body is serialised into the page.
   */
  subjects: { hero: readonly string[]; device: readonly string[]; graphic: readonly string[] };
}): {
  n: number;
  collisions: { a: string; b: string; overlapPx: number }[];
  fontSizeSteps: number[];
  alignmentColumns: number;
  subjectBoxes: { hero: number; device: number; graphic: number };
} {
  const describe = (element: ProbeElement): string => {
    const tag = String(element.tagName || "").toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const cls = typeof element.className === "string" && element.className.trim() !== "" ? `.${element.className.trim().split(/\s+/)[0]}` : "";
    return `${tag}${id}${cls}`;
  };

  const classesOf = (element: ProbeElement): string[] => {
    const raw = typeof element.className === "string" ? element.className.trim() : "";
    return raw === "" ? [] : raw.split(/\s+/);
  };

  const isAncestor = (maybeAncestor: ProbeElement, node: ProbeElement): boolean => {
    let cursor: ProbeElement | null = node.parentElement ?? null;
    // Bounded rather than `while (cursor)`: a fake DOM wired into a cycle by
    // a test would otherwise hang the probe, and no slide template nests
    // anywhere near this deep.
    for (let depth = 0; cursor !== null && depth < 64; depth++) {
      if (cursor === maybeAncestor) return true;
      cursor = cursor.parentElement ?? null;
    }
    return false;
  };

  // Same exclusion `probePage` applies for the same reason: `<script>` and
  // `<style>` are text-bearing leaves with a computed font size and no
  // pixels. The zero-area guard below already catches them in a real browser,
  // but the two reads must agree by CONSTRUCTION and not by coincidence —
  // `fontSizeSteps[0]` and `displayTypeScale` are asserted to describe the
  // same glyph.
  const nonVisual = ["script", "style", "head", "meta", "link", "title", "noscript", "template"];

  const isIn = (element: ProbeElement, group: readonly string[]): boolean => {
    const tag = String(element.tagName || "").toLowerCase();
    if (group.indexOf(tag) !== -1) return true;
    for (const name of classesOf(element)) if (group.indexOf(`.${name}`) !== -1) return true;
    return false;
  };

  /**
   * The share of the canvas one subject group covers. A match nested inside
   * another match of the SAME group is skipped — a `.dv` fragment inside
   * `.cov-device` is one object, not two — which is the same rule the agent's
   * own `probeSubjectBoxes` states, and `cover-subject.test.ts` is what pins
   * the two readings together.
   */
  const subjectShare = (group: readonly string[]): number => {
    const frame = arg.w * arg.h;
    if (frame <= 0) return 0;
    let area = 0;
    for (const element of document.querySelectorAll("*")) {
      if (!isIn(element, group)) continue;
      let ancestor: ProbeElement | null = element.parentElement ?? null;
      let nested = false;
      for (let depth = 0; ancestor !== null && !nested && depth < 64; depth++) {
        if (isIn(ancestor, group)) nested = true;
        ancestor = ancestor.parentElement ?? null;
      }
      if (nested) continue;
      const rect = element.getBoundingClientRect();
      area += Math.max(0, rect.width) * Math.max(0, rect.height);
    }
    return Math.min(1, area / frame);
  };

  const all = document.querySelectorAll("*");
  const watched: { element: ProbeElement; rect: ProbeRect; name: string; classes: string[] }[] = [];
  const sizes: number[] = [];
  const columns: number[] = [];

  for (const element of all) {
    if (nonVisual.indexOf(String(element.tagName || "").toLowerCase()) !== -1) continue;
    const classes = classesOf(element);
    const rect = element.getBoundingClientRect();

    // ── THE TYPE-STEP SET ──────────────────────────────────────────────
    // Same definition of a text-bearing leaf `probePage` uses (an element
    // with words and no element children), so `fontSizeSteps[0]` and
    // `displayTypeScale * canvasHeight` describe the same glyph. Rounded to
    // whole px because a `clamp()` or a `calc(19px * var(--ts))` resolves to
    // 31.9998 and 32 for what a designer laid out as ONE step; nothing in
    // these templates puts two intended steps within 1px of each other.
    const text = (element.textContent ?? "").trim();
    if (element.children.length === 0 && text !== "" && rect.width > 0 && rect.height > 0) {
      const computed = getComputedStyle(element);
      const px = parseFloat(String(computed.fontSize ?? ""));
      if (isFinite(px) && px > 0) {
        const step = Math.round(px);
        if (sizes.indexOf(step) === -1) sizes.push(step);
      }
      // ── THE ALIGNMENT COLUMN SET ───────────────────────────────────────
      // The INLINE START edge, which is the left edge in `ltr` and the right
      // edge in `rtl` — a Hebrew plate ranged right sits on ONE column, and a
      // read that took `left` unconditionally would report one column per line
      // length and make every Hebrew plate look chaotic.
      //
      // Quantised to 4px for the reason the font sizes are rounded to whole
      // px: sub-pixel layout and an optical hang of a px or two are one column
      // to a reader, and the question is "how many places does the eye have to
      // start from", not "how many distinct floats did Chromium produce".
      const rtl = String(computed.direction ?? "ltr") === "rtl";
      const edge = Math.round((rtl ? rect.right : rect.left) / 4) * 4;
      if (columns.indexOf(edge) === -1) columns.push(edge);
    }

    if (classes.length === 0) continue;
    let isWatched = false;
    for (const cls of classes) if (arg.watch.indexOf(cls) !== -1) isWatched = true;
    if (!isWatched) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;
    const ariaHidden = typeof element.getAttribute === "function" ? element.getAttribute("aria-hidden") : null;
    if (ariaHidden === "true") continue;
    if (String(getComputedStyle(element).visibility ?? "visible") === "hidden") continue;
    watched.push({ element, rect, name: describe(element), classes });
  }

  const collisions: { a: string; b: string; overlapPx: number }[] = [];
  const depth = (p: ProbeRect, q: { left: number; top: number; right: number; bottom: number }): number => {
    const ix = Math.min(p.right, q.right) - Math.max(p.left, q.left);
    const iy = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    return ix <= 0 || iy <= 0 ? 0 : Math.min(ix, iy);
  };

  for (let i = 0; i < watched.length; i++) {
    const a = watched[i]!;
    for (let j = i + 1; j < watched.length; j++) {
      const b = watched[j]!;
      if (isAncestor(a.element, b.element) || isAncestor(b.element, a.element)) continue;
      const overlapPx = depth(a.rect, b.rect);
      if (overlapPx > arg.minOverlapPx) collisions.push({ a: a.name, b: b.name, overlapPx });
    }

    if (arg.reserved !== undefined) {
      let owns = false;
      for (const cls of a.classes) if ((arg.reservedOwners ?? []).indexOf(cls) !== -1) owns = true;
      if (!owns) {
        const zone = { left: arg.reserved.x, top: arg.reserved.y, right: arg.reserved.x + arg.reserved.w, bottom: arg.reserved.y + arg.reserved.h };
        const overlapPx = depth(a.rect, zone);
        // The literal must equal `RESERVED_ZONE_SELECTOR`, and cannot
        // REFERENCE it: this body is serialised to the page and closes over
        // nothing. `probe-collisions.test.ts` asserts the two agree, so the
        // drift is caught by a test rather than left to a reader.
        if (overlapPx > arg.minOverlapPx) collisions.push({ a: a.name, b: "[reserved-zone]", overlapPx });
      }
    }
  }

  // Deepest first, then by name, so the cap drops the least interesting pairs
  // and two runs of the same plate report the same list in the same order.
  collisions.sort((x, y) => y.overlapPx - x.overlapPx || (x.a + x.b < y.a + y.b ? -1 : 1));
  sizes.sort((x, y) => y - x);

  // The caps are literals rather than named module constants because this
  // body is serialised and run in the page and may close over nothing — the
  // same rule that puts `watch` and `minOverlapPx` in the argument. Six
  // collisions matches `overflowing`/`offscreen`, which are capped at six for
  // the same reason: these lists exist to NAME A CULPRIT in a steer sentence,
  // not to enumerate a DOM. Twenty-four type steps is well past the point
  // where the count is itself the finding.
  return {
    n: arg.n,
    collisions: collisions.slice(0, 6),
    fontSizeSteps: sizes.slice(0, 24),
    alignmentColumns: columns.length,
    subjectBoxes: { hero: subjectShare(arg.subjects.hero), device: subjectShare(arg.subjects.device), graphic: subjectShare(arg.subjects.graphic) },
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
      const renderKey = renderKeyFor(input);

      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        return toolingError(`playwright is not installed/available: ${err instanceof Error ? err.message : String(err)}`);
      }

      /**
       * ── `KAROS_BROWSER_CHANNEL`: RENDER LOCALLY ON A BROWSER THAT IS ALREADY
       *    INSTALLED. ──
       *
       * Unset everywhere but a developer machine, so CI and prep launch exactly
       * the browser they launched before this line existed: Playwright's own
       * pinned build, which is the one every calibrated threshold in
       * `interest-floor.ts` was measured against.
       *
       * It exists because of what its absence cost. Playwright's installer
       * stalls partway through on this project's Windows machines (antivirus,
       * reproducibly, after `chrome.dll`), which leaves the full `chromium-NNNN`
       * build on disk and the `chromium_headless_shell-NNNN` build that
       * `launch()` actually defaults to missing. Every render test then
       * self-skips, and **a defect that only pixels can see becomes a
       * ~25-minute CI round trip per guess.** Three template defects in a row
       * were diagnosed that way, one of them twice, which is not a way to work.
       *
       * `KAROS_BROWSER_CHANNEL=chrome` launches installed Google Chrome and the
       * same suite runs in minutes. A channel is a different build from the
       * pinned one, so a share measured under it is indicative rather than
       * authoritative and CI stays the source of truth for a THRESHOLD. For
       * layout facts — does this element overflow its own box, does that band
       * collapse — it is the same engine and the same answer.
       */
      const channel = process.env["KAROS_BROWSER_CHANNEL"]?.trim();
      const browser = await chromium.launch(channel !== undefined && channel.length > 0 ? { channel } : {});
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

          // 1.11.0: a brand mark badge marked `data-at="auto"` is placed where
          // the rendered slide is quietest and no copy is near it. Furniture:
          // it cannot fail the render. See `mark-placement.ts`.
          const markPlacement = await placeAutoMarkBadge(page as never, { w: input.canvas.w, h: input.canvas.h }, `${input.postId}:${slide.n}`);

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
                ...(slide.measure?.foregroundHex !== undefined ? { ink: slide.measure.foregroundHex } : {}),
                ...(slide.measure?.markHexes !== undefined ? { marks: slide.measure.markHexes } : {}),
              },
            });
            if (outcome.ok) metrics = outcome.metrics;
            else measureFailure = outcome.reason;
          }

          // AFTER the screenshot, deliberately: nothing the probe reads can
          // then have perturbed the pixels that were measured.
          let probe: SlideProbe | undefined;
          let geometry: SlideGeometry | undefined;
          if (input.probe === true) {
            try {
              probe = await page.evaluate(probePage, { n: slide.n, w: input.canvas.w, h: input.canvas.h });
            } catch {
              // The probe is diagnostic. A page that will not answer it still
              // rendered, and a render must not fail on its own instrumentation.
              probe = undefined;
            }
            // A SEPARATE try: a geometry read that throws must not take the
            // overflow read down with it, and vice versa. Two evaluates
            // rather than one because the watch list and the threshold are
            // module constants that this body must not close over, and
            // because the two answer different questions — see probeGeometry.
            try {
              geometry = await page.evaluate(probeGeometry, {
                n: slide.n,
                watch: [...COLLISION_WATCH_CLASSES],
                minOverlapPx: COLLISION_MIN_PX,
                w: input.canvas.w,
                h: input.canvas.h,
                subjects: {
                  hero: [...SUBJECT_BOX_GROUPS.hero],
                  device: [...SUBJECT_BOX_GROUPS.device],
                  graphic: [...SUBJECT_BOX_GROUPS.graphic],
                },
                ...(input.reservedZone !== undefined ? { reserved: input.reservedZone, reservedOwners: ["brand-logo", "brand-mark"] } : {}),
              });
            } catch {
              geometry = undefined;
            }
          }

          const outPath = path.join(resolvedOutDir, `slide-${slide.n}.png`);
          const objectPath = `instagram/${input.client}/${input.postId}/${renderKey}/slide-${slide.n}.png`;
          const persisted = await persistRenderedSlide(buffer, outPath, objectPath, mediaStore);
          rendered.push({
            n: slide.n,
            ...persisted,
            ...(metrics !== undefined ? { metrics } : {}),
            ...(measureFailure !== undefined ? { measureFailure } : {}),
            ...(probe !== undefined ? { probe } : {}),
            ...(geometry !== undefined ? { geometry } : {}),
            ...(markPlacement !== undefined ? { markPlacement } : {}),
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
