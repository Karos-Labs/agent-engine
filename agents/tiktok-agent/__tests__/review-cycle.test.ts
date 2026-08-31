import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ZodType } from "zod";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import {
  BrandFrameInputSchema,
  CutClipInputSchema,
  SelfEvalGateInputSchema,
  TranscribeInputSchema,
  UploadDeliverableInputSchema,
} from "@agent-engine/tool-karos-video";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * SCRUM-379 (AU19 redo): tiktok-agent adopts `runReviewCycle` on top of the
 * terminal topic guardrail it already had, against main's CURRENT workflow
 * shape (the cutClip -> brandFrame -> selfEvalGate -> uploadDeliverable
 * pipeline, not the retired `video.render` one AU19's first attempt was
 * written against).
 *
 * Before this, step 11 was a single-shot approve/reject gate with no `revise`
 * path — a reviewer who wanted a different caption had no option but to reject
 * the whole clip and have someone dispatch a fresh run that knew nothing about
 * why.
 *
 * Two bug fixes ride along, and each has a test here that fails without it:
 *
 * 1. `readForbiddenTopics` was imported and never called, so
 *    `runTopicGuardrail` fell through to its own `client.getConfig` read —
 *    a duplicate config call and a `guardrail-verify-load-topics` step on
 *    every run. See "reads the client's forbidden topics once".
 * 2. Releasing the topic reservation on an `AwaitingGateSignal`. The review
 *    cycle needs a catch that hands the moment back on a rejection, a hold or
 *    a failed gate, and `step.gate`'s "throw to pause" contract routes every
 *    healthy `awaiting_gate` pause through that same catch. See "does not
 *    release the moment while a human is still looking at the clip".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

/** 90 seconds of one-second sentences, so a legal 20-120s clip exists. */
function transcriptWords(): Array<{ text: string; start: number; end: number }> {
  return Array.from({ length: 90 }, (_, i) => ({ text: `word${i}.`, start: i, end: i + 1 }));
}

const GOOD_MOMENT = {
  startSeconds: 10,
  endSeconds: 50,
  hookLine: "word10.",
  hookType: "surprising-number" as const,
  rationale: "The figure reframes the whole discussion.",
};

const FIRST_COMMENTARY = {
  caption: "Our read on this: the number is right and the conclusion is wrong. Via Jane Doe on The Show ep. 12.",
  about: "A clip where a guest gives a figure we disagree with the framing of.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

const REVISED_COMMENTARY = {
  caption: "The number holds up, the takeaway does not — here's why. Via Jane Doe on The Show ep. 12.",
  about: "A shorter, punchier take on the same disagreement, per the reviewer's note.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

const SECOND_REVISED_COMMENTARY = {
  caption: "Third pass: the figure is fine, the framing is not. Via Jane Doe on The Show ep. 12.",
  about: "Another rewrite, per the second reviewer note.",
  sourceCredit: "Jane Doe on The Show ep. 12",
};

/**
 * Answers each router call with the next candidate in order, ignoring the
 * schema — the calling sequence is deterministic, and a revision round has to
 * get a DIFFERENT commentary than the round before it or the test proves
 * nothing about re-drafting.
 */
function sequentialFakeRouter(candidates: readonly unknown[]): ModelRouter {
  const queue = [...candidates];
  return {
    async complete(_prompt, _schema, policy) {
      const next = queue.shift();
      if (next === undefined) throw new Error("sequentialFakeRouter: exhausted configured turns");
      return {
        output: { type: "final", output: next },
        modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      } as CompletionResult<unknown>;
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as ModelRouter;
}

interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
  /** Every `ledger.writeDeliverable` payload, for asserting what actually shipped. */
  deliverables: Array<Record<string, unknown>>;
  /** Every `memory.appendFeedback` payload — the durable half of the feedback flywheel. */
  feedback: Array<Record<string, unknown>>;
  /** Every object path `video.uploadDeliverable` was asked to write. */
  uploadedPaths: string[];
}

/**
 * The same discipline `workflow.test.ts` uses: every video stub validates its
 * arguments against the REAL tool's input schema, never a permissive fake, so
 * a contract drift fails here rather than in production.
 */
function stubTools(opts: { forbiddenTopics?: string[] } = {}): Harness {
  const calls: string[] = [];
  const deliverables: Array<Record<string, unknown>> = [];
  const feedback: Array<Record<string, unknown>> = [];
  const uploadedPaths: string[] = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = { verdict: "pass" as const, reason: "" };

  const tool = (name: string, run: (args: never) => unknown, schema?: ZodType) => ({
    name,
    version: "1.0.0",
    inputSchema: schema ?? { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
      if (schema) schema.parse(args);
      return run(args);
    },
  });

  const config = {
    tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] },
    ...(opts.forbiddenTopics ? { forbiddenTopics: opts.forbiddenTopics } : {}),
  };

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok(config)),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the margin call moment"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: transcriptWords() }), TranscribeInputSchema),
    "video.cutClip": tool("video.cutClip", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40 }), CutClipInputSchema),
    "video.brandFrame": tool(
      "video.brandFrame",
      (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40, applied: ["bars"] }),
      BrandFrameInputSchema,
    ),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass), SelfEvalGateInputSchema),
    "video.uploadDeliverable": tool(
      "video.uploadDeliverable",
      (args) => {
        const objectPath = (args as { objectPath: string }).objectPath;
        uploadedPaths.push(objectPath);
        return ok({ gcsUri: `gs://media/${objectPath}`, signedUrl: `https://signed.example/${objectPath}` });
      },
      UploadDeliverableInputSchema,
    ),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass)),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass)),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass)),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass)),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", (args) => {
      deliverables.push((args as { deliverable: Record<string, unknown> }).deliverable);
      return ok({ id: "deliv-1", created: true });
    }),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
    "memory.appendFeedback": tool("memory.appendFeedback", (args) => {
      feedback.push(args as unknown as Record<string, unknown>);
      return ok({ id: "fb-1" });
    }),
    "memory.readFeedback": tool("memory.readFeedback", () => ok({ entries: [] })),
  };
  return { tools: tools as unknown as AgentToolRegistry, calls, deliverables, feedback, uploadedPaths };
}

function makeWorkflow(h: Harness, candidates: readonly unknown[], autoApprove = false) {
  return createTikTokAgentWorkflow({
    tools: h.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: sequentialFakeRouter(candidates),
    ...(autoApprove ? { autoApprove: true } : {}),
  });
}

const INPUT = { sourcePath: "/tmp/episode.mp4" };

describe("tiktok-agent review cycle (runReviewCycle)", () => {
  it("rewrites the commentary and re-renders on a revise decision, then delivers on approval", async () => {
    const h = stubTools();
    // moment, then commentary r0, then commentary r1 — the order the workflow
    // itself calls the router in.
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY, REVISED_COMMENTARY]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "run-tt-revise";

    const r0 = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(r0.status).toBe("awaiting_gate");
    if (r0.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r0.pendingGateId).toContain("11-clip-review-r0");

    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Shorten the caption and lead with the disagreement, not the number.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("11-clip-review-r1");

    await engine.resolveGate(runId, "11-clip-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect((final.output as { commentary: { caption: string } }).commentary.caption).toBe(REVISED_COMMENTARY.caption);
    // What shipped is the REVISED clip, not the one the reviewer turned down.
    expect(h.deliverables).toHaveLength(1);
    expect(h.deliverables[0]).toMatchObject({ caption: REVISED_COMMENTARY.caption });

    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    // Round 1's production steps are revision-scoped, so they genuinely re-ran
    // — including a real second render, not a reused one.
    expect(ids).toContain("06-commentary");
    expect(ids).toContain("06-commentary-r1");
    expect(ids).toContain("07-compliance-r1");
    expect(ids).toContain("08-render-r1");
    expect(ids).toContain("09-qa-gate-r1");
    expect(ids).toContain("10a-upload-clip-r1");
    // Everything upstream of the production loop kept its id and ran exactly once.
    expect(ids.filter((i) => i === "03-select-moment")).toHaveLength(1);
    expect(ids).not.toContain("03-select-moment-r1");
    expect(ids.filter((i) => i === "04-cut-bounds")).toHaveLength(1);
    expect(ids).not.toContain("04-cut-bounds-r1");
    expect(ids).not.toContain("07b-load-video-brand-r1");

    // Two full renders and two uploads, one per round — and the second does
    // not overwrite the object the r0 gate record links a reviewer to.
    expect(h.calls.filter((c) => c === "video.cutClip")).toHaveLength(2);
    expect(h.calls.filter((c) => c === "video.brandFrame")).toHaveLength(2);
    expect(h.uploadedPaths).toEqual([
      `tiktok/acme/${runId}/clip.mp4`,
      `tiktok/acme/${runId}/clip-r1.mp4`,
    ]);

    // The moment was never released — a clip genuinely shipped.
    expect(h.calls).toContain("topics.commit");
    expect(h.calls).not.toContain("topics.release");
  }, 30000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const h = stubTools();
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY, REVISED_COMMENTARY]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-memory";

    await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the disagreement.",
      at: new Date().toISOString(),
    });
    await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    await engine.resolveGate(runId, "11-clip-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The disagreement framing is working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(final.status).toBe("completed");

    // A store that only remembers complaints learns a distorted version of
    // what a client wants: the approval is written too.
    expect(h.feedback.map((f) => f["decision"])).toEqual(["revise", "approve"]);
    expect(h.feedback.map((f) => f["feedbackId"])).toEqual([`${runId}-r0`, `${runId}-r1`]);
    expect(h.feedback[1]).toMatchObject({ note: "The disagreement framing is working, keep doing that." });
  }, 30000);

  it("releases the reservation on an outright rejection, exactly once, and ships nothing", async () => {
    const h = stubTools();
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-reject";

    await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "off-brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);

    expect(h.calls.filter((c) => c === "topics.release")).toHaveLength(1);
    expect(h.calls).not.toContain("topics.commit");
    expect(h.calls).not.toContain("ledger.writeDeliverable");

    // SCRUM-306 (AU23): the clip's content used to be lost the moment the run
    // held — never in `ledger.writeDeliverable` (asserted above it never
    // ran), never anywhere else durable. It must now be on the SAME feedback
    // row as the rejection reason, not a second sink.
    expect(h.feedback).toHaveLength(1);
    expect(h.feedback[0]).toMatchObject({ decision: "reject", note: "off-brand this week" });
    const content = h.feedback[0]!["content"];
    expect(typeof content).toBe("string");
    const parsedDraft = JSON.parse(content as string) as { commentary: unknown; renderedPath: unknown; uploaded: unknown };
    // The exact commentary the reviewer was shown and turned down — not a
    // paraphrase of it.
    expect(parsedDraft.commentary).toEqual(FIRST_COMMENTARY);
    expect(typeof parsedDraft.renderedPath).toBe("string");
  }, 30000);

  it("holds at the revision ceiling rather than re-rendering indefinitely, and gives the moment back", async () => {
    // Every round re-runs a paid drafting step and a full render; a reviewer
    // who keeps clicking revise would otherwise keep spending forever.
    const h = stubTools();
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY, REVISED_COMMENTARY, SECOND_REVISED_COMMENTARY]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-ceiling";

    for (const revision of [0, 1, 2]) {
      const paused = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
      expect(paused.status, `round ${revision}`).toBe("awaiting_gate");
      await engine.resolveGate(runId, `11-clip-review-r${revision}`, {
        decision: "revise",
        actor: "jane@karoslabs.com",
        feedback: `still not there (round ${revision})`,
        at: new Date().toISOString(),
      });
    }
    const result = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/ceiling/i);

    expect(h.calls.filter((c) => c === "topics.release")).toHaveLength(1);
    expect(h.calls).not.toContain("ledger.writeDeliverable");
  }, 30000);

  it("does not release the moment while a human is still looking at the clip", async () => {
    // SCRUM-379 bug 2. `step.gate` PAUSES a run by throwing
    // `AwaitingGateSignal`, and that throw travels through the same catch that
    // hands the moment back on a rejection. A catch that does not tell the two
    // apart releases the reservation of a perfectly healthy run the instant it
    // reaches a reviewer: the row goes back into the lane while the clip made
    // from it waits for approval, the next run claims the same moment, and the
    // approval that eventually lands commits a reservation that no longer
    // means anything.
    const h = stubTools();
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY]);
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "run-tt-healthy-pause";

    const paused = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(paused.status).toBe("awaiting_gate");
    // The whole assertion: a pause is not a failure, so nothing was released.
    expect(h.calls).not.toContain("topics.release");
    expect(h.calls).not.toContain("topics.commit");

    // And the reservation is still the one that gets committed when the
    // reviewer eventually says yes.
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(final.status).toBe("completed");
    expect(h.calls).not.toContain("topics.release");
    expect(h.calls.filter((c) => c === "topics.commit")).toHaveLength(1);
  }, 30000);
});

describe("tiktok-agent terminal topic guardrail", () => {
  it("reads the client's forbidden topics once, at intake, rather than a second time inside the guardrail", async () => {
    // SCRUM-379 bug 1. `readForbiddenTopics` was imported by this workflow and
    // never called, so `runTopicGuardrail` fell through to its own
    // `client.getConfig` read: a duplicate config call plus a
    // `guardrail-verify-load-topics` step on EVERY run, including the majority
    // of runs — clients who forbid nothing — where the guardrail then does not
    // run at all.
    const h = stubTools({ forbiddenTopics: ["cryptocurrency"] });
    const workflow = makeWorkflow(h, [GOOD_MOMENT, FIRST_COMMENTARY, { violatedTopics: [] }], true);
    const durableStore = new MemoryDurableStepStore();
    const runId = "run-tt-guardrail-preload";
    const result = await new WorkflowEngine(durableStore).run(workflow, { ...PARAMS, runId, input: INPUT });

    expect(result.status).toBe("completed");
    // Exactly one client.getConfig call for the whole run — the guardrail used
    // what step 00 already loaded rather than reading it again.
    expect(h.calls.filter((c) => c === "client.getConfig")).toHaveLength(1);

    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    // The guardrail genuinely ran; it just did not pay for its own config read.
    expect(ids).toContain("guardrail-verify");
    expect(ids).not.toContain("guardrail-verify-load-topics");
  }, 30000);

  it("re-verifies the REVISED caption instead of short-circuiting on round 0's guardrail checkpoint", async () => {
    // Without a per-revision step id suffix the fixed `guardrail-verify`
    // checkpoint answers for round 1 too, and the revised copy is never
    // actually checked — while the trace still reports a pass.
    const h = stubTools({ forbiddenTopics: ["cryptocurrency"] });
    const workflow = makeWorkflow(h, [
      GOOD_MOMENT,
      FIRST_COMMENTARY,
      { violatedTopics: [] },
      REVISED_COMMENTARY,
      { violatedTopics: [] },
    ]);
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "run-tt-guardrail-revision";

    await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    await engine.resolveGate(runId, "11-clip-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Shorter, please.",
      at: new Date().toISOString(),
    });
    await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    await engine.resolveGate(runId, "11-clip-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflow, { ...PARAMS, runId, input: INPUT });
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(ids).toContain("guardrail-verify");
    expect(ids).toContain("guardrail-verify-r1");
    // Still one config read for the whole run, two revision rounds included.
    expect(h.calls.filter((c) => c === "client.getConfig")).toHaveLength(1);
  }, 30000);
});
