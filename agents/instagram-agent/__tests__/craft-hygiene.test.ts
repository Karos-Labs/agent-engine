import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { checkCraftHygiene, checkSentenceCase } from "../src/workflow/craft-hygiene.js";
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
        finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
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

    it("blocks a draft with an exclamation mark, holding the whole post after exhausting all attempts if never fixed", async () => {
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
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_craft_exhausted" });

      expect(result.status).toBe("held");
      if (result.status !== "held") throw new Error("unreachable");
      expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);

      const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_craft_exhausted", "_"]);
      expect(deliverables).toHaveLength(0);
    }, 60000);

    it("is unconditional: a client style config with NO banned_chars still blocks an em dash", async () => {
      // goodStyleConfig()'s default banned_chars is [] -- if craft hygiene were
      // driven by client config instead of unconditional, this em dash would
      // sail through untouched.
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
      const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_craft_unconditional" });

      expect(result.status).toBe("held");
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
