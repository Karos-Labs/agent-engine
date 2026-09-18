import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  checkExpectedScript,
  languageGateText,
  okAxes,
  resolveExpectedScript,
  LANGUAGE_FLUENCY_RETRY_SUFFIX,
  LANGUAGE_FLUENCY_ROUND2_SUFFIX,
  MIN_EXPECTED_SCRIPT_RATIO,
  NATIVE_EDITOR_RUBRIC_VERSION,
} from "../src/workflow/language-gate.js";
import { STEP_COST_ESTIMATES_USD } from "../src/workflow/run-budget.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
  SIX_RESEARCH_FACTS,
  copyTurnInputs,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodClientBrief,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

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
/**
 * Phase 5 note: the figures are ASCII DIGITS, not spelled out.
 *
 * `07i-value-signals`' `checkNamedSpecifics` needs at least `ceil(6 / 3) = 2`
 * slides carrying a named, checkable specific, and in a script with no case the
 * paths open to it are a numeral with a unit, a percent, a year, or one of the
 * client's own `coreTerms` - there is no capitalised-run path in Hebrew.
 * Spelling four as a word therefore reads to the floor as a slide with no
 * specific on it at all. Digits are also what a real Hebrew post uses:
 * `gate.nativeLanguage` flags FOREIGN digits, never ASCII ones, which is the
 * same fact RFC-18 section 4.2 rests `gate.numbersSourced` on.
 */
const GOOD_HEBREW_BODIES = [
  "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע 4 שעות בכל שבוע.",
  "צוות התמיכה שלנו סגר 30% יותר פניות אחרי המעבר לתהליך המיון החדש.",
  "לקוחות שעברו הטמעה עם רשימת הבדיקה החדשה הגיעו לערך הראשון שלהם 2 ימים מוקדם יותר.",
  "סקרים פנימיים הראו עלייה של 25% בשביעות הרצון של הצוות אחרי שינוי התהליך.",
  "צוות העיצוב צמצם את סבבי התיקונים מ 5 סבבים ל 2 בממוצע.",
  "זמן ההטמעה ירד מ 14 ימים ל 7 ימים אחרי ההשקה.",
];

/**
 * Hebrew script, broken Hebrew: real words in mangled agreement and word
 * order, the shape a model produces when it is translating word by word
 * instead of writing. Passes the script check (every letter is Hebrew) and
 * is exactly what stage 2 exists to catch.
 */
const BAD_HEBREW_BODIES = [
  "צוותים אשר אוטומטי הדוח השבועי היה, חסכה 4 שעה בתוך שבועות, וזה הוא טוב עבור של החברה.",
  "התמיכה צוות סגרה 30% האחוז יותר של פניות, אחרי אשר עברנו אל תהליך מיון החדשה מאוד.",
  "לקוחות אשר הטמעה עשה עם הרשימה בדיקה, הגיע ערך ראשונה שלהם יותר מהר ב 2 של ימים.",
  "סקר פנימי הראה עלייה של 25% אחוזים בתוך שביעות רצון הצוות, אחרי אשר התהליך שונה היה.",
  "העיצוב צוות צמצמה את הסבבים תיקונים, מן 5 אל 2, בתוך ממוצע של הרבעון האחרונה.",
  "הזמן של ההטמעה ירדה מן 14 של ימים, אל 7 ימים, אחרי אשר ההשקה קרה.",
];

/**
 * Six DIFFERENT Hebrew headlines, and the difference is load-bearing.
 *
 * These used to be one phrase plus a slide number, six openings from one word.
 * `07i-value-signals`' `checkRhythm` refuses that outright, and `07i` runs
 * BEFORE `07e`/`07e2` - so a Hebrew fixture that keeps the old shape never
 * reaches the language gate these tests are about at all. Slide 1 also carries
 * the contrast marker the Hebrew half of `checkCoverTension` reads.
 *
 * No nikud, no transliterations, ASCII digits only: the three things
 * `gate.nativeLanguage` reads on this same text one step later.
 */
const HEBREW_HEADLINES = [
  "תפסיקו לכתוב את הדוח ביד",
  "מיון פניות כבר בכניסה",
  "רשימת בדיקה שווה יומיים",
  "המספר שמנבא אם השינוי יחזיק",
  "חמישה סבבים הפכו לשניים",
  "קליטת לקוח בשבוע אחד",
];

function hebrewCopy(bodies: readonly string[], caption: string): InstagramCopyOutput {
  const base = goodCopyOutput();
  return {
    format: "carousel",
    caption,
    slides: base.slides.map((slide, i) => ({
      ...slide,
      headline: HEBREW_HEADLINES[i]!,
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
  native: false,
  axes: { ...okAxes(), translationese: "major" as const },
  corrections: [
    {
      target: "slide:1",
      field: "body" as const,
      // An EXACT substring of `GOOD_HEBREW_BODIES[0]`, occurring exactly once, because that is the contract
      // `applyNativeCorrections` enforces: a span that does not resolve to one place is dropped, and a test
      // that quoted a paraphrase would be testing the drop path while claiming to test the patch path.
      span: "בממוצע 4 שעות",
      replacement: "ארבע שעות בממוצע",
      axis: "translationese" as const,
      severity: "major" as const,
      why: "English clause order: a native writer puts the quantity before the qualifier here",
    },
  ],
  rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
};

/** The clean verdict. `corrections: []` and every axis `ok` — round 1 passes and no second round is paid for. */
const NATIVE_VERDICT = { native: true, axes: okAxes(), corrections: [], rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION };

/**
 * Not native, with a correction anchored in `BAD_HEBREW_BODIES[0]`.
 *
 * The correction is NOT optional decoration: `normaliseNativeEditorVerdict` resets any axis that carries no
 * correction back to `ok` and recomputes `native` from the survivors, so a verdict that flags an axis and
 * proposes nothing is read as having delivered nothing and PASSES. A fixture without a correction would
 * therefore be testing the opposite of what its name claims.
 */
const NOT_NATIVE_VERDICT = {
  native: false,
  axes: { ...okAxes(), grammar: "major" as const },
  corrections: [
    {
      target: "slide:1",
      field: "body" as const,
      span: "חסכה 4 שעה",
      replacement: "חסכו ארבע שעות",
      axis: "grammar" as const,
      severity: "major" as const,
      why: "number and gender agreement: plural subject takes a plural verb and a plural noun",
    },
  ],
  rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
};

/** A round-2 verdict that is still not native, whose span is the one the round-1 patch WROTE. */
const STILL_NOT_NATIVE_VERDICT = {
  native: false,
  axes: { ...okAxes(), register: "major" as const },
  corrections: [
    {
      target: "slide:2",
      field: "body" as const,
      span: "אחרי המעבר",
      replacement: "מאז המעבר",
      axis: "register" as const,
      severity: "major" as const,
      why: "this publication writes the temporal relation, not the event",
    },
  ],
  rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
};

// ─────────────────────────────────────────────────────────────────────────
// Stage 1, in isolation: pure, deterministic, no model, no workflow.
// ─────────────────────────────────────────────────────────────────────────

/*
 * The stage-2 RUBRIC used to be pinned here, against `buildLanguageFluencySystemPrompt`'s inline string.
 * Phase 4 moved it into a versioned `PromptStore` file (`instagram-native-editor@1`) so a six-axis rubric
 * with worked examples is reviewable, and the "a prompt in the same store as the drafting prompts can be
 * edited to agree with them" risk is answered by a guard rather than by hiding the file:
 * `__tests__/native-editor-rubric.test.ts` asserts all six axis names, the major/3x-minor verdict rule and
 * the no-finding-without-a-correction rule are present in `latest.md`.
 */

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
    expect(text).toContain(HEBREW_HEADLINES[0]!);
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
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_pass", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + angle + copy + vet + relevance + fluency judge + QA (Phase 0: the scout runs on every run and the relevance judge on every attempt; Phase 1 adds the angle proposal, once per revision).
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(12);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    // One pass only: nothing sent it back to step 05.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: { language: string; source: string } | null };
    expect(language.output?.language).toBe("Hebrew");
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    const fluency = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as {
      output: { finalOutput: { native: boolean } };
    };
    expect(fluency.output.finalOutput.native).toBe(true);
    // The gate ran BEFORE the render, which is the whole point.
    expect(stepIds.indexOf("07f-language-fluency-attempt-1")).toBeLessThan(stepIds.indexOf("08-render-carousel-attempt-1"));
  }, 60000);

  /**
   * A package a Hebrew client's `08c1` actually accepts.
   *
   * `DEFAULT_PACKAGE_TURN` is English BY CONSTRUCTION and `turns.ts` says so in as many words: `08c1` holds
   * the tags to the TARGET language's script, so a non-English fixture that inherits the default has its
   * package refused, buys the `08c-package-post-retry` turn, and `08c2` never runs. Two Latin tags is the
   * most `08c1` allows, and `founders` is one of the seeded brief's own `coreTerms`, which is the other rule
   * it enforces rather than requests.
   */
  const HEBREW_PACKAGE_TURN = {
    hashtags: ["founders", "pipeline", "תוכן", "עריכה", "קצב"],
    altText: HEBREW_HEADLINES.map((headline, i) => ({ n: i + 1, alt: `שקופית ${i + 1}: ${headline}`.slice(0, 125) })),
    firstCommentText: "המקורות לנתונים שמופיעים בשקופיות מופיעים כאן, לפי סדר הופעתם.",
  };

  it("FAILS stage 1: an English draft for a Hebrew client DELIVERS DEGRADED on the last attempt, and pays no judge to read the wrong script", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // RFC-19 §4 item 4. The deterministic stage still refuses all three drafts at
    // the same floor — `MIN_EXPECTED_SCRIPT_RATIO` does not move and 0% Hebrew is
    // 0% Hebrew. Attempts 1 and 2 are unchanged: back to `05`, no judge bought.
    // The LAST attempt is what changed. It used to `continue` into the
    // self-check-exhaustion hold; it now records `{ gate: "script", kind:
    // "wrong-script" }`, marks the language degraded and ships.
    //
    // And it ships CHEAPER than a passing run: `07g`, `07j` and `07f` are skipped
    // outright (−$0.023, §7.4), because three paid opinions about text in the
    // wrong language are three opinions nobody can act on. That saving is
    // asserted below as three absent step ids, not taken on trust.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      // The turns the fall-through buys, and the complete list of them.
      finalTurn(goodVisualQaOutput()),
      finalTurn(HEBREW_PACKAGE_TURN),
      // `08c2-package-native-round` IS bought, and that is not an oversight in
      // the skip list above: `07f` would have been asked to read the English
      // SLIDES, whereas `08c2` reads the PACKAGE — hashtags, alt text and the
      // first comment — which `08c` has just authored in Hebrew. A native round
      // over genuinely Hebrew prose is an opinion somebody can act on.
      finalTurn(NATIVE_VERDICT),
    ]);
    const params = { runId: "instagram_run_lang_script_fail", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07e-language-script-attempt-3");

    // THE PREMISE (RFC-19 §8.2 assertion 7): the gate refused the draft that
    // shipped, in its own words, measuring what it always measured.
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean; reason: string } };
    expect(script.output.ok).toBe(false);
    expect(script.output.reason).toMatch(/only 0\//);
    const script3 = (await durableStore.getStep(params.runId, "07e-language-script-attempt-3")) as { output: { ok: boolean } };
    expect(script3.output.ok).toBe(false);

    // §7.4's SAVING, asserted rather than described: not one of the three paid
    // opinions about wrong-script text was bought, on ANY attempt.
    expect(stepIds.some((id) => id.startsWith("07g-relevance"))).toBe(false);
    expect(stepIds.some((id) => id.startsWith("07j-value-judge"))).toBe(false);
    expect(stepIds.some((id) => id.startsWith("07f-language-fluency"))).toBe(false);

    // The finding, and the language marker beside it.
    const finding = result.output.selfCheck?.checks.find((c) => c.gate === "script");
    expect(finding, `checks: ${JSON.stringify(result.output.selfCheck?.checks)}`).toBeDefined();
    expect(finding!.kind).toBe("wrong-script");
    expect(finding!.detail).toMatch(/not written in the Hebrew script/i);
    // MEASURED, not asserted in prose — the gate's own coverage figure rides the
    // finding, so a reviewer reads "0/938 letters" rather than "it failed".
    expect(finding!.detail).toMatch(/only 0\/\d+ letters/);
    expect(result.output.language?.status).toBe("degraded");
    expect(result.output.language?.reason).toMatch(/not in Hebrew/i);

    // THE TURN COUNT, ENUMERATED (RFC-19 §8.2 assertion 9):
    //   scout 1 + research 1 + angle 1                                        = 3
    //   3 × (copy + vet)                                                      = 6   (07e refuses before any judge)
    //   attempt 3 falls through: visual QA                                    = 1
    //   after the loop: packager + the package's native round                 = 2
    //                                                                     total 12
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    // 2026-09-18: +1 per RETRY for `05r-revise-copy`, which every attempt after the first buys instead of a full redraft.
    expect(router.complete).toHaveBeenCalledTimes(15);

    // It rendered and it was delivered — the two things the hold used to prevent.
    expect(stepIds).toContain("08-render-carousel-attempt-3");
    expect(stepIds).toContain("09b-deliver-and-log");
    const deliverables = await env.store.listJson<{ deliverable: { selfCheck?: { checks: Array<{ kind: string }> } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.selfCheck?.checks.some((c) => c.kind === "wrong-script")).toBe(true);
  }, 60000);

  it("TWO ROUNDS THEN DELIVERS: a judge that still flags the final attempt ships the best version degraded, and NEVER holds", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // Three attempts, each paying for BOTH judge rounds: round 1 proposes a correction, the correction is
    // applied in place, round 2 judges the patched copy and is still not satisfied. On attempts 1 and 2 that
    // returns to 05; on attempt 3 - the LAST one - it DELIVERS, flagged.
    const attemptTurns = () => [
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NOT_NATIVE_VERDICT),
      finalTurn(STILL_NOT_NATIVE_VERDICT),
    ];
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      ...attemptTurns(), ...attemptTurns(), ...attemptTurns(),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_two_rounds_deliver", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // THE ASSERTION THIS WHOLE PHASE TURNS ON. A hold delivers nothing, and a person cannot reject what they
    // never received. Make the loop hold at exhaustion and this line is what refuses.
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 2 is checkpointed under its own id, on every attempt.
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    expect(stepIds).toContain(`07f-language-fluency-attempt-3${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    // Stage 1 passed every time - the copy really is in Hebrew script, so this is stage 2's finding alone.
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    // A `not_native` verdict is a verdict: no in-step retry is spent on it.
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    // It RENDERED and it DELIVERED - the two things the old hold path never reached.
    expect(stepIds).toContain("08-render-carousel-attempt-3");
    expect(stepIds).toContain("09b-deliver-and-log");

    // And it is flagged, on the artefact a human reads, with the axes and the applied/dropped counts.
    const deliverables = await env.store.listJson<{
      deliverable: { grounding?: { language?: { status: string; rounds: number; correctionsProposed: number; correctionsApplied: number; reason?: string } } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const language = deliverables[0]!.data.deliverable.grounding?.language;
    expect(language?.status).toBe("degraded");
    expect(language?.rounds).toBe(2);
    expect(language?.correctionsProposed).toBe(1);
    expect(language?.reason).toMatch(/after 2 rounds/i);
    expect(language?.reason).toMatch(/Hebrew reader should read the slides/i);
  }, 60000);

  it("PASSES on a redraft: a still-flagged attempt returns to 05 with nativeSteer carrying the quote AND the replacement", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NOT_NATIVE_VERDICT),
      finalTurn(STILL_NOT_NATIVE_VERDICT),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_redraft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const first = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as { output: { finalOutput: { native: boolean } } };
    expect(first.output.finalOutput.native).toBe(false);
    const second = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-2")) as { output: { finalOutput: { native: boolean } } };
    expect(second.output.finalOutput.native).toBe(true);
    // Attempt 2 was clean on round 1, so it paid for no second round.
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-2${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);

    // The redraft is not blind, and `nativeSteer` is a SEPARATE field from `selfCheckSteer`: a language
    // correction and a failed render rule are different remedies and one must not overwrite the other.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(2);
    expect(copyInputs[0]!["nativeSteer"]).toBeUndefined();
    const steer = copyInputs[1]!["nativeSteer"];
    expect(typeof steer).toBe("string");
    // Anchored quote THEN proposed replacement - the shape @16 section 16 tells the writer to apply.
    expect(steer).toContain(STILL_NOT_NATIVE_VERDICT.corrections[0]!.span);
    expect(steer).toContain(STILL_NOT_NATIVE_VERDICT.corrections[0]!.replacement);
    expect(copyInputs[1]!["selfCheckSteer"]).toMatch(/still reads attempt 1 as translated after two rounds/);
    // The two prompts differ by exactly that: same brief, same facts, same topic.
    expect(copyInputs[1]!["clientBrief"]).toEqual(copyInputs[0]!["clientBrief"]);
    expect(copyInputs[1]!["topic"]).toEqual(copyInputs[0]!["topic"]);
  }, 60000);

  it("CORRECTED IN PLACE: a translationese finding is patched and round 2 clears it, so the post ships corrected without a redraft", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      // Fluent Hebrew SCRIPT and fluent Hebrew GRAMMAR: stage 1 passes and so does every mechanical check.
      // Only the translationese axis can fail this draft - the failure a proofreader also passes.
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(TRANSLATIONESE_VERDICT),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_translationese", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // THE SAVING THIS PHASE IS BETTING ON: a sentence defect cost $0.014 to fix in place instead of $0.24 to
    // redraft, and the judge had already written the better sentence. NO second attempt was started.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    expect(stepIds).toContain("08-render-carousel-attempt-1");

    const deliverables = await env.store.listJson<{
      deliverable: { grounding?: { language?: { status: string; rounds: number; correctionsProposed: number; correctionsApplied: number } } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const language = deliverables[0]!.data.deliverable.grounding?.language;
    expect(language?.status).toBe("corrected");
    expect(language?.rounds).toBe(2);
    expect(language?.correctionsProposed).toBe(1);
    expect(language?.correctionsApplied).toBe(1);

    // And the correction is really IN the shipped copy, not merely counted.
    const shipped = (await durableStore.getStep(params.runId, "07c-emit-slides-data-attempt-1")) as { output: { slides: Array<{ fields?: Record<string, string> }> } };
    const bodies = shipped.output.slides.map((slide) => slide.fields?.["body"] ?? "").join(" ");
    expect(bodies).toContain(TRANSLATIONESE_VERDICT.corrections[0]!.replacement);
    expect(bodies).not.toContain(TRANSLATIONESE_VERDICT.corrections[0]!.span);
  }, 60000);

  it("a transient judge failure is retried once inside the same 07f step: two router turns, no redraft, and the run passes", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_judge_retry", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + angle + copy + vet + relevance + TWO judge calls + QA: the retry is a real
    // second model call, not a replay of the first checkpoint.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(13);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("08-render-carousel-attempt-1");

    const first = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as { status: string };
    expect(first.status).toBe("content_fail");
    const retry = (await durableStore.getStep(params.runId, `07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`)) as {
      output: { finalOutput: { native: boolean } };
    };
    expect(retry.output.finalOutput.native).toBe(true);

    // ── AND THE METER BOOKED BOTH CALLS ──
    //
    // This is the retry-then-SUCCEED path: the retry returned `native: true`,
    // so the result's `status` is NOT `"error"`. The meter used to infer the
    // call count from that status and therefore booked two vendor calls as
    // one — up to $0.084 unseen across a three-attempt Hebrew run. It now
    // bills `result.calls`, which the judge reports as a fact.
    //
    // Break it by restoring `(round1.status === "error" ? 2 : 1) * judgeUnit`
    // at the call site and this drops to 1x.
    const deliverables = await env.store.listJson<{
      deliverable: { budget: { lines: Array<{ label: string; estimateUsd: number }> } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const judgeLine = deliverables[0]!.data.deliverable.budget.lines.find((l) => l.label === "07f-language-fluency-attempt-1");
    expect(judgeLine, "the judge's own budget line").toBeDefined();
    expect(judgeLine!.estimateUsd).toBeCloseTo(2 * STEP_COST_ESTIMATES_USD.nativeJudge, 6);
  }, 60000);

  it("a judge that completes on its FIRST call is billed for exactly one — the other side of the retry rule", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_judge_single", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFor(router), params);
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{
      deliverable: { budget: { lines: Array<{ label: string; estimateUsd: number }> } };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    const judgeLine = deliverables[0]!.data.deliverable.budget.lines.find((l) => l.label === "07f-language-fluency-attempt-1");
    expect(judgeLine!.estimateUsd).toBeCloseTo(STEP_COST_ESTIMATES_USD.nativeJudge, 6);

    // ── AND 05'S ESTIMATE FLOOR CARRIES THE LANGUAGE BRIEF ──
    //
    // `copyLanguageBrief` exists as a separate key precisely because the
    // `languageBrief` field is charged per attempt on non-English runs, and
    // `rawEstimate` adds it under the same condition. Metering 05 at
    // `copyAttempt` alone made the meter and the estimator disagree about the
    // price of the same step: on an attempt where the router reports no usable
    // cost, `max(measured, estimate)` books $0.161 where the plan said $0.170.
    // Drop the conditional at the 05 `spend(...)` call and this fails.
    const copyLine = deliverables[0]!.data.deliverable.budget.lines.find((l) => l.label === "05-write-copy-attempt-1");
    expect(copyLine, "the copy step's own budget line").toBeDefined();
    expect(copyLine!.estimateUsd).toBeCloseTo(STEP_COST_ESTIMATES_USD.copyAttempt + STEP_COST_ESTIMATES_USD.copyLanguageBrief, 6);
    // The other side of the rule: the language term is a real addition, not a
    // rename of `copyAttempt`.
    expect(STEP_COST_ESTIMATES_USD.copyLanguageBrief).toBeGreaterThan(0);
  }, 60000);

  // ── Fail closed (inverts the former "a judge that cannot complete never blocks a draft") ──
  //
  // These three need the integrator's 07f change (`fluency.status !== "fluent"`
  // -> lastSelfCheckReason + continue) — see WP0-2's integrationNotes. Until
  // that lands they fail, which is the correct signal: the old fail-open
  // posture is exactly what let unverified Hebrew ship.

  it("OUTAGE WITH ATTEMPTS LEFT: a judge that errors twice on attempt 1 returns to 05 naming the OUTAGE, and attempt 2 ships", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_judge_error", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    expect(stepIds).toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("07f-language-fluency-attempt-2");
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-2${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).toContain("08-render-carousel-attempt-2");
    // The outage is named to the writer, so a redraft after a judge failure is not mistaken for a copy
    // problem by the model either.
    const copyInputs = copyTurnInputs(router);
    expect(copyInputs).toHaveLength(2);
    expect(copyInputs[1]!["selfCheckSteer"]).toMatch(/native Hebrew editor could not run/);
    // Attempt 2 was judged and cleared, so nothing degraded rides along with the shipped post.
    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { language?: { status: string } } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    expect(deliverables[0]!.data.deliverable.grounding?.language?.status).toBe("verified");
  }, 60000);

  it("OUTAGE ON THE FINAL ATTEMPT: the post ships UNVERIFIED with a ledger warn - flagged, seen by a human, never held", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // The judge is down for the whole run: the call AND its in-step retry fail on every attempt.
    const attemptTurns = () => [
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(JUDGE_ERROR_TURN),
      finalTurn(JUDGE_ERROR_TURN),
    ];
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      ...attemptTurns(), ...attemptTurns(), ...attemptTurns(),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_judge_outage", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // Phase 0 held here, and that is exactly what shipped nothing while telling nobody. "Fails closed" is
    // preserved in the sense that still matters: unverified Hebrew never ships SILENTLY. It ships FLAGGED,
    // to a run that still has a human gate at 09a.
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Every attempt paid for the in-step retry before giving up on the judge.
    expect(stepIds).toContain(`07f-language-fluency-attempt-3${LANGUAGE_FLUENCY_RETRY_SUFFIX}`);
    // An outage produces no corrections, so there is nothing to patch and no second round to pay for.
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-3${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    expect(stepIds).toContain("08-render-carousel-attempt-3");
    expect(stepIds).toContain("09b-deliver-and-log");

    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { language?: { status: string; reason?: string } } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    expect(deliverables).toHaveLength(1);
    const language = deliverables[0]!.data.deliverable.grounding?.language;
    expect(language?.status).toBe("unverified");
    expect(language?.reason).toMatch(/could not be reached/i);
    expect(language?.reason).toMatch(/never verified/i);

    // One ledger warn, keyed so a RESUME writes exactly one row - the thing that tells a person at all.
    const events = await env.store.listJson<{ level: string; message: string }>("acme", ["ledger", "events", params.runId]);
    const warns = events.filter((e) => e.data.level === "warn" && /never verified/i.test(e.data.message));
    expect(warns).toHaveLength(1);
  }, 60000);


  // ── Phase 4 (RFC-15): the ordering contract, and what each step is allowed to consume ──

  it("ORDERING: 07e -> 07e2 -> 07g -> 07f, and a 07e2 content_fail consumes ZERO relevance and ZERO judge turns", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // Hebrew script throughout, so 07e passes - and CURLY QUOTATION MARKS, which `gate.nativeLanguage`
    // rejects mechanically and no model is asked about. A draft that trips the free gate must die before the
    // $0.002 relevance judge and the $0.014 native editor, which is the entire cost argument of this phase.
    const curly = () => {
      const base = badHebrewCopy();
      // Phase 5 - the curly quotes now wrap the REAL cover headline instead of replacing it. `07i` runs
      // BEFORE `07e2`, and its `checkCoverTension` reads the cover's contrast marker: a headline that
      // dropped that marker to make room for the quotation marks would be refused one step earlier by a
      // different gate, and this test would quietly stop being about `gate.nativeLanguage` at all.
      return { ...base, slides: base.slides.map((slide, i) => (i === 0 ? { ...slide, headline: `“${HEBREW_HEADLINES[0]!}”` } : slide)) };
    };
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(curly()), finalTurn(goodImageVettingOutput()),
      finalTurn(curly()), finalTurn(goodImageVettingOutput()),
      finalTurn(curly()), finalTurn(goodImageVettingOutput()),
      // RFC-19 §4 item 5 — and ONLY attempt 3 buys any of these. The ordering
      // claim this test is named for is a claim about attempts 1 and 2, and it is
      // unchanged: a draft a regex can refuse still dies before the $0.002
      // relevance judge and the $0.014 native editor, twice. The last attempt
      // records the conventions finding and walks the rest of the way, because
      // there is no next draft for the saving to be a saving FOR.
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(HEBREW_PACKAGE_TURN), finalTurn(NATIVE_VERDICT),
    ]);
    const params = { runId: "instagram_run_lang_conventions", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e2-native-conventions-attempt-1");
    expect(stepIds).toContain("07e2-native-conventions-attempt-3");

    // THE PREMISE (RFC-19 §8.2 assertion 7): the free gate refused the draft that
    // shipped. The bar did not move — `gate.nativeLanguage` still rejects a curly
    // quotation mark mechanically, on every attempt.
    const conventions3 = (await durableStore.getStep(params.runId, "07e2-native-conventions-attempt-3")) as { output: { ok: boolean } };
    expect(conventions3.output.ok).toBe(false);
    const finding = result.output.selfCheck?.checks.find((c) => c.gate === "conventions");
    expect(finding, `checks: ${JSON.stringify(result.output.selfCheck?.checks)}`).toBeDefined();
    expect(finding!.detail).toMatch(/deterministic Hebrew conventions gate/i);
    // The gate's OWN sentence, naming the rule that fired — not a paraphrase.
    expect(finding!.detail).toMatch(/curly-quotes/);

    // ── THE ORDERING CLAIM, PRESERVED WHERE IT STILL HOLDS ──
    // Attempts 1 and 2 spend ZERO relevance and ZERO judge turns: they were
    // returned to `05` by a free gate, which is the entire cost argument of this
    // phase and is untouched. Only attempt 3 — which has no next draft to be
    // cheap for — pays.
    for (const attempt of [1, 2]) {
      expect(stepIds).not.toContain(`07g-relevance-attempt-${attempt}`);
      expect(stepIds).not.toContain(`07j-value-judge-attempt-${attempt}`);
      expect(stepIds).not.toContain(`07f-language-fluency-attempt-${attempt}`);
      expect(stepIds).not.toContain(`08-render-carousel-attempt-${attempt}`);
    }
    expect(stepIds).toContain("07g-relevance-attempt-3");
    expect(stepIds).toContain("07f-language-fluency-attempt-3");

    // THE TURN COUNT, ENUMERATED (RFC-19 §8.2 assertion 9):
    //   scout 1 + research 1 + angle 1                                        = 3
    //   3 × (copy + vet)                                                      = 6   (07e2 refuses each)
    //   attempt 3 falls through: relevance + value + native editor + visual QA = 4
    //   after the loop: packager + the package's native round                 = 2
    //                                                                     total 15
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    // 2026-09-18: +1 per RETRY for `05r-revise-copy`, which every attempt after the first buys instead of a full redraft.
    expect(router.complete).toHaveBeenCalledTimes(18);

    // And the order is the one the comment claims, measured on the checkpoints rather than asserted in prose.
    expect(stepIds.indexOf("07e-language-script-attempt-1")).toBeLessThan(stepIds.indexOf("07e2-native-conventions-attempt-1"));
    expect(stepIds.indexOf("07e2-native-conventions-attempt-3")).toBeLessThan(stepIds.indexOf("07g-relevance-attempt-3"));
    expect(stepIds.indexOf("07g-relevance-attempt-3")).toBeLessThan(stepIds.indexOf("07f-language-fluency-attempt-3"));

    // Delivered, with the truth attached.
    expect(await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"])).toHaveLength(1);
  }, 60000);

  it("ORDERING, the other half: on a draft that PASSES the free gates, 07e2 runs before 07g and 07g before 07f", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_order", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    const at = (id: string) => {
      const i = stepIds.indexOf(id);
      expect(i, `${id} never ran`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // free -> free -> $0.002 -> $0.014. Reorder any pair and this fails.
    expect(at("07e-language-script-attempt-1")).toBeLessThan(at("07e2-native-conventions-attempt-1"));
    expect(at("07e2-native-conventions-attempt-1")).toBeLessThan(at("07g-relevance-attempt-1"));
    expect(at("07g-relevance-attempt-1")).toBeLessThan(at("07f-language-fluency-attempt-1"));
    // And every one of them ran before a single pixel was rendered, which is the older contract this phase
    // extends rather than replaces: text baked into a 1080x1440 PNG is what a reviewer cannot fix in place.
    expect(at("07f-language-fluency-attempt-1")).toBeLessThan(at("08-render-carousel-attempt-1"));

    // A clean round 1 pays for NO second round.
    expect(stepIds).not.toContain(`07f-language-fluency-attempt-1${LANGUAGE_FLUENCY_ROUND2_SUFFIX}`);
    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { language?: { status: string; rounds: number } } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    const language = deliverables[0]!.data.deliverable.grounding?.language;
    expect(language?.status).toBe("verified");
    expect(language?.rounds).toBe(1);
  }, 60000);

  it("04l-language-register runs once per REVISION, outside the attempt loop, and costs nothing", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NOT_NATIVE_VERDICT),
      finalTurn(STILL_NOT_NATIVE_VERDICT),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_register_step", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // ONE checkpoint across two attempts: the register does not change between two drafts of one revision,
    // and re-deriving it per attempt would put identical checkpoints in the trace.
    expect(stepIds.filter((id) => id === "04l-language-register")).toHaveLength(1);
    expect(stepIds.indexOf("04l-language-register")).toBeLessThan(stepIds.indexOf("05-write-copy-attempt-1"));

    // The writer really received it, as a FIELD - not only as a clause inside `briefForPrompt`, which is
    // the survey gap this closes.
    const copyInputs = copyTurnInputs(router);
    expect(typeof copyInputs[0]!["languageBrief"]).toBe("string");
    expect(copyInputs[0]!["languageBrief"]).toMatch(/Hebrew/);
  }, 60000);

  it("an ENGLISH run pays for none of it: no 04l, no 07e2, no judge, and no `languageBrief` in the writer's payload", async () => {
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_english_free", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    // An eighth call would be the judge, and would exhaust the router.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(10);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("04l-language-register");
    expect(stepIds).not.toContain("07e2-native-conventions-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
    expect(copyTurnInputs(router)[0]!["languageBrief"]).toBeUndefined();

    const deliverables = await env.store.listJson<{ deliverable: { grounding?: { language?: unknown } } }>(
      "acme",
      ["ledger", "deliverables", params.runId, "_"],
    );
    expect(deliverables[0]!.data.deliverable.grounding?.language).toBeUndefined();
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
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_from_profile", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + angle + copy + vet + relevance + fluency judge + QA.
    expect(result.status).toBe("completed");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(12);
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: { language: string; source: string } | null };
    expect(language.output?.language).toBe("Hebrew");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
  }, 60000);

  /**
   * ── RFC-19 §4 item 18: still stops, and now stops HONESTLY ──
   *
   * This case used to assert `held`. Nothing about WHEN the run stops has
   * changed — 02d still refuses, before a cent is spent, and the three
   * `reason` assertions below are the same three. What changed is the WORD.
   *
   * `WorkflowHeld` is this agent's vocabulary for "a quality process reached
   * the end of its rope", and that is not what happened here. A client whose
   * profile is Cyrillic prose with no `brand.language` is a CONFIG GAP: it is
   * identical in kind to the five `WorkflowBlockedIntake` sites beside it (no
   * client config, an unparseable `instagramStyleConfig`, a canvas scale that
   * is not 2), and `zero-held-guarantee.test.ts:379` already names that class
   * in the words this now matches — "a real blockage somebody must act on".
   *
   * It is the one row of RFC-19's exit table that is NOT a quality change,
   * and the RFC says so: "one word". Filing a missing input as a malfunction
   * is how the owner's carve-out ("there is nobody to write for") ends up
   * looking like the thing the carve-out exists to forbid.
   */
  it("BLOCKS INTAKE: a client whose profile is written in a script several languages share stops at 02d before any copy is drafted", async () => {
    await env.store.writeJson("acme", ["client", "profile"], CYRILLIC_PROFILE);
    // No turns at all: 02d runs before research (04), so stopping there must
    // cost zero model calls.
    const router = fakeRouterSequence([]);
    const params = { runId: "instagram_run_lang_unresolved", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // NOT `held` — and, just as importantly, NOT `completed`. The owner's
    // requirement is that a quality verdict may not kill a run; it is not that
    // every run ships something. With no resolvable language there is nobody
    // to write FOR, and inventing one is the failure this branch prevents.
    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/target language could not be resolved/i);
    expect(result.reason).toMatch(/Cyrillic/);
    expect(result.reason).toMatch(/Russian/);
    expect(result.reason).toMatch(/brand\.language/);
    expect(router.complete).toHaveBeenCalledTimes(0);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("05-write-copy-attempt-1");
    expect(stepIds).not.toContain("04a2-research-pull-deep");
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
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_one_cyrillic_line", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: unknown };
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
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_english_client", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    // scout + research + angle + copy + vet + relevance + QA. An eighth call would be
    // the fluency judge, and would exhaust the router.
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(10);
    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: unknown };
    expect(language.output).toBeNull();
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);

  it("costs nothing for a client with no evidence of a non-English language: no gate steps, no extra model call", async () => {
    // No `client/brand` and no profile written at all — the default fixture
    // client, which resolves to `english-default`.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_none", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    // scout + research + angle + copy + vet + relevance + QA — and no fluency judge.
    expect(result.status).toBe("completed");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(10);
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);
});

describe("a brief-declared language is the RUN's language, not just the writer's", () => {
  let env: TestEnvironment;
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

  /**
   * Audit defect 5's second door. `02d` reads the brand record, the profile,
   * the voice rules and the brand-voice document; it does NOT read the
   * client's own site, and `00b1` does -- so the brief agent, told to "set the
   * language the sources clearly show they publish in" when the run resolved
   * none, can hand back `language.target: "Hebrew"` for a client whose Hebrew
   * lives only on their own pages. The copy prompt then makes that binding
   * ("`language.target`, when present, is the language of every word you
   * write"), while `07e`, `07f` and the Hebrew font stack all used to read
   * 02d's `undefined`: Hebrew copy, in the Chromium fallback face, with no
   * script check and no fluency judge at all.
   */
  it("02d resolves nothing + a brief that declares Hebrew -> 07e/07f run and the rendered template carries the Hebrew face", async () => {
    // The default fixture client: no `client/brand`, no profile prose -- 02d
    // resolves `english-default`. The persisted brief is the only thing that
    // says Hebrew.
    env = await setupTestEnvironment({
      seedBrief: goodClientBrief({ language: { target: "Hebrew", register: "ישיר, מקצועי, בגוף ראשון רבים" } }),
    });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_from_brief", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");

    // 02d itself is unchanged: it still honestly reports that nothing IT
    // reads names a language.
    const resolved = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: unknown };
    expect(resolved.output).toBeNull();

    // Both gate stages ran, on the language the writer was actually told to
    // use -- and the judge's turn is consumed, so a run that skipped the gate
    // would leave `FLUENT_VERDICT` to be read by the visual QA step instead.
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(12);
    // Nothing sent it back to 05: the language is consistent, not contested.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    // And the glyphs have a face to render in: the script font fragment is
    // spliced into the materialized template.
    const composed = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", params.runId, "slide.html"), "utf8");
    expect(composed).toContain("family=Heebo");
    expect(composed).toContain("'Heebo'");

    // The reviewer is told where the language came from and how to make it
    // explicit, rather than discovering a Hebrew post from an English client.
    const deliverables = await env.store.listJson<{
      deliverable: {
        grounding?: { targetLanguage?: string; targetLanguageSource?: string; targetLanguageNote?: string };
        post?: { status: string; hashtags: string[] };
      };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const grounding = deliverables[0]!.data.deliverable.grounding;
    expect(grounding?.targetLanguage).toBe("Hebrew");
    expect(grounding?.targetLanguageSource).toBe("brief");
    expect(grounding?.targetLanguageNote).toMatch(/brand\.language/);

    // ── WHAT THIS TEST HAS BEEN QUIETLY SHIPPING, asserted so it stops being quiet. ──
    //
    // The turn queue above inherits `DEFAULT_PACKAGE_TURN`, whose English hashtags cannot survive `08c1`'s
    // script check on a Hebrew run — `turns.ts` says exactly that about itself ("there is no
    // script-neutral hashtag"). So `08c1` refuses, the run buys `08c-package-post-retry` (that is the
    // eleventh router call this test counts, not a packager success), the re-ask has no turn queued, and
    // the post ships ABSENT: no hashtags, no alt text, no first comment. `08c2` never runs.
    //
    // This is correct fail-open behaviour and the carousel is unaffected, which is why nothing here ever
    // noticed. It is pinned rather than fixed because this test is about LANGUAGE ADOPTION and giving it a
    // real Hebrew package would change its router-call count and its subject; the block at the bottom of
    // this file covers the package round properly. If someone gives this test a Hebrew `postPackager`
    // turn, these two lines fail loudly and should simply be deleted.
    // TOP LEVEL, not under `grounding` — RFC-18 §6.6 and §12's portal contract.
    const absent = deliverables[0]!.data.deliverable.post;
    expect(absent?.status).toBe("absent");
    expect(absent?.hashtags).toEqual([]);
  }, 60000);

  it("a brief that declares English changes nothing: no gate steps, no extra model call", async () => {
    // The common case, and the reason the adoption is filtered: switching the
    // fail-closed gate on for English copy would add a Haiku call per attempt
    // and a judge-outage hold path the brief scoped to non-English targets.
    env = await setupTestEnvironment({ seedBrief: goodClientBrief({ language: { target: "en-US" } }) });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
    ]);
    const params = { runId: "instagram_run_lang_brief_english", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(10);
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);
});

/**
 * Phase 5 (RFC-18 §6.5) — `08c2-package-native-round`, THE ROUND NOTHING EVER RAN.
 *
 * This block did not exist before the integration pass, and its absence was load-bearing. Two separate
 * defects lived inside the gap:
 *
 * 1. **`instagram-native-editor@1` never told the judge the package round's target vocabulary existed.**
 *    `NativeCorrectionSchema.target` admitted `comment` and `alt:N`, `resolvePackageField` resolved them,
 *    and `NATIVE_EDITOR_RUBRIC_VERSION` was stamped `"2"` — all for a prompt change nobody made. @1
 *    documented `"caption"` and `"slide:3"` and nothing else, so the only spelling available to a judge on
 *    a package round was a carousel target, which `resolveField`'s context guard then correctly dropped. A
 *    `packageNativeJudge`-priced step that could not apply a correction on any run, in any language, ever.
 * 2. **The workflow reported that as `verified`.** `applied > 0 ? "corrected" : "verified"` cannot tell
 *    "the judge had nothing to say" from "the judge's entire opinion was thrown away" — and unlike `07e2`
 *    one round up, this round has NO round 2, so nothing re-reads the prose afterwards. Defect 1 was
 *    therefore invisible in prep telemetry by construction.
 *
 * Neither defect is detectable from inside the shipped code, and no fixture anywhere supplied a
 * `packageNative` turn, so the whole path was dark. These two tests are the light.
 */
describe("08c2 — the post package's native round, and what it is allowed to call `verified`", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * Hebrew core terms, so the package's hashtags satisfy BOTH of `08c1`'s free rules at once: at least one
   * tag derived from a core term, and every tag in the target language's script. `defaultPackageTurnFor`
   * is English by construction and `turns.ts` says so in as many words — a non-English run has to pass
   * `postPackager` explicitly or `08c1` refuses the package, buys the re-ask turn, and `08c2` never runs.
   */
  const HEBREW_CORE_TERMS = ["ציוד מסעדות", "קירור מסחרי", "תחזוקת מטבח"];

  /** An exact substring of `FIRST_COMMENT`, occurring exactly once — the contract `runPatch` enforces. */
  const COMMENT_SPAN = "לפי סדר הופעתם";
  const FIRST_COMMENT = `המקורות לשני הנתונים שמופיעים בשקופיות הראשונה והשנייה מופיעים כאן, ${COMMENT_SPAN}.`;
  const COMMENT_REPLACEMENT = "לפי הסדר שבו הם מופיעים";

  function hebrewPackageTurn(): Record<string, unknown> {
    return {
      hashtags: ["ציודמסעדות", "קירורמסחרי", "תחזוקתמטבח"],
      altText: HEBREW_HEADLINES.map((headline, i) => ({ n: i + 1, alt: `שקופית ${i + 1}: ${headline}`.slice(0, 125) })),
      firstCommentText: FIRST_COMMENT,
    };
  }

  /**
   * What `instagram-native-editor@1` produced on this round: a real objection to the first comment,
   * addressed to `"caption"` — the only target the old rubric ever named. The span is quoted out of the
   * FIRST COMMENT, because that is the text the judge was actually shown; it is the target that is wrong,
   * not the reading.
   */
  const CAROUSEL_VOCABULARY_ON_A_PACKAGE_ROUND = {
    native: false,
    axes: { ...okAxes(), register: "major" as const },
    corrections: [
      {
        target: "caption",
        field: "caption" as const,
        span: COMMENT_SPAN,
        replacement: COMMENT_REPLACEMENT,
        axis: "register" as const,
        severity: "major" as const,
        why: "compressed construct chain; the publication's own posts spell this out",
      },
    ],
    rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
  };

  /** The same objection, spelled the way `@2` teaches and `resolvePackageField` resolves. */
  const PACKAGE_VOCABULARY = {
    ...CAROUSEL_VOCABULARY_ON_A_PACKAGE_ROUND,
    corrections: [{ ...CAROUSEL_VOCABULARY_ON_A_PACKAGE_ROUND.corrections[0]!, target: "comment", field: "comment" as const }],
  };

  async function runHebrewPackageRound(runId: string, packageNativeVerdict: unknown) {
    env = await setupTestEnvironment({
      seedBrief: goodClientBrief({
        language: { target: "Hebrew", register: "ישיר, מקצועי, בגוף ראשון רבים" },
        coreTerms: HEBREW_CORE_TERMS,
      }),
    });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS),
      finalTurn(NATIVE_VERDICT),
      finalTurn(goodVisualQaOutput()),
      finalTurn(hebrewPackageTurn()),
      finalTurn(packageNativeVerdict),
    ]);
    const params = { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      params,
    );
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    const deliverables = await env.store.listJson<{
      deliverable: {
        // TOP LEVEL — RFC-18 §6.6 and §12's cross-repo portal contract.
        post?: {
          status: string;
          reason?: string;
          firstComment: { text: string };
          language?: { status: string; correctionsProposed: number; correctionsApplied: number; reason?: string };
        };
      };
    }>("acme", ["ledger", "deliverables", params.runId, "_"]);
    return { result, stepIds, post: deliverables[0]?.data.deliverable.post };
  }

  it("a round that proposed corrections and landed NONE of them is `unverified`, and the post is `partial`", async () => {
    const { result, stepIds, post } = await runHebrewPackageRound("instagram_run_pkg_native_dropped", CAROUSEL_VOCABULARY_ON_A_PACKAGE_ROUND);

    // Never held, never failed — the whole point of the phase.
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(stepIds).toContain("08c2-package-native-round");

    // The judge spoke and nothing it said reached the post.
    expect(post?.language?.correctionsProposed).toBe(1);
    expect(post?.language?.correctionsApplied).toBe(0);
    // THE ASSERTION THIS BLOCK EXISTS FOR. Under `applied > 0 ? "corrected" : "verified"` this read
    // `verified` with no reason at all — a total failure to apply, reported as a clean bill of health, on
    // a round with no second pass to catch it.
    expect(post?.language?.status).toBe("unverified");
    expect(post?.language?.reason).toMatch(/applied none of them/);
    expect(post?.language?.reason).toMatch(/Hebrew/);
    // And because `post.status` keys off `unverified`, the honest value is also the one that reaches the
    // human at `09a` instead of dying in a field nobody reads.
    expect(post?.status).toBe("partial");
    expect(post?.reason).toMatch(/applied none of them/);

    // The prose is untouched, which is what "unverified" is claiming.
    expect(post?.firstComment.text).toBe(FIRST_COMMENT);
  }, 60000);

  it("the SAME objection, spelled the way `@2` teaches, actually lands — so the test above is not merely asserting that patching is broken", async () => {
    const { result, post } = await runHebrewPackageRound("instagram_run_pkg_native_applied", PACKAGE_VOCABULARY);

    expect(result.status, JSON.stringify(result)).toBe("completed");
    // One target word and one field word apart from the fixture above, and the outcome inverts. That
    // difference IS the @1 -> @2 prompt bump, measured end to end rather than asserted about.
    expect(post?.language?.correctionsProposed).toBe(1);
    expect(post?.language?.correctionsApplied).toBe(1);
    expect(post?.language?.status).toBe("corrected");
    expect(post?.language?.reason).toBeUndefined();
    expect(post?.status).toBe("complete");

    // The first comment really was rewritten in place.
    expect(post?.firstComment.text).not.toContain(COMMENT_SPAN);
    expect(post?.firstComment.text).toContain(COMMENT_REPLACEMENT);
  }, 60000);
});
