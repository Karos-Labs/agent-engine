import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
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
  const SWITCHED: { file: string; rule: RegExp; token: "fx-accent" | "fx-accent-ink" }[] = [
    { file: "slide.html", rule: /\.stat-band\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "cover.html", rule: /\.stat-band\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "headline-focus.html", rule: /\.stat-band\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "stat-callout.html", rule: /\.stat-band\s*\{[^}]*\}/, token: "fx-accent" },
    // `.cl-rule` is declared twice in `closer.html` (a margin rule and the
    // mark itself), so the pattern names the one that paints.
    { file: "closer.html", rule: /\.cl-rule\s*\{[^}]*background:\s*var\(--accent\)[^}]*\}/, token: "fx-accent" },
    { file: "quote-card.html", rule: /\.qc-foot::before\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "comparison-card.html", rule: /\.sc-figure-band::after\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "list-takeaway.html", rule: /\.sc-figure-band::after\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "quote-card.html", rule: /\.sc-figure-band::after\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "stat-callout.html", rule: /\.sc-figure-band::after\s*\{[^}]*\}/, token: "fx-accent" },
    { file: "list-takeaway.html", rule: /\.me-rows:not\(:empty\)\s*\{[^}]*\}/, token: "fx-accent-ink" },
  ];

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
        // This archetype's accent is INFORMATION: it marks which column won
        // (`.cmp-col.win`'s border, diamond and rule). Its only standing
        // decorative mark is the figure band's rule, which needs a photograph
        // this fixture does not supply. A change that swept `.cmp-col.win`
        // into the switch would leave an accent-off comparison card
        // unreadable AS a comparison.
        "comparison-card.html": "the switch moved an accent that encodes information",
      };
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
