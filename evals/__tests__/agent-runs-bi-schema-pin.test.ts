import { describe, expect, it } from "vitest";
import { insertRowFields } from "../../scripts/check-bq-insert-schema.js";
import { AGENT_RUNS_BI_COLUMNS, AgentRunsBiRowSchema } from "../src/persistence/agent-runs-bi-row.js";

/**
 * SCRUM-308 / AU25: the eval ladder's notion of the `agent_runs_bi` row shape
 * must be the ENGINE's notion of it, not a copy.
 *
 * `insertRowFields()` parses the object literal handed to `table.insert(...)`
 * in `packages/telemetry/src/span-helpers.ts` — the single place the engine
 * decides what a BI row contains, and the same function
 * `npm run check:bq-schema` uses to compare that literal against the live
 * table. Reusing it here means there is exactly one hand-maintained field list
 * in the repo, and this test is what stops a second one from drifting away
 * from it in either direction.
 *
 * Set equality both ways, not "contains": a column the ladder writes that the
 * engine does not is a column the live table may not have (silently dropped
 * on insert, because `ignoreUnknownValues: true`), and a column the engine
 * writes that the ladder does not know about is a column the fake would
 * reject on a row that production accepts.
 */
describe("agent_runs_bi column list is pinned to the engine's own insert literal", () => {
  const engineFields = insertRowFields();

  it("parses a non-empty field list out of span-helpers.ts", () => {
    // Guards the guard: `insertRowFields` throws if its anchor moves, but a
    // silently-empty result would make every comparison below vacuous.
    expect(engineFields.length).toBeGreaterThan(0);
    expect(engineFields).toContain("runId");
    expect(engineFields).toContain("source");
  });

  it("AGENT_RUNS_BI_COLUMNS is exactly the set the engine inserts", () => {
    expect([...AGENT_RUNS_BI_COLUMNS].sort()).toEqual([...engineFields].sort());
  });

  it("AgentRunsBiRowSchema's keys are exactly the same set", () => {
    expect(Object.keys(AgentRunsBiRowSchema.shape).sort()).toEqual([...engineFields].sort());
  });

  it("keeps the engine's own insertion order, so the generated read-back projection matches the row literal", () => {
    expect([...AGENT_RUNS_BI_COLUMNS]).toEqual(engineFields);
  });
});
