import { describe, expect, it } from "vitest";
import { CAMPAIGN_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runCampaignDeterministicAssertions } from "./src/run-assertions.js";

describe("Campaign orchestrator golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(CAMPAIGN_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of CAMPAIGN_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed plan passes every structural check`, () => {
      const results = runCampaignDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, () => {
      const first = runCampaignDeterministicAssertions(goldenRun);
      const second = runCampaignDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a missing channel fails channel-coverage", () => {
    const goldenRun = CAMPAIGN_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, channelSlots: goldenRun.endorsedOutput.channelSlots.slice(0, 4) } };

    const results = runCampaignDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "channel-coverage")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: a duplicated slotId fails slotId-uniqueness", () => {
    const goldenRun = CAMPAIGN_GOLDEN_RUNS[0]!;
    const slots = goldenRun.endorsedOutput.channelSlots;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, channelSlots: [...slots, { ...slots[0]!, channel: "newsletter" as const }] },
    };

    const results = runCampaignDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "slotId-uniqueness")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: a keyMessage that just restates the theme fails key-message-discipline", () => {
    const goldenRun = CAMPAIGN_GOLDEN_RUNS[0]!;
    const slots = goldenRun.endorsedOutput.channelSlots;
    const regressed = {
      ...goldenRun,
      endorsedOutput: {
        ...goldenRun.endorsedOutput,
        channelSlots: [{ ...slots[0]!, keyMessage: goldenRun.endorsedOutput.theme }, ...slots.slice(1)],
      },
    };

    const results = runCampaignDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "key-message-discipline")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: two slots sharing the same targetAudience fails audience-segmentation", () => {
    const goldenRun = CAMPAIGN_GOLDEN_RUNS[0]!;
    const slots = goldenRun.endorsedOutput.channelSlots;
    const regressed = {
      ...goldenRun,
      endorsedOutput: {
        ...goldenRun.endorsedOutput,
        channelSlots: [{ ...slots[0]!, targetAudience: slots[1]!.targetAudience }, ...slots.slice(1)],
      },
    };

    const results = runCampaignDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "audience-segmentation")!;
    expect(check.verdict).toBe("content_fail");
  });
});
