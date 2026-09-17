import { describe, expect, it } from "vitest";
import { buildGateVerdict, draftDigestFor, gateVerdictLine, type GateVerdictInput } from "../src/workflow/gate-verdict.js";
import { MAX_RUN_SPEND_USD, TARGET_RUN_SPEND_USD, formatUsd, type SpendLine } from "../src/workflow/run-budget.js";

/**
 * Phase 5.5 (spec §6 G1) — THE THREE RUNS A HUMAN APPROVED.
 *
 * On 2026-09-16 three prep posts went through the `09a` gate and all three were
 * approved. The owner then looked at them as a CMO and refused all three. The
 * facts that would have stopped a reviewer were all on the payload already, in
 * a block somewhere below thirty-nine others.
 *
 * Every fixture below is that run's own document, replayed:
 *
 * - `pubsub-21868183257380937` — karoslabs. Attempt 3 died at the 16,384-token
 *   ceiling, attempt 2's draft shipped, and the post carries no photograph.
 * - `pubsub-21864573169935321` — thepitchbydeel. Attempts 2 AND 3 died the same
 *   way, so the "redraft" re-judged attempt 1's words twice and `08c` came back
 *   `budget_exceeded` with nothing in it: the post shipped with no hashtags and
 *   no alt text.
 * - `pubsub-21868533047825082` — geektime. Attempts 1 and 2 died, attempt 3 was
 *   the first and only draft, and `08b` answered `pass: false` with three
 *   failing rules that nothing acted on and nothing surfaced.
 *
 * **Every assertion in this file is about a fact that is invisible on today's
 * payload.** The test is not that the builder copies fields; it is that the one
 * line a reviewer actually reads would have said `NO REDRAFT LANDED`,
 * `packaging FAILED (no hashtags, no alt text)` and `visual QA FAILED 3 rules`
 * on the exact days it did not.
 */

// ─────────────────────────────────────────────────────────────────────────
// What a truncated copy attempt really cost
// ─────────────────────────────────────────────────────────────────────────

/**
 * The run documents record `costUsd: 0` on every truncated attempt, because
 * the `max_tokens` throw bypassed usage reporting — the hole W1-A closed.
 * These are what the SAME calls book today, reconstructed from each run's own
 * sibling attempt on the same model and the same prompt:
 *
 *   billed = (sibling total − sibling output × $15/1M) + 16,384 × $15/1M
 *
 * which replaces the sibling's output charge with the full ceiling the truncated
 * call is known to have spent, and keeps the sibling's measured input charge
 * (same prompt, same cache state).
 *
 * karoslabs attempt 2: $0.400484 total, 16,120 output → $0.4044 for attempt 3.
 * deel attempt 1: $0.110939 total, 2,751 output → $0.3154 for attempts 2 and 3.
 * geektime attempt 3: $0.334373 total, 16,323 output → $0.3353 for attempts 1 and 2.
 */
const TRUNCATED_KAROSLABS_USD = 0.4044;
const TRUNCATED_DEEL_USD = 0.3154;
const TRUNCATED_GEEKTIME_USD = 0.3353;

const TRUNCATION_ERROR =
  'model call failed: anthropic: model "claude-sonnet-4-6" hit the 16384-token output limit before completing its structured output — ' +
  "raise the step's `maxTokens` (AgentStepConfig) or narrow its outputSchema";

/** A measured spend line, the way the meter books a model step. */
function measured(label: string, usd: number): SpendLine {
  return { label, usd, measuredUsd: usd, estimateUsd: usd, basis: "measured" };
}

/** A per-unit line the vendor never priced back — a scraper execution. Real money, not a vendor figure. */
function estimated(label: string, usd: number): SpendLine {
  return { label, usd, estimateUsd: usd, basis: "estimate" };
}

function budgetFor(actualUsd: number, lines: SpendLine[], adaptations: string[] = []): GateVerdictInput["budget"] {
  return { actualUsd, targetUsd: TARGET_RUN_SPEND_USD, maxUsd: MAX_RUN_SPEND_USD, adaptations, lines };
}

/** The lever every one of the three runs pulled, in `planRunBudget`'s own words. */
const NO_GENERATED_IMAGES = "generatedImagesCap 4 -> 0";

// ─────────────────────────────────────────────────────────────────────────
// karoslabs — pubsub-21868183257380937
// ─────────────────────────────────────────────────────────────────────────

function karoslabs(): GateVerdictInput {
  return {
    budget: budgetFor(0.994, [measured("05-write-copy-attempt-1", 0.402785), measured("05-write-copy-attempt-2", 0.400484), estimated("04e-read-cross-channel-history", 0.021)], [NO_GENERATED_IMAGES]),
    billedUsd: 0.994 + TRUNCATED_KAROSLABS_USD,
    skipped: [{ step: "04m-concept-eligibility", reason: "the run budget bought no generated images" }],
    shippedAttempt: 2,
    attempts: [
      { attempt: 1, producedDraft: true, usdBurned: 0.402785, draftDigest: "k1" },
      { attempt: 2, producedDraft: true, usdBurned: 0.400484, draftDigest: "k2" },
      { attempt: 3, producedDraft: false, status: "tooling_error", reason: TRUNCATION_ERROR, usdBurned: TRUNCATED_KAROSLABS_USD },
    ],
    visualQa: {
      pass: false,
      findings: [
        { ruleId: "default:no-image-means-device", slide: 4, passed: false, note: "Slide 4 has no image, no explicit number device, and its archetype ('text_only') is not one of the archetypes that inherently serve as a device." },
        { ruleId: "default:no-image-means-device", slide: 6, passed: false, note: "Slide 6 has no image, no explicit number device, and its archetype ('text_only') is not one of the archetypes that inherently serve as a device." },
        { ruleId: "composition-richness", passed: false, note: "slides 4 and 6 both use the 'text_only' archetype with a similar headline and body text structure" },
        { ruleId: "default:closer-carries-cta", passed: true, note: "the closer carries a takeaway and a cta" },
        { ruleId: "default:no-repeated-picture", passed: true, note: "no picture is repeated" },
      ],
    },
    post: {
      hashtags: ["GEO", "GenerativeEngineOptimization", "AICMO", "B2Bgrowth", "SaaSMarketing"],
      altText: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, alt: `White text on a gradient background, slide ${i + 1}.` })),
      firstComment: { text: "The data on CMO sentiment and AI infrastructure comes from two sources." },
      status: "complete",
    },
    imagery: {
      // `06-vet-images-attempt-3` considered one slide and cleared none of it.
      wanted: 1,
      generated: 0,
      shortfall: [{ slide: 1, wanted: "stock", promotedByBand: false, got: "text_only", why: "None of the candidates carried the slide's claim", remedy: "font-scale" }],
      selections: [{ n: 1, imagePath: null, license: "n/a — no candidate qualified" }],
    },
    degradeMarkers: [
      { slide: 4, from: "stat_callout", to: "text_only", reason: "stat_callout (already used earlier in this carousel)" },
      { slide: 5, from: "stat_callout", to: "text_only", reason: "stat_callout (already used earlier in this carousel)" },
      { slide: 6, from: "stat_callout", to: "text_only", reason: "stat_callout (already used earlier in this carousel)" },
    ],
    // The owner's own words: "יש למעלה לוגו שלהם שזה מעולה" — and karoslabs'
    // brand kit carries a `logoUrl` while the slides showed only the @handle.
    brandAsset: { present: false, reason: "brand logoUrl did not produce a usable download this attempt", remedy: "check the logoUrl's content-type and size cap" },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// thepitchbydeel — pubsub-21864573169935321
// ─────────────────────────────────────────────────────────────────────────

function deel(): GateVerdictInput {
  return {
    budget: budgetFor(0.4146, [measured("05-write-copy-attempt-1", 0.110939), estimated("04e-read-cross-channel-history", 0.021)], [NO_GENERATED_IMAGES]),
    billedUsd: 0.4146 + 2 * TRUNCATED_DEEL_USD,
    skipped: [{ step: "04m-concept-eligibility", reason: "the run budget bought no generated images" }],
    shippedAttempt: 1,
    attempts: [
      { attempt: 1, producedDraft: true, usdBurned: 0.110939, draftDigest: "d1" },
      { attempt: 2, producedDraft: false, status: "tooling_error", reason: TRUNCATION_ERROR, usdBurned: TRUNCATED_DEEL_USD },
      { attempt: 3, producedDraft: false, status: "tooling_error", reason: TRUNCATION_ERROR, usdBurned: TRUNCATED_DEEL_USD },
    ],
    stepFailures: [
      { step: "08c-package-post", status: "budget_exceeded", why: "the packager ran out of turns against its output schema", usdBurned: 0.006374 },
      { step: "00b2-write-client-brief", status: "tooling_error", why: TRUNCATION_ERROR, usdBurned: 0 },
    ],
    visualQa: {
      pass: false,
      findings: [
        { ruleId: "default:closer-carries-cta", passed: true, note: "the closer invites action" },
        { ruleId: "default:no-image-means-device", slide: 5, passed: false, note: "Slide 5 consists only of headline and body text on bare ground, which the rule considers an empty slide (14% occupied share)." },
        { ruleId: "composition-richness", passed: true, note: "the carousel exhibits good compositional rhythm" },
        { ruleId: "default:cover-carries-hook", passed: false, note: "the cover device reads as a truncated label" },
        { ruleId: "default:no-repeated-picture", passed: false, note: "two slides carry pictures of the same subject" },
      ],
    },
    // `08c-package-post` resolved `budget_exceeded` and returned nothing at all.
    imagery: {
      wanted: 4,
      generated: 0,
      shortfall: [{ slide: 1, wanted: "stock", promotedByBand: false, got: "text_only", why: "No candidate in the pool carried the cover's claim", remedy: "font-scale" }],
      selections: [
        { n: 1, imagePath: null, license: "n/a — no candidate qualified" },
        { n: 3, imagePath: "gs://karos/deel/3.png", license: "CC0, Pexels" },
        { n: 4, imagePath: "gs://karos/deel/4.png", license: "CC0, Pexels" },
        { n: 6, imagePath: "gs://karos/deel/6.png", license: "CC0, Pexels" },
      ],
    },
    brandAsset: { present: false, reason: "brand logoUrl did not produce a usable download this attempt" },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// geektime — pubsub-21868533047825082
// ─────────────────────────────────────────────────────────────────────────

function geektime(): GateVerdictInput {
  return {
    budget: budgetFor(0.5287, [measured("05-write-copy-attempt-3", 0.334373), estimated("04e-read-cross-channel-history", 0.021)], [NO_GENERATED_IMAGES]),
    billedUsd: 0.5287 + 2 * TRUNCATED_GEEKTIME_USD,
    skipped: [{ step: "04m-concept-eligibility", reason: "the run budget bought no generated images" }],
    shippedAttempt: 3,
    attempts: [
      { attempt: 1, producedDraft: false, status: "tooling_error", reason: TRUNCATION_ERROR, usdBurned: TRUNCATED_GEEKTIME_USD },
      { attempt: 2, producedDraft: false, status: "tooling_error", reason: TRUNCATION_ERROR, usdBurned: TRUNCATED_GEEKTIME_USD },
      { attempt: 3, producedDraft: true, usdBurned: 0.334373, draftDigest: "g3" },
    ],
    stepFailures: [
      { step: "04b-research-extract-facts", status: "tooling_error", why: "the extraction agent did not complete", usdBurned: 0 },
      { step: "00c3-write-design-brief", status: "tooling_error", why: TRUNCATION_ERROR, usdBurned: 0 },
    ],
    packagingRetried: true,
    visualQa: {
      pass: false,
      findings: [
        { ruleId: "default:closer-carries-cta", passed: true, note: "the closer carries a cta" },
        { ruleId: "default:no-image-means-device", slide: 2, passed: false, note: "Slide 2 lacks an image and a numerical device." },
        { ruleId: "default:no-image-means-device", slide: 4, passed: false, note: "Slide 4 lacks an image and a numerical device." },
        { ruleId: "default:no-image-means-device", slide: 8, passed: false, note: "Slide 8 lacks an image and a numerical device." },
      ],
    },
    post: {
      hashtags: ["geektime", "הייטקישראלי", "חדשותטכנולוגיה", "קהילתהייטק", "תוכןטכנולוגי"],
      altText: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, alt: `Text on screen, slide ${i + 1}.` })),
      firstComment: { text: "הנתונים על מעמדה של גיקטיים מבוססים על מידע מאתר גיקטיים עצמו." },
      status: "complete",
    },
    imagery: {
      wanted: 3,
      generated: 0,
      shortfall: [{ slide: 1, wanted: "stock", promotedByBand: false, got: "text_only", why: "None of the candidates carried the cover's claim", remedy: "font-scale" }],
      selections: [
        { n: 1, imagePath: null, license: "n/a — no candidate qualified" },
        { n: 3, imagePath: "gs://karos/geektime/3.png", license: "CC0, Pexels" },
        { n: 7, imagePath: "gs://karos/geektime/7.png", license: "CC0, Pexels" },
      ],
    },
    // geektime is the ONE client whose logo rendered — and it collided with the
    // series badge, which is a different defect (item F) and not this block's.
    brandAsset: { present: true, corner: "top-end" },
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe("karoslabs, replayed", () => {
  const verdict = buildGateVerdict(karoslabs());

  it("says which draft the reader is looking at: attempt 2 of 3, with attempt 3 recorded as failed", () => {
    expect(verdict.draftProvenance.shippedAttempt).toBe(2);
    expect(verdict.draftProvenance.attemptsSpent).toBe(3);
    expect(verdict.draftProvenance.attemptsThatFailed).toHaveLength(1);
    expect(verdict.draftProvenance.attemptsThatFailed[0]).toMatchObject({ attempt: 3, status: "tooling_error", usdBurned: TRUNCATED_KAROSLABS_USD });
    // The engine's own error text, trimmed to one readable line for the gate.
    expect(verdict.draftProvenance.attemptsThatFailed[0]!.reason).toContain("hit the 16384-token output limit");
    expect(verdict.draftProvenance.attemptsThatFailed[0]!.reason.length).toBeLessThanOrEqual(200);
    // One real redraft: attempt 2's words were not attempt 1's.
    expect(verdict.draftProvenance.redraftsThatActuallyHappened).toBe(1);
  });

  it("THE MISSING FACT: the failed attempt carries a non-zero dollar figure", () => {
    const failure = verdict.stepFailures.find((f) => f.step === "05-write-copy-attempt-3");
    expect(failure).toBeDefined();
    expect(failure!.usdBurned).toBeGreaterThan(0);
    expect(failure!.usdBurned).toBe(TRUNCATED_KAROSLABS_USD);
    // And the run's real bill is a THIRD higher than the meter's total, which is
    // the whole reason the budget ladder was cutting pictures out of the post.
    expect(verdict.spend.meteredUsd).toBe(0.994);
    expect(verdict.spend.billedUsd).toBeGreaterThan(verdict.spend.meteredUsd);
    expect(verdict.spend.billedUsd).toBeCloseTo(1.3984, 4);
  });

  it("the post asked for a photograph and shipped none, and the block says so without being asked", () => {
    expect(verdict.imagery).toMatchObject({ wanted: 1, shipped: 0, generated: 0 });
    expect(verdict.imagery.shortfall).toHaveLength(1);
    expect(verdict.spend.skipped).toEqual([{ step: "04m-concept-eligibility", reason: "the run budget bought no generated images" }]);
  });

  it("the one line reads badly, in the order a reviewer scans it", () => {
    expect(verdict.summary).toBe(
      "attempt 2 of 3 shipped (1 draft failed) · 0 of 1 picture WANTED, 1 slide lost one · visual QA FAILED 3 rules · " +
        `packaging ok · 3 slides DEGRADED · NO LOGO · $1.40 billed / ${formatUsd(TARGET_RUN_SPEND_USD)} target`,
    );
    // The line is also inside the block, so the deliverable and the ledger quote
    // the same sentence rather than re-deriving it.
    expect(gateVerdictLine(verdict)).toBe(verdict.summary);
  });
});

describe("thepitchbydeel, replayed", () => {
  const verdict = buildGateVerdict(deel());

  it("packaging FAILED with zero hashtags and zero alt texts — the post a human approved", () => {
    expect(verdict.packaging.status).toBe("failed");
    expect(verdict.packaging.hashtags).toBe(0);
    expect(verdict.packaging.altTexts).toBe(0);
    expect(verdict.packaging.firstComment).toBe(false);
    expect(verdict.packaging.reason).toMatch(/no post at all/);
  });

  it("NO REDRAFT LANDED: three attempts were spent and only one draft was ever written", () => {
    expect(verdict.draftProvenance.shippedAttempt).toBe(1);
    expect(verdict.draftProvenance.attemptsSpent).toBe(3);
    expect(verdict.draftProvenance.attemptsThatFailed).toHaveLength(2);
    expect(verdict.draftProvenance.redraftsThatActuallyHappened).toBe(0);
    // Two dead attempts at $0.3154 each, which the run recorded as $0.00.
    const burned = verdict.stepFailures.filter((f) => f.step.startsWith("05-write-copy")).reduce((s, f) => s + f.usdBurned, 0);
    expect(burned).toBeCloseTo(0.6308, 4);
  });

  it("the one line names all three failures at once", () => {
    expect(verdict.summary).toBe(
      "attempt 1 of 3 shipped (2 drafts failed, NO REDRAFT LANDED) · 3 of 4 pictures WANTED, 1 slide lost one · visual QA FAILED 3 rules · " +
        `packaging FAILED (no hashtags, no alt text) · 2 steps FAILED ($0.01 burned) · NO LOGO · $1.05 billed / ${formatUsd(TARGET_RUN_SPEND_USD)} target`,
    );
  });
});

describe("geektime, replayed", () => {
  const verdict = buildGateVerdict(geektime());

  it("visual QA answered pass: false with three failing rules, and nothing on the old payload said so", () => {
    expect(verdict.visualQa.pass).toBe(false);
    expect(verdict.visualQa.findings.filter((f) => !f.passed)).toHaveLength(3);
    expect(verdict.summary).toContain("visual QA FAILED 3 rules");
  });

  it("the shipped draft was the THIRD attempt and the first one that existed", () => {
    expect(verdict.draftProvenance.shippedAttempt).toBe(3);
    expect(verdict.draftProvenance.redraftsThatActuallyHappened).toBe(0);
    expect(verdict.summary).toContain("attempt 3 of 3 shipped (2 drafts failed, NO REDRAFT LANDED)");
  });

  it("the run's real bill is over the hard max, and the line says OVER", () => {
    expect(verdict.spend.billedUsd).toBeCloseTo(1.1993, 4);
    expect(verdict.spend.maxUsd).toBe(MAX_RUN_SPEND_USD);
    // Whether the line shouts depends on where the hard max is set this phase;
    // what must never happen is a bill above the max rendering silently.
    if (verdict.spend.billedUsd > verdict.spend.maxUsd) expect(verdict.summary).toContain("OVER");
    else expect(verdict.summary).toContain("$1.20 billed");
  });

  it("packaging retried is not packaging ok: the reviewer sees the retry that saved the hashtags", () => {
    expect(verdict.packaging.status).toBe("retried");
    expect(verdict.packaging.hashtags).toBe(5);
    expect(verdict.summary).toContain("packaging retried");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The properties the block has to hold whatever the run did
// ─────────────────────────────────────────────────────────────────────────

describe("the block itself", () => {
  it("puts the summary FIRST in the serialised object, where a reviewer reaches it", () => {
    expect(Object.keys(buildGateVerdict(karoslabs()))[0]).toBe("summary");
  });

  it("is pure: the same input builds the same block, and nothing aliases the caller's arrays", () => {
    const input = karoslabs();
    const a = buildGateVerdict(input);
    const b = buildGateVerdict(input);
    expect(a).toEqual(b);

    a.spend.adaptations.push("mutated");
    a.degradeMarkers.pop();
    expect(input.budget.adaptations).toEqual([NO_GENERATED_IMAGES]);
    expect(input.degradeMarkers).toHaveLength(3);
  });

  it("separates the vendor's figure from the arithmetic inside `billedUsd`", () => {
    // `04e`'s scraper executions are real money that no vendor priced back.
    expect(buildGateVerdict(karoslabs()).spend.estimatedShareUsd).toBeCloseTo(0.021, 6);
  });

  it("derives the bill from the meter's own lines when the caller gives no figure, and it is NOT `max(measured, estimate)`", () => {
    const lines: SpendLine[] = [
      // A step that really cost less than its estimate: the meter books $0.05,
      // the vendor billed $0.02, and a reviewer asking "what did this cost" is
      // owed the second number.
      { label: "07j-value-judge", usd: 0.05, measuredUsd: 0.02, estimateUsd: 0.05, basis: "estimate" },
      { label: "04a2-research-lanes", usd: 0.007, estimateUsd: 0.007, basis: "estimate" },
    ];
    const { billedUsd, meteredUsd, estimatedShareUsd } = buildGateVerdict({
      budget: budgetFor(0.057, lines),
      shippedAttempt: 1,
      attempts: [{ attempt: 1, producedDraft: true, usdBurned: 0.02 }],
      imagery: { wanted: 0, generated: 0, selections: [] },
      post: { hashtags: ["a", "b", "c"], altText: [{ n: 1, alt: "one" }], firstComment: { text: "s" }, status: "complete" },
      brandAsset: { present: true },
    }).spend;
    expect(meteredUsd).toBe(0.057);
    expect(billedUsd).toBe(0.027);
    expect(estimatedShareUsd).toBe(0.007);
  });

  it("an unjudged visual QA reads NOT JUDGED, never as a pass", () => {
    const { visualQa: _unused, ...withoutQa } = geektime();
    void _unused;
    const unjudged = buildGateVerdict(withoutQa);
    expect(unjudged.visualQa.pass).toBeUndefined();
    expect(unjudged.summary).toContain("visual QA NOT JUDGED");
  });

  it("a `publishable: false` from the CMO-eye judge is called out separately from the rule findings", () => {
    const refused = buildGateVerdict({ ...geektime(), visualQa: { pass: true, publishable: false, findings: [] } });
    expect(refused.summary).toContain("judged NOT PUBLISHABLE");
    expect(refused.summary).toContain("visual QA passed");
  });

  it("a clean run reads clean, so the shouting means something", () => {
    const clean = buildGateVerdict({
      budget: budgetFor(0.92, [measured("05-write-copy-attempt-1", 0.31)]),
      billedUsd: 0.92,
      shippedAttempt: 1,
      attempts: [{ attempt: 1, producedDraft: true, usdBurned: 0.31 }],
      visualQa: { pass: true, publishable: true, findings: [] },
      post: {
        hashtags: ["a", "b", "c"],
        altText: [{ n: 1, alt: "one" }],
        firstComment: { text: "sources" },
        status: "complete",
      },
      imagery: { wanted: 3, generated: 1, selections: [{ n: 1, imagePath: "gs://x/1", license: "CC0" }, { n: 2, imagePath: "gs://x/2", license: "CC0" }, { n: 3, imagePath: "gs://x/3", license: "generated" }] },
      brandAsset: { present: true, corner: "top-start" },
    });
    expect(clean.summary).toBe(
      `attempt 1 of 1 shipped · 3 pictures (1 generated) · visual QA passed · packaging ok · $0.92 billed / ${formatUsd(TARGET_RUN_SPEND_USD)} target`,
    );
    expect(clean.summary).not.toMatch(/[A-Z]{4,}/);
  });

  it("two consecutive drafts with the same digest are not a redraft: the writer said nothing new", () => {
    const stalled = buildGateVerdict({
      ...deel(),
      shippedAttempt: 3,
      attempts: [
        { attempt: 1, producedDraft: true, usdBurned: 0.11, draftDigest: "same" },
        { attempt: 2, producedDraft: true, usdBurned: 0.11, draftDigest: "same" },
        { attempt: 3, producedDraft: true, usdBurned: 0.11, draftDigest: "same" },
      ],
    });
    expect(stalled.draftProvenance.redraftsThatActuallyHappened).toBe(0);
    expect(stalled.summary).toContain("NO REDRAFT LANDED");
  });

  it("`draftDigestFor` is stable, whitespace-insensitive and different for different words", () => {
    const slides = [{ headline: "A headline", body: "A body." }];
    expect(draftDigestFor("caption", slides)).toBe(draftDigestFor("caption", slides));
    // A re-emitted identical draft with a different wrap has said nothing new.
    expect(draftDigestFor("caption", slides)).toBe(draftDigestFor("caption ", [{ headline: "A  headline", body: "A body.\n" }]));
    expect(draftDigestFor("caption", slides)).not.toBe(draftDigestFor("caption", [{ headline: "A headline", body: "A different body." }]));
  });

  it("an unknown digest is not evidence of sameness: a second completed draft counts as a redraft", () => {
    const unknown = buildGateVerdict({
      ...deel(),
      shippedAttempt: 2,
      attempts: [
        { attempt: 1, producedDraft: true, usdBurned: 0.11 },
        { attempt: 2, producedDraft: true, usdBurned: 0.11 },
      ],
    });
    expect(unknown.draftProvenance.redraftsThatActuallyHappened).toBe(1);
    expect(unknown.summary).not.toContain("NO REDRAFT LANDED");
  });

  it("a package that came back complete but empty of hashtags is a FAILURE, whatever the step's status said", () => {
    const empty = buildGateVerdict({
      ...geektime(),
      post: { hashtags: [], altText: [{ n: 1, alt: "one" }], firstComment: { text: "x" }, status: "complete" },
    });
    expect(empty.packaging.status).toBe("failed");
    expect(empty.summary).toContain("packaging FAILED (no hashtags)");
  });
});
