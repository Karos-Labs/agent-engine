import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BUNDLED_SERIES,
  EDITORIAL_SERIES_IDS,
  MIN_SERIES_SLIDES,
  SERIES_ROTATION_HOLD,
  seriesBadgeFor,
  seriesDirective,
  selectSeries,
  skeletonFor,
  type EditorialSeries,
  type EditorialSeriesId,
  type SeriesEvidence,
} from "../src/workflow/editorial-series.js";
import { ARCHETYPE_TEMPLATE_FILES } from "../src/workflow/slides-data.js";
import { InstagramSlideLayoutSchema } from "../src/workflow/types.js";

/**
 * RFC-21 Part 3 — the series layer.
 *
 * The owner's ruling is that a run composes from VALIDATED BUILDING BLOCKS
 * rather than authoring markup, and that the variety comes from the format the
 * story lands in rather than from a bigger menu of slides. Two properties
 * carry that, and everything below is one of them:
 *
 *   1. Every layout a series names is an archetype the repo already renders,
 *      asserted against the real template map rather than a list restated
 *      here. A series that named a layout nothing renders would be a template
 *      the pool never validated, arriving through the back door.
 *   2. Two consecutive runs on the SAME story get DIFFERENT compositions.
 *      That is the owner's repetition complaint stated as a test, and it is
 *      the one thing a per-slide menu could never give.
 */

const NOTHING: SeriesEvidence = { restsOnKinds: [] };

describe("the bundled series are built from validated blocks, and nothing else", () => {
  it("names only layouts the schema declares, and NEVER `custom` — which is the ruling, as an assertion", () => {
    // `custom` is the one layout that needs a file nothing has validated: it is
    // rendered from model-authored `bodyHtml`/`css`. A series naming it would
    // be authored markup arriving through the composition door, which is
    // exactly what the owner's ruling forbids.
    for (const series of BUNDLED_SERIES) {
      for (const layout of series.middle) {
        expect(() => InstagramSlideLayoutSchema.parse(layout), `series "${series.id}" names "${layout}", which is not a declared layout`).not.toThrow();
        expect(layout, `series "${series.id}" composes from an AUTHORED layout`).not.toBe("custom");
      }
    }
    // And the archetype set they draw on is the bundled one, read from the
    // module that owns it rather than restated here.
    expect(ARCHETYPE_TEMPLATE_FILES.length, "the archetype set is empty, so this test proves nothing").toBeGreaterThan(4);
  });

  it("adds no template file of its own: the module imports a type and emits only existing layout names", async () => {
    // The import boundary IS the guarantee, so it is read off the source
    // rather than described. A future edit that reaches for `fs`, a template
    // directory or a CSS string is the moment "composition from validated
    // blocks" stops being true, and it fails here first.
    const source = await fs.readFile(path.resolve(__dirname, "..", "src", "workflow", "editorial-series.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gmu)].map((m) => m[1]!);
    expect(imports, "editorial-series.ts grew an import — composition from validated blocks means it needs none").toEqual(["./types.js"]);
    expect(source).not.toMatch(/<style|<div|\.css|bodyHtml/u);
  });

  it("gives every series a DIFFERENT opening archetype, which is what makes a rotation look like a different post", () => {
    const openers = BUNDLED_SERIES.map((s) => s.middle[0]);
    expect(new Set(openers).size, `two series open on the same archetype: ${openers.join(", ")}`).toBe(BUNDLED_SERIES.length);
  });

  it("declares every id in EDITORIAL_SERIES_IDS exactly once, and a middle long enough for the widest canvas", () => {
    expect(BUNDLED_SERIES.map((s) => s.id).sort()).toEqual([...EDITORIAL_SERIES_IDS].sort());
    for (const series of BUNDLED_SERIES) {
      // `slides_max` is 8: cover + 6 interiors + closer. A middle shorter than
      // six would silently repeat its last entry on a full-length post.
      expect(series.middle.length, `series "${series.id}" cannot fill an eight-slide post without repeating`).toBeGreaterThanOrEqual(6);
      expect(series.badge.length, `series "${series.id}" has no badge`).toBeGreaterThan(0);
      expect(series.register.length, `series "${series.id}" has no register, so the writer gets a skeleton and no instruction`).toBeGreaterThan(40);
    }
  });
});

describe("skeletonFor: cover, the series, closer — truncated, never sampled", () => {
  const series = BUNDLED_SERIES.find((s) => s.id === "the_playbook")!;

  it("returns exactly slideCount layouts, positional ones at the ends", () => {
    for (const count of [4, 5, 6, 7, 8]) {
      const skeleton = skeletonFor(series, count);
      expect(skeleton, `count ${count}`).toHaveLength(count);
      expect(skeleton[0], `count ${count}`).toBe("cover");
      expect(skeleton.at(-1), `count ${count}`).toBe("closer");
    }
  });

  it("TRUNCATES: a six-slide post is the first four interiors of the eight-slide one, so the format reads the same at both lengths", () => {
    const long = skeletonFor(series, 8);
    const short = skeletonFor(series, 6);
    // The claim, stated as a prefix comparison rather than as two literals —
    // two literals would agree with a sampled implementation the first time
    // somebody wrote one.
    expect(short.slice(0, -1)).toEqual(long.slice(0, short.length - 1));
  });

  it("floors at MIN_SERIES_SLIDES rather than returning a carousel with no middle", () => {
    expect(skeletonFor(series, 1)).toHaveLength(MIN_SERIES_SLIDES);
    expect(skeletonFor(series, 0)).toHaveLength(MIN_SERIES_SLIDES);
    expect(skeletonFor(series, Number.NaN)).toHaveLength(MIN_SERIES_SLIDES);
  });

  it("repeats the last interior rather than throwing when a canvas is wider than any series", () => {
    const wide = skeletonFor(series, 12);
    expect(wide).toHaveLength(12);
    expect(wide.at(-2)).toBe(series.middle.at(-1));
  });
});

describe("selectSeries: the story picks the format, and the evidence is what decides", () => {
  const choose = (evidence: Partial<SeriesEvidence>): EditorialSeriesId => selectSeries({ ...NOTHING, ...evidence }).series.id;

  it("two stats and a surprising-number angle is by_the_numbers", () => {
    expect(choose({ restsOnKinds: ["stat", "stat"], angleId: "surprising-number" })).toBe("by_the_numbers");
  });

  it("two compared entities is head_to_head, and the angle alone is not enough", () => {
    expect(choose({ comparedEntities: 2, angleId: "wrong-assumption" })).toBe("head_to_head");
    // THE ASYMMETRY, asserted rather than assumed: a framing with nothing to
    // compare cannot render a comparison card, so the framing alone must not
    // win. Delete the `compared >= 2` limb and this line goes red while the
    // one above stays green.
    expect(choose({ angleId: "wrong-assumption" })).not.toBe("head_to_head");
  });

  it("definitions and a what-it-means angle is the_playbook", () => {
    expect(choose({ restsOnKinds: ["definition", "definition"], angleId: "what-it-means" })).toBe("the_playbook");
  });

  it("an event is field_notes, and two quotes is in_their_words", () => {
    expect(choose({ restsOnKinds: ["event"] })).toBe("field_notes");
    expect(choose({ restsOnKinds: ["quote", "quote"] })).toBe("in_their_words");
  });

  it("ONE quote is not a format: it is a breakdown with a quote slide, which the_breakdown already has", () => {
    expect(choose({ restsOnKinds: ["quote"] })).toBe("the_breakdown");
    // And the reason is legible rather than inferred from the outcome.
    expect(selectSeries({ restsOnKinds: ["quote"] }).scores.in_their_words).toBeLessThanOrEqual(
      selectSeries({ restsOnKinds: ["quote"] }).scores.the_breakdown,
    );
  });

  it("falls to the_breakdown with no evidence at all, and SAYS it was a default rather than a decision", () => {
    const choice = selectSeries(NOTHING);
    expect(choice.series.id).toBe("the_breakdown");
    expect(choice.reason).toMatch(/no format had a signal/u);
  });

  it("publishes every score, so a one-point win cannot pass for a decision", () => {
    const choice = selectSeries({ restsOnKinds: ["stat", "stat"], angleId: "surprising-number" });
    expect(Object.keys(choice.scores).sort()).toEqual([...EDITORIAL_SERIES_IDS].sort());
    expect(choice.scores.by_the_numbers).toBeGreaterThan(choice.scores.the_breakdown);
    expect(choice.reason).toMatch(/by \d+ over /u);
  });

  it("is total and never throws on a malformed run", () => {
    expect(() => selectSeries({ restsOnKinds: [] })).not.toThrow();
    expect(() => selectSeries({ restsOnKinds: [], comparedEntities: Number.NaN })).not.toThrow();
    expect(() => selectSeries({ restsOnKinds: [], recentSeriesIds: ["not-a-series"] })).not.toThrow();
    expect(selectSeries({ restsOnKinds: [], comparedEntities: -4 }).series.id).toBe("the_breakdown");
  });
});

describe("rotation: the owner's repetition complaint, as a property", () => {
  /** The SAME story, three weeks running. Nothing about the evidence changes. */
  const SAME_STORY: SeriesEvidence = { restsOnKinds: ["stat", "stat"], angleId: "surprising-number" };

  it("gives three consecutive runs on one unchanged story three DIFFERENT formats", () => {
    const shipped: EditorialSeriesId[] = [];
    for (let week = 0; week < 3; week++) {
      const choice = selectSeries({ ...SAME_STORY, recentSeriesIds: [...shipped].reverse() });
      shipped.push(choice.series.id);
    }
    expect(new Set(shipped).size, `the same story shipped the same format twice in three weeks: ${shipped.join(" -> ")}`).toBe(3);
  });

  it("and gives them three different OPENING SLIDES, which is the half a reader can see", () => {
    const shipped: EditorialSeriesId[] = [];
    const openers: string[] = [];
    for (let week = 0; week < 3; week++) {
      const choice = selectSeries({ ...SAME_STORY, recentSeriesIds: [...shipped].reverse() });
      shipped.push(choice.series.id);
      openers.push(skeletonFor(choice.series, 8)[1]!);
    }
    expect(new Set(openers).size, `three consecutive posts opened on the same interior archetype: ${openers.join(", ")}`).toBe(3);
  });

  it("holds a format out for exactly SERIES_ROTATION_HOLD posts and then allows it back", () => {
    const first = selectSeries(SAME_STORY).series.id;
    const held = selectSeries({ ...SAME_STORY, recentSeriesIds: [first] });
    expect(held.rotatedAway).toContain(first);
    expect(held.series.id).not.toBe(first);
    // Pushed past the hold, the best format returns — rotation is a rota, not
    // a ban. Asserted with the winner sitting `SERIES_ROTATION_HOLD` posts
    // back, which is the first position the hold no longer covers.
    const recent = [...Array<string>(SERIES_ROTATION_HOLD).fill("the_playbook"), first];
    expect(recent.length).toBeGreaterThan(SERIES_ROTATION_HOLD);
    expect(selectSeries({ ...SAME_STORY, recentSeriesIds: recent }).series.id).toBe(first);
  });

  it("still ships when every series is held out — rotation is a preference, never a refusal", () => {
    const all = BUNDLED_SERIES.map((s) => s.id);
    const choice = selectSeries({ ...SAME_STORY, recentSeriesIds: all }, BUNDLED_SERIES.slice(0, 2));
    expect(choice.series).toBeDefined();
    expect(EDITORIAL_SERIES_IDS).toContain(choice.series.id);
  });

  it("ASSERT THE PREMISE: without the rotation the same story repeats, so the test above is measuring the rotation", () => {
    // Three runs with the history withheld. If this came back with three
    // different formats, the rotation test above would be green for a reason
    // that has nothing to do with rotation — which is how this codebase has
    // produced guards that cannot fail.
    const withoutHistory = [0, 1, 2].map(() => selectSeries(SAME_STORY).series.id);
    expect(new Set(withoutHistory).size).toBe(1);
  });
});

describe("seriesBadgeFor: an explicit brand decision beats a derived one", () => {
  const choice = selectSeries({ restsOnKinds: ["event"] });

  it("prints the series badge when the client set none", () => {
    expect(seriesBadgeFor(choice)).toBe("field notes");
    expect(seriesBadgeFor(choice, "")).toBe("field notes");
    expect(seriesBadgeFor(choice, "   ")).toBe("field notes");
  });

  it("keeps the client's own badge, and the client still gets the series' composition", () => {
    expect(seriesBadgeFor(choice, "מדריך")).toBe("מדריך");
    // The badge is how the format is ANNOUNCED; it is not what the format is.
    expect(skeletonFor(choice.series, 8)[1]).toBe(choice.series.middle[0]);
    expect(choice.series.id).toBe("field_notes");
  });
});

describe("seriesDirective: the writer is given the order, and the fit rules still bind", () => {
  const choice = selectSeries({ restsOnKinds: ["stat", "stat"], angleId: "surprising-number" });

  it("names every slide's layout in order, numbered, for the length it was built at", () => {
    const directive = seriesDirective(choice, 6);
    const skeleton = skeletonFor(choice.series, 6);
    for (const [index, layout] of skeleton.entries()) expect(directive).toContain(`${index + 1}. ${layout}`);
    expect(directive).not.toContain("7.");
  });

  it("states the TRUNCATION rule, because the writer decides the slide count and the run does not", () => {
    // The run cannot know how long the post will be — §3 makes the count follow
    // the structure the writer finds. So the directive gives the order at full
    // length and says a shorter post is its PREFIX, which is what `skeletonFor`
    // does. Without this line the writer is free to pick out of the middle, and
    // two lengths of the same series stop looking like the same series.
    const directive = seriesDirective(choice, 8);
    expect(directive).toMatch(/take the FIRST slides of that order/u);
    expect(directive).toMatch(/Do not re-order and do not pick out of the middle/u);
    expect(directive).toContain("at the full 8 slides");
  });

  it("carries the premise and the register, because a skeleton with no instruction is a form to fill in", () => {
    const directive = seriesDirective(choice, 8);
    expect(directive).toContain(choice.series.premise);
    expect(directive).toContain(choice.series.register);
  });

  it("states that the per-archetype REQUIREMENTS still win over the skeleton", () => {
    // The safety argument for handing a writer a skeleton: the series
    // constrains the sequence, section 7 constrains the fit, and where they
    // disagree the fit wins — otherwise a `stat_callout` with no number
    // renders as a hole.
    expect(seriesDirective(choice, 8)).toMatch(/content cannot fill the layout it was given/u);
  });
});

/** A hand-built series, to prove the catalogue is a parameter rather than a hardcode. */
const CUSTOM: EditorialSeries = {
  id: "the_breakdown",
  badge: "custom",
  premise: "p",
  middle: ["photo", "photo", "photo", "photo", "photo", "photo"],
  register: "r".repeat(50),
};

describe("the catalogue is a parameter", () => {
  it("selects from the catalogue it is handed, so a per-client set can replace the bundled one without touching this module", () => {
    expect(selectSeries({ restsOnKinds: ["event"] }, [CUSTOM]).series.badge).toBe("custom");
  });
});
