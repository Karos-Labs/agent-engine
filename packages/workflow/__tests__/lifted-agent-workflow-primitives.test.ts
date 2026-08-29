import { describe, expect, it } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, WorkflowToolingFailure, finalizeDeliverable, recordOutputExcerpt, runGate, toAgentContext, type WorkflowContext } from "../src/index.js";

/**
 * AU16 / SCRUM-300: `toAgentContext`, `runGate`, and the `finalizeDeliverable`
 * / `recordOutputExcerpt` persist-triple primitive, lifted out of fifteen
 * (`toAgentContext`), nine (`runGate`), and eight (the persist-triple)
 * per-agent workflow files that each defined their own byte-for-byte copy.
 *
 * These did not exist before this ticket — on unmodified `main` this whole
 * file fails to even import (`@agent-engine/workflow` exports none of these
 * four names).
 */

const baseParams = { runId: "run_lifted_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function tool(execute: (args: unknown) => Promise<unknown>): AgentToolRegistry[string] {
  // `description` is required on AgentTool since SCRUM-293 (AU7).
  return { name: "t", description: "Test stub tool.", version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, execute: execute as never };
}

describe("toAgentContext", () => {
  it("carries the workflow's identity straight through, with empty metadata", () => {
    const wf = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", input: {} } as WorkflowContext;
    expect(toAgentContext(wf)).toEqual({ runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} });
  });

  it("includes slotId only when the workflow context actually has one", () => {
    const withSlot = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", slotId: "slot-3", input: {} } as WorkflowContext;
    const withoutSlot = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", input: {} } as WorkflowContext;
    expect(toAgentContext(withSlot).slotId).toBe("slot-3");
    expect("slotId" in toAgentContext(withoutSlot)).toBe(false);
  });
});

describe("runGate", () => {
  const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

  it("throws WorkflowToolingFailure — never a content verdict — when the gate isn't registered", async () => {
    await expect(runGate({}, "gate.missing", {}, ctx)).rejects.toThrow(WorkflowToolingFailure);
    await expect(runGate({}, "gate.missing", {}, ctx)).rejects.toThrow(/no gate registered as "gate.missing"/);
  });

  it("throws WorkflowToolingFailure when the gate call itself doesn't report success", async () => {
    const tools: AgentToolRegistry = { "gate.numbersSourced": tool(async () => ({ status: "tooling_error", reason: "browser crashed" })) };
    await expect(runGate(tools, "gate.numbersSourced", {}, ctx)).rejects.toThrow(/gate "gate.numbersSourced" call failed: tooling_error/);
  });

  it("unwraps a successful call to the raw GateVerdict", async () => {
    const verdict = { verdict: "content_fail", reason: "unsourced number", evidence: [], toolVersion: "1.0.0" };
    const tools: AgentToolRegistry = { "gate.numbersSourced": tool(async () => ({ status: "success", result: verdict })) };
    await expect(runGate(tools, "gate.numbersSourced", { text: "x" }, ctx)).resolves.toEqual(verdict);
  });
});

describe("finalizeDeliverable", () => {
  it("writes the deliverable, then snapshots the dashboard with the resolved deliverableId folded in — using the caller's own step ids", async () => {
    const calls: { writeDeliverable: unknown[]; dashboardSnapshot: unknown[] } = { writeDeliverable: [], dashboardSnapshot: [] };
    const tools: AgentToolRegistry = {
      "ledger.writeDeliverable": tool(async (args) => {
        calls.writeDeliverable.push(args);
        return { status: "success", result: { id: "deliv_abc123" } };
      }),
      "ledger.dashboardSnapshot": tool(async (args) => {
        calls.dashboardSnapshot.push(args);
        return { status: "success", result: {} };
      }),
    };

    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) => {
      const ctx = toAgentContext(wf);
      return finalizeDeliverable(wf, tools, ctx, {
        persistDeliverableStepId: "16-persist-deliverable",
        persistManifestStepId: "17-persist-manifest",
        kind: "x-post",
        deliverable: { text: "hello world" },
        snapshot: (deliverableId) => ({ topic: "launch", deliverableId }),
      });
    };

    const result = await new WorkflowEngine(store).run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output).toBe("deliv_abc123");

    expect(calls.writeDeliverable).toEqual([{ runId: baseParams.runId, kind: "x-post", deliverable: { text: "hello world" } }]);
    expect(calls.dashboardSnapshot).toEqual([{ runId: baseParams.runId, snapshot: { topic: "launch", deliverableId: "deliv_abc123" } }]);

    // The exact step ids the caller passed in are what got checkpointed — a
    // resumed run has to find these same two ids, or every pre-existing
    // in-flight run breaks on this deploy.
    const steps = await store.listSteps(baseParams.runId);
    expect(steps.map((s) => s.stepId).sort()).toEqual(["16-persist-deliverable", "17-persist-manifest"]);
  });

  it("throws WorkflowToolingFailure and never calls dashboardSnapshot when writeDeliverable itself doesn't succeed", async () => {
    const dashboardCalls: unknown[] = [];
    const tools: AgentToolRegistry = {
      "ledger.writeDeliverable": tool(async () => ({ status: "tooling_error", reason: "firestore down" })),
      "ledger.dashboardSnapshot": tool(async (args) => {
        dashboardCalls.push(args);
        return { status: "success", result: {} };
      }),
    };

    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) => {
      const ctx = toAgentContext(wf);
      return finalizeDeliverable(wf, tools, ctx, {
        persistDeliverableStepId: "d",
        persistManifestStepId: "m",
        kind: "x-post",
        deliverable: {},
        snapshot: (deliverableId) => ({ deliverableId }),
      });
    };

    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "run_lifted_fail" });
    expect(result.status).not.toBe("completed");
    expect(dashboardCalls).toHaveLength(0);
  });

  it("resuming a run whose deliverable step already completed does not rebuild the deliverable or re-call either tool", async () => {
    let buildCount = 0;
    const writeCalls: unknown[] = [];
    const snapshotCalls: unknown[] = [];
    const tools: AgentToolRegistry = {
      "ledger.writeDeliverable": tool(async (args) => {
        writeCalls.push(args);
        return { status: "success", result: { id: "deliv_resumed" } };
      }),
      "ledger.dashboardSnapshot": tool(async (args) => {
        snapshotCalls.push(args);
        return { status: "success", result: {} };
      }),
    };

    const store = new MemoryDurableStepStore();
    const runId = "run_lifted_resume";
    const workflowFn = async (wf: WorkflowContext) => {
      const ctx = toAgentContext(wf);
      return finalizeDeliverable(wf, tools, ctx, {
        persistDeliverableStepId: "d",
        persistManifestStepId: "m",
        kind: "x-post",
        buildDeliverable: () => {
          buildCount += 1;
          // A non-repeatable stamp, same shape as blog-agent's `new Date().toISOString()` —
          // the point of `buildDeliverable` is that this must run exactly once.
          return { builtAt: buildCount };
        },
        snapshot: (deliverableId) => ({ deliverableId }),
      });
    };

    const first = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });
    expect(first.status).toBe("completed");
    expect(buildCount).toBe(1);
    expect(writeCalls).toHaveLength(1);
    expect(snapshotCalls).toHaveLength(1);

    const second = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId });
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // The whole point: resuming must not rebuild the deliverable or re-call either tool.
    expect(buildCount).toBe(1);
    expect(writeCalls).toHaveLength(1);
    expect(snapshotCalls).toHaveLength(1);
  });
});

describe("recordOutputExcerpt", () => {
  const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

  it("calls ledger.recordOutputExcerpt with the given agentId/runId/excerpt", async () => {
    const calls: unknown[] = [];
    const tools: AgentToolRegistry = {
      "ledger.recordOutputExcerpt": tool(async (args) => {
        calls.push(args);
        return { status: "success", result: {} };
      }),
    };
    await recordOutputExcerpt(tools, ctx, "r1", "x-agent", "shipped post text");
    expect(calls).toEqual([{ agentId: "x-agent", runId: "r1", excerpt: "shipped post text" }]);
  });

  it("never throws when the tool call rejects — losing an excerpt must never cost the delivered post", async () => {
    const tools: AgentToolRegistry = {
      "ledger.recordOutputExcerpt": tool(async () => {
        throw new Error("network blip");
      }),
    };
    await expect(recordOutputExcerpt(tools, ctx, "r1", "x-agent", "text")).resolves.toBeUndefined();
  });

  it("is a safe no-op when the tool isn't registered at all", async () => {
    await expect(recordOutputExcerpt({}, ctx, "r1", "x-agent", "text")).resolves.toBeUndefined();
  });
});
