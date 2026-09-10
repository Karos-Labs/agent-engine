import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  buildLanguageFluencySystemPrompt,
  checkExpectedScript,
  languageGateText,
  resolveExpectedScript,
  LANGUAGE_FLUENCY_OUTPUT_FIELDS,
  LANGUAGE_FLUENCY_RETRY_SUFFIX,
  MIN_EXPECTED_SCRIPT_RATIO,
} from "../src/workflow/language-gate.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
  SIX_RESEARCH_FACTS,
  copyTurnInputs,
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
 * SCRUM-310 (AU32) — the language-compliance gate, both stages, both halves.
 *
 * The client here is modelled on the real one the gate exists for: geektime,
 * a Hebrew-only outlet whose carousel shipped in fluent English because no
 * language dimension existed anywhere in the QA chain.
 *
 * Stage 1 (`07e-language-script`) is deterministic and is NEVER stubbed in
 * this file — the English fixtures really are checked by the real code.
 * Stage 2 (`07f-language-fluency`) is a model call, stubbed through this
 * package's established `fakeRouterSequence`/`finalTurn` helpers (the same
 * mechanism `visual-qa-retry.test.ts` uses for `instagram-visual-qa`), so
 * nothing here depends on a live model.
 *
 * Instagram upgrade 2026-09 (brief item B): the gate is now ALWAYS ON for a
 * non-English client and FAILS CLOSED. Step 02d resolves the language from
 * the brand kit, the profile, the voice rules and the brand-voice document
 * (`resolveTargetLanguage`), so geektime — whose Hebrew is stated only in
 * profile prose — gets the gate without anyone filling in `brand.language`;
 * and a stage-2 judge that cannot run is a failed attempt, not a pass,
 * after one in-step retry. The audit found the gate had run in none of ten
 * sampled prep runs, which is what the second half of this file pins.
 */

/** The brand kit a Hebrew-only client has: `language` is AU31's structured field, read by step 02d. */
const HEBREW_BRAND = { name: "Geektime", language: "Hebrew" };

/** geektime as it actually is in the portal: the language is in the profile blurb and `brand.language` is unset. */
const GEEKTIME_PROFILE = {
  name: "Geektime",
  industry: "technology media",
  description: "Israel's largest Hebrew-language technology site, covering startups, venture capital and the people behind them.",
};

/** A client whose profile is written in a script several languages share — the one case 02d must refuse to guess. */
const CYRILLIC_PROFILE = {
  name: "Технологии сегодня",
  description:
    "Ежедневное издание о технологиях, стартапах и венчурных инвестициях. Мы пишем коротко и по делу, без рекламных штампов, для инженеров и основателей компаний.",
};

/** Malformed against the judge's own output schema -> `content_fail` -> this gate's `error`. */
const JUDGE_ERROR_TURN = { nonsense: true };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/**
 * Fluent, ordinary Hebrew: a real caption and six real slide bodies, one per
 * research fact. `sourceRef` stays the English fact claim verbatim — step 07
 * requires that, the field is never rendered, and the gate deliberately does
 * not read it.
 */
const GOOD_HEBREW_BODIES = [
  "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע ארבע שעות בכל שבוע.",
  "צוות התמיכה שלנו סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך המיון החדש.",
  "לקוחות שעברו הטמעה עם רשימת הבדיקה החדשה הגיעו לערך הראשון שלהם מהר יותר בפעמיים.",
  "סקרים פנימיים הראו עלייה של עשרים וחמישה אחוז בשביעות הרצון של הצוות אחרי שינוי התהליך.",
  "צוות העיצוב צמצם את סבבי התיקונים מחמישה סבבים לשניים בממוצע.",
  "זמן ההטמעה ירד מארבעה עשר ימים לשבעה ימים אחרי ההשקה.",
];

/**
 * Hebrew script, broken Hebrew: real words in mangled agreement and word
 * order, the shape a model produces when it is translating word by word
 * instead of writing. Passes the script check (every letter is Hebrew) and
 * is exactly what stage 2 exists to catch.
 */
const BAD_HEBREW_BODIES = [
  "צוותים אשר אוטומטי הדוח השבועי היה, חסכה ארבע שעה בתוך שבועות, וזה הוא טוב עבור של החברה.",
  "התמיכה צוות סגרה שלושים האחוז יותר של פניות, אחרי אשר עברנו אל תהליך מיון החדשה מאוד.",
  "לקוחות אשר הטמעה עשה עם הרשימה בדיקה, הגיע ערך ראשונה שלהם יותר מהר בשני של ימים.",
  "סקר פנימי הראה עלייה של עשרים וחמש אחוזים בתוך שביעות רצון הצוות, אחרי אשר התהליך שונה היה.",
  "העיצוב צוות צמצמה את הסבבים תיקונים, מן חמישה אל שניים, בתוך ממוצע של הרבעון האחרונה.",
  "הזמן של ההטמעה ירדה מן ארבעה עשר של ימים, אל שבעה ימים, אחרי אשר ההשקה קרה.",
];

function hebrewCopy(bodies: readonly string[], caption: string): InstagramCopyOutput {
  const base = goodCopyOutput();
  return {
    format: "carousel",
    caption,
    slides: base.slides.map((slide, i) => ({
      ...slide,
      headline: `ממצא מספר ${slide.n}`,
      body: bodies[i]!,
      // Unchanged on purpose: `sourceRef` must match a step-04 research
      // fact's claim verbatim, and `visualNeed` is a stock-photo query.
      sourceRef: SIX_RESEARCH_FACTS[i]!.claim,
    })),
  };
}

const goodHebrewCopy = () => hebrewCopy(GOOD_HEBREW_BODIES, "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה, ועל מה שצוותים עשו אחרת.");
const badHebrewCopy = () => hebrewCopy(BAD_HEBREW_BODIES, "מבט של קצר על השינויים אשר בתוך תהליכי עבודה, אשר באמת עשה את ההבדל בתוך הרבעון הזה של אחרון.");

/**
 * Grammatical Hebrew that is an English draft rendered clause by clause: the
 * one failure mode a proofreader also passes, which is why the rubric has to
 * ask about it by name (`buildLanguageFluencySystemPrompt`'s translationese
 * bullet) and why the copy prompt (@12 §16) promises this exact wording as a
 * redraft steer.
 */
const TRANSLATIONESE_VERDICT = {
  fluent: false,
  issues: ["reads as word by word translation of English marketing copy", "calqued idiom and English clause order throughout the slides"],
  evidence: "אנחנו לוקחים את השיווק שלך לרמה הבאה",
};

const FLUENT_VERDICT = { fluent: true, issues: [] };
const NOT_FLUENT_VERDICT = {
  fluent: false,
  issues: ["broken agreement and word order throughout", "reads as word-by-word machine translation"],
  evidence: "צוותים אשר אוטומטי הדוח השבועי היה",
};

// ─────────────────────────────────────────────────────────────────────────
// Stage 1, in isolation: pure, deterministic, no model, no workflow.
// ─────────────────────────────────────────────────────────────────────────

describe("stage 2's rubric — the questions the judge is actually asked", () => {
  it("asks about translationese, the failure every other bullet passes", () => {
    const prompt = buildLanguageFluencySystemPrompt("Hebrew");
    expect(prompt).toMatch(/word-for-word translation of English rather than Hebrew as a native writer would say it/);
    expect(prompt).toMatch(/calqued idiom/);
    expect(prompt).toMatch(/English clause order that is grammatical but not natural/);
    // The closing "say so if it reads well" line must not undo the bullet:
    // grammar and phrasing are two bars, and a draft can pass one and fail
    // the other.
    expect(prompt).toMatch(/"natural" is the bar for phrasing/);
    // The four older categories are unchanged.
    expect(prompt).toMatch(/not in Hebrew at all/);
    expect(prompt).toMatch(/grammatically broken/);
    expect(prompt).toMatch(/word-salad or machine-translated nonsense/);
    expect(prompt).toMatch(/transliterated into another script/);
    // The structured output contract names it too, so the judge has a word
    // for it in `issues` and the redraft steer quotes something actionable.
    const issues = LANGUAGE_FLUENCY_OUTPUT_FIELDS.find((f) => f.name === "issues");
    expect(issues?.description).toMatch(/translationese/);
  });
});

describe("stage 1 — checkExpectedScript (deterministic, no model call)", () => {
  const goodHebrewText = languageGateText(goodHebrewCopy());
  const englishText = languageGateText(goodCopyOutput());

  it("passes real Hebrew copy for a Hebrew client", () => {
    expect(checkExpectedScript(goodHebrewText, "Hebrew")).toEqual({ ok: true });
  });

  it("FAILS English copy for a Hebrew client, naming the script and the ratio", () => {
    const verdict = checkExpectedScript(englishText, "Hebrew");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not written in the Hebrew script/);
    expect(verdict.reason).toMatch(/0%\) are Hebrew/);
  });

  it("resolves the language from a BCP-47 tag as well as a plain name", () => {
    expect(resolveExpectedScript("he-IL")?.name).toBe("Hebrew");
    expect(resolveExpectedScript("he")?.name).toBe("Hebrew");
    expect(resolveExpectedScript("HEBREW")?.name).toBe("Hebrew");
    expect(checkExpectedScript(englishText, "he-IL").ok).toBe(false);
  });

  it("is symmetric: Hebrew copy for an English client fails too", () => {
    expect(checkExpectedScript(goodHebrewText, "English").ok).toBe(false);
    expect(checkExpectedScript(englishText, "English")).toEqual({ ok: true });
  });

  it("tolerates the Latin-script product names real Hebrew tech copy is full of", () => {
    const mixed = `${goodHebrewText}\n\nOpenAI Anthropic Google Gemini Claude Vertex Kubernetes`;
    const letters = mixed.match(/\p{L}/gu)!.length;
    const hebrew = mixed.match(/\p{Script=Hebrew}/gu)!.length;
    expect(hebrew / letters).toBeGreaterThan(MIN_EXPECTED_SCRIPT_RATIO);
    expect(checkExpectedScript(mixed, "Hebrew")).toEqual({ ok: true });
  });

  it("has no opinion about a language it has never heard of, rather than failing every draft", () => {
    expect(checkExpectedScript(englishText, "Klingon")).toEqual({ ok: true });
    expect(resolveExpectedScript("Klingon")).toBeUndefined();
  });

  it("has no opinion about text too short to judge", () => {
    expect(checkExpectedScript("Acme Q3", "Hebrew")).toEqual({ ok: true });
  });

  it("reads the caption and on-image prose only — never sourceRef or visualNeed", () => {
    const text = languageGateText(goodHebrewCopy());
    expect(text).toContain("ממצא מספר 1");
    expect(text).toContain(GOOD_HEBREW_BODIES[0]);
    expect(text).not.toContain(SIX_RESEARCH_FACTS[0]!.claim);
    expect(text).not.toContain(goodCopyOutput().slides[0]!.visualNeed);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Both stages, end to end, through the real workflow.
// ─────────────────────────────────────────────────────────────────────────

describe("07e/07f — the language-compliance gate in the instagram self-check loop", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
  }

  it("PASSES: good Hebrew clears stage 1 deterministically and stage 2's judge, and the run completes", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_pass", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + copy + vet + relevance + fluency judge + QA (Phase 0: the scout runs on every run and the relevance judge on every attempt).
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    // One pass only: nothing sent it back to step 05.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: string };
    expect(language.output).toBe("Hebrew");
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    const fluency = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as {
      output: { finalOutput: { fluent: boolean } };
    };
    expect(fluency.output.finalOutput.fluent).toBe(true);
    // The gate ran BEFORE the render, which is the whole point.
    expect(stepIds.indexOf("07f-language-fluency-attempt-1")).toBeLessThan(stepIds.indexOf("08-render-carousel-attempt-1"));
  }, 60000);

  it("FAILS stage 1: an English draft for a Hebrew client never reaches the judge, never renders, and holds", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // Three full attempts of copy + vetting and NOT ONE fluency turn — the
    // deterministic stage rejects each draft before stage 2 costs anything.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
    ]);
    const params = { runId: "instagram_run_lang_script_fail", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);
    expect(result.reason).toMatch(/deterministic language\/script check/i);
    expect(result.reason).toMatch(/not written in the Hebrew script/i);

    // Stage 2 was never asked, and neither was the relevance judge (07e fails before 07g): scout + research + 3 x (copy + vetting).
    expect(router.complete).toHaveBeenCalledTimes(8);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07e-language-script-attempt-3");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");

    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean; reason: string } };
    expect(script.output.ok).toBe(false);
    expect(script.output.reason).toMatch(/only 0\//);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  it("FAILS stage 2: Hebrew-script nonsense clears the script check and is caught by the judge, then holds", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(NOT_FLUENT_VERDICT),
    ]);
    const params = { runId: "instagram_run_lang_fluency_fail", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/not fluent Hebrew on attempt 3/i);
    expect(result.reason).toMatch(/machine translation/i);
    // A `not_fluent` verdict is a verdict: no in-step retry is spent on it. scout + research + 3 x (copy + vet + relevance + judge).
    expect(router.complete).toHaveBeenCalledTimes(14);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Stage 1 passed on every attempt — the copy really is in Hebrew script.
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    expect(stepIds).toContain("07f-language-fluency-attempt-3");
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");
  }, 60000);

  it("PASSES stage 2 on a redraft: bad Hebrew is sent back to step 05 and good Hebrew ships", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_redraft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + (copy + vet + relevance + judge) + (copy + vet + relevance + judge + QA).
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(11);

    const first = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as { output: { finalOutput: { fluent: boolean } } };
    expect(first.output.finalOutput.fluent).toBe(false);
    const second = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-2")) as { output: { finalOutput: { fluent: boolean } } };
    expect(second.output.finalOutput.fluent).toBe(true);

    // The redraft is NOT blind (spec B: "returns the draft to 05 with the
    // findings"): attempt 2's copy prompt carries the judge's issues and its
    // evidence as `selfCheckSteer` (prompt §16); attempt 1's carried nothing.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(2);
    expect(copyInputs[0]!["selfCheckSteer"]).toBeUndefined();
    const steer = copyInputs[1]!["selfCheckSteer"];
    expect(typeof steer).toBe("string");
    expect(steer).toMatch(/not fluent Hebrew/);
    for (const issue of NOT_FLUENT_VERDICT.issues) expect(steer).toContain(issue);
    expect(steer).toContain(NOT_FLUENT_VERDICT.evidence);
    // The two prompts differ by exactly that: same brief, same facts, same topic.
    expect(copyInputs[1]!["clientBrief"]).toEqual(copyInputs[0]!["clientBrief"]);
    expect(copyInputs[1]!["topic"]).toEqual(copyInputs[0]!["topic"]);
  }, 60000);

  it("TRANSLATIONESE: a grammatical but word-by-word Hebrew draft is returned to 05 with the finding the copy prompt promises", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      // Fluent Hebrew SCRIPT and fluent Hebrew GRAMMAR: stage 1 passes, and
      // every pre-2026-09-10 rubric bullet passes it too. Only the
      // translationese bullet can fail this draft.
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(TRANSLATIONESE_VERDICT),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_translationese", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // The script check had no complaint on either attempt: this is stage 2's
    // finding alone.
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");

    // The steer the writer receives is the one @12 §16 tells it how to act on
    // ("a fluency finding that says the copy 'reads as word by word
    // translation' means those slides are rewritten as a native writer would
    // say them"), quoted verbatim rather than paraphrased.
    const steer = copyTurnInputs(router)[1]!["selfCheckSteer"];
    expect(steer).toMatch(/reads as word by word translation/);
    expect(steer).toContain(TRANSLATIONESE_VERDICT.issues[1]);
    expect(steer).toContain(TRANSLATIONESE_VERDICT.evidence);
  }, 60000);

  it("a transient judge failure is retried once inside the same 07f step: two router turns, no redraft, and the run passes", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_judge_retry", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + copy + vet + relevance + TWO judge calls + QA: the retry is a real
    // second model call, not a replay of the first checkpoint.
    expect(router.complete).toHaveBeenCalledTimes(8);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("08-render-carousel-attempt-1");

    const first = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as { status: string };
    expect(first.status).toBe("content_fail");
    const retry = (await durableStore.getStep(params.runId, `07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`)) as {
      output: { finalOutput: { fluent: boolean } };
    };
    expect(retry.output.finalOutput.fluent).toBe(true);
  }, 60000);

  // ── Fail closed (inverts the former "a judge that cannot complete never blocks a draft") ──
  //
  // These three need the integrator's 07f change (`fluency.status !== "fluent"`
  // -> lastSelfCheckReason + continue) — see WP0-2's integrationNotes. Until
  // that lands they fail, which is the correct signal: the old fail-open
  // posture is exactly what let unverified Hebrew ship.

  it("FAILS CLOSED: a judge that errors twice on attempt 1 sends the draft back to step 05, and a working judge on attempt 2 ships it", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_judge_error", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + (copy + vet + relevance + judge + judge retry) + (copy + vet + relevance + judge + QA).
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(12);
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("07f-language-fluency-attempt-2");
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-2${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).toContain("08-render-carousel-attempt-2");
    // The outage is named to the writer too, so a redraft after a judge
    // failure is not mistaken for a copy problem by the model either.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(2);
    expect(copyInputs[1]!["selfCheckSteer"]).toMatch(/fluency judge could not run/);
  }, 60000);

  it("FAILS CLOSED: a judge that errors on every attempt holds the run, and the reason names the outage, not the copy", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const attemptTurns = () => [finalTurn(goodHebrewCopy()), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()), finalTurn(JUDGE_ERROR_TURN), finalTurn(JUDGE_ERROR_TURN)];
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...attemptTurns(), ...attemptTurns(), ...attemptTurns()]);
    const params = { runId: "instagram_run_lang_judge_outage", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);
    expect(result.reason).toMatch(/could not run/i);
    expect(result.reason).toMatch(/Hebrew/);
    // scout + research + 3 x (copy + vet + relevance + judge + judge retry). Every attempt
    // paid for the retry before giving up on the judge.
    expect(router.complete).toHaveBeenCalledTimes(17);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain(`07f-language-fluency-attempt-3${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  // ── Always on: 02d resolves the language from more than `brand.language` ──
  //
  // These two need the integrator's 02d rewrite (`resolveTargetLanguage` over
  // brand + profile + voice rules + brand-voice doc, WorkflowHeld on
  // `unresolved-non-english`) — see WP0-2's integrationNotes.

  it("ALWAYS ON: a geektime-shaped client with NO brand.language gets the gate from its profile prose", async () => {
    // No `client/brand` at all. The profile says "Hebrew-language"; nothing
    // structured says anything. This is the real portal state that left the
    // gate off in every sampled prep run.
    await env.store.writeJson("acme", ["client", "profile"], GEEKTIME_PROFILE);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_from_profile", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + copy + vet + relevance + fluency judge + QA.
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(7);
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: string | null };
    expect(language.output).toBe("Hebrew");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
  }, 60000);

  it("HOLDS AT INTAKE: a client whose profile is written in a script several languages share holds at 02d before any copy is drafted", async () => {
    await env.store.writeJson("acme", ["client", "profile"], CYRILLIC_PROFILE);
    // No turns at all: 02d runs before research (04), so a hold there must
    // cost zero model calls.
    const router = fakeRouterSequence([]);
    const params = { runId: "instagram_run_lang_unresolved", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/target language could not be resolved/i);
    expect(result.reason).toMatch(/Cyrillic/);
    expect(result.reason).toMatch(/Russian/);
    expect(result.reason).toMatch(/brand\.language/);
    expect(router.complete).toHaveBeenCalledTimes(0);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("05-write-copy-attempt-1");
    expect(stepIds).not.toContain("04a-research-pull");
  }, 60000);

  it("does NOT hold at 02d when one voice-rule line is Cyrillic and the profile is plainly English", async () => {
    // The intake hold is for a client whose language is a genuine unknown. A
    // single non-Latin do-list line (the sniff floor is 24 letters) used to be
    // enough to make every run for an English client unrunnable until somebody
    // edited the portal.
    await env.store.writeJson("acme", ["client", "profile"], {
      name: "Acme Analytics",
      industry: "business intelligence",
      description:
        "Acme Analytics is a business intelligence platform for retail operators. We publish practitioner guides about inventory, margin and store operations for the people who run them.",
    });
    await env.store.writeJson("acme", ["client", "voice-rules"], {
      tone: "direct",
      doList: ["Пишите коротко и по делу, без рекламных штампов и лишних слов", "lead with the number"],
    });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_one_cyrillic_line", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: string | null };
    expect(language.output).toBeNull();
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);

  it("costs nothing for an ENGLISH client that says so in its profile: no gate steps, no fluency turn, no outage hold path", async () => {
    // The gate is scoped to non-English targets. An English client naming
    // English used to resolve `targetLanguage: "English"` off the shared
    // script table's Latin row ("english" is one of its names), which turned
    // the fail-closed gate on for English runs: 07e and 07f on every attempt,
    // a Haiku call per attempt, and a hold whenever the judge was down
    // ("refusing to ship unverified English copy").
    await env.store.writeJson("acme", ["client", "profile"], {
      name: "Karos Labs",
      industry: "AI marketing",
      description: "We are an AI marketing agency for English-speaking markets in B2B SaaS. Karos Labs publishes in English for founders.",
    });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_english_client", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + copy + vet + relevance + QA. A seventh call would be
    // the fluency judge, and would exhaust the router.
    expect(router.complete).toHaveBeenCalledTimes(6);
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: string | null };
    expect(language.output).toBeNull();
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);

  it("costs nothing for a client with no evidence of a non-English language: no gate steps, no extra model call", async () => {
    // No `client/brand` and no profile written at all — the default fixture
    // client, which resolves to `english-default`.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_none", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + copy + vet + relevance + QA — and no fluency judge.
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(6);
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);
});
