import { describe, expect, it } from "vitest";
import type { ClientBrief } from "@agent-engine/tools";
import { deriveClientBrief } from "../src/workflow/client-brief.js";
import type { BrandTokens } from "../src/workflow/types.js";
import type { LaneVisualPatterns } from "../src/workflow/research-lanes.js";
import {
  ArtDirectorOutputSchema,
  VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY,
  VISUAL_DIRECTION_BELIEF_KEY,
  VISUAL_DIRECTION_LINES_MIN,
  VISUAL_DIRECTION_RETRY_DAYS,
  VISUAL_DIRECTION_TTL_DAYS,
  VISUAL_EVIDENCE_RANK,
  VISUAL_PATTERNS_UNAVAILABLE_GAP,
  VisualDirectionSchema,
  buildVisualDirectionInput,
  checkVisualDirection,
  fallbackVisualDirection,
  finaliseVisualDirection,
  isReviewedProfile,
  pickVisualPatternProfile,
  readVisualDirection,
  readVisualDirectionAttempt,
  visualDirectionAgeDays,
  visualEvidenceRank,
  type ArtDirectorOutput,
  type VisualDirection,
  type VisualPatternEvidence,
} from "../src/workflow/visual-direction.js";

/**
 * RFC-13 Phase 3, item Q — the per-client visual direction derived once at
 * setup.
 *
 * The defect these tests stand over: every generated image for every
 * Instagram client was drawn to `image.generate`'s twelve-word neutral
 * fallback, because the only art direction the workflow ever passed came from
 * four optional `BrandTokens` fields no client config sets. What this file
 * pins is not that the agent writes good lines — it is that the pipeline can
 * no longer arrive at that fallback: a stored direction is reused inside its
 * TTL, a missing one is derived, and a client with nothing but a brand kit or
 * nothing but a brief STILL gets four grounded lines with no model call at
 * all.
 */

const NOW = new Date("2026-09-11T09:00:00.000Z");

function karoslabsBrief(): ClientBrief {
  return deriveClientBrief({
    profile: {
      name: "Karos Labs",
      industry: "AI marketing",
      website: "https://karoslabs.com",
      description: "Karos Labs is an AI marketing agency for B2B founders. We run research, drafting and publishing across every channel with agents a human editor reviews.",
    },
    contextDocs: {
      productInformation: "# Product information\n\nKaros Labs sells a managed AI content engine: weekly Instagram, X and LinkedIn posts drafted by agents and approved by the client's editor.",
      targetAudience: "# Target audience\n\nFounders and heads of marketing at seed to series B B2B software companies, usually a team of one to three doing marketing part time.",
    },
    forbiddenTopics: ["competitor pricing", "unreleased roadmap"],
    now: NOW,
  });
}

/** A brand kit that actually carries photographic tokens — the state a hand-art-directed client is in, and the one almost nobody in the fleet is. */
const ART_DIRECTED_KIT: BrandTokens = {
  templateDir: "agents/instagram-agent/assets/templates/default",
  slideTemplate: "slide.html",
  accentColor: "#ff6b2c",
  aesthetic: "editorial documentary",
  lighting: "soft diffused north light",
  palette: ["warm charcoal", "paper white", "#ff6b2c"],
  visualMood: "calm and considered",
};

/** The real fleet default: a template directory and nothing a photograph could be composed from. */
const BARE_KIT: BrandTokens = {
  templateDir: "agents/instagram-agent/assets/templates/default",
  slideTemplate: "slide.html",
};

function storedDirection(overrides: Partial<VisualDirection> = {}): VisualDirection {
  return {
    version: 1,
    generatedAt: NOW.toISOString(),
    generatedBy: "instagram-art-director@1",
    subject: ["a laptop on a kitchen table before the office opens"],
    light: ["soft window light, no fill"],
    palette: ["warm charcoal", "paper white"],
    treatment: ["35mm, shallow depth of field"],
    forbid: ["stock handshakes", "glass-tower skylines"],
    lines: [
      { line: "Photograph the work itself, at the desk where it happens.", basis: "https://instagram.com/p/abc", confidence: "high" },
      { line: "Soft window light from one side, never a ring light.", basis: "https://instagram.com/p/def", confidence: "high" },
      { line: "Keep the frame inside warm charcoal and paper white.", basis: "brand kit: palette", confidence: "medium" },
      { line: "One subject per frame, shallow depth of field.", basis: "https://karoslabs.com/work", confidence: "medium" },
    ],
    styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject, soft single-source light, no composite." },
    source: "patterns+brand",
    gaps: [],
    ...overrides,
  };
}

const REVIEWED_PROFILE: VisualPatternEvidence = {
  versionId: "v0003",
  generatedAt: "2026-08-01T00:00:00.000Z",
  reviewStatus: "corrected",
  reference: "Client visual patterns (v0003, review: corrected).\nWarm interior light, work in progress, never a posed team photo.",
  templateHints: ["full-bleed photo, caption below"],
};

const UNREVIEWED_PROFILE: VisualPatternEvidence = { ...REVIEWED_PROFILE, versionId: "v0004", reviewStatus: "unreviewed" };

// ─────────────────────────────────────────────────────────────────────────
// 00d — freshness
// ─────────────────────────────────────────────────────────────────────────

describe("00d-check-visual-direction: freshness against VISUAL_DIRECTION_TTL_DAYS", () => {
  it("reuses a direction inside the TTL and never pays for it twice", () => {
    const beliefs = { [VISUAL_DIRECTION_BELIEF_KEY]: storedDirection({ generatedAt: "2026-07-01T09:00:00.000Z" }) };

    const check = checkVisualDirection(beliefs, { now: NOW, allowDerive: true });

    expect(check.action).toBe("reuse");
    expect(check.ageDays).toBe(72);
    expect(check.direction?.styleLock.id).toBe("warm-documentary");
    expect(check.reason).toContain(String(VISUAL_DIRECTION_TTL_DAYS));
  });

  it("derives again the day the TTL expires, not a day early and not a day late", () => {
    const dayBefore = new Date(NOW.getTime() - (VISUAL_DIRECTION_TTL_DAYS - 1) * 86_400_000).toISOString();
    const onTheDay = new Date(NOW.getTime() - VISUAL_DIRECTION_TTL_DAYS * 86_400_000).toISOString();

    expect(checkVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: storedDirection({ generatedAt: dayBefore }) }, { now: NOW, allowDerive: true }).action).toBe("reuse");
    expect(checkVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: storedDirection({ generatedAt: onTheDay }) }, { now: NOW, allowDerive: true }).action).toBe("derive");
  });

  it("derives when the client has nothing stored", () => {
    expect(checkVisualDirection({}, { now: NOW, allowDerive: true })).toMatchObject({ action: "derive" });
    expect(checkVisualDirection(undefined, { now: NOW, allowDerive: true }).action).toBe("derive");
  });

  it("reports unavailable rather than failing when the setup budget turned the step off and nothing is stored", () => {
    const check = checkVisualDirection({}, { now: NOW, allowDerive: false });

    // The owner's standing rule: a budget lever adapts the plan. It must
    // never be able to produce a fourth outcome the caller has to hold on.
    expect(check.action).toBe("unavailable");
    expect(check.reason).toContain("brand-kit fallback");
  });

  it("reuses a STALE direction rather than dropping to brand tokens when the budget turned derivation off", () => {
    const stale = storedDirection({ generatedAt: "2026-01-01T09:00:00.000Z" });

    const check = checkVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: stale }, { now: NOW, allowDerive: false });

    // A quarter-old direction for THIS client still beats the generic
    // fallback, which is the only other thing on offer here.
    expect(check.action).toBe("reuse");
    expect(check.direction?.generatedBy).toBe("instagram-art-director@1");
    expect(check.reason).toContain("stale");
  });

  /**
   * The negative cache.
   *
   * A derivation that failed used to leave nothing behind, so `00d` resolved
   * `derive` again on the next run and the run after that, re-paying `00d1` +
   * `00d2` (~$0.075) every time. That is recurring spend on the budget whose
   * whole premise is "one-off per client, amortised", and it is invisible to
   * the run's $1.00/$1.50 accounting because the setup meter is a different
   * meter: a run whose true spend is ~$1.06 keeps reporting ~$0.98.
   */
  describe("a derivation that failed is remembered, so it is not re-paid for every run", () => {
    const failed = (attemptedAt: string) => ({
      [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: { version: 1 as const, attemptedAt, failedWith: '00d2-derive-visual-direction resolved to "budget_exceeded"' },
    });

    it("reports unavailable, not derive, while the retry window stands", () => {
      const check = checkVisualDirection(failed("2026-09-09T09:00:00.000Z"), { now: NOW, allowDerive: true });

      expect(check.action).toBe("unavailable");
      expect(check.reason).toContain("budget_exceeded");
      expect(check.reason).toContain("brand-kit fallback");
    });

    it("tries again the day the retry window expires, not a day early and not a day late", () => {
      const dayBefore = new Date(NOW.getTime() - (VISUAL_DIRECTION_RETRY_DAYS - 1) * 86_400_000).toISOString();
      const onTheDay = new Date(NOW.getTime() - VISUAL_DIRECTION_RETRY_DAYS * 86_400_000).toISOString();

      expect(checkVisualDirection(failed(dayBefore), { now: NOW, allowDerive: true }).action).toBe("unavailable");
      expect(checkVisualDirection(failed(onTheDay), { now: NOW, allowDerive: true }).action).toBe("derive");
    });

    it("keeps a stale stored direction in force rather than re-paying for a derivation that just failed", () => {
      const beliefs = { [VISUAL_DIRECTION_BELIEF_KEY]: storedDirection({ generatedAt: "2026-01-01T09:00:00.000Z" }), ...failed("2026-09-09T09:00:00.000Z") };

      const check = checkVisualDirection(beliefs, { now: NOW, allowDerive: true });

      expect(check.action).toBe("reuse");
      expect(check.direction?.styleLock.id).toBe("warm-documentary");
      expect(check.reason).toContain("just failed");
    });

    it("is retired by a successful derivation, so one bad week does not silence the next one", () => {
      // `memory.updateBeliefs` shallow-merges, so `null` is how `00d3` retires
      // the key on the success path.
      const beliefs = { [VISUAL_DIRECTION_BELIEF_KEY]: storedDirection({ generatedAt: "2026-01-01T09:00:00.000Z" }), [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: null };

      expect(readVisualDirectionAttempt(beliefs)).toBeUndefined();
      expect(checkVisualDirection(beliefs, { now: NOW, allowDerive: true }).action).toBe("derive");
    });

    it("does not let an unreadable stamp hold the retry shut forever", () => {
      const check = checkVisualDirection({ [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: { version: 1, attemptedAt: "whenever", failedWith: "something" } }, { now: NOW, allowDerive: true });
      expect(check.action).toBe("derive");
    });

    it("treats a malformed marker as absent instead of throwing", () => {
      expect(readVisualDirectionAttempt({ [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: { version: 2 } })).toBeUndefined();
      expect(readVisualDirectionAttempt({ [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: "nonsense" })).toBeUndefined();
      expect(readVisualDirectionAttempt(null)).toBeUndefined();
    });
  });

  it("treats a malformed or unparseable stored document as absent instead of throwing", () => {
    expect(readVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: { version: 1, lines: "not an array" } })).toBeUndefined();
    expect(readVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: "nonsense" })).toBeUndefined();
    expect(readVisualDirection(null)).toBeUndefined();
    expect(visualDirectionAgeDays({ generatedAt: "whenever" }, NOW)).toBeUndefined();
    expect(checkVisualDirection({ [VISUAL_DIRECTION_BELIEF_KEY]: { nope: true } }, { now: NOW, allowDerive: true }).action).toBe("derive");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────

describe("evidence assembly and precedence", () => {
  it("names the missing consent as a gap and still produces a usable input — the common path, not the exception", () => {
    const { input, gaps, source } = buildVisualDirectionInput({
      clientSlug: "karoslabs",
      brandTokens: BARE_KIT,
      brief: karoslabsBrief(),
      sitePages: [{ url: "https://karoslabs.com", title: "Karos Labs", text: "We run research, drafting and publishing with agents a human editor reviews." }],
    });

    expect(gaps).toContain(VISUAL_PATTERNS_UNAVAILABLE_GAP);
    expect(gaps.some((g) => g.startsWith("visualPatternsUnavailable"))).toBe(true);
    // The run proceeds: the brief and the site still reached the prompt.
    expect(source).toBe("brand+brief");
    expect(input.positioning).toContain("Karos Labs");
    expect(input.sitePages).toHaveLength(1);
    expect(input.gaps).toBe(gaps);
    // And the bare kit's own emptiness is named rather than passed off as
    // direction — this is the state that produced the neutral one-liner.
    expect(gaps.some((g) => g.includes("no photographic tokens"))).toBe(true);
    expect(input.brandTokens).toBeUndefined();
  });

  it("ranks a reviewed profile above an unreviewed one, which is above brand+brief, which is above brand alone", () => {
    expect(isReviewedProfile(REVIEWED_PROFILE)).toBe(true);
    expect(isReviewedProfile(UNREVIEWED_PROFILE)).toBe(false);

    const reviewed = visualEvidenceRank({ patterns: REVIEWED_PROFILE, brief: karoslabsBrief() });
    const unreviewed = visualEvidenceRank({ patterns: UNREVIEWED_PROFILE, brief: karoslabsBrief() });
    const brandAndBrief = visualEvidenceRank({ brief: karoslabsBrief() });
    const brandOnly = visualEvidenceRank({});

    expect(reviewed).toBe(VISUAL_EVIDENCE_RANK.reviewedPatterns);
    expect(reviewed).toBeGreaterThan(unreviewed);
    expect(unreviewed).toBeGreaterThan(brandAndBrief);
    expect(brandAndBrief).toBeGreaterThan(brandOnly);
  });

  it("picks the human-reviewed profile version even when a machine-written one is newer", () => {
    const versions = [
      { version: 1, review: { status: "unreviewed" } },
      { version: 2, review: { status: "corrected" } },
      { version: 3, review: { status: "unreviewed" } },
    ];

    // A reviewer's corrections are the only ground truth on file; a later
    // automatic ingestion does not overturn them.
    expect(pickVisualPatternProfile(versions)?.version).toBe(2);
    expect(pickVisualPatternProfile([{ version: 4, review: { status: "unreviewed" } }, { version: 7, review: { status: "unreviewed" } }])?.version).toBe(7);
    expect(pickVisualPatternProfile([])).toBeUndefined();
  });

  it("carries an unreviewed profile's own caveat into the gaps, and labels the source patterns+brand", () => {
    const { input, gaps, source } = buildVisualDirectionInput({
      clientSlug: "karoslabs",
      brandTokens: ART_DIRECTED_KIT,
      brief: karoslabsBrief(),
      patterns: UNREVIEWED_PROFILE,
      sitePages: [{ url: "https://karoslabs.com", text: "about us" }],
    });

    expect(source).toBe("patterns+brand");
    expect(input.visualPatterns).toContain("Warm interior light");
    expect(input.visualPatternsReviewStatus).toBe("unreviewed");
    expect(input.templateHints).toEqual(["full-bleed photo, caption below"]);
    expect(gaps.some((g) => g.includes("v0004") && g.includes("not been reviewed"))).toBe(true);
    expect(gaps).not.toContain(VISUAL_PATTERNS_UNAVAILABLE_GAP);
  });

  it("accepts `04a2`'s own visual-patterns block directly, so the integrator wires one field to the other", () => {
    // `LaneVisualPatterns` is what `pullResearchLanes` surfaces off
    // `research.pull({ includeVisualPatterns: true })`. This pins that it is
    // assignable to `VisualPatternEvidence` — the whole point of declaring
    // both structurally rather than importing across packages.
    const fromResearch: LaneVisualPatterns = {
      versionId: "v0003",
      generatedAt: "2026-08-01T00:00:00.000Z",
      reviewStatus: "approved",
      reference: "Client visual patterns (v0003).\nWarm interior light.",
      templateHints: ["full-bleed photo, caption below"],
    };

    const { input, source } = buildVisualDirectionInput({ clientSlug: "karoslabs", brandTokens: ART_DIRECTED_KIT, brief: karoslabsBrief(), patterns: fromResearch });

    expect(source).toBe("patterns+brand");
    expect(input.visualPatternsVersionId).toBe("v0003");
    expect(visualEvidenceRank({ patterns: fromResearch })).toBe(VISUAL_EVIDENCE_RANK.reviewedPatterns);
  });

  it("labels the source `patterns` when a profile exists but no brand kit does, and `brand` when there is neither profile nor brief", () => {
    expect(buildVisualDirectionInput({ clientSlug: "x", patterns: REVIEWED_PROFILE }).source).toBe("patterns");
    expect(buildVisualDirectionInput({ clientSlug: "x", brandTokens: BARE_KIT }).source).toBe("brand");
  });

  it("clamps a long site page and caps the pages and image notes, so one source cannot crowd the profile out of the prompt", () => {
    const { input } = buildVisualDirectionInput({
      clientSlug: "karoslabs",
      patterns: REVIEWED_PROFILE,
      sitePages: [
        { url: "https://karoslabs.com/a", text: "a".repeat(9_000) },
        { url: "https://karoslabs.com/b", text: "b" },
        { url: "https://karoslabs.com/c", text: "c" },
        { url: "https://karoslabs.com/d", text: "d" },
      ],
      ownImageNotes: Array.from({ length: 20 }, (_, i) => `note ${i} ${"x".repeat(900)}`),
    });

    expect(input.sitePages).toHaveLength(3);
    expect(input.sitePages![0]!.text.length).toBeLessThanOrEqual(2_500);
    expect(input.ownImageNotes).toHaveLength(8);
    expect(input.ownImageNotes!.every((n) => n.length <= 400)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The schema
// ─────────────────────────────────────────────────────────────────────────

describe("VisualDirectionSchema", () => {
  it("refuses a line with no basis — an unbacked line is a gap, not an assertion", () => {
    const direction = storedDirection();
    const noBasis = { ...direction, lines: [...direction.lines.slice(1), { line: "Make it feel premium.", confidence: "high" }] };

    expect(VisualDirectionSchema.safeParse(direction).success).toBe(true);
    expect(VisualDirectionSchema.safeParse(noBasis).success).toBe(false);
    expect(VisualDirectionSchema.safeParse({ ...direction, lines: [...direction.lines.slice(1), { line: "x", basis: "", confidence: "high" }] }).success).toBe(false);
  });

  it("refuses fewer than four lines, because four is what the fallback itself guarantees", () => {
    const direction = storedDirection();
    expect(VisualDirectionSchema.safeParse({ ...direction, lines: direction.lines.slice(0, 3) }).success).toBe(false);
    expect(direction.lines.length).toBeGreaterThanOrEqual(VISUAL_DIRECTION_LINES_MIN);
  });

  it("lets an agent omit an axis it had nothing to say about, but never the lines themselves", () => {
    // The axes are an index into the lines for a human reader; losing a whole
    // quarter's direction because the model said nothing about lighting is
    // the wrong trade, and the owner's rule is adapt-and-deliver.
    const authored = ArtDirectorOutputSchema.parse({
      lines: storedDirection().lines,
      styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject." },
    });
    expect(authored.light).toEqual([]);
    expect(authored.forbid).toEqual([]);
    expect(authored.subject).toEqual([]);

    expect(ArtDirectorOutputSchema.safeParse({ styleLock: { id: "x", line: "y" } }).success).toBe(false);
    expect(ArtDirectorOutputSchema.safeParse({ lines: storedDirection().lines }).success).toBe(false);
  });

  it("round-trips through the belief key unchanged", () => {
    const direction = storedDirection();
    const beliefs = JSON.parse(JSON.stringify({ someoneElsesKey: 1, [VISUAL_DIRECTION_BELIEF_KEY]: direction })) as unknown;

    expect(readVisualDirection(beliefs)).toEqual(direction);
  });

  it("stamps the four fields code owns onto the agent's answer and merges both sets of gaps", () => {
    const authored: ArtDirectorOutput = ArtDirectorOutputSchema.parse({
      subject: ["a laptop on a kitchen table"],
      lines: storedDirection().lines,
      styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject." },
      gaps: ["only four of the client's own posts carried an image"],
    });

    const direction = finaliseVisualDirection(authored, {
      source: "patterns+brand",
      generatedBy: "instagram-art-director@1",
      now: NOW,
      gaps: [VISUAL_PATTERNS_UNAVAILABLE_GAP, "only four of the client's own posts carried an image"],
    })!;

    expect(direction).toBeDefined();
    expect(direction.version).toBe(1);
    expect(direction.generatedAt).toBe(NOW.toISOString());
    expect(direction.generatedBy).toBe("instagram-art-director@1");
    expect(direction.source).toBe("patterns+brand");
    // De-duplicated: the model can only see gaps inside the evidence, code
    // knows what never reached it, and they overlap.
    expect(direction.gaps).toHaveLength(2);
    expect(VisualDirectionSchema.safeParse(direction).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The fallback — the insurance that makes the neutral one-liner unreachable
// ─────────────────────────────────────────────────────────────────────────

describe("fallbackVisualDirection", () => {
  it("derives at least four grounded lines for a client with only a brief", () => {
    const direction = fallbackVisualDirection(BARE_KIT, karoslabsBrief(), { now: NOW })!;

    expect(direction).toBeDefined();
    expect(direction.lines.length).toBeGreaterThanOrEqual(VISUAL_DIRECTION_LINES_MIN);
    expect(direction.lines.every((l) => l.basis.length > 0)).toBe(true);
    expect(direction.lines.every((l) => l.basis.startsWith("client brief:"))).toBe(true);
    expect(direction.source).toBe("brand+brief");
    expect(direction.generatedBy).toBe("fallback:brand-kit-and-brief");
    expect(VisualDirectionSchema.safeParse(direction).success).toBe(true);
  });

  it("derives at least four grounded lines for a client with only a brand kit", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, undefined, { now: NOW })!;

    expect(direction.lines.length).toBeGreaterThanOrEqual(VISUAL_DIRECTION_LINES_MIN);
    expect(direction.lines.every((l) => l.basis.startsWith("brand kit:"))).toBe(true);
    expect(direction.palette).toContain("warm charcoal");
    expect(direction.light).toEqual(["soft diffused north light"]);
    expect(direction.source).toBe("brand");
    // The accent has to be a thing in the frame, not a wash over it: an
    // overlay sits exactly where the template then draws live text.
    expect(direction.lines.some((l) => l.line.includes("#ff6b2c") && l.line.includes("never as a colour overlay"))).toBe(true);
    expect(VisualDirectionSchema.safeParse(direction).success).toBe(true);
  });

  it("carries the brief's forbidden topics into forbid", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;

    expect(direction.forbid).toContain("competitor pricing");
    expect(direction.forbid).toContain("unreleased roadmap");
  });

  it("returns undefined rather than padding when neither source can ground four lines", () => {
    // A fabricated line is worse than no direction: it would steer a quarter
    // of this client's generated images on the strength of nothing.
    expect(fallbackVisualDirection(BARE_KIT, undefined, { now: NOW })).toBeUndefined();
    expect(fallbackVisualDirection(undefined, undefined, { now: NOW })).toBeUndefined();
    expect(fallbackVisualDirection({ ...BARE_KIT, accentColor: "#ff6b2c" }, undefined, { now: NOW })).toBeUndefined();
  });

  it("names its own weakness in gaps, so a reviewer can tell it from an authored direction", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;

    expect(direction.gaps).toContain(VISUAL_PATTERNS_UNAVAILABLE_GAP);
    expect(direction.gaps.some((g) => g.includes("without an art-direction model call"))).toBe(true);
    expect(direction.styleLock.id).toBe("brand-kit");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The three ways a derived direction used to become unreadable, unearned or
// untrue — each fixed in code, each pinned here.
// ─────────────────────────────────────────────────────────────────────────

/** The REAL `media.ingestVisualPatterns` refusal for a client with no scraper configured. */
const REAL_NOT_AVAILABLE_REASON =
  "media.ingestVisualPatterns: no scraper configured — set SCRAPPYCOCO_API_KEY so a client's own account history can be read " +
  "(see packages/tools/karos-media/README.md)";

/** Exactly what `00d1` pushes into `problems` on the commonest fleet path. */
const REAL_INGEST_PROBLEM = `the client's own feed was not read (not_available: ${REAL_NOT_AVAILABLE_REASON}) — the direction rests on the brand kit, the brief and the site`;

describe("a derived direction can always be read back", () => {
  it("clamps a real >240-character not_available reason, so the document survives the round trip", () => {
    // The whole chain as `00d1` -> `00d2` -> `00d3` runs it. Unclamped, this
    // gap ran past the schema's 240-character ceiling,
    // `VisualDirectionSchema` refused the stored document on the NEXT run,
    // `00d` resolved `derive` again, and `00d1` + `00d2` (~$0.075 of the
    // per-client setup budget) were re-paid every single run — on the SUCCESS
    // path, where no failure marker is written to stop it.
    expect(REAL_INGEST_PROBLEM.length).toBeGreaterThan(240);

    const assembled = buildVisualDirectionInput({
      clientSlug: "karoslabs",
      brandTokens: ART_DIRECTED_KIT,
      brief: karoslabsBrief(),
      problems: [REAL_INGEST_PROBLEM],
    });
    expect(assembled.gaps.every((g) => g.length <= 240)).toBe(true);
    // Clamped, not dropped: the reason is still legible on the gate.
    expect(assembled.gaps[0]).toContain("no scraper configured");

    const direction = finaliseVisualDirection(
      ArtDirectorOutputSchema.parse({ lines: storedDirection().lines, styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject." } }),
      { source: "brand+brief", generatedBy: "instagram-art-director@1", now: NOW, gaps: assembled.gaps },
    )!;
    expect(direction).toBeDefined();
    expect(direction.gaps.every((g) => g.length <= 240)).toBe(true);

    // The assertion that matters: through the belief document and out again.
    const beliefs = JSON.parse(JSON.stringify({ [VISUAL_DIRECTION_BELIEF_KEY]: direction })) as unknown;
    expect(readVisualDirection(beliefs)).toEqual(direction);
  });

  it("returns undefined rather than a document the next run's safeParse would refuse", () => {
    // Belt and braces over every clamp: whatever is wrong with it, a
    // direction that cannot be read back is never handed to `00d3` to write.
    const unstorable = finaliseVisualDirection(
      { ...ArtDirectorOutputSchema.parse({ lines: storedDirection().lines, styleLock: { id: "x", line: "y" } }), lines: [] } as ArtDirectorOutput,
      { source: "brand", generatedBy: "instagram-art-director@1", now: NOW },
    );
    expect(unstorable).toBeUndefined();
  });

  it("demotes a line whose basis cites a URL the evidence never carried", () => {
    // `prompts/instagram-art-director/1.md` section 2 offers "a named site
    // page" as a basis kind, and nothing checked the citation. A model handed
    // no site page could answer with a plausible URL, and that line would then
    // steer a quarter of this client's generated images for ninety days.
    const assembled = buildVisualDirectionInput({
      clientSlug: "karoslabs",
      brandTokens: ART_DIRECTED_KIT,
      brief: karoslabsBrief(),
      sitePages: [{ url: "https://karoslabs.com/about", text: "We run research, drafting and publishing with agents a human editor reviews." }],
    });
    expect(assembled.evidenceUrls).toContain("https://karoslabs.com/about");

    const authored = ArtDirectorOutputSchema.parse({
      lines: [
        { line: "Photograph the desk where the work happens.", basis: "https://karoslabs.com/about", confidence: "high" },
        { line: "One subject per frame, never a composite.", basis: "brand kit: aesthetic", confidence: "high" },
        { line: "Soft window light from one side.", basis: "brand kit: lighting", confidence: "medium" },
        { line: "Keep the frame inside the brand palette.", basis: "brand kit: palette", confidence: "medium" },
        { line: "Shoot on the shop floor at golden hour.", basis: "https://karoslabs.com/case-studies/never-fetched", confidence: "high" },
      ],
      styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject." },
    });

    const direction = finaliseVisualDirection(authored, {
      source: "brand+brief",
      generatedBy: "instagram-art-director@1",
      now: NOW,
      gaps: assembled.gaps,
      evidenceUrls: assembled.evidenceUrls,
    })!;

    expect(direction.lines.map((l) => l.line)).not.toContain("Shoot on the shop floor at golden hour.");
    // The line the evidence DID carry survives — this is a citation check,
    // not a ban on citing pages.
    expect(direction.lines.map((l) => l.basis)).toContain("https://karoslabs.com/about");
    expect(direction.gaps.some((g) => g.includes("never-fetched"))).toBe(true);

    // With no `evidenceUrls` supplied the check is off, so a caller that
    // cannot say what its evidence was does not silently lose lines.
    const unchecked = finaliseVisualDirection(authored, { source: "brand+brief", generatedBy: "instagram-art-director@1", now: NOW })!;
    expect(unchecked.lines).toHaveLength(5);
  });
});

describe("what the evidence did NOT contain is reported truthfully", () => {
  it("tells a site that was never fetched apart from a site that could not be read", () => {
    // Both land on the gate payload as `visualDirection.gaps`. "could not be
    // read" when no fetch was ever made sends a reviewer chasing a scraper
    // fault that does not exist.
    const notFetched = buildVisualDirectionInput({ clientSlug: "karoslabs", brandTokens: ART_DIRECTED_KIT, brief: karoslabsBrief() });
    expect(notFetched.gaps.some((g) => g.includes("was fetched for this step"))).toBe(true);
    expect(notFetched.gaps.some((g) => g.includes("could not be read"))).toBe(false);

    const fetchedAndEmpty = buildVisualDirectionInput({ clientSlug: "karoslabs", brandTokens: ART_DIRECTED_KIT, brief: karoslabsBrief(), sitePages: [] });
    expect(fetchedAndEmpty.gaps).toContain("the client's own site could not be read");
  });
});

describe("a brief placeholder is never an instruction to an image model", () => {
  /** `deriveClientBrief` for a client whose profile carries nothing at all — the exact shape item Q exists for. */
  function emptyProfileBrief(): ClientBrief {
    return deriveClientBrief({ profile: {}, contextDocs: {}, forbiddenTopics: [], now: NOW });
  }

  it("writes placeholder sentences into the very fields the fallback reads", () => {
    const brief = emptyProfileBrief();
    expect(brief.positioning.oneLiner).toContain("unnamed business");
    expect(brief.icp.summary).toContain("no target-audience document or industry on file");
  });

  it("derives no line and no style lock from them", () => {
    // Before this guard the image model was told "Art direction: - Photograph
    // the work itself: an unnamed business: no profile description, tagline,
    // name or industry on file", and EVERY generated image in the run carried
    // "Style lock (identical for every image in this set): ... plain
    // documentary photography of an unnamed business: no profile
    // description...". That is strictly worse than the neutral twelve-word
    // line item Q exists to replace.
    const direction = fallbackVisualDirection(BARE_KIT, emptyProfileBrief(), { now: NOW });
    expect(direction).toBeUndefined();

    // With a real brand kit the client still gets a direction — and none of
    // its lines, and not its style lock, quote the placeholder.
    const withKit = fallbackVisualDirection(ART_DIRECTED_KIT, emptyProfileBrief(), { now: NOW })!;
    expect(withKit).toBeDefined();
    const everySentence = [...withKit.lines.map((l) => l.line), withKit.styleLock.line, ...withKit.subject].join(" ");
    expect(everySentence).not.toContain("unnamed business");
    expect(everySentence).not.toContain("on file");
    expect(withKit.styleLock.id).toBe("brand-kit");
    // Named rather than silently skipped: the gate says which brief fields
    // were placeholders.
    expect(withKit.gaps.some((g) => g.includes("positioning.oneLiner") && g.includes("placeholder"))).toBe(true);
    expect(withKit.gaps.some((g) => g.includes("icp.summary"))).toBe(true);
  });

  it("still uses a real brief, so the guard costs a well-described client nothing", () => {
    const direction = fallbackVisualDirection(BARE_KIT, karoslabsBrief(), { now: NOW })!;
    expect(direction.lines.some((l) => l.line.includes("Photograph the work itself"))).toBe(true);
    expect(direction.styleLock.id).toBe("client-brief");
    expect(direction.styleLock.line).toContain("Karos Labs");
  });
});
