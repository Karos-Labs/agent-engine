import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * Output de-duplication on the dynamic runner.
 *
 * `packages/core`'s suite pins the measure and the verdict as pure functions.
 * What is left here is the behaviour that only appears in composition: that the
 * flag actually gates it, that a run's own output becomes the next run's
 * history, and — the one that matters most — that a flagged repeat does NOT
 * fail the run. De-duplication is a signal for a human, unlike the topic
 * guardrail beside it, and a regression that turned it into a blocker would
 * silently start killing legitimate work.
 */

const PARAGRAPH =
  "The team shipped the new billing dashboard this week, cutting invoice reconciliation from three days to under an hour for finance.";

function agent(agentId: string, dedupe: boolean): AgentDefinitionInput {
  return {
    agentId,
    name: "Drafting Agent",
    description: "Produces one short draft",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    dedupeAgainstHistory: dedupe,
    stages: [
      {
        id: "draft",
        description: "produce a draft",
        systemPrompt: "You write short drafts.",
        allowedTools: [],
        outputSchema: [{ name: "text", type: "string", optional: false }],
      },
    ],
  } as AgentDefinitionInput;
}

describe("dynamic runner output de-duplication", () => {
  let env: TestEnvironment;
  let store: MemoryAgentDefinitionStore;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    store = new MemoryAgentDefinitionStore();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function run(agentId: string, runId: string, draft: string) {
    return startRunJob({ clientSlug: "acme", productId: agentId, runKind: "recurring" }, runId, {
      durableStore: env.durableStore,
      runtimeDeps: { ...env.runtimeDeps, router: smartFakeRouter([{ text: draft }]) },
      agentDefinitionStore: store,
    });
  }

  /**
   * The verdict this run recorded, read from its own checkpointed step — which
   * is where it has to be for anyone to act on it.
   */
  async function verdictFor(runId: string): Promise<Record<string, unknown> | undefined> {
    const steps = await env.durableStore.listSteps(runId);
    return steps.find((s) => s.stepId === "output-dedupe")?.output as Record<string, unknown> | undefined;
  }

  /** Which steps a run actually executed. */
  async function stepIds(runId: string): Promise<string[]> {
    return (await env.durableStore.listSteps(runId)).map((s) => s.stepId);
  }

  it("does nothing at all for an agent that did not opt in", async () => {
    // The zero-impact guarantee: an agent without the flag must not read
    // history, write history, or pay for either.
    await store.upsert("plain", agent("plain", false), { expectExisting: false });

    const outcome = await run("plain", "run-dd-off", PARAGRAPH);

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(await stepIds("run-dd-off")).not.toContain("output-dedupe");
    expect(await env.store.readJson("acme", ["ledger", "output-history", "plain"])).toBeUndefined();
  });

  it("runs the check and records the deliverable when the agent opted in", async () => {
    await store.upsert("deduper", agent("deduper", true), { expectExisting: false });

    const outcome = await run("deduper", "run-dd-1", PARAGRAPH);

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");

    // A first run has nothing to compare against, and says so rather than
    // reporting a pass it never earned.
    expect(await verdictFor("run-dd-1")).toMatchObject({ status: "no_history", comparedCount: 0 });

    // The point of recording: the NEXT run has something to compare against.
    const history = await env.store.readJson<Array<{ runId: string }>>("acme", [
      "ledger",
      "output-history",
      "deduper",
    ]);
    expect(history?.map((h) => h.runId)).toEqual(["run-dd-1"]);
  });

  it("completes the run when the deliverable repeats a previous one", async () => {
    // The single most important assertion in this file. A repeat is flagged,
    // never blocked — if this ever fails, de-duplication has quietly become a
    // guardrail and is killing work it was never meant to stop.
    await store.upsert("deduper", agent("deduper", true), { expectExisting: false });

    const first = await run("deduper", "run-dd-a", PARAGRAPH);
    const second = await run("deduper", "run-dd-b", PARAGRAPH);

    if (first.outcome !== "started" || second.outcome !== "started") throw new Error("unreachable");
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    // Flagged, and specific about what it matched — a verdict a person can act
    // on, attached to a run that still delivered.
    expect(await verdictFor("run-dd-b")).toMatchObject({
      status: "similar",
      mostSimilarRunId: "run-dd-a",
      comparedCount: 1,
    });
  });

  it("passes a genuinely different deliverable rather than flagging everything", async () => {
    // The counterpart to the test above: if the measure flagged indiscriminately
    // the flag would carry no information and would be ignored.
    await store.upsert("deduper", agent("deduper", true), { expectExisting: false });

    await run("deduper", "run-dd-p", PARAGRAPH);
    await run("deduper", "run-dd-q", "Our office is closed on Monday for the public holiday.");

    expect(await verdictFor("run-dd-q")).toMatchObject({ status: "ok", comparedCount: 1 });
  });

  it("accumulates history across runs so each run sees the ones before it", async () => {
    await store.upsert("deduper", agent("deduper", true), { expectExisting: false });

    await run("deduper", "run-dd-x", PARAGRAPH);
    await run("deduper", "run-dd-y", "Hiring two backend engineers in Tel Aviv this quarter.");

    const history = await env.store.readJson<Array<{ runId: string }>>("acme", [
      "ledger",
      "output-history",
      "deduper",
    ]);
    expect(history?.map((h) => h.runId)).toEqual(["run-dd-x", "run-dd-y"]);
  });

  it("keeps one agent's history out of another's", async () => {
    await store.upsert("agent-one", agent("agent-one", true), { expectExisting: false });
    await store.upsert("agent-two", agent("agent-two", true), { expectExisting: false });

    await run("agent-one", "run-dd-one", PARAGRAPH);
    await run("agent-two", "run-dd-two", PARAGRAPH);

    for (const id of ["agent-one", "agent-two"]) {
      const history = await env.store.readJson<unknown[]>("acme", ["ledger", "output-history", id]);
      expect(history, id).toHaveLength(1);
    }
  });
});
