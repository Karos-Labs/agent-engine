import { describe, expect, it } from "vitest";
import { TriageConfigSchema, TriageToolInputSchema } from "../src/triage/schemas.js";
import { createReputationTriage } from "../src/triage/triage-tool.js";
import { DEFAULT_TRIAGE_CONFIG } from "../src/triage/config.js";
import type { TriagePayload } from "../src/triage/types.js";

/** A minimal, otherwise-valid config override, missing only `platform_visibility.default`. */
function configMissingDefault() {
  const { default: _omit, ...rest } = DEFAULT_TRIAGE_CONFIG.value_signals.platform_visibility;
  return {
    ...DEFAULT_TRIAGE_CONFIG,
    value_signals: { ...DEFAULT_TRIAGE_CONFIG.value_signals, platform_visibility: rest },
  };
}

const emptyPayload: TriagePayload = {
  now: "2026-08-15T00:00:00Z",
  reviews: [],
  already_responded_ids: [],
  seen_review_ids: [],
  alerted_crisis_signatures: [],
  baseline_rating_avg: {},
};

describe("TriageConfigSchema.value_signals.platform_visibility (a triage-config-hardening audit finding)", () => {
  it("rejects a per-client config override that omits the required 'default' key", () => {
    const parsed = TriageConfigSchema.safeParse(configMissingDefault());
    expect(parsed.success).toBe(false);
  });

  it("still accepts arbitrary additional platform keys alongside the required default", () => {
    const parsed = TriageConfigSchema.safeParse({
      ...DEFAULT_TRIAGE_CONFIG,
      value_signals: { ...DEFAULT_TRIAGE_CONFIG.value_signals, platform_visibility: { default: 0, google: 10, yelp: 8, appstore: 5 } },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the real DEFAULT_TRIAGE_CONFIG unchanged", () => {
    expect(TriageConfigSchema.safeParse(DEFAULT_TRIAGE_CONFIG).success).toBe(true);
  });
});

describe("reputation.triage tool input validation", () => {
  it("rejects a call whose config override omits platform_visibility.default with tooling_error, never NaN-scored routing", async () => {
    const tool = createReputationTriage();
    const outcome = await tool.execute(
      { payload: emptyPayload, config: configMissingDefault() as never },
      { ctx: { runId: "run_1", clientSlug: "acme", productId: "reputation-agent", runKind: "recurring", metadata: {} } },
    );
    expect(outcome.status).toBe("tooling_error");
  });

  it("still parses successfully via the full tool input schema when default is present", () => {
    const parsed = TriageToolInputSchema.safeParse({ payload: emptyPayload, config: DEFAULT_TRIAGE_CONFIG });
    expect(parsed.success).toBe(true);
  });
});
