import type { ClientBrief } from "@agent-engine/tools";
import type { Angle, AngleProposal, PastAngle } from "../src/workflow/angle-selection.js";
import { SIX_RESEARCH_FACTS } from "./test-helpers.js";

/**
 * Fixtures for the angle step (RFC-13 §K).
 *
 * Their own file rather than `test-helpers.ts`, which another Phase 1 work
 * package owns this cycle; fold them in once the phase lands. Every
 * `restsOn` here names a `SIX_RESEARCH_FACTS` claim verbatim, because
 * `selectAngle` drops an angle that rests on a card the run never fetched and
 * a fixture that silently trips that rule tests nothing.
 */

/** The claims the fixture angles rest on, so a test can assert against the same strings. */
export const ANGLE_FACT_CLAIMS = SIX_RESEARCH_FACTS.map((f) => f.claim);

export function wrongAssumptionAngle(overrides: Partial<Angle> = {}): Angle {
  return {
    id: "wrong-assumption",
    title: "The status meeting was never the reporting problem",
    rememberLine: "The hours come back only when the report writes itself from the source data.",
    restsOn: [ANGLE_FACT_CLAIMS[0]!],
    whyThisClient: "This account sells the reporting automation the survey is measuring, to the operations leads who run those meetings.",
    briefFit: 5,
    ...overrides,
  };
}

export function surprisingNumberAngle(overrides: Partial<Angle> = {}): Angle {
  return {
    id: "surprising-number",
    title: "Four hours a week, and nobody had asked where they went",
    rememberLine: "Four hours a week per team was sitting inside a report nobody had written down.",
    restsOn: [ANGLE_FACT_CLAIMS[0]!, ANGLE_FACT_CLAIMS[5]!],
    whyThisClient: "The client's own onboarding cohort data measures the same hours from the other end.",
    briefFit: 4,
    ...overrides,
  };
}

export function whatItMeansAngle(overrides: Partial<Angle> = {}): Angle {
  return {
    id: "what-it-means",
    title: "What automated reporting changes for a two person operations team",
    rememberLine: "A two person operations team gets its Monday back before it gets its dashboard.",
    restsOn: [ANGLE_FACT_CLAIMS[1]!],
    whyThisClient: "The brief's ICP is exactly the two person operations team, and the client's triage flow is the change being described.",
    briefFit: 4,
    ...overrides,
  };
}

/** Three angles, one per id, all resting on real cards — the shape `04i-propose-angles` returns on a healthy run. */
export function goodAngleProposal(overrides: Partial<AngleProposal> = {}): AngleProposal {
  return {
    angles: [wrongAssumptionAngle(), surprisingNumberAngle(), whatItMeansAngle()],
    notes: "no card carries a customer name, so no case-study angle was proposed",
    ...overrides,
  };
}

/**
 * The brief surface `selectAngle` scores against: core terms and an ICP the
 * fixture angles genuinely touch (so `hits` is non-zero) and one offer.
 */
export function angleScoringBrief(overrides: Partial<Pick<ClientBrief, "coreTerms" | "offers" | "icp">> = {}): Pick<ClientBrief, "coreTerms" | "offers" | "icp"> {
  return {
    coreTerms: ["reporting", "operations", "automation", "onboarding"],
    offers: [{ name: "Reporting autopilot", summary: "Weekly reports assembled from the client's own source data." }],
    icp: {
      summary: "Operations leads at small B2B software teams who own the weekly reporting nobody wants to write",
      roles: ["operations lead"],
      pains: ["manual weekly reporting"],
      industries: [],
      geos: [],
    },
    ...overrides,
  };
}

/** A past angle whose remember line is what `surprisingNumberAngle()` says, so novelty can be tested against a genuine repeat. */
export function repeatedPastAngle(): PastAngle {
  return { id: "surprising-number", rememberLine: "Four hours a week per team was sitting inside a report nobody had written down." };
}
