import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { checkCraftHygiene, checkSentenceCase, CRAFT_GATE_OUTAGE_SLUG } from "../src/workflow/craft-hygiene.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
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
import { DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
const params = { runId: "instagram_run_craft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

function copyWith(overrideBody: string, slideIndex = 0): InstagramCopyOutput {
  const copy = goodCopyOutput();
  return {
    ...copy,
    slides: copy.slides.map((s, i) => (i === slideIndex ? { ...s, body: overrideBody } : s)),
  };
}

describe("Fix 3: unconditional mechanical craft-hygiene gate (em dash / exclamation / sentence case)", () => {
  describe("checkSentenceCase (unit)", () => {
    it("passes ordinary sentence-case text", () => {
      expect(checkSentenceCase("Teams that automated their weekly reporting saved time.").ok).toBe(true);
    });

    /**
     * The allowlist has to cover the vocabulary these agents actually write in.
     * A live prep run rejected two good drafts over "DTC" and held having
     * produced nothing — each miss costs a whole run, not one flagged word.
     */
    it.each(["DTC", "ROAS", "CPA", "CTR", "CAC", "LTV", "UGC", "CRM", "KPI", "CMO"])(
      "accepts %s, which a marketing agent writes constantly",
      (acronym) => {
        expect(checkSentenceCase(`Our ${acronym} improved every quarter.`).ok).toBe(true);
      },
    );

    it("passes a term with digits because the tokeniser never yields one whole", () => {
      // Not a claim that "GA4" is allowlisted — it cannot be. The word regex
      // yields "GA", so the allowlist entry has to be "GA", and an entry
      // spelled "GA4" would be unreachable protection. Pinned so the next
      // person editing that list sees which shape actually works.
      expect(checkSentenceCase("Our GA4 property tracks it.").ok).toBe(true);
      expect(checkSentenceCase("Our A/B test won.").ok).toBe(true);
    });

    it("flags an ALL-CAPS word outside the acronym allowlist", () => {
      const result = checkSentenceCase("This is AMAZING news for the team.");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/ALL-CAPS/);
    });

    it("does not flag a short list of common acronyms", () => {
      expect(checkSentenceCase("Our AI tool saved the CEO four hours a week.").ok).toBe(true);
    });

    it("flags Title Case spam", () => {
      const result = checkSentenceCase("Five Amazing Ways To Grow Your Team This Quarter Fast");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/Title Case/);
    });
  });

  describe("checkCraftHygiene (unit, via the real gate.lintPost tool)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("catches an em dash", async () => {
      const copy = copyWith("Teams saved time — a lot of it, every single week.");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
    });

    it("catches a double-hyphen em-dash stand-in", async () => {
      const copy = copyWith("Teams saved time -- a lot of it, every week.");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
    });

    it("catches an exclamation mark", async () => {
      const copy = copyWith("Teams saved four hours a week!");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1/);
    });

    it("passes clean, ordinary slide copy", async () => {
      const result = await checkCraftHygiene(env.tools, ctx, goodCopyOutput());
      expect(result.ok).toBe(true);
    });

    it("names the failing slide by number even when it is not the first one", async () => {
      const copy = copyWith("Support tickets dropped — by a third.", 3);
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/^slide 4 failed the mechanical craft-hygiene gate: /);
      expect(result.reason).not.toMatch(/thread part/);
    });

    // ── The caption is linted too (Instagram upgrade 2026-09, brief item B) ──
    //
    // The gate used to iterate `copy.slides` only, so the one piece of copy a
    // reader sees without tapping through was never read.

    it("catches an em dash in the CAPTION and names the caption, not a slide", async () => {
      const copy = { ...goodCopyOutput(), caption: "A quick look at what changed — and what teams did differently." };
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/^caption failed the mechanical craft-hygiene gate: /);
      expect(result.reason).toMatch(/em dash/);
      expect(result.reason).not.toMatch(/slide \d/);
    });

    it("catches a caption over Instagram's 2,200-character limit", async () => {
      const sentence = "Teams that automated their weekly reporting saved four hours a week. ";
      const caption = sentence.repeat(Math.ceil(2300 / sentence.length));
      expect(caption.length).toBeGreaterThan(2200);
      const result = await checkCraftHygiene(env.tools, ctx, { ...goodCopyOutput(), caption });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/^caption failed the mechanical craft-hygiene gate: /);
      expect(result.reason).toMatch(/2200/);
    });

    it("catches shouting in the caption via the sentence-case check, naming the caption", async () => {
      const result = await checkCraftHygiene(env.tools, ctx, { ...goodCopyOutput(), caption: "STOP scrolling. This quarter's process changes, in six slides." });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/^caption failed the sentence-case check: /);
    });

    it("hashtags in the caption do not trip the sentence-case check", async () => {
      // "TLV NYC" would read as consecutive caps without the hashtag strip.
      const result = await checkCraftHygiene(env.tools, ctx, { ...goodCopyOutput(), caption: "Three lessons from a week of founder meetings. #TLV #NYC #SXSW #B2BMarketing" });
      expect(result.ok).toBe(true);
    });

    it("a Hebrew slide with a Latin acronym passes, and a Hebrew caption passes", async () => {
      const copy = {
        ...goodCopyOutput(),
        caption: "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה.",
        slides: goodCopyOutput().slides.map((s, i) =>
          i === 0 ? { ...s, headline: "ממצא מספר אחד", body: "צוותים שעברו סקירת GDPR מצאו שלושה פערים בתהליך הקליטה." } : s,
        ),
      };
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    });

    it("'GDPR IS BROKEN' still fails inside Hebrew copy", async () => {
      const copy = copyWith("הרגולטור אמר את זה בפירוש: GDPR IS BROKEN, ולא רק בישראל.");
      const result = await checkCraftHygiene(env.tools, ctx, copy);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toMatch(/slide 1 failed the sentence-case check/);
      expect(result.reason).toMatch(/consecutive ALL-CAPS/);
    });
  });

  /**
   * ── RFC-19 §3, Mechanism C: a gate that could not run has no opinion ──
   *
   * `07e2` has taken this posture since Phase 4, in its own words: "A gate that
   * could not RUN is not a verdict on the draft, and this one is free — there
   * is no spend to justify failing a run over." `gate.lintPost` is free too,
   * and this gate got it wrong in BOTH of the two shapes an outage arrives in,
   * on two adjacent lines:
   *
   * - a non-success `execute` OUTCOME threw `WorkflowToolingFailure`, ending a
   *   run that had already paid for its draft, its images and its vetting;
   * - a `tooling_error` VERDICT was converted into a CONTENT refusal whose
   *   sentence says the caption "failed the mechanical craft-hygiene gate" —
   *   about a caption the gate never read. That one is the worse of the two:
   *   it fed the redraft prompt a complaint no writer can act on, three times,
   *   and then the loop's exhaustion terminus held the run.
   *
   * `checkPostPackage` already draws exactly this line for the same tool
   * (`post-package.test.ts`), and its comment cited THIS gate's throw as the
   * correct opposite. That asymmetry is what RFC-19 removes: the argument for
   * it was "copy inside the drafting loop must not ship unchecked", and an
   * outage does not check it either way — it just decides whether the client
   * gets the post.
   */
  describe("Mechanism C: a gate.lintPost outage forms no opinion (RFC-19 §3)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    /** The two shapes an outage takes, on the two different lines they arrive on. Same shape `post-package.test.ts` uses. */
    type LintOutcome = Awaited<ReturnType<NonNullable<TestEnvironment["tools"]["gate.lintPost"]>["execute"]>>;
    const outages: ReadonlyArray<[string, LintOutcome]> = [
      ["a non-success outcome", { status: "tooling_error", reason: "lint provider unavailable" }],
      ["a `tooling_error` verdict", { status: "success", result: { verdict: "tooling_error", reason: "lint provider unavailable", toolVersion: "1.0.0" } }],
    ];

    function withOutage(env: TestEnvironment, outcome: LintOutcome): AgentToolRegistry {
      return { ...env.tools, "gate.lintPost": { ...env.tools["gate.lintPost"]!, execute: async () => outcome } } as AgentToolRegistry;
    }

    for (const [label, outcome] of outages) {
      it(`treats ${label} as a pass that SAYS it did not run, not as a refusal and not as a throw`, async () => {
        // The em dash the real gate refuses in the tests above. THE PREMISE:
        // this exact copy is proved to be a refusal when the gate is healthy,
        // so a pass here is the outage doing it, not a clean draft.
        const copy = copyWith("Teams saved time — a lot of it, every single week.");
        await expect(checkCraftHygiene(env.tools, ctx, copy)).resolves.toMatchObject({ ok: false });

        const result = await checkCraftHygiene(withOutage(env, outcome), ctx, copy);
        // Still a pass: the draft ships, because a gate that could not RUN is not a verdict on it.
        expect(result.ok).toBe(true);
        // And NOT a bare `{ ok: true }` — that is a clean bill of health the anti-slop half never gave, on a
        // draft the healthy gate is proved one line above to refuse. `outage` is what the workflow turns
        // into the `kind: "not-checked"` self-check finding the client and the `09a` reviewer both read.
        expect(result.outage).toMatch(/gate\.lintPost could not form a view/);
        // Precise about WHICH half went dark: the sentence-case checks are local code and still ran.
        expect(result.outage).toMatch(/anti-slop half recorded NO OPINION on this draft; the sentence-case checks still ran/);
      });

      it(`records ONE ledger warn naming the gate and the outage for ${label}`, async () => {
        await checkCraftHygiene(withOutage(env, outcome), ctx, goodCopyOutput());
        const events = await env.store.listJson<{ level: string; eventId: string; message: string }>("acme", ["ledger", "events", ctx.runId]);
        const warn = events.find((e) => e.data.eventId === `${ctx.runId}__${CRAFT_GATE_OUTAGE_SLUG}`);
        expect(warn, `events: ${JSON.stringify(events)}`).toBeDefined();
        expect(warn!.data.level).toBe("warn");
        expect(warn!.data.message).toMatch(/gate\.lintPost could not form a view/);
        expect(warn!.data.message).toMatch(/NO OPINION/);
        // Names WHICH outage, so a reader can tell a dead provider from a
        // provider that answered with a shrug.
        expect(warn!.data.message).toMatch(outcome.status === "success" ? /verdict: tooling_error/ : /outcome: tooling_error/);
      });

      it(`still refuses shouting for ${label} — the outage silences the tool's half, never the local half`, async () => {
        // THE ANTI-WEAKENING ASSERTION. A "no opinion" that returned early
        // would skip `checkSentenceCase`, which needs no tool at all, and the
        // gate would quietly stop enforcing the one rule it can enforce on its
        // own. The bar does not move: this draft still refuses with the gate
        // out.
        const shouting = { ...goodCopyOutput(), caption: "STOP scrolling. This quarter's process changes, in six slides." };
        const result = await checkCraftHygiene(withOutage(env, outcome), ctx, shouting);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).toMatch(/^caption failed the sentence-case check: /);
      });
    }

    it("a REGISTERED tool that failed and an UNREGISTERED tool are different things, and only the second one throws", async () => {
      // RFC-19 §6 item 8. An unregistered tool is a deploy defect: there is
      // nothing to measure the draft with and no redraft produces one. Keeping
      // this throw is what makes the no-opinion branch above a narrow decision
      // rather than "the gate stopped mattering".
      await expect(checkCraftHygiene({}, ctx, goodCopyOutput())).rejects.toThrow(/not registered/);
    });

    it("a content_fail verdict is untouched by any of this — the gate still refuses exactly what it refused", async () => {
      const refusing: LintOutcome = {
        status: "success",
        result: { verdict: "content_fail", evidence: [], reason: "thread part 2: contains an em dash", toolVersion: "1.0.0" },
      };
      const result = await checkCraftHygiene(withOutage(env, refusing), ctx, goodCopyOutput());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("slide 1 failed the mechanical craft-hygiene gate: contains an em dash");
    });
  });

  describe("wired into the workflow's retry loop (integration)", () => {
    let env: TestEnvironment;

    beforeEach(async () => {
      env = await setupTestEnvironment();
    });

    afterEach(async () => {
      await env.cleanup();
    });

    it("blocks a draft with an em dash on attempt 1, then succeeds on attempt 2 with a clean revision", async () => {
      const promptStore = makePromptStore();
      const emDashCopy = copyWith("Teams saved time — every single week, without fail.");
      const cleanCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(cleanCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const result = await engine.run(workflowFn, params);

      expect(result.status).toBe("completed");
      const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
      expect(stepIds).toContain("07b-craft-hygiene-attempt-1");
      expect(stepIds).toContain("05-write-copy-attempt-2");
      expect(stepIds).toContain("07b-craft-hygiene-attempt-2");

      const hygiene1 = (await durableStore.getStep(params.runId, "07b-craft-hygiene-attempt-1")) as { output: { ok: boolean } };
      expect(hygiene1.output.ok).toBe(false);
    }, 60000);

    /**
     * ── RFC-19 §8.6: this case used to end `held` ──
     *
     * It asserted `/self-check never passed after 3 attempt/` and that ZERO
     * deliverables existed. Three drafts were paid for, three were refused over
     * an exclamation mark, and the client received nothing. An exclamation mark
     * is EXACTLY the class the owner named: "if the score is not good then it
     * should repeat steps or do something else, but THE CLIENT CANNOT RECEIVE A
     * FAILED RUN unless it is a real fault."
     *
     * The gate is not weakened — `07b-craft-hygiene-attempt-3` still refuses,
     * and this test asserts that it did (the premise assertion, RFC-19 §8.2:
     * without it this passes just as happily when the gate silently stopped
     * running). What changed is what happens after the refusal: attempt 3 walks
     * on, the post ships, and the reviewer is handed the gate's own sentence.
     *
     * **The turn count is ENUMERATED, not observed** (RFC-19 §8.2 assertion 9,
     * §11 item 4): 3 pre-loop (scout, research, angle) + 2 per refused attempt
     * (copy, vetting) × 3 + the 3 the delivering attempt now reaches (relevance,
     * value, visual QA) + 1 packager = 13. A new model call anywhere in this
     * path exhausts the queue and this test fails loudly — which is the real
     * enforcement of RFC-19 §7's "added planned cost: $0.000000".
     */
    it("delivers a draft whose exclamation mark the gate refused on every attempt, marked degraded, rather than holding", async () => {
      const promptStore = makePromptStore();
      const shoutyCopy = copyWith("Four hours back every week!");
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(shoutyCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(shoutyCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(shoutyCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const runId = "instagram_run_craft_exhausted";
      const result = await engine.run(workflowFn, { ...params, runId });

      expect(result.status).toBe("completed");

      // THE PREMISE. The fall-through must be AFTER a refusal, not INSTEAD of
      // one — six recorded instances in this codebase of a guard that could not
      // fail say so.
      const hygiene3 = (await durableStore.getStep(runId, "07b-craft-hygiene-attempt-3")) as { output: { ok: boolean; reason?: string } };
      expect(hygiene3.output.ok).toBe(false);

      const deliverables = await env.store.listJson<{ deliverable?: { selfCheck?: { status: string; reason: string; checks: Array<Record<string, unknown>> } } }>(
        "acme",
        ["ledger", "deliverables", runId, "_"],
      );
      expect(deliverables).toHaveLength(1);
      const selfCheck = deliverables[0]!.data.deliverable?.selfCheck;
      expect(selfCheck?.status).toBe("degraded");

      // The right gate, in the gate's OWN words — `detail` is never re-worded,
      // so a reviewer reads what `07b` actually said.
      const craft = selfCheck?.checks.find((c) => c["gate"] === "craft");
      expect(craft, `checks: ${JSON.stringify(selfCheck?.checks)}`).toBeDefined();
      expect(craft!["detail"]).toBe(hygiene3.output.reason);
      expect(craft!["step"]).toBe("07b-craft-hygiene-attempt-3");

      expect(router.complete).toHaveBeenCalledTimes(13);
    }, 60000);

    /**
     * Assertion 8 (RFC-19 §8.2) for the case above: the same fixture with the
     * trigger removed must ship with NO marker at all. The marker is absent,
     * never empty, on a clean run — attaching one unconditionally is the
     * "silently shipping a bad post" failure in reverse: shouting `degraded` at
     * every clean post until nobody reads the word.
     */
    it("attaches NO selfCheck marker when the identical fixture's draft is clean", async () => {
      const promptStore = makePromptStore();
      const cleanCopy = goodCopyOutput();
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(cleanCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const runId = "instagram_run_craft_clean";
      const result = await engine.run(workflowFn, { ...params, runId });

      expect(result.status).toBe("completed");
      const hygiene1 = (await durableStore.getStep(runId, "07b-craft-hygiene-attempt-1")) as { output: { ok: boolean } };
      expect(hygiene1.output.ok).toBe(true);

      const deliverables = await env.store.listJson<{ deliverable?: { selfCheck?: unknown } }>("acme", ["ledger", "deliverables", runId, "_"]);
      expect(deliverables).toHaveLength(1);
      expect(deliverables[0]!.data.deliverable?.selfCheck).toBeUndefined();
    }, 60000);

    it("is unconditional: a client style config with NO banned_chars still refuses an em dash, and the post still ships degraded", async () => {
      // goodStyleConfig()'s default banned_chars is [] -- if craft hygiene were
      // driven by client config instead of unconditional, this em dash would
      // sail through untouched and `07b` would report `ok: true`. The
      // `ok: false` assertion below is what keeps THAT the thing under test:
      // "completed" alone would pass whether the gate refused or never looked.
      const promptStore = makePromptStore();
      const emDashCopy = copyWith("Teams saved time — every week, reliably.");
      const router = fakeRouterSequence([
        finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(emDashCopy),
        finalTurn(goodImageVettingOutput()),
        finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
      ]);
      const workflowFn = createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore,
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });

      const durableStore = new MemoryDurableStepStore();
      const engine = new WorkflowEngine(durableStore);
      const runId = "instagram_run_craft_unconditional";
      const result = await engine.run(workflowFn, { ...params, runId });

      expect(result.status).toBe("completed");
      for (const attempt of [1, 2, 3]) {
        const hygiene = (await durableStore.getStep(runId, `07b-craft-hygiene-attempt-${attempt}`)) as { output: { ok: boolean; reason?: string } };
        expect(hygiene.output.ok, `attempt ${attempt}`).toBe(false);
        expect(hygiene.output.reason).toMatch(/em dash/);
      }

      const deliverables = await env.store.listJson<{ deliverable?: { selfCheck?: { checks: Array<Record<string, unknown>> } } }>(
        "acme",
        ["ledger", "deliverables", runId, "_"],
      );
      expect(deliverables[0]!.data.deliverable?.selfCheck?.checks.some((c) => c["gate"] === "craft")).toBe(true);
    }, 60000);
  });
});

/**
 * The sentence-case check used to be fail-dangerous: any ALL-CAPS token
 * outside a hand-maintained acronym allowlist failed the gate, which routes
 * into the step-07 retry loop, so the model re-drafted, wrote the same
 * correct acronym again, and the run exhausted its budget and held.
 *
 * Prep run pubsub-21545408480430711 spent 18 minutes and three full drafting
 * passes doing that over "GDPR". An earlier run did it over "DTC".
 */
describe("checkSentenceCase: acronyms must not cost a run", () => {
  it("accepts a real acronym that nobody thought to list", () => {
    // The point is NOT that these specific words are now listed — it is that
    // an unlisted one no longer fails. `ZKPROOF` is deliberately not in any
    // allowlist.
    for (const text of [
      "Our GDPR review found three gaps.",
      "The CCPA deadline moved again.",
      "We shipped ZKPROOF support this week.",
      "Their SOC 2 audit is done.",
    ]) {
      const result = checkSentenceCase(text);
      expect(result.ok, `${text} -> ${result.ok ? "" : result.reason}`).toBe(true);
    }
  });

  it("still catches genuine emphasis shouting", () => {
    for (const text of ["STOP scrolling and read this.", "This is FREE for a limited time.", "You MUST see these numbers."]) {
      const result = checkSentenceCase(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/emphasis/i);
    }
  });

  it("catches consecutive caps words, which is what shouting actually looks like", () => {
    const result = checkSentenceCase("We got AMAZING RESULTS from one change.");
    // "AMAZING" is on the denylist, so it flags on emphasis first — either
    // reason is a correct rejection.
    expect(result.ok).toBe(false);

    // Two unlisted words adjacent: no denylist entry involved, so this proves
    // the adjacency rule independently.
    const adjacency = checkSentenceCase("The verdict was ZKPROOF BROKEN according to the audit.");
    expect(adjacency.ok).toBe(false);
    if (!adjacency.ok) expect(adjacency.reason).toMatch(/consecutive/i);
  });

  it("does not flag two acronyms sitting next to each other, since that is terminology not shouting", () => {
    expect(checkSentenceCase("Our GDPR CCPA obligations overlap.").ok).toBe(true);
    expect(checkSentenceCase("We track ROI and CAC weekly.").ok).toBe(true);
    // Two-letter acronym pairs are terminology too — nothing here is on any list.
    expect(checkSentenceCase("Our UX UI team shipped the redesign.").ok).toBe(true);
    expect(checkSentenceCase("The NYC VC scene moved to Miami.").ok).toBe(true);
  });

  it("flags a caps FUNCTION word next to a caps word: 'GDPR IS BROKEN' is shouting, whatever the allowlist says about GDPR", () => {
    // The allowlist's comment promised this for a long time while the
    // three-letter floor on the adjacency rule quietly let "IS" through.
    const result = checkSentenceCase("The verdict was GDPR IS BROKEN according to the audit.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/consecutive ALL-CAPS words.*IS BROKEN/);
    expect(checkSentenceCase("THIS IS THE moment to switch.").ok).toBe(false);
  });

  it("leaves the Title Case heuristic untouched", () => {
    const result = checkSentenceCase("Five Ways To Grow Your Team This Quarter");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/title case/i);
  });
});

/**
 * Instagram upgrade 2026-09 (brief item B): the tokeniser was `[A-Za-z]…`,
 * blind to every non-Latin letter, so for geektime's Hebrew copy the check
 * read only the Latin loanwords. It now tokenises `\p{L}` and applies the
 * case rules only to CASED tokens — a Hebrew word is neither "all caps" nor
 * "capitalised", however `toUpperCase()` happens to compare it.
 */
describe("checkSentenceCase: scripts without case", () => {
  const HEBREW = "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע ארבע שעות בכל שבוע, ולא רק בצוותי המוצר.";

  it("never reads Hebrew as shouting, even though every Hebrew word equals its own toUpperCase()", () => {
    expect(HEBREW.toUpperCase()).toBe(HEBREW);
    expect(checkSentenceCase(HEBREW).ok).toBe(true);
    expect(checkSentenceCase("שמרו את הפוסט הזה. שתפו אותו עם הצוות. ספרו לנו מה עבד אצלכם.").ok).toBe(true);
  });

  it("never reads Hebrew as Title Case, even with several Latin brand names in it", () => {
    expect(checkSentenceCase("צוות המוצר עבר מ-Google Workspace ל-Notion ו-Slack, והוסיף גם Anthropic Claude לתהליך הכתיבה השבועי.").ok).toBe(true);
    expect(checkSentenceCase(`${HEBREW} OpenAI Anthropic Google Gemini`).ok).toBe(true);
  });

  it("judges a Latin acronym inside Hebrew copy exactly as in English copy", () => {
    expect(checkSentenceCase("צוותים שעברו סקירת GDPR מצאו שלושה פערים בתהליך הקליטה.").ok).toBe(true);
    expect(checkSentenceCase("הרגולטור אמר את זה בפירוש: GDPR IS BROKEN, ולא רק בישראל.").ok).toBe(false);
    const emphasis = checkSentenceCase("זה FREE לזמן מוגבל בלבד, לכל מי שנרשם השבוע.");
    expect(emphasis.ok).toBe(false);
    if (!emphasis.ok) expect(emphasis.reason).toMatch(/emphasis/i);
  });

  it("still judges cased non-Latin scripts: Cyrillic shouting is shouting", () => {
    const result = checkSentenceCase("Это ВНИМАНИЕ СРОЧНО для всех подписчиков канала.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/consecutive ALL-CAPS/);
    expect(checkSentenceCase("Команды, автоматизировавшие отчёты, сэкономили четыре часа в неделю.").ok).toBe(true);
  });

  it("tokenises letters with curly apostrophes and hyphens as one word, so DON’T is one emphasis token", () => {
    const result = checkSentenceCase("DON’T miss the second slide.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DON’T/);
    expect(checkSentenceCase("Arabic and Thai copy is uncased too: ทีมที่ทำรายงานอัตโนมัติประหยัดเวลาได้สี่ชั่วโมงต่อสัปดาห์").ok).toBe(true);
  });
});
