import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Prep batch 6, karoslabs (pubsub-21792907400950482), slide 5: a 35-word
 * quotation shrunk by the fit ladder set 14 lines in 40% of its panel, because
 * its 17ch measure shrinks with the font. The frame floor holds the measure.
 */
describe("a quotation's measure has a floor in the panel, not only in ch", () => {
  it("quote-card.html sets the quote's measure as max(17ch, a share of the panel)", () => {
    const html = readFileSync(path.resolve(__dirname, "../assets/templates/default/quote-card.html"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(html).toMatch(/\.quote-text\s*\{\s*max-inline-size:\s*min\(max\(17ch,\s*\d{2}%\),\s*100%\);/u);
  });
});
