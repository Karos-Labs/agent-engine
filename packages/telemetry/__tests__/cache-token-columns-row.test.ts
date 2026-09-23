import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCostAndTokens } from "../src/span-helpers.js";
import { __resetBigQueryClient } from "../src/bigquery-client.js";
import { trace } from "@opentelemetry/api";

/**
 * `agent_runs_bi` has three cache columns, and nothing ever filled them.
 *
 * `inputTokensCached`, `inputTokensUncached` and `inputTokensCacheWrite` have
 * been in that table since the schema was written. The insert took the two
 * numbers it was handed, **added them together**, wrote the total to
 * `inputTokens`, and discarded which was which.
 *
 * Found by trying to answer "is prompt caching paying for itself" against
 * fourteen days of prep spend — $149.94 on the engine, $84.66 on
 * instagram-agent — and getting three columns of NULL. The question cannot be
 * asked from the sum: `cached` is what the cache saved, `cacheWrite` is what
 * filling it cost at 1.25x the base rate, and only both together answer it.
 *
 * The sum stays exactly as it was. Every existing query reads `inputTokens`
 * and it still means the same thing; the split joins it rather than replacing
 * it.
 *
 * ## What makes this fail
 *
 * Delete any of the three keys from the row literal in `span-helpers.ts`, or
 * rename one, and its assertion reads `undefined`. Drop the `?? null` on
 * `inputTokensCacheWrite` and the "wrote no cache" case reads `undefined`,
 * which is a different thing in a BigQuery insert — the same distinction
 * `servedByHop` needed.
 *
 * ## What it does NOT prove
 *
 * That the columns exist in the live table. `npm run check:bq-schema` is what
 * checks that, and it is the reason these three were safe to start writing
 * today while `evalScore` still is not: the table already has them.
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

async function settleInsert(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function insertedRow(attrs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const span = trace.getTracer("test").startSpan("test");
  recordCostAndTokens(span, attrs as never);
  await settleInsert();
  expect(inserts.length, "the insert must actually have run — an unrun check produces no evidence").toBe(1);
  return inserts[0]!.rows[0]!;
}

describe("agent_runs_bi row: the cache token split", () => {
  it("carries cached and uncached as their own columns, not only as a total", async () => {
    const row = await insertedRow({ ...BASE, inputTokensCacheWrite: 1_400 });

    expect(row["inputTokensCached"]).toBe(20_000);
    expect(row["inputTokensUncached"]).toBe(7_233);
    expect(row["inputTokensCacheWrite"]).toBe(1_400);
  });

  it("keeps inputTokens meaning exactly what it always meant", async () => {
    // The whole reason the split is additive. A query that reads `inputTokens`
    // today must read the same number tomorrow, or every cost report built on
    // it quietly changes shape.
    const row = await insertedRow({ ...BASE, inputTokensCacheWrite: 1_400 });

    expect(row["inputTokens"]).toBe(27_233);
  });

  it("writes NULL, not undefined, for a turn that wrote no cache", async () => {
    // `undefined` and `null` are different things to a BigQuery insert: one
    // omits the column, the other states it is empty. The distinction is the
    // same one `servedByHop` needed.
    const row = await insertedRow({ ...BASE });

    expect(row["inputTokensCacheWrite"]).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(row, "inputTokensCacheWrite")).toBe(true);
  });

  it("does not double-count the cache write, which is already inside uncached", async () => {
    // The adapter folds cache-creation tokens into `uncached` at the base rate
    // and `computeStepCostUsd` adds the 1.25x premium from `cacheWrite`. A row
    // that added it a second time here would overstate every first turn.
    const row = await insertedRow({ ...BASE, inputTokensCacheWrite: 1_400 });

    expect(row["inputTokens"]).toBe(BASE.inputTokensCached + BASE.inputTokensUncached);
  });
});
