import { describe, expect, it } from "vitest";
import {
  checkCoverFigureDevice,
  COVER_FIGURE_LABEL_MAX_CHARS,
  isCompleteClause,
  type CoverFigureEvidence,
  type SlideDevice,
} from "../src/workflow/slide-devices.js";

/**
 * ITEM G4 — THE COVER FIGURE THE OWNER READ ON TWO POSTS AT ONCE.
 *
 * karoslabs, 2026-09-16, on the cover of a post about generative-engine
 * optimisation:
 *
 * ```
 *   7.2%
 *   Only of organizations respond to inbound leads within five minutes, meaning
 *   The Inbound Pipeline
 * ```
 *
 * Four defects in one device, on the one slide the whole audience sees:
 *
 *   1. the figure is from a fact card the post's own angle does not rest on —
 *      the post argues about AI answer engines and the card is about inbound
 *      lead response time;
 *   2. the label opens with `Only`, because the figure was cut out of the
 *      middle of that card's sentence BY POSITION;
 *   3. the label ends on `meaning`, because it was then truncated to fit;
 *   4. the identical figure had already been on this client's previous post,
 *      about a different subject.
 *
 * `interest-relayout.ts` no longer builds a cover device from an arbitrary
 * fact card — that limb is deleted, and `interest-floor.test.ts` asserts its
 * deletion. This is the belt-and-braces half, for a device the WRITER
 * declares: four rules, $0, deterministic, a finding back to `05` and never a
 * hold.
 */

/** The karoslabs cover device, verbatim. */
const THE_COVER_DEVICE: SlideDevice = {
  kind: "figure",
  value: "7.2%",
  label: "Only of organizations respond to inbound leads within five minutes, meaning",
  source: "The Inbound Pipeline",
};

/** The post's real evidence: the angle rests on the GEO cards, and the 7.2% card is in the research but not in the argument. */
const EVIDENCE: CoverFigureEvidence = {
  citedClaims: [
    "90% of CMOs say buyer discovery now happens inside AI-generated answers",
    "81% of marketing leaders are building or piloting AI answer-engine work",
  ],
  factCards: [
    { claim: "90% of CMOs say buyer discovery now happens inside AI-generated answers", source: "Mind the Marketing Gap, BCG, June 2026" },
    { claim: "81% of marketing leaders are building or piloting AI answer-engine work", source: "Mind the Marketing Gap, BCG, June 2026" },
    { claim: "Only 7.2% of organizations respond to inbound leads within five minutes, meaning most buyers wait", source: "The Inbound Pipeline" },
  ],
  previousCoverFigure: "7.2%",
};

describe("checkCoverFigureDevice: the karoslabs cover, rule by rule", () => {
  it("names every one of the four defects, not the first — one redraft has to fix all of them", () => {
    const verdict = checkCoverFigureDevice(THE_COVER_DEVICE, EVIDENCE);
    expect(verdict.ok).toBe(false);
    const said = (verdict.ok ? [] : verdict.reasons).join(" | ");
    expect(said).toMatch(/angle does not rest on/u);
    expect(said).toMatch(/opens with "only"/u);
    expect(said).toMatch(/ends on "meaning"/u);
    expect(said).toMatch(/previous post put the same figure/u);
    // The label itself is 74 characters, so the length rule is the ONE that
    // does not fire — which is worth pinning: a test that reported four
    // failures because everything fails is not evidence about anything.
    expect(THE_COVER_DEVICE.kind === "figure" && THE_COVER_DEVICE.label.length).toBeLessThan(COVER_FIGURE_LABEL_MAX_CHARS);
    expect(said).not.toMatch(/characters \(max/u);
  });

  it("rule 1: a figure from a card the angle DOES rest on is fine, and one from no card at all is worse", () => {
    const fromAngle: SlideDevice = { kind: "figure", value: "90%", label: "of CMOs say discovery happens inside AI answers", source: "BCG, June 2026" };
    expect(checkCoverFigureDevice(fromAngle, { ...EVIDENCE, previousCoverFigure: undefined }).ok).toBe(true);

    const invented: SlideDevice = { ...fromAngle, value: "63%" };
    const verdict = checkCoverFigureDevice(invented, { ...EVIDENCE, previousCoverFigure: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.reasons[0]).toMatch(/does not appear in any fact card/u);
  });

  it("rule 1: with no cited claims it falls back to every card — weaker, and never abstaining entirely", () => {
    const fromAnyCard: SlideDevice = { ...THE_COVER_DEVICE, label: "of organizations answer inbound leads inside five minutes" };
    const verdict = checkCoverFigureDevice(fromAnyCard, { ...EVIDENCE, citedClaims: [], previousCoverFigure: undefined });
    // The angle rule cannot speak, so it does not — but the figure is still
    // required to come from a card, and this one does.
    expect(verdict.ok).toBe(true);
    const unsourced = checkCoverFigureDevice({ ...fromAnyCard, value: "44%" }, { ...EVIDENCE, citedClaims: [], previousCoverFigure: undefined });
    expect(unsourced.ok).toBe(false);
  });

  it("rules 2 and 3: a label is a whole clause, in either language", () => {
    expect(isCompleteClause("of CMOs say discovery happens inside AI answers").ok).toBe(true);
    // The positional cut, from both ends.
    expect(isCompleteClause("Only of organizations respond within five minutes").ok).toBe(false);
    expect(isCompleteClause("of organizations respond within five minutes, meaning").ok).toBe(false);
    // Case and punctuation do not rescue it.
    expect(isCompleteClause("ONLY, of organizations respond").ok).toBe(false);
    // Hebrew, which is half of what this pipeline ships.
    expect(isCompleteClause("מהחברות משיבות לפנייה תוך חמש דקות").ok).toBe(true);
    expect(isCompleteClause("רק מהחברות משיבות לפנייה").ok).toBe(false);
    expect(isCompleteClause("מהחברות משיבות לפנייה, כלומר").ok).toBe(false);
    expect(isCompleteClause("   ").ok).toBe(false);
  });

  it("rule 3: a label too long to read in one glance is refused at its own limit", () => {
    const long = "of organizations that answer an inbound lead inside five minutes and log the outcome in the same system".slice(0, COVER_FIGURE_LABEL_MAX_CHARS + 1);
    const verdict = checkCoverFigureDevice({ kind: "figure", value: "90%", label: long, source: "BCG" }, { ...EVIDENCE, previousCoverFigure: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.reasons.join(" ")).toMatch(new RegExp(`max ${COVER_FIGURE_LABEL_MAX_CHARS}`, "u"));
  });

  it("rule 4: the same number on two posts about different subjects is the AI tell in its most literal form", () => {
    const good: SlideDevice = { kind: "figure", value: "90%", label: "of CMOs say discovery happens inside AI answers", source: "BCG, June 2026" };
    expect(checkCoverFigureDevice(good, { ...EVIDENCE, previousCoverFigure: "7.2%" }).ok).toBe(true);
    const repeated = checkCoverFigureDevice(good, { ...EVIDENCE, previousCoverFigure: "90 %" });
    // Digits are compared, not strings, so a re-spaced or re-unitted repeat is
    // still a repeat.
    expect(repeated.ok).toBe(false);
  });

  it("says nothing about the five device kinds that are not a figure — this defect has one shape", () => {
    const bars: SlideDevice = {
      kind: "bars",
      rows: [
        { label: "Manual intake", value: 62, display: "62%" },
        { label: "Automated", value: 38, display: "38%" },
      ],
      source: "Karos survey, 2026",
    };
    expect(checkCoverFigureDevice(bars, EVIDENCE).ok).toBe(true);
  });

  /**
   * A device is furniture, and the invariant this pipeline states repeatedly is
   * that furniture must not be able to hold a run. This function returns
   * reasons; it never throws, never holds, and never mutates the device.
   */
  it("is a pure verdict: it reports, it does not repair", () => {
    const before = JSON.stringify(THE_COVER_DEVICE);
    checkCoverFigureDevice(THE_COVER_DEVICE, EVIDENCE);
    expect(JSON.stringify(THE_COVER_DEVICE)).toBe(before);
  });
});
