import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { TYPE_SCALE_PX, typeScaleDeclarations, type TypeStep } from "../src/workflow/visual-system.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * ── SCRUM-503 — THE REVIEWER'S TYPE-SCALE CONTROL RUNS BACKWARDS, AND IT
 *    CANNOT BE TUNED STRAIGHT. ──
 *
 * The control is three settings on one axis: `body.ts-s` (`--ts` 0.85), the
 * unclassed middle (1), and `body.ts-l` (1.18). The only thing a control shaped
 * like that promises is an ORDER — ask for larger type, get larger type.
 *
 * It does not hold. Measured here on `headline-focus.html` at the production
 * scale, one plate, only the body class changed:
 *
 *     copy      s            m            l            rungs (s/m/l)
 *     1 word    187.00px     124.00px     146.32px     -1 / 0 / 0
 *     5 words   187.00px     220.00px     146.32px     -1 / -1 / 0
 *     9 words   105.40px     124.00px     146.32px      0 / 0 / 0
 *     14 words  105.40px     124.00px      99.12px      0 / 0 / 1
 *
 * Row 3 is the control working. Rows 1, 2 and 4 are it losing to the fit
 * ladder: SMALL renders 28% larger than LARGE on a one-line plate, and the
 * MIDDLE setting is the largest of the three on row 2.
 *
 * ## The cause, which is arithmetic and not a bug in any one rule
 *
 * The ladder moves a host by a STEP of the scale. The steps this set declares
 * are `46 -> 84` (x1.83), `84 -> 124` (x1.48) and `124 -> 220` (x1.77). The
 * control's whole range is x1.39, and one of its notches is x1.18. **Every rung
 * the ladder can take is larger than the entire control.** So the size a plate
 * ends at is decided by whether it had ROOM for a rung, not by what the
 * reviewer asked for — and a short plate at `s` has room where the same plate
 * at `l` does not. `the ladder's smallest rung is bigger than the control's
 * largest notch` below pins exactly that, so the day the scale or the control
 * changes enough for this to be fixable, this file says so.
 *
 * ## Why nothing here is FIXED, which is a measurement and not a preference
 *
 * Both cheap fixes were built and swept on this tree before this file was
 * written, and both cost more than the defect:
 *
 * 1. **Bound the rung to one notch of the control**
 *    (`--fit-grow: min(calc(1 / var(--ts-s)), var(--ts-l))`, x1.176, replacing
 *    the named step). It works — every grow inversion above disappears and the
 *    order becomes provable for all copy that fits. It also empties the plates,
 *    because the rung exists to fill them. Swept over 6 templates x 2
 *    directions x 2 copy lengths x 3 settings, `largestEmptyRectShare`:
 *
 *        headline-focus ltr short l   0.2111 -> 0.7333   (+0.52, NEWLY OVER)
 *        headline-focus rtl short l   0.3833 -> 0.7278   (+0.34)
 *        headline-focus rtl short s   0.5333 -> 0.8556   (+0.32)
 *        closer         ltr short m   0.1389 -> 0.3722   (+0.23, NEWLY OVER)
 *        closer         rtl short m   0.2167 -> 0.3722   (+0.16, NEWLY OVER)
 *        ... 38 rows emptier, 25 fuller, 3 newly over the refusal ceiling
 *
 *    The rows that get emptier are the SHORT ones — which are the rows the
 *    rung was added for, and the owner's *"חלק מהשקפים ריקים"*.
 *
 * 2. **Make the rung's outcome independent of the setting** (decide it at the
 *    largest setting and apply it at whichever is in force; or let only the
 *    largest setting grow). Both are monotone by construction, and both can
 *    only ever REMOVE a rung that fires today — never add one — so neither can
 *    improve fill anywhere and both must reduce it wherever a setting currently
 *    grows, including the unclassed middle that production actually renders.
 *    That is an argument rather than a sweep, and it is the reason no sweep was
 *    run for them.
 *
 * So ordering and fill are opposed while the ladder moves in whole steps, and
 * the fix is the one the set already has open: fit CONTINUOUSLY within a step
 * rather than stepping (SCRUM-503 option 3), which is the deferred round-1
 * type-scale Major `template-furniture.test.ts` carries the ratchet for. This
 * file is the measurement that pass will need, and the guard that the
 * diagnosis stays true in the meantime.
 *
 * Nothing ships wrong because of the defect today: no client sees the control,
 * and no plate above is refused by any floor.
 *
 * `KAROS_BROWSER_CHANNEL=chrome` renders locally with installed Chrome, which
 * is HARSHER than CI — a local failure here is not automatically a regression.
 */

const TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");

/**
 * The renderer's own slot rules, mirrored: `{{html:key}}` raw, `{{key}}`
 * escaped, and any slot nobody filled is emptied rather than screenshotted.
 * Mirrored rather than reached for, exactly as `cover-subject.test.ts` and
 * `interest-floor-calibration.test.ts` mirror their halves of production — this
 * file measures a COMPUTED FONT SIZE, so what matters is that the same elements
 * carry the same classes, not that the markup came out of the same function.
 */
function fillSlots(html: string, fields: Record<string, string>): string {
  let filled = html;
  for (const [key, value] of Object.entries(fields)) {
    filled = filled.replaceAll(`{{${key}}}`, value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;"));
  }
  return filled.replace(/\{\{(?:html:|image:)?[A-Za-z0-9_]+\}\}/gu, "");
}

/** The three settings, smallest first. The middle one is the absence of a class. */
const SETTINGS = ["s", "m", "l"] as const;

// ─────────────────────────────────────────────────────────────────────────
// 1. WHY IT CANNOT BE TUNED STRAIGHT — arithmetic, no browser, so it fails in
//    the diff that changes the scale or the control rather than in whichever
//    render happens to notice.
// ─────────────────────────────────────────────────────────────────────────

describe("the fit ladder's rung against the reviewer's control", () => {
  let sheet: string;

  beforeAll(async () => {
    sheet = await fs.readFile(path.join(TEMPLATE_DIR, "_design-system.css"), "utf8");
  });

  /** The two named settings, read off the sheet rather than restated here. */
  const control = (css: string): { small: number; large: number } => {
    const small = /body\.ts-s\s*\{\s*--ts:\s*([0-9.]+)/u.exec(css)?.[1];
    const large = /body\.ts-l\s*\{\s*--ts:\s*([0-9.]+)/u.exec(css)?.[1];
    expect(small, "`_design-system.css` no longer declares `body.ts-s`").toBeTruthy();
    expect(large, "`_design-system.css` no longer declares `body.ts-l`").toBeTruthy();
    return { small: Number(small), large: Number(large) };
  };

  /**
   * Every grow rung the sheet declares, as a RATIO — `[data-fit="-1"].r-lead {
   * font-size: var(--t-statement) }` is `statement / lead`. Read off the sheet
   * and priced with `TYPE_SCALE_PX`, so neither half can move without this
   * number moving.
   */
  const growRungs = (css: string): Array<{ from: string; to: string; ratio: number }> => {
    const rungs: Array<{ from: string; to: string; ratio: number }> = [];
    for (const m of css.matchAll(/\[data-fit="-1"\]\.r-([a-z]+)\s*\{\s*font-size:\s*var\(--t-([a-z]+)\)/gu)) {
      const from = m[1] as TypeStep;
      const to = m[2] as TypeStep;
      rungs.push({ from, to, ratio: TYPE_SCALE_PX[to] / TYPE_SCALE_PX[from] });
    }
    return rungs;
  };

  it("declares a grow rung for every role that has one", () => {
    // If this list empties, the rung was removed rather than fixed, and the
    // plates it fills are the owner's empty-slide complaint.
    const rungs = growRungs(sheet);
    expect(rungs.map((r) => r.from).sort()).toEqual(["display", "lead", "statement"]);
  });

  it("the ladder's smallest rung is bigger than the control's largest notch — which is the whole defect", () => {
    const { small, large } = control(sheet);
    const rungs = growRungs(sheet);
    const smallestRung = Math.min(...rungs.map((r) => r.ratio));
    // The two notches of a three-setting control: s -> m and m -> l.
    const largestNotch = Math.max(1 / small, large);

    expect(
      smallestRung,
      `the smallest grow rung is x${smallestRung.toFixed(3)} (${rungs.map((r) => `${r.from}->${r.to} x${r.ratio.toFixed(3)}`).join(", ")}) ` +
        `and the control's largest notch is x${largestNotch.toFixed(3)}. THIS CASE GOING RED IS GOOD NEWS: it means the ladder can ` +
        `no longer move a plate further than the reviewer can, so SCRUM-503's inversion is fixable by tuning and the rendered case ` +
        `below should be turned from a measurement into an assertion. Do not "fix" this case by widening the control or shrinking ` +
        `the rung without re-running the fill sweep in this file's header — that trade was measured and it lost.`,
    ).toBeGreaterThan(largestNotch);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. WHAT IT ACTUALLY RENDERS.
// ─────────────────────────────────────────────────────────────────────────

/** Copy lengths chosen to straddle the rung: two short enough to grow at some settings, one that grows at none, one long enough that the largest setting has to shrink. */
const COPY = [
  { label: "1 word", text: "Restraint" },
  { label: "5 words", text: "AI does not have a look" },
  { label: "9 words", text: "The best marketing does not look like marketing at all" },
  { label: "14 words", text: "Every brand that tries to sound like everyone else ends up sounding like nobody in particular" },
] as const;

interface Rendered {
  copy: string;
  setting: string;
  /** The resolved `font-size` of the primary host, in px. */
  px: number;
  /** The rung the ladder landed on: negative grew, positive shrank. */
  rung: number;
}

describe.skipIf(!isChromiumInstalled())("the control against the ladder, on the pixels (Chromium)", () => {
  let browser: Browser | undefined;
  const rendered: Rendered[] = [];

  beforeAll(async () => {
    const channel = process.env["KAROS_BROWSER_CHANNEL"]?.trim();
    browser = await chromium.launch(channel !== undefined && channel.length > 0 ? { channel } : {});

    const source = await fs.readFile(path.join(TEMPLATE_DIR, "headline-focus.html"), "utf8");
    /**
     * THE PRODUCTION SCALE, NOT THE TEMPLATE'S OWN.
     *
     * A template declares the scale so a brandless render is self-contained,
     * and every real run overrides it with `visualSystemCssBlock`'s block. The
     * two are not the same numbers — the template's fallback is 46/66/94/200
     * and `TYPE_SCALE_PX` is 46/84/124/220 — so a measurement taken against the
     * fallback is a measurement of a scale no client receives. Emitted here
     * exactly as a run emits it, which is why the header's figures are 124 and
     * 220.
     */
    const runScale = `<style>body {\n${typeScaleDeclarations("display").join("\n")}\n}</style>`;

    for (const copy of COPY) {
      for (const setting of SETTINGS) {
        const html = fillSlots(source, {
          fontScale: setting,
          textAlign: "start",
          dir: "ltr",
          lang: "en",
          slideIndex: "04",
          groundStyle: "grid",
          accentColor: "#C4552F",
          kicker: "KICKER",
          brandHandle: "@karos",
          headline: copy.text,
        }).replace("</head>", `${runScale}\n</head>`);

        const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
        try {
          await page.setContent(html, { waitUntil: "load" });
          await page.waitForFunction("window.__CAROUSEL_READY__ === true", null, { timeout: 30_000 });
          // Evaluated as an EXPRESSION rather than a function so this file needs
          // no `dom` lib: everything inside runs in the page, nothing in it is
          // typechecked here, and the shape is asserted on the way out.
          const measured = (await page.evaluate(
            `(() => {
               const host = document.getElementById("headline");
               return {
                 px: parseFloat(getComputedStyle(host).fontSize),
                 grow: Number(host.getAttribute("data-fit") || "0"),
                 shrink: Number(document.body.getAttribute("data-fit-step") || "0"),
               };
             })()`,
          )) as { px: number; grow: number; shrink: number };
          expect(Number.isFinite(measured.px), `${copy.label} ${setting}: the headline host has no resolved font-size`).toBe(true);
          rendered.push({ copy: copy.label, setting, px: measured.px, rung: measured.grow !== 0 ? measured.grow : measured.shrink });
        } finally {
          await page.close();
        }
      }
    }
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
  });

  const at = (copy: string, setting: string): Rendered => rendered.find((r) => r.copy === copy && r.setting === setting)!;

  it("measures the control on every copy length, and names every inversion", () => {
    /* eslint-disable no-console */
    console.log(
      [
        "",
        "SCRUM-503 — THE TYPE-SCALE CONTROL, headline-focus.html at the production scale",
        `${"copy".padEnd(10)}${SETTINGS.map((s) => `${s} px`.padEnd(10) + "rung".padEnd(6)).join("")}`,
        ...COPY.map((c) => `${c.label.padEnd(10)}` + SETTINGS.map((s) => `${at(c.label, s).px.toFixed(2).padEnd(10)}${String(at(c.label, s).rung).padEnd(6)}`).join("")),
        "",
      ].join("\n"),
    );

    const inversions: string[] = [];
    for (const c of COPY) {
      const row = SETTINGS.map((s) => at(c.label, s));
      for (let i = 0; i < row.length - 1; i++) {
        if (row[i + 1]!.px < row[i]!.px - 0.01) {
          inversions.push(
            `${c.label}: ${row[i]!.setting} ${row[i]!.px.toFixed(2)}px (rung ${row[i]!.rung}) > ${row[i + 1]!.setting} ${row[i + 1]!.px.toFixed(2)}px (rung ${row[i + 1]!.rung})`,
          );
        }
      }
    }
    console.log(inversions.length === 0 ? "no inversions — see this file's header\n" : `inversions:\n  ${inversions.join("\n  ")}\n`);
    /* eslint-enable no-console */

    // ── CARRIED AS A MEASUREMENT, NOT ASSERTED, AND THE HEADER SAYS WHY. ──
    // Asserting the order here would be asserting a property this tree does not
    // have and cannot be given without emptying the plates. What IS asserted is
    // the DIAGNOSIS, below: that the ladder is the cause. The day the ladder
    // stops being able to overturn the control, the source case above goes red
    // and this one becomes an assertion.
    expect(rendered).toHaveLength(COPY.length * SETTINGS.length);
  });

  it("every inversion is the LADDER's, not the scale's", () => {
    // The scale itself is a pure multiplication by `--ts`, so two settings that
    // both land on their own step are ordered by arithmetic. If this ever
    // fails, the defect is in the scale or in how `--ts` reaches it — a
    // different bug from SCRUM-503, and one that would make the control
    // useless even with no ladder at all (which is what the `--ts`-on-`:root`
    // defect Phase 5.5 fixed actually was).
    for (const c of COPY) {
      const row = SETTINGS.map((s) => at(c.label, s));
      if (row.some((r) => r.rung !== 0)) continue;
      for (let i = 0; i < row.length - 1; i++) {
        expect(
          row[i + 1]!.px,
          `${c.label}: ${row[i + 1]!.setting} renders ${row[i + 1]!.px.toFixed(2)}px against ${row[i]!.setting}'s ${row[i]!.px.toFixed(2)}px ` +
            `with EVERY setting on its own step — the ladder did not touch this row, so the control is broken upstream of it.`,
        ).toBeGreaterThan(row[i]!.px);
      }
    }
  });

  it("the control reaches the type at all", () => {
    // The floor under everything else here, and it has failed before: with the
    // scale declared on `:root` the `var(--ts)` substitution happened where
    // `--ts` is always 1, and all three settings rendered identical plates
    // while every test that read the SOURCE still passed.
    for (const c of COPY) {
      const sizes = new Set(SETTINGS.map((s) => at(c.label, s).px.toFixed(2)));
      expect(sizes.size, `${c.label}: all three settings render the same size — the control is not reaching the type`).toBeGreaterThan(1);
    }
  });
});
