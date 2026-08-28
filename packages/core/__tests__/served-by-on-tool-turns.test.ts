import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MockAgent,
  type AgentContext,
  type AgentStepConfig,
  type AgentTool,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

/**
 * SCRUM-361 item 3, precondition 1 — the SOURCE of the data, one level below
 * `agent_runs_bi`.
 *
 * ## The gap this pins
 *
 * `base-agent.ts` builds `AgentStepTelemetry` in six places. Five of them —
 * disallowed tool, write-fence block, unregistered tool, bad tool args, and
 * the two `final`-turn branches — attach `servedBy` from
 * `completion.provenance`. The SUCCESSFUL tool-call turn did not.
 *
 * That is the happy path of a ReAct loop, so it is also the common one. The
 * consequence is directional and it is the wrong direction for this ticket: a
 * step whose TOOL turns were served by the direct-Anthropic hop but whose
 * final turn was served by Vertex recorded NO provenance, and so read as
 * fully Vertex-billed. The fallback share — the exact quantity the billing
 * reconciliation splits on — was understated, and understated silently,
 * because an absent `servedBy` is indistinguishable from a primary-served one
 * by construction (`base-agent.ts` only attaches it when `hop !== "primary"`).
 *
 * ## What makes this fail
 *
 * Remove the `...(completion.provenance && completion.provenance.hop !==
 * "primary" ? { servedBy: ... } : {})` spread from the successful tool-call
 * telemetry literal and test 1 reads `undefined`. Change it to attach
 * unconditionally and test 3 fails, because a primary-served turn would start
 * claiming a hop.
 */

const DraftOutput = z.object({ body: z.string() });

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram", runKind: "recurring", metadata: {} };

type Provenance = { hop: "primary" | "secondary" | "tertiary"; servedBy: string; failedOver: { from: string; errorClass: string; status?: number }[] };

function turn(output: unknown, provenance?: Provenance): () => CompletionResult<unknown> {
  return () => ({
    output,
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: 100 },
    outputTokens: 20,
    ...(provenance ? { provenance } : {}),
  }) as CompletionResult<unknown>;
}

function fakeRouter(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouter: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("completeAlias not used");
    }),
  } as unknown as ModelRouter;
}

const PING: AgentTool<unknown, unknown> = {
  name: "noop.ping",
  version: "1.0.0",
  inputSchema: z.object({}),
  execute: async () => ({ status: "success", result: { ok: true } }),
};

const FELL_OVER: Provenance = { hop: "secondary", servedBy: "anthropic", failedOver: [{ from: "vertex-claude", errorClass: "rate_limited", status: 429 }] };

async function runTwoTurnAgent(toolTurnProvenance: Provenance | undefined, finalTurnProvenance: Provenance | undefined) {
  const router = fakeRouter([
    turn({ type: "tool_call", tool: "noop.ping", args: {} }, toolTurnProvenance),
    turn({ type: "final", output: { body: "drafted" } }, finalTurnProvenance),
  ]);
  const runtime: BaseAgentRuntime = { router, tools: { "noop.ping": PING } };
  const config: AgentStepConfig<z.infer<typeof DraftOutput>> = {
    id: "draft",
    description: "two-turn ReAct step",
    allowedTools: ["noop.ping"],
    outputSchema: DraftOutput,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
  };
  const result = await new MockAgent(runtime, config).run(ctx, {});
  // The intervention has to have run before its result is read: two turns, and
  // the step must have completed rather than errored into a one-turn shape.
  expect(result.status, "the agent must have completed for the tool turn to be a SUCCESSFUL one").toBe("completed");
  expect(result.steps.length, "expected exactly two turns: one tool call, one final").toBe(2);
  return result.steps;
}

describe("base-agent records who served a SUCCESSFUL tool-call turn", () => {
  it("attaches servedBy to a tool turn that was answered by the fallback", async () => {
    const [toolTurn] = await runTwoTurnAgent(FELL_OVER, undefined);

    expect(toolTurn!.toolCall?.name, "this is the successful-tool-call branch, not an error branch").toBe("noop.ping");
    expect(toolTurn!.status).toBe("success");
    expect(toolTurn!.servedBy).toEqual({
      hop: "secondary",
      adapter: "anthropic",
      failedOver: [{ from: "vertex-claude", errorClass: "rate_limited", status: 429 }],
    });
  });

  it("leaves the final turn clean when only the tool turn failed over — the case that was invisible", async () => {
    const [toolTurn, finalTurn] = await runTwoTurnAgent(FELL_OVER, undefined);

    expect(toolTurn!.servedBy?.hop).toBe("secondary");
    expect(finalTurn!.servedBy, "the final turn genuinely was primary-served").toBeUndefined();
    // Before the fix this step carried zero provenance and read as fully
    // Vertex-billed, despite one of its two turns being billed by Anthropic.
    expect(
      result_anyTurnFellOver([toolTurn!, finalTurn!]),
      "the reconciliation's question is 'was ANY part of this billed by someone other than Google'",
    ).toBe(true);
  });

  it("attaches nothing when the tool turn was primary-served — absent must keep meaning Vertex", async () => {
    const [toolTurn] = await runTwoTurnAgent({ hop: "primary", servedBy: "vertex-claude", failedOver: [] }, undefined);

    expect(toolTurn!.servedBy).toBeUndefined();
  });
});

/** The same rule `runStepAgent` applies, restated here so the two cannot drift apart silently. */
function result_anyTurnFellOver(steps: { servedBy?: { hop: string } | undefined }[]): boolean {
  return steps.some((s) => s.servedBy !== undefined && s.servedBy.hop !== "primary");
}
