import { describe, expect, it } from "vitest";
import { parseContentModeFromSummary } from "@agent-engine/workflow";
import {
  AngleProposalSchema,
  AngleSchema,
  angleDecisionSummary,
  angleForCopyInput,
  angleFromDecisionSummary,
  angleUnavailable,
  factCardKind,
  factsForAnglePrompt,
  pastAnglesFromDecisions,
  selectAngle,
  type Angle,
  type AngleFactCard,
  type SelectAngleOptions,
} from "../src/workflow/angle-selection.js";
import { topicDecisionSummary } from "../src/workflow/topic-selection.js";
import { SIX_RESEARCH_FACTS } from "./test-helpers.js";
import { angleScoringBrief, goodAngleProposal, surprisingNumberAngle, whatItMeansAngle, wrongAssumptionAngle } from "./angle-fixtures.js";

/**
 * RFC-13 §K — the deterministic pick and the ledger codec.
 *
 * The pick is where the angle step earns its Sonnet call: a model that also
 * scores its own three proposals grades its own homework, and the two things
 * that decide an angle in practice (how much of the client's brief it
 * touches, how far it is from what this account already said) are
 * measurable. Every test below therefore ASSERTS ITS OWN PREMISE first —
 * that two candidates really are tied before checking which way the
 * tie-break went, that a repeat really did score 0 — because a scoring
 * function whose inputs quietly stopped being equal would otherwise let
 * every one of these pass for the wrong reason.
 */

const FACTS: AngleFactCard[] = SIX_RESEARCH_FACTS.map((f) => ({ claim: f.claim, kind: "stat" }));

/** A card with no figure in it at all: the one shape `surprising-number` may not rest on. */
const NO_FIGURE_CARD: AngleFactCard = { claim: "Support leads describe triage as the least designed part of their week.", kind: "quote" };

function options(overrides: Partial<SelectAngleOptions> = {}): SelectAngleOptions {
  return {
    brief: angleScoringBrief(),
    facts: FACTS,
    pastAngles: [],
    recentExcerpts: [],
    mode: "deep-value",
    ...overrides,
  };
}

describe("AngleSchema / AngleProposalSchema", () => {
  it("accepts the healthy proposal shape and refuses the two the prompt is written to prevent", () => {
    expect(AngleProposalSchema.safeParse(goodAngleProposal()).success).toBe(true);

    // Two angles is not a proposal: the three ids are three different moves
    // on the subject, and a step that accepted two would silently narrow the
    // field it exists to widen.
    expect(AngleProposalSchema.safeParse({ angles: [wrongAssumptionAngle(), whatItMeansAngle()] }).success).toBe(false);
    // An unknown id would reach `selectAngle` with no mode preference and no
    // eligibility rule to hold it to.
    expect(AngleSchema.safeParse({ ...wrongAssumptionAngle(), id: "hot-take" }).success).toBe(false);
    // `restsOn` is the whole evidence contract.
    expect(AngleSchema.safeParse({ ...wrongAssumptionAngle(), restsOn: [] }).success).toBe(false);
    // A remember line has to fit on a slide.
    expect(AngleSchema.safeParse({ ...wrongAssumptionAngle(), rememberLine: "x".repeat(161) }).success).toBe(false);
  });
});

describe("factCardKind", () => {
  it("trusts a declared kind and, without one, reads the claim for an actual figure", () => {
    expect(factCardKind({ claim: "anything", kind: "Quote" })).toBe("quote");
    // Item J's `kind` field is not on `ResearchFactSchema` yet, so a card can
    // arrive without one; the rule a `surprising-number` angle clears is
    // "there is a number to be surprised by", which is a property of the claim.
    expect(factCardKind({ claim: "Teams saved 4 hours per week." })).toBe("stat");
    expect(factCardKind({ claim: "Support resolved 30% more tickets." })).toBe("stat");
    expect(factCardKind({ claim: "₪1,200 per seat per year." })).toBe("stat");
    // A four-digit year alone is not a statistic (the same exclusion
    // `LEADS_WITH_FIGURE` makes in visual-qa-pre-checks).
    expect(factCardKind({ claim: "2026 was the year the vendor shipped triage." })).toBe("unspecified");
    expect(factCardKind(NO_FIGURE_CARD)).toBe("quote");
  });

  it("factsForAnglePrompt caps the cards and carries claim plus kind only", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ claim: `card ${i} with 4 hours in it` }));
    const forPrompt = factsForAnglePrompt(many);
    expect(forPrompt).toHaveLength(14);
    expect(Object.keys(forPrompt[0]!)).toEqual(["claim", "kind"]);
    expect(forPrompt[0]!.kind).toBe("stat");
  });
});

describe("selectAngle — eligibility", () => {
  it("drops an angle whose restsOn names a card this run never fetched, and says which one", () => {
    const invented = wrongAssumptionAngle({ restsOn: ["Gartner says 80% of teams will automate reporting by 2027."] });
    const result = selectAngle([invented, whatItMeansAngle(), surprisingNumberAngle()], options());

    expect(result.status).toBe("selected");
    if (result.status !== "selected") throw new Error("unreachable");
    expect(result.chosen.id).not.toBe("wrong-assumption");
    const dropped = result.scores.find((s) => s.id === "wrong-assumption")!;
    expect(dropped.eligible).toBe(false);
    expect(dropped.score).toBe(0);
    expect(dropped.ineligibleReason).toMatch(/never fetched/);
    expect(dropped.ineligibleReason).toContain("Gartner says 80%");
    expect(result.rejected.find((r) => r.angle.id === "wrong-assumption")!.why).toMatch(/never fetched/);
  });

  it("matches cards case- and whitespace-insensitively: a re-capitalised claim is not an invented one", () => {
    const restated = whatItMeansAngle({ restsOn: [`  ${SIX_RESEARCH_FACTS[1]!.claim.toUpperCase()} `] });
    const result = selectAngle([restated, wrongAssumptionAngle(), surprisingNumberAngle()], options({ mode: "open-discussion" }));

    if (result.status !== "selected") throw new Error("unreachable");
    expect(result.scores.find((s) => s.id === "what-it-means")!.eligible).toBe(true);
  });

  it("scores a surprising-number angle 0 when no card it rests on carries a figure", () => {
    const facts = [NO_FIGURE_CARD, ...FACTS.slice(1)];
    const unsupported = surprisingNumberAngle({ restsOn: [NO_FIGURE_CARD.claim] });
    // Premise: the card IS in this run's set, so the only rule that can drop
    // this angle is the stat rule.
    expect(facts.some((f) => f.claim === NO_FIGURE_CARD.claim)).toBe(true);

    const result = selectAngle([unsupported, wrongAssumptionAngle(), whatItMeansAngle()], options({ facts }));
    if (result.status !== "selected") throw new Error("unreachable");
    const scored = result.scores.find((s) => s.id === "surprising-number")!;
    expect(scored.score).toBe(0);
    expect(scored.ineligibleReason).toMatch(/kind "stat"/);
    expect(result.chosen.id).not.toBe("surprising-number");
  });

  it("returns no-eligible-angle (never a hold) when all three rest on nothing real, and copy gets no angle block", () => {
    const result = selectAngle(
      [
        wrongAssumptionAngle({ restsOn: ["made up A"] }),
        surprisingNumberAngle({ restsOn: ["made up B"] }),
        whatItMeansAngle({ restsOn: ["made up C"] }),
      ],
      options(),
    );

    expect(result.status).toBe("no-eligible-angle");
    if (result.status !== "no-eligible-angle") throw new Error("unreachable");
    expect(result.rejected).toHaveLength(3);
    expect(result.reason).toMatch(/drafts without an angle/);
    expect(angleForCopyInput(result)).toBeUndefined();
    expect(angleForCopyInput(angleUnavailable("agent content_fail"))).toBeUndefined();
  });
});

describe("selectAngle — scoring", () => {
  it("prefers the novel angle over one that repeats last run's remember line, whatever the model claimed for briefFit", () => {
    const repeat = wrongAssumptionAngle({ briefFit: 5 });
    const fresh = whatItMeansAngle({ briefFit: 3 });
    const pastAngles = [{ id: "wrong-assumption" as const, rememberLine: repeat.rememberLine }];

    const result = selectAngle([repeat, fresh], options({ pastAngles, mode: "deep-value" }));
    if (result.status !== "selected") throw new Error("unreachable");

    const repeatScore = result.scores.find((s) => s.id === "wrong-assumption")!;
    const freshScore = result.scores.find((s) => s.id === "what-it-means")!;
    // Premise: the repeat is the one the model rated HIGHER on brief fit, and
    // it is off-mode-penalised on nothing (deep-value prefers exactly it).
    expect(repeatScore.fit).toBeGreaterThan(freshScore.fit);
    expect(repeatScore.modeFit).toBe(1);
    // Novelty is what settles it: an exact repeat is 0 distant from itself.
    expect(repeatScore.novelty).toBe(0);
    expect(repeatScore.score).toBe(0);
    expect(result.chosen.id).toBe("what-it-means");
    expect(result.rejected[0]!.why).toMatch(/novelty 0/);
  });

  it("measures novelty against recent posts too, not only past angles", () => {
    const angle = whatItMeansAngle();
    const excerpt = `Our take: ${angle.rememberLine}`;
    const withHistory = selectAngle([angle], options({ recentExcerpts: [excerpt], mode: "open-discussion" }));
    const withoutHistory = selectAngle([angle], options({ mode: "open-discussion" }));

    if (withHistory.status !== "selected" || withoutHistory.status !== "selected") throw new Error("unreachable");
    expect(withoutHistory.scores[0]!.novelty).toBe(1);
    expect(withHistory.scores[0]!.novelty).toBeLessThan(1);
    // Still chosen: it is the only angle on the table, and the run always delivers.
    expect(withHistory.chosen.id).toBe("what-it-means");
  });

  it("counts the brief's own terms in the angle's words, capped so keyword stuffing buys nothing", () => {
    const bare = whatItMeansAngle({ title: "A quiet Monday", rememberLine: "Nothing else changes.", briefFit: 3 });
    const grounded = whatItMeansAngle({
      title: "Reporting automation for operations leads",
      rememberLine: "Onboarding is where reporting automation pays an operations lead back.",
      briefFit: 3,
    });

    const bareScore = selectAngle([bare], options({ mode: "open-discussion" }));
    const groundedScore = selectAngle([grounded], options({ mode: "open-discussion" }));
    if (bareScore.status !== "selected" || groundedScore.status !== "selected") throw new Error("unreachable");

    expect(bareScore.scores[0]!.hits).toBe(0);
    expect(groundedScore.scores[0]!.hits).toBeGreaterThan(0);
    expect(groundedScore.scores[0]!.fit).toBeGreaterThan(bareScore.scores[0]!.fit);
    // The scale stops at four hits, so a fifth term cannot buy more fit.
    expect(groundedScore.scores[0]!.hits).toBeLessThanOrEqual(4);
  });

  it("mode fit separates two otherwise identical angles: the mode's own kind wins", () => {
    const shared = { title: "A quiet Monday", rememberLine: "Nothing else changes.", briefFit: 4, restsOn: [SIX_RESEARCH_FACTS[0]!.claim] };
    const inMode = wrongAssumptionAngle({ ...shared });
    const offMode = whatItMeansAngle({ ...shared });

    const result = selectAngle([offMode, inMode], options({ mode: "deep-value" }));
    if (result.status !== "selected") throw new Error("unreachable");
    const a = result.scores.find((s) => s.id === "wrong-assumption")!;
    const b = result.scores.find((s) => s.id === "what-it-means")!;
    // Premise: identical fit and identical novelty, so mode fit is the ONLY
    // difference left (and it is a penalty, not a wall).
    expect(a.fit).toBe(b.fit);
    expect(a.novelty).toBe(b.novelty);
    expect(a.modeFit).toBe(1);
    expect(b.modeFit).toBe(0.85);
    // Listed second, chosen anyway: order is the last tie-break, not the first.
    expect(result.chosen.id).toBe("wrong-assumption");
    expect(result.rule).toContain("mode deep-value");
  });

  it("a genuine tie breaks toward the angle kind this account has used least", () => {
    const shared = { title: "A quiet Monday", rememberLine: "Nothing else changes.", briefFit: 4, restsOn: [SIX_RESEARCH_FACTS[0]!.claim] };
    const used = surprisingNumberAngle({ ...shared });
    const unused = whatItMeansAngle({ ...shared });
    // Both kinds are in-mode for hot-news, so mode fit cannot separate them.
    const pastAngles = [
      { id: "surprising-number" as const, rememberLine: "Lunch orders are up." },
      { id: "surprising-number" as const, rememberLine: "The office plant died." },
    ];

    const result = selectAngle([used, unused], options({ mode: "hot-news", pastAngles }));
    if (result.status !== "selected") throw new Error("unreachable");
    const a = result.scores.find((s) => s.id === "surprising-number")!;
    const b = result.scores.find((s) => s.id === "what-it-means")!;
    // Premise: a real tie, on every component.
    expect(a.score).toBe(b.score);
    expect(a.modeFit).toBe(1);
    expect(b.modeFit).toBe(1);
    expect(result.chosen.id).toBe("what-it-means");
    expect(result.rule).toMatch(/used least/);
  });

  it("hands copy the winner and the two rejected angles as context, without the arithmetic", () => {
    const result = selectAngle(goodAngleProposal().angles, options());
    if (result.status !== "selected") throw new Error("unreachable");
    expect(result.rejected).toHaveLength(2);

    const forCopy = angleForCopyInput(result)!;
    expect(forCopy.chosen).toEqual(result.chosen);
    expect(forCopy.rejected).toHaveLength(2);
    expect(forCopy.rejected.map((a) => a.id)).not.toContain(result.chosen.id);
    // Scores are for the reviewer, not for the writer.
    for (const rejected of forCopy.rejected) expect(rejected).not.toHaveProperty("score");
  });
});

describe("the ledger codec", () => {
  const base = topicDecisionSummary({
    topic: "automated weekly reporting is replacing the Monday status meeting",
    mode: "deep-value",
    source: "trend",
    archetypes: ["photo", "stat-callout"],
  });

  it("round-trips a remember line containing parentheses, and leaves the mode readable", () => {
    const chosen: Angle = wrongAssumptionAngle({ rememberLine: "The hours come back (all four of them) only once the report writes itself." });
    const summary = angleDecisionSummary(base, chosen);

    expect(summary).toContain(`; angle: wrong-assumption | ${chosen.rememberLine})`);
    expect(summary.endsWith(")")).toBe(true);
    // The mode still parses: it is the only place the rotation survives across runs.
    expect(parseContentModeFromSummary(summary)).toBe("deep-value");
    expect(angleFromDecisionSummary(summary)).toEqual({ id: "wrong-assumption", rememberLine: chosen.rememberLine });
  });

  it("round-trips a remember line that ENDS in a parenthesis", () => {
    const chosen = whatItMeansAngle({ rememberLine: "Monday comes back first (the dashboard later)" });
    const summary = angleDecisionSummary(base, chosen);
    expect(angleFromDecisionSummary(summary)?.rememberLine).toBe(chosen.rememberLine);
  });

  it("round-trips a Hebrew remember line", () => {
    const chosen = whatItMeansAngle({ rememberLine: "השעות חוזרות רק כשהדוח כותב את עצמו." });
    const summary = angleDecisionSummary(base, chosen);
    expect(parseContentModeFromSummary(summary)).toBe("deep-value");
    expect(angleFromDecisionSummary(summary)).toEqual({ id: "what-it-means", rememberLine: chosen.rememberLine });
  });

  it("leaves the summary alone when there was no angle, and reads nothing back out of it", () => {
    expect(angleDecisionSummary(base, undefined)).toBe(base);
    expect(angleFromDecisionSummary(base)).toBeUndefined();
    // A run that failed open must not look like a run that chose an angle.
    expect(angleFromDecisionSummary('instagram post: "x" (mode: hot-news; source: trend; archetypes: none)')).toBeUndefined();
  });

  it("appends its own parenthesis when the base summary has none", () => {
    const summary = angleDecisionSummary("instagram post: no parenthesis here", whatItMeansAngle());
    expect(summary).toBe(`instagram post: no parenthesis here (angle: what-it-means | ${whatItMeansAngle().rememberLine})`);
    expect(angleFromDecisionSummary(summary)?.id).toBe("what-it-means");
  });

  it("pastAnglesFromDecisions reads the log newest-first and ignores rows without an angle", () => {
    const older = angleDecisionSummary(base, wrongAssumptionAngle());
    const newer = angleDecisionSummary(base, whatItMeansAngle());
    const decisions = [
      { at: 2, summary: older },
      { at: 1, summary: 'instagram post: "an older post" (mode: hot-news; source: reserved; archetypes: photo)' },
      { at: 3, summary: newer },
      { at: 4, summary: "a feedback row that is not a topic decision at all" },
    ];

    const past = pastAnglesFromDecisions(decisions);
    expect(past.map((p) => p.id)).toEqual(["what-it-means", "wrong-assumption"]);
    expect(past[0]!.rememberLine).toBe(whatItMeansAngle().rememberLine);
  });
});
