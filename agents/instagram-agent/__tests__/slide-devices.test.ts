import { describe, expect, it } from "vitest";
import {
  buildDeviceFragment,
  barMaxFor,
  DEVICE_BAR_HEADROOM,
  DEVICE_VALUE_INSIDE_BAR_THRESHOLD,
  deviceFigureValues,
  figureSizeClass,
  illustrativeNoteFor,
  SlideDeviceSchema,
  SLIDE_DEVICE_KINDS,
  validateDevice,
  type SlideDevice,
} from "../src/workflow/slide-devices.js";

/**
 * Phase 2, item M.2 — the number-device library.
 *
 * The library's whole safety argument is that the copy model authors DATA and
 * this module authors MARKUP, so the tests that matter are the ones that pin
 * the boundary: escaping, the code-side autosize table, the layout rules
 * carried over from the legacy `_cf-devices` reference, and the schema caps
 * that make the "about 50 to 60%" overflow defect unrepresentable rather than
 * merely discouraged.
 */

const FIGURE: SlideDevice = { kind: "figure", value: "73%", label: "of teams file by hand", source: "Acme, 2026" };

/** How many elements in a fragment carry the single accent marker. */
function accentCount(fragment: string): number {
  return fragment.match(/dv-accent/g)?.length ?? 0;
}

describe("SlideDeviceSchema — the caps are the defect fix", () => {
  it("refuses a 13-character display value on every shape that paints one", () => {
    expect(SlideDeviceSchema.safeParse({ ...FIGURE, value: "1234567890123" }).success).toBe(false);
    expect(SlideDeviceSchema.safeParse({ ...FIGURE, value: "123456789012" }).success).toBe(true);
    // "about 50 to 60%" is 15 characters — the string that overflowed a
    // figure in production cannot be constructed at all now.
    expect(SlideDeviceSchema.safeParse({ ...FIGURE, value: "about 50 to 60%" }).success).toBe(false);
    expect(
      SlideDeviceSchema.safeParse({
        kind: "bars",
        rows: [
          { label: "a", value: 1, display: "1234567890123" },
          { label: "b", value: 2, display: "2" },
        ],
        source: "Acme",
      }).success,
    ).toBe(false);
  });

  it("requires a source on the three shapes that assert a measurement, and on no others", () => {
    expect(SlideDeviceSchema.safeParse({ kind: "figure", value: "73%", label: "of teams" }).success).toBe(false);
    expect(
      SlideDeviceSchema.safeParse({
        kind: "figure_pair",
        before: { value: "5", label: "rounds" },
        after: { value: "2", label: "rounds" },
      }).success,
    ).toBe(false);
    // A timeline or a unit grid can legitimately be illustrative, and says so
    // in the rendered fragment instead.
    expect(SlideDeviceSchema.safeParse({ kind: "timeline", points: [{ at: "2024", what: "a" }, { at: "2026", what: "b" }] }).success).toBe(true);
    expect(SlideDeviceSchema.safeParse({ kind: "unit_grid", filled: 72, of: 100, label: "of the queue" }).success).toBe(true);
  });

  it("bounds the row and point counts a plate can actually hold", () => {
    const row = (n: number) => ({ label: `l${n}`, value: n, display: `${n}` });
    expect(SlideDeviceSchema.safeParse({ kind: "bars", rows: [row(1)], source: "s" }).success).toBe(false);
    expect(SlideDeviceSchema.safeParse({ kind: "bars", rows: [1, 2, 3, 4, 5, 6].map(row), source: "s" }).success).toBe(false);
    expect(SlideDeviceSchema.safeParse({ kind: "unit_grid", filled: 100, of: 100, label: "all" }).success).toBe(false);
  });

  it("names all six kinds", () => {
    expect([...SLIDE_DEVICE_KINDS].sort()).toEqual(["bars", "figure", "figure_pair", "timeline", "unit_grid", "versus"]);
  });
});

describe("figureSizeClass — the autosize table, in code and not in the page", () => {
  it("steps at 3 and 6 characters", () => {
    expect(figureSizeClass("73")).toBe("dv-figure--big");
    expect(figureSizeClass("73%")).toBe("dv-figure--big");
    expect(figureSizeClass("4.2x")).toBe("dv-figure--mid");
    expect(figureSizeClass("$1.8B")).toBe("dv-figure--mid");
    expect(figureSizeClass("₪1,200")).toBe("dv-figure--mid");
    expect(figureSizeClass("₪12,000")).toBe("dv-figure--small");
    expect(figureSizeClass("123456789012")).toBe("dv-figure--small");
  });

  it("ignores surrounding whitespace, so a padded value is not silently shrunk a step", () => {
    expect(figureSizeClass("  73%  ")).toBe("dv-figure--big");
  });
});

describe("buildDeviceFragment — structure, escaping, and one accent each", () => {
  it("escapes every model-authored string, so a copy field can never become markup", () => {
    const fragment = buildDeviceFragment(
      { kind: "figure", value: "73%", label: `<script>alert("x")</script> & "quoted"`, source: "a & b" },
      "ltr",
    );
    expect(fragment).not.toContain("<script>");
    expect(fragment).toContain("&lt;script&gt;");
    expect(fragment).toContain("&amp;");
    expect(fragment).toContain("&quot;");
  });

  it("figure: value, one accent rule, label beneath, source line", () => {
    const fragment = buildDeviceFragment(FIGURE, "ltr");
    expect(fragment).toContain(`<div class="dv-figure dv-figure--big">73%</div>`);
    expect(fragment).toContain(`<div class="dv-rule dv-accent"></div>`);
    expect(fragment).toContain(`<div class="dv-label">of teams file by hand</div>`);
    expect(fragment).toContain(`<div class="dv-source">Acme, 2026</div>`);
    expect(accentCount(fragment)).toBe(1);
  });

  it("figure_pair: the accent lands on the AFTER value, and the arrow follows reading direction", () => {
    const device: SlideDevice = {
      kind: "figure_pair",
      before: { value: "5", label: "rounds" },
      after: { value: "2", label: "rounds" },
      source: "Acme, 2026",
    };
    const ltr = buildDeviceFragment(device, "ltr");
    expect(ltr).toContain("→");
    expect(ltr).not.toContain("←");
    expect(accentCount(ltr)).toBe(1);
    // The accented element is the after figure, not the arrow.
    expect(ltr).toContain(`<div class="dv-figure dv-figure--big dv-accent">2</div>`);

    const rtl = buildDeviceFragment(device, "rtl");
    expect(rtl).toContain("←");
    expect(rtl).not.toContain("→");
  });

  it("bars: the largest row carries the accent, every row states its own display value", () => {
    const device: SlideDevice = {
      kind: "bars",
      rows: [
        { label: "Manual intake", value: 62, display: "62%" },
        { label: "Automated", value: 21, display: "21%" },
        { label: "Abandoned", value: 17, display: "17%" },
      ],
      source: "Acme, 2026",
    };
    const fragment = buildDeviceFragment(device, "ltr");
    expect(fragment.match(/dv-bar-row/g)?.length).toBe(3);
    expect(accentCount(fragment)).toBe(1);
    expect(fragment).toContain("62%");
    expect(fragment).toContain("21%");
    // Complementary shares (they sum to 100) are drawn against 100, so the
    // longest bar is 62% of its track rather than all of it.
    expect(fragment).toContain(`style="inline-size:62.0%"`);
    // The accent is on the largest row's fill.
    expect(fragment).toContain(`<div class="dv-bar-fill dv-accent" style="inline-size:62.0%">`);
  });

  it("bars: the value moves INSIDE the fill at 0.72 of the track and not at 0.71", () => {
    const device = (value: number): SlideDevice => ({
      kind: "bars",
      max: 100,
      rows: [
        { label: "a", value, display: "v" },
        { label: "b", value: 5, display: "5" },
      ],
      source: "Acme",
    });
    expect(DEVICE_VALUE_INSIDE_BAR_THRESHOLD).toBe(0.72);

    const below = buildDeviceFragment(device(71), "ltr");
    expect(below).not.toContain("dv-bar-row--inset");
    // Outside the fill: the value span follows the track's closing tag.
    expect(below).toContain(`</div></div><span class="dv-bar-value">v</span>`);

    const at = buildDeviceFragment(device(72), "ltr");
    expect(at).toContain("dv-bar-row--inset");
    expect(at).toContain(`style="inline-size:72.0%"><span class="dv-bar-value">v</span>`);
  });

  it("timeline: the accent lands on the last point, and a sourceless device says it is illustrative", () => {
    const fragment = buildDeviceFragment(
      { kind: "timeline", points: [{ at: "2024", what: "manual" }, { at: "2025", what: "scripted" }, { at: "2026", what: "automated" }] },
      "ltr",
    );
    expect(fragment.match(/dv-tl-point/g)?.length).toBe(3);
    expect(accentCount(fragment)).toBe(1);
    expect(fragment.indexOf("dv-accent")).toBeGreaterThan(fragment.indexOf("2025"));
    expect(fragment).toContain(`<div class="dv-note">Illustrative, not measured</div>`);
  });

  it("versus: the winner carries the accent, and 'neither' moves it to the mark — exactly one either way", () => {
    const device = (winner: "left" | "right" | "neither"): SlideDevice => ({
      kind: "versus",
      left: { label: "In-house", body: "Slower, cheaper" },
      right: { label: "Agency", body: "Faster, dearer" },
      winner,
    });
    for (const winner of ["left", "right", "neither"] as const) {
      const fragment = buildDeviceFragment(device(winner), "ltr");
      expect(accentCount(fragment), winner).toBe(1);
    }
    expect(buildDeviceFragment(device("right"), "ltr")).toContain(`<div class="dv-vs-cell dv-accent">`);
    expect(buildDeviceFragment(device("neither"), "ltr")).toContain(`<div class="dv-vs-mark dv-accent">vs</div>`);
  });

  it("unit_grid: 100 units, `filled` of them on, one accent marker on the container", () => {
    const fragment = buildDeviceFragment({ kind: "unit_grid", filled: 72, of: 100, label: "of the queue" }, "ltr");
    expect(fragment.match(/<span class="dv-unit/g)?.length).toBe(100);
    expect(fragment.match(/dv-unit--on/g)?.length).toBe(72);
    // One marker, not seventy-two: the container sets the ink and the filled
    // units inherit it.
    expect(accentCount(fragment)).toBe(1);
    expect(fragment).toContain(`<div class="dv-units dv-accent">`);
    expect(fragment).toContain(`<div class="dv-note">Illustrative, not measured</div>`);
  });

  it("localises the illustrative note through the target-language table, and never guesses", () => {
    expect(illustrativeNoteFor("Hebrew")).toBe("להמחשה בלבד, לא נמדד");
    expect(illustrativeNoteFor("hebrew")).toBe("להמחשה בלבד, לא נמדד");
    expect(illustrativeNoteFor("Arabic")).toContain("توضيحي");
    // An unknown language falls back to English rather than a guessed
    // translation baked into a rendered slide.
    expect(illustrativeNoteFor("Klingon")).toBe("Illustrative, not measured");
    expect(illustrativeNoteFor(undefined)).toBe("Illustrative, not measured");
    expect(buildDeviceFragment({ kind: "unit_grid", filled: 9, of: 100, label: "l" }, "rtl", "Hebrew")).toContain("להמחשה בלבד, לא נמדד");
  });
});

describe("barMaxFor — complementary shares never end flush", () => {
  it("uses 100 when the rows sum to a whole", () => {
    expect(
      barMaxFor({
        kind: "bars",
        rows: [
          { label: "a", value: 62, display: "62%" },
          { label: "b", value: 38, display: "38%" },
        ],
        source: "s",
      }),
    ).toBe(100);
  });

  it("gives unrelated magnitudes headroom, so the longest bar stops short of its track", () => {
    const max = barMaxFor({
      kind: "bars",
      rows: [
        { label: "a", value: 40, display: "40" },
        { label: "b", value: 10, display: "10" },
      ],
      source: "s",
    });
    expect(max).toBeCloseTo(40 * DEVICE_BAR_HEADROOM, 6);
    expect(40 / max).toBeLessThan(1);
  });

  it("honours an explicit max", () => {
    expect(barMaxFor({ kind: "bars", max: 250, rows: [{ label: "a", value: 40, display: "40" }, { label: "b", value: 10, display: "10" }], source: "s" })).toBe(250);
  });
});

describe("validateDevice — a fact, never a gate", () => {
  it("refuses a bar set where a single row would fill the whole track", () => {
    const verdict = validateDevice({
      kind: "bars",
      max: 40,
      rows: [
        { label: "Manual", value: 40, display: "40" },
        { label: "Auto", value: 10, display: "10" },
      ],
      source: "s",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("Manual");
      expect(verdict.reason).toContain("fills its whole track");
    }
  });

  it("refuses a negative bar, an all-zero set, and a half-empty pair — each naming the offending part", () => {
    const negative = validateDevice({ kind: "bars", rows: [{ label: "a", value: -1, display: "-1" }, { label: "b", value: 2, display: "2" }], source: "s" });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.reason).toContain("negative");

    const zeroes = validateDevice({ kind: "bars", rows: [{ label: "a", value: 0, display: "0" }, { label: "b", value: 0, display: "0" }], source: "s" });
    expect(zeroes.ok).toBe(false);

    const halfPair = validateDevice({ kind: "figure_pair", before: { value: "", label: "rounds" }, after: { value: "2", label: "rounds" }, source: "s" });
    expect(halfPair.ok).toBe(false);
    if (!halfPair.ok) expect(halfPair.reason).toContain("BOTH sides");
  });

  it("accepts every well-formed shape", () => {
    const devices: SlideDevice[] = [
      FIGURE,
      { kind: "figure_pair", before: { value: "5", label: "rounds" }, after: { value: "2", label: "rounds" }, source: "s" },
      { kind: "bars", rows: [{ label: "a", value: 62, display: "62%" }, { label: "b", value: 38, display: "38%" }], source: "s" },
      { kind: "timeline", points: [{ at: "2024", what: "manual" }, { at: "2026", what: "automated" }] },
      { kind: "versus", left: { label: "a", body: "b" }, right: { label: "c", body: "d" }, winner: "left" },
      { kind: "unit_grid", filled: 72, of: 100, label: "of the queue" },
    ];
    for (const device of devices) expect(validateDevice(device), device.kind).toEqual({ ok: true });
  });
});

describe("deviceFigureValues — what the device actually paints", () => {
  it("returns the painted tokens per kind, in reading order", () => {
    expect(deviceFigureValues(FIGURE)).toEqual(["73%"]);
    expect(deviceFigureValues({ kind: "figure_pair", before: { value: "5", label: "l" }, after: { value: "2", label: "l" }, source: "s" })).toEqual(["5", "2"]);
    expect(
      deviceFigureValues({ kind: "bars", rows: [{ label: "a", value: 1, display: "1%" }, { label: "b", value: 2, display: "2%" }], source: "s" }),
    ).toEqual(["1%", "2%"]);
    expect(deviceFigureValues({ kind: "timeline", points: [{ at: "2024", what: "a" }, { at: "2026", what: "b" }] })).toEqual(["2024", "2026"]);
    expect(deviceFigureValues({ kind: "unit_grid", filled: 72, of: 100, label: "l" })).toEqual(["72"]);
    // A versus split is prose on both sides — it paints no figure, so it can
    // never satisfy `default:numbers-are-devices` on its own.
    expect(deviceFigureValues({ kind: "versus", left: { label: "a", body: "b" }, right: { label: "c", body: "d" }, winner: "neither" })).toEqual([]);
  });
});
