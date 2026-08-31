import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosMemoryTools } from "../src/index.js";
import type { HypothesisRecord, ReadResult } from "../src/read.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("karos-memory", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosMemoryTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-memory-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosMemoryTools(store);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  describe("memory.read — beliefs", () => {
    it("returns an empty default state when nothing's been set, not not_available", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      expect(outcome).toEqual({ status: "success", result: { scope: "beliefs", beliefs: {} } });
    });

    it("reflects updateBeliefs's merge afterward", async () => {
      await tools["memory.updateBeliefs"]!.execute({ diff: { tone: "confident" } }, { ctx });
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      expect(outcome).toEqual({ status: "success", result: { scope: "beliefs", beliefs: { tone: "confident" } } });
    });
  });

  describe("memory.read — decisions / hypotheses", () => {
    it("returns an empty list (success) when nothing's been appended yet", async () => {
      const decisions = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      const hypotheses = await tools["memory.read"]!.execute({ scope: "hypotheses" }, { ctx });
      expect(decisions).toEqual({ status: "success", result: { scope: "decisions", items: [] } });
      expect(hypotheses).toEqual({ status: "success", result: { scope: "hypotheses", items: [] } });
    });

    it("lists appended decisions and hypotheses", async () => {
      await tools["memory.appendDecision"]!.execute({ decisionId: "d1", summary: "ship it" }, { ctx });
      await tools["memory.appendHypothesis"]!.execute({ hypothesisId: "h1", statement: "audience prefers video" }, { ctx });

      const decisions = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      const hypotheses = await tools["memory.read"]!.execute({ scope: "hypotheses" }, { ctx });

      expect(decisions.status).toBe("success");
      expect(hypotheses.status).toBe("success");
      const decisionsResult = (decisions as { status: "success"; result: ReadResult }).result;
      const hypothesesResult = (hypotheses as { status: "success"; result: ReadResult }).result;
      if (decisionsResult.scope === "decisions") {
        expect(decisionsResult.items).toHaveLength(1);
        expect(decisionsResult.items[0]?.summary).toBe("ship it");
      }
      if (hypothesesResult.scope === "hypotheses") {
        expect(hypothesesResult.items).toHaveLength(1);
        expect(hypothesesResult.items[0]?.status).toBe("open");
      }
    });

    it("AU12: since/limit bound decisions to the most recent matching ones", async () => {
      vi.useFakeTimers();
      const at = (ms: number) => vi.setSystemTime(new Date(ms));
      const base = Date.parse("2026-01-01T00:00:00Z");

      at(base);
      await tools["memory.appendDecision"]!.execute({ decisionId: "d1", summary: "oldest" }, { ctx });
      at(base + 1000);
      await tools["memory.appendDecision"]!.execute({ decisionId: "d2", summary: "middle" }, { ctx });
      at(base + 2000);
      await tools["memory.appendDecision"]!.execute({ decisionId: "d3", summary: "newest" }, { ctx });

      // since: only d2 and d3 were recorded at/after base+1000.
      const sinceOnly = await tools["memory.read"]!.execute({ scope: "decisions", since: base + 1000 }, { ctx });
      const sinceResult = (sinceOnly as { result: ReadResult }).result;
      if (sinceResult.scope === "decisions") {
        expect(sinceResult.items.map((i) => i.decisionId)).toEqual(["d3", "d2"]);
      }

      // limit: most-recent-first, capped at 2 — d1 (oldest) falls off.
      const limitOnly = await tools["memory.read"]!.execute({ scope: "decisions", limit: 2 }, { ctx });
      const limitResult = (limitOnly as { result: ReadResult }).result;
      if (limitResult.scope === "decisions") {
        expect(limitResult.items.map((i) => i.decisionId)).toEqual(["d3", "d2"]);
      }

      // Neither given: unbounded, original (store/id-sorted) order preserved.
      const unbounded = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      const unboundedResult = (unbounded as { result: ReadResult }).result;
      if (unboundedResult.scope === "decisions") {
        expect(unboundedResult.items.map((i) => i.decisionId)).toEqual(["d1", "d2", "d3"]);
      }
    });
  });

  describe("memory.appendDecision", () => {
    it("is idempotent on decisionId: calling twice does not create two records", async () => {
      const args = { decisionId: "d1", summary: "v1" };
      const first = await tools["memory.appendDecision"]!.execute(args, { ctx });
      const second = await tools["memory.appendDecision"]!.execute({ ...args, summary: "v2" }, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "d1", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "d1", created: false } });

      const entries = await store.listJson("acme", ["memory", "products", "linkedin", "decisions"]);
      expect(entries).toHaveLength(1);
      expect((entries[0]?.data as { summary: string }).summary).toBe("v2");
    });

    it("writes under a path segmented by ctx.productId, not just ctx.clientSlug (AU24)", async () => {
      await tools["memory.appendDecision"]!.execute({ decisionId: "d1", summary: "posted on linkedin" }, { ctx });

      expect(await store.exists("acme", ["memory", "products", "linkedin", "decisions", "d1"])).toBe(true);
      // Same client, different product: must land in a different bucket entirely.
      expect(await store.exists("acme", ["memory", "products", "x-agent", "decisions", "d1"])).toBe(false);
    });
  });

  describe("AU24: decisions are scoped by (clientSlug, productId), not clientSlug alone", () => {
    const linkedinCtx: AgentContext = { ...ctx, productId: "linkedin-agent" };
    const xAgentCtx: AgentContext = { ...ctx, productId: "x-agent" };

    it("memory.read({scope:\"decisions\"}) for one product never returns another product's rows for the same client", async () => {
      await tools["memory.appendDecision"]!.execute(
        { decisionId: "li_1", summary: 'Posted about "rollout" (archetype: teardown-framework)' },
        { ctx: linkedinCtx },
      );
      // Same client, a different product, a LATER timestamp than the LinkedIn row above
      // (appended after it) — this is exactly the shape that let a same-client,
      // different-channel decision stand in for "the last post" before the fix.
      await tools["memory.appendDecision"]!.execute(
        { decisionId: "x_1", summary: 'Posted about "roadmap" (lane: knowledge)' },
        { ctx: xAgentCtx },
      );

      const linkedinDecisions = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx: linkedinCtx });
      const xDecisions = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx: xAgentCtx });

      expect(linkedinDecisions.status).toBe("success");
      expect(xDecisions.status).toBe("success");
      const linkedinResult = (linkedinDecisions as { status: "success"; result: ReadResult }).result;
      const xResult = (xDecisions as { status: "success"; result: ReadResult }).result;
      if (linkedinResult.scope === "decisions") {
        expect(linkedinResult.items.map((i) => i.decisionId)).toEqual(["li_1"]);
      }
      if (xResult.scope === "decisions") {
        expect(xResult.items.map((i) => i.decisionId)).toEqual(["x_1"]);
      }
    });

    it("migration: pre-fix rows at the old unscoped path are not backfilled into any product's read", async () => {
      // Simulates a decision written before this fix, at the old (clientSlug-only)
      // path `memory.appendDecision` used to write to.
      await store.writeJson("acme", ["memory", "decisions", "legacy_1"], {
        decisionId: "legacy_1",
        summary: 'Posted about "old post" (archetype: teardown-framework)',
        at: Date.now() - 1_000_000,
      });

      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx: linkedinCtx });
      expect(outcome).toEqual({ status: "success", result: { scope: "decisions", items: [] } });

      // The legacy row itself is left in place, not deleted by the read.
      expect(await store.exists("acme", ["memory", "decisions", "legacy_1"])).toBe(true);
    });
  });

  describe("memory.appendHypothesis", () => {
    it("is idempotent on hypothesisId: calling twice does not create two records", async () => {
      const args = { hypothesisId: "h1", statement: "s1" };
      const first = await tools["memory.appendHypothesis"]!.execute(args, { ctx });
      const second = await tools["memory.appendHypothesis"]!.execute(args, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "h1", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "h1", created: false } });

      const entries = await store.listJson("acme", ["memory", "hypotheses"]);
      expect(entries).toHaveLength(1);
    });
  });

  describe("memory.resolveHypothesis", () => {
    it("returns not_available for an unknown id", async () => {
      const outcome = await tools["memory.resolveHypothesis"]!.execute(
        { hypothesisId: "does-not-exist", resolution: "confirmed" },
        { ctx },
      );
      expect(outcome.status).toBe("not_available");
    });

    it("transitions an existing hypothesis's status to resolved", async () => {
      await tools["memory.appendHypothesis"]!.execute({ hypothesisId: "h1", statement: "audience prefers video" }, { ctx });
      const outcome = await tools["memory.resolveHypothesis"]!.execute(
        { hypothesisId: "h1", resolution: "confirmed", evidence: ["engagement up 20%"] },
        { ctx },
      );
      expect(outcome).toEqual({ status: "success", result: { hypothesisId: "h1", status: "resolved" } });

      const stored = await store.readJson<HypothesisRecord>("acme", ["memory", "hypotheses", "h1"]);
      expect(stored?.status).toBe("resolved");
      expect(stored?.resolution).toBe("confirmed");
      expect(stored?.evidence).toEqual(["engagement up 20%"]);
      expect(stored?.statement).toBe("audience prefers video");
    });
  });

  // These two tools back the one real feedback pipeline every review-gated
  // agent uses (`packages/workflow/src/primitives/review-cycle.ts`'s
  // `persistReviewFeedbackToMemory`/`readPastFeedback`) — the replacement for
  // AU22's retired `ledger.feedbackAppend` write-only log. This package had
  // no direct test for either tool before this ticket; the agent-level
  // proof lives in `agents/intel-report-agent/__tests__/workflow-e2e.test.ts`.
  describe("memory.appendFeedback / memory.readFeedback", () => {
    it("is idempotent on feedbackId: a replayed append does not duplicate the row", async () => {
      const args = { feedbackId: "fb_1", productId: "blog-agent", decision: "approve" as const, actor: "jane@karoslabs.com", note: "v1" };
      const first = await tools["memory.appendFeedback"]!.execute(args, { ctx });
      const second = await tools["memory.appendFeedback"]!.execute({ ...args, note: "v2" }, { ctx });

      expect(first).toEqual({ status: "success", result: { id: "fb_1", created: true } });
      expect(second).toEqual({ status: "success", result: { id: "fb_1", created: false } });

      const entries = await store.listJson("acme", ["memory", "feedback"]);
      expect(entries).toHaveLength(1);
      expect((entries[0]?.data as { note: string }).note).toBe("v2");
    });

    it("reads back what was written — the write-then-read proof this pipeline exists for", async () => {
      await tools["memory.appendFeedback"]!.execute(
        { feedbackId: "fb_1", productId: "blog-agent", decision: "approve", actor: "jane@karoslabs.com", note: "shorter hooks are working", revision: 0, runId: "run_1" },
        { ctx },
      );
      await tools["memory.appendFeedback"]!.execute(
        { feedbackId: "fb_2", productId: "blog-agent", decision: "reject", actor: "jane@karoslabs.com", note: "stop leading with the metric", revision: 0, runId: "run_2" },
        { ctx },
      );

      const outcome = await tools["memory.readFeedback"]!.execute({ productId: "blog-agent", limit: 10 }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      const entries = (outcome.result as { entries: Array<{ feedbackId: string; note: string; decision: string }> }).entries;
      expect(entries.map((e) => e.feedbackId).sort()).toEqual(["fb_1", "fb_2"]);
      expect(entries.find((e) => e.feedbackId === "fb_1")?.note).toBe("shorter hooks are working");
    });

    // SCRUM-306 (AU23): `content` is the lost half of the signal — the exact
    // drafted content a decision (typically a `reject`) was about, alongside
    // the `note` explaining why. No `.min()`/length cap anywhere on this
    // field (see `AppendFeedbackInputSchema`'s own doc), and this is the
    // adversarial proof: a multi-line, unicode-bearing string with characters
    // a naive excerpting/trimming pass would be tempted to mangle, asserted
    // back with strict `toBe` (not `toContain`/`toMatchObject`) so a
    // truncated or summarized copy fails this test.
    it("persists content byte-identical — not trimmed, not truncated, not summarized (AU23)", async () => {
      const rejectedDraft = JSON.stringify({
        caption: "🚀 Limited time offer — act now!!! Don't miss out on savings up to 90%!!",
        slides: ["line one\nline two", "  leading/trailing whitespace preserved  ", "emoji: 🎉🔥✨", "quote: \"nested\" and 'single'"],
      });

      await tools["memory.appendFeedback"]!.execute(
        {
          feedbackId: "fb_content_1",
          productId: "blog-agent",
          decision: "reject",
          actor: "jane@karoslabs.com",
          note: "too promotional",
          revision: 0,
          runId: "run_content_1",
          content: rejectedDraft,
        },
        { ctx },
      );

      const outcome = await tools["memory.readFeedback"]!.execute({ productId: "blog-agent", limit: 10 }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      const entries = (outcome.result as { entries: Array<{ feedbackId: string; note: string; content?: string }> }).entries;
      const entry = entries.find((e) => e.feedbackId === "fb_content_1");
      expect(entry?.note).toBe("too promotional");
      // Byte-identical: strict equality, full length, no `.slice`/`.trim` anywhere upstream.
      expect(entry?.content).toBe(rejectedDraft);
      expect(entry?.content?.length).toBe(rejectedDraft.length);
    });

    it("omits `content` entirely when the caller doesn't attach one, rather than writing an empty/undefined placeholder", async () => {
      await tools["memory.appendFeedback"]!.execute(
        { feedbackId: "fb_no_content", productId: "blog-agent", decision: "approve", actor: "jane@karoslabs.com", note: "good" },
        { ctx },
      );
      const outcome = await tools["memory.readFeedback"]!.execute({ productId: "blog-agent", limit: 10 }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      const entries = (outcome.result as { entries: Array<{ feedbackId: string; content?: string }> }).entries;
      const entry = entries.find((e) => e.feedbackId === "fb_no_content");
      expect(entry).toBeDefined();
      expect(entry && "content" in entry).toBe(false);
    });

    it("filters by productId, so one client's other agents never see this agent's feedback", async () => {
      await tools["memory.appendFeedback"]!.execute(
        { feedbackId: "fb_blog", productId: "blog-agent", decision: "approve", actor: "jane@karoslabs.com", note: "blog note" },
        { ctx },
      );
      await tools["memory.appendFeedback"]!.execute(
        { feedbackId: "fb_reddit", productId: "reddit-agent", decision: "approve", actor: "jane@karoslabs.com", note: "reddit note" },
        { ctx },
      );

      const outcome = await tools["memory.readFeedback"]!.execute({ productId: "blog-agent", limit: 10 }, { ctx });
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      const entries = (outcome.result as { entries: Array<{ feedbackId: string }> }).entries;
      expect(entries.map((e) => e.feedbackId)).toEqual(["fb_blog"]);
    });
  });

  describe("memory.updateBeliefs", () => {
    it("merges a diff into existing beliefs without clobbering unrelated keys", async () => {
      await tools["memory.updateBeliefs"]!.execute({ diff: { a: 1 } }, { ctx });
      const outcome = await tools["memory.updateBeliefs"]!.execute({ diff: { b: 2 } }, { ctx });

      expect(outcome).toEqual({ status: "success", result: { beliefs: { a: 1, b: 2 } } });
    });
  });

  describe("tenant scoping", () => {
    it("ignores a model-supplied clientSlug override on appendDecision and writes under ctx.clientSlug instead", async () => {
      await tools["memory.appendDecision"]!.execute(
        { decisionId: "d1", summary: "ship it", clientSlug: "attacker-corp" } as never,
        { ctx },
      );

      const acmeExists = await store.exists("acme", ["memory", "products", "linkedin", "decisions", "d1"]);
      const attackerExists = await store.exists("attacker-corp", ["memory", "products", "linkedin", "decisions", "d1"]);
      expect(acmeExists).toBe(true);
      expect(attackerExists).toBe(false);
    });

    it("ignores a model-supplied clientSlug override on updateBeliefs and writes under ctx.clientSlug instead", async () => {
      await tools["memory.updateBeliefs"]!.execute({ diff: { a: 1 }, clientSlug: "attacker-corp" } as never, { ctx });

      const acmeBeliefs = await store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
      const attackerExists = await store.exists("attacker-corp", ["memory", "beliefs"]);
      expect(acmeBeliefs).toEqual({ a: 1 });
      expect(attackerExists).toBe(false);
    });
  });
});
