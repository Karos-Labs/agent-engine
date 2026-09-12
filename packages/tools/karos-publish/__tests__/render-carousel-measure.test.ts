import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRenderCarousel, probePage, RenderCarouselInputSchema, type RenderCarouselInput, type RenderCarouselResult } from "../src/render-carousel.js";
import { SlideProbeSchema } from "../src/slide-metrics.js";

/**
 * The one place `measure` and `probe` are checked against a REAL Chromium
 * render, because that is the only way to know the numbers describe the
 * pixels a client would see. Every other render-carousel test is deliberately
 * Chromium-free (`validateRenderInputs`'s own doc comment).
 *
 * Self-skips without the browser binary so `npm test` never reads as a broken
 * build on a machine that has not run `npx playwright install chromium`. CI's
 * image has it, so the assertions here are real verification there.
 */
function isChromiumInstalled(): boolean {
  const cacheDir =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith("chromium-")) continue;
      const exePath =
        process.platform === "win32"
          ? path.join(cacheDir, entry, "chrome-win", "chrome.exe")
          : process.platform === "darwin"
            ? path.join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
            : path.join(cacheDir, entry, "chrome-linux", "chrome");
      if (existsSync(exePath)) return true;
    }
  } catch {
    // The cache directory does not exist: Chromium was never installed.
  }
  return false;
}

/**
 * `assertInside` requires every path to be repo-relative and inside the root,
 * so the scratch template/output directories live under this package rather
 * than in os.tmpdir() — the same constraint every real caller works under.
 */
const ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = "__tests__/.tmp-measure-templates";
const OUT_DIR = "__tests__/.tmp-measure-out";

const GROUND = "#17181C";
const FOREGROUND = "#F4F2EC";
const ACCENT = "#FF3B30";

/**
 * A deliberately DULL slide and a deliberately RICH one, so the measurement
 * has to tell them apart rather than merely produce numbers.
 *
 * `fitting.html` is the shape of the defect: a flat ground with a headline in
 * the lower third. `carrying.html` puts a real accent field behind that
 * headline. `flooded.html` is the same field taken past the point where it
 * stops being a field and becomes the plate. `overflowing.html` forces a real
 * box overflow, which is the probe's whole reason to exist and cannot be seen
 * in a screenshot.
 *
 * ── WHY `carrying.html`'s BLOCK IS 620px AND NOT 1000px ──────────────────
 *
 * It was 1000px of 1440, and two assertions here were impossible against it.
 * Measured through a real render (`.local/measure-fixtures.mjs`, 2026-09-11),
 * with the ground and accent tokens declared exactly as the inputs below
 * declare them:
 *
 *   block height   groundMatches   backgroundHex   imagery+device   accent
 *    620px (43%)       true           #17181C          43.4%         43.1%
 *    720px (50%)      FALSE           #FF3B30          49.8%         50.0%
 *   1000px (69%)      FALSE           #FF3B30          30.4%         69.4%
 *
 * The ground is the MODAL colour over the frame's flat cells, so a flat block
 * that covers more than half the plate wins that vote and IS the ground from
 * the measurement's point of view — at which point the declared token no
 * longer matches (`backgroundMatchesBrandGround` false, which is what CI
 * reported as "slide 2 did not find its declared ground") and the metric
 * correctly reports the remaining brand ground as the graphic, giving the
 * 30.4% that CI reported against an expected `> 0.5`.
 *
 * So `imageryOrDeviceShare > 0.5` was not a threshold that needed loosening,
 * it was a shape no flat-block slide can have: above 50% the block becomes
 * the ground and the number inverts. Only an element with variety in every
 * cell — a photograph, which contributes no flat cells at all — reaches 0.5
 * and keeps the brand ground, and that case is pinned in
 * `interest-floor-calibration.test.ts`, which renders one. What a real
 * FIELD-bearing slide measures is the 0.20–0.45 band: the bundled
 * `cover.html`'s colour-block ground with no photograph measures 33.1%.
 *
 * The 1000px version is kept, as `flooded.html`, because the inversion is a
 * real and surprising property worth pinning — and because with both slides
 * asserting `backgroundMatchesBrandGround === true`, a field hard-wired to
 * `true` would have passed this whole file.
 */
const FITTING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --bg: ${GROUND}; --fg: ${FOREGROUND}; }
  html, body { margin: 0; width: 1080px; height: 1440px; }
  body { background: var(--bg); color: var(--fg); font-family: Georgia, serif; position: relative; }
  .copy { position: absolute; inset-inline: 64px; bottom: 130px; font-size: 74px; line-height: 1.1; }
</style></head>
<body><div class="copy">{{title}}</div>
<script>window.__CAROUSEL_READY__ = true;</script></body></html>`;

const blockSlide = (blockHeightPx: number): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --bg: ${GROUND}; --fg: ${FOREGROUND}; --accent: ${ACCENT}; }
  html, body { margin: 0; width: 1080px; height: 1440px; }
  body { background: var(--bg); color: var(--fg); font-family: Georgia, serif; position: relative; }
  .block { position: absolute; inset-inline: 0; top: 0; height: ${blockHeightPx}px; background: var(--accent); }
  .copy { position: absolute; inset-inline: 64px; bottom: 120px; font-size: 64px; }
</style></head>
<body><div class="block"></div><div class="copy">{{title}}</div>
<script>window.__CAROUSEL_READY__ = true;</script></body></html>`;

/** A real accent field, sized so the BRAND GROUND is still the plate's modal flat colour. */
const CARRYING_HTML = blockSlide(620);
/** The same field past the crossover, where it wins the modal vote and becomes the ground itself. */
const FLOODED_HTML = blockSlide(1000);

const OVERFLOWING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --bg: ${GROUND}; --fg: ${FOREGROUND}; }
  html, body { margin: 0; width: 1080px; height: 1440px; }
  body { background: var(--bg); color: var(--fg); font-family: Georgia, serif; }
  .clamped { width: 300px; height: 120px; overflow: hidden; font-size: 90px; white-space: nowrap; }
</style></head>
<body><div class="clamped" id="clamped">{{title}}</div>
<script>window.__CAROUSEL_READY__ = true;</script></body></html>`;

function input(overrides: Partial<RenderCarouselInput> = {}): RenderCarouselInput {
  return RenderCarouselInputSchema.parse({
    client: "acme",
    postId: "post_measure",
    templateDir: TEMPLATE_DIR,
    outDir: OUT_DIR,
    repoRoot: ROOT,
    slides: [
      { n: 1, template: "fitting.html", fields: { title: "A headline on flat ground" }, measure: { groundHex: GROUND, foregroundHex: FOREGROUND } },
      { n: 2, template: "carrying.html", fields: { title: "A slide that carries something" }, measure: { groundHex: GROUND, accentHex: ACCENT } },
    ],
    // `validateRenderInputs` pins this to exactly 2, which is what makes the
    // measured PNG 2160x2880 against the 1080x1440 design canvas.
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
    ...overrides,
  });
}

async function run(payload: RenderCarouselInput): Promise<RenderCarouselResult> {
  // The second argument is the tool-call envelope, NOT the context itself:
  // `execute` reads `arg.ctx.runId`, so a bare `{ runId, stepId }` throws
  // "Cannot read properties of undefined (reading 'runId')" before Chromium
  // is ever launched. This is Chromium-gated, so it only surfaced in CI.
  const outcome = await createRenderCarousel().execute(payload, {
    ctx: { runId: "r_measure", clientSlug: "acme", productId: "instagram-agent", runKind: "setup", metadata: {} },
  } as never);
  expect(outcome.status, `render failed: ${JSON.stringify(outcome)}`).toBe("success");
  return (outcome as { status: "success"; result: RenderCarouselResult }).result;
}

// ─────────────────────────────────────────────────────────────────────────
// The probe's own logic, without a browser
// ─────────────────────────────────────────────────────────────────────────

/**
 * `probePage` runs in the page, so on a machine with no Chromium it would
 * otherwise be entirely untested — and the describe block below would skip
 * without anyone noticing it had broken. It closes over nothing at module
 * scope, so installing a fake `document`/`getComputedStyle` on the global
 * exercises exactly the body Playwright serialises.
 */
interface FakeElement {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  childCount?: number;
  box?: { left: number; top: number; width: number; height: number };
  scroll?: { w: number; h: number };
  client?: { w: number; h: number };
  fontFamily?: string;
  /** Index into the same array, for the block-start limb. Absent = no parent. */
  parent?: number;
  /** This element's computed `overflow`, which is what the limb reads off a PARENT; defaults to "visible". */
  overflow?: string;
  /** This element's own computed `position`; defaults to "static". */
  position?: string;
}

function withFakeDom<T>(elements: FakeElement[], body: () => T): T {
  const global = globalThis as unknown as Record<string, unknown>;
  const priorDocument = global["document"];
  const priorComputed = global["getComputedStyle"];
  const built = elements.map((e) => {
    const box = e.box ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      tagName: e.tagName,
      id: e.id ?? "",
      className: e.className ?? "",
      textContent: e.text ?? "",
      children: { length: e.childCount ?? 0 },
      scrollWidth: e.scroll?.w ?? box.width,
      scrollHeight: e.scroll?.h ?? box.height,
      clientWidth: e.client?.w ?? box.width,
      clientHeight: e.client?.h ?? box.height,
      getBoundingClientRect: () => ({
        left: box.left,
        top: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        width: box.width,
        height: box.height,
      }),
      parentElement: null as unknown,
      __fontFamily: e.fontFamily ?? "Inter, sans-serif",
      __overflow: e.overflow ?? "visible",
      __position: e.position ?? "static",
    };
  });
  // Wired AFTER the map so a child may name a parent declared later.
  elements.forEach((e, i) => {
    if (e.parent !== undefined) built[i]!.parentElement = built[e.parent] ?? null;
  });
  global["document"] = { querySelectorAll: () => built };
  global["getComputedStyle"] = (element: { __fontFamily: string; __overflow: string; __position: string }) => ({
    fontFamily: element.__fontFamily,
    overflow: element.__overflow,
    position: element.__position,
  });
  try {
    return body();
  } finally {
    global["document"] = priorDocument;
    global["getComputedStyle"] = priorComputed;
  }
}

describe("probePage (the in-page half, driven against a fake DOM)", () => {
  const canvas = { n: 3, w: 1080, h: 1440 };

  it("reports a well-fitting page as clean and names the font family in use", () => {
    const probe = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 2, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "DIV", className: "copy", text: "A headline", box: { left: 64, top: 1100, width: 952, height: 180 }, fontFamily: '"Playfair Display", Georgia, serif' },
      ],
      () => probePage(canvas),
    );
    expect(SlideProbeSchema.parse(probe)).toEqual(probe);
    expect(probe.n).toBe(3);
    expect(probe.overflow).toBe(false);
    expect(probe.overflowing).toEqual([]);
    expect(probe.offscreen).toEqual([]);
    expect(probe.elementCount).toBe(3);
    expect(probe.fontFamiliesUsed).toEqual(["Playfair Display"]); // quotes stripped, first family only
    expect(probe.textBoxShare).toBeCloseTo((952 * 180) / (1080 * 1440), 8);
  });

  it("names the overflowing element and caps the list at six", () => {
    const many: FakeElement[] = [];
    for (let i = 0; i < 9; i++) {
      many.push({ tagName: "SPAN", className: `row-${i}`, text: "x", box: { left: 0, top: 0, width: 300, height: 40 }, scroll: { w: 900, h: 40 }, client: { w: 300, h: 40 } });
    }
    const probe = withFakeDom(many, () => probePage(canvas));
    expect(probe.overflow).toBe(true);
    expect(probe.overflowing).toHaveLength(6);
    expect(probe.overflowing[0]).toBe("span.row-0");
  });

  /**
   * THE BLOCK-START LIMB, and why `scrollHeight` alone could never be the
   * whole of this check.
   *
   * The scrollable overflow region starts at the padding box's block-start
   * edge and grows away from it, so content pushed out of the TOP of its
   * parent leaves `scrollHeight === clientHeight`. `headline-focus.html`
   * shipped exactly that: a `flex: 0 1 auto; min-block-size: 0` block under
   * `justify-content: flex-end` shrank below its content and spilled the
   * headline 155px above its own parent, on top of the kicker rail, while the
   * probe reported the page clean and a calibration test rendering that very
   * plate went green. Each case here is built so the scrollHeight limb CANNOT
   * fire (`scroll` is left equal to the box), which is what makes it a test of
   * the new limb rather than of the old one.
   */
  describe("the block-start limb", () => {
    const parentBox = { left: 64, top: 400, width: 952, height: 480 };

    it("names a child that escapes its parent's block-start edge, which scrollHeight cannot see", () => {
      const probe = withFakeDom(
        [
          { tagName: "DIV", className: "hf-field", childCount: 1, box: parentBox },
          { tagName: "DIV", className: "hf-headline", text: "Most marketing calendars fail in month two", parent: 0, box: { left: 64, top: 245, width: 952, height: 633 } },
        ],
        () => probePage(canvas),
      );
      expect(probe.overflow, "the escape must be reported").toBe(true);
      expect(probe.overflowing).toEqual(["div.hf-headline"]);
    });

    it("tolerates the 2px a display face's glyph box routinely sits above its line box", () => {
      const probe = withFakeDom(
        [
          { tagName: "DIV", className: "copy", childCount: 1, box: parentBox },
          { tagName: "DIV", className: "hf-headline", text: "A statement", parent: 0, box: { left: 64, top: 398, width: 952, height: 480 } },
        ],
        () => probePage(canvas),
      );
      expect(probe.overflow).toBe(false);
    });

    it("leaves an ABSOLUTELY POSITIONED child alone — a bleeding ground numeral is art direction, not overflow", () => {
      const probe = withFakeDom(
        [
          { tagName: "BODY", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
          { tagName: "SPAN", className: "ground-glyph", text: "03", parent: 0, position: "absolute", box: { left: -18, top: -210, width: 700, height: 720 } },
        ],
        () => probePage(canvas),
      );
      expect(probe.overflow, "a placed decoration is not a layout failure").toBe(false);
      expect(probe.overflowing).toEqual([]);
    });

    it("leaves a child of a CLIPPING parent alone — that parent has already said what happens at its edge", () => {
      const probe = withFakeDom(
        [
          { tagName: "DIV", className: "panel", childCount: 1, overflow: "hidden", box: parentBox },
          { tagName: "DIV", className: "inner", text: "clipped by design", parent: 0, box: { left: 64, top: 245, width: 952, height: 633 } },
        ],
        () => probePage(canvas),
      );
      expect(probe.overflow).toBe(false);
    });

    it("reports an escaping element ONCE even though both limbs could name it", () => {
      const probe = withFakeDom(
        [
          { tagName: "DIV", className: "field", childCount: 1, box: parentBox },
          {
            tagName: "DIV", className: "copy", text: "both ways", parent: 0,
            box: { left: 64, top: 245, width: 952, height: 633 },
            scroll: { w: 952, h: 900 }, client: { w: 952, h: 633 },
          },
        ],
        () => probePage(canvas),
      );
      expect(probe.overflowing, "one element, one entry").toEqual(["div.copy"]);
    });
  });

  it("names a box that escapes the canvas, and tolerates a 1px rounding overhang", () => {
    const probe = withFakeDom(
      [
        { tagName: "DIV", id: "bleed", text: "off", box: { left: 40, top: 1400, width: 1000, height: 200 } },
        { tagName: "DIV", id: "edge", text: "at the edge", box: { left: 0, top: 0, width: 1081, height: 1441 } },
      ],
      () => probePage(canvas),
    );
    expect(probe.offscreen).toContain("div#bleed");
    expect(probe.offscreen, "a 1px overhang is rounding, not a layout escape").not.toContain("div#edge");
  });

  it("ignores script/style/head text — a font nothing paints is not a font in use", () => {
    const probe = withFakeDom(
      [
        { tagName: "HEAD", childCount: 2, text: "title" },
        { tagName: "TITLE", text: "Slide 3", fontFamily: "Times" },
        { tagName: "STYLE", text: ":root { --bg: #17181C }", fontFamily: "Courier" },
        { tagName: "SCRIPT", text: "window.__CAROUSEL_READY__ = true;", fontFamily: "Consolas", scroll: { w: 9999, h: 20 }, client: { w: 0, h: 0 } },
        { tagName: "DIV", className: "copy", text: "Real copy", box: { left: 0, top: 0, width: 540, height: 720 }, fontFamily: "Heebo, sans-serif" },
      ],
      () => probePage(canvas),
    );
    expect(probe.fontFamiliesUsed).toEqual(["Heebo"]);
    // The script's absurd scrollWidth must not read as a layout overflow.
    expect(probe.overflow).toBe(false);
    expect(probe.textBoxShare).toBeCloseTo(0.25, 8);
  });

  it("clamps textBoxShare to 1 rather than reporting a share above the plate", () => {
    const probe = withFakeDom(
      [
        { tagName: "DIV", className: "a", text: "one", box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "DIV", className: "b", text: "two", box: { left: 0, top: 0, width: 1080, height: 1440 } },
      ],
      () => probePage(canvas),
    );
    expect(probe.textBoxShare).toBe(1);
  });

  it("sorts the family list so two runs of the same page cannot differ", () => {
    const probe = withFakeDom(
      [
        { tagName: "DIV", className: "a", text: "one", box: { left: 0, top: 0, width: 10, height: 10 }, fontFamily: "Zilla Slab" },
        { tagName: "DIV", className: "b", text: "two", box: { left: 0, top: 0, width: 10, height: 10 }, fontFamily: "Assistant" },
        { tagName: "DIV", className: "c", text: "three", box: { left: 0, top: 0, width: 10, height: 10 }, fontFamily: "Assistant" },
      ],
      () => probePage(canvas),
    );
    expect(probe.fontFamiliesUsed).toEqual(["Assistant", "Zilla Slab"]);
  });
});

describe("the Chromium fixtures are valid inputs even where the browser is absent", () => {
  it("parses the measure/probe input the gated block renders", () => {
    const payload = input({ measure: true, probe: true });
    expect(payload.measure).toBe(true);
    expect(payload.probe).toBe(true);
    expect(payload.canvas.scale, "validateRenderInputs pins this to exactly 2").toBe(2);
    expect(payload.slides[0]!.measure).toEqual({ groundHex: GROUND, foregroundHex: FOREGROUND });
    expect(payload.slides[1]!.measure).toEqual({ groundHex: GROUND, accentHex: ACCENT });
  });

  it("defaults both flags off, so an existing caller's parsed input is unchanged", () => {
    const payload = input();
    expect(payload.measure).toBeUndefined();
    expect(payload.probe).toBeUndefined();
  });
});

describe.skipIf(!isChromiumInstalled())("publish.renderCarousel measure/probe against a real Chromium render", () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(ROOT, TEMPLATE_DIR), { recursive: true });
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "fitting.html"), FITTING_HTML, "utf8");
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "carrying.html"), CARRYING_HTML, "utf8");
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "flooded.html"), FLOODED_HTML, "utf8");
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "overflowing.html"), OVERFLOWING_HTML, "utf8");
  }, 120_000);

  afterAll(async () => {
    await fs.rm(path.join(ROOT, TEMPLATE_DIR), { recursive: true, force: true });
    await fs.rm(path.join(ROOT, OUT_DIR), { recursive: true, force: true });
  });

  it(
    "attaches metrics to EVERY rendered entry when measure is on",
    async () => {
      const result = await run(input({ measure: true }));
      expect(result.rendered).toHaveLength(2);
      for (const entry of result.rendered) {
        expect(entry.metrics, `slide ${entry.n} was not measured`).toBeDefined();
        expect(entry.measureFailure).toBeUndefined();
        const m = entry.metrics!;
        for (const [field, value] of Object.entries(m)) {
          if (typeof value === "number") expect(value, `${field} on slide ${entry.n}`).toBeGreaterThanOrEqual(0);
        }
        expect(m.flatBackgroundShare).toBeLessThanOrEqual(1);
        expect(m.occupiedShare).toBeLessThanOrEqual(1);
        // The ground token was supplied and the real render has to agree with
        // it — this is the assertion that would catch a scale/anchoring bug.
        // Both fixtures leave the brand ground as the plate's modal flat
        // colour; the case where an element takes that away from it has its
        // own test below.
        expect(m.backgroundMatchesBrandGround, `slide ${entry.n} did not find its declared ground`).toBe(true);
        expect(m.backgroundHex).toBe(GROUND);
      }
    },
    240_000,
  );

  it(
    "reports the ground it MEASURED, not the one it was handed, when an element takes the plate",
    async () => {
      const result = await run(
        input({
          measure: true,
          slides: [
            { n: 1, template: "flooded.html", fields: { title: "A field that became the plate" }, images: {}, htmlFragments: {}, measure: { groundHex: GROUND, accentHex: ACCENT } },
          ],
        }),
      );
      const m = result.rendered[0]!.metrics!;
      // THE ASSERTION THAT MAKES THE ONE ABOVE MEAN SOMETHING. A flat element
      // covering 69% of the frame wins the modal-flat-cell vote, so the
      // declared `#17181C` is no longer what the plate is made of and the
      // metric says so instead of rubber-stamping the caller's token.
      expect(m.backgroundMatchesBrandGround, "a 69% flat field IS the plate's ground, and the declared token is not").toBe(false);
      expect(m.backgroundHex).toBe(ACCENT);
      // ...and the consequence a caller has to know about: with the accent
      // reading as ground, it is the REMAINING brand ground that measures as
      // the graphic. This is why a colour-block design is calibrated below
      // the crossover — see this file's fixture note.
      expect(m.imageryOrDeviceShare).toBeLessThan(0.5);
      expect(m.accentShare).toBeGreaterThan(0.5);
    },
    240_000,
  );

  it(
    "tells the dull slide from the one that carries something",
    async () => {
      const result = await run(input({ measure: true }));
      const dull = result.rendered.find((r) => r.n === 1)!.metrics!;
      const carrying = result.rendered.find((r) => r.n === 2)!.metrics!;

      // The defect the owner reported: mostly flat, barely occupied, one big
      // hole, nothing but words.
      expect(dull.flatBackgroundShare).toBeGreaterThan(0.7);
      expect(dull.imageryOrDeviceShare).toBeLessThan(0.03);
      expect(dull.largestEmptyRectShare).toBeGreaterThan(0.28);
      expect(dull.textShare).toBeGreaterThan(0);

      // The dull slide was handed no `accentHex`, and an accent cannot be
      // measured against an accent nobody named — so this is 0 by design,
      // not by accident. It is the same hint channel whose absence made the
      // interest-floor calibration report 0.0% accent on all eight bundled
      // archetypes.
      expect(dull.accentShare).toBe(0);
      expect(dull.accentPresent).toBe(false);

      // ...and the slide that fills its frame measures the opposite way on
      // every one of those axes. `> 0.4` rather than `> 0.5`: a flat field
      // cannot pass half the plate and still leave the brand ground as the
      // ground — see this file's fixture note for the measured crossover, and
      // `flooded.html`'s test above for what happens past it. 0.4 sits above
      // the whole bundled band (`cover.html`'s colour-block ground with no
      // photograph measures 33.1%) and below this fixture's measured 43.4%.
      expect(carrying.flatBackgroundShare).toBeLessThan(dull.flatBackgroundShare);
      expect(carrying.imageryOrDeviceShare).toBeGreaterThan(0.4);
      expect(carrying.occupiedShare).toBeGreaterThan(dull.occupiedShare);
      expect(carrying.largestEmptyRectShare).toBeLessThan(dull.largestEmptyRectShare);
      expect(carrying.accentShare).toBeGreaterThan(0.4);
      expect(carrying.accentPresent).toBe(true);
    },
    240_000,
  );

  it(
    "attaches a probe with the font families the page actually resolved",
    async () => {
      const result = await run(input({ probe: true }));
      for (const entry of result.rendered) {
        expect(entry.probe, `slide ${entry.n} was not probed`).toBeDefined();
        const probe = entry.probe!;
        expect(probe.n).toBe(entry.n);
        expect(probe.elementCount).toBeGreaterThan(0);
        expect(probe.textBoxShare).toBeGreaterThan(0);
        expect(probe.textBoxShare).toBeLessThanOrEqual(1);
        // The first real evidence that a font LOADED rather than that its
        // <link> was emitted.
        expect(probe.fontFamiliesUsed.length, "no resolved font family").toBeGreaterThan(0);
        expect(probe.fontFamiliesUsed).toContain("Georgia");
        expect(probe.overflow, `slide ${entry.n} overflowed unexpectedly`).toBe(false);
        expect(probe.overflowing).toEqual([]);
        expect(probe.offscreen).toEqual([]);
      }
    },
    240_000,
  );

  it(
    "reports overflow, and names the element, for a box the copy does not fit in",
    async () => {
      const result = await run(
        input({
          probe: true,
          slides: [{ n: 1, template: "overflowing.html", fields: { title: "Averyverylongunbreakableheadline" }, images: {}, htmlFragments: {} }],
        }),
      );
      const probe = result.rendered[0]!.probe!;
      expect(probe.overflow, "a clamped 300px box holding a 90px unbreakable word must overflow").toBe(true);
      expect(probe.overflowing.join(" ")).toContain("clamped");
      expect(probe.overflowing.length).toBeLessThanOrEqual(6);
    },
    240_000,
  );

  it(
    "leaves both fields absent when neither flag is set — every existing caller's result is byte-identical",
    async () => {
      const result = await run(input());
      expect(result.rendered).toHaveLength(2);
      for (const entry of result.rendered) {
        expect(entry.metrics).toBeUndefined();
        expect(entry.probe).toBeUndefined();
        expect(entry.measureFailure).toBeUndefined();
        // The prior shape exactly: `n` plus what `persistRenderedSlide`
        // returned, and nothing else.
        expect(Object.keys(entry).sort()).toEqual(["n", "path"]);
      }
    },
    240_000,
  );
});
