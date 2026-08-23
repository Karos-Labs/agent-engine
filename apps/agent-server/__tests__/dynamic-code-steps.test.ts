import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * Code stages on the dynamic runner.
 *
 * The sandbox's own guarantees — no egress, no writes outside scratch, no
 * inherited secrets — are asserted against real subprocesses in
 * `@agent-engine/dynamic-sandbox`'s suite. What is left to pin here is the
 * wiring: that the flag genuinely gates execution, that a script sees the run's
 * input, that its output feeds the next stage, and that a script which fails
 * fails the run rather than quietly producing a deliverable with a step
 * missing from it.
 */

/** A definition whose only stage is an authored script. */
function codeOnlyAgent(code: string, extra: Record<string, unknown> = {}): AgentDefinitionInput {
  return {
    agentId: "transformer",
    name: "Transformer",
    description: "One deterministic transform, no model",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        kind: "code",
        id: "transform",
        description: "reshape the run input",
        language: "node",
        code,
        ...extra,
      },
    ],
  } as AgentDefinitionInput;
}

/** Reads stdin as JSON and prints whatever `fn` returns. */
function nodeScript(body: string): string {
  return `let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const ctx = JSON.parse(raw);
  console.log(JSON.stringify((${body})(ctx)));
});`;
}

describe("dynamic runner code stages", () => {
  let env: TestEnvironment;
  let store: MemoryAgentDefinitionStore;
  let priorFlag: string | undefined;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    store = new MemoryAgentDefinitionStore();
    priorFlag = process.env.DYNAMIC_CODE_STEPS_ENABLED;
  });

  afterEach(async () => {
    if (priorFlag === undefined) delete process.env.DYNAMIC_CODE_STEPS_ENABLED;
    else process.env.DYNAMIC_CODE_STEPS_ENABLED = priorFlag;
    await env.cleanup();
  });

  /**
   * What a stage actually checkpointed. Read from the durable store rather
   * than the run report, because the report carries status and cost per step,
   * never the value — and the value is the whole claim here.
   *
   * For a code stage this is the sandbox's full `CodeStepResult`, not the
   * unwrapped payload: the checkpoint is the audit record (it keeps `stderr`
   * and which tier ran), while the unwrapped object is what flows on to the
   * next stage. `.output` is the payload half.
   */
  async function stepRecord(runId: string, stepId: string): Promise<{ ok: boolean; output?: unknown; tier?: string }> {
    const steps = await env.durableStore.listSteps(runId);
    return steps.find((s) => s.stepId === stepId)?.output as { ok: boolean; output?: unknown; tier?: string };
  }

  const stepOutput = async (runId: string, stepId: string) => (await stepRecord(runId, stepId)).output;

  /** The engine diagnostic recorded against a failed step, for asserting WHY a run failed. */
  function failureFor(report: { steps: Array<{ stepId: string; status: string; error?: string }> }, stepId: string): string {
    const step = report.steps.find((s) => s.stepId === stepId);
    expect(step?.status, `step "${stepId}" should have failed`).toBe("failed");
    return step?.error ?? "";
  }

  async function run(definition: AgentDefinitionInput, runId: string, input?: Record<string, unknown>) {
    await store.upsert(definition.agentId, definition, { expectExisting: false });
    return startRunJob(
      { clientSlug: "acme", productId: definition.agentId, runKind: "recurring", ...(input ? { input } : {}) },
      runId,
      {
        durableStore: env.durableStore,
        runtimeDeps: { ...env.runtimeDeps, router: smartFakeRouter([{ text: "unused" }]) },
        agentDefinitionStore: store,
      },
    );
  }

  it("refuses to run a code stage when the flag is off, rather than skipping it", async () => {
    // The important half. Skipping would produce a deliverable that is missing
    // a transform the author declared, with nothing downstream aware a step
    // was dropped.
    delete process.env.DYNAMIC_CODE_STEPS_ENABLED;

    const outcome = await run(codeOnlyAgent(nodeScript("() => ({ ok: true })")), "run-code-off");

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).not.toBe("completed");
    // Asserted on the reason, not just the status: "did not complete" would
    // also hold if code steps were broken outright, which is the opposite of
    // what this test is for.
    expect(failureFor(outcome.report, "transform")).toMatch(/DYNAMIC_CODE_STEPS_ENABLED/);
  });

  it("executes the script and returns its output when the flag is on", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const outcome = await run(codeOnlyAgent(nodeScript("() => ({ shouted: 'HELLO' })")), "run-code-on");

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(await stepOutput("run-code-on", "transform")).toMatchObject({ shouted: "HELLO" });
  }, 30_000);

  it("gives the script the run's own input", async () => {
    // The same bug the AI path had: a stage that cannot see what the person
    // typed is answering a question it was never shown.
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const outcome = await run(
      codeOnlyAgent(nodeScript("(ctx) => ({ echoed: ctx.runInput.requestedTopic })")),
      "run-code-input",
      { requestedTopic: "quarterly billing review" },
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(await stepOutput("run-code-input", "transform")).toMatchObject({ echoed: "quarterly billing review" });
  }, 30_000);

  it("feeds a code stage's output into the next stage", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const definition = {
      ...codeOnlyAgent(nodeScript("() => ({ count: 2 })")),
      agentId: "chained",
      stages: [
        ...codeOnlyAgent(nodeScript("() => ({ count: 2 })")).stages,
        {
          kind: "code",
          id: "double",
          description: "double the previous stage's count",
          language: "node",
          code: nodeScript("(ctx) => ({ doubled: ctx.previousOutput.count * 2 })"),
        },
      ],
    } as AgentDefinitionInput;

    const outcome = await run(definition, "run-code-chain");

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(await stepOutput("run-code-chain", "double")).toMatchObject({ doubled: 4 });
  }, 45_000);

  it("fails the run when the script throws", async () => {
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const outcome = await run(
      codeOnlyAgent(`throw new Error("the transform is broken");`),
      "run-code-throw",
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).not.toBe("completed");
    expect(failureFor(outcome.report, "transform")).toMatch(/the transform is broken/);
  }, 30_000);

  it("fails the run when the script's output misses its declared schema", async () => {
    // Declared, so enforced — a next stage reading a field that is not there
    // fails further from the cause than this does.
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const outcome = await run(
      codeOnlyAgent(nodeScript("() => ({ wrongField: 1 })"), {
        outputSchema: [{ name: "headline", type: "string", optional: false }],
      }),
      "run-code-schema",
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).not.toBe("completed");
    expect(failureFor(outcome.report, "transform")).toMatch(/does not match its declared schema/);
  }, 30_000);

  it("passes a code stage's output through untouched when it declares no schema", async () => {
    // The flat DSL cannot describe nested data, and a transform legitimately
    // returns some. The sandbox already guarantees the value IS a JSON object.
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    const outcome = await run(
      codeOnlyAgent(nodeScript("() => ({ nested: { deep: ['a', 'b'] } })")),
      "run-code-nested",
    );

    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(await stepOutput("run-code-nested", "transform")).toMatchObject({ nested: { deep: ["a", "b"] } });
  }, 30_000);

  it("records which sandbox tier executed the step", async () => {
    // Two tiers with materially different guarantees — the docker one is
    // kernel-enforced, the local one is a blocklist. Months later, "was this
    // step actually isolated" has to be answerable from the run itself.
    process.env.DYNAMIC_CODE_STEPS_ENABLED = "true";

    await run(codeOnlyAgent(nodeScript("() => ({ done: true })")), "run-code-tier");

    expect((await stepRecord("run-code-tier", "transform")).tier).toMatch(/^(docker|local)$/);
  }, 30_000);
});
