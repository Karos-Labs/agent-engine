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
    // Whole when it fits two lines; otherwise cut at a COMPLETE clause, never
    // with an ellipsis (2026-09-24, Hanky Panky's "sewn in New York and…").
    expect(labels(html)).toEqual(["startups reached the Grand Finale", "Zeely users before the Paris Grand Finale", "discount on the SAFE"]);
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
    // No sentence break inside the limit: cut at the last complete clause, not
    // at a word with an ellipsis (2026-09-24).
    expect(c).toBe("What a production agent system requires");
    expect(labels(html)).toEqual([]);
    expect(html).not.toContain("rc-fig");
  });
});

describe("one plate per figure (2026-09-23)", () => {
  it("drops a figure an earlier slide already stated, so the strip never repeats a number", () => {
    const stat = (n: number, figure: string) => slide({ n, layout: "stat_callout", stat: { figure, subLabel: `label ${n}`, source: "s" } });
    const html = buildRecapFragment([stat(1, "£500K"), stat(3, "£500K"), stat(5, ">50,000"), stat(6, "92%")]);
    // The premise: four figures, one repeated. Without the fold the strip
    // would hold three plates with £500K twice (spread over four sources).
    expect(titles(html)).toEqual(["£500K", "&gt;50,000", "92%"]);
    // The first slide to state it keeps it, with its own label.
    expect(labels(html)[0]).toBe("label 1");
    // Whitespace and case are not a different figure.
    expect(titles(buildRecapFragment([stat(1, "1M +"), stat(2, "1m+"), stat(3, "20%")]))).toEqual(["1M +", "20%"]);
  });
});

describe("a recap label is a complete clause or a headline, never a stub (2026-09-24)", () => {
  it("cuts before a conjunction and lends a naked figure its slide's headline", () => {
    const html = buildRecapFragment([
      slide({ n: 2, layout: "stat_callout", headline: "Nine in ten customers buy again", stat: { figure: "95%", subLabel: "", source: "s" } }),
      slide({ n: 3, layout: "stat_callout", stat: { figure: "75%", subLabel: "of Hanky Panky products sewn in New York and shipped from the same studio", source: "s" } }),
    ]);
    expect(labels(html)).toEqual(["Nine in ten customers buy again", "of Hanky Panky products sewn in New York"]);
    expect(html).not.toContain("…");
  });
});

describe("the strip never prints an ellipsis (2026-09-25, owner feedback WS-10)", () => {
  it("leaves out a plate whose headline has no complete clause that fits, and keeps the rest", () => {
    const html = buildRecapFragment([
      slide({ n: 1, headline: "Your first pin goes live." }),
      slide({ n: 2, headline: "Onboarding flows quietly lose seventy percent of creators within minutes" }),
      slide({ n: 3, headline: "Four creator onboarding click taxes" }),
    ]);
    expect(html).not.toContain("…");
    expect(titles(html)).toEqual(["Your first pin goes live.", "Four creator onboarding click taxes"]);
  });
});
