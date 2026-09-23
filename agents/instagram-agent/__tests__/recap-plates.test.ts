import { describe, expect, it } from "vitest";
import { buildRecapFragment, MAX_RECAP_PLATE_CHARS, MAX_RECAP_SENTENCE_CHARS } from "../src/workflow/slides-data.js";
import type { InstagramSlideCopy } from "../src/workflow/types.js";

// 2026-09-23: two closers the owner saw. Deel's recapped as `84 / 1M+ / 20%`
// with nothing saying what any number counted; karoslabs' cut every headline
// mid-phrase ("Your AI agents keep failing. The prompt…").
const slide = (over: Partial<InstagramSlideCopy> & { n: number }): InstagramSlideCopy =>
  ({ headline: "A headline", body: "b", visualNeed: "v", sourceRef: "c", ...over }) as InstagramSlideCopy;
const titles = (html: string) => [...html.matchAll(/<div class="item-title">([^<]*)<\/div>/gu)].map((m) => m[1]);
const labels = (html: string) => [...html.matchAll(/<div class="rc-label">([^<]*)<\/div>/gu)].map((m) => m[1]);

describe("the closer's recap plates", () => {
  it("a figure plate says what its number counts, from the stat's own sub-label", () => {
    const html = buildRecapFragment([
      slide({ n: 2, layout: "stat_callout", stat: { figure: "84", subLabel: "startups reached the Grand Finale", source: "Vestbee" } }),
      slide({ n: 3, layout: "stat_callout", stat: { figure: "1M+", subLabel: "Zeely users before the Paris Grand Finale", source: "Forbes" } }),
      slide({ n: 4, layout: "stat_callout", stat: { figure: "20%", subLabel: "discount on the SAFE, converting at the next priced round with no cap", source: "Terms" } }),
    ]);
    expect(titles(html)).toEqual(["84", "1M+", "20%"]);
    // Whole when it fits two lines; cut at a word, never mid-word, when not.
    expect(labels(html)).toEqual(["startups reached the Grand Finale", "Zeely users before the Paris Grand Finale", "discount on the SAFE, converting at the next…"]);
    expect(html.match(/rc-plate rc-fig/gu)).toHaveLength(3);
  });

  it("a headline plate keeps a whole first sentence instead of cutting mid-phrase, and carries no label", () => {
    const first = "Your AI agents keep failing.";
    const html = buildRecapFragment([
      slide({ n: 1, headline: `${first} The prompt is not the problem.` }),
      slide({ n: 2, headline: "Most CMOs say AI is transforming marketing. Few run agents in production." }),
      slide({ n: 3, headline: "What a production agent system requires, in practice, for a team of three" }),
    ]);
    const [a, b, c] = titles(html);
    expect(a).toBe(first);
    expect(b).toBe("Most CMOs say AI is transforming marketing.");
    // The premise: that sentence is past the old cut, and inside the new one.
    expect(b!.length).toBeGreaterThan(MAX_RECAP_PLATE_CHARS);
    expect(b!.length).toBeLessThanOrEqual(MAX_RECAP_SENTENCE_CHARS);
    // No sentence break inside the limit: the word-boundary cut still applies.
    expect(c!.endsWith("…")).toBe(true);
    expect(labels(html)).toEqual([]);
    expect(html).not.toContain("rc-fig");
  });
});
