import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PLATES, renderPlate } from "../../../scripts/sync-design-system.js";

const DIR = join(process.cwd(), "agents/instagram-agent/assets/templates/default");
const read = (file: string): string => readFileSync(join(DIR, file), "utf8");

/**
 * THE GUARD THAT MAKES THE DESIGN SYSTEM ONE THING.
 *
 * The eight plates used to declare their own scale, ground, brand zone and fit
 * ladder. Nothing held them together, five different authors edited "a
 * template", and the set drifted until one carousel rendered 22-28 distinct
 * type sizes against a six-step scale and three accent colours at eleven
 * widths — which is what the owner read as machine-made. The fix is not a
 * convention; it is this file. Edit `_design-system.css` / `_ds-fit.js`, run
 * `npx tsx scripts/sync-design-system.ts`, and a plate that drifts fails here.
 */
describe("the design system is one source, copied into eight plates", () => {
  it("has every plate byte-identical to the source", () => {
    const drifted = PLATES.filter((plate) => read(plate) !== renderPlate(plate));
    expect(drifted, "run: npx tsx scripts/sync-design-system.ts").toEqual([]);
  });

  it.each(PLATES)("%s carries both generated regions", (plate) => {
    const html = read(plate);
    for (const marker of ["/* @ds:start */", "/* @ds:end */", "/* @ds:fit-start */", "/* @ds:fit-end */"]) {
      expect(html, `${plate} is missing ${marker}`).toContain(marker);
    }
  });
});

/**
 * THE TWO PROPERTIES THE OWNER ASKED FOR, ASSERTED ON THE SOURCE.
 *
 * Both are things a reader sees and both were true of the old set: a carousel
 * that showed the accent at two lengths in two colours, and one that rendered
 * two dozen type sizes. A render test can only ever check the fixtures it
 * happens to render; these check that the set CANNOT express the defect.
 */
describe("the rules the set cannot break", () => {
  const decomment = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
    /* `decomment` above: these guards read CODE, not prose. The doc comment beside
     the scale names `calc(var(--t-x) * 0.8387)` as the thing that must not
     exist, and a guard that cannot tell an example from a declaration fails on
     its own explanation — which is exactly what this one did. */
  const system = decomment(read("_design-system.css"));

  it("sizes type only from the six steps — no fractions of a step", () => {
    /* `calc(var(--t-statement) * 0.7857)` is how the set reached 25 sizes: a
       pixel target written as a fraction. A long string takes a SMALLER STEP. */
    const fractions = system.match(/var\(--t-[a-z]+\)\s*\*\s*[0-9.]+/g) ?? [];
    expect(fractions).toEqual([]);
  });

  it.each(PLATES)("%s sets no font-size outside the scale", (plate) => {
    const body = decomment(read(plate).split("/* @ds:end */")[1] ?? "");
    const offScale = (body.match(/font-size:\s*([^;]+);/g) ?? []).filter(
      (declaration) => !/var\(--t-(micro|label|lead|statement|display|figure)\)/.test(declaration),
    );
    expect(offScale).toEqual([]);
  });

  it.each(PLATES)("%s paints no rule of its own — the accent is the only mark", (plate) => {
    /* A 984px `border-top` on a card reads to the eye exactly like a 984px
       hairline, which is why this checks borders and not just elements. The
       old set carried them on `.me-row`, `.cl-recap`, `.cl-ask`, `.rc-plate`
       and `.cmp-col`, and the probe counted eleven distinct rule widths in one
       carousel against an accent that is a single block. */
    const body = decomment(read(plate).split("/* @ds:end */")[1] ?? "");
    const borders = (body.match(/border(-block|-inline)?(-top|-bottom|-left|-right|-start|-end)?:\s*([^;]+);/g) ?? []).filter(
      (declaration) => !/\b(none|0)\b/.test(declaration),
    );
    expect(borders).toEqual([]);
  });
});
