import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MemoryTemplateStore, TemplateDefinitionSchema } from "@agent-engine/tool-karos-templates";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/**
 * The universal approve / revise / reject cycle, as instagram-agent uses it.
 *
 * `revise` exists because `reject` conflated two intentions: "this is wrong,
 * stop" and "this is close, change X". Both used to hold the run and discard
 * everything it had done, so the only way to act on feedback was to dispatch a
 * fresh run that had no idea what the feedback was.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function tools(env: TestEnvironment, extra: Record<string, unknown> = {}): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    ...extra,
  } as AgentToolRegistry;
}

/** Router turns for one full drafting pass: copy, vetting, visual QA. */
function draftTurns(copyOutput: ReturnType<typeof goodCopyOutput>) {
  return [finalTurn(copyOutput), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
}

describe("revision loop", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts with the reviewer's feedback injected, then delivers on approval", async () => {
    const first = goodCopyOutput();
    const revised = { ...first, slides: first.slides.map((s) => ({ ...s, headline: `${s.headline} (revised)` })) };

    // Two full drafting passes queued: the original and the revision.
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(first), ...draftTurns(revised)]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "revision_happy";

    // Round 0 pauses at the gate.
    const r0 = await engine.run(workflowFn, { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Open with the outcome, not the statistic.",
      at: new Date().toISOString(),
    });

    // Resuming re-drafts and pauses at the NEXT round's gate, not the same one.
    const r1 = await engine.run(workflowFn, { ...base, runId });
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("09a-batch-review-r1");

    // Nothing shipped while the revision was in flight.
    expect(await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"])).toHaveLength(0);

    await engine.resolveGate(runId, "09a-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...base, runId });
    expect(final.status).toBe("completed");

    const steps = await durableStore.listSteps(runId);
    const ids = steps.map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran
    // rather than short-circuiting on round 0's checkpoints.
    expect(ids).toContain("05-write-copy-attempt-1");
    expect(ids).toContain("05-write-copy-attempt-1-r1");
    expect(ids).toContain("07c-emit-slides-data-attempt-1-r1");
    // Everything upstream of the drafting loop kept its id and was REUSED, which
    // is the whole reason the revision is in-run rather than a fresh run.
    expect(ids.filter((i) => i === "04a-research-pull")).toHaveLength(1);
    expect(ids.filter((i) => i.startsWith("04b-research-extract-facts"))).toHaveLength(1);
    expect(ids).not.toContain("04a-research-pull-r1");

    // The delivered copy is the REVISED copy.
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1-r1")?.output as
      | { slides: Array<{ fields: Record<string, string> }> }
      | undefined;
    expect(slidesData?.slides[0]?.fields["headline"]).toContain("(revised)");
  }, 60000);

  it("passes the reviewer's words into the re-draft, and remembers them for future runs", async () => {
    const first = goodCopyOutput();
    const captured: Array<Record<string, unknown>> = [];
    // A router that records what the copy agent was actually asked.
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(first), ...draftTurns(first)]);
    const originalComplete = router.complete as unknown as (...a: unknown[]) => unknown;
    (router as { complete: unknown }).complete = (...args: unknown[]) => {
      // Every argument, stringified: which positional slot carries the payload
      // is BaseAgent's business, and asserting on a specific index would make
      // this test fail for a reason that has nothing to do with revisions.
      captured.push({ all: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? "")).join(" ") });
      return originalComplete(...args);
    };

    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "revision_feedback_injected";

    await engine.run(workflowFn, { ...base, runId });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Drop the exclamation energy and shorten every hook.",
      at: new Date().toISOString(),
    });
    await engine.run(workflowFn, { ...base, runId });

    // The revision directive reached a model call, numbered and attributed.
    const sawDirective = captured.some((c) => String(c["all"]).includes("Drop the exclamation energy"));
    expect(sawDirective).toBe(true);

    // And it is in durable client memory, so the NEXT run reads it back.
    const remembered = await env.store.listJson<{ note: string; decision: string }>("acme", ["memory", "feedback"]);
    expect(remembered.map((r) => r.data.note)).toContain("Drop the exclamation energy and shorten every hook.");
    expect(remembered.map((r) => r.data.decision)).toContain("revise");
  }, 60000);

  it("records feedback on an APPROVAL too, because a store that only remembers complaints learns a distorted picture", async () => {
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(goodCopyOutput())]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "revision_approve_feedback";

    await engine.run(workflowFn, { ...base, runId });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The shorter hooks are working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...base, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string }>("acme", ["memory", "feedback"]);
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    expect(remembered.map((r) => r.data.note)).toContain("The shorter hooks are working, keep doing that.");
  }, 60000);

  // Every round re-runs the paid drafting steps, so the loop has to be bounded
  // or a reviewer clicking revise forever spends forever.
  it("holds after the revision ceiling rather than re-drafting indefinitely", async () => {
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      ...draftTurns(copy),
      ...draftTurns(copy),
      ...draftTurns(copy),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "revision_ceiling";

    for (const round of [0, 1, 2]) {
      await engine.run(workflowFn, { ...base, runId });
      await engine.resolveGate(runId, `09a-batch-review-r${round}`, {
        decision: "revise",
        actor: "jane@karoslabs.com",
        feedback: `change number ${round + 1}`,
        at: new Date().toISOString(),
      });
    }
    const result = await engine.run(workflowFn, { ...base, runId });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/ceiling/i);
    // The hold names every request, so whoever reads it sees the whole thread.
    expect(result.reason).toContain("change number 1");
    expect(result.reason).toContain("change number 3");
  }, 90000);

  it("routes per-slide template feedback to the registry, moving that template's quality score", async () => {
    const store = new MemoryTemplateStore([
      TemplateDefinitionSchema.parse({
        id: "ai:quote:1",
        archetypeId: "quote_card",
        name: "Experimental quote card",
        layoutType: "typographic",
        htmlTemplate: "<html><head></head><body>{{quoteText}}{{attribution}}</body></html>",
        source: "ai_generated",
        qualityScore: 40,
      }),
    ]);

    const first = goodCopyOutput();
    const copy = {
      ...first,
      slides: first.slides.map((s) =>
        s.n === 2 ? { ...s, layout: "quote_card" as const, quote: { text: "Ship it.", attribution: "A lead" } } : s,
      ),
    };
    const pool = goodImageCandidatePool();
    const photoNs = first.slides.filter((s) => s.n !== 2).map((s) => s.n);
    const vetting = {
      selections: photoNs.map((n) => ({
        n,
        imagePath: pool[0]!.path,
        reason: "matches",
        license: "CC0",
        rightsUsable: true,
        watermarkFree: true,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting), finalTurn(goodVisualQaOutput())]);

    const workflowFn = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: pool,
      templateStore: store,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "revision_template_feedback";

    const r0 = await engine.run(workflowFn, { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    // The gate payload flags which slide used a template nobody has signed off
    // on — this is what the review surface renders as "new custom template on
    // slide 2".
    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { slideTemplates: Array<{ n: number; templateId?: string; isExperimental: boolean }> };
    const slide2 = payload.slideTemplates.find((s) => s.n === 2)!;
    expect(slide2.templateId).toBe("ai:quote:1");
    expect(slide2.isExperimental).toBe(true);

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      templateFeedback: [
        { slide: 2, templateId: "ai:quote:1", verdict: "approved", note: "the tighter mark reads better at feed size", promote: true },
      ],
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...base, runId });
    expect(final.status).toBe("completed");

    // The approval climbed the template's score and kept the note against it,
    // so later runs across every client prefer it a little more.
    const updated = await store.get("ai:quote:1");
    expect(updated!.qualityScore).toBe(45);
    expect(updated!.feedback.at(-1)).toMatchObject({
      actor: "jane@karoslabs.com",
      verdict: "approved",
      note: "the tighter mark reads better at feed size",
    });
  }, 60000);
});
