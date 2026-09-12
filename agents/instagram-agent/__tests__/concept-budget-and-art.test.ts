import { describe, expect, it } from "vitest";
import type { ClientBrief } from "@agent-engine/tools";
import { deriveClientBrief } from "../src/workflow/client-brief.js";
import type { BrandTokens } from "../src/workflow/types.js";
import {
  DEFAULT_RUN_BUDGET_PLAN,
  DEFAULT_RUN_SHAPE,
  EMPTY_RUN_BUDGET_HISTORY,
  MAX_RUN_SPEND_USD,
  STEP_COST_ESTIMATES_USD,
  TARGET_RUN_SPEND_USD,
  estimateRunCost,
  planRunBudget,
  roundUsd,
} from "../src/workflow/run-budget.js";
import {
  ANTI_METAPHOR_LINE_PREFIX,
  STANDING_IMAGE_FORBID,
  buildArtDirection,
  buildConceptArtDirection,
  fallbackVisualDirection,
} from "../src/workflow/visual-direction.js";

/**
 * RFC-16 (Phase 4) P5 — the money and the art direction of the CONCEPT mode,
 * plus one pre-existing safety hole found while reading for it.
 *
 * Three things are pinned here, and each one stands over a specific way this
 * phase could quietly stop working:
 *
 * 1. **The estimate is unconditional.** `02j-plan-run-budget` runs long before
 *    `04m-concept-eligibility`, so it cannot know whether the selector will
 *    fire. `run-budget.ts`'s own rule is that an estimate which flatters
 *    itself pulls no lever, so the worst case is priced on every run the mode
 *    is reachable on — and the test below proves the $0.030 actually reaches
 *    the lever rather than merely appearing in a breakdown.
 * 2. **The anti-metaphor line is dropped by IDENTITY.** A `startsWith` against
 *    an exported constant, not a regex over prose — and the constant is pinned
 *    against the sentence `fallbackVisualDirection` really emits, because
 *    nothing in the type system ties the two together.
 * 3. **The brand-kit fallback carries the standing product policy.** Until
 *    this phase it did not, for any client, on either the brief or the
 *    brand-only path.
 */

const NOW = new Date("2026-09-11T09:00:00.000Z");

/** The hand-art-directed client: a kit with real photographic tokens, so `buildArtDirection` has every field to return. */
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

// ─────────────────────────────────────────────────────────────────────────
// 1. The estimate
// ─────────────────────────────────────────────────────────────────────────

describe("run-budget — the concept is priced before anyone knows whether it fires", () => {
  /** What the mode costs per run over and above the pictures already in `images`: the Sonnet design call and the one vision inspection of the frame it produced. */
  const CONCEPT_FIXED_USD = STEP_COST_ESTIMATES_USD.concept + STEP_COST_ESTIMATES_USD.visionInspectPerImage;

  it("prices the concept worst case even on a run where the selector will decline", () => {
    const possible = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, conceptPossible: true });
    const off = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, conceptPossible: false });

    // $0.029 of Sonnet + $0.001 of vision, and nothing else: the concept's
    // IMAGE is one of the pictures `images` already prices, and booking it
    // twice would pull an image lever the run does not need.
    expect(CONCEPT_FIXED_USD).toBeCloseTo(0.03, 6);
    expect(roundUsd(possible.breakdown.fixed - off.breakdown.fixed)).toBeCloseTo(0.03, 6);
    expect(possible.breakdown.images).toBe(off.breakdown.images);
    expect(possible.breakdown.attempts).toBe(off.breakdown.attempts);
    expect(possible.breakdown.rescue).toBe(off.breakdown.rescue);
    expect(roundUsd(possible.rawUsd - off.rawUsd)).toBeCloseTo(0.03, 6);

    // The default shape is the WORST case, as every other field of it is: the
    // mode is reachable unless a client config or a run input turned it off,
    // and `02j` is handed the shape it cannot yet disprove.
    expect(DEFAULT_RUN_SHAPE.conceptPossible).toBe(true);

    // And the point of all of it — the $0.030 has to reach the LEVER. A run
    // whose remaining target exactly fits the concept-less estimate adapts
    // when the mode is reachable and does not when it is off. An estimate
    // that only priced what it hoped for would adapt in neither case and the
    // run would discover the Sonnet call on the live meter instead.
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 0.5, runs: [] };
    const warm = { ...DEFAULT_RUN_SHAPE, trendQueries: 0, signalExecutions: 0, researchLaneQueries: 0, pageFetches: 0 };
    const withoutConcept = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...warm, conceptPossible: false }, history.ewmaRatio);
    const spentUsd = roundUsd(TARGET_RUN_SPEND_USD - withoutConcept.estimatedUsd);

    expect(planRunBudget({ ...warm, conceptPossible: false }, history, { spentUsd }).adaptations).toEqual([]);
    const adapted = planRunBudget({ ...warm, conceptPossible: true }, history, { spentUsd });
    expect(adapted.adaptations).not.toEqual([]);
    // Adapted, never held: the run still has a plan and still fits the target.
    expect(adapted.plan.generatedImagesCap).toBeGreaterThanOrEqual(0);
    expect(roundUsd(adapted.estimate.estimatedUsd + spentUsd)).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
  });

  it("prices the Sonnet call at no less than the arithmetic in its own comment, and moves no ceiling", () => {
    // 6,200 in x $3/1M + 650 out x $15/1M = $0.0186 + $0.00975 = $0.02835,
    // priced 0.029 — rounded UP, because the direction an estimate is allowed
    // to be wrong in is the one that arms a lever early.
    const arithmetic = (6_200 * 3) / 1_000_000 + (650 * 15) / 1_000_000;
    expect(arithmetic).toBeCloseTo(0.02835, 6);
    expect(STEP_COST_ESTIMATES_USD.concept).toBe(0.029);
    expect(STEP_COST_ESTIMATES_USD.concept).toBeGreaterThanOrEqual(arithmetic);
    // Well under the $0.039 image it is deciding the subject of, which is the
    // whole case for spending it — and no Opus anywhere in a run.
    expect(STEP_COST_ESTIMATES_USD.concept).toBeLessThan(STEP_COST_ESTIMATES_USD.generatedImage);

    // Phase 4 buys nothing by moving a ceiling. If one of these ever has to
    // change to make the mode fit, the mode is the thing that is wrong.
    expect(TARGET_RUN_SPEND_USD).toBe(1.0);
    expect(MAX_RUN_SPEND_USD).toBe(1.5);
    // The image ladder is module-private, so it is pinned through the only
    // door it has: the adaptations a cold run's plan reports, in order.
    expect(planRunBudget(DEFAULT_RUN_SHAPE).adaptations).toEqual(["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The concept's art direction
// ─────────────────────────────────────────────────────────────────────────

/** The concept object's two art-bearing fields, as `04n` would hand them over. */
const CONCEPT = {
  paletteRole: "the accent orange is the ember light on the throne's arm, not a wash over the frame",
  productionNote: "push the locked style to its most dramatic end",
};

describe("buildConceptArtDirection", () => {
  it("buildConceptArtDirection drops the anti-metaphor line by identity and keeps accentColor, forbid and styleLock byte-identical", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;
    // A line that TALKS about metaphor without being the standing one. A
    // regex over prose would eat this; an identity check on the prefix must
    // not, or the mode starts deleting an art director's own sentences.
    const authorLine = "Never let an abstract metaphor stand in for the product when the product is on screen.";
    const withAuthorLine = { ...direction, lines: [...direction.lines, { line: authorLine, basis: "client feed", confidence: "medium" as const }] };

    const base = buildArtDirection(ART_DIRECTED_KIT, withAuthorLine)!;
    const concept = buildConceptArtDirection(ART_DIRECTED_KIT, withAuthorLine, CONCEPT)!;

    expect(typeof base.notes).toBe("string");
    expect(base.notes as string).toContain(ANTI_METAPHOR_LINE_PREFIX);
    expect(concept.notes as string).not.toContain(ANTI_METAPHOR_LINE_PREFIX);
    // Only that one line goes. Every other line the art direction carries is
    // still in the verbatim block, including the one about metaphors that
    // nobody asked us to drop.
    expect(concept.notes as string).toContain(authorLine);
    for (const line of withAuthorLine.lines) {
      if (line.line.startsWith(ANTI_METAPHOR_LINE_PREFIX)) continue;
      expect(concept.notes as string).toContain(line.line);
    }
    // The two additions, in order, as sentences: `notes` is appended verbatim
    // to the generation brief, so the punctuation is ours to get right.
    expect(concept.notes as string).toContain(`${CONCEPT.paletteRole}.`);
    expect(concept.notes as string).toMatch(/push the locked style to its most dramatic end\.$/u);

    // Everything else is byte-identical. `accentColor` above all: it is a
    // brand FACT, and the owner's "brand colours govern absolutely" is this
    // assertion in code.
    expect(Object.keys(concept).sort()).toEqual(Object.keys(base).sort());
    expect(concept.accentColor).toBe(ART_DIRECTED_KIT.accentColor);
    expect(concept.palette).toEqual(base.palette);
    expect(concept.forbid).toEqual(base.forbid);
    expect(concept.styleLock).toEqual(base.styleLock);
    expect(concept.aesthetic).toEqual(base.aesthetic);
    expect(concept.lighting).toEqual(base.lighting);
    expect(concept.mood).toEqual(base.mood);
  });

  it("cannot be talked out of the brand accent, and cannot shorten forbid", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;
    // No production note: a concept that wrote none appends none, rather than
    // an empty sentence into a block the generator reads verbatim.
    const concept = buildConceptArtDirection(ART_DIRECTED_KIT, direction, { paletteRole: "render the whole frame in Duolingo green #58cc02 instead" })!;

    expect(concept.accentColor).toBe("#ff6b2c");
    expect(concept.forbid).toEqual(direction.forbid);
    expect(concept.forbid as string[]).toEqual(expect.arrayContaining([...STANDING_IMAGE_FORBID]));
    // An absent production note appends nothing rather than an empty sentence.
    expect(concept.notes as string).not.toContain("..");
    expect((concept.notes as string).endsWith("instead.")).toBe(true);
  });

  it("is undefined in exactly the one case buildArtDirection is, rather than inventing an art object out of a note", () => {
    // Precondition 6 and L8 both require a palette or an accent before a
    // concept is ever authored, so this is unreachable on the concept path —
    // and it stays honest instead of shipping a brief that is only a note.
    expect(buildArtDirection(BARE_KIT, undefined)).toBeUndefined();
    expect(buildConceptArtDirection(BARE_KIT, undefined, CONCEPT)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The pin, and the pre-existing hole
// ─────────────────────────────────────────────────────────────────────────

describe("fallbackVisualDirection — the sentence and the standing policy", () => {
  it("ANTI_METAPHOR_LINE_PREFIX still prefixes the line fallbackVisualDirection actually emits", () => {
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;
    const emitted = direction.lines.find((l) => l.basis === "client brief: positioning.whatWeSell");

    // The pin. The drop in `buildConceptArtDirection` is a `startsWith`
    // against the constant, and nothing in the type system ties the constant
    // to this sentence: edit one without the other and the drop silently
    // stops dropping anything, on every client, with no test failing anywhere
    // else in the suite. That is what this assertion is for.
    expect(emitted).toBeDefined();
    expect(emitted!.line.startsWith(ANTI_METAPHOR_LINE_PREFIX)).toBe(true);
    // ...and the constant is the whole standing sentence, not a fragment of
    // it that would also match an author's line.
    expect(ANTI_METAPHOR_LINE_PREFIX.endsWith(":")).toBe(true);
    expect(ANTI_METAPHOR_LINE_PREFIX.length).toBeGreaterThan(60);
  });

  it("fallbackVisualDirection forbids recognisable real people and brand marks on the brand-kit path", () => {
    // The hole, in one line: this path populated `forbid` SOLELY from
    // `brief.forbidden.topics`, so the standing policy the art-director
    // prompt states ("logos and brand marks, recognisable real people") was
    // present only when the AGENT wrote the direction. A brand-kit-only
    // client — most of the fleet, since visual-pattern consent is usually
    // absent — had an empty `forbid` and shipped every generated image with
    // no real-person or brand-mark entry at all. Live since Phase 3.
    const brandOnly = fallbackVisualDirection(ART_DIRECTED_KIT, undefined, { now: NOW })!;
    expect(brandOnly.forbid).toContain("recognisable real people");
    expect(brandOnly.forbid).toContain("logos and brand marks");
    expect(buildArtDirection(ART_DIRECTED_KIT, brandOnly)!.forbid).toEqual(brandOnly.forbid);

    // And on the brief path, alongside the client's own topics rather than
    // instead of them.
    const withBrief = fallbackVisualDirection(ART_DIRECTED_KIT, karoslabsBrief(), { now: NOW })!;
    expect(withBrief.forbid).toEqual(expect.arrayContaining([...STANDING_IMAGE_FORBID, "competitor pricing", "unreleased roadmap"]));
  });

  it("a client with a long forbidden-topics list cannot squeeze the standing policy out of the ten-entry list", () => {
    const brief = karoslabsBrief();
    const crowded: ClientBrief = { ...brief, forbidden: { ...brief.forbidden, topics: Array.from({ length: 14 }, (_, i) => `forbidden topic ${i + 1}`) } };
    const direction = fallbackVisualDirection(ART_DIRECTED_KIT, crowded, { now: NOW })!;

    // The schema caps `forbid` at ten. The two entries that are a rights
    // question rather than a taste one are the two that survive the cap.
    expect(direction.forbid.length).toBe(10);
    expect(direction.forbid.slice(0, 2)).toEqual([...STANDING_IMAGE_FORBID]);
  });
});
