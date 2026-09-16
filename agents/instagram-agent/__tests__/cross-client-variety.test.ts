import { describe, expect, it } from "vitest";
import { BUNDLED_SERIES, CROSS_CLIENT_SERIES_PENALTY, selectSeries, type SeriesEvidence } from "../src/workflow/editorial-series.js";
import {
  crossClientSeriesIds,
  crossClientSystemIds,
  CROSS_CLIENT_FORMAT_BELIEF_KEY,
  CROSS_CLIENT_HISTORY_LIMIT,
  EMPTY_CROSS_CLIENT_HISTORY,
  fallbackClientVisualSystem,
  pickVisualSystem,
  readCrossClientFormatHistory,
  recordCrossClientFormat,
  SYSTEM_CROSS_CLIENT_HOLD,
} from "../src/workflow/visual-system.js";

/**
 * Phase 5.5, item D2 — TWO CLIENTS MUST NOT LOOK LIKE ONE MACHINE.
 *
 * The owner's sharpest complaint about the 2026-09-16 batch was not that a
 * client repeated itself. It was that two different clients' posts, published
 * the same day for unrelated stories, were recognisably one system's output:
 * *"והכי גרוע שהפוסט הזה ושל KAROS LABS רואים שאותו AI ייצר אותו, אמרתי על
 * גיוון והכל"*.
 *
 * `skeleton-memory.ts` is per-CLIENT and structurally cannot see that —
 * karoslabs and thepitchbydeel both landed `by_the_numbers` and neither
 * client's own history said anything was wrong. This suite is the fleet-scoped
 * half: one agent-level belief holding the last twenty
 * `{ at, clientSlug, seriesId, systemId }` rows, a 2-point penalty on the
 * series and a hold on the system.
 *
 * ## The two properties that matter more than the penalty itself
 *
 * 1. **It must not override the evidence.** A story that genuinely is
 *    number-led still gets `by_the_numbers`. A variety rule that beats a real
 *    fit produces a worse post than the repetition it prevented.
 * 2. **It must fail open.** An absent, malformed or half-written belief means
 *    NO penalty — never a hold, never a throw. This is a nudge on a document
 *    nobody is required to have written yet.
 */

/** The live 2026-09-16 shape: two stat cards and the matching angle, which scored `by_the_numbers` 5 against `the_breakdown`'s standing 1. */
const NUMBER_LED: SeriesEvidence = { angleId: "surprising-number", restsOnKinds: ["stat", "stat", "definition"] };
/** A story with no signal at all: every format scores 0 except the standing default. */
const NO_SIGNAL: SeriesEvidence = { restsOnKinds: [] };

describe("the cross-client penalty pushes, and never shoves", () => {
  it("does NOT override a strong evidence fit — the live karoslabs scores, pinned", () => {
    const plain = selectSeries(NUMBER_LED);
    expect(plain.series.id).toBe("by_the_numbers");
    expect(plain.scores.by_the_numbers).toBe(5);
    expect(plain.scores.the_breakdown).toBe(1);

    const penalised = selectSeries({ ...NUMBER_LED, crossClientSeriesIds: ["by_the_numbers"] });
    // 5 - 2 = 3, still clear of the teardown's 1. If this ever flips, the
    // penalty has become a veto and a number-led story is being written as a
    // teardown for the sake of variety.
    expect(penalised.series.id).toBe("by_the_numbers");
    expect(penalised.crossClientPenalised).toEqual(["by_the_numbers"]);
    expect(penalised.reason).toContain(`-${CROSS_CLIENT_SERIES_PENALTY}`);
  });

  it("DOES decide the case where two formats are within a point of each other", () => {
    // The evidence-free run is exactly where two clients land on the same
    // format for no reason: every score is 0 except the standing default's 1.
    const plain = selectSeries(NO_SIGNAL);
    expect(plain.series.id).toBe("the_breakdown");
    const penalised = selectSeries({ ...NO_SIGNAL, crossClientSeriesIds: ["the_breakdown"] });
    expect(penalised.series.id).not.toBe("the_breakdown");
  });

  it("reports the raw story fit, not the penalised number — a reviewer reads what the STORY scored", () => {
    const penalised = selectSeries({ ...NUMBER_LED, crossClientSeriesIds: ["by_the_numbers"] });
    expect(penalised.scores.by_the_numbers).toBe(5);
  });

  it("a fleet with nothing recorded costs a run nothing", () => {
    expect(selectSeries({ ...NUMBER_LED, crossClientSeriesIds: [] })).toEqual(selectSeries(NUMBER_LED));
    expect(selectSeries({ ...NUMBER_LED, crossClientSeriesIds: undefined })).toEqual(selectSeries(NUMBER_LED));
  });

  it("never refuses a series, even with the whole catalogue penalised AND the client's own rotation held", () => {
    const everything = BUNDLED_SERIES.map((series) => series.id);
    const choice = selectSeries({ ...NO_SIGNAL, crossClientSeriesIds: everything, recentSeriesIds: everything });
    expect(choice.series.id.length).toBeGreaterThan(0);
  });
});

describe("three clients in sequence do not share a format", () => {
  it("consecutive clients on IDENTICAL evidence get different (series, system) pairs", () => {
    // The 2026-09-16 case, reproduced: three clients, one day, unrelated
    // stories that happen to score the same. Each one reads the belief the
    // previous one wrote.
    let history = EMPTY_CROSS_CLIENT_HISTORY;
    const shipped: { clientSlug: string; seriesId: string; systemId: string }[] = [];
    for (const clientSlug of ["karoslabs", "thepitchbydeel", "geektime"]) {
      const series = selectSeries({ ...NO_SIGNAL, crossClientSeriesIds: crossClientSeriesIds(history, clientSlug, 5) });
      const system = pickVisualSystem({
        clientSlug,
        // The SAME seed for all three, so nothing but the belief can separate
        // them: a test that varied the seed would pass on the hash alone.
        paletteSeed: "same-day",
        slideCount: 8,
        client: fallbackClientVisualSystem({ clientSlug: "shared-shape" }),
        seriesId: series.series.id,
        recentCrossClientSystemIds: crossClientSystemIds(history, clientSlug, SYSTEM_CROSS_CLIENT_HOLD),
      });
      shipped.push({ clientSlug, seriesId: series.series.id, systemId: system.systemId });
      history = recordCrossClientFormat(history, { at: `2026-09-16T0${shipped.length}:00:00Z`, clientSlug, seriesId: series.series.id, systemId: system.systemId });
    }
    const pairs = shipped.map((row) => `${row.seriesId}/${row.systemId}`);
    expect(new Set(pairs).size, `three clients shipped the same shape: ${pairs.join(", ")}`).toBe(3);
    // And the stronger claim: not even the series alone repeats inside a
    // single day's batch.
    expect(new Set(shipped.map((row) => row.seriesId)).size).toBe(3);
  });
});

describe("the fleet belief fails open in every direction", () => {
  it("an absent key reads as an empty history", () => {
    expect(readCrossClientFormatHistory(undefined)).toEqual({ version: 1, entries: [] });
    expect(readCrossClientFormatHistory({})).toEqual({ version: 1, entries: [] });
    expect(readCrossClientFormatHistory(null)).toEqual({ version: 1, entries: [] });
  });

  it("a malformed document reads as an empty history rather than throwing", () => {
    for (const malformed of ["a string", 42, [], { entries: "not an array" }, { entries: [null, 7, "x"] }]) {
      expect(() => readCrossClientFormatHistory({ [CROSS_CLIENT_FORMAT_BELIEF_KEY]: malformed })).not.toThrow();
      expect(readCrossClientFormatHistory({ [CROSS_CLIENT_FORMAT_BELIEF_KEY]: malformed }).entries).toEqual([]);
    }
  });

  it("ONE bad row does not take the rest of the fleet's history with it", () => {
    // A `safeParse` over the whole document would drop twenty good rows
    // because one was written by an older shape. Every row is parsed on its
    // own and a bad one is skipped.
    const history = readCrossClientFormatHistory({
      [CROSS_CLIENT_FORMAT_BELIEF_KEY]: {
        version: 1,
        entries: [
          { at: "2026-09-16T01:00:00Z", clientSlug: "a", seriesId: "field_notes", systemId: "quiet-rule" },
          { at: "2026-09-16T02:00:00Z", clientSlug: "b" },
          { at: "2026-09-16T03:00:00Z", clientSlug: "c", seriesId: "the_playbook", systemId: "ruled-object" },
        ],
      },
    });
    expect(history.entries).toHaveLength(2);
    expect(history.entries.map((entry) => entry.clientSlug)).toEqual(["a", "c"]);
  });

  it("an unreadable belief yields NO penalty and no hold", () => {
    const history = readCrossClientFormatHistory({ [CROSS_CLIENT_FORMAT_BELIEF_KEY]: "corrupt" });
    const choice = selectSeries({ ...NUMBER_LED, crossClientSeriesIds: crossClientSeriesIds(history, "karoslabs", 5) });
    expect(choice.crossClientPenalised).toEqual([]);
    expect(choice).toEqual(selectSeries(NUMBER_LED));
  });

  it("keeps only the last CROSS_CLIENT_HISTORY_LIMIT rows", () => {
    let history = EMPTY_CROSS_CLIENT_HISTORY;
    for (let i = 0; i < CROSS_CLIENT_HISTORY_LIMIT + 7; i++) {
      history = recordCrossClientFormat(history, { at: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`, clientSlug: `c${i}`, seriesId: "field_notes", systemId: "quiet-rule" });
    }
    expect(history.entries).toHaveLength(CROSS_CLIENT_HISTORY_LIMIT);
    expect(history.entries[0]!.clientSlug).toBe("c7");
  });
});

describe("only the shape travels — never a client's subject matter", () => {
  it("a recorded row carries four fields and no content", () => {
    const history = recordCrossClientFormat(EMPTY_CROSS_CLIENT_HISTORY, {
      at: "2026-09-16T00:00:00Z",
      clientSlug: "karoslabs",
      seriesId: "by_the_numbers",
      systemId: "ruled-object",
    });
    // A fleet-scoped document is exactly the place one client's topics must
    // not leak into, and the penalty this data buys does not need to know what
    // anybody wrote about.
    expect(Object.keys(history.entries[0]!).sort()).toEqual(["at", "clientSlug", "seriesId", "systemId"]);
  });

  it("the reader drops any extra field a future writer adds", () => {
    const history = readCrossClientFormatHistory({
      [CROSS_CLIENT_FORMAT_BELIEF_KEY]: {
        version: 1,
        entries: [{ at: "2026-09-16T00:00:00Z", clientSlug: "a", seriesId: "field_notes", systemId: "quiet-rule", topic: "a client's confidential angle" }],
      },
    });
    expect(Object.keys(history.entries[0]!).sort()).toEqual(["at", "clientSlug", "seriesId", "systemId"]);
  });

  it("a client never sees its OWN rows through the fleet lens — that is skeleton-memory's job and counting it twice would be a 5-point penalty", () => {
    const history = recordCrossClientFormat(EMPTY_CROSS_CLIENT_HISTORY, {
      at: "2026-09-16T00:00:00Z",
      clientSlug: "karoslabs",
      seriesId: "by_the_numbers",
      systemId: "ruled-object",
    });
    expect(crossClientSeriesIds(history, "karoslabs", 5)).toEqual([]);
    expect(crossClientSystemIds(history, "karoslabs", 5)).toEqual([]);
    expect(crossClientSeriesIds(history, "geektime", 5)).toEqual(["by_the_numbers"]);
  });
});
