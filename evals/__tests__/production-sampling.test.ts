import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLING_POLICY,
  labelProductionDraft,
  ProductionDraftRecordSchema,
  revisionDivergence,
  sampleProductionDrafts,
  samplingBucket,
  shouldSampleProductionDraft,
  toJudgeCase,
  type ProductionDraftRecord,
} from "../src/production-sampling.js";

function record(overrides: Partial<ProductionDraftRecord> = {}): ProductionDraftRecord {
  return ProductionDraftRecordSchema.parse({
    runId: "pubsub-21091607732714829",
    clientId: "acme",
    agentId: "linkedin-agent",
    language: "en",
    platform: "linkedin",
    firstDraft: "Teams with a fixed two-day in-office schedule reported fewer scheduling conflicts.",
    finalOutput: "Teams with a fixed two-day in-office schedule reported fewer scheduling conflicts.",
    revision: 0,
    notes: [],
    decidedAt: "2026-08-28T11:04:00.000Z",
    decidedBy: "tomer@karoslabs.com",
    ...overrides,
  });
}

describe("labelProductionDraft", () => {
  it("labels an untouched approval approved_as_drafted", () => {
    expect(labelProductionDraft(record())).toBe("approved_as_drafted");
  });

  it("labels a draft that went round the revision loop revised", () => {
    const revised = record({
      revision: 2,
      notes: [{ revision: 1, actor: "tomer", at: "2026-08-28T10:00:00.000Z", feedback: "shorter hook" }],
      finalOutput: "Fixed anchor days cut scheduling conflicts.",
    });
    expect(labelProductionDraft(revised)).toBe("revised");
  });

  it("labels a hand-edited approval revised even though the revision counter is 0", () => {
    // `GateResponse.edits` — a reviewer changing the text in place and then
    // approving. Reading only `revision` would file this under "the agent got
    // it right first time", which is exactly backwards as a training signal.
    expect(labelProductionDraft(record({ revision: 0, finalOutput: "Anchor days cut scheduling conflicts." }))).toBe("revised");
  });
});

describe("revisionDivergence", () => {
  it("is 0 for text nobody touched", () => {
    expect(revisionDivergence(record())).toBe(0);
  });

  it("grows with how much of the vocabulary changed", () => {
    const light = revisionDivergence(record({ finalOutput: "Teams with a fixed two-day in-office schedule reported fewer calendar conflicts." }));
    const heavy = revisionDivergence(record({ finalOutput: "Anchor days. Try them." }));
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBeLessThanOrEqual(1);
  });

  it("works on Hebrew, where a \\w-based tokenizer would report no words at all", () => {
    const hebrew = record({
      language: "he",
      firstDraft: "צוותים עם שני ימי משרד קבועים דיווחו על פחות התנגשויות ביומן",
      finalOutput: "צוותים עם ימי עוגן קבועים דיווחו על פחות התנגשויות",
    });
    expect(revisionDivergence(hebrew)).toBeGreaterThan(0);
    expect(revisionDivergence(hebrew)).toBeLessThan(1);
  });
});

describe("sampling is deterministic in the run id", () => {
  it("gives the same bucket for the same run, every time and in every process", () => {
    expect(samplingBucket("pubsub-21091607732714829")).toBe(samplingBucket("pubsub-21091607732714829"));
    expect(samplingBucket("pubsub-21091607732714829")).toBeGreaterThanOrEqual(0);
    expect(samplingBucket("pubsub-21091607732714829")).toBeLessThan(1);
  });

  it("gives different buckets for different runs, and for the same run under a different salt", () => {
    expect(samplingBucket("run-a")).not.toBe(samplingBucket("run-b"));
    expect(samplingBucket("run-a", "2026-w35")).not.toBe(samplingBucket("run-a"));
  });

  it("selects roughly the configured share of approvals across a realistic population", () => {
    const approvals = Array.from({ length: 2_000 }, (_, i) => record({ runId: `run-${i}` }));
    const selected = approvals.filter((r) => shouldSampleProductionDraft(r, { rate: 0.05, alwaysSampleRevised: false }));
    // 5% of 2,000 is 100. A hash is not a uniform generator, so this asserts
    // the order of magnitude, not the exact count.
    expect(selected.length).toBeGreaterThan(60);
    expect(selected.length).toBeLessThan(150);
  });

  it("takes every revised draft regardless of rate, because revisions are the scarce, informative class", () => {
    const revisions = Array.from({ length: 50 }, (_, i) =>
      record({ runId: `rev-${i}`, revision: 1, finalOutput: "Anchor days cut conflicts." }),
    );
    expect(revisions.every((r) => shouldSampleProductionDraft(r, DEFAULT_SAMPLING_POLICY))).toBe(true);
    // …and honours an explicit opt-out.
    expect(revisions.filter((r) => shouldSampleProductionDraft(r, { rate: 0, alwaysSampleRevised: false }))).toHaveLength(0);
  });
});

describe("toJudgeCase", () => {
  it("scores the SHIPPED text, with the agent's own draft as the reference when a person changed it", () => {
    const revised = record({
      revision: 1,
      finalOutput: "Anchor days cut scheduling conflicts.",
      notes: [{ revision: 1, actor: "tomer", at: "2026-08-28T10:00:00.000Z", feedback: "shorter hook, drop the preamble" }],
    });
    const judgeCase = toJudgeCase(revised);

    expect(judgeCase.output).toBe("Anchor days cut scheduling conflicts.");
    expect(judgeCase.reference).toBe(revised.firstDraft);
    expect(judgeCase.notes).toContain("shorter hook, drop the preamble");
    expect(judgeCase.caseId).toBe("pubsub-21091607732714829:production-sample");
  });

  it("carries no reference for an untouched approval — draft and shipped text are the same artifact", () => {
    expect(toJudgeCase(record()).reference).toBeUndefined();
  });

  it("carries the client's language through, so a sampled Hebrew run is judged as Hebrew", () => {
    expect(toJudgeCase(record({ language: "he" })).language).toBe("he");
  });
});

describe("sampleProductionDrafts", () => {
  it("returns the selected records as ready-to-judge samples, labelled and measured", () => {
    const population = [
      record({ runId: "approved-1" }),
      record({ runId: "revised-1", revision: 1, finalOutput: "Anchor days cut scheduling conflicts." }),
    ];
    const samples = sampleProductionDrafts(population, { rate: 0, alwaysSampleRevised: true });

    expect(samples).toHaveLength(1);
    expect(samples[0]!.label).toBe("revised");
    expect(samples[0]!.divergence).toBeGreaterThan(0);
    expect(samples[0]!.judgeCase.agentId).toBe("linkedin-agent");
  });
});
