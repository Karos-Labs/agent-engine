import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { createRenderCarousel, type SlideMetrics } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { ARCHETYPE_TEMPLATE_FILES, buildListRows } from "../src/workflow/slides-data.js";
import { fallbackClientVisualSystem, pickVisualSystem, visualSystemCssBlock } from "../src/workflow/visual-system.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * Phase 5.5, item C — THE FURNITURE INVERSION, held as a source scan.
 *
 * ## What this suite is for
 *
 * The owner, judging three prep posts on 2026-09-16: *"יש קווים כאלה כתומים
 * שזה הכי סימן לפוסט שנעשה עם AI… על חלק מהשקופיות כתוב מספר ועל חלק לא"*. Two
 * of those three complaints are properties of the TEMPLATE SET rather than of
 * any one template, and neither is visible to someone reading one file:
 *
 *   1. every bundled template painted its accent mark unconditionally, so a
 *      carousel carried eight of them;
 *   2. the 460px ground numeral existed in TWO of the eight files, so a
 *      carousel carried two.
 *
 * The mechanism this phase ships is an INVERSION: a mark is hidden unless a
 * switch token turns it on, and `visualSystemCssBlock` sets that token on at
 * most three slides. The inversion is only worth anything if it holds across
 * the whole set — one template that forgets it paints that mark forever and
 * the post is back where it started. That is a set-level property, so it is
 * tested at the set level.
 *
 * ## Why a SOURCE SCAN
 *
 * This repo's own idiom (`template-mark-slots.test.ts`,
 * `default-template-render.test.ts`), and the right one here: every claim
 * below is about what the eight files DECLARE, which is exactly the thing a
 * Chromium render cannot tell you (a render shows you one document with one
 * set of tokens, and the defect is the absence of a guard). The pixel half —
 * that an accent-off plate paints no bar and an accent-on plate does — is the
 * Chromium block at the foot, and CI is its authority.
 */

const TEMPLATE_DIR = path.join(__dirname, "..", "assets", "templates", "default");

async function readTemplates(): Promise<{ file: string; html: string }[]> {
  return Promise.all(
    ARCHETYPE_TEMPLATE_FILES.map(async (file) => ({ file, html: await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8") })),
  );
}

/**
 * The `<style>` block with its CSS comments stripped.
 *
 * BOTH halves matter. Outside `<style>` these files carry long HTML doc
 * comments that quote slot names; inside it they carry equally long CSS
 * comments that quote whole rules — `cover.html`'s badge note contains the
 * literal `.brand-badge { ... }` while explaining what the brand head
 * fragment does to it. A scan that reads either would be reading the
 * commentary and reporting it as the code.
 */
function styleOf(html: string): string {
  const open = html.indexOf("<style>");
  const close = html.lastIndexOf("</style>");
  const css = open >= 0 && close > open ? html.slice(open + "<style>".length, close) : "";
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The `<body>`-onwards markup, with HTML comments stripped: a slot named inside a comment is not a slot the renderer fills. */
function markupOf(html: string): string {
  const open = html.indexOf("<body");
  return (open >= 0 ? html.slice(open) : html).replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * A MINIMAL DOM SHIM, the same idiom `interest-floor.ts` uses for
 * `probeSubjectBoxes`: the bodies passed to `page.evaluate` below run inside
 * the page, so they need `document` / `getComputedStyle` / `window` to
 * type-check in a package whose `lib` is deliberately node-only. Declaring
 * exactly what is used keeps the shim honest — a body that reaches for
 * anything else fails here rather than at runtime.
 */
interface DomProbeElement {
  getBoundingClientRect(): { width: number; height: number };
}
declare const document: { querySelector(selector: string): DomProbeElement | null };
declare const getComputedStyle: (
  element: DomProbeElement,
  pseudo?: string,
) => { display: string; width: string; height: string; backgroundImage: string; borderBlockStartColor: string };
declare const window: Record<string, unknown>;

/**
 * ── THE SWITCHED-MARK REGISTRY, AT MODULE SCOPE. ──
 *
 * It used to be fourteen rows: `.stat-band`, `.cmp-rail`, `.qc-foot`, `.cl-art`,
 * `.hf-field`, `.me-rows` and the rest — a different accent mark per template,
 * each with its own selector, its own paint mechanism (element, background,
 * border, pseudo-element) and its own switch condition. That list is the defect
 * it was written to police, written down: fourteen marks is why one carousel
 * rendered the accent in three colours at eleven widths, and why a reader
 * called the result machine-made.
 *
 * There is now ONE mark in the whole set. `.acc` is an element, it is switched
 * by `--fx-accent`, its geometry is the run's own `--fx-accent-w/h`, its ink is
 * `--fx-accent-ink`, and the shared sheet is the only place any of that is
 * said. Every plate gets the same row, which is the point: a registry that
 * cannot disagree with itself.
 *
 * `design-system-sync.test.ts` carries the complementary guard — that no plate
 * declares a border or an off-scale size of its own — so a fifteenth mark
 * cannot come back in by another door.
 */
const SWITCHED: {
  file: string;
  rule: RegExp;
  token: "fx-accent" | "fx-accent-ink";
  selector: string;
  paint: "element" | "background" | "border" | "::before" | "::after";
  rendered?: false;
  absent?: string;
}[] = ARCHETYPE_TEMPLATE_FILES.map((file) => ({
  file,
  rule: /\.acc\s*\{[^}]*\}/,
  token: "fx-accent" as const,
  selector: ".acc",
  paint: "element" as const,
}));

describe("the series badge is gone from the whole set", () => {
  it("no template declares a {{seriesBadge}} slot", async () => {
    // It printed an INTERNAL label — the pipeline's own format name — in the
    // same corner on every slide of every post, and on geektime it collided
    // with the brand logo disc and clipped to `{ FIELD` on all eight plates.
    for (const { file, html } of await readTemplates()) {
      expect(html, `${file} still declares a series-badge slot`).not.toContain("{{seriesBadge}}");
    }
  });

  it("no template renders a .brand-badge element", async () => {
    for (const { file, html } of await readTemplates()) {
      expect(markupOf(html), `${file} still renders a .brand-badge element`).not.toMatch(/class="brand-badge"/);
    }
  });

  it("every template KEEPS its .brand-badge placement rule, because a client's own template may still carry the slot", async () => {
    // The slot name stays in `KNOWN_SLOT_NAMES` and in `LAYOUT_FIELD_KEYS` for
    // exactly this reason: a removed slot must still be a known NON-PROSE key,
    // or a client template that kept it starts counting as content. A badge
    // that lost its placement rule would lay itself out in normal flow over
    // the copy.
    for (const { file, html } of await readTemplates()) {
      expect(styleOf(html), `${file} dropped the .brand-badge rule along with the slot`).toMatch(/\.brand-badge\s*\{/);
    }
  });
});

describe("the pagination index is uniform across all eight files", () => {
  it("every template renders exactly one .pg-index carrying {{slideIndex}}", async () => {
    for (const { file, html } of await readTemplates()) {
      const markup = markupOf(html);
      expect(markup.match(/class="pg-index"/g)?.length ?? 0, `${file} does not render exactly one .pg-index`).toBe(1);
      expect(markup, `${file}'s .pg-index does not carry the slide number`).toMatch(/class="pg-index"[^>]*>\{\{slideIndex\}\}</);
    }
  });

  it("every .pg-index carries the IDENTICAL switch condition", async () => {
    // The whole defect was that the index existed in two files and not in the
    // other six. Eight identical conditions is the shape of "all or none".
    for (const { file, html } of await readTemplates()) {
      expect(styleOf(html), `${file}'s .pg-index is not switched by --fx-pagination`).toMatch(/\.pg-index\s*\{[^}]*display:\s*var\(--fx-pagination,\s*none\)/);
    }
  });

  it("the 460px ground numeral is gone from the set", async () => {
    // `.ground-glyph` lived in `closer.html` and `headline-focus.html` only.
    // A designed large figure is still available where the CONTENT has a
    // number — `device: { kind: "figure" }` — which is a bounded, labelled
    // object rather than a decoration wearing a numeral's clothes.
    for (const { file, html } of await readTemplates()) {
      expect(markupOf(html), `${file} still renders a .ground-glyph`).not.toMatch(/class="ground-glyph"/);
      expect(styleOf(html), `${file} still declares .ground-glyph rules`).not.toMatch(/\.ground-glyph\s*\{/);
    }
  });

  it("every template carries data-n on its body, which is what the per-slide switch selects on", async () => {
    // `visualSystemCssBlock` writes `body[data-n="03"]`. A template without
    // the attribute silently opts out of every switch — the same class of
    // silent-absence defect as the two-of-eight numeral.
    for (const { file, html } of await readTemplates()) {
      expect(markupOf(html), `${file}'s body carries no data-n`).toMatch(/<body[^>]*data-n="\{\{slideIndex\}\}"/);
    }
  });
});

describe("every standing accent mark is hidden unless the system switches it on", () => {
  /**
   * The standing marks: a contentless bar, rule or cap whose only job is to be
   * brand-coloured. Each is named with the file it lives in, so a failure
   * points at the rule rather than at the suite.
   *
   * NOT in this list, deliberately, and each for a stated reason:
   *   - `.cmp-col.win`'s border, diamond and rule (`comparison-card.html`) —
   *     the accent there says WHICH COLUMN WON. That is `accentRole:
   *     "information"` doing its job, not furniture.
   *   - `.quote-block`'s 14px inline-start rule (`quote-card.html`) — it is
   *     the quotation mark of the archetype; it belongs to an object.
   *   - `.cl-ask` / `.cl-recap`'s caps (`closer.html`) — the closer is always
   *     in `accentSlides`, and the ask's band is this archetype's drawn
   *     device, which clause E reads.
   */
  /**
   * ── TWO ROWS USED TO NAME A MARK THAT COULD NOT PAINT, AND THAT IS WHY
   *    THERE IS A RENDERED LIMB BELOW THIS ONE NOW. ──
   *
   * `headline-focus.html`'s `.stat-band` and `closer.html`'s `.cl-rule` were
   * both dead, and NEITHER died of a complementary guard pair. Their real
   * guards, quoted off `HEAD~` rather than remembered:
   *
   *   headline-focus  `body:has(.hf-device .dv) .stat-band {display:none}`
   *                   `body:not(:has(#headline > span:not(:empty))) .stat-band {display:none}`
   *   closer          `body:not(:has(#takeaway > span:not(:empty))) .cl-rule {display:none}`
   *                   `body:has(.cl-ask .cl-question > span:not(:empty)) .cl-rule,`
   *                   `body:has(.cl-ask .cl-cta > span:not(:empty)) .cl-rule {display:none}`
   *
   * Two different conditions each. The closer's second guard is satisfied by
   * every closer the assembler builds (`contentFor` always routes `body` into
   * one of `question`/`cta`), so that bar was dead in the PIPELINE, not in the
   * CSS. `headline-focus.html`'s was not dead at all: a headline_focus with a
   * headline and no device painted it, which `composeBoundedObjects`' `refused`
   * outcome reaches routinely — that deletion is a real pixel change and the
   * template says so.
   *
   * Both rows stayed green the whole time, because this case only ever read
   * the declaration TEXT out of the source. `headline-focus.html` said so in a
   * comment: *"The rule stays declared and stays under the switch: it is what
   * `template-furniture.test.ts` reads to prove this archetype's mark is
   * switchable."* Markup kept alive to satisfy a guard is the definition of a
   * guard that cannot fail.
   *
   * Both elements are deleted now, and these rows name the mark each archetype
   * ACTUALLY paints. `the registry's marks paint a box` in the Chromium block
   * below renders every row with the switch ON and asserts a non-zero rect, so
   * a row that stops being reachable fails there rather than passing quietly.
   * That is the limb that answers this defect; the complementary-guard case
   * below answers a DIFFERENT one (see its own note) and would not have caught
   * either of these two.
   */

  it.each(SWITCHED)("$file's mark reads --$token rather than painting unconditionally", async ({ file, rule, token }) => {
    const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
    const block = rule.exec(styleOf(html))?.[0];
    expect(block, `${file}: the rule this test names no longer exists — rename the test, do not delete the guard`).toBeTruthy();
    // THE FALLBACK IS THE ASSERTION, not the presence of the token. Written as
    // `var(--fx-accent, block)` the mark reads the switch and still paints on
    // every plate that nobody switched on — the inversion reversed, and
    // invisible in a scan that only looked for the variable. Four of the eight
    // templates shipped exactly that for one revision of this phase, and the
    // Chromium block below is what caught it: an accent-on render measured
    // byte-identical accent share to an accent-off one.
    const fallback = token === "fx-accent" ? "none" : "transparent";
    expect(block, `${file}'s mark paints unconditionally`).toContain(`var(--${token}, ${fallback})`);
  });

  it("the file-level caps in slide.html and headline-focus.html take their ink from the switch", async () => {
    // These are `background-image` gradients rather than elements, so they
    // cannot be `display`-switched; they take `--fx-accent-ink` instead, which
    // leaves the geometry (and therefore every share the interest floor
    // measures) untouched and removes only the colour.
    for (const file of ["slide.html", "headline-focus.html", "closer.html"]) {
      const style = styleOf(await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8"));
      const caps = style.match(/linear-gradient\(to (?:top|bottom), var\(--[a-z-]+\) 0 calc\(\d+px/g) ?? [];
      expect(caps, `${file} still caps a field with the raw accent`).toEqual([]);
    }
  });

  /**
   * ── A MARK MUST NOT BE HIDDEN BY A TAUTOLOGY. ──
   *
   * The defect this exists for, in full: a mark acquires one guard, then a
   * second, and the two are COMPLEMENTS of each other —
   *
   *   body:has(C)      SEL { display: none }
   *   body:not(:has(C)) SEL { display: none }
   *
   * Every document matches exactly one of them, so the element is hidden on
   * every plate that can exist, and the case above stays green because a
   * declaration is still there.
   *
   * ── WHAT THIS CASE IS NOT. ──
   * It is NOT the control for the two marks this phase deleted. Neither
   * `.stat-band` nor `.cl-rule` had a complementary pair (the registry's own
   * note quotes what they actually had), and run against either pre-deletion
   * file this regex finds no intersecting condition and PASSES. Saying
   * otherwise would make this the second unfalsifiable guard in a file about
   * unfalsifiable guards. The limb that answers those two is `the registry's
   * marks paint a box`, which measures a rect.
   *
   * What it does answer is the shape above, which this set has reached before
   * and which no rendered limb can see on a machine with no browser.
   * Source-level rather than rendered, deliberately: it runs in every
   * environment, it names the exact pair rather than a share that moved, and it
   * cannot be satisfied by adding a third guard.
   *
   * It looks for `body:has(C) SEL {display:none}` and `body:not(:has(C)) SEL
   * {display:none}` over the same condition `C`. Two guards on DIFFERENT
   * conditions are fine and common — that is a mark that paints when both hold.
   */
  it.each(SWITCHED)("$file's $selector is not hidden by a pair of complementary guards", async ({ file, selector }) => {
    const style = styleOf(await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8"));
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // `[^{}]*` on the selector list so a rule's own body can never be scanned
    // as a selector, and `[^}]*display:\s*none` so only HIDING rules count.
    const guard = new RegExp(String.raw`body(:not\(:has\((?<negated>[^)]*\)?[^)]*)\)\)|:has\((?<direct>[^)]*\)?[^)]*)\))[^{}]*${escaped}[^{}]*\{[^}]*display:\s*none`, "gu");
    const direct = new Set<string>();
    const negated = new Set<string>();
    for (const match of style.matchAll(guard)) {
      if (match.groups?.["direct"] !== undefined) direct.add(match.groups["direct"].trim());
      if (match.groups?.["negated"] !== undefined) negated.add(match.groups["negated"].trim());
    }
    const both = [...direct].filter((condition) => negated.has(condition));
    expect(
      both,
      `${file}: ${selector} is hidden both when (${both.join(", ")}) holds and when it does not — the two guards partition every document, so this mark can never paint. ` +
        `Delete the element, or make one of the guards conditional on something else.`,
    ).toEqual([]);
  });

  it("no template sets a --fx-* switch itself — the switch belongs to the run's system, not to a file", async () => {
    // A template that set its own `--fx-accent: block` would re-create the
    // unconditional paint through the back door and nothing downstream could
    // see it.
    for (const { file, html } of await readTemplates()) {
      expect(styleOf(html), `${file} sets a furniture switch itself`).not.toMatch(/--fx-(accent|accent-ink|pagination)\s*:/);
    }
  });
});

describe("one type scale, declared by every template", () => {
  const STEPS = ["micro", "label", "lead", "statement", "display", "figure"] as const;

  it("every template declares all six steps with the same values", async () => {
    const seen = new Map<string, Set<string>>();
    for (const { file, html } of await readTemplates()) {
      const style = styleOf(html);
      for (const step of STEPS) {
        const declaration = new RegExp(`--t-${step}:\\s*([^;]+);`).exec(style)?.[1]?.trim();
        expect(declaration, `${file} does not declare --t-${step}`).toBeTruthy();
        seen.set(step, (seen.get(step) ?? new Set()).add(declaration!));
      }
    }
    // One value per step ACROSS the set: a scale that differs per file is not
    // a scale, it is the 45 distinct sizes this phase replaced wearing six
    // names.
    for (const step of STEPS) expect([...seen.get(step)!], `--t-${step} differs between templates`).toHaveLength(1);
  });

  it("every step folds in --ts, so the reviewer's type control still reaches it", async () => {
    // `default-template-render.test.ts` pins that no template carries a bare
    // px `font-size`; moving sizes into custom properties would defeat that
    // rule silently if the properties themselves dropped `--ts`.
    for (const { file, html } of await readTemplates()) {
      for (const step of STEPS) {
        const declaration = new RegExp(`--t-${step}:\\s*([^;]+);`).exec(styleOf(html))?.[1] ?? "";
        expect(declaration, `${file}'s --t-${step} does not scale with --ts`).toContain("var(--ts, 1)");
      }
    }
  });

  /**
   * ── WHERE THE STEPS ARE DECLARED IS THE WHOLE OF WHETHER THEY WORK. ──
   *
   * A custom property's `var()` references are substituted AT THE ELEMENT THAT
   * DECLARES IT. `--ts` is `1` on `:root` and is overridden on `body.ts-s` /
   * `body.ts-l`, so `--t-display: calc(124px * var(--ts, 1))` declared on
   * `:root` resolves against the ROOT's `--ts` — always 1 — and inherits down
   * already substituted. The test above ("every step folds in --ts") passes on
   * that document and means nothing, which is exactly what happened: the set
   * shipped with the steps on `:root` and the reviewer's whole type-scale
   * control stopped reaching any size that reads one. Measured at the time:
   * the stat plate rendered its 300px figure at 300px at `ts-s` where the
   * literal it replaced rendered 255px, and the calibration's own s-vs-l
   * control pair reported the two covers painting identical ink (0.4175 both).
   *
   * So the scan is about the SELECTOR, not the value.
   */
  it("the six steps are declared on `body`, where --ts is actually in scope", async () => {
    for (const { file, html } of await readTemplates()) {
      const style = styleOf(html);
      for (const step of STEPS) {
        // The rule the declaration sits in: everything back to the previous
        // `{`'s selector.
        const at = style.indexOf(`--t-${step}:`);
        expect(at, `${file} does not declare --t-${step}`).toBeGreaterThan(-1);
        const selector = style.slice(0, at).lastIndexOf("{");
        const opener = style.slice(0, selector).split(/[};]/).pop()!.trim();
        expect(opener, `${file} declares --t-${step} on \`${opener}\`, where body.ts-s/.ts-l cannot reach it`).toBe("body");
      }
      expect(/:root\s*\{[^}]*--t-/.test(style), `${file} still declares a scale step on :root`).toBe(false);
    }
  });

  /**
   * ── THE PAGE MARGIN IS AN AXIS, AND IT IS DECLARED WHERE THE AXIS LANDS. ──
   *
   * `--gutter` is the visual system's own `gutter` axis (`wide` 64px, `tight`
   * 48px), emitted per run on `body` by `visualSystemCssBlock`. Before this
   * phase every template hard-coded `--mx`, so two catalog entries that differ
   * ONLY in gutter rendered identical geometry and the twelve-entry catalog
   * was a variety claim a reader could not see. Same substitution rule as the
   * steps above: on `:root` the run's value is out of scope.
   */
  it("the page margin is derived from --gutter, on `body`", async () => {
    for (const { file, html } of await readTemplates()) {
      const style = styleOf(html);
      const at = style.indexOf("--mx:");
      expect(at, `${file} does not declare --mx`).toBeGreaterThan(-1);
      const declaration = style.slice(at, style.indexOf(";", at));
      expect(declaration, `${file}'s --mx is a literal, so the gutter axis cannot move it`).toContain("var(--gutter,");
      const selector = style.slice(0, style.slice(0, at).lastIndexOf("{"));
      expect(selector.split(/[};]/).pop()!.trim(), `${file} declares --mx where --gutter is out of scope`).toBe("body");
    }
  });

  /**
   * ── AND THE DISPLAY TYPE TAKES A STEP TOO, WHICH IS WHERE THE SCALE WAS
   *    STILL A DECORATION. ──
   *
   * The furniture scan below has always covered the 22px and 32px steps. The
   * four ABOVE them — `lead`, `statement`, `display`, `figure` — were declared
   * by every template and read by none: every display size was a per-file
   * literal (`.hf-headline` 124, `.headline` 76/96/100/104, `.num-figure` 300),
   * so `typeScaleDeclarations`' flavour multiplier — which applies to exactly
   * those four steps — changed nothing at all, and `display` vs `editorial` vs
   * `condensed`, a designed 30% spread, was a token with no pixels behind it.
   *
   * Every `font-size` in the set now references a step. A per-file literal
   * fails here the way a bare px already fails
   * `default-template-render.test.ts`.
   *
   * ── AND REFERENCING A STEP IS NOT THE SAME AS LANDING ON ONE. ──
   * This case reads the FORM. What the form permits is
   * `calc(var(--t-display) * 0.8387)`, and the rendered set is therefore six
   * steps times however many per-role factors the eight files declare between
   * them — measured through the production composition with the probe's type
   * limb CORRECTED (it used to compare every rendered size against the
   * UNFLAVOURED base table, which inflated every off-scale list it printed for
   * a non-`display` run), **19 to 30 distinct rendered sizes per carousel, with
   * up to 39 type hosts on no step of the scale at all**. The earlier figure in
   * this note, 23-30, was taken with the broken limb.
   * The case below is what puts a number on that and stops it growing.
   */
  it("no font-size in the set is a per-file literal — every one is a step of the scale", async () => {
    for (const { file, html } of await readTemplates()) {
      const style = styleOf(html);
      const sizes = [...style.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
      expect(sizes.length, `${file} declares no font-size at all`).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(size, `${file} sets a font-size (${size}) that does not come from the type scale`).toMatch(/var\(--t-(micro|label|lead|statement|display|figure)\)/);
      }
    }
  });

  /**
   * ── WHAT "A SIX-STEP SCALE" ACTUALLY COSTS, COUNTED. ──
   *
   * The case above proves every size REFERENCES a step. It says nothing about
   * how many sizes the set renders, and the answer is the round-1 Major: six
   * steps multiplied by a per-role factor per host is not a six-step scale.
   * Counted here rather than argued, because the count is the whole finding:
   * on this tree the eight bundled files declare **50 distinct multipliers**
   * on top of the six steps, from 1.5 down to 0.3636. Through the production
   * composition that renders as 19-30 distinct sizes per carousel and up to 39
   * type hosts off every step (`.local/owner-check.mjs`'s off-scale list).
   *
   * IT WAS 51 AND IT CAME DOWN BY ONE, which is the direction this case exists
   * to record: `slide.html`'s heroless statement rungs moved from
   * `--t-statement * 1.1429` / `* 1` onto `headline-focus.html`'s own
   * `--t-display * 1` / `* 0.8387`, so `1.1429` left the set and no new factor
   * arrived. The two shapeless archetypes now share one display ladder.
   *
   * ── THIS CASE IS NOT A CLOSURE, AND SAYING SO IS PART OF THE FIX. ──
   *
   * **The round-1 type-scale Major is DEFERRED, with this ratchet as the only
   * interim control.** A reviewer should read it that way and not as an
   * answer. What is still true after Phase 5.5: the set renders 19-30 distinct
   * sizes per carousel and essentially every display host is off its own run's
   * steps, because each file multiplies a step by its own literal. The two
   * honest fixes are both large — derive every per-role factor from the ratios
   * BETWEEN steps so each host lands on one, or stop calling it a six-step
   * scale and drop the `typeScale` axis from the system payload — and either
   * is a typographic re-set of eight files that has to be swept through CI
   * before it ships. Neither is in this phase.
   *
   * What IS closed of that finding is the other half, and it is measured: the
   * flavour axis now moves pixels. `editorial` renders 22/32/40/72/107/189
   * against `condensed`'s 22/32/52/94/139/246 on the same plate, read off the
   * document's own `--t-*` by `.local/owner-check.mjs`.
   *
   * What this case refuses in the meantime is the number going UP silently,
   * which is how it got to 51 before this phase brought it to 50: a new per-role factor fails here, in the diff
   * that adds it, with the count beside it. Phase 5.5's own type change —
   * `slide.html`'s heroless statement moving onto the display step — was made
   * with `headline-focus.html`'s EXISTING multipliers for exactly that reason,
   * so it cost the ratchet nothing.
   *
   * `interest-floor.ts`'s `TYPE_STEP_CEILING` is the same claim measured on
   * the PIXELS rather than on the source, and it ships `*_ARMED = false` — so
   * no run can produce a `type-discipline` finding this phase either. The
   * gate-zero sweep prints its distribution on every row, which is what the
   * pass that arms it will read.
   */
  it("the six-step scale is six steps and 50 per-role multipliers, and that count only comes down", async () => {
    const multipliers = new Set<string>();
    for (const { html } of await readTemplates()) {
      const style = styleOf(html);
      for (const match of style.matchAll(/font-size:\s*([^;}]+)/g)) {
        const step = /var\(--t-(?:micro|label|lead|statement|display|figure)\)(?:\s*\*\s*([0-9.]+))?/u.exec(match[1]!.trim());
        // The case above is the one that fails on a size with no step in it.
        if (step === null) continue;
        multipliers.add(step[1] ?? "1");
      }
    }
    const sorted = [...multipliers].sort((a, b) => Number(b) - Number(a));
    expect(
      multipliers.size,
      `the set declares ${multipliers.size} distinct type multipliers on top of six steps: ${sorted.join(", ")}. ` +
        `If this went UP, a new per-role factor was added and the scale got further from being one — see this case's own note. ` +
        `If it went DOWN, lower the number here in the same commit and say which hosts came onto a step.`,
    ).toBeLessThanOrEqual(50);
  });

  it("every standing furniture size is a scale step, not a per-file literal", async () => {
    // The handle, the badge and the pagination index are the same object on
    // every plate of every post; they had four different sizes across the set
    // (17, 19, 22, 24px).
    for (const { file, html } of await readTemplates()) {
      const style = styleOf(html);
      for (const selector of [".brand-handle", ".brand-badge", ".pg-index"]) {
        const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(style)?.[0] ?? "";
        expect(block, `${file} has no ${selector} rule`).toBeTruthy();
        expect(block, `${file}'s ${selector} sets its own size instead of taking a scale step`).toMatch(/font-size:\s*var\(--t-micro\)/);
      }
    }
  });
});


/**
 * ── THE PIXEL HALF. Chromium-gated; CI is its authority. ──
 *
 * The source scan above proves every mark READS a switch. This proves the
 * switch DOES something — that an accent-off plate paints no accent and an
 * accent-on plate does — which is the only form of the claim a reader of the
 * CSS cannot check for themselves.
 *
 * All eight archetypes, because the defect was a set-level one. The visual
 * system's stylesheet is spliced through `composeRawDocument`'s
 * `extraHeadHtml` channel, which is the same channel the workflow will use
 * (`headExtras()`, beside `deviceCssBlock()`), so this renders the document
 * production composes rather than a hand-assembled approximation.
 *
 * `KAROS_BROWSER_CHANNEL=chrome` renders locally with installed Chrome, which
 * is HARSHER than CI — a local failure here is not automatically a regression.
 */
describe.skipIf(!isChromiumInstalled())("the switch reaches the pixels (Chromium)", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  /** The measured accent of the calibration renders, and the one the metrics are told to look for. */
  const ACCENT = "#C4552F";
  let workDir = "";

  afterEach(async () => {
    if (workDir !== "") await fs.rm(workDir, { recursive: true, force: true });
    workDir = "";
  });

  /**
   * Copies the eight templates into a directory with `extra` spliced before
   * `</head>`, exactly as `composeRawDocument` does in production.
   *
   * The directory is NAMED by the caller. It used to be derived from whether
   * `extra` was `undefined`, which was fine while the only control was "no
   * sheet at all" — and silently wrong the moment a caller wanted two DIFFERENT
   * sheets: both landed in `on/`, the second overwrote the first, and the case
   * compared a document with itself and reported `0.00721948945473251` twice.
   */
  async function materialise(name: string, extra: string | undefined): Promise<string> {
    const dir = path.join(workDir, name);
    await fs.mkdir(dir, { recursive: true });
    for (const file of ARCHETYPE_TEMPLATE_FILES) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      await fs.writeFile(path.join(dir, file), composeRawDocument(html, undefined, undefined, extra), "utf8");
    }
    return dir;
  }

  const ROWS = buildListRows([
    { title: "Name one owner", note: "Not a committee." },
    { title: "Publish on a cadence", note: "Weekly beats perfect." },
    { title: "Measure the second month", note: "Month one always looks fine." },
  ]);

  /** One slide, rendered with measurement on. Copy long enough that every archetype composes rather than collapsing to an empty plate. */
  async function measure(dir: string, file: string, slide: number): Promise<SlideMetrics> {
    const outDir = path.join(workDir, `out-${path.basename(dir)}-${file}`);
    await fs.mkdir(outDir, { recursive: true });
    const fields: Record<string, string> = {
      accentColor: ACCENT,
      dir: "ltr",
      lang: "en",
      fontScale: "m",
      textAlign: "start",
      groundStyle: "grid",
      slideIndex: String(slide).padStart(2, "0"),
      kicker: "FIELD NOTES",
      eyebrow: "FIELD NOTES",
      headline: "Most marketing calendars fail in month two",
      title: "Most marketing calendars fail in month two",
      takeaway: "Most marketing calendars fail in month two",
      body: "The pattern is always the same, and it is visible in the first fortnight of the second month.",
      subtitle: "The pattern is always the same, and it is visible in the first fortnight.",
      cta: "Save this for your next planning cycle.",
      figure: "72%",
      subLabel: "of calendars slip",
      sourceLine: "Internal audit, 2026",
      quoteText: "We rebuilt the calendar three times before it held.",
      attribution: "A head of content",
      leftLabel: "Before",
      leftBody: "Four owners, no cadence.",
      rightLabel: "After",
      rightBody: "One owner, one cadence.",
    };
    const tool = createRenderCarousel();
    const outcome = await tool.execute(
      {
        client: "furniture-test",
        postId: "p",
        templateDir: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"),
        outDir: path.relative(REPO_ROOT, outDir).replaceAll("\\", "/"),
        repoRoot: REPO_ROOT,
        // `measure` is a BOOLEAN on the input and an anchor OBJECT on each
        // slide: without `accentHex` the measurement reports `accentShare: 0`
        // for every render, and this whole comparison would be 0 > 0.
        // `list-takeaway.html` guards its accent cap on `.me-rows:not(:empty)`,
        // so a plate with no rows carries no cap and the comparison would be
        // 0 > 0 for a guard that is working perfectly. The fragment is built
        // by the same `buildListRows` the composition uses.
        slides: [{ n: slide, template: file, fields, images: {}, htmlFragments: file === "list-takeaway.html" ? { itemRows: ROWS } : {}, measure: { accentHex: ACCENT } }],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        measure: true,
      } as never,
      { ctx: { runId: "furniture", clientSlug: "furniture-test", productId: "instagram-agent", runKind: "setup" as const, metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(`render failed for ${file}: ${JSON.stringify(outcome)}`);
    const metrics = outcome.result.rendered[0]?.metrics;
    if (metrics === undefined) throw new Error(`${file} came back without metrics`);
    return metrics;
  }

  it(
    "an accent-ON slide carries more accent ink than the same slide with the accent off, on every archetype",
    async () => {
      workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-furniture-"));
      // Slide 3 of an 8-slide post: an interior, which under the default
      // `[1, mid, n]` set is NOT an accent slide — so switching it on is the
      // difference this test measures.
      const client = fallbackClientVisualSystem({ clientSlug: "furniture-test", palette: ["#A", "#B", "#C"] });
      const system = pickVisualSystem({ clientSlug: "furniture-test", paletteSeed: "seed", slideCount: 8, client });
      const on = visualSystemCssBlock({ ...system, accentForm: "rule", accentSlides: [3], numeralSlides: [3] });
      // ── THE CONTROL IS THE SAME SYSTEM WITH THE SWITCH OFF, NOT NO SYSTEM. ──
      //
      // This used to render the OFF document with no sheet at all, which made
      // "the switch" and "the whole visual system" one variable. That was
      // harmless while the sheet's only job was the two `--fx-*` switches. It
      // stopped being harmless when the sheet started carrying the axes that
      // reach the pixels — `--gutter`, `--cover-band`, the type scale's flavour
      // — and the cover's masthead then differed by its own HEIGHT between the
      // two documents: 2.6% of the frame, attributed to a switch that paints
      // nothing on a cover. Same system, same axes, one switch apart is the
      // comparison the case's own name makes.
      const off = visualSystemCssBlock({ ...system, accentForm: "rule", accentSlides: [], numeralSlides: [] });
      // ── THE TWO DELIBERATE EXEMPTIONS, PINNED AS NON-MOVEMENT. ──
      //
      // Stronger than a skip: these two say the switch must NOT move these
      // plates, and they are the lines that would fail if a later tidy-up
      // swept either exemption into the switch.
      //
      // The tolerance is 0.001 of the frame rather than exact equality,
      // because the accent-on document also carries the pagination index and
      // an antialiased 22px glyph lands a few pixels inside the accent's
      // measurement tolerance. Measured on this tree with installed Chrome the
      // cover's two shares differ by 3.2e-7, so 0.001 is three orders of
      // magnitude of headroom over the noise. It is a ceiling on NON-movement
      // only; every other archetype is still held to a strict increase, which
      // is the assertion that would catch a mark that stopped painting.
      const UNMOVED: Record<string, string> = {
        // The cover carries NO furniture at all (spec §4.5): its `.stat-band`
        // div is deleted from the markup rather than switched. What accent it
        // has is the field ramp, which is the composition, not a mark.
        "cover.html": "the cover's accent moved, and a cover has no switchable furniture at all",
      };
      // ── `comparison-card.html` LEFT THIS TABLE, AND THE REASON IT WAS IN IT
      //    STOPPED BEING TRUE. ──
      //
      // The exemption read: *"its only standing decorative mark is the figure
      // band's rule, which needs a photograph this fixture does not supply"*.
      // That was correct while `.cmp-rail` was a NEUTRAL 952x2 hairline at 48%
      // of the foreground — switching it on and off moved the ACCENT share by
      // nothing, so the plate measured as unmoved. This phase made `.cmp-rail`
      // the archetype's accent mark (`--fx-accent-w` x `--fx-accent-h` in
      // `var(--accent)`), and measured on this tree through real Chromium the
      // switch now moves it by 0.0015432 — 480x20 device px of 6,220,800,
      // exactly the rail — which is over the 0.001 non-movement ceiling.
      //
      // So it is held to the STRICT INCREASE every other archetype is held to,
      // which is the stronger assertion of the two. What has NOT changed is the
      // reason the exemption existed: `.cmp-col.win`'s border, diamond and rule
      // are `accentRole: "information"` — they say which column won — and they
      // still paint in both documents. A change that swept them into the switch
      // would leave an accent-off comparison card unreadable AS a comparison,
      // and it would show up here as a much larger delta than the rail's.
      const offDir = await materialise("off", off);
      const onDir = await materialise("on", on);
      for (const file of ARCHETYPE_TEMPLATE_FILES) {
        const offMetrics = await measure(offDir, file, 3);
        const onMetrics = await measure(onDir, file, 3);
        const unmoved = UNMOVED[file];
        if (unmoved !== undefined) {
          expect(Math.abs(onMetrics.accentShare - offMetrics.accentShare), `${file}: ${unmoved}`).toBeLessThan(0.001);
          continue;
        }
        expect(onMetrics.accentShare, `${file}: switching the accent on painted no more accent than leaving it off`).toBeGreaterThan(offMetrics.accentShare);
      }
    },
    600_000,
  );
});

/**
 * ── THE ROW REGISTRY'S OWN RENDERED LIMB: A REGISTERED MARK MUST REACH A BOX. ──
 *
 * The defect this exists for is the one the registry's note describes, and
 * neither the declaration scan nor the complementary-guard case can see it: a
 * mark stops being reachable, the rule it declares is still in the file, and
 * the row stays green. `headline-focus.html`'s `.stat-band` and
 * `closer.html`'s `.cl-rule` both did that — one because the pipeline always
 * satisfied its hiding condition, one because it painted only on a state the
 * registry's fixture never rendered.
 *
 * So every SWITCHED row is rendered with the switch ON, in real Chromium, and
 * measured according to how its mark actually paints (`paint`):
 *   * `element`    — a non-zero `getBoundingClientRect` and `display !== none`.
 *   * `background` — a non-zero rect AND the accent resolved into
 *                    `background-image`. The rect alone would pass on a host
 *                    whose `--fx-accent-ink` never resolved, which is exactly
 *                    the regression the `fx-accent-ink` rows exist to catch.
 *   * `::before` / `::after` — a pseudo-element has no rect, so its computed
 *                    `display`, `width` and `height` are the measurement.
 * And the one row with `rendered: false` is asserted ABSENT from the markup,
 * so the exemption cannot cover an element somebody deleted by accident.
 *
 * Playwright directly rather than through `renderCarousel`, for the reason
 * `cover-subject.test.ts` reads the DOM the same way: this measures BOXES, and
 * `SlideMetrics` cannot tell you which element a share belongs to.
 *
 * `KAROS_BROWSER_CHANNEL=chrome` renders locally with installed Chrome, which
 * is HARSHER than CI — a local failure here is not automatically a regression.
 */
describe.skipIf(!isChromiumInstalled())("the registry's marks paint a box (Chromium)", () => {
  /** The accent every row is rendered with, and the ink the `background` rows are checked for. */
  const ACCENT_HEX = "#C4552F";
  const ACCENT_RGB = "rgb(196, 85, 47)";
  /** A 2x2 opaque PNG. `.sc-figure-band` collapses on an empty `src`, so the band rows need a picture in the slot. */
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AzbAxIAdjEoRIwUAJUcCA0ap6bcAAAAASUVORK5CYII=";

  let browser: Browser | undefined;

  beforeAll(async () => {
    const channel = process.env["KAROS_BROWSER_CHANNEL"]?.trim();
    browser = await chromium.launch(channel !== undefined && channel.length > 0 ? { channel } : {});
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * The switch ON for slide 3, with every other axis of the run sheet exactly
   * as the accent-delta case above sets it — same system, same `accentForm`, so
   * a row that fails here fails for the switch and not for the sheet.
   */
  function sheetOn(): string {
    const client = fallbackClientVisualSystem({ clientSlug: "furniture-test", palette: ["#A", "#B", "#C"] });
    const system = pickVisualSystem({ clientSlug: "furniture-test", paletteSeed: "seed", slideCount: 8, client });
    return visualSystemCssBlock({ ...system, accentForm: "rule", accentSlides: [3], numeralSlides: [3] });
  }

  /** Every slot filled, so no row is measuring a guard that is working perfectly. */
  const FIELDS: Record<string, string> = {
    accentColor: ACCENT_HEX,
    dir: "ltr",
    lang: "en",
    fontScale: "m",
    textAlign: "start",
    groundStyle: "grid",
    slideIndex: "03",
    brandHandle: "@furniture",
    kicker: "FIELD NOTES",
    eyebrow: "FIELD NOTES",
    headline: "Most marketing calendars fail in month two",
    title: "Most marketing calendars fail in month two",
    takeaway: "Most marketing calendars fail in month two",
    body: "The pattern is always the same, and it is visible in the first fortnight of the second month.",
    subtitle: "The pattern is always the same, and it is visible in the first fortnight.",
    question: "Which one would you change first?",
    cta: "Save this for your next planning cycle.",
    figure: "72%",
    subLabel: "of calendars slip",
    sourceLine: "Internal audit, 2026",
    quoteText: "We rebuilt the calendar three times before it held.",
    attribution: "A head of content",
    leftLabel: "Before",
    leftBody: "Four owners, no cadence.",
    rightLabel: "After",
    rightBody: "One owner, one cadence.",
  };

  const FRAGMENTS: Record<string, string> = {
    itemRows: buildListRows([
      { title: "Name one owner", note: "Not a committee." },
      { title: "Publish on a cadence", note: "Weekly beats perfect." },
      { title: "Measure the second month", note: "Month one always looks fine." },
    ]),
    recap:
      '<div class="rc-strip"><div class="rc-plate"><div class="rc-n">01</div><div class="item-title">Name one owner</div></div>' +
      '<div class="rc-plate"><div class="rc-n">03</div><div class="item-title">Publish weekly</div></div></div>',
  };

  interface MarkBox {
    w: number;
    h: number;
    display: string;
    backgroundImage: string;
    borderColour: string;
  }

  /** The production composition, slots filled, opened at the carousel's own canvas. */
  async function open(file: string): Promise<{ read: (selector: string, pseudo: string | null) => Promise<MarkBox>; close: () => Promise<void> }> {
    const template = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
    let html = composeRawDocument(template, undefined, undefined, `<style>${sheetOn()}</style>`);
    for (const [key, fragment] of Object.entries(FRAGMENTS)) html = html.replaceAll(`{{html:${key}}}`, fragment);
    for (const [key, value] of Object.entries(FIELDS)) html = html.replaceAll(`{{${key}}}`, value);
    html = html.replaceAll("{{image:hero}}", TINY_PNG).replace(/\{\{(?:html:|image:)?[A-Za-z0-9_]+\}\}/gu, "");
    const page = await browser!.newPage({ viewport: { width: 1080, height: 1440 } });
    await page.setContent(html, { waitUntil: "load" });
    // The same order `renderCarousel` waits in: the ready flag, then the fonts.
    // Four templates defer the flag behind a post-web-font layout pass.
    await page.waitForFunction(() => (window as unknown as Record<string, unknown>)["__CAROUSEL_READY__"] === true, undefined, { timeout: 10_000 }).catch(() => {});
    return {
      read: async (selector, pseudo) =>
        (await page.evaluate(
          ([sel, pse]) => {
            const el = document.querySelector(sel as string);
            if (el === null) return { w: -1, h: -1, display: "(no element)", backgroundImage: "", borderColour: "" };
            const style = getComputedStyle(el, (pse as string | null) ?? undefined);
            const rect = el.getBoundingClientRect();
            return {
              // A pseudo-element has no box of its own to ask for, so its
              // computed width/height are the only reading available; a real
              // element's rect is the truth and is preferred.
              w: pse === null ? rect.width : parseFloat(style.width) || 0,
              h: pse === null ? rect.height : parseFloat(style.height) || 0,
              display: style.display,
              backgroundImage: style.backgroundImage,
              borderColour: style.borderBlockStartColor,
            };
          },
          [selector, pseudo] as [string, string | null],
        )) as MarkBox,
      close: () => page.close(),
    };
  }

  it.each(SWITCHED)(
    "$file's $selector paints a box with the switch on",
    async ({ file, selector, paint, rendered, absent }) => {
      if (rendered === false) {
        // Not a skip: the claim is that the ELEMENT is deliberately absent, and
        // that is asserted, so a row cannot hide behind the exemption.
        const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
        expect(markupOf(html), `${file}: ${selector} is in the markup after all — ${absent ?? "(no reason recorded)"}`).not.toContain(`class="${selector.slice(1)}"`);
        return;
      }
      const page = await open(file);
      try {
        const pseudo = paint === "::before" || paint === "::after" ? paint : null;
        const box = await page.read(selector, pseudo);
        expect(box.display, `${file}: ${selector}${pseudo ?? ""} is not rendered at all (display ${box.display})`).not.toBe("none");
        expect(box.w, `${file}: ${selector}${pseudo ?? ""} has zero width with the accent switched ON — this registered mark cannot reach a pixel`).toBeGreaterThan(0);
        expect(box.h, `${file}: ${selector}${pseudo ?? ""} has zero height with the accent switched ON — this registered mark cannot reach a pixel`).toBeGreaterThan(0);
        if (paint === "background" || paint === "border") {
          // The rect alone is worthless here: `.hf-field`, `.cl-art` and
          // `.me-rows` are full-size hosts that have a box whether or not their
          // cap paints. The INK is the mark, and it has to be read off the
          // property the cap actually uses — `.me-rows` carries a `color-mix`
          // panel tint in its background-image and its cap on the border, so
          // reading the background there would report the tint and pass a row
          // whose cap had stopped resolving.
          const channel = paint === "border" ? box.borderColour : box.backgroundImage;
          expect(
            channel.includes(ACCENT_RGB),
            `${file}: ${selector}'s ${paint === "border" ? "border-block-start-color" : "background-image"} carries no accent ink with the switch ON (${channel.slice(0, 160)})`,
          ).toBe(true);
        }
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
