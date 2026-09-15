import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * # THE FIGURE BAND COLLAPSES ON A PLATE WITH NO PICTURE
 *
 * ## The defect, and why a source scan is the right instrument for it
 *
 * The four panel archetypes carry a bounded image band beside their content, so
 * a carousel is not limited to `cover.html` and `slide.html` for its pictures
 * (owner, 2026-09-15: *"add image slots and sometimes use striking images in
 * other layouts too, beside a stat or a card"*). On a slide with no picture the
 * band has to take NO height at all, or every pictureless plate in the set pays
 * 200px for a photograph it does not have.
 *
 * It was written `.sc-figure-band:not(:has(img)) { display: none; }` and that is
 * false on exactly the plates it was for. **`fillTemplate` erases a slot nobody
 * filled, so the markup renders `<img src="">` and the `<img>` element is still
 * in the document.** The band kept its height everywhere, and CI 35011946920
 * reported `clipped` on `en ltr long l -> stat-callout @ interior` — a plate the
 * calibration sweep attaches no image to at all.
 *
 * `onerror="this.remove()"` is not the guard either, and that is the part worth
 * pinning. An empty `src` may not fire `error`, and if it does it fires
 * ASYNCHRONOUSLY: the DOM probe can read the document before the handler runs,
 * so the same template measures differently from one run to the next. A collapse
 * rule has to be true at parse time.
 *
 * ## Why this file is a regex over CSS rather than a render
 *
 * The rule is a fact about the STYLESHEET, and the stylesheet is the thing that
 * was wrong. A render test would prove it for the one fixture it renders, needs
 * Chromium — which does not install on this machine, so it self-skips locally
 * (`chromium-not-installed-for-render-tests`) — and costs a ~25 minute CI round
 * trip to say so. This runs in milliseconds, covers all four archetypes at once,
 * and fails on the exact edit that caused the defect.
 *
 * `default-template-render.test.ts` still renders these plates; this is the
 * cheap guard in front of it, not a replacement for it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, "..", "assets", "templates", "default");

/** Every archetype that carries the bounded band. `cover.html` and `slide.html` are absent: their picture is full-bleed and they key their own heroless rules off `.bg:empty`. */
const BANDED = ["stat-callout.html", "comparison-card.html", "list-takeaway.html", "quote-card.html"] as const;

const sheetOf = (file: string): string => readFileSync(path.join(TEMPLATES, file), "utf8");

/** CSS with every comment stripped, so a selector quoted in a doc comment is never mistaken for a live rule. */
const rulesOf = (file: string): string => sheetOf(file).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the bounded figure band", () => {
  it.each(BANDED)("collapses in %s on a NON-EMPTY src, never on the element merely existing", (file) => {
    const css = rulesOf(file);

    // The guard itself: an `<img>` whose `src` was erased must not hold the band open.
    expect(css, `${file} has no collapse rule for .sc-figure-band`).toMatch(
      /\.sc-figure-band:not\(:has\(img\[src\]:not\(\[src=""\]\)\)\)\s*\{\s*display:\s*none/u,
    );

    // And the shape that caused the defect may never come back, in the collapse
    // rule or in any rule scoped to "a picture is on this plate".
    expect(css, `${file} still keys a rule off :has(img) alone — an erased slot leaves the element behind`).not.toMatch(
      /:has\(img\)\s*\)?\s*[,{]/u,
    );
    expect(css, `${file} scopes a rule to .sc-figure-band img without testing src`).not.toMatch(
      /\.sc-figure-band img\)/u,
    );
  });

  it.each(BANDED)("keeps %s's onerror, because a filled path that fails to load is the case it IS for", (file) => {
    // Deliberately NOT deleted when the collapse rule was fixed. The two guards
    // answer different questions: the CSS answers "was a slot filled", which is
    // knowable at parse time, and `onerror` answers "did the file load", which
    // is not. Removing either one leaves a hole.
    expect(sheetOf(file)).toMatch(/<img src="\{\{image:hero\}\}" onerror="this\.remove\(\)"/u);
  });

  it.each(BANDED)("floors %s's shrink, so the band can yield height without becoming a stripe", (file) => {
    const css = rulesOf(file);
    // `flex: 0 1 auto` makes the band the element that gives a pixel back when a
    // long body at `l` asks for more than the canvas has — text cannot shrink
    // without being clipped and a cover-fitted photograph can. The floor stops
    // that becoming a sliver that clause E would score as this plate's drawn
    // device.
    expect(css, `${file}'s band is not the shrinking element`).toMatch(/\.sc-figure-band\s*\{[^}]*flex:\s*0 1 auto/u);
    expect(css, `${file}'s band has no min-block-size, so it can be squeezed to nothing`).toMatch(
      /\.sc-figure-band\s*\{[^}]*min-block-size:/u,
    );
  });
});
