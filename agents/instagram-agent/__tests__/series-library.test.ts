import { describe, expect, it } from "vitest";
import {
  BUNDLED_SERIES,
  LIBRARY_ANCHOR,
  MAX_CLIENT_LIBRARY,
  MIN_CLIENT_LIBRARY,
  selectSeries,
  seriesLibraryFor,
} from "../src/workflow/editorial-series.js";

/**
 * Phase 5.6, item C3.
 *
 * The property being bought is the owner's own sentence about two finished
 * posts: *you can see the same AI made both.* Six series shared by every
 * client is the mechanism that made that true, and the assertions below are
 * about the mechanism being gone rather than about any particular library.
 */

const CLIENTS = ["karoslabs", "geektime", "thepitchbydeel", "acme", "northwind", "kestrel"];

describe("seriesLibraryFor — each client runs its own three to five", () => {
  it("gives every client a library inside the specification's bounds", () => {
    for (const clientSlug of CLIENTS) {
      const { series } = seriesLibraryFor({ clientSlug });
      expect(series.length, clientSlug).toBeGreaterThanOrEqual(MIN_CLIENT_LIBRARY);
      expect(series.length, clientSlug).toBeLessThanOrEqual(MAX_CLIENT_LIBRARY);
    }
  });

  it("is STABLE: the same client gets the same library every run, which is what makes a feed read as one system", () => {
    for (const clientSlug of CLIENTS) {
      const a = seriesLibraryFor({ clientSlug, segments: ["b2b saas"] });
      const b = seriesLibraryFor({ clientSlug, segments: ["b2b saas"] });
      expect(a.series.map((s) => s.id), clientSlug).toEqual(b.series.map((s) => s.id));
    }
  });

  it("two clients do NOT get the same library — the defect this exists to close", () => {
    const libraries = CLIENTS.map((clientSlug) => seriesLibraryFor({ clientSlug }).series.map((s) => s.id).join(","));
    expect(new Set(libraries).size, `libraries: ${libraries.join(" | ")}`).toBeGreaterThan(1);
  });

  it("two clients of the SAME SIZE and the SAME segment still hold different series", () => {
    // The sharp version, and the reason it is written this way: a first draft
    // compared two arbitrary slugs and passed because their libraries were
    // different LENGTHS. That assertion held with the per-client shuffle
    // deleted — it was testing the size seed, not the content. Finding a
    // same-size pair is what makes this about the shuffle.
    const slugs = Array.from({ length: 60 }, (_, i) => `client-${i}`);
    const libraries = slugs.map((clientSlug) => ({
      clientSlug,
      ids: seriesLibraryFor({ clientSlug, segments: ["b2b saas platform"] }).series.map((s) => s.id),
    }));

    const pair = libraries.flatMap((left, i) =>
      libraries.slice(i + 1).filter((right) => right.ids.length === left.ids.length).map((right) => [left, right] as const),
    );
    expect(pair.length, "no two of sixty clients share a library size — the sample cannot test content").toBeGreaterThan(0);

    const differing = pair.filter(([left, right]) => left.ids.join(",") !== right.ids.join(","));
    expect(
      differing.length,
      "every same-size pair holds the same series, so only the SIZE varies per client and the feed still repeats",
    ).toBeGreaterThan(0);
  });

  it("ALWAYS carries the anchor, or an evidence-free run picks among zeroes by array order", () => {
    for (const clientSlug of [...CLIENTS, "", "a", "zzzzzzzzzzzz"]) {
      expect(seriesLibraryFor({ clientSlug }).series.map((s) => s.id), clientSlug).toContain(LIBRARY_ANCHOR);
    }
  });

  it("never repeats a series inside one library", () => {
    for (const clientSlug of CLIENTS) {
      const ids = seriesLibraryFor({ clientSlug }).series.map((s) => s.id);
      expect(new Set(ids).size, clientSlug).toBe(ids.length);
    }
  });

  it("only ever returns series the repo already renders", () => {
    const known = new Set(BUNDLED_SERIES.map((s) => s.id));
    for (const clientSlug of CLIENTS) {
      for (const s of seriesLibraryFor({ clientSlug }).series) expect(known).toContain(s.id);
    }
  });
});

describe("seriesLibraryFor — the segment leans, it does not decide", () => {
  it("leans a regulated business towards figures and rules", () => {
    // Asserted across several slugs: one slug passing could be the shuffle.
    const withAffinity = CLIENTS.map((clientSlug) => seriesLibraryFor({ clientSlug, segments: ["financial compliance"] }).series.map((s) => s.id));
    const carries = withAffinity.filter((ids) => ids.includes("by_the_numbers") || ids.includes("the_playbook")).length;
    expect(carries, `libraries: ${withAffinity.map((i) => i.join("+")).join(" | ")}`).toBe(CLIENTS.length);
  });

  it("leans an agency towards what people said and what happened", () => {
    const withAffinity = CLIENTS.map((clientSlug) => seriesLibraryFor({ clientSlug, segments: ["marketing agency"] }).series.map((s) => s.id));
    const carries = withAffinity.filter((ids) => ids.includes("in_their_words") || ids.includes("field_notes")).length;
    expect(carries).toBe(CLIENTS.length);
  });

  it("says in one sentence which shapes this client runs and on what basis", () => {
    const steered = seriesLibraryFor({ clientSlug: "acme", segments: ["b2b saas"] });
    // The reported token is what the row MATCHED, which for "b2b saas" is
    // "b2b" — the first alternative present in the string, not the one a
    // reader would have named. Asserted as written rather than as expected,
    // because a sentence on a gate payload has to say what actually happened.
    expect(steered.rule).toContain("b2b");
    expect(steered.rule).toContain(steered.series[0]!.id);
    const unsteered = seriesLibraryFor({ clientSlug: "acme", segments: ["something nobody has a row for"] });
    expect(unsteered.rule).toContain("named no segment this recognises");
  });

  it("does not fall over on a brief that names nothing at all", () => {
    expect(seriesLibraryFor({ clientSlug: "acme" }).series.length).toBeGreaterThanOrEqual(MIN_CLIENT_LIBRARY);
    expect(seriesLibraryFor({ clientSlug: "acme", segments: [] }).series.length).toBeGreaterThanOrEqual(MIN_CLIENT_LIBRARY);
  });
});

describe("a library is a catalogue selectSeries can actually run on", () => {
  it("still returns a series the library contains, for evidence that fits and evidence that does not", () => {
    for (const clientSlug of CLIENTS) {
      const { series } = seriesLibraryFor({ clientSlug, segments: ["b2b saas"] });
      const ids = new Set(series.map((s) => s.id));

      const fitting = selectSeries({ angleId: "surprising-number", restsOnKinds: ["stat", "stat", "stat"] }, series);
      expect(ids, `${clientSlug} on a number-led story`).toContain(fitting.series.id);

      const bare = selectSeries({ restsOnKinds: [] }, series);
      expect(ids, `${clientSlug} on no evidence at all`).toContain(bare.series.id);
      // …and with nothing to go on it is the anchor, not array order.
      expect(bare.series.id, clientSlug).toBe(LIBRARY_ANCHOR);
    }
  });

  it("a story whose shape is absent from the library still gets a rendered answer rather than nothing", () => {
    // `head_to_head` is the one series with a structural gate, so a library
    // without it is the sharpest version of this case.
    const without = BUNDLED_SERIES.filter((s) => s.id !== "head_to_head");
    const choice = selectSeries({ angleId: "wrong-assumption", comparedEntities: 2 }, without);
    expect(choice.series.id).not.toBe("head_to_head");
    expect(BUNDLED_SERIES.map((s) => s.id)).toContain(choice.series.id);
  });
});
