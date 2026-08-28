import { describe, expect, it } from "vitest";
import { computeVisibilityMetrics } from "../src/visibility-metrics.js";
import { computeVisibilityIndex } from "../src/visibility-index.js";
import { evaluateScoreFamily, listInputKeys } from "../src/evaluate-scores.js";
import { GEO_READINESS_BUCKETS, SEO_BUCKETS } from "../src/scoring-config.js";
import { evaluateRecommendations, groupInputsByRecId } from "../src/recommend.js";
import { scoringConfigData } from "../src/config/scoring-config.data.js";
import type { InputMeasurement, SeoGeoCaptureCell } from "../src/types.js";

/**
 * ENGINE SELFTEST (SCRUM-318 / AU27).
 *
 * The v2 skill's own `assets/engine/selftest.py` could not be ported
 * verbatim — `Karos-Labs/karos-agents` is not reachable from this
 * environment (the checkout token authenticates to `agent-engine` and is
 * rejected for `karos-agents`), so its 132 assertions and its 6-engine
 * real-provider fixtures are unavailable here.
 *
 * What IS available is the same domain logic: `src/config/*.data.ts` are
 * byte-for-fidelity transcriptions of the lab-spec JSON assets (see each
 * file's header), and `visibility.metrics[].formula` in that config states
 * every visibility formula in words. This suite therefore asserts the
 * TypeScript port against those verbatim formula strings, quoting the
 * config line each assertion is derived from. That is what makes the port
 * verifiable rather than hopeful: a formula the port drifts from fails
 * here, loudly, with the config text in the failure message.
 */

/**
 * The verbatim `visibility.metrics[]` formula strings, keyed by the config's
 * own `id` (a rec_id — GEO-11, BOTH-14, ...), so assertions cite the config
 * rather than paraphrasing it.
 */
const METRIC_FORMULAS: Record<string, string> = Object.fromEntries(
  (scoringConfigData.visibility.metrics as ReadonlyArray<{ id: string; formula: string }>).map((m) => [m.id, m.formula]),
);

/**
 * Resolves a formula, THROWING if the config has no such entry. Without
 * this, a mis-keyed lookup yields `undefined`, vitest accepts `undefined` as
 * a message, and the whole citation harness degrades to decoration that can
 * never report a problem — the same "check incapable of failing" this suite
 * exists to catch. (It caught exactly that: these were first keyed by
 * `name`, a field `visibility.metrics[]` does not have.)
 */
function formula(recId: string): string {
  const text = METRIC_FORMULAS[recId];
  if (!text) throw new Error(`no visibility.metrics[] entry with id "${recId}" in scoring-config.data.ts`);
  return `${recId}: ${text}`;
}

describe("the formula-citation harness itself resolves", () => {
  it("every metric this suite cites exists in the config", () => {
    for (const recId of ["GEO-11", "BOTH-14", "GEO-27", "GEO-35", "GEO-26", "GEO-32", "GEO-36"]) {
      expect(formula(recId)).toContain(recId);
    }
    expect(() => formula("GEO-999")).toThrow();
  });
});

function cell(overrides: Partial<SeoGeoCaptureCell> & Pick<SeoGeoCaptureCell, "promptId">): SeoGeoCaptureCell {
  return {
    engine: "chatgpt",
    captureTier: "MEASURED",
    brandMentioned: false,
    brandCited: false,
    competitorsNamed: [],
    citations: [],
    mentionCounts: {},
    sentimentPerMention: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. share_of_voice — the LOCKED ROSTER is the denominator, not "whoever showed up"
// ---------------------------------------------------------------------------

describe("GEO-27 share_of_voice is scoped to the locked competitor roster", () => {
  /**
   * Config `visibility.metrics[] id=GEO-27` (share_of_voice):
   *   "SOV[b] = mentions(b) / sum_{b' in client+competitor_set} mentions(b') * 100;
   *    share_of_voice = SOV[client]; sums to 100 across locked roster"
   *
   * `competitor_set` is a FROZEN input — `reproducibility.hash_inputs`
   * carries `competitor_set_hash`, and `constants.roster_size_field` reads
   * `competitor_set_hash.roster_count`. So the denominator is the locked
   * roster, and a brand the model happened to name that is NOT on that
   * roster must not enter the sum.
   */
  const rosterCells = [
    cell({
      promptId: "p1",
      brandMentioned: true,
      brandFirstMentionCharOffset: 10,
      mentionCounts: { client: 5, competitorA: 5, someRandomBlog: 90 },
    }),
  ];

  it("ignores off-roster brands in the SOV denominator", () => {
    const metrics = computeVisibilityMetrics({
      cells: rosterCells,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    // client=5, competitorA=5 -> 5/10*100 = 50. `someRandomBlog` is off-roster and excluded.
    expect(metrics.shareOfVoiceClient, formula("GEO-27")).toBeCloseTo(50);
  });

  it("reports which off-roster brands it excluded rather than dropping them silently", () => {
    const metrics = computeVisibilityMetrics({
      cells: rosterCells,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    expect(metrics.rosterScoped).toBe(true);
    expect(metrics.offRosterBrandsIgnored).toEqual(["someRandomBlog"]);
  });

  it("SOV across the locked roster sums to 100", () => {
    const metrics = computeVisibilityMetrics({
      cells: rosterCells,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const total = Object.values(metrics.shareOfVoiceByBrand).reduce((sum, v) => sum + v, 0);
    expect(total, formula("GEO-27")).toBeCloseTo(100);
  });

  it("an EMPTY roster does not silently hand the client a free 100% — it falls back to observed brands and says so", () => {
    // Guard against fixing one can't-fail check by introducing another: with no locked
    // roster, scoping "to the roster" would mean scoping to {client} alone and SOV would
    // become structurally incapable of being anything but 100.
    const metrics = computeVisibilityMetrics({
      cells: rosterCells,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: [],
    });
    expect(metrics.rosterScoped).toBe(false);
    expect(metrics.shareOfVoiceClient).toBeCloseTo(5); // 5 / (5+5+90) * 100
    expect(metrics.shareOfVoiceClient).not.toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 2. BOTH-14 first_named — also scoped to the locked roster
// ---------------------------------------------------------------------------

describe("BOTH-14 first(p,e) compares the client against the locked roster only", () => {
  /**
   * Config `visibility.metrics[] id=BOTH-14` (who_ranks_first):
   *   "first(p,e) = max(first_named, first_cited); first_position_rate[e] = sum_p first / N;
   *    emit rank_first_competitor = argmax over competitor_set"
   *
   * "argmax over competitor_set" is explicit: the comparison set is the
   * locked roster. An off-roster brand mentioned earlier in the answer is
   * not a competitor and must not strip the client of first position, nor
   * can it ever be emitted as `rank_first_competitor`.
   */
  const offRosterFirst = [
    cell({
      promptId: "p1",
      brandMentioned: true,
      brandFirstMentionCharOffset: 100,
      competitorsNamed: [{ brandId: "someRandomBlog", charOffset: 5 }],
      mentionCounts: { client: 1, someRandomBlog: 1 },
    }),
  ];

  it("an off-roster brand named first does not cost the client first position", () => {
    const metrics = computeVisibilityMetrics({
      cells: offRosterFirst,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.firstPositionRate, formula("BOTH-14")).toBe(1);
  });

  it("an off-roster brand can never be emitted as rank_first_competitor", () => {
    const metrics = computeVisibilityMetrics({
      cells: offRosterFirst,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    expect(metrics.rankFirstCompetitor, formula("BOTH-14")).toBeNull();
  });

  it("an ON-roster brand named first still costs the client first position (the guard can fail)", () => {
    const metrics = computeVisibilityMetrics({
      cells: [
        cell({
          promptId: "p1",
          brandMentioned: true,
          brandFirstMentionCharOffset: 100,
          competitorsNamed: [{ brandId: "competitorA", charOffset: 5 }],
          mentionCounts: { client: 1, competitorA: 1 },
        }),
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.firstPositionRate).toBe(0);
    expect(metrics.rankFirstCompetitor).toBe("competitorA");
  });

  it("ties in rank_first_competitor break deterministically on brandId, not on capture order", () => {
    // `reproducibility.rule`: identical inputs must yield bit-identical outputs. Two
    // competitors tied on first-count must not resolve by whichever cell was seen first.
    const build = (order: readonly string[]) =>
      computeVisibilityMetrics({
        cells: order.map((brandId, i) =>
          cell({
            promptId: `p${i + 1}`,
            competitorsNamed: [{ brandId, charOffset: 5 }],
            mentionCounts: { [brandId]: 1 },
          }),
        ),
        promptCount: 2,
        clientDomains: ["client.com"],
        competitorRoster: ["zebra", "alpha"],
      });
    expect(build(["zebra", "alpha"]).rankFirstCompetitor).toBe("alpha");
    expect(build(["alpha", "zebra"]).rankFirstCompetitor).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// 3. ghost_citation_rate — both legs must mean the same thing by "cited"
// ---------------------------------------------------------------------------

describe("GEO-26 ghost_citation_rate uses one consistent definition of `cited`", () => {
  /**
   * Config `visibility.metrics[] id=GEO-26` (ghost_citation_rate):
   *   "ghost_citation_rate[e] = (sum_p cited - sum_p named_AND_cited)/max(sum_p cited,1) * 100"
   * and `visibility.metrics[] name=citation_share`:
   *   "citation_share[e] = (sum_p [client root domain in citations[p][e].domain]) / N"
   *
   * `cited(p,e)` is therefore "the client root domain appears in this
   * answer's citations". Both legs of the ghost formula must use that same
   * predicate; if `sum_p cited` counts a looser thing than `sum_p
   * named_AND_cited` does, the difference is non-zero for reasons that have
   * nothing to do with ghosting and the rate is inflated.
   */
  const ghostCells = [
    // Cited a THIRD-PARTY domain (not the client's) and also named the client.
    cell({
      promptId: "p1",
      brandMentioned: true,
      brandFirstMentionCharOffset: 10,
      brandCited: true,
      brandFirstCitationOrdinal: 1,
      citations: [{ domain: "someoneelse.com", ordinal: 1 }],
      mentionCounts: { client: 1 },
    }),
  ];

  it("a citation that is not the client's own domain is not a ghost citation", () => {
    const metrics = computeVisibilityMetrics({
      cells: ghostCells,
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: [],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    // Under the config's own definition of `cited`, sum_p cited = 0 here, so the rate is 0.
    expect(chatgpt.citationShare, formula("GEO-11")).toBe(0);
    expect(chatgpt.ghostCitationRate, formula("GEO-26")).toBe(0);
  });

  it("a real ghost — client domain cited but client never named — still reports 100 (the metric can fire)", () => {
    const metrics = computeVisibilityMetrics({
      cells: [
        cell({
          promptId: "p1",
          brandMentioned: false,
          brandCited: true,
          brandFirstCitationOrdinal: 1,
          citations: [{ domain: "client.com", ordinal: 1 }],
        }),
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: [],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.ghostCitationRate, formula("GEO-26")).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 4. gate_rule — a gate whose field was never measured must NOT pass
// ---------------------------------------------------------------------------

/** Every SEO + GEO Readiness input, measured at a value that would otherwise score full marks. */
function fullMarksMeasurements(buckets: typeof SEO_BUCKETS): Record<string, InputMeasurement> {
  const measurements: Record<string, InputMeasurement> = {};
  for (const bucket of buckets) {
    bucket.inputs.forEach((input, index) => {
      const key = `${bucket.name}[${index}]`;
      const p = input.params;
      let data: InputMeasurement["data"];
      switch (p.normalization) {
        case "boolean":
          data = { kind: "boolean", measured: true };
          break;
        case "count_with_target":
          data = { kind: "count", actual: (p.target ?? 1) * 10 };
          break;
        case "ratio_clamp":
          data = { kind: "ratio", value: (p.target ?? 1) * 10 };
          break;
        case "percentage":
          data = { kind: "percentage", valuePct: (p.target ?? 1) * 10 };
          break;
        case "lower_is_better_stepped":
          data = { kind: "stepped", value: 0 };
          break;
        case "multi_bool":
          data = { kind: "multiBool", subBools: [true, true, true] };
          break;
        case "combine":
          data = {
            kind: "combine",
            fields: Object.fromEntries(
              (p.legs ?? []).map((leg) => {
                if (leg.fn === "boolean") return [leg.field, true];
                // `lower_is_better_stepped` legs score best at the LOW end, every other leg at the high end.
                return [leg.field, leg.fn === "lower_is_better_stepped" ? 0 : 10_000];
              }),
            ),
          };
          break;
      }
      // Deliberately NO `gatePass` — this models a caller that measured the input
      // but never ran the gate check the config declares for it.
      measurements[key] = { data, coverage: "measured" };
    });
  }
  return measurements;
}

describe("gate_rule: an unverified gate fails closed", () => {
  /**
   * Config `normalization_fns.gate_rule`:
   *   "an input with a gate object: if gate.field is false, norm forced to
   *    gate.on_fail_norm (e.g. GEO-18 anti-stuffing forces 0); otherwise norm
   *    computed normally"
   * and GEO-18's own `measure`:
   *   "gated: norm = anti_stuffing_pass ? min(actual/15,1) : 0"
   *
   * `anti_stuffing_pass` is a ternary condition, and `grade_data_only_rule`
   * governs what an unmeasured condition is worth: inputs that do not trace
   * to real measured data are "excluded and shown as pending, never
   * guessed". An absent `gatePass` is an unmeasured condition. Treating it
   * as a pass makes the anti-stuffing gate structurally incapable of
   * failing for any caller that simply never supplies the field — the gate
   * has exactly one input value (`false`) that can fire it, and the far
   * commoner value (absent) silently grants full credit.
   */
  const geo18Key = listInputKeys(GEO_READINESS_BUCKETS).find((k) => k.recId === "GEO-18")!;

  it("GEO-18 scores 0 when anti_stuffing_pass was never measured, even with a passing raw count", () => {
    const measurements: Record<string, InputMeasurement> = {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 60 }, coverage: "measured" },
    };
    const result = evaluateScoreFamily(GEO_READINESS_BUCKETS, measurements);
    const geo18 = result.inputs.find((i) => i.inputKey === geo18Key.inputKey)!;
    expect(geo18.norm).toBe(0);
    expect(geo18.points).toBe(0);
  });

  it("reports the gate state honestly as `unverified`, distinct from an explicit failure", () => {
    const unverified = evaluateScoreFamily(GEO_READINESS_BUCKETS, {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 60 }, coverage: "measured" },
    }).inputs.find((i) => i.inputKey === geo18Key.inputKey)!;
    const failed = evaluateScoreFamily(GEO_READINESS_BUCKETS, {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 60 }, coverage: "measured", gatePass: false },
    }).inputs.find((i) => i.inputKey === geo18Key.inputKey)!;
    const passed = evaluateScoreFamily(GEO_READINESS_BUCKETS, {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 60 }, coverage: "measured", gatePass: true },
    }).inputs.find((i) => i.inputKey === geo18Key.inputKey)!;

    expect(unverified.gateState).toBe("unverified");
    expect(failed.gateState).toBe("failed");
    expect(passed.gateState).toBe("pass");
    expect(passed.norm).toBe(1); // the gate CAN pass — this is not a check that always fails
  });

  it("`gated` fires even when the pre-gate norm already equalled on_fail_norm", () => {
    // The old flag was `gateResult !== norm`, so a gate that failed an input whose raw
    // norm was already 0 reported `gated: false` — an indicator incapable of firing in
    // precisely the case an auditor most wants to see it.
    const zeroCount = evaluateScoreFamily(GEO_READINESS_BUCKETS, {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 0 }, coverage: "measured", gatePass: false },
    }).inputs.find((i) => i.inputKey === geo18Key.inputKey)!;
    expect(zeroCount.norm).toBe(0);
    expect(zeroCount.gated).toBe(true);
    expect(zeroCount.gateState).toBe("failed");
  });

  it("an ungated input never claims a gate state", () => {
    const measurements = fullMarksMeasurements(GEO_READINESS_BUCKETS);
    const evaluated = evaluateScoreFamily(GEO_READINESS_BUCKETS, measurements).inputs;
    const ungated = evaluated.filter((i) => i.inputKey !== geo18Key.inputKey);
    expect(ungated.length).toBeGreaterThan(0);
    expect(ungated.every((i) => i.gateState === "none")).toBe(true);
    expect(ungated.every((i) => i.gated === false)).toBe(true);
  });

  /** Every config input that declares a `gate` block, and the total weight they carry. */
  const gatedWeight = GEO_READINESS_BUCKETS.reduce(
    (sum, bucket) => sum + bucket.inputs.reduce((t, input) => t + (input.gate ? input.weight : 0), 0),
    0,
  );

  it("the GEO Readiness config really does declare at least one gate (else this whole section proves nothing)", () => {
    expect(gatedWeight).toBeGreaterThan(0);
  });

  it("a full-marks run that never ran its gate checks scores exactly the gated weight below the same run with them verified", () => {
    const unverified = fullMarksMeasurements(GEO_READINESS_BUCKETS);
    const verified = fullMarksMeasurements(GEO_READINESS_BUCKETS);
    GEO_READINESS_BUCKETS.forEach((bucket) => {
      bucket.inputs.forEach((input, index) => {
        if (input.gate) verified[`${bucket.name}[${index}]`]!.gatePass = true;
      });
    });

    const unverifiedRun = evaluateScoreFamily(GEO_READINESS_BUCKETS, unverified);
    const verifiedRun = evaluateScoreFamily(GEO_READINESS_BUCKETS, verified);

    // Both runs measured every input, so `grade_data_only_rule` flags neither as partial...
    expect(unverifiedRun.dataCoveragePct).toBe(100);
    expect(verifiedRun.dataCoveragePct).toBe(100);
    // ...and the ONLY difference between them is whether the declared gates were run.
    expect(verifiedRun.score - unverifiedRun.score).toBe(gatedWeight);
  });

  it("an unverified gate makes its rec fire, exactly as an explicit failure does", () => {
    // `trigger.fires_when`: FIRE if min(norm) < 1.0. A silently-passed gate suppressed
    // the GEO-18 recommendation entirely — the rec was unreachable for such callers.
    const inputs = evaluateScoreFamily(GEO_READINESS_BUCKETS, {
      [geo18Key.inputKey]: { data: { kind: "count", actual: 60 }, coverage: "measured" },
    }).inputs.filter((i) => i.inputKey === geo18Key.inputKey);
    const fired = evaluateRecommendations(groupInputsByRecId(inputs));
    expect(fired.map((f) => f.recId)).toContain("GEO-18");
    expect(fired.find((f) => f.recId === "GEO-18")!.fireState).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// 5. Structural invariants that must hold for the port to be a port at all
// ---------------------------------------------------------------------------

describe("port structural invariants", () => {
  it("every SEO and GEO Readiness bucket set sums to weight_total 100", () => {
    expect(SEO_BUCKETS.reduce((s, b) => s + b.inputs.reduce((t, i) => t + i.weight, 0), 0)).toBe(
      scoringConfigData.scores.seo.weight_total,
    );
    expect(GEO_READINESS_BUCKETS.reduce((s, b) => s + b.inputs.reduce((t, i) => t + i.weight, 0), 0)).toBe(
      scoringConfigData.scores.geo_readiness.weight_total,
    );
  });

  it("the Visibility Index is reproducible: identical metrics give a bit-identical integer", () => {
    const make = () =>
      computeVisibilityMetrics({
        cells: [
          cell({
            promptId: "p1",
            brandMentioned: true,
            brandFirstMentionCharOffset: 10,
            brandCited: true,
            brandFirstCitationOrdinal: 1,
            citations: [{ domain: "client.com", ordinal: 1 }],
            mentionCounts: { client: 3, competitorA: 1 },
            sentimentPerMention: [{ mentionIndex: 0, label: "pos" }],
          }),
        ],
        promptCount: 1,
        clientDomains: ["client.com"],
        competitorRoster: ["competitorA"],
      });
    expect(computeVisibilityIndex(make()).index).toBe(computeVisibilityIndex(make()).index);
  });
});
