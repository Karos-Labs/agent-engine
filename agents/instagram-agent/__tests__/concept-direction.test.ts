import { describe, expect, it } from "vitest";
import {
  ABSTRACT_ANCHORS,
  CONCEPT_COOLDOWN_POSTS,
  CONCEPT_MAX_IN_WINDOW,
  CONCEPT_MIN_SCORE,
  CONCEPT_PATTERNS,
  CONCEPT_WINDOW,
  ConceptSchema,
  MAX_CONCEPT_SCENE_CHARS,
  NO_LIKENESS_PERMIT,
  checkConceptLegibility,
  checkConceptRendered,
  conceptCardKey,
  conceptDecisionSummary,
  conceptEligibility,
  conceptFromDecisionSummary,
  conceptSubjectPalette,
  contestMarker,
  eligibleConceptPatterns,
  entitiesFromSource,
  namedEntities,
  pastConceptsFromDecisions,
  registrableLabel,
  scoreConcept,
  type Concept,
  type ConceptBriefView,
  type ConceptEligibilityInput,
  type ConceptFactCard,
  type ConceptLikenessPermit,
  type ConceptSignals,
  type ConceptTrendSignals,
  type ConceptTrendText,
} from "../src/workflow/concept-direction.js";
import { angleDecisionSummary, angleFromDecisionSummary, selectAngle, type Angle } from "../src/workflow/angle-selection.js";
import { isPlaceholderBriefValue, GENERIC_ICP_NO_INDUSTRY, PLACEHOLDER_ONE_LINER } from "../src/workflow/client-brief.js";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PROMPTS_ROOT } from "./test-helpers.js";

/**
 * RFC-16 §1-§3 and §6.3 — the pure selector, recognition, the subject palette
 * and the L1-L10 legibility guards.
 *
 * Every test below was written by BREAKING THE CODE FIRST and watching the
 * guard refuse: a gate that passes because its fixture never reached it is
 * not a gate. So each one also asserts its own premise — that the score
 * really is 4 before checking that 4 is refused, that the Hebrew fixture
 * really does contain no Latin text before checking that Apple was
 * recognised anyway, that `isPlaceholderBriefValue` really does NOT catch
 * `"unknown business"` before checking that the palette does.
 *
 * The three constraints these tests exist to hold:
 *
 *   (a) SOMETIMES — the four 1-point terms sum to 4, so a story with no
 *       reversal, no figure and no contest cannot reach 5. That single
 *       arithmetic fact is what the whole rate guarantee rests on.
 *   (b) BRAND AND TOPIC GOVERN — L2 (subject) and L1 (claim) are the two
 *       wires, and a placeholder brief turns the mode off entirely.
 *   (c) LIKENESS IS A POLICY DECISION — nothing here grants anything without
 *       a permit passed in explicitly.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BRIEF: ConceptBriefView = {
  positioning: {
    oneLiner: "Karos Labs builds AI marketing agents for small B2B teams.",
    whatWeSell: "a fleet of publishing agents that research, draft and ship social posts",
    differentiators: ["every claim traces back to a named source"],
  },
  icp: { summary: "marketing leads at 10-50 person B2B companies", roles: ["marketing lead", "founder"] },
  offers: [{ name: "agent fleet", summary: "one agent per channel, run weekly" }],
  coreTerms: ["marketing agents", "reporting", "automation"],
  ownAssets: [{ title: "the weekly reporting teardown", kind: "doc", summary: "a teardown of one client's weekly report", sourceRef: "client.getKnowledge/assets" }],
  forbidden: { topics: ["crypto"], claims: [] },
  brandName: "Karos Labs",
};

/** A client with nothing on file: `deriveClientBrief`'s own placeholders, including the `"unknown business"` core term it writes at `client-brief.ts:442-446`. */
const PLACEHOLDER_BRIEF: ConceptBriefView = {
  positioning: { oneLiner: PLACEHOLDER_ONE_LINER, whatWeSell: PLACEHOLDER_ONE_LINER, differentiators: [] },
  icp: { summary: GENERIC_ICP_NO_INDUSTRY, roles: [] },
  offers: [],
  coreTerms: ["unknown business"],
  ownAssets: [],
  forbidden: { topics: [], claims: [] },
};

const FACTS: ConceptFactCard[] = [
  { claim: "Small teams spend 4 hours a week rebuilding the same weekly report.", kind: "stat", source: "Reuters", url: "https://www.reuters.com/tech/reporting" },
  { claim: "Airtable cut its small-team tier this week.", kind: "event", source: "Airtable Newsroom", url: "https://www.airtable.com/news/pricing" },
];

/** A story with a named contest in its headline — the shape a metaphor can carry. */
const RIVALRY_TREND: ConceptTrendSignals & ConceptTrendText = {
  topic: "reporting automation pricing",
  headline: "Notion and Airtable in a pricing battle over small teams",
  mode: "hot-news",
  brandFit: 4,
  interest: 4,
  hasNumbers: true,
  whyNow: "both cut their small-team tier this week",
  angle: "what a price cut means for teams that just want the report to write itself",
  evidenceRefs: ["https://www.reuters.com/tech/pricing"],
  sourceUrls: ["https://notion.so/pricing"],
};

/** The same week, with the contest taken out of it: no reversal, no figure angle, no contrast marker anywhere. */
const FLAT_TREND: ConceptTrendSignals & ConceptTrendText = {
  topic: "weekly reporting",
  headline: "Small teams keep rebuilding the same weekly report",
  mode: "hot-news",
  brandFit: 5,
  interest: 5,
  hasNumbers: true,
  whyNow: "two tools cut their small-team tier this week",
  angle: "the report should write itself",
  evidenceRefs: ["https://www.reuters.com/tech/pricing"],
  sourceUrls: [],
};

/**
 * `distance` has NO default on purpose, and it is the one place these fixtures
 * are allowed to differ from a run only when a test says so explicitly.
 *
 * `create-instagram-agent-workflow.ts:4834-4839` deliberately does not supply
 * `distance` — the scout's per-candidate novelty is not carried onto the claim
 * — so `distance` is absent on every real run and the score's ceiling is 7,
 * not 10. It used to default to 0.8 here, which made every fixture score one
 * point higher than any run could. The two tests that pass a value pass it to
 * make a point about the term itself.
 */
function signalsFor(trend: ConceptTrendSignals & ConceptTrendText, angleId: ConceptSignals["angleId"], distance?: number): ConceptSignals {
  const found = namedEntities(trend, { title: "The report writes itself", rememberLine: "The hours only come back when the report writes itself." }, FACTS, BRIEF);
  return {
    angleId,
    briefFit: 5,
    angleFit: 0.8,
    trend,
    ...(distance !== undefined ? { distance } : {}),
    facts: FACTS,
    entities: found.entities,
    entityBasis: found.basis,
  };
}

function eligibilityInput(signals: ConceptSignals, overrides: Partial<ConceptEligibilityInput> = {}): ConceptEligibilityInput {
  return {
    signals,
    brief: BRIEF,
    pastConcepts: [],
    angleStatus: "selected",
    trendTookSlot: true,
    hasBrandColour: true,
    generatedImagesCap: 4,
    meterPosture: "normal",
    ...overrides,
  };
}

const GOOD_CONCEPT: Concept = {
  pattern: "rivalry",
  anchor: "a marketing lead's chair at the head of one long table",
  situation: "the identical chair opposite it scorched down to the frame",
  scene:
    "a marketing lead's chair at the head of one long table, the identical chair opposite it scorched down to the frame, embers settling on the wood, deep shadow across the lower third",
  readsAs: "two chairs at a long table, one of them burned",
  decodesTo: "Airtable's price cut leaves the reporting seat empty for small teams",
  restsOn: "Airtable cut its small-team tier this week.",
  paletteRole: "the brand accent is the lacquer catching the light on the surviving chair",
  typeZone: "the lower third falls into flat shadow under the table edge",
  usesPermittedMarks: [],
};

function legibilityContext(overrides: Partial<Parameters<typeof checkConceptLegibility>[1]> = {}): Parameters<typeof checkConceptLegibility>[1] {
  return {
    facts: FACTS,
    brief: BRIEF,
    entities: ["reuters", "airtable", "notion"],
    rememberLine: "The hours only come back when the report writes itself.",
    forbid: ["logos and brand marks, recognisable real people"],
    hasBrandColour: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.4 — the score, and the brake the whole rate guarantee rests on
// ─────────────────────────────────────────────────────────────────────────────

describe("the score (§1.4)", () => {
  it("a story with no reversal, no figure and no contest cannot reach the threshold", () => {
    const signals = signalsFor(FLAT_TREND, "what-it-means", 0.9);

    // Premise, asserted rather than assumed: this fixture scores EVERY
    // 1-point term there is. It is a hot-news story, at the top of the
    // interest scale, carrying numbers, maximally distant from what this
    // account already posted. Nothing else about it can be improved.
    const { score, terms } = scoreConcept(signals);
    expect(terms.map((t) => t.term).sort()).toEqual(["distance>=0.6", "hot-news", "interest>=4", "numbers"]);
    expect(terms.every((t) => t.points === 1)).toBe(true);
    expect(score).toBe(4);
    expect(score).toBeLessThan(CONCEPT_MIN_SCORE);

    const verdict = conceptEligibility(eligibilityInput(signals));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain(`score 4 is under the ${CONCEPT_MIN_SCORE} threshold`);
    expect(verdict.rule).toContain("→ not eligible");

    // And the control: the SAME story with one of the three 2-point shape
    // terms present clears it. The gate is the shape, not the fixture.
    const withContest = signalsFor({ ...FLAT_TREND, whyNow: "the two tools are now in an open battle over small teams" }, "what-it-means", 0.9);
    expect(scoreConcept(withContest).score).toBe(6);
    expect(conceptEligibility(eligibilityInput(withContest)).eligible).toBe(true);
  });

  it("scores the reversal, the contest and the figure at two points each, and says where it saw them", () => {
    const signals = signalsFor(RIVALRY_TREND, "wrong-assumption");
    const { score, terms } = scoreConcept(signals);
    expect(terms.find((t) => t.term === "reversal")).toEqual({ term: "reversal", points: 2, why: 'angle "wrong-assumption"' });
    expect(terms.find((t) => t.term === "contest")?.why).toBe('contrast marker "battle" in headline');
    // 2 (reversal) + 2 (contest) + hot-news + interest>=4 + numbers = 7, which
    // is also the ceiling a real run can reach: `distance` is never supplied
    // by the workflow, so the fourth 1-point term is absent here exactly as it
    // is in production.
    expect(score).toBe(7);
    expect(terms.map((t) => t.term)).not.toContain("distance>=0.6");
  });

  it('the "scale" term needs a real figure on a stat card, not just the surprising-number angle', () => {
    const noFigure: ConceptFactCard[] = [{ claim: "Support leads describe triage as the least designed part of their week.", kind: "stat", source: "Reuters" }];
    const base = signalsFor(FLAT_TREND, "surprising-number", 0.1);

    expect(scoreConcept({ ...base, facts: noFigure }).terms.map((t) => t.term)).not.toContain("scale");
    // The premise: the same angle over a card that DOES carry a figure scores it.
    const scored = scoreConcept({ ...base, facts: FACTS }).terms.find((t) => t.term === "scale");
    expect(scored?.points).toBe(2);
    expect(scored?.why).toContain("4");
  });

  it("reads the contrast marker in Hebrew, where a capitalisation heuristic reads nothing at all", () => {
    expect(contestMarker("אפל לעומת סמסונג בקרב על המסך המתקפל")).toBe("לעומת");
    expect(contestMarker("Apple vs. Samsung, and the fold nobody asked for")).toBe("vs");
    expect(contestMarker("a calm week for reporting tools")).toBeUndefined();
    // Whole words only: a lexicon that stems fires on prose.
    expect(contestMarker("the team battles the spreadsheet")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.3 — recognition
// ─────────────────────────────────────────────────────────────────────────────

describe("recognition (§1.3)", () => {
  it("recognises Apple and Samsung from a Hebrew headline whose only Latin text is in the fact-card sources", () => {
    const hebrewFacts: ConceptFactCard[] = [
      { claim: "מכירות המכשירים המתקפלים צמחו ב-25% ברבעון האחרון.", kind: "stat", source: "Apple Newsroom" },
      { claim: "החברה הכריזה השבוע על דגם חדש.", kind: "event", source: "Samsung Press Release" },
    ];
    const hebrewTrend: ConceptTrendText = {
      topic: "מסכים מתקפלים",
      headline: "אפל מול סמסונג: הקרב על המסך המתקפל",
      whyNow: "שתי החברות הכריזו השבוע",
      angle: "מה זה אומר לצוותים קטנים",
    };
    const hebrewBrief: ConceptBriefView = { ...BRIEF, coreTerms: ["סוכני שיווק"], offers: [], ownAssets: [] };

    // THE PREMISE, and the reason this test exists: there is not one Latin
    // letter anywhere in the story itself. A detector built on capitalisation
    // (`HEADING_HAS_PROPER_NOUN`, whose own comment admits it is silent in
    // Hebrew) would return nothing here and would disable the whole feature
    // for a Hebrew client, which is a defect and not a policy.
    const storyText = [hebrewTrend.topic, hebrewTrend.headline, hebrewTrend.whyNow, hebrewTrend.angle, ...hebrewFacts.map((f) => f.claim)].join(" ");
    expect(/\p{Script=Latin}/u.test(storyText)).toBe(false);

    const found = namedEntities(hebrewTrend, undefined, hebrewFacts, hebrewBrief);
    expect(found.entities).toEqual(["apple", "samsung"]);
    expect(found.basis).toBe("fact-card sources");
  });

  it("takes the registrable label out of a host and refuses anything that is not one", () => {
    expect(registrableLabel("https://www.apple.com/newsroom/foldables")).toBe("apple");
    expect(registrableLabel("news.samsung.co.uk")).toBe("samsung");
    // `evidenceRefs` legitimately carries client document headings; a heading is not an organisation.
    expect(registrableLabel("market-strategy#pricing")).toBeUndefined();
    expect(registrableLabel("")).toBeUndefined();
  });

  it("takes the organisation out of a source field and nothing out of a source that names no organisation", () => {
    expect(entitiesFromSource("Apple Newsroom")).toEqual(["apple"]);
    expect(entitiesFromSource("The Wall Street Journal")).toEqual(["wall street journal"]);
    expect(entitiesFromSource("apple.com")).toEqual(["apple"]);
    // A survey is not an organisation, and treating it as one would make the recognition gate a formality.
    expect(entitiesFromSource("internal client survey")).toEqual([]);
    expect(entitiesFromSource("סקר פנימי")).toEqual([]);
  });

  it("admits a core term as an entity only when the story itself says it", () => {
    const silent = namedEntities({ headline: "a quiet week for small teams", whyNow: "" }, undefined, [], BRIEF);
    expect(silent.entities).toEqual([]);

    const spoken = namedEntities({ headline: "reporting is the hour nobody costs", whyNow: "" }, undefined, [], BRIEF);
    expect(spoken.entities).toContain("reporting");

    // Why this matters: `coreTerms` is required to be non-empty by
    // `ClientBriefSchema`, so admitting it ungated would make
    // `entities.length > 0` true for every story ever scouted and the
    // recognition gate would stop being a gate.
    expect(BRIEF.coreTerms.length).toBeGreaterThan(0);
  });

  it("uses capitalised names as a bonus, never as the gate, and skips the first word of a sentence", () => {
    const found = namedEntities({ headline: "Everything changed when Airtable cut its tier", whyNow: "" }, undefined, [], undefined);
    expect(found.entities).toContain("airtable");
    expect(found.entities).not.toContain("everything");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — the subject palette
// ─────────────────────────────────────────────────────────────────────────────

describe("the subject palette (§3.1)", () => {
  it("a placeholder brief yields an empty subject palette and the selector returns not-eligible", () => {
    // THE PREMISE. `isPlaceholderBriefValue` was written for the two prose
    // one-liners and does NOT catch the core term `deriveClientBrief` writes
    // when a client has no industry, no description and no documents. If it
    // ever did, this module's extra check would be redundant — and if this
    // assertion ever flips, the reader should know the extra check is the one
    // doing the work here, not the borrowed one.
    expect(isPlaceholderBriefValue(PLACEHOLDER_ONE_LINER)).toBe(true);
    expect(isPlaceholderBriefValue("unknown business")).toBe(false);

    expect(conceptSubjectPalette(PLACEHOLDER_BRIEF)).toEqual([]);

    // A story that would otherwise sail through: score 8, two entities, brand fit 4.
    const signals = { ...signalsFor(RIVALRY_TREND, "wrong-assumption"), briefFit: 5 };
    expect(scoreConcept(signals).score).toBeGreaterThanOrEqual(CONCEPT_MIN_SCORE);

    const verdict = conceptEligibility(eligibilityInput(signals, { brief: PLACEHOLDER_BRIEF }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.subjects).toEqual([]);
    expect(verdict.reason).toContain("no subject palette");

    // The control: the same story against a real brief is eligible.
    expect(conceptEligibility(eligibilityInput(signals)).eligible).toBe(true);
  });

  it("draws only from the client's own world, and puts the client's own mark behind the permit", () => {
    const palette = conceptSubjectPalette(BRIEF);
    expect(palette).toContain("marketing lead");
    expect(palette).toContain("agent fleet");
    expect(palette).toContain("the weekly reporting teardown");
    // A brand mark is a thing to be DRAWN, and drawing it is what `ownMarks` decides.
    expect(palette).not.toContain("Karos Labs");
    expect(conceptSubjectPalette(BRIEF, { ...NO_LIKENESS_PERMIT, ownMarks: true })).toContain("Karos Labs");
  });

  it("adds a third-party mark only when the permit names it", () => {
    expect(conceptSubjectPalette(BRIEF)).not.toContain("Duolingo");
    const permit: ConceptLikenessPermit = { thirdPartyMarks: ["Duolingo"], publicFigures: [], ownMarks: false };
    expect(conceptSubjectPalette(BRIEF, permit)).toContain("Duolingo");
    // The default and "no record at all" are the same answer.
    expect(conceptSubjectPalette(BRIEF, NO_LIKENESS_PERMIT)).toEqual(conceptSubjectPalette(BRIEF, undefined));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 — the pattern preconditions
// ─────────────────────────────────────────────────────────────────────────────

describe("the pattern vocabulary (§2.1)", () => {
  it("is closed, and offers the model only the patterns this story supports", () => {
    expect(CONCEPT_PATTERNS.length).toBe(7);
    const patterns = eligibleConceptPatterns(signalsFor(RIVALRY_TREND, "wrong-assumption"), BRIEF);
    expect(patterns).toContain("rivalry");
    expect(patterns).toContain("reversal");
    expect(patterns).toContain("the-race");
    expect(patterns).not.toContain("the-crown"); // no rank or superlative on any stat card
  });

  it("refuses rivalry when there is only one recognised entity, however loud the contest", () => {
    const signals = signalsFor(RIVALRY_TREND, "what-it-means");
    expect(contestMarker(RIVALRY_TREND.headline)).toBe("battle");
    expect(eligibleConceptPatterns({ ...signals, entities: ["airtable"] }, BRIEF)).not.toContain("rivalry");
    expect(eligibleConceptPatterns({ ...signals, entities: ["airtable", "notion"] }, BRIEF)).toContain("rivalry");
  });

  it("an empty pattern set is not eligible, whatever the score says", () => {
    const signals: ConceptSignals = {
      ...signalsFor(FLAT_TREND, "wrong-assumption", 0.9),
      facts: [{ claim: "Support leads describe triage as the least designed part of their week.", kind: "quote", source: "Reuters" }],
      trend: { ...FLAT_TREND, mode: "deep-value", whyNow: "" },
    };
    const brief: ConceptBriefView = { ...BRIEF, positioning: { ...BRIEF.positioning, differentiators: [] } };
    // The premise: this story still scores, so the pattern set is what refuses it.
    expect(scoreConcept(signals).score).toBeGreaterThanOrEqual(CONCEPT_MIN_SCORE);
    expect(eligibleConceptPatterns(signals, brief)).toEqual(["reversal"]);

    const noShape = { ...signals, angleId: "what-it-means" as const };
    expect(eligibleConceptPatterns(noShape, brief)).toEqual([]);
    const verdict = conceptEligibility(eligibilityInput(noShape, { brief, runMode: "on" }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("no concept pattern");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.3 — L1-L10
// ─────────────────────────────────────────────────────────────────────────────

describe("the legibility guard (§2.3)", () => {
  it("accepts a concept that clears every clause", () => {
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext())).toEqual({ verdict: "accepted" });
  });

  it("L1 discards a concept resting on a claim this run never fetched", () => {
    const concept = { ...GOOD_CONCEPT, restsOn: "Airtable doubled its revenue last year." };
    const verdict = checkConceptLegibility(concept, legibilityContext());
    expect(verdict).toMatchObject({ verdict: "discarded", clause: "L1" });
  });

  it("L1 matches a card the way `selectAngle` matches one — case and whitespace, nothing else", () => {
    const sloppy = `   ${FACTS[1]!.claim.toUpperCase()}   `;
    expect(conceptCardKey(sloppy)).toBe(conceptCardKey(FACTS[1]!.claim));
    expect(checkConceptLegibility({ ...GOOD_CONCEPT, restsOn: sloppy }, legibilityContext())).toEqual({ verdict: "accepted" });

    // The pin: `angle-selection.ts`'s own (private) matcher accepts exactly
    // the same sloppiness, so these two cannot drift into disagreeing about
    // what "verbatim" means.
    const angle: Angle = {
      id: "what-it-means",
      title: "The seat nobody costs",
      rememberLine: "The hours only come back when the report writes itself.",
      restsOn: [sloppy],
      whyThisClient: "we build the agents that write it",
      briefFit: 5,
    };
    const picked = selectAngle([angle], {
      brief: { coreTerms: BRIEF.coreTerms, offers: BRIEF.offers, icp: { summary: BRIEF.icp.summary, roles: BRIEF.icp.roles, pains: [], industries: [], geos: [] } },
      facts: FACTS,
      pastAngles: [],
      recentExcerpts: [],
      mode: "hot-news",
    });
    expect(picked.status).toBe("selected");
  });

  it("L2 discards a concept whose anchor names nothing in the client's own brief", () => {
    // The Duolingo owl on the Iron Throne is a fine picture and it is not
    // about this client. This is the original audit failure — a real-estate
    // carousel for an AI marketing agency — with better art.
    const offClient = { ...GOOD_CONCEPT, anchor: "a cartoon owl on an iron throne", scene: "a cartoon owl on an iron throne amid fire and embers, deep shadow across the lower third" };
    const verdict = checkConceptLegibility(offClient, legibilityContext());
    expect(verdict).toMatchObject({ verdict: "discarded", clause: "L2" });
    expect((verdict as { reason: string }).reason).toContain("names nothing in the client's own brief");
  });

  it("L2's control: an anchor built out of a palette token passes", () => {
    // The premise: the token really is in the palette and really is in the anchor.
    expect(conceptSubjectPalette(BRIEF)).toContain("marketing lead");
    expect(GOOD_CONCEPT.anchor).toContain("marketing lead");
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext())).toEqual({ verdict: "accepted" });
  });

  it("L3 discards an anchor that is not a thing", () => {
    expect(ABSTRACT_ANCHORS).toContain("momentum");
    const abstract = { ...GOOD_CONCEPT, anchor: "the marketing lead's momentum" };
    expect(checkConceptLegibility(abstract, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L3" });
  });

  it("L4 discards a decode that names no recognised entity", () => {
    const vague = { ...GOOD_CONCEPT, decodesTo: "the reporting seat is empty for small teams" };
    const verdict = checkConceptLegibility(vague, legibilityContext());
    expect(verdict).toMatchObject({ verdict: "discarded", clause: "L4" });
    expect((verdict as { reason: string }).reason).toContain("entities");

    // The control: naming one of them is enough, and the recognised set is
    // what decides — the same sentence passes once `airtable` is recognised.
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext())).toEqual({ verdict: "accepted" });
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext({ entities: ["reuters"] }))).toMatchObject({ verdict: "discarded", clause: "L4" });
  });

  it("L4 also discards a decode that names an entity but says nothing this slide is about", () => {
    const elsewhere = { ...GOOD_CONCEPT, decodesTo: "Airtable hired a new head of design in Lisbon" };
    expect(checkConceptLegibility(elsewhere, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L4" });
  });

  it("L5 discards two moves in one situation, and a simile inside the scene", () => {
    expect(checkConceptLegibility({ ...GOOD_CONCEPT, situation: "the chair opposite scorched while the table keeps setting itself" }, legibilityContext())).toMatchObject({
      verdict: "discarded",
      clause: "L5",
    });
    expect(checkConceptLegibility({ ...GOOD_CONCEPT, scene: `${GOOD_CONCEPT.scene.slice(0, 180)}, lit like a stage` }, legibilityContext())).toMatchObject({
      verdict: "discarded",
      clause: "L5",
    });
  });

  it("L6 demotes a concept whose decode is its own description, rather than discarding it", () => {
    const literal = { ...GOOD_CONCEPT, readsAs: "Airtable's price cut leaves the reporting seat empty for small teams." };
    const verdict = checkConceptLegibility(literal, legibilityContext());
    expect(verdict.verdict).toBe("demoted");
    expect(verdict).toMatchObject({ clause: "L6" });
  });

  it("L7 enforces the forbid list instead of advising it", () => {
    const forbidden = { ...GOOD_CONCEPT, paletteRole: "the accent is the glow of a crypto ticker behind the chair" };
    expect(checkConceptLegibility(forbidden, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L7" });
    // From `art.forbid` too, not only from the brief.
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext({ forbid: ["long table"] }))).toMatchObject({ verdict: "discarded", clause: "L7" });
  });

  it("L8 discards when there is no brand colour to obey, and when the palette has no role", () => {
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext({ hasBrandColour: false }))).toMatchObject({ verdict: "discarded", clause: "L8" });
    expect(checkConceptLegibility({ ...GOOD_CONCEPT, paletteRole: "   " }, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L8" });
  });

  it("L9 discards a mark the permit does not name, and accepts one it does", () => {
    const withMarks = { ...GOOD_CONCEPT, usesPermittedMarks: ["Nike"] };
    expect(checkConceptLegibility(withMarks, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L9" });
    const permit: ConceptLikenessPermit = { thirdPartyMarks: ["Nike"], publicFigures: [], ownMarks: false };
    expect(checkConceptLegibility(withMarks, legibilityContext({ permit }))).toEqual({ verdict: "accepted" });
    // A permit that names other marks is not a permit for this one.
    const other: ConceptLikenessPermit = { thirdPartyMarks: ["Adidas"], publicFigures: [], ownMarks: false };
    expect(checkConceptLegibility(withMarks, legibilityContext({ permit: other }))).toMatchObject({ verdict: "discarded", clause: "L9" });
  });

  // ── L9's first half: the text the GENERATOR is handed ──
  //
  // `usesPermittedMarks` is the model's own declaration, so validating only
  // that enforced the honest path and nothing else. The only field that
  // reaches the diffusion model is `scene` (`conceptPrompt = concept.scene`),
  // and L7 cannot cover it: its matcher compares WHOLE forbid entries as
  // substrings, and the standing entries are the sentences "logos and brand
  // marks" / "recognisable real people", which fire only on a scene that
  // quotes the policy verbatim. The fixture below is the realistic one — the
  // real `STANDING_IMAGE_FORBID`, an empty permit, and the entity names the
  // model was handed in its own input.
  const REALISTIC_FORBID = ["logos and brand marks", "recognisable real people"];

  it("L9 discards a concept that writes an unpermitted mark into the scene and declares nothing", () => {
    const undeclared: Concept = {
      ...GOOD_CONCEPT,
      scene:
        "a marketing lead's chair at the head of one long table beside a Notion banner, the Airtable logo glowing on the wall behind them, deep shadow across the lower third",
      usesPermittedMarks: [],
    };
    const verdict = checkConceptLegibility(undeclared, legibilityContext({ forbid: REALISTIC_FORBID }));
    expect(verdict).toMatchObject({ verdict: "discarded", clause: "L9" });
    expect((verdict as { reason: string }).reason).toContain("no permission for");

    // The premise, asserted rather than assumed: L7 lets this through, so this
    // clause is the only thing standing in front of it.
    expect(REALISTIC_FORBID.some((f) => undeclared.scene.toLowerCase().includes(f))).toBe(false);
    // And the control: the same concept with the names taken out is accepted,
    // so the clause is matching the names and not the sentence.
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext({ forbid: REALISTIC_FORBID }))).toEqual({ verdict: "accepted" });
  });

  it("L9 catches a bare mark noun with no name on it, and stands down when the permit grants something", () => {
    const mascot = { ...GOOD_CONCEPT, scene: `${GOOD_CONCEPT.scene}, an owl mascot perched on the back of the chair` };
    expect(checkConceptLegibility(mascot, legibilityContext({ forbid: REALISTIC_FORBID }))).toMatchObject({ verdict: "discarded", clause: "L9" });
    const permit: ConceptLikenessPermit = { thirdPartyMarks: ["Duolingo"], publicFigures: [], ownMarks: false };
    expect(checkConceptLegibility(mascot, legibilityContext({ forbid: REALISTIC_FORBID, permit }))).toEqual({ verdict: "accepted" });
  });

  it("L9 does not fire on the client's own world, which L2 REQUIRES the anchor to name", () => {
    // `entities` carries the client's own terms by §1.3's source 3, and the
    // subject palette is built from the same brief. Without the palette
    // subtraction, L2 and L9 would contradict each other and every concept
    // would be discarded — so this is the clause's own premise, not a bonus.
    const withOwnTerms = legibilityContext({ forbid: REALISTIC_FORBID, entities: ["reuters", "airtable", "marketing lead", "weekly reporting"] });
    expect(checkConceptLegibility(GOOD_CONCEPT, withOwnTerms)).toEqual({ verdict: "accepted" });
    expect(conceptSubjectPalette(BRIEF).some((t) => t.toLowerCase().includes("marketing lead"))).toBe(true);
  });

  it("L2 discards a concept whose scene never names the token its anchor was grounded on", () => {
    // The anchor is grounded and stays grounded; only `scene` loses the token.
    // `scene` is the only field the generator receives, so this is the whole
    // subject wire as far as the pixels are concerned.
    const drifted = {
      ...GOOD_CONCEPT,
      scene: "a chair at the head of one long table, the identical chair opposite it scorched down to the frame, embers settling on the wood, deep shadow across the lower third",
    };
    const verdict = checkConceptLegibility(drifted, legibilityContext());
    expect(verdict).toMatchObject({ verdict: "discarded", clause: "L2" });
    expect((verdict as { reason: string }).reason).toContain("the only text the generator is given");
    // The control: the anchor alone is unchanged and still passes L2's first
    // half, so this is the second half firing and not the first.
    expect(checkConceptLegibility(GOOD_CONCEPT, legibilityContext())).toEqual({ verdict: "accepted" });
  });

  it("L10 discards a scene too long for a visual need to carry", () => {
    const long = { ...GOOD_CONCEPT, scene: `${GOOD_CONCEPT.scene} ${"x".repeat(MAX_CONCEPT_SCENE_CHARS)}` };
    expect(long.scene.length).toBeGreaterThan(MAX_CONCEPT_SCENE_CHARS);
    expect(checkConceptLegibility(long, legibilityContext())).toMatchObject({ verdict: "discarded", clause: "L10" });
    // The schema is the first line of that defence; L10 is the second, for a
    // concept that was never parsed through it (a fixture, a resumed run).
    expect(ConceptSchema.safeParse(long).success).toBe(false);
    expect(ConceptSchema.safeParse(GOOD_CONCEPT).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The prompt's worked example, run through the code that judges the answer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `- \`field\`: "value"` bullets out of the prompt's ONE worked shape.
 *
 * Whitespace is collapsed first, so a bullet wrapped across source lines reads
 * as the single string the model sees.
 */
function workedShapeFromPrompt(): Record<string, string> {
  const md = readFileSync(path.join(PROMPTS_ROOT, "instagram-concept", "latest.md"), "utf8");
  const start = md.indexOf("One worked shape");
  expect(start, "the prompt must still carry a worked shape").toBeGreaterThan(-1);
  const block = md.slice(start).replace(/\s+/gu, " ");
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/- `(\w+)`: "([^"]*)"/gu)) out[m[1]!] = m[2]!;
  return out;
}

describe("the prompt's worked example is a concept the code accepts", () => {
  // The model is shown exactly one fully-worked shape and it imitates it. When
  // that shape violates a clause, the $0.029 Sonnet call is bought and thrown
  // away SILENTLY — a discard is free and leaves no failure, so it surfaces
  // only as a depressed shipping rate weeks later.
  //
  // Two real ones were shipped in the first cut of this prompt: a `situation`
  // reading "one seat scorched and still smoking while the other is untouched"
  // (L5 — it carries both " and " and " while ") and an `anchor` reading "two
  // identical high-backed chairs at the head of one long table" (L2 — it names
  // no token from any client's subject palette). Every fixture in this file
  // wrote its own compliant strings, so nothing caught either.
  it("carries the fields the guards read", () => {
    const shape = workedShapeFromPrompt();
    for (const field of ["anchor", "situation", "scene", "paletteRole", "typeZone", "readsAs"]) {
      expect(shape[field], `the worked shape must still demonstrate \`${field}\``).toBeTruthy();
    }
  });

  it("passes checkConceptLegibility on the clauses the example itself decides", () => {
    const shape = workedShapeFromPrompt();
    // `restsOn`, `decodesTo` and `pattern` are about a DIFFERENT story than
    // this file's fixture, so L1 and L4 cannot be judged from the prompt
    // alone and keep the fixture's values. Every field the example does
    // demonstrate is taken from the prompt verbatim.
    const asWritten: Concept = {
      ...GOOD_CONCEPT,
      anchor: shape["anchor"]!,
      situation: shape["situation"]!,
      scene: shape["scene"]!,
      paletteRole: shape["paletteRole"]!,
      typeZone: shape["typeZone"]!,
      readsAs: shape["readsAs"]!,
    };
    expect(checkConceptLegibility(asWritten, legibilityContext())).toEqual({ verdict: "accepted" });
  });

  it("would refuse the shape that shipped first, which is how we know the guard reads the prompt", () => {
    // The premise, asserted. Swap either of the two original strings back in
    // and the clause fires — so the test above is measuring the prompt's
    // content and not merely that some string parses.
    const shape = workedShapeFromPrompt();
    const base: Concept = { ...GOOD_CONCEPT, anchor: shape["anchor"]!, situation: shape["situation"]!, scene: shape["scene"]! };
    expect(checkConceptLegibility({ ...base, situation: "one seat scorched and still smoking while the other is untouched" }, legibilityContext())).toMatchObject({
      verdict: "discarded",
      clause: "L5",
    });
    expect(checkConceptLegibility({ ...base, anchor: "two identical high-backed chairs at the head of one long table" }, legibilityContext())).toMatchObject({
      verdict: "discarded",
      clause: "L2",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — what was actually drawn
// ─────────────────────────────────────────────────────────────────────────────

describe("the rendered check (§6.3)", () => {
  it("drops a frame that drew a mark nobody permitted, and keeps one the permit names", () => {
    const drawn = { subjects: ["Apple logo on a white circular badge", "a long table"], textInImage: [], hasPeople: false };
    expect(checkConceptRendered(drawn).ok).toBe(false);
    const permit: ConceptLikenessPermit = { thirdPartyMarks: ["Apple"], publicFigures: [], ownMarks: false };
    expect(checkConceptRendered(drawn, permit)).toEqual({ ok: true });
  });

  it("drops a frame that drew a named person with no likeness permission, and keeps a generic one", () => {
    const named = { subjects: ["a man who resembles Elon Musk at the head of the table"], textInImage: [], hasPeople: true };
    expect(checkConceptRendered(named).ok).toBe(false);
    const generic = { subjects: ["a founder alone at the head of the table"], textInImage: [], hasPeople: true };
    expect(checkConceptRendered(generic)).toEqual({ ok: true });
    const permit: ConceptLikenessPermit = { thirdPartyMarks: [], publicFigures: ["Elon Musk"], ownMarks: false };
    expect(checkConceptRendered(named, permit)).toEqual({ ok: true });
  });

  it("drops a frame carrying lettering, which is the constraint the pipeline has never actually verified", () => {
    const lettered = { subjects: ["a long table"], textInImage: ["REPORTING", "2026"], hasPeople: false };
    const verdict = checkConceptRendered(lettered);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("REPORTING");
  });

  it("does not treat a synthetic look as a failure — every image on this path is generated", () => {
    expect(checkConceptRendered({ subjects: ["two chairs", "embers"], textInImage: [], hasPeople: false, description: "a glossy render of two chairs" })).toEqual({ ok: true });
  });

  // ── the shapes `media.inspectImages` ACTUALLY emits ──
  //
  // `inspect-images.ts:133` instructs the model to "NAME what you can actually
  // recognise — the team, club, brand, product, public figure, city, landmark
  // … and say so plainly (\"Juventus crest on the shirt\")". That produces
  // BARE NAMES. The first cut of this check required one of twelve English
  // mark nouns in the same `subjects` string before it would look, and a
  // generic person noun AND a proper noun together before it would drop a
  // likeness — so every shape below returned `{ok: true}` and the two tests
  // above passed only because their fixtures happened to contain a cue word.
  //
  // These are the cases that were measured passing the old code. Break the
  // recognition rule in `checkConceptRendered` and every one of them goes
  // green again, which is the point of pinning them by the phrasing the tool
  // is instructed to produce rather than by a phrasing that suits the gate.
  it.each([
    ["a bare public-figure name, no person noun anywhere", { subjects: ["Tim Cook"], textInImage: [], hasPeople: true }],
    ["a public figure named inside a scene description", { subjects: ["Tim Cook at the head of the table", "embers on the floor"], textInImage: [], hasPeople: true }],
    ["a brand named as a product, with no mark noun", { subjects: ["Nike sneakers"], textInImage: [], hasPeople: false }],
    ["a mascot, which no mark noun in the first cut covered", { subjects: ["the Duolingo owl mascot", "fire and embers"], textInImage: [], hasPeople: false }],
    ["a name the model put in `description` rather than `subjects`", { subjects: ["a throne"], description: "Tim Cook sits on the Iron Throne", textInImage: [], hasPeople: true }],
  ])("drops %s", (_label, drawn) => {
    expect(checkConceptRendered(drawn).ok).toBe(false);
  });

  // The other half of the premise. A gate that drops everything is not a gate,
  // and the safe default palette §5.1 names — generic archetypes, the client's
  // own world — has to survive it or the mode never ships a frame.
  it.each([
    ["a generic archetype", { subjects: ["a courier's satchel on a doorstep"], textInImage: [], hasPeople: false }],
    ["a role with people in frame", { subjects: ["a founder at a long table", "embers"], textInImage: [], hasPeople: true }],
    ["prose with no name in it", { subjects: ["a chair"], description: "one chair at the head of a long table, the other scorched", textInImage: [], hasPeople: false }],
  ])("keeps %s", (_label, drawn) => {
    expect(checkConceptRendered(drawn)).toEqual({ ok: true });
  });

  it("lets the permit through by name, in `description` as well as `subjects`", () => {
    const drawn = { subjects: ["a throne"], description: "Tim Cook sits on a throne", textInImage: [], hasPeople: true };
    const permit: ConceptLikenessPermit = { thirdPartyMarks: [], publicFigures: ["Tim Cook"], ownMarks: false };
    expect(checkConceptRendered(drawn, permit)).toEqual({ ok: true });
    // And a permit for somebody else is not a permit for this one.
    const elsewhere: ConceptLikenessPermit = { thirdPartyMarks: [], publicFigures: ["Elon Musk"], ownMarks: false };
    expect(checkConceptRendered(drawn, elsewhere).ok).toBe(false);
  });

  it("lets the client's OWN mark through on exactly L9's condition, and not otherwise", () => {
    const drawn = { subjects: ["the Karos Labs wordmark on the wall"], textInImage: [], hasPeople: false };
    const granted: ConceptLikenessPermit = { thirdPartyMarks: [], publicFigures: [], ownMarks: true };
    expect(checkConceptRendered(drawn, granted, "Karos Labs")).toEqual({ ok: true });
    // `ownMarks` without a brand name to compare against grants nothing, and a
    // brand name without `ownMarks` is not a grant.
    expect(checkConceptRendered(drawn, granted, undefined).ok).toBe(false);
    expect(checkConceptRendered(drawn, NO_LIKENESS_PERMIT, "Karos Labs").ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.7 — the ledger codec and the cooldown
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SUMMARY = 'instagram post: "the seat nobody costs" (mode: hot-news; source: trend; archetypes: photo,stat-callout)';
const LEDGER_ANGLE: Angle = {
  id: "wrong-assumption",
  title: "The seat nobody costs",
  rememberLine: "The hours only come back when the report writes itself.",
  restsOn: [FACTS[0]!.claim],
  whyThisClient: "we build the agents that write it",
  briefFit: 5,
};

function decisionsWithConceptAt(postsAgo: number, count = 1): Array<{ at: number; summary: string }> {
  const rows: Array<{ at: number; summary: string }> = [];
  for (let i = 0; i < 10; i++) {
    const carries = i >= postsAgo && i < postsAgo + count;
    rows.push({
      at: 1000 - i,
      summary: carries ? conceptDecisionSummary(BASE_SUMMARY, { n: 1, pattern: "rivalry", anchor: `a marketing lead's chair ${i}` }) : BASE_SUMMARY,
    });
  }
  return rows;
}

describe("the ledger codec and the cooldown (§1.7)", () => {
  it("round-trips through a summary that also carries an angle, in either order", () => {
    const angleFirst = conceptDecisionSummary(angleDecisionSummary(BASE_SUMMARY, LEDGER_ANGLE), { n: 2, pattern: "reversal", anchor: "a marketing lead's chair" });
    const conceptFirst = angleDecisionSummary(conceptDecisionSummary(BASE_SUMMARY, { n: 2, pattern: "reversal", anchor: "a marketing lead's chair" }), LEDGER_ANGLE);

    for (const summary of [angleFirst, conceptFirst]) {
      expect(conceptFromDecisionSummary(summary)).toEqual({ n: 2, pattern: "reversal", anchor: "a marketing lead's chair" });
      // And the angle codec still reads a CLEAN remember line out of the same
      // row: the angle rotation measures novelty against these strings, so a
      // concept fragment glued onto one would quietly corrupt next week's pick.
      expect(angleFromDecisionSummary(summary)?.rememberLine).toBe(LEDGER_ANGLE.rememberLine);
      expect(/mode: hot-news/u.test(summary)).toBe(true);
    }
  });

  it("reads nothing out of a row that carries no concept, rather than defaulting one", () => {
    expect(conceptFromDecisionSummary(BASE_SUMMARY)).toBeUndefined();
    expect(conceptFromDecisionSummary(angleDecisionSummary(BASE_SUMMARY, LEDGER_ANGLE))).toBeUndefined();
    expect(pastConceptsFromDecisions([{ at: 1, summary: BASE_SUMMARY }])).toEqual([]);
  });

  it("counts POSTS, not concept rows, when it reads the log back", () => {
    const past = pastConceptsFromDecisions(decisionsWithConceptAt(4));
    expect(past.length).toBe(1);
    expect(past[0]!.postsAgo).toBe(4);
  });

  it("the cooldown refuses a second concept within 3 posts", () => {
    const signals = signalsFor(RIVALRY_TREND, "wrong-assumption");
    // The premise: this story is otherwise eligible, so the cooldown is what refuses it.
    expect(conceptEligibility(eligibilityInput(signals)).eligible).toBe(true);

    for (let postsAgo = 0; postsAgo < CONCEPT_COOLDOWN_POSTS; postsAgo++) {
      const verdict = conceptEligibility(eligibilityInput(signals, { pastConcepts: pastConceptsFromDecisions(decisionsWithConceptAt(postsAgo)) }));
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("cooldown");
      expect(verdict.cooldown.postsSinceLastConcept).toBe(postsAgo);
    }

    // The control, and the arithmetic the 25% ceiling rests on: the fourth
    // post after a concept may have one.
    const clear = conceptEligibility(eligibilityInput(signals, { pastConcepts: pastConceptsFromDecisions(decisionsWithConceptAt(CONCEPT_COOLDOWN_POSTS)) }));
    expect(clear.eligible).toBe(true);
    expect(clear.rule).toContain(`3 posts since the last concept ≥ ${CONCEPT_COOLDOWN_POSTS}`);
  });

  it("the window is a second ceiling: two in eight is the most this account gets", () => {
    const signals = signalsFor(RIVALRY_TREND, "wrong-assumption");
    const rows = [...decisionsWithConceptAt(3), ...[]];
    rows[6] = { at: 1000 - 6, summary: conceptDecisionSummary(BASE_SUMMARY, { n: 1, pattern: "the-race", anchor: "a founder at a starting block" }) };
    const past = pastConceptsFromDecisions(rows);
    expect(past.map((p) => p.postsAgo)).toEqual([3, 6]);

    const verdict = conceptEligibility(eligibilityInput(signals, { pastConcepts: past }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain(`ceiling of ${CONCEPT_MAX_IN_WINDOW}`);
    expect(verdict.cooldown.usedInWindow).toBe(2);

    // Outside the window it stops counting.
    const old = past.map((p) => ({ ...p, postsAgo: p.postsAgo + CONCEPT_WINDOW }));
    expect(conceptEligibility(eligibilityInput(signals, { pastConcepts: old })).eligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.5 / §1.7 — the rest of the verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("the verdict (§1.5, §1.7)", () => {
  it("itemises its own arithmetic on a run that declined, not only on one that fired", () => {
    const verdict = conceptEligibility(eligibilityInput(signalsFor(FLAT_TREND, "what-it-means")));
    expect(verdict.eligible).toBe(false);
    expect(verdict.score).toBe(3);
    expect(verdict.threshold).toBe(CONCEPT_MIN_SCORE);
    expect(verdict.terms.length).toBe(3);
    expect(verdict.recognition.entities.length).toBeGreaterThan(0);
    expect(verdict.grounding).toMatchObject({ basis: "trend", brandFit: 5, floor: 4 });
    expect(verdict.subjects.length).toBeGreaterThan(0);
    expect(verdict.rule).toMatch(/^score 3 < 5, entities\(/u);
  });

  it("fails OFF when there is no selected angle", () => {
    const signals = signalsFor(RIVALRY_TREND, "wrong-assumption");
    for (const angleStatus of ["unavailable", "no-eligible-angle"] as const) {
      const verdict = conceptEligibility(eligibilityInput(signals, { angleStatus }));
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toContain("fails off");
    }
  });

  it("holds the grounding floor on both paths", () => {
    const signals = signalsFor({ ...RIVALRY_TREND, brandFit: 3 }, "wrong-assumption");
    expect(conceptEligibility(eligibilityInput(signals)).reason).toContain("grounding floor");

    const noTrend = { ...signalsFor(RIVALRY_TREND, "wrong-assumption"), briefFit: 3, angleFit: 0.9 };
    expect(conceptEligibility(eligibilityInput(noTrend, { trendTookSlot: false })).reason).toContain("grounding floor");

    const weakFit = { ...signalsFor(RIVALRY_TREND, "wrong-assumption"), briefFit: 5, angleFit: 0.4 };
    expect(conceptEligibility(eligibilityInput(weakFit, { trendTookSlot: false })).reason).toContain("0.6 floor");
  });

  it("never buys a concept on a run that is past target, and says so as a skip rather than a failure", () => {
    const signals = signalsFor(RIVALRY_TREND, "wrong-assumption");
    const past = conceptEligibility(eligibilityInput(signals, { meterPosture: "essential-only" }));
    expect(past.eligible).toBe(false);
    expect(past.skipped).toBe("past target");

    const noImages = conceptEligibility(eligibilityInput(signals, { generatedImagesCap: 0 }));
    expect(noImages.skipped).toBe("generatedImagesCap 0");

    const clientMedia = conceptEligibility(eligibilityInput(signals, { mediaSource: "client" }));
    expect(clientMedia.skipped).toBe("client-media run");
  });

  it('the client-level "off" beats a per-run "on", and "on" bypasses the story gates but not the grounding ones', () => {
    const weak = signalsFor(FLAT_TREND, "what-it-means");

    const clientOff = conceptEligibility(eligibilityInput(weak, { clientMode: "off", runMode: "on" }));
    expect(clientOff.eligible).toBe(false);
    expect(clientOff.mode).toBe("off");
    expect(clientOff.reason).toContain("instagramConceptMode");

    // "on" over a story that scores 3 and sits inside the cooldown: both bypassed.
    const forced = conceptEligibility(eligibilityInput(weak, { runMode: "on", pastConcepts: pastConceptsFromDecisions(decisionsWithConceptAt(0)) }));
    expect(forced.score).toBe(3);
    expect(forced.eligible).toBe(true);
    expect(forced.rule).toContain('bypassed by conceptMode "on"');

    // But not the grounding floor, the palette, the colour or the budget.
    expect(conceptEligibility(eligibilityInput(weak, { runMode: "on", brief: PLACEHOLDER_BRIEF })).eligible).toBe(false);
    expect(conceptEligibility(eligibilityInput(weak, { runMode: "on", hasBrandColour: false })).eligible).toBe(false);
    expect(conceptEligibility(eligibilityInput(weak, { runMode: "on", meterPosture: "cheapest-path" })).eligible).toBe(false);
    expect(conceptEligibility(eligibilityInput({ ...weak, trend: { ...FLAT_TREND, brandFit: 2 } }, { runMode: "on" })).eligible).toBe(false);
  });

  it('a client-level "on" forces, and is not quietly downgraded to "auto"', () => {
    const weak = signalsFor(FLAT_TREND, "what-it-means");
    // `readConceptMode` admits all three values from the client config, and
    // the workflow reports the deciding LEVEL alongside the mode. Consulting
    // `clientMode` only for "off" made "on" a settable-but-dead value: the
    // verdict said mode "auto", source "client config" — a level that had not
    // set that value.
    const forced = conceptEligibility(eligibilityInput(weak, { clientMode: "on" }));
    expect(forced.mode).toBe("on");
    expect(forced.eligible).toBe(true);
    expect(forced.rule).toContain('bypassed by conceptMode "on"');

    // The precedence is unchanged in both directions: a run input still wins
    // over the config, and "off" at either level still wins over everything.
    expect(conceptEligibility(eligibilityInput(weak, { clientMode: "on", runMode: "off" })).mode).toBe("off");
    expect(conceptEligibility(eligibilityInput(weak, { clientMode: "off", runMode: "on" })).mode).toBe("off");
    expect(conceptEligibility(eligibilityInput(weak, { clientMode: "auto" })).eligible).toBe(false);
  });

  it("recognition is a gate: a story whose own sources name nothing never qualifies", () => {
    const anonymous: ConceptFactCard[] = [
      { claim: "Small teams spend 4 hours a week rebuilding the same weekly report.", kind: "stat", source: "internal client survey" },
      { claim: "One team cut its small-team tier this week.", kind: "event", source: "internal client survey" },
    ];
    const trend: ConceptTrendSignals & ConceptTrendText = { ...RIVALRY_TREND, headline: "two tools in a pricing battle over small teams", evidenceRefs: [], sourceUrls: [] };
    const found = namedEntities(trend, undefined, anonymous, { ...BRIEF, coreTerms: ["marketing agents"], offers: [], ownAssets: [] });
    expect(found.entities).toEqual([]);

    const signals: ConceptSignals = { ...signalsFor(trend, "wrong-assumption"), facts: anonymous, entities: found.entities, entityBasis: found.basis };
    // The premise: the shape is there, so recognition is what refuses it.
    expect(scoreConcept(signals).score).toBeGreaterThanOrEqual(CONCEPT_MIN_SCORE);
    const verdict = conceptEligibility(eligibilityInput(signals));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("name no organisation");
  });

  it("hands the model only the patterns the story supports, and shows the reviewer the same list", () => {
    const verdict = conceptEligibility(eligibilityInput(signalsFor(RIVALRY_TREND, "wrong-assumption")));
    expect(verdict.eligible).toBe(true);
    expect(verdict.patterns).toEqual(eligibleConceptPatterns(signalsFor(RIVALRY_TREND, "wrong-assumption"), BRIEF));
    expect(verdict.patterns.length).toBeLessThan(CONCEPT_PATTERNS.length);
    expect(verdict.rule).toMatch(/→ eligible$/u);
  });
});
