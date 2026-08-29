import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MockAgent,
  type AgentContext,
  type AgentStepConfig,
  type AgentTool,
  type AgentToolOutcome,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

/**
 * SCRUM-299 (AU15): `selfCritique.gateArgs` supports only STATIC fields, so
 * a gate that needs to check the draft's own *content* — not just a fixed
 * field like `platform` — had no way to express draft-to-gate-input. This is
 * exactly what seo-geo-fix-draft's numbersSourced gate needs: it checks that
 * every number claimed in a list of fixes has a cited source, but the draft
 * shape is `{ fixes: [{description, ...}] }`, not the `{ text, sources }`
 * the gate reads.
 */

const FixDraft = z.object({ fixes: z.array(z.object({ description: z.string() })) });
type FixDraft = z.infer<typeof FixDraft>;

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo", runKind: "recurring", metadata: {} };

function fakeRouter(turns: Array<() => CompletionResult<unknown>>) {
  const queue = [...turns];
  const complete = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fakeRouter: exhausted configured turns");
    return next();
  });
  return { complete, router: { complete, completeAlias: vi.fn() } as unknown as ModelRouter };
}

const finalTurn = (output: unknown) => () => ({
  output: { type: "final", output },
  modelUsed: "claude-sonnet-4-6",
  inputTokens: { cached: 0, uncached: 100 },
  outputTokens: 20,
});

function fakeTool(name: string, execute: (args: unknown) => Promise<AgentToolOutcome<unknown>>): AgentTool {
  return { name, description: `Test double for ${name}.`, version: "1.0.0", inputSchema: z.unknown(), execute: vi.fn(execute) };
}

/** The gate this ticket exists to unblock: fails when `args.text` cites a number with no matching source. */
function numbersSourcedGate(): AgentTool {
  return fakeTool("gate.numbersSourced", async (args) => {
    const { text = "", sources = [] } = (args ?? {}) as { text?: string; sources?: string[] };
    const numbers = text.match(/\d+%?/g) ?? [];
    const unsourced = numbers.filter((n: string) => !sources.some((s: string) => s.includes(n)));
    return {
      status: "success",
      result:
        unsourced.length === 0
          ? { verdict: "pass", evidence: [], toolVersion: "1.0.0" }
          : { verdict: "content_fail", reason: `unsourced numbers: ${unsourced.join(", ")}`, evidence: unsourced, toolVersion: "1.0.0" },
    };
  });
}

const DRAFT: FixDraft = {
  fixes: [{ description: "Lifts eligible impressions by 38% for the fixed pages." }, { description: "Removes 12 duplicate URLs." }],
};

function config(overrides: Partial<AgentStepConfig<FixDraft>> = {}): AgentStepConfig<FixDraft> {
  return {
    id: "fix-draft",
    description: "Draft SEO fixes",
    allowedTools: ["gate.numbersSourced"],
    outputSchema: FixDraft,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    selfCritique: { gateTool: "gate.numbersSourced", maxRevisions: 1 },
    ...overrides,
  };
}

describe("BaseAgent — selfCritique.gateInput", () => {
  it("lets the gate see the draft's own content via a transform gateArgs alone cannot express", async () => {
    const gate = numbersSourcedGate();
    // Both turns produce the same unsourced-numbers draft, so the gate fails
    // both the initial check and the one bounded revision (maxRevisions: 1) —
    // the run ends in content_fail either way, which is all this test needs.
    const { router } = fakeRouter([finalTurn(DRAFT), finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const result = await new MockAgent(
      runtime,
      config({
        selfCritique: {
          gateTool: "gate.numbersSourced",
          gateInput: (draft) => ({ text: draft.fixes.map((f) => f.description).join(" "), sources: [] }),
        },
      }),
    ).run(ctx, {});

    // Two unsourced numbers (38%, 12) in the real draft content: the gate must catch this, not pass vacuously.
    expect(result.status).toBe("content_fail");
    expect(gate.execute).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("38%") }), expect.anything());
  });

  it("merges gateInput's result with static gateArgs, gateArgs winning", async () => {
    const gate = fakeTool("gate.numbersSourced", async () => ({ status: "success", result: { verdict: "pass", evidence: [], toolVersion: "1.0.0" } }));
    const { router } = fakeRouter([finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    await new MockAgent(
      runtime,
      config({
        selfCritique: {
          gateTool: "gate.numbersSourced",
          gateArgs: { platform: "seo-geo" },
          gateInput: (draft) => ({ text: draft.fixes.map((f) => f.description).join(" "), platform: "overridden" }),
        },
      }),
    ).run(ctx, {});

    expect(gate.execute).toHaveBeenCalledWith(expect.objectContaining({ platform: "seo-geo" }), expect.anything());
  });

  // The defect family this ticket names: a check structurally incapable of failing. A guard that only
  // rejects `typeof !== "object"` does NOT catch an array — `typeof [] === "object"` in JS — so a very
  // plausible authoring mistake (mapping the fixes to an array of description strings and forgetting to
  // join them into `{ text: ... }`) would spread into `{0:"a",1:"b",...gateArgs}`, a shape with no `text`
  // field the gate reads, and pass vacuously on a draft with two unsourced numbers.
  it("rejects a gateInput that returns an array, instead of spreading it into a vacuous pass", async () => {
    const gate = numbersSourcedGate();
    const { router } = fakeRouter([finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const result = await new MockAgent(
      runtime,
      config({
        selfCritique: {
          gateTool: "gate.numbersSourced",
          gateArgs: { platform: "seo-geo" },
          // The near-miss: forgot to join the descriptions into `{ text }`.
          gateInput: (draft) => draft.fixes.map((f) => f.description) as unknown,
        },
      }),
    ).run(ctx, {});

    expect(gate.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("tooling_error");
    expect(result.steps.at(-1)!.error).toMatch(/gateInput returned an array, not a plain object/);
  });

  it("reports tooling_error, draft preserved, when gateInput itself throws", async () => {
    const gate = numbersSourcedGate();
    const { router } = fakeRouter([finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const result = await new MockAgent(
      runtime,
      config({
        selfCritique: {
          gateTool: "gate.numbersSourced",
          gateInput: () => {
            throw new Error("transform blew up");
          },
        },
      }),
    ).run(ctx, {});

    expect(gate.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("tooling_error");
    expect(result.steps.at(-1)!.error).toMatch(/gateInput threw: transform blew up/);
  });

  it.each([
    ["a string", () => "just a string"],
    ["a number", () => 42],
    ["null", () => null],
  ])("rejects a gateInput that returns %s", async (_label, gateInput) => {
    const gate = numbersSourcedGate();
    const { router } = fakeRouter([finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const result = await new MockAgent(runtime, config({ selfCritique: { gateTool: "gate.numbersSourced", gateInput } })).run(ctx, {});

    expect(gate.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("tooling_error");
  });

  it("still passes the raw draft to the gate when no gateInput is configured (unchanged behaviour)", async () => {
    const gate = fakeTool("gate.numbersSourced", async () => ({ status: "success", result: { verdict: "pass", evidence: [], toolVersion: "1.0.0" } }));
    const { router } = fakeRouter([finalTurn(DRAFT)]);
    const runtime: BaseAgentRuntime = { router, tools: { "gate.numbersSourced": gate } };

    const result = await new MockAgent(runtime, config()).run(ctx, {});

    expect(result.status).toBe("completed");
    expect(gate.execute).toHaveBeenCalledWith(DRAFT, expect.anything());
  });
});
