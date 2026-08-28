import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCostAndTokens } from "../src/span-helpers.js";
import { __resetBigQueryClient } from "../src/bigquery-client.js";
import { trace } from "@opentelemetry/api";

/**
 * SCRUM-361 item 3, precondition 1: `servedBy.hop` and the serving adapter
 * must reach `agent_runs_bi` as COLUMNS.
 *
 * ## Why this is a real check and not a tautology
 *
 * The row literal in `insertAgentRunRow` is the only place the engine decides
 * what a BI row contains, and `table.insert` is called with
 * `ignoreUnknownValues: true` — so a key that is missing from the literal is
 * not an error anywhere: the insert succeeds, the column reads NULL, and the
 * reconciliation silently compares Anthropic-billed spend against a Google
 * bill. That is exactly how `operation`, `jobId`, `stepId` and `source` were
 * discarded on every insert for months (quality.yml:66-73).
 *
 * So this test captures the row that is actually handed to `table.insert` and
 * asserts the two keys are present WITH their values. It fails on the code as
 * it stands (the keys do not exist), and the only way to make it pass is to
 * put them in the literal.
 *
 * ## What makes it fail
 *
 * Delete either key from the row literal in `span-helpers.ts`, or rename it,
 * and the corresponding assertion below reads `undefined`. Drop the
 * `?? null` normalisation and the "absent means primary" test reads
 * `undefined` rather than `null`, which is a different thing in a BigQuery
 * insert.
 *
 * ## What this does NOT prove
 *
 * That the columns exist in the live BigQuery table. They are declared in
 * karos-portal's `deploy/bootstrap-bi-telemetry-gcp.sh`, and this container
 * has no GCP credential, so `npm run check:bq-schema` is advisory here
 * (UNREACHABLE, not "pass"). See the report.
 */

interface CapturedInsert {
  rows: Record<string, unknown>[];
  options: unknown;
}

const inserts: CapturedInsert[] = [];

vi.mock("@google-cloud/bigquery", () => ({
  BigQuery: class {
    constructor(_opts: { projectId: string }) {}
    dataset(_id: string) {
      return {
        table: (_t: string) => ({
          insert: async (rows: Record<string, unknown>[], options: unknown) => {
            inserts.push({ rows, options });
          },
        }),
      };
    }
  },
}));

const ORIGINAL = { ...process.env };

beforeEach(() => {
  inserts.length = 0;
  __resetBigQueryClient();
  process.env.BQ_PROJECT_ID = "karoscmo-prep";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetBigQueryClient();
});

const BASE = {
  runId: "pubsub-21091607732714829",
  clientId: "acme",
  agentId: "instagram",
  model: "claude-sonnet-4-6",
  costUsd: 0.280324,
  inputTokensCached: 20_000,
  inputTokensUncached: 7_233,
  outputTokens: 8_280,
  durationMs: 4_120,
  status: "completed",
  jobId: "pubsub-21091607732714829",
  stepId: "08b-visual-qa-attempt-2",
  operation: "workflow_step_agent",
};

/**
 * `recordCostAndTokens` fires the insert with `void` — deliberately, so
 * telemetry never blocks the run it describes. Two macrotask turns is enough
 * for the dynamic `import()` inside `getBigQuery()` plus the awaited insert;
 * the assertion on `inserts.length` below is what actually proves the
 * intervention ran, rather than assuming it did.
 */
async function settleInsert(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function insertedRow(attrs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const span = trace.getTracer("test").startSpan("test");
  // Not a fresh object literal at the call site, so TypeScript's excess-property
  // check does not fire — this test type-checks both before and after the
  // change, which is what lets it fail on an ASSERTION rather than on tsc.
  recordCostAndTokens(span, attrs as never);
  await settleInsert();
  expect(inserts.length, "the insert must actually have run — an unrun check produces no evidence").toBe(1);
  expect(inserts[0]!.rows.length).toBe(1);
  return inserts[0]!.rows[0]!;
}

describe("agent_runs_bi row: servedByHop / servingAdapter (SCRUM-361 item 3 precondition)", () => {
  it("carries the fallback hop and the adapter that answered, so Anthropic-billed rows are separable", async () => {
    const row = await insertedRow({ ...BASE, servedByHop: "secondary", servingAdapter: "anthropic" });

    expect(row["servedByHop"]).toBe("secondary");
    expect(row["servingAdapter"]).toBe("anthropic");
    // Guards against a partial fix that adds the column but loses the value.
    expect(row["model"]).toBe("claude-sonnet-4-6");
    expect(row["costUsd"]).toBe(0.280324);
  });

  it("carries the tertiary hop, where the adapter is a different vendor entirely", async () => {
    const row = await insertedRow({ ...BASE, servedByHop: "tertiary", servingAdapter: "google-gemini" });

    expect(row["servedByHop"]).toBe("tertiary");
    expect(row["servingAdapter"]).toBe("google-gemini");
  });

  it("writes NULL, not undefined, when nothing failed over — the common case", async () => {
    const row = await insertedRow({ ...BASE });

    // `undefined` and `null` are not the same to a BigQuery insert, and the
    // reconciliation query's `servedByHop IS NULL OR servedByHop = 'primary'`
    // filter is written against NULL.
    expect(row).toHaveProperty("servedByHop");
    expect(row).toHaveProperty("servingAdapter");
    expect(row["servedByHop"]).toBeNull();
    expect(row["servingAdapter"]).toBeNull();
  });

  it("still inserts with ignoreUnknownValues — which is exactly why the keys must be asserted here", async () => {
    await insertedRow({ ...BASE, servedByHop: "secondary", servingAdapter: "anthropic" });

    expect(inserts[0]!.options).toEqual({ ignoreUnknownValues: true, skipInvalidRows: false });
  });
});
