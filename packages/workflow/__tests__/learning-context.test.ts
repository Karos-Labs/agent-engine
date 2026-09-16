import { describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  craftRulesForPrompt,
  emptyLearningContext,
  feedbackForPrompt,
  goalLineBullets,
  pickStrategyRow,
  resolveGoalLine,
  readLearningContext,
  readRunDirection,
  stageForRun,
  subjectWindowConflict,
  toAgentContext,
  touchesNeverTopic,
  writeRunState,
  type LearningContextLike,
  type WorkflowContext,
} from "../src/index.js";

/**
 * C7 (`docs/contracts/C7-run-context.md`, SCRUM-458/459/460): the learning
 * loop's shared primitives. The read and write wrappers are pinned on the
 * one property the contract states for both — the only way out is a value,
 * never a thrown error — and the pure helpers on the decisions they make
 * for a run: what counts as a repeat, what counts as a never-topic, which
 * stage a run is for, which strategy row it takes, and how the craft rules
 * reach the prompt.
 */

const baseParams = { runId: "run_learning_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function tool(execute: (args: unknown) => Promise<unknown>): AgentToolRegistry[string] {
  return { name: "t", description: "Test stub tool.", version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, execute: execute as never };
}

const WINDOW = {
  rows: [
    { subject: "How AI pricing is changing in 2026", stage: "expertise", status: "posted" },
    { subject: "Four-day weeks and output", stage: "attention", status: "drafted" },
    { subject: "A skipped subject about churn", stage: "decide", status: "skipped" },
  ],
};

describe("subjectWindowConflict", () => {
  it("reads a shorter topic covered by a window row as the same subject, and an adjacent idea as new", () => {
    expect(subjectWindowConflict("AI pricing", WINDOW)?.subject).toBe("How AI pricing is changing in 2026");
    expect(subjectWindowConflict("AI pricing: changing fast in 2026", WINDOW)?.subject).toBe("How AI pricing is changing in 2026");
    // No stemming, deliberately: "changes" is not "changing", and two of three shared tokens is under the 0.75 bar.
    expect(subjectWindowConflict("pricing changes in AI, 2026", WINDOW)).toBeUndefined();
    expect(subjectWindowConflict("Why intake queues break in month two", WINDOW)).toBeUndefined();
  });
  it("ignores skipped rows (a skipped subject was never published) and an absent window", () => {
    expect(subjectWindowConflict("a skipped subject about churn", WINDOW)).toBeUndefined();
    expect(subjectWindowConflict("anything", undefined)).toBeUndefined();
    expect(subjectWindowConflict("anything", { rows: [] })).toBeUndefined();
  });
});

describe("touchesNeverTopic", () => {
  it("matches when every content token of a never-topic appears in the topic", () => {
    const prefs = { neverTopics: ["pricing", "layoffs at Acme"] };
    expect(touchesNeverTopic("Our pricing page redesign", prefs)).toBe("pricing");
    expect(touchesNeverTopic("Layoffs hit Acme this week", prefs)).toBe("layoffs at Acme");
    expect(touchesNeverTopic("Layoffs across the sector", prefs)).toBeUndefined();
    expect(touchesNeverTopic("anything", undefined)).toBeUndefined();
  });
});

describe("stageForRun (D32)", () => {
  it("the calendar slot's stage wins outright", () => {
    expect(stageForRun("decide", WINDOW)).toBe("decide");
  });
  it("with no slot and no history, a funnel starts at attention", () => {
    expect(stageForRun(undefined, undefined)).toBe("attention");
    expect(stageForRun(undefined, { rows: [] })).toBe("attention");
  });
  it("with no slot, the stage most behind its 3/2/1 share goes next — skipped rows do not count", () => {
    const allAttention = { rows: [{ subject: "a", stage: "attention" }, { subject: "b", stage: "attention" }, { subject: "c", stage: "attention" }] };
    expect(stageForRun(undefined, allAttention)).toBe("expertise");
    const balanced = { rows: [{ subject: "a", stage: "attention" }, { subject: "b", stage: "attention" }, { subject: "c", stage: "attention" }, { subject: "d", stage: "expertise" }, { subject: "e", stage: "expertise" }] };
    expect(stageForRun(undefined, balanced)).toBe("decide");
    expect(stageForRun(undefined, { rows: [{ subject: "x", stage: "decide", status: "skipped" }] })).toBe("attention");
  });
});

describe("pickStrategyRow", () => {
  const MAP = {
    rows: [
      { id: "r1", stage: "attention", idea: "How AI pricing is changing in 2026" },
      { id: "r2", stage: "expertise", idea: "Why intake queues break in month two", status: "open" },
      { id: "r3", stage: "attention", idea: "The one metric ops leads never track", status: "open" },
      { id: "r4", stage: "decide", idea: "How to pilot intake automation in a week", status: "used" },
    ],
  };
  it("takes the first open row at the wanted stage that is not already in the subject window", () => {
    // r1 is in the window (same subject as a posted row); r3 is the first open attention row left.
    expect(pickStrategyRow(MAP, "attention", WINDOW)?.id).toBe("r3");
    expect(pickStrategyRow(MAP, "expertise", WINDOW)?.id).toBe("r2");
  });
  it("falls back to any open row when the stage has none, and to nothing when the map is spent or absent", () => {
    expect(pickStrategyRow(MAP, "decide", WINDOW)?.id).toBe("r2");
    expect(pickStrategyRow({ rows: [{ id: "u", stage: "decide", idea: "used", status: "used" }] }, "decide", undefined)).toBeUndefined();
    expect(pickStrategyRow(undefined, "attention", undefined)).toBeUndefined();
  });
});

describe("craftRulesForPrompt (D41)", () => {
  it("renders hard rules first with their ids, then defaults with layer and evidence, then overrides", () => {
    const text = craftRulesForPrompt({
      rules: [
        { id: "L2-saas-x-002", layer: "L2", kind: "default", rule: "Lead with a benchmark number", metric: "replies per impression" },
        { id: "L1-x-003", layer: "L1", kind: "hard", rule: "No link in the post body", metric: "reach" },
        { id: "L3-acme-x-001", layer: "L3", kind: "default", rule: "Open with a declarative, never a question", sampleSize: 12 },
      ],
      overrides: [{ winner: "L3-acme-x-001", loser: "L1-x-011" }],
    })!;
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^HARD RULES/);
    expect(lines[1]).toBe("- [L1-x-003] No link in the post body (moves: reach)");
    expect(lines[2]).toMatch(/^DEFAULTS/);
    expect(text).toContain("- [L2-saas-x-002] (L2) Lead with a benchmark number (moves: replies per impression)");
    expect(text).toContain("- [L3-acme-x-001] (L3, n=12) Open with a declarative, never a question");
    expect(lines.at(-1)).toBe("- L3-acme-x-001 overrides L1-x-011 for this client.");
  });
  it("is undefined with no rules, so the prompt key is omitted rather than empty", () => {
    expect(craftRulesForPrompt(undefined)).toBeUndefined();
    expect(craftRulesForPrompt({ rules: [] })).toBeUndefined();
  });
});

describe("feedbackForPrompt", () => {
  it("turns edits, skips and change requests into lines a writer can act on, newest first, and drops rows with nothing to say", () => {
    const lines = feedbackForPrompt({
      rows: [
        { action: "posted", at: "2026-09-01" },
        { action: "skipped", reason: "too salesy", at: "2026-09-02" },
        { action: "posted_with_edits", originalText: "We are thrilled to announce", finalText: "We shipped", at: "2026-09-03" },
        { action: "change_requested", at: "2026-09-04" },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Edited before posting (2026-09-03)");
    expect(lines[0]).toContain("We shipped");
    expect(lines[1]).toBe("Skipped (2026-09-02): too salesy");
    expect(feedbackForPrompt(undefined)).toEqual([]);
  });
});

describe("readLearningContext", () => {
  it("without the tool in the registry, returns everything-absent and the run goes on", async () => {
    let seen: LearningContextLike | undefined;
    const workflowFn = async (wf: WorkflowContext) => {
      seen = await readLearningContext(wf, {}, toAgentContext(wf), "x", "01b");
      return { ok: true };
    };
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    expect(seen).toEqual(emptyLearningContext("x"));
    expect(seen!.readiness.absent).toHaveLength(7);
  });

  it("a tool that throws is the same as no tool; a tool that succeeds is passed through with its readiness", async () => {
    const throwing: AgentToolRegistry = { "client.getLearningContext": tool(async () => { throw new Error("gcs down"); }) };
    const fine: AgentToolRegistry = {
      "client.getLearningContext": tool(async () => ({ status: "success", result: { platform: "x", preferences: { neverTopics: ["pricing"] }, readiness: { present: ["preferences"], absent: [] } } })),
    };
    const run = async (tools: AgentToolRegistry, runId: string) => {
      let seen: LearningContextLike | undefined;
      const workflowFn = async (wf: WorkflowContext) => {
        seen = await readLearningContext(wf, tools, toAgentContext(wf), "x", "01b");
        return { ok: true };
      };
      const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId });
      expect(result.status).toBe("completed");
      return seen!;
    };
    expect(await run(throwing, "run_throw")).toEqual(emptyLearningContext("x"));
    const ok = await run(fine, "run_fine");
    expect(ok.preferences?.neverTopics).toEqual(["pricing"]);
    expect(ok.readiness.present).toEqual(["preferences"]);
  });
});

describe("writeRunState", () => {
  const record = { platform: "x" as const, deliverable: { kind: "x-post", goal: "attention" as const } };
  it("hands the record plus the run id to ledger.writeRunState and reports the path", async () => {
    const calls: unknown[] = [];
    const tools: AgentToolRegistry = { "ledger.writeRunState": tool(async (args) => { calls.push(args); return { status: "success", result: { recordPath: "state/runs/run_learning_1" } }; }) };
    const workflowFn = async (wf: WorkflowContext) => writeRunState(wf, tools, toAgentContext(wf), "21", record);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, baseParams);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output).toEqual({ written: true, recordPath: "state/runs/run_learning_1" });
    expect(calls[0]).toMatchObject({ runId: "run_learning_1", platform: "x", deliverable: { kind: "x-post" } });
  });
  it("a missing tool, a failed outcome or a throw never fail the run — they are reported on the step", async () => {
    const cases: Array<[string, AgentToolRegistry, string]> = [
      ["none", {}, "ledger.writeRunState is not in this registry"],
      ["failed", { "ledger.writeRunState": tool(async () => ({ status: "tooling_error", reason: "x" })) }, "ledger.writeRunState resolved to tooling_error"],
      ["threw", { "ledger.writeRunState": tool(async () => { throw new Error("gcs down"); }) }, "gcs down"],
    ];
    for (const [name, tools, reason] of cases) {
      const workflowFn = async (wf: WorkflowContext) => writeRunState(wf, tools, toAgentContext(wf), "21", record);
      const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...baseParams, runId: `run_ws_${name}` });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("unreachable");
      expect(result.output).toEqual({ written: false, reason });
    }
  });
});

describe("readRunDirection carries slotStage (C3/C7)", () => {
  it("passes a valid stage through and drops anything else", () => {
    expect(readRunDirection({ slotStage: "expertise" }).slotStage).toBe("expertise");
    expect(readRunDirection({ slotStage: "awareness" }).slotStage).toBeUndefined();
    expect(readRunDirection({}).slotStage).toBeUndefined();
  });
});

describe("resolveGoalLine and goalLineBullets (D11 / C3, SCRUM-457)", () => {
  const fallback = { stage: "attention" as const, whyNow: "the next planned topic in the client's catalog" };

  it("the model's own answer wins; what it left out falls back to what the run knows", () => {
    expect(resolveGoalLine({ goal: "decide", audience: "ops leads", whyNow: "the pilot window opens" }, fallback)).toEqual({
      goal: "decide",
      goalText: "help them decide",
      audience: "ops leads",
      whyNow: "the pilot window opens",
    });
    // Nothing stated: the stage the run was written for, and the caller's line.
    expect(resolveGoalLine({}, fallback)).toEqual({ goal: "attention", goalText: "earn attention", whyNow: fallback.whyNow });
    // Blank is not an answer — a model that emits "" gets the fallback, not an empty card.
    expect(resolveGoalLine({ whyNow: "   ", audience: "" }, { ...fallback, audience: "the whole market" })).toEqual({
      goal: "attention",
      goalText: "earn attention",
      audience: "the whole market",
      whyNow: fallback.whyNow,
    });
  });

  it("renders the bullets the portal's drafts parsers already read, and omits the ones with nothing to say", () => {
    expect(goalLineBullets({ goal: "expertise", goalText: "show expertise", audience: "ops leads whose intake breaks", whyNow: "a report landed" })).toEqual([
      "**Goal:** show expertise",
      "**For:** ops leads whose intake breaks",
      "**Why now:** a report landed",
    ]);
    expect(goalLineBullets({ goal: "attention", goalText: "earn attention", whyNow: "" })).toEqual(["**Goal:** earn attention"]);
  });

  it("keeps URLs out of the why-now bullet, so the X parser can never read it as this draft's reply target", () => {
    // classifyXMetaBullet reads a bullet's URL against a reply/quote PHRASE:
    // "replying to <a real status URL>" in a why-now would drive the hand-off
    // deep link at the wrong post. Links ride on the bullets built for them.
    const bullets = goalLineBullets({
      goal: "attention",
      goalText: "earn attention",
      whyNow: "we are replying to https://x.com/someone/status/123 while it is live",
    });
    expect(bullets[1]).toBe("**Why now:** we are replying to while it is live");
    expect(bullets.join(" ")).not.toContain("http");
  });
});
