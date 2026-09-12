import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { buildDeviceFragment, deviceCssBlock, type SlideDevice } from "../src/workflow/slide-devices.js";

/**
 * Phase 2, item M — the RTL contract, pinned by source scan.
 *
 * Hebrew is a first-class target language for this agent (client `geektime`),
 * so a device that mirrors correctly is not a nice-to-have. The mechanism is
 * LOGICAL PROPERTIES ONLY: with no `left`/`right` anywhere, `dir="rtl"`
 * mirrors every device on its own and there is no second stylesheet to keep
 * in step with the first.
 *
 * A source scan rather than a render assertion, deliberately, and it is the
 * same shape `default-template-render.test.ts` already uses for colour and
 * font literals: a physical property is invisible in an LTR screenshot and
 * only shows up on the one client whose posts are Hebrew. Scanning the
 * stylesheet catches it on every run instead of on that client's next post.
 * The real RTL RENDER is asserted separately, on pixels, in
 * `interest-floor-calibration.test.ts`.
 */

/** `left: 0`, `right: 12px` — a physical side used as a property. */
const PHYSICAL_SIDE_PROPERTY = /(?:^|[\s;{])(left|right)\s*:/;
/** `margin-left`, `padding-right`, `border-left`, `inset-right`, `scroll-margin-left`, … */
const PHYSICAL_SIDE_LONGHAND = /\b(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b/;
/** `text-align: left|right` — logical copy has to align to `start`/`end`. */
const PHYSICAL_TEXT_ALIGN = /text-align\s*:\s*(left|right)\b/;
/** `float: left`, `clear: right`. */
const PHYSICAL_FLOAT = /\b(?:float|clear)\s*:\s*(left|right)\b/;

const EVERY_KIND: SlideDevice[] = [
  { kind: "figure", value: "73%", label: "מהצוותים עדיין מדווחים ידנית", source: "סקר פנימי, 2026" },
  { kind: "figure_pair", before: { value: "5", label: "סבבים" }, after: { value: "2", label: "סבבים" }, source: "סקר פנימי" },
  {
    kind: "bars",
    rows: [
      { label: "קליטה ידנית", value: 62, display: "62%" },
      { label: "אוטומטי", value: 38, display: "38%" },
    ],
    source: "סקר פנימי",
  },
  { kind: "timeline", points: [{ at: "2024", what: "ידני" }, { at: "2026", what: "אוטומטי" }] },
  { kind: "versus", left: { label: "בתוך הבית", body: "זול, איטי" }, right: { label: "סוכנות", body: "יקר, מהיר" }, winner: "right" },
  { kind: "unit_grid", filled: 72, of: 100, label: "מהתור" },
];

function assertNoPhysicalDirection(source: string, what: string): void {
  for (const [name, pattern] of [
    ["a physical side property (left:/right:)", PHYSICAL_SIDE_PROPERTY],
    ["a physical longhand (margin-left/padding-right/...)", PHYSICAL_SIDE_LONGHAND],
    ["a physical text-align", PHYSICAL_TEXT_ALIGN],
    ["a physical float/clear", PHYSICAL_FLOAT],
  ] as const) {
    const match = pattern.exec(source);
    expect(match?.[0], `${what} carries ${name}: ${match?.[0] ?? ""}`).toBeUndefined();
  }
}

describe("the device stylesheet is logical-properties only", () => {
  it("deviceCssBlock() carries no physical direction property", () => {
    const css = deviceCssBlock();
    assertNoPhysicalDirection(css, "deviceCssBlock()");
    // And it does use the logical forms, so the scan above is not passing
    // for want of any positioning at all.
    expect(css).toContain("padding-inline-end");
    expect(css).toContain("border-inline-start");
    expect(css).toContain("inline-size");
    expect(css).toContain("margin-block-start");
    expect(css).toContain("text-align: start");
  });

  it("is delivered as a complete <style> element, the shape composeDocument's extraHeadHtml takes", () => {
    const css = deviceCssBlock();
    expect(css.startsWith("<style>")).toBe(true);
    expect(css.trimEnd().endsWith("</style>")).toBe(true);
  });

  it("sizes every rule off var(--ts), so the reviewer's type scale and the per-script scale both compose", () => {
    const css = deviceCssBlock();
    // Every `font-size` is a calc against --ts. A bare `font-size: 30px`
    // would sit outside BOTH `body.ts-s/ts-l` and script-fonts.ts's Hebrew
    // 0.94 / Arabic 0.92 scale — the composition trap RFC-13 flagged.
    const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(fontSizes.length).toBeGreaterThan(5);
    for (const value of fontSizes) expect(value, `font-size "${value}" does not scale off var(--ts)`).toContain("var(--ts");
  });
});

describe("every emitted fragment is logical-properties only", () => {
  it("carries no physical direction property in any inline style, in either direction", () => {
    for (const device of EVERY_KIND) {
      for (const dir of ["ltr", "rtl"] as const) {
        assertNoPhysicalDirection(buildDeviceFragment(device, dir, "Hebrew"), `${device.kind} (${dir})`);
      }
    }
  });

  it("uses `inline-size` for the one inline style it does emit — a bar fill grows from the reading-start edge", () => {
    const bars = EVERY_KIND.find((d) => d.kind === "bars")!;
    const fragment = buildDeviceFragment(bars, "rtl", "Hebrew");
    expect(fragment).toContain(`style="inline-size:62.0%"`);
    expect(fragment).not.toContain("width:");
  });

  it("renders Hebrew labels verbatim — no transliteration, no stripping", () => {
    const fragment = buildDeviceFragment(EVERY_KIND[0]!, "rtl", "Hebrew");
    expect(fragment).toContain("מהצוותים עדיין מדווחים ידנית");
    expect(fragment).toContain("סקר פנימי, 2026");
  });
});

/**
 * The two new bundled archetypes, held to the same contract as the rest of
 * the directory (`default-template-render.test.ts` scans every file for
 * colour and font-size literals; these two also have to be direction-clean,
 * because both are built around a bottom- or start-anchored lockup).
 */
describe("cover.html and closer.html are direction-clean and token-driven", () => {
  const TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");

  /** The `<style>` blocks, minus the `:root` token defaults every template in this directory declares. */
  async function stylesOf(file: string): Promise<string> {
    const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
    const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
    return styles.replace(/:root\s*\{[\s\S]*?\}/g, "");
  }

  for (const file of ["cover.html", "closer.html", "headline-focus.html"]) {
    it(`${file} carries no physical direction property outside the :root token block`, async () => {
      const styles = await stylesOf(file);
      assertNoPhysicalDirection(styles, file);
    });

    it(`${file} sizes type off var(--ts) and colours off the tokens`, async () => {
      const styles = await stylesOf(file);
      expect(styles, `${file} sizes type off a bare px literal`).not.toMatch(/font-size:\s*\d+px/);
      // No brand-neutral literal outside `:root` — a literal is exactly what
      // stops a cream-ground client from re-theming a scrim or a keyline.
      expect(styles, `${file} hardcodes a ground/foreground literal`).not.toMatch(/#17181C|#F4F2EC/i);
      expect(styles, `${file} paints no ground at all`).toMatch(/\.ground|\.hero/);
    });
  }

  it("both new files declare their own ready flag, since the renderer waits on it before screenshotting", async () => {
    for (const file of ["cover.html", "closer.html"]) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      expect(html, file).toContain("window.__CAROUSEL_READY__ = true;");
    }
  });

  it("the cover's hero removes itself on error, which is what reveals the colour-block ground beneath it", async () => {
    const html = await fs.readFile(path.join(TEMPLATE_DIR, "cover.html"), "utf8");
    expect(html).toContain(`src="{{image:hero}}"`);
    expect(html).toContain(`onerror="this.remove()"`);
    expect(html).toContain(`{{html:device}}`);
  });

  it("the closer reads the code-built recap fragment, and headline-focus reads a device", async () => {
    expect(await fs.readFile(path.join(TEMPLATE_DIR, "closer.html"), "utf8")).toContain("{{html:recap}}");
    expect(await fs.readFile(path.join(TEMPLATE_DIR, "headline-focus.html"), "utf8")).toContain("{{html:device}}");
  });
});
