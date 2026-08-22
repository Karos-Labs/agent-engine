import { describe, expect, it } from "vitest";
import { MemoryDurableStepStore } from "../src/adapters/memory-store.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import type { WorkflowContext } from "../src/primitives/context.js";

/**
 * The per-run input channel.
 *
 * agent-middleware has always published the caller's `input` on the job
 * message; the engine's schema stripped it, so a portal brief reached the
 * broker and stopped there. The agent then chose its own topic — wrong
 * output rather than a failure, which is why nothing surfaced it.
 *
 * The alternative that existed before this was writing a per-run request into
 * the client's standing config. These tests pin the two properties that made
 * that alternative wrong: input is per run, and it survives a gate pause.
 */
const BASE = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

describe("WorkflowContext.input", () => {
  it("hands the workflow what this run was asked for", async () => {
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    let seen: Readonly<Record<string, unknown>> | undefined;

    await engine.run(
      async (wf: WorkflowContext) => {
        seen = wf.input;
        return "ok";
      },
      { ...BASE, runId: "run_1", input: { requestedTopic: "cold brew economics" } },
    );

    expect(seen).toEqual({ requestedTopic: "cold brew economics" });
  });

  it("is always an object, so a workflow never guards for undefined", async () => {
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    let seen: unknown;

    await engine.run(
      async (wf: WorkflowContext) => {
        seen = wf.input;
        return "ok";
      },
      { ...BASE, runId: "run_2" },
    );

    expect(seen).toEqual({});
  });

  it("keeps two runs' briefs apart", async () => {
    // The property that client-config-as-brief could not provide: two runs for
    // one client, dispatched close together, each drafting against its own
    // request rather than whichever wrote to config last.
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const seen: string[] = [];

    const capture = async (wf: WorkflowContext) => {
      seen.push(String(wf.input.requestedTopic));
      return "ok";
    };

    await Promise.all([
      engine.run(capture, { ...BASE, runId: "run_a", input: { requestedTopic: "first" } }),
      engine.run(capture, { ...BASE, runId: "run_b", input: { requestedTopic: "second" } }),
    ]);

    expect(seen.sort()).toEqual(["first", "second"]);
  });

  it("survives a gate pause, because a resume carries no brief of its own", async () => {
    // The post-gate half runs in a different process — often a different
    // container — and must draft against the same brief as the first half.
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const seen: unknown[] = [];

    const workflow = async (wf: WorkflowContext) => {
      seen.push(wf.input.requestedTopic);
      await wf.step.gate("approve", { kind: "human", prompt: "ok?" } as never);
      seen.push(wf.input.requestedTopic);
      return "done";
    };

    const first = await engine.run(workflow, {
      ...BASE,
      runId: "run_gated",
      input: { requestedTopic: "the brief" },
    });
    expect(first.status).toBe("awaiting_gate");

    await engine.resolveGate("run_gated", "approve", {
      decision: "approve",
      actor: "someone",
      at: Date.now(),
    } as never);

    // Deliberately no `input` on the resume — the record is the carrier.
    const second = await engine.run(workflow, { ...BASE, runId: "run_gated" });

    expect(second.status).toBe("completed");
    // Three observations, not two: a resume re-executes the workflow body from
    // the top while completed steps return their checkpoints, so the pre-gate
    // line runs again. All three see the same brief, which is the point — the
    // replayed half and the new half agree.
    expect(seen).toEqual(["the brief", "the brief", "the brief"]);
  });

  it("persists the brief on the run record", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    await engine.run(async () => "ok", {
      ...BASE,
      runId: "run_persisted",
      input: { requestedTopic: "recorded" },
    });

    const record = await store.getRun("run_persisted");
    expect(record?.input).toEqual({ requestedTopic: "recorded" });
  });

  it("stores nothing when the caller sent nothing, rather than an empty object", async () => {
    // A scheduled run has no request of its own; an empty map on the record
    // would read as "asked for nothing in particular" instead of "not asked".
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);

    await engine.run(async () => "ok", { ...BASE, runId: "run_bare" });

    const record = await store.getRun("run_bare");
    expect(record?.input).toBeUndefined();
  });
});
