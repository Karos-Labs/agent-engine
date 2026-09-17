import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import {
  checkInterestFloor,
  COVER_HERO_BOX_SHARE,
  COVER_OBJECT_BOX_SHARE,
  DESIGN_CANVAS,
  probeSubjectBoxes,
  type SubjectBoxes,
} from "../src/workflow/interest-floor.js";
import { buildDeviceFragment, deviceCssBlock } from "../src/workflow/slide-devices.js";
import { buildBrandHeadHtml, type BrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import { passingSlideMetrics, passingSlideProbe, isChromiumInstalled } from "./test-helpers.js";

/**
 * CLAUSE I, MEASURED IN A REAL BROWSER ON THE REAL `cover.html`.
 *
 * The owner, 2026-09-16: *"השקף הראשון יחסית ריק ומשעמם"* — the first slide is
 * fairly empty and boring. The plate he was looking at is a gradient with a
 * title in the lower third, and it passed every clause in `interest-floor.ts`,
 * including clause E, because `cover.html`'s own ramp measures
 * `imageryOrDeviceShare` 0.165-0.188 before any content lands on it. **The ramp
 * satisfies a pixel share; it is not a subject.**
 *
 * Raising a pixel floor to refuse it would be fitting a threshold to one
 * palette — the mistake this file's subject has made and measured away six
 * times (`instagram-floor-candidates-falsified`). So the cover question is
 * asked of the DOM: three box areas, read with `getBoundingClientRect()`,
 * which no brand kit can move.
 *
 * ## What this file proves, and what it does not
 *
 * It proves the POLICY and the MEASUREMENT on the real template: the same
 * cover document with nothing on it, with a photograph, and with a figure
 * device, measured in Chromium, produces the three verdicts clause I claims.
 *
 * ## The wiring, which this file used to say it did not prove
 *
 * It said *"`probePage` does not emit `subjectBoxes` yet, so on the live path
 * clause I abstains"*. Half of that was true and the half that mattered was
 * not: `renderCarousel` 1.6.0 DOES compute the three boxes — on
 * `rendered[].geometry.subjectBoxes`, because they are a second in-page read
 * and `probe` is byte-identical to 1.5.1 by design — and the workflow was
 * handing `rendered` to `checkSlidesInterestFloor` without joining the two, so
 * the clause abstained on every production render while the numbers sat one
 * key away. The two no-hero covers in the 2026-09-16 sweep reported
 * `{hero: 0, device: 0, graphic: 0}` and rendered as exactly the plate the
 * owner named.
 *
 * `withSubjectBoxes` at the `08a1` call site merges them onto each row's
 * `probe` before the floor sees it, and `wave2-integration.test.ts` asserts
 * that join on a `geometry`-shaped row. What is measured HERE is still the
 * policy and the three box areas on the real template.
 *
 * Chromium-gated, and CI has Chromium. `KAROS_BROWSER_CHANNEL=chrome` runs it
 * locally against installed Chrome, which is harsher than CI.
 */

const TEMPLATES = path.resolve(__dirname, "..", "assets", "templates", "default");
const CANVAS = DESIGN_CANVAS;

/**
 * The renderer's three substitution forms, mirrored.
 *
 * `fillTemplate` is private to `render-carousel.ts` and the rules are four
 * lines: `{{html:key}}` raw, `{{key}}` escaped, `{{image:key}}` a URL, and any
 * slot nobody filled is emptied rather than screenshotted. Mirrored here
 * rather than reached for, exactly as `interest-floor-calibration.test.ts`
 * mirrors production's head assembly — and for the same reason: this file
 * measures BOXES, so what matters is that the same elements exist in the same
 * places, not that the pixels came out of the same function.
 */
function fillSlots(html: string, fields: Record<string, string>, fragments: Record<string, string>, images: Record<string, string>): string {
  let filled = html;
  for (const [key, fragment] of Object.entries(fragments)) filled = filled.replaceAll(`{{html:${key}}}`, fragment);
  for (const [key, value] of Object.entries(fields)) {
    filled = filled.replaceAll(`{{${key}}}`, value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;"));
  }
  for (const [key, url] of Object.entries(images)) filled = filled.replaceAll(`{{image:${key}}}`, url);
  return filled.replace(/\{\{(?:html:|image:)?[A-Za-z0-9_]+\}\}/gu, "");
}

/** A 2x2 opaque PNG as a data URI — the hero's CONTENT is irrelevant here; its BOX is the measurement. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AzbAxIAdjEoRIwUAJUcCA0ap6bcAAAAASUVORK5CYII=";

/** A kit as `buildBrandHeadHtml` takes it: ground and ink as CSS vars, the accent on its own channel (the template reads `{{accentColor}}`). */
const kit = (bg: string, fg: string, accent: string): BrandRenderTokens => ({
  cssVars: { "--bg": bg, "--fg": fg },
  fontFamilies: [],
  brandAccent: accent,
  badgeStyle: "plain",
  palette: [accent],
});

const TOKENS = kit("#17181C", "#F4F2EC", "#C4552F");

const BASE_FIELDS: Record<string, string> = {
  accentColor: TOKENS.brandAccent!,
  dir: "ltr",
  lang: "en",
  fontScale: "m",
  textAlign: "start",
  groundStyle: "flat",
  slideIndex: "01",
  brandHandle: "@karoslabs",
  title: "GEO is not a future strategy",
  subtitle: "Your buyers are already inside AI-generated answers. Whether your brand is there with them is the question.",
};

const FIGURE_DEVICE = {
  kind: "figure" as const,
  value: "90%",
  label: "of CMOs say buyer discovery now happens inside AI-generated answers",
  source: "Mind the Marketing Gap, BCG, June 2026",
};

let browser: Browser | undefined;
const chromiumInstalled = isChromiumInstalled();

beforeAll(async () => {
  if (!chromiumInstalled) return;
  const channel = process.env["KAROS_BROWSER_CHANNEL"]?.trim();
  browser = await chromium.launch(channel !== undefined && channel.length > 0 ? { channel } : {});
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

/** Composes the real `cover.html`, opens it at 1080x1440 and returns what `probeSubjectBoxes` measures in the page. */
async function boxesFor(over: { fragments?: Record<string, string>; images?: Record<string, string>; extraHead?: string } = {}): Promise<SubjectBoxes> {
  const template = await fs.readFile(path.join(TEMPLATES, "cover.html"), "utf8");
  const head = `${buildBrandHeadHtml(TOKENS)}\n${over.extraHead ?? ""}`;
  const html = fillSlots(template, BASE_FIELDS, over.fragments ?? {}, over.images ?? {}).replace("</head>", `${head}\n</head>`);
  const page = await browser!.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h } });
  try {
    await page.setContent(html, { waitUntil: "load" });
    return (await page.evaluate(probeSubjectBoxes, { w: CANVAS.w, h: CANVAS.h })) as SubjectBoxes;
  } finally {
    await page.close();
  }
}

/** Clause I's verdict for a cover carrying these boxes, through the REAL rule. */
function coverVerdict(subjectBoxes: SubjectBoxes): string[] {
  return checkInterestFloor(passingSlideMetrics(), passingSlideProbe(1, { subjectBoxes }), "cover", { slide: 1 }).findings.map((f) => f.kind);
}

describe.skipIf(!chromiumInstalled)("clause I: a cover carries a subject, measured in Chromium", () => {
  it("the gradient cover the owner called empty fails — its ground paints, and a ground is not a subject", async () => {
    const boxes = await boxesFor();
    expect(boxes.hero).toBe(0);
    // Whatever the ramp, the rail and the eyebrow come to, none of them is an
    // object: together they stay under the object floor.
    expect(boxes.device).toBeLessThan(COVER_OBJECT_BOX_SHARE);
    expect(boxes.graphic).toBeLessThan(COVER_OBJECT_BOX_SHARE);
    const kinds = coverVerdict(boxes);
    expect(kinds).toContain("cover-subject");
  });

  it("...the same cover with a full-bleed photograph passes, on the hero limb", async () => {
    const boxes = await boxesFor({ images: { hero: TINY_PNG } });
    // `cover.html`'s `.hero` is `position: absolute; inset: 0` — a photograph
    // on this template is the whole plate, comfortably over the 45% floor.
    expect(boxes.hero).toBeGreaterThanOrEqual(COVER_HERO_BOX_SHARE);
    expect(coverVerdict(boxes)).not.toContain("cover-subject");
  });

  it("...and the same cover with a figure device passes, on the object limb", async () => {
    const boxes = await boxesFor({ fragments: { device: buildDeviceFragment(FIGURE_DEVICE, "ltr") }, extraHead: `<style>${deviceCssBlock()}</style>` });
    expect(boxes.hero).toBe(0);
    expect(boxes.device).toBeGreaterThanOrEqual(COVER_OBJECT_BOX_SHARE);
    expect(coverVerdict(boxes)).not.toContain("cover-subject");
  });

  /**
   * The measurement's own guard: a `.dv` fragment sits INSIDE `.cov-device`,
   * and both are in the device group. Counted twice, a device would measure
   * about double its area and a thin one would pass a floor it should not.
   */
  it("counts a nested object once, not twice", async () => {
    const boxes = await boxesFor({ fragments: { device: buildDeviceFragment(FIGURE_DEVICE, "ltr") }, extraHead: `<style>${deviceCssBlock()}</style>` });
    expect(boxes.device).toBeLessThanOrEqual(1);
    // The slot is full width and the fragment fills it, so double counting
    // would put this over half the canvas on its own.
    expect(boxes.device).toBeLessThan(0.5);
  });

  /**
   * THE PALETTE CONTROL, which is the whole reason this clause reads boxes.
   *
   * RFC-21 §2.9 made the owner's colour-agnosticism instruction executable:
   * one plate, four brand palettes, the verdict must be identical. Every
   * pixel-derived separator this project has tried failed exactly here.
   */
  it("measures the same boxes on four brand palettes — a kit cannot move a bounding rectangle", async () => {
    const palettes: BrandRenderTokens[] = [
      TOKENS,
      kit("#FFFFFF", "#101014", "#2F5BC4"),
      kit("#0B2E4F", "#EAF2FB", "#A5E82B"),
      // On the 4.5:1 contrast floor, which is the palette every pixel-derived
      // separator has died on.
      kit("#3A3A3A", "#EDEDED", "#7A7A7A"),
    ];
    const readings: SubjectBoxes[] = [];
    for (const tokens of palettes) {
      const template = await fs.readFile(path.join(TEMPLATES, "cover.html"), "utf8");
      const html = fillSlots(template, { ...BASE_FIELDS, accentColor: tokens.brandAccent! }, {}, {}).replace("</head>", `${buildBrandHeadHtml(tokens)}\n</head>`);
      const page = await browser!.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        readings.push((await page.evaluate(probeSubjectBoxes, { w: CANVAS.w, h: CANVAS.h })) as SubjectBoxes);
      } finally {
        await page.close();
      }
    }
    for (const reading of readings) expect(reading).toEqual(readings[0]);
    // And the verdict, which is the thing that actually has to be identical.
    for (const reading of readings) expect(coverVerdict(reading)).toEqual(coverVerdict(readings[0]!));
  }, 120_000);
});

describe("clause I's policy, without a browser", () => {
  /**
   * The two numbers, written down where a reviewer reads them, and the
   * abstention. `interest-floor.test.ts` carries the rest of the clause's unit
   * behaviour; this is the part that has to stay true when Chromium is absent.
   */
  it("pins the two floors and abstains when nothing measured the boxes", () => {
    expect(COVER_HERO_BOX_SHARE).toBe(0.45);
    expect(COVER_OBJECT_BOX_SHARE).toBe(0.12);
    expect(coverVerdict({ hero: 0, device: 0.004, graphic: 0.01 })).toContain("cover-subject");
    expect(checkInterestFloor(passingSlideMetrics(), passingSlideProbe(1), "cover", { slide: 1 }).findings.map((f) => f.kind)).not.toContain("cover-subject");
  });

  /**
   * `probeSubjectBoxes` is serialised BY SOURCE and run inside the page, so a
   * reference to anything at module scope would throw a `ReferenceError` in
   * Chromium rather than fail a comparison — the same contract `probePage`
   * declares in `render-carousel.ts`. Asserted off the source, because the
   * property is "closes over nothing" and no call can demonstrate that.
   */
  it("is self-contained, so Playwright can serialise it", async () => {
    // Newlines normalised first: the tree is CRLF, and a `\n}\n` search on it
    // silently returns -1 and slices the whole file — which would make this
    // guard pass by reading the wrong text, then fail on a constant declared
    // three hundred lines away.
    const source = (await fs.readFile(path.resolve(__dirname, "..", "src", "workflow", "interest-floor.ts"), "utf8")).replace(/\r\n/gu, "\n");
    const start = source.indexOf("export function probeSubjectBoxes");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end, "probeSubjectBoxes's closing brace was not found — the slice below would read the rest of the file").toBeGreaterThan(start);
    const body = source.slice(start, end);
    // The module's own exported constants are the reachable mistake: naming
    // one here would read fine in Node and be `undefined` in the page.
    for (const name of ["COVER_HERO_BOX_SHARE", "COVER_OBJECT_BOX_SHARE", "CONTENT_WEIGHTS", "DESIGN_CANVAS", "FULL_BLEED_IMAGERY_SHARE"]) {
      expect(body, `probeSubjectBoxes must not close over ${name}`).not.toContain(name);
    }
  });
});
