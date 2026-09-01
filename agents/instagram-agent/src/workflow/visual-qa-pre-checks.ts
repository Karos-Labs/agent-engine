import type { BrandLogoPlacement } from "@agent-engine/tool-karos-media";
import type { SlidesDataSelfCheck } from "./types.js";

/**
 * SCRUM-324 (AU40) — the deterministic half of "elevated visual QA."
 *
 * The ticket's own instruction, verbatim: add deterministic pre-checks in
 * code wherever the question has a factual answer — is the logo present? are
 * the palette tokens within the kit? does the contrast ratio pass? Code
 * answers those; the LLM judge (`instagram-visual-qa@2`,
 * `InstagramVisualQaAgent`) then grades only what code cannot — composition
 * richness, font hierarchy QUALITY, and colour harmony as an aesthetic
 * judgment beyond raw palette membership. Asking a model whether a hex value
 * is in a list is both more expensive and less reliable than an `includes()`
 * call; this module is that `includes()` call, and the facts it computes so
 * the model never has to guess at them either.
 *
 * Two different shapes of "pre-check" on purpose, not an oversight:
 *
 * 1. `checkPaletteWithinKit` GATES the attempt (`SlidesDataSelfCheck`, the
 *    exact same pass/content_fail shape `checkExpectedScript` and
 *    `checkCraftHygiene` already use): a failure here means the RENDER
 *    ITSELF is carrying a color the brand kit never shipped, which is a real
 *    content defect, feeds the SAME step-07/08b retry loop as every other
 *    self-check, and short-circuits `instagram-visual-qa@2` entirely — the
 *    required evidence for this ticket's cost claim (see
 *    `__tests__/visual-qa-pre-checks.test.ts` and the workflow-level
 *    model-call-counting test in `__tests__/visual-qa-elevated-criteria.test.ts`).
 *
 * 2. `assessBrandAssetPresence` does NOT gate the attempt. It is a FACT, not
 *    a verdict, and that is deliberate: AU38's own module (`brand-logo.ts`)
 *    and this workflow's `brandFragments()` both state the same invariant
 *    repeatedly — "brand furniture must never be able to hold a run." A
 *    client whose `logoUrl` is permanently unreachable (a stale link, or the
 *    `gs://` dead end below) would, if this fact instead FAILED the attempt,
 *    burn all `MAX_SELF_CHECK_ATTEMPTS` redrafting COPY that was never the
 *    problem and then genuinely HOLD THE RUN over a logo — the exact
 *    regression that invariant exists to prevent. So this fact is consumed
 *    two ways instead: it decides whether `brand-asset-integration` is even
 *    worth asking the model to grade this attempt (nothing to grade when no
 *    mark will render), and it is threaded into the model's own input as
 *    `brandAssetContext` so the judge grades INTEGRATION QUALITY of a mark
 *    already known (by code) to be present, rather than guessing at
 *    presence itself.
 *
 * A live, named caveat this module inherits rather than re-derives:
 * `assessBrandAssetPresence`'s "omit" branch can be reached by AU38's own
 * 3:1 contrast floor (`BRAND_LOGO_CONTRAST_FLOOR`,
 * `@agent-engine/tool-karos-media`), which is a JUDGMENT CALL, not a
 * standard — WCAG 2.2 technically exempts logotypes from its contrast
 * requirements at all; AU38 applied SC 1.4.11's graphical-object floor to
 * logos anyway. This module states that plainly rather than presenting an
 * inherited judgment call as settled law.
 *
 * A second, formerly-live caveat, closed by SCRUM-383: `gs://` brand logo
 * URLs used to be a silent dead end upstream — `deriveBrandRenderTokens`
 * accepted a `gs://` logoUrl and passed it straight through,
 * `downloadBrandLogo` (`@agent-engine/tool-karos-media`) refused any
 * non-`https://` URL on its first line with NO diagnostic, so a client whose
 * portal-authored logoUrl was `gs://...` got a silently absent logo on
 * every single run — indistinguishable from "no logo configured at all."
 *
 * `deriveBrandRenderTokens` now rejects a `gs://` logoUrl at derivation
 * (the smaller of the ticket's two defensible fixes — this pipeline has no
 * GCS signing client wired in anywhere to make resolving it to a fetchable
 * https URL the safe choice) and reports why via `BrandRenderTokens`'s
 * `rejectedLogoUrlReason`, which `assessBrandAssetPresence` below surfaces
 * as ITS OWN distinct `present: false` reason — the exact same
 * "unchecked"/"reason" vocabulary this whole pre-checks module already uses
 * elsewhere, not a second parallel mechanism. `downloadBrandLogo`'s own
 * bare refusal also now warns rather than returning silently, as defense in
 * depth for any caller that reaches it directly with an unfiltered URL.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. Palette-within-kit — GATES the attempt. An `includes()` call, not a
//    model judgment.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every accent hex this attempt's render actually used must be a member of
 * `kitPalette` — AU39's accent ring (`BrandRenderTokens.palette`,
 * `buildAccentRing`), which is the working definition of "within the kit"
 * this ticket asks for rather than re-deriving one.
 *
 * `kitPalette.length === 0` passes without an opinion — the same
 * refuse-to-guess rule every other gate in this workflow follows
 * (`checkExpectedScript` on an unknown language, `runTopicGuardrail` on an
 * empty forbidden-topics list): a client with no derivable kit ring has
 * nothing to check the render against, and that must degrade to "this gate
 * has no opinion," never to "fail every draft for this client."
 *
 * Under TODAY's wiring this is close to unreachable with real drafted
 * content — `assembleSlidesData` assigns one code-chosen `accentColor` to
 * every slide (`brandTokens.accentColor ?? brandKit.brandAccent ?? default`),
 * and the ring's own construction (`buildAccentRing`) always seats that same
 * anchor at `ring[0]`, so the two can't disagree yet. It is real protection
 * once AU39's per-slide `paletteForSlide` rotation is wired into rendering
 * (it is not, today — see that function's own module for the seeded-rotation
 * machinery this gate is future-compatible with), and it is directly
 * unit-testable today by constructing a slides-data fixture with an
 * off-kit hex, which is exactly how this module's own test proves the
 * short-circuit.
 */
export function checkPaletteWithinKit(usedHexes: readonly string[], kitPalette: readonly string[]): SlidesDataSelfCheck {
  if (kitPalette.length === 0) return { ok: true };
  const kitSet = new Set(kitPalette.map((h) => h.toLowerCase()));
  const offKit = [...new Set(usedHexes.map((h) => h.toLowerCase()))].filter((h) => !kitSet.has(h));
  if (offKit.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `this attempt's render uses accent color(s) ${offKit.join(", ")} that are not members of the brand kit's ` +
      `accent ring (${kitPalette.join(", ")}) — a deterministic includes() check, not a model judgment`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Brand-asset (logo) presence + AU38 contrast — a FACT, never a gate.
// ─────────────────────────────────────────────────────────────────────────

export type BrandAssetFact =
  | { present: false; reason: string }
  | {
      present: true;
      corner: BrandLogoPlacement["corner"];
      /** True when the mark needed AU38's legibility plate to clear the floor. */
      scrimmed: boolean;
      /** The measured WCAG ratio against the ground, when the mark's own colors were readable at all. */
      groundContrast?: number;
    };

/**
 * Whether a brand logo will actually render on this attempt, and — the whole
 * point of this function, per the ticket's own caveat — WHY it will not,
 * when it will not. Never a stand-in for "the render is broken"; a
 * `present: false` here is frequently the CORRECT, expected outcome (no
 * logoUrl configured at all).
 *
 * `rejectedLogoUrlReason` (SCRUM-383) names a `gs://` dead end explicitly —
 * `deriveBrandRenderTokens` computes it, at the source, when a configured
 * logoUrl was rejected before a download was ever attempted — rather than
 * this function reporting a bare "logo absent" indistinguishable from "no
 * logo configured." Checked FIRST, ahead of `configuredLogoUrl`, because a
 * rejected URL never reaches `hasDownload`/`placement` at all.
 *
 * A `placement` whose `decision === "omit"` folds in AU38's inherited
 * judgment-call contrast floor (`BRAND_LOGO_CONTRAST_FLOOR`) — carried here
 * as `placement.reason`, already a real, computed explanation, never
 * re-derived.
 */
export function assessBrandAssetPresence(input: {
  configuredLogoUrl: string | undefined;
  /**
   * Set when `deriveBrandRenderTokens` rejected a configured logoUrl outright
   * (SCRUM-383, currently: a `gs://` URI) — `configuredLogoUrl` is `undefined`
   * whenever this is set, since a rejected URL is never carried as `logoUrl`.
   */
  rejectedLogoUrlReason?: string | undefined;
  /** True iff the logo's bytes were actually downloaded and decoded this attempt (`parseBrandLogoDataUri` succeeded). */
  hasDownload: boolean;
  /** AU38's placement plan, computed from those bytes — `undefined` iff `hasDownload` is false. */
  placement: BrandLogoPlacement | undefined;
}): BrandAssetFact {
  if (input.rejectedLogoUrlReason !== undefined) {
    return { present: false, reason: input.rejectedLogoUrlReason };
  }

  if (input.configuredLogoUrl === undefined) {
    return { present: false, reason: "this client has no brand logoUrl configured — nothing to grade for brand-asset integration" };
  }

  if (!input.hasDownload) {
    return {
      present: false,
      reason: `brand logoUrl "${input.configuredLogoUrl}" did not produce a usable download this attempt (bad status, wrong content-type, over the size cap, or a network error)`,
    };
  }

  if (input.placement === undefined || input.placement.decision === "omit") {
    return {
      present: false,
      reason: input.placement?.reason ?? "the mark's own colors could not be verified, and no legible placement could be planned",
    };
  }

  return {
    present: true,
    corner: input.placement.corner,
    scrimmed: input.placement.decision === "scrim",
    ...(input.placement.groundContrast !== undefined ? { groundContrast: input.placement.groundContrast } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. What's left for the model — composition richness, font hierarchy,
//    brand-asset integration QUALITY, and colour harmony as an aesthetic
//    judgment beyond raw membership.
// ─────────────────────────────────────────────────────────────────────────

export interface VisualQaCriterion {
  id: string;
  description: string;
}

export const COMPOSITION_RICHNESS_CRITERION: VisualQaCriterion = {
  id: "composition-richness",
  description:
    "Across the WHOLE carousel, do the slides use a genuinely varied set of layouts and visual devices (photo, stat callout, quote, comparison, list) suited to what each slide actually says, or does every slide reduce to the same headline+body block regardless of content? This is a judgment about VARIETY AND FIT, not about whether any single field is present — code already checked that a required field exists; judge whether the STRUCTURE this attempt chose is rich or monotonous.",
};

export const FONT_HIERARCHY_CRITERION: VisualQaCriterion = {
  id: "font-hierarchy",
  description:
    "Within each slide, does the mix of fields present (a `figure` beside a `subLabel`, a `headline` beside a `kicker`, a mono `sourceLine`) read as an intentional typographic hierarchy — one clear dominant element with everything else supporting it — or does it read as several competing blocks of similar visual weight with nothing establishing what matters most? Judge the STRUCTURE the fields imply, not whether a font family loaded — that is a code-level render concern, not this judge's.",
};

export const BRAND_ASSET_INTEGRATION_CRITERION: VisualQaCriterion = {
  id: "brand-asset-integration",
  description:
    "A brand mark IS confirmed present this attempt (see `brandAssetContext` in the input — its presence and legibility were already verified by code, never re-judge that). Given where it sits (`corner`) and whether it needed a legibility plate (`scrimmed`), does it read as a native, intentional piece of the design, or as a badge stamped on top of an otherwise-unrelated layout? Judge INTEGRATION, not presence.",
};

export const COLOUR_HARMONY_CRITERION: VisualQaCriterion = {
  id: "colour-harmony",
  description:
    "Every accent color this attempt uses IS a verified member of the brand's kit (see `brandPalette` in the input — membership was already checked by code with a simple includes() call, never re-judge that). Given the specific ground/accent combination actually rendered, does it read as a harmonious, intentional pairing, or as a technically-in-palette but jarring or accidental-looking combination? Judge the AESTHETIC PAIRING, not whether the hex is one the client owns.",
};

/**
 * Which of the four elevated criteria are even worth sending to the model
 * this attempt — composition richness and font hierarchy are universal (every
 * carousel has slides and typography to judge), but brand-asset integration
 * and colour harmony each require a signal to judge AT ALL: asking the model
 * to grade the integration of a logo that will not render, or the harmony of
 * a palette this client's kit doesn't even have, is exactly the "ask a model
 * a question code already knows the answer to" pattern this ticket exists to
 * remove — the honest answer in both cases is "not applicable," and code
 * already knows that without spending a token on it.
 */
export function buildElevatedVisualQaCriteria(input: { logo: BrandAssetFact; kitPalette: readonly string[] }): VisualQaCriterion[] {
  const criteria: VisualQaCriterion[] = [COMPOSITION_RICHNESS_CRITERION, FONT_HIERARCHY_CRITERION];
  if (input.logo.present) criteria.push(BRAND_ASSET_INTEGRATION_CRITERION);
  if (input.kitPalette.length > 0) criteria.push(COLOUR_HARMONY_CRITERION);
  return criteria;
}
