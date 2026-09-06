import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import {
  approvingEditorVerdict,
  fakeRouterSequence,
  finalTurn,
  goodEditionPlan,
  makePromptStore,
  revisingEditorVerdict,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * 2026-09-05: the editorial rounds. Before this, every content gate held the
 * run on its first failure and nothing ever judged whether the edition read
 * as a person wrote it. Now a failed gate is a note to the next draft, a
 * deterministic editorial lint checks links/tells/headings, and an editor
 * agent approves or sends the draft back with notes, bounded to three
 * rounds. These tests pin the round semantics; `editorial-lint.test.ts`
 * pins the lint rules themselves.
 */

const params = { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

function draft(overrides: Partial<{ intro: string; heading: string; body: string; linkUrl: string; subjectLine: string }> = {}) {
  const intro = overrides.intro ?? "Here is what actually worked for engineering teams this week, measured rather than felt.";
  const heading = overrides.heading ?? "Structured onboarding cuts ramp time";
  const body = overrides.body ?? "New-hire ramp time dropped sharply after a fixed four-day onboarding rollout. We think the structure mattered more than any single day's content.";
  const section = { heading, body, ...(overrides.linkUrl !== undefined ? { linkUrl: overrides.linkUrl } : {}) };
  const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
  const signoff = "The Acme Weekly Team";
  return {
    subjectLine: overrides.subjectLine ?? "3 teams cut onboarding time in half",
    previewText: "Plus: async standups are quietly replacing daily syncs.",
    intro,
    sections: [section],
    callToAction,
    signoff,
    text: `${intro}\n\n## ${heading}\n\n${body}\n\n${callToAction.text}\n\n${signoff}`,
  };
}

function calls(router: { complete: unknown }): string[] {
  return (router.complete as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
}

describe("editorial rounds", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a link the run never gave the draft is a redraft note, and the corrected redraft ships", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodEditionPlan()),
      finalTurn(draft({ linkUrl: "https://futureweek.com" })),
      finalTurn(draft()),
      finalTurn(approvingEditorVerdict()),
    ]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "nl_rounds_link" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.editorial?.rounds).toBe(2);
    expect(result.output.editorial?.flagged).toBe(false);

    const prompts = calls(router);
    expect(prompts[2]).toContain("editorial lint");
    expect(prompts[2]).toContain("https://futureweek.com");
    const ids = (await durableStore.listSteps("nl_rounds_link")).map((s) => s.stepId);
    expect(ids).toContain("15b-editorial-lint");
    expect(ids).toContain("15b-editorial-lint-round-2");
    expect(ids).toContain("15c-editor-verdict-round-2");
    expect(ids).not.toContain("15c-editor-verdict");
  });

  it("a generated-prose tell holds the run only after three drafts still carry it", async () => {
    const telling = draft({ body: "Ramp time fell after the rollout. That is the tell. The window is narrowing for teams that wait." });
    const router = fakeRouterSequence([finalTurn(goodEditionPlan()), finalTurn(telling), finalTurn(telling), finalTurn(telling)]);
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "nl_rounds_tell" },
    );
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("editorial lint");
    expect(result.reason).toContain("that is the tell");
    expect(router.complete).toHaveBeenCalledTimes(4);
  });

  it("the editor's revise verdict redrafts with its notes quoted, and the approved redraft ships clean", async () => {
    const notes = ["Lead, second sentence: 'ramp time dropped sharply' is a label. Use the four-day figure the source gives."];
    const router = fakeRouterSequence([
      finalTurn(goodEditionPlan()),
      finalTurn(draft()),
      finalTurn(revisingEditorVerdict(notes)),
      finalTurn(draft({ body: "New-hire ramp time dropped from four weeks to under two after a fixed four-day onboarding rollout. We think the structure mattered more than any single day's content." })),
      finalTurn(approvingEditorVerdict(["Optional: the signoff could name a person."])),
    ]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "nl_rounds_editor" },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.editorial).toMatchObject({ verdict: "approve", rounds: 2, flagged: false, notes: ["Optional: the signoff could name a person."] });
    expect(result.output.preview).toContain("from four weeks to under two");

    const prompts = calls(router);
    // The redraft prompt carries the editor's note, marked as the editor's.
    expect(prompts[3]).toContain("Editor: Lead, second sentence");
    // The second editor call sees the first round's notes, so it can check they were acted on.
    expect(prompts[4]).toContain("previousNotes");
    expect(prompts[4]).toContain('"round":2');

    const ids = (await durableStore.listSteps("nl_rounds_editor")).map((s) => s.stepId);
    expect(ids).toContain("15c-editor-verdict");
    expect(ids).toContain("09-draft-post-round-2");
    expect(ids).toContain("15c-editor-verdict-round-2");
  });

  it("an editor still asking for changes on the last round ships FLAGGED with the notes attached, never held", async () => {
    const notes = ["Still generic in the lead."];
    const router = fakeRouterSequence([
      finalTurn(goodEditionPlan()),
      finalTurn(draft()),
      finalTurn(revisingEditorVerdict(notes)),
      finalTurn(draft()),
      finalTurn(revisingEditorVerdict(notes)),
      finalTurn(draft()),
      finalTurn(revisingEditorVerdict(notes)),
    ]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router }),
      { ...params, runId: "nl_rounds_flagged" },
    );
    // Taste does not block a person: the run pauses for the human gate as usual.
    expect(result.status).toBe("awaiting_gate");
    expect(router.complete).toHaveBeenCalledTimes(7);
    const gate = await durableStore.getGate("nl_rounds_flagged__16-batch-review-r0");
    expect(gate).toBeDefined();
    const payload = gate!.payload as { editorial?: { verdict: string; flagged: boolean; rounds: number; notes: string[] }; planThesis: string };
    expect(payload.editorial).toMatchObject({ verdict: "revise", flagged: true, rounds: 3, notes });
    expect(payload.planThesis).toBe(goodEditionPlan().thesis);
  });

  it("the plan reaches the draft and the editor, and the draft's research digest carries every query's sources", async () => {
    const router = fakeRouterSequence([finalTurn(goodEditionPlan()), finalTurn(draft()), finalTurn(approvingEditorVerdict())]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true }),
      { ...params, runId: "nl_rounds_plan" },
    );
    expect(result.status).toBe("completed");
    const prompts = calls(router);
    // The plan prompt sees the research; the draft prompt sees the plan; the editor sees both the draft and the plan.
    expect(prompts[0]).toContain('"research"');
    expect(prompts[1]).toContain(goodEditionPlan().thesis);
    expect(prompts[2]).toContain('"draft"');
    expect(prompts[2]).toContain(goodEditionPlan().thesis);

    // Research asked several questions and merged them: more than one query, more documents than one pull returns.
    const queries = (await durableStore.getStep("nl_rounds_plan", "04-plan-research"))?.output as string[];
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries[0]).toBe("B2B SaaS industry and company update digest");
    const research = (await durableStore.getStep("nl_rounds_plan", "04-research-pull"))?.output as { result?: { documents?: unknown[] } };
    expect(research.result?.documents?.length).toBeGreaterThan(2);
  });
});
