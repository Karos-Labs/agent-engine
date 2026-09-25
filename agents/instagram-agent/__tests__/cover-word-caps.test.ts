import { describe, expect, it } from "vitest";
import { checkHeadlineCaps, COVER_TITLE_MAX_WORDS, HEADLINE_MAX_WORDS } from "../src/workflow/slide-word-budget.js";

/** Owner feedback round 2026-09-24 (H, WS-08): covers carry ten words or fewer in the title, one short deck. */

const cover = (title: string, subtitle: string) => ({ n: 1, template: "cover.html", fields: { title, subtitle }, images: {}, htmlFragments: {} });
const interior = (headline: string) => ({ n: 3, template: "headline-focus.html", fields: { headline, body: "b" }, images: {}, htmlFragments: {} });

describe("cover and headline caps", () => {
  it("refuses XO's 11-word title and 19-word deck", () => {
    const xo = cover(
      "Most agencies still sell hours when their clients want outcomes now",
      "We rebuilt our pricing around results in 2025, and the clients who switched stayed longer than the rest.",
    );
    expect(checkHeadlineCaps(xo as never, 0, 7)?.measured.scope).toBe("cover title");
  });

  it("passes Sitti's 8-word title with a one-sentence 12-word deck", () => {
    const sitti = cover("By August, the spotlights had real names", "Alix Earle's map and Matt Peterson's NYC picks sold out in days.");
    expect(checkHeadlineCaps(sitti as never, 0, 7)).toBeUndefined();
  });

  it("refuses a two-sentence deck even when it is short", () => {
    expect(checkHeadlineCaps(cover("Local knowledge sells", "Creators map cities. Fans pay.") as never, 0, 7)?.measured.scope).toBe("cover deck");
  });

  it("caps an interior headline and leaves the closer alone", () => {
    const long = interior("The one part of a thong that most brands never actually design at all");
    expect(checkHeadlineCaps(long as never, 2, 7)?.measured.limit).toBe(HEADLINE_MAX_WORDS);
    expect(checkHeadlineCaps(long as never, 7, 7)).toBeUndefined();
    expect(COVER_TITLE_MAX_WORDS).toBeLessThanOrEqual(10);
  });

  it("a cover whose photograph fills the plate carries 16 words; a plate or framed cover keeps 20 (decision 20, 2026-09-25)", () => {
    // Sitti's cover (19 words as counted): fine on a plate, three too many over a full-bleed photograph.
    const words = ["By August, the spotlights had real names", "Alix Earle's map and Matt Peterson's NYC picks sold out in days."] as const;
    const poster = { ...cover(...words), images: { hero: ".media-cache/r/n1.jpg" } };
    expect(checkHeadlineCaps(poster as never, 0, 7)?.measured).toEqual({ words: 19, limit: 16, scope: "photo cover total" });
    const framed = { ...poster, fields: { ...poster.fields, heroKind: "framed" } };
    expect(checkHeadlineCaps(framed as never, 0, 7)).toBeUndefined();
    expect(checkHeadlineCaps(cover(...words) as never, 0, 7)).toBeUndefined();
  });
});
