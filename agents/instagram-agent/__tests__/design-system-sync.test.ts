import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PLATES, renderPlate } from "../../../scripts/sync-design-system.js";

/* From this file, not from `process.cwd()`: CI runs vitest per workspace. */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets/templates/default");
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
    const drifted = PLATES.filter((plate) => read(plate) !== renderPlate(plate, DIR));
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

  it("invents no colour — every colour resolves to a kit token", () => {
    /* THE DEFECT THIS EXISTS FOR, and the owner found it by eye on two clients
       at once. `buildBrandHeadHtml` does NOT emit `--accent`; every template
       declared `--accent: {{accentColor}}` itself, the rewrite dropped the
       declaration, and the whole set fell through to a literal `#ff5a1f`. A
       client whose brand colour is purple and one whose is lime both painted
       ORANGE rules — on plates the system had deliberately left unmarked.

       A literal is legitimate ONLY as the last fallback of a `var()`, so that
       is what this allows and nothing else.

       EVERYTHING IS LOCAL TO THIS TEST, deliberately. The first version read
       the sheet at describe scope and kept the scanner there too; a break-it
       run then measured positions from one copy of the string against another
       read at a different moment, the offsets landed inside a `var()` by
       coincidence, and the guard reported a naked `#ff0000` as legitimate. It
       has been watched refusing that exact break since. */
    const sheet = decomment(read("_design-system.css"));

    const insideVarFallback = (source: string, at: number): boolean => {
      const start = Math.max(source.lastIndexOf(";", at), source.lastIndexOf("{", at)) + 1;
      let depth = 0;
      let varDepth = 0;
      for (let i = start; i < at; i++) {
        if (source[i] === "(") {
          depth += 1;
          if (source.slice(Math.max(0, i - 3), i) === "var") varDepth = depth;
        } else if (source[i] === ")") {
          if (depth === varDepth) varDepth = 0;
          depth -= 1;
        }
      }
      return varDepth > 0;
    };

    /* A literal is legitimate in exactly two places: as the VALUE of a custom
       property — the token block is the one place a colour may be named, and
       the interest-floor calibration reads it to anchor its measurements — and
       as the last fallback of a `var()`. Anywhere else it is a colour the sheet
       invented for a client who did not choose it. */
    const declaresToken = (source: string, at: number): boolean => {
      const start = Math.max(source.lastIndexOf(";", at), source.lastIndexOf("{", at)) + 1;
      return /^\s*--[a-z0-9-]+\s*:\s*$/.test(source.slice(start, at));
    };

    const naked = [...sheet.matchAll(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g)]
      .filter((match) => !insideVarFallback(sheet, match.index) && !declaresToken(sheet, match.index))
      .map((match) => match[0]);
    expect(naked).toEqual([]);
  });

  it("declares the brand accent, because nothing else does", () => {
    /* `--bg`, `--fg`, the faces and the logo zone all arrive from the kit's own
       head block. `--accent` does not: it has always entered through the
       template. If this declaration goes, every accent in the set silently
       becomes `currentColor`. */
    expect(system).toMatch(/--accent:\s*\{\{accentColor\}\}/);
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
