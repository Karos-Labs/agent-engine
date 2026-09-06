import { describe, expect, it } from "vitest";
import type { AgentExecutionResult, AgentStepTelemetry } from "@agent-engine/core";
import { commitDirectiveAfterExhaustion, describeAgentExhaustion } from "../src/index.js";

function turn(stepIndex: number, toolCall?: AgentStepTelemetry["toolCall"], error?: string): AgentStepTelemetry {
  return {
    stepIndex,
    ...(toolCall !== undefined ? { toolCall } : {}),
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 6222, uncached: 23000 },
    outputTokens: 2200,
    durationMs: 50_000,
    costUsd: 0.1,
    status: error === undefined ? "success" : "tooling_error",
    ...(error !== undefined ? { error } : {}),
  };
}

const lintPass = { status: "success", result: { verdict: "pass", evidence: ["within the twitter length limit (202/280)"], toolVersion: "1.0.0" } };
const preview = { status: "success", result: { characterCount: 146, withinLimit: true } };

/** Prep run pubsub-21699953559354996's `10-draft-post`, turn for turn, plus the commit turn the engine now adds. */
function theObservedRun(): AgentExecutionResult<unknown> {
  const refusal = 'the 8-turn working budget was spent and this commit turn had to return the final output, but the model called "gate.lintPost" instead — refused, not executed';
  return {
    finalOutput: null,
    status: "budget_exceeded",
    totalCostUsd: 0.909997,
    totalTokens: { input: 234170, output: 21672 },
    steps: [
      turn(0, { name: "render.preview", args: { text: "…" }, result: preview, toolVersion: "1.0.0" }),
      turn(1, { name: "gate.lintPost", args: { text: "…" }, result: lintPass, toolVersion: "1.0.0" }),
      turn(2, { name: "render.preview", args: { text: "…" }, result: preview, toolVersion: "1.0.0" }),
      ...[3, 4, 5, 6, 7].map((i) => turn(i, { name: "gate.lintPost", args: { text: "…" }, result: lintPass, toolVersion: "1.0.0" })),
      turn(8, { name: "gate.lintPost", args: { text: "…" }, result: { refused: true, reason: refusal }, toolVersion: "commit-turn" }, refusal),
    ],
  };
}

describe("describeAgentExhaustion", () => {
  it("says what the step did instead of finishing: turns, spend, every tool with its pass count, and the turn that ended it", () => {
    const line = describeAgentExhaustion(theObservedRun());

    expect(line).toBe(
      "budget_exceeded after 9 turn(s), $0.91; " +
        // Insertion order, so the account reads in the order the model worked.
        // The refused commit-turn call counts as a call but not as a pass.
        "tool calls: render.preview ×2, gate.lintPost ×7 (6 pass); " +
        'the 8-turn working budget was spent and this commit turn had to return the final output, but the model called "gate.lintPost" instead — refused, not executed',
    );
  });

  it("stays honest about a step that did nothing observable", () => {
    const result: AgentExecutionResult<unknown> = {
      finalOutput: null,
      status: "budget_exceeded",
      totalCostUsd: 0,
      totalTokens: { input: 0, output: 0 },
      steps: [],
    };
    expect(describeAgentExhaustion(result)).toBe("budget_exceeded after 0 turn(s), $0.00; no tool calls; no final output was returned");
  });

  it("does not mistake a non-gate tool's result for a verdict", () => {
    const result: AgentExecutionResult<unknown> = {
      finalOutput: null,
      status: "budget_exceeded",
      totalCostUsd: 0.2,
      totalTokens: { input: 10, output: 10 },
      steps: [
        turn(0, { name: "research.pull", args: {}, result: { status: "success", result: { verdict: 42 } }, toolVersion: "1.0.0" }),
        turn(1, { name: "research.pull", args: {}, result: null, toolVersion: "1.0.0" }),
      ],
    };
    expect(describeAgentExhaustion(result)).toContain("tool calls: research.pull ×2;");
    expect(describeAgentExhaustion(result)).not.toContain("pass");
  });
});

describe("commitDirectiveAfterExhaustion", () => {
  it("hands the next attempt its predecessor's account and the shape of a turn-frugal attempt", () => {
    const directive = commitDirectiveAfterExhaustion(describeAgentExhaustion(theObservedRun()));

    expect(directive).toContain("ran out of turns without returning a final output");
    expect(directive).toContain("gate.lintPost ×7 (6 pass)");
    expect(directive).toContain("AT MOST once");
    expect(directive).toContain('return {"type":"final"} on the very next turn');
    // The observed failure re-deliberated a lane it had been told not to choose.
    expect(directive).toContain("lane and content mode you were given are settled");
  });
});
