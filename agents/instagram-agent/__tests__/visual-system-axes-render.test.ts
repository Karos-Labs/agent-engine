import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { COLLISION_WATCH_CLASSES, createRenderCarousel, type RenderCarouselInput } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { decodePngRows } from "@agent-engine/tool-common";
import { buildBrandHeadHtml, type BrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import { buildScriptFontHeadForLanguage } from "../src/workflow/script-fonts.js";
import { buildMarkRing, markCssBlock } from "../src/workflow/emphasis-marks.js";
import { deviceCssBlock } from "../src/workflow/slide-devices.js";
import {
  COMPOSITION_ANCHOR,
  COMPOSITION_GRAMMARS,
  DISPLAY_REGISTERS,
  DISPLAY_REGISTER_SCRIPTS,
  VISUAL_SYSTEM_CATALOG,
  accentSlidesFor,
  clientVisualSystemCss,
  fallbackClientVisualSystem,
  interiorSlides,
  resolveDisplayRegisterForScript,
  visualSystemCssBlock,
  type CarouselVisualSystem,
  type ClientVisualSystem,
  type CompositionGrammar,
  type DisplayRegister,
} from "../src/workflow/visual-system.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * ── A NEW AXIS IS A NEW SET OF METRICS, AND NOTHING MEASURED ONE. ──
 *
 * Phase 5.5 added six frozen per-client axes and a twelve-entry per-run
 * catalog. Every one of them is a decision about the PIXELS, and the only
 * instruments the phase shipped for them were source scans
 * (`template-furniture.test.ts`) and unit tests over the pure picker
 * (`visual-system.test.ts`). Neither can see what a browser does with a face
 * it has never laid out before.
 *
 * Two defects shipped through that gap and this file is the answer to both.
 *
 * **1. `condensed` refused three plates of every carousel it touched.** An
 * inline box's border box is the FONT's content area, and `--mk-twin-bleed`'s
 * `.14em` was measured against Fraunces (max 0.10em) and Inter (0.09em) alone.
 * Oswald overshoots 0.22em. So `cover.html`, `slide.html`,
 * `headline-focus.html` and `closer.html` all reported `probe.overflow` with
 * `["span.mk-runs","span.mk-plain"]`, interest-floor clause B refused all four
 * as `clipped`, and its steer — *"shorten the headline"* — cannot fix a font
 * metric: the whole redraft budget burned and the post shipped degraded.
 *
 * **2. Five of the nine decisions reached no template at all.**
 * `--fx-accent-form`, `--system-cover`, `--system-ground`, `--system-grammar`
 * and `--gutter` were emitted and read by nothing, so two catalog entries
 * differing on four axes rendered structurally identical plates and the
 * variety claim on the gate payload was one a reader could not see.
 *
 * Chromium-gated; CI is the authority on the numbers.
 * `KAROS_BROWSER_CHANNEL=chrome` renders locally with installed Chrome, which
 * is HARSHER than CI, so a local failure is not automatically a regression.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");
const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 } as const;
const ACCENT = "#C4552F";

/** Every bundled archetype, in the positions a real carousel puts them in. */
const PLATES: ReadonlyArray<readonly [string, number]> = [
  ["cover.html", 1],
  ["stat-callout.html", 2],
  ["slide.html", 3],
  ["headline-focus.html", 4],
  ["list-takeaway.html", 5],
  ["quote-card.html", 6],
  ["comparison-card.html", 7],
  ["closer.html", 8],
];

const ROWS =
  `<li class="item"><span class="item-num">01</span><div><div class="item-title">Name the owner</div><div class="item-body">One person holds the cadence.</div></div></li>` +
  `<li class="item"><span class="item-num">02</span><div><div class="item-title">Cut the slate</div><div class="item-body">Three pieces beats nine.</div></div></li>` +
  `<li class="item"><span class="item-num">03</span><div><div class="item-title">Publish on a clock</div><div class="item-body">Same day, same hour, always.</div></div></li>`;

/**
 * The closer's recap strip, in `buildRecapFragment`'s own markup.
 *
 * Supplied because a closer that does not carry one is not the plate this
 * agent ships: the fragment needs `MIN_RECAP_PLATES` earlier slides and every
 * carousel has them, and it takes 447-646px out of the one elastic middle the
 * takeaway and the ask are already competing for. A sweep that rendered the
 * closer WITHOUT it measured a plate with several hundred px of room the real
 * one does not have — which is half of why the CTA-on-the-watermark defect
 * survived a sweep designed to catch exactly that.
 */
const RECAP =
  `<div class="rc-strip">` +
  [
    ["01", "Most marketing calendars quietly fall…"],
    ["03", "A checklist is worth two working days"],
    ["05", "Five rounds of revisions became two"],
    ["07", "What we would do first if we started…"],
  ]
    .map(([n, title]) => `<div class="rc-plate"><div class="rc-n">${n}</div><div class="item-title">${title}</div></div>`)
    .join("") +
  `</div>`;

/**
 * The same copy on every plate of every case, so the ONLY variable between two
 * renders is the axis under test. Long enough that each archetype's own length
 * ladder has picked a step below its largest, which is where an overshoot
 * shows up.
 */
const COPY = {
  headline: "Most marketing calendars fail in the second month, not the first",
  body: "The first month runs on enthusiasm. The second runs on whatever process you actually built.",
  short: "Intake is the bottleneck",
};

/**
 * ── THE CTA THE SCHEMA ACTUALLY ADMITS. ──
 *
 * `InstagramSlideCopySchema.body` is `.max(600)` and `contentFor`'s closer
 * routes a body with no '?' in it into `cta`, so this is a producible plate,
 * not a stress test. The sweep this file ran before it shipped used
 * *"Save this for your next planning cycle."* — 41 characters, one line — which
 * is why it could not see that a real CTA sets three or ten lines and the last
 * of them lands on `@karoslabs`. `.brand-handle` is `position: absolute;
 * inset-block-end: 44px` and `.cl-ask` reaches the plate's foot, so nothing in
 * flow knew the strip was taken.
 *
 * At the schema's own ceiling (601 characters, one over `body`'s 600, so the
 * plate under test is at least as long as anything the writer can produce),
 * asserted below so the case moves the day somebody changes the max.
 */
const MAX_CTA =
  "Open ChatGPT and type the exact question your buyer asks when they are evaluating options in your category, then screenshot the answer, " +
  "read which three companies it names, and note whether any of them is you; if it is not, the gap is not awareness and it is not budget, " +
  "it is that the model has nothing of yours to quote, so the first move is to publish the one page that answers that question better than " +
  "anything ranking for it right now, and then to say so in the plainest language a model can lift verbatim without paraphrasing you into somebody else. Do it today, before the next planning cycle.";

/** A Hebrew headline with Latin inside it — the shape Israeli tech copy actually has (geektime slide 7, 2026-09-16). */
const MIXED_SCRIPT = {
  headline: "כנס Code. מפגש הקהילה השנתי של מפתחי ה-AI",
  body: "מאות מפתחים ומנהלי טכנולוגיה נפגשים, כשחלק מהדיון הוא על מה ש-ChatGPT שינה בעבודה של צוותי ה-R&D.",
  short: "כנס Code נפתח",
};

function fieldsFor(n: number, system: CarouselVisualSystem, over: Record<string, string> = {}): Record<string, string> {
  return {
    accentColor: ACCENT,
    dir: "ltr",
    lang: "en",
    fontScale: "m",
    textAlign: "start",
    // The ground is the SYSTEM's decision and reaches the plate through this
    // field — `assembleSlidesData` writes `visualSystem.ground` here. Hard-coded,
    // this sweep would render two catalog entries on one ground and then assert
    // they differ.
    groundStyle: system.ground,
    // ── AND SO IS THE GRAMMAR, FOR THE REASON THE GROUND IS. ──
    // This field was missing, so `data-anchor` reached every plate EMPTY, no
    // anchor rule matched, and all four grammars rendered the default: the
    // case below read `contentCentroid.y` 0.5205627983094601 under BOTH
    // `top-column` and `bottom-column`. An axis this sweep does not emit is
    // an axis this sweep cannot measure, whatever it asserts.
    compositionAnchor: COMPOSITION_ANCHOR[system.compositionGrammar],
    slideIndex: String(n).padStart(2, "0"),
    brandHandle: "@karoslabs",
    // Filled on every plate: an EMPTY eyebrow hides itself and the collision
    // this file's sibling case looks for could never occur.
    kicker: "FIELD NOTES",
    eyebrow: "FIELD NOTES",
    headline: COPY.headline,
    title: COPY.short,
    subtitle: COPY.body,
    takeaway: COPY.short,
    body: COPY.body,
    question: "Which round would you cut first?",
    cta: "Save this for your next planning cycle.",
    figure: "73%",
    subLabel: "of teams still file intake by hand",
    sourceLine: "Karos survey, 2026",
    quoteText: "We stopped guessing and started measuring the queue.",
    attribution: "Head of Ops, 2026",
    leftLabel: "Before",
    leftBody: "Five review rounds",
    rightLabel: "After",
    rightBody: "Two review rounds",
    ...over,
  };
}

const systemFrom = (
  entry: (typeof VISUAL_SYSTEM_CATALOG)[number],
  slideCount = 8,
  /* The grammar is an AXIS of this sweep, so it is a parameter rather than a
     constant: the case that asserts the grammars move the lockup has to be able
     to hand each one in. Default `bottom-column`, which is what a run with no
     grammar of its own resolves to. */
  compositionGrammar: CarouselVisualSystem["compositionGrammar"] = "bottom-column",
): CarouselVisualSystem => ({
  systemId: entry.id,
  compositionGrammar,
  ground: entry.ground,
  accentSlides: accentSlidesFor(slideCount, entry.accentForm),
  accentForm: entry.accentForm,
  numeralSlides: interiorSlides(slideCount),
  eyebrow: { kind: "topical", slides: interiorSlides(slideCount) },
  coverForm: entry.coverForm,
  typeScale: entry.typeScale,
  gutter: entry.gutter,
  reason: "axes render sweep",
});

const clientSystem = (over: Partial<ClientVisualSystem> = {}): ClientVisualSystem => ({
  accentRole: "information",
  displayRegister: "grotesque",
  compositionGrammar: "centre-measure",
  imageryRegister: "documentary",
  pagination: "all",
  groundTexture: "near-ground",
  basis: {},
  ...over,
});

/**
 * The kit a real client renders through.
 *
 * `buildBrandHeadHtml` is what emits `clientVisualSystemCss` AND the Google
 * Fonts `<link>` a non-default display family needs — a sweep that spliced the
 * client sheet by hand would declare `'Oswald'` and silently lay out in
 * `Arial Narrow`, which is how the overflow above hid from a probe run for
 * exactly that reason.
 */
const KIT: BrandRenderTokens = {
  cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC" },
  fontFamilies: [],
  badgeStyle: "plain",
  palette: [ACCENT],
};

let workDir: string;

/**
 * A run's language, for the cases that need one.
 *
 * `script` is what `buildBrandHeadHtml` is told, and `language` is what
 * `buildScriptFontHeadForLanguage` reads — the two come from the same
 * `targetLanguage` in the workflow, and they are separate arguments here for
 * exactly one reason: the ungated CONTROL passes the language and withholds the
 * script, which is the tree as it stood before `DISPLAY_REGISTER_SCRIPTS`.
 */
interface RunLanguage {
  language: string;
  bcp47: string;
  script?: string;
  markScript?: string;
}

async function materialize(dir: string, system: CarouselVisualSystem, client: ClientVisualSystem, lang?: RunLanguage): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const ring = buildMarkRing({ brandAccent: ACCENT, palette: [ACCENT] }, "#17181C", "#F4F2EC", []);
  // The same four sheets, in the same order, `headExtras()` splices — and the
  // brand head LAST, which is what `composeRawDocument` does in production and
  // what lets a client's own sheet beat a template on a specificity tie.
  const extra = [deviceCssBlock(), visualSystemCssBlock(system), markCssBlock(lang?.markScript, ring)].filter((s) => s.length > 0).join("\n");
  // `[scriptHead, brandHead]`, which is the order `brandFragments()` composes
  // in. It matters: both sheets declare `letter-spacing` on the same display
  // selectors at the same specificity, so the LATER one wins, and the later one
  // is the brand head.
  const scriptHead = lang === undefined ? undefined : buildScriptFontHeadForLanguage(lang.language, KIT.cssVars);
  const brandHead = buildBrandHeadHtml(KIT, { system: client, ...(lang?.script !== undefined ? { script: lang.script } : {}) });
  const head = [scriptHead, brandHead].filter((s): s is string => s !== undefined).join("\n");
  for (const file of (await fs.readdir(SOURCE_TEMPLATE_DIR)).filter((f) => f.endsWith(".html"))) {
    const html = await fs.readFile(path.join(SOURCE_TEMPLATE_DIR, file), "utf8");
    await fs.writeFile(path.join(dir, file), composeRawDocument(html, head, undefined, extra), "utf8");
  }
}

interface Plate {
  n: number;
  template: string;
  path: string;
  metrics: { edgeDensity: number; contentBBox: { x: number; y: number; w: number; h: number }; contentCentroid: { x: number; y: number } };
  overflow: boolean;
  overflowing: string[];
  fontFamiliesUsed: string[];
  collisions: Array<{ a: string; b: string; overlapPx: number }>;
}

interface RenderOpts {
  templates?: ReadonlyArray<readonly [string, number]>;
  /** Per-plate field overrides — the copy under test, where the default set is not the point. */
  fields?: Record<string, string>;
  lang?: RunLanguage;
}

async function renderSet(label: string, system: CarouselVisualSystem, client: ClientVisualSystem, opts: RenderOpts = {}): Promise<Plate[]> {
  const templates = opts.templates ?? PLATES;
  const dir = path.join(workDir, label.replace(/[^a-z0-9-]/gi, "-"));
  await materialize(dir, system, client, opts.lang);
  const input = {
    client: "axes",
    postId: label,
    templateDir: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"),
    outDir: path.relative(REPO_ROOT, path.join(dir, "out")).replaceAll("\\", "/"),
    repoRoot: REPO_ROOT,
    canvas: CANVAS,
    slides: templates.map(([template, n]) => ({
      n,
      template,
      fields: {
        ...fieldsFor(n, system, opts.fields ?? {}),
        ...(opts.lang !== undefined ? { dir: opts.lang.bcp47 === "he" ? "rtl" : "ltr", lang: opts.lang.bcp47 } : {}),
      },
      images: {},
      htmlFragments: template === "list-takeaway.html" ? { itemRows: ROWS } : template === "closer.html" ? { recap: RECAP } : {},
      measure: { accentHex: ACCENT, groundHex: "#17181C", foregroundHex: "#F4F2EC" },
    })),
    measure: true,
    probe: true,
  } as unknown as RenderCarouselInput;
  const outcome = await createRenderCarousel().execute(input, {
    ctx: { runId: "axes", clientSlug: "axes", productId: "instagram-agent", runKind: "setup", metadata: {} },
  });
  if (outcome.status !== "success") throw new Error(`${label} render failed: ${JSON.stringify(outcome)}`);
  return outcome.result.rendered.map((row, index) => {
    if (row.metrics === undefined || row.probe === undefined) throw new Error(`${label} slide ${row.n} came back without metrics/probe`);
    return {
      n: row.n,
      template: templates[index]![0],
      path: row.path,
      metrics: { edgeDensity: row.metrics.edgeDensity, contentBBox: row.metrics.contentBBox, contentCentroid: row.metrics.contentCentroid },
      overflow: row.probe.overflow,
      overflowing: row.probe.overflowing,
      fontFamiliesUsed: row.probe.fontFamiliesUsed,
      collisions: (row as { geometry?: { collisions?: Array<{ a: string; b: string; overlapPx: number }> } }).geometry?.collisions ?? [],
    };
  });
}

describe.skipIf(!isChromiumInstalled())("every declared axis is measured on a real render", () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-render-test-axes-"));
  }, 120_000);

  afterAll(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  /**
   * THE GUARD THAT DID NOT EXIST WHEN `condensed` WAS ADDED.
   *
   * All eight archetypes, once per register. A face whose content area is
   * taller than the box its line height reserves puts the twin span above its
   * own host, and `probe.overflow` is the DOM fact clause B refuses on.
   */
  it(
    "no archetype overflows under any display register",
    async () => {
      const entry = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      for (const register of DISPLAY_REGISTERS) {
        const plates = await renderSet(`register-${register}`, systemFrom(entry), clientSystem({ displayRegister: register }));
        for (const plate of plates) {
          expect(plate.overflow, `${plate.template} under "${register}" overflows: ${plate.overflowing.join(", ")}`).toBe(false);
        }
        // THE PREMISE. `fontFamiliesUsed` reports the computed STACK, not the
        // face Chromium resolved, so a register whose family never loaded still
        // reports its own name — which is how the Oswald overflow hid from a
        // probe run that asserted exactly this and nothing else. What proves
        // the face arrived is that the plates MEASURE differently from the
        // fleet default, which the case below asserts on the invariants.
        expect(plates[0]!.fontFamiliesUsed.length, `"${register}" resolved no font families at all`).toBeGreaterThan(0);
      }
    },
    600_000,
  );

  /**
   * ── THE SAME SWEEP, WITH A CTA THE SCHEMA ACTUALLY ADMITS. ──
   *
   * This is the gap that let the closer defect through. The sweep above renders
   * every archetype under every register and asserts `probe.overflow` — and its
   * CTA was *"Save this for your next planning cycle."*, 41 characters, one
   * line, on a plate whose whole question is how many lines the ask takes.
   * `body` is `.max(600)`; at 108 characters under `mono-display` the third
   * line already printed on top of `@karoslabs`, and at 600 under
   * `humanist-serif` the CTA's box left `.cl-ask` by 23px.
   *
   * Two failures could produce that and only one of them is the template's:
   * the copy really does land on the watermark, and `probeGeometry` could not
   * SEE it, because `COLLISION_WATCH_CLASSES` held eight names and all eight
   * were furniture. So the premise is asserted first — the watch list must know
   * the class the plate actually carries — or this case would pass on a blind
   * instrument, which is the failure mode the phase's own F4 detector had.
   */
  it(
    "a closer with a schema-maximum CTA clears the brand furniture under every display register",
    async () => {
      // THE PREMISE: a detector whose watch list holds only furniture cannot
      // find a furniture-versus-content collision, and reports `[]` either way.
      expect(COLLISION_WATCH_CLASSES, "the collision probe cannot see the closer's CTA").toContain("cl-cta");
      expect(COLLISION_WATCH_CLASSES).toContain("brand-handle");
      // `InstagramSlideCopySchema.body` is `.max(600)`; the plate under test
      // must be at least that long or this case is measuring a shorter string
      // than the writer can produce — which is exactly how the one-line CTA the
      // sweep shipped with let the defect through.
      expect(MAX_CTA.length, "the CTA under test is shorter than the schema's own ceiling for `body`").toBeGreaterThanOrEqual(600);

      const entry = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      const closer: ReadonlyArray<readonly [string, number]> = [["closer.html", 8]];
      for (const register of DISPLAY_REGISTERS) {
        for (const [what, cta] of [["schema maximum", MAX_CTA], ["three lines", "Open ChatGPT. Type the question your buyer asks when evaluating options in your category. Screenshot the answer."]] as const) {
          const plates = await renderSet(`cta-${register}-${cta.length}`, systemFrom(entry), clientSystem({ displayRegister: register }), {
            templates: closer,
            fields: { cta, question: "" },
          });
          const plate = plates[0]!;
          expect(plate.overflow, `the ${what} CTA under "${register}" overflows: ${plate.overflowing.join(", ")}`).toBe(false);
          // THE CLAIM. Nothing the reader reads may share pixels with the
          // standing marks along the plate's foot.
          const onFurniture = plate.collisions.filter((c) => /brand-handle|brand-logo|brand-mark/u.test(`${c.a} ${c.b}`));
          expect(onFurniture, `the ${what} CTA under "${register}" prints on the brand furniture: ${JSON.stringify(onFurniture)}`).toEqual([]);
        }
      }
    },
    600_000,
  );

  /**
   * ── A NON-LATIN RUN DOES NOT TAKE THE DISPLAY REGISTER'S LATIN DECISIONS. ──
   *
   * `clientVisualSystemCss` emitted `--f-display`, the register's tracking and
   * its face bleed with no script condition at all, and of the four registers
   * none carries a Hebrew glyph (`script-fonts.ts`'s own module header records
   * the measurement for three of them; Oswald is the same class of face).
   * `fallbackClientVisualSystem` routes geektime's kit — `"news, bold"` /
   * `"loud"` — to `condensed` deterministically, so this was every Hebrew
   * geektime post, not a rare shape.
   *
   * What the ungated sheet actually did to the pixels is the point of the
   * control below: `script-fonts.ts` declares its stack on `body`, which beats
   * this sheet's `:root` for `--f-display`, but both sheets declare
   * `letter-spacing` on the same display selectors at the same specificity and
   * the brand head is composed LAST — so Oswald's `-0.004em` won over the
   * `normal` that module measured for Hebrew, on a script where negative
   * tracking walks the final forms (ך ן ף ץ) into the next word.
   */
  it(
    "a Hebrew run sets one display system: no Latin register face, and the script pack's own tracking",
    async () => {
      // THE PREMISE, in three parts, so this cannot pass on an axis nobody chose.
      const geektime = fallbackClientVisualSystem({ accentColor: ACCENT, palette: [ACCENT, "#22D3EE", "#F59E0B"], aesthetic: "bold news magazine", visualMood: "editorial punchy", clientSlug: "geektime" });
      expect(geektime.displayRegister, "this kit no longer resolves to a register with no Hebrew coverage").toBe("condensed");
      expect(DISPLAY_REGISTER_SCRIPTS[geektime.displayRegister]).not.toContain("Hebrew");
      expect(resolveDisplayRegisterForScript(geektime.displayRegister, "Hebrew").covers).toBe(false);

      // The sheet itself: the three Latin declarations are withheld, and only
      // those three. The grammar, the ground texture and the weight are
      // script-neutral and must survive, or the axis would be turned off rather
      // than corrected.
      const ungatedCss = clientVisualSystemCss(geektime);
      const gatedCss = clientVisualSystemCss(geektime, { script: "Hebrew" });
      expect(ungatedCss).toContain("--f-display");
      expect(ungatedCss).toContain("letter-spacing");
      expect(gatedCss).not.toContain("--f-display");
      expect(gatedCss).not.toContain("letter-spacing");
      // The descender allowance is NOT withheld: it is combined with the
      // script's own at the consumption site with `max()`, so it can only add
      // padding, and withholding it is the one direction that can clip. See its
      // note in `clientVisualSystemCss`.
      expect(gatedCss).toContain("--mk-face-bleed");
      expect(gatedCss).toContain("--display-weight");
      expect(gatedCss).toContain("--lockup-anchor");
      expect(gatedCss).toContain("--ground-texture-alpha");
      // A LATIN run is byte-identical to before — the gate must not be a change
      // to the English fleet.
      expect(clientVisualSystemCss(geektime, { script: "Latin" })).toBe(ungatedCss);
      expect(clientVisualSystemCss(geektime, {})).toBe(ungatedCss);

      const entry = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      const system = systemFrom(entry);
      const client = { ...clientSystem(), displayRegister: geektime.displayRegister };
      const mixed = { headline: MIXED_SCRIPT.headline, body: MIXED_SCRIPT.body, title: MIXED_SCRIPT.short, subtitle: MIXED_SCRIPT.body, takeaway: MIXED_SCRIPT.short, cta: MIXED_SCRIPT.body, question: "", kicker: "קוד", eyebrow: "קוד" };
      const hebrew: RunLanguage = { language: "Hebrew", bcp47: "he", markScript: "hebrew" };

      const gated = await renderSet("he-gated", system, client, { fields: mixed, lang: { ...hebrew, script: "Hebrew" } });
      const ungated = await renderSet("he-ungated", system, client, { fields: mixed, lang: hebrew });

      // Nothing regressed: a Hebrew carousel still lays out cleanly on all
      // eight archetypes with the register's face withheld.
      for (const plate of gated) {
        expect(plate.overflow, `${plate.template} overflows on a gated Hebrew run: ${plate.overflowing.join(", ")}`).toBe(false);
      }

      // ── AND THE GATE IS NOT INERT. ──
      //
      // Asserted on `contentBBox`, which is colour-invariant
      // (`slide-metrics.ts`; `pixel-shares-are-contrast-dependent` is why the
      // six SHARES are the wrong instrument here): both renders use the same
      // kit, the same copy and the same system, so the only thing that can move
      // a glyph is the register's tracking reaching the plate or not.
      const moved = gated.filter((plate, index) => {
        const other = ungated[index]!;
        return plate.metrics.contentBBox.w !== other.metrics.contentBBox.w || plate.metrics.contentBBox.h !== other.metrics.contentBBox.h || plate.metrics.edgeDensity !== other.metrics.edgeDensity;
      });
      expect(moved.length, "gating the register changed nothing on any plate — the sheet is not reaching the pixels").toBeGreaterThan(0);
    },
    600_000,
  );

  /**
   * ── TWO CATALOG ENTRIES MUST PRODUCE TWO DIFFERENT PLATES. ──
   *
   * Item D's success test is *"two different clients must produce visibly
   * different posts"*, and before this phase's axes reached the templates it
   * was delivered as a font swap: `karoslabs-en-long` (`glyph-figure`) and
   * `karoslabs-en-short` (`ruled-object`) rendered structurally identical
   * plates — same margins, same lockup positions, same rule placement on all
   * eight slides — because `gutter`, `coverForm` and `accentForm`'s shape were
   * tokens no template read.
   *
   * Asserted on `edgeDensity`, `contentBBox` and `contentCentroid`, which are
   * the COLOUR-INVARIANT metrics (`slide-metrics.ts`; and see
   * `pixel-shares-are-contrast-dependent` — the six pixel SHARES are not
   * separable on a quiet plate, so a difference measured on them would not
   * mean what it looks like). A palette swap moves none of these three; a
   * margin, a band height or a mark's geometry moves at least one.
   */
  it(
    "two catalog entries differ in more than their palette",
    async () => {
      const a = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "glyph-figure")!;
      const b = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      // `glyph-figure` is tight/figure/display, `ruled-object` is
      // wide/object/display — the pair the live runs shipped as identical.
      expect(a.gutter).not.toBe(b.gutter);
      expect(a.coverForm).not.toBe(b.coverForm);

      const left = await renderSet("catalog-a", systemFrom(a), clientSystem());
      const right = await renderSet("catalog-b", systemFrom(b), clientSystem());

      // ── THE INSTRUMENT IS A PIXEL DIFF, AND THE PALETTE IS HELD FIXED. ──
      //
      // Both renders use the SAME kit, the same accent and the same copy, so
      // the only thing that can move a pixel is a visual-system axis. That is
      // what makes a raw diff the honest measure here, and it is why the
      // colour-invariant shares are the wrong one: `contentBBox` is the bbox of
      // everything that is not the ground token, and every archetype washes
      // most of its plate, so it reads 1048x1380 whatever the margins do.
      // Measured that way, four axes' worth of difference showed up as
      // `edgeDensity` 0.0172 vs 0.0186 — real, and not a claim anybody can see.
      const differing = async (a: string, b: string): Promise<number> => {
        const read = async (file: string): Promise<Uint8Array> => {
          const bytes = await fs.readFile(path.isAbsolute(file) ? file : path.join(REPO_ROOT, file));
          let out: Uint8Array | undefined;
          let stride = 0;
          decodePngRows(bytes, (row, y, hd) => {
            if (out === undefined) {
              stride = hd.width * 3;
              out = new Uint8Array(hd.height * stride);
            }
            let at = y * stride;
            for (let i = 0; i < row.length; i += 4) {
              out![at++] = row[i]!;
              out![at++] = row[i + 1]!;
              out![at++] = row[i + 2]!;
            }
          });
          return out!;
        };
        const [x, y] = await Promise.all([read(a), read(b)]);
        if (x.length !== y.length) return 1;
        let differs = 0;
        // 12 per channel: past antialiasing noise, under any real move.
        for (let i = 0; i < x.length; i += 3) {
          if (Math.abs(x[i]! - y[i]!) > 12 || Math.abs(x[i + 1]! - y[i + 1]!) > 12 || Math.abs(x[i + 2]! - y[i + 2]!) > 12) differs += 1;
        }
        return differs / (x.length / 3);
      };

      const shares: string[] = [];
      let moved = 0;
      for (const [index, plate] of left.entries()) {
        const share = await differing(plate.path, right[index]!.path);
        shares.push(`${plate.template}: ${(share * 100).toFixed(2)}% of pixels differ`);
        // 1% of a 1080x1440 plate is ~15,500 pixels — well past AA noise
        // between two renders of the same words, and about what a 16px margin
        // shift alone produces.
        if (share > 0.01) moved += 1;
      }
      // The table the claim is read off, printed pass or fail: "these two
      // systems differ" is a sentence a reviewer should be able to check
      // against numbers rather than take on a boolean.
      console.log(["", "glyph-figure vs ruled-object, same kit and same copy:", ...shares, ""].join("\n"));

      // Not "every plate": a panel archetype composes around a structure the
      // gutter moves and the cover form does not. The claim is that the SET
      // differs, and a majority of eight is a claim a reader can see.
      expect(moved, `only ${moved} of ${left.length} plates differ by more than 1% of their pixels between two catalog entries with an identical palette`).toBeGreaterThanOrEqual(5);
    },
    600_000,
  );

  /**
   * ── THE GRAMMAR MOVES THE LOCKUP, AND NO ANCHOR BREAKS A PLATE. ──
   *
   * `compositionGrammar` is *"where the type lockup sits on the plate"* and it
   * shipped as `--system-grammar: split-band`, a string no template read. It
   * now sets the block anchor of `headline-focus.html`'s elastic field.
   *
   * ONE ARCHETYPE, MEASURED. Off-centre in an elastic field is a band of bare
   * ground wherever the content is not, so the axis costs dead-space share and
   * the question is which plates can pay it. Measured against a 0.28 interior
   * ceiling, same copy and same bounded object, one grammar apart:
   * `headline-focus` reads 0.2081-0.2689 across all four anchors and the
   * heroless `slide.html` reads 0.2917-0.4278 — so the axis reaches the plate
   * that can carry it and not the one a carousel may repeat. See
   * `LOCKUP_ANCHOR`'s own note for the table.
   *
   * Both halves are asserted: that the anchor MOVES the content, and that no
   * anchor puts anything out of its own box — an anchor is free to change a
   * composition and is never free to clip one.
   */
  it(
    "every composition grammar renders cleanly, and they do not all render the same plate",
    async () => {
      const entry = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      const statementPlates = PLATES.filter(([file]) => file === "headline-focus.html");
      const centroids = new Map<CompositionGrammar, number[]>();
      for (const grammar of COMPOSITION_GRAMMARS) {
        // BOTH objects carry it, as production does: `resolveVisualSystem`
        // copies the client's frozen axis onto the run's system, and it is
        // the RUN's system that `fieldsFor` reads. Handed only to the client
        // sheet, `systemFrom`'s default `bottom-column` reached the plate on
        // every pass of this loop — which is what `systemFrom`'s third
        // parameter was added for and then not used.
        const plates = await renderSet(
          `grammar-${grammar}`,
          systemFrom(entry, 8, grammar),
          clientSystem({ compositionGrammar: grammar }),
          { templates: statementPlates },
        );
        for (const plate of plates) {
          expect(plate.overflow, `${plate.template} under "${grammar}" overflows: ${plate.overflowing.join(", ")}`).toBe(false);
        }
        centroids.set(grammar, plates.map((p) => p.metrics.contentCentroid.y));
      }
      const top = centroids.get("top-column")!;
      const bottom = centroids.get("bottom-column")!;
      for (const [index, y] of top.entries()) {
        expect(
          bottom[index]!,
          `the ${statementPlates[index]![0]} lockup sits at y=${y} under top-column and y=${bottom[index]} under bottom-column — the grammar moved nothing`,
        ).toBeGreaterThan(y);
      }
    },
    600_000,
  );

  /**
   * ── THE BRAND MARK'S CORNER, ON A REAL PLATE THAT HAS AN EYEBROW IN IT. ──
   *
   * `probe-collisions.test.ts` drives a fake DOM, so no test ever put a brand
   * logo and a filled eyebrow on one real plate — which is how the disc came
   * to sit on the eyebrow of every eyebrow-bearing slide of every client.
   * Measured before the fix on the composed karoslabs stat plate:
   * `.brand-logo` (44,44 65x65) over `.eyebrow` (64,96 180x29), 13px deep.
   *
   * The cause was that `planBrandLogoPlacement` was asked about the client's
   * STANDING badge while the run's own eyebrow took the same corner. With the
   * effective question asked, the mark takes `top-end` and the zone the
   * renderer is given is the opposite corner, so nothing enters it.
   */
  it(
    "a real plate carrying both a brand logo and an eyebrow reports no collision in the mark's zone",
    async () => {
      const { BRAND_MARK_ZONE, BRAND_MARK_ZONE_INTRUSION_PX } = await import("../src/workflow/visual-system.js");
      const { planBrandLogoPlacement } = await import("@agent-engine/tool-karos-media");
      // The placement a run resolves when its own visual system puts a topical
      // eyebrow in the start-side corner — the EFFECTIVE question, which is the
      // one the workflow now asks.
      const placement = planBrandLogoPlacement({ ground: "#17181C", fg: "#F4F2EC", ink: { source: "png", samples: [{ hex: "#FFFFFF", weight: 1 }] }, hasSeriesBadge: true });
      expect(placement.corner, "with the eyebrow's corner occupied the mark must take the other one").toBe("top-end");

      const entry = VISUAL_SYSTEM_CATALOG.find((e) => e.id === "ruled-object")!;
      const system = systemFrom(entry);
      const dir = path.join(workDir, "logo-zone");
      await materialize(dir, system, clientSystem());
      // A 1x1 white PNG is enough: the zone check is geometry, and the mark's
      // box is set by `brandLogoCss`, not by the asset's own pixels.
      const logo =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const withLogo = buildBrandHeadHtml(KIT, { logo: placement, system: clientSystem() });
      for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith(".html"))) {
        const html = await fs.readFile(path.join(dir, file), "utf8");
        await fs.writeFile(path.join(dir, file), composeRawDocument(html, withLogo, `<img class="brand-logo" src="${logo}" alt="" />`), "utf8");
      }

      const zone =
        placement.corner === "top-start"
          ? { x: BRAND_MARK_ZONE.inset, y: BRAND_MARK_ZONE.inset, w: BRAND_MARK_ZONE.size, h: BRAND_MARK_ZONE.size }
          : { x: CANVAS.w - BRAND_MARK_ZONE.inset - BRAND_MARK_ZONE.size, y: BRAND_MARK_ZONE.inset, w: BRAND_MARK_ZONE.size, h: BRAND_MARK_ZONE.size };

      const outcome = await createRenderCarousel().execute(
        {
          client: "axes",
          postId: "logo-zone",
          templateDir: path.relative(REPO_ROOT, dir).replaceAll("\\", "/"),
          outDir: path.relative(REPO_ROOT, path.join(dir, "out")).replaceAll("\\", "/"),
          repoRoot: REPO_ROOT,
          canvas: CANVAS,
          slides: PLATES.map(([template, n]) => ({
            n,
            template,
            fields: fieldsFor(n, system),
            images: {},
            htmlFragments: template === "list-takeaway.html" ? { itemRows: ROWS } : {},
          })),
          probe: true,
          reservedZone: zone,
        } as unknown as RenderCarouselInput,
        { ctx: { runId: "axes", clientSlug: "axes", productId: "instagram-agent", runKind: "setup", metadata: {} } },
      );
      if (outcome.status !== "success") throw new Error(`logo-zone render failed: ${JSON.stringify(outcome)}`);

      for (const [index, row] of outcome.result.rendered.entries()) {
        const collisions = (row as { geometry?: { collisions?: Array<{ a: string; b: string; overlapPx: number }> } }).geometry?.collisions ?? [];
        const intrusions = collisions.filter((c) => c.b === "[reserved-zone]" && c.overlapPx > BRAND_MARK_ZONE_INTRUSION_PX);
        expect(intrusions, `${PLATES[index]![0]} let ${intrusions.map((c) => c.a).join(", ")} into the brand mark's zone`).toEqual([]);
        const onTheMark = collisions.filter((c) => /brand-(logo|mark)/u.test(`${c.a} ${c.b}`));
        expect(onTheMark, `${PLATES[index]![0]} paints something on top of the brand mark: ${JSON.stringify(onTheMark)}`).toEqual([]);
      }
    },
    600_000,
  );
});
