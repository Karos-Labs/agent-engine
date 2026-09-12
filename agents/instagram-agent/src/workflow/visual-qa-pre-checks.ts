import type { BrandLogoPlacement } from "@agent-engine/tool-karos-media";
import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import { ACCENT_GROUND_CONTRAST_FLOOR, TEXT_CONTRAST_FLOOR, contrastRatio } from "./brand-render-tokens.js";
import { NO_IMAGE_MEANS_DEVICE_RULE, checkNoImageMeansDevice } from "./scene-brief.js";
import { INVERTED_TEMPLATE_SUFFIX } from "./slides-data.js";
import type { InstagramCopyOutput, SlidesDataSelfCheck, StyleRule } from "./types.js";

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
// 2. Brand-asset (logo) presence + AU38 contrast, and (SCRUM-393/IGSTYLE-8)
//    ground/fg + accent-on-ground contrast — all FACTS, never gates.
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

/**
 * One measured WCAG contrast check, reported as a fact — the ratio, the
 * floor it's judged against, and whether it cleared.
 *
 * SCRUM-393 (IGSTYLE-8). `buildAccentRing` (`brand-render-tokens.ts`)
 * exempts only the ring's ANCHOR from `ACCENT_GROUND_CONTRAST_FLOOR` — on
 * purpose, per that function's own comment: refusing a client's real,
 * already-shipping accent would be worse than rendering it. But that
 * exemption from GATING was silently doubling as an exemption from ever
 * being MEASURED at all: two real clients (`sitti`, coral-on-cream at
 * 2.8:1; `kindlyyours`, tan-on-white at 2.2:1) ship a low-contrast anchor
 * and nothing anywhere says so. Both are genuine properties of those
 * brands' own colors, not defects to silently override — so this reports
 * them, exactly the way section 2 above reports a present-or-absent logo:
 * a number for a human to see, never a verdict this pre-check enforces.
 */
export interface ContrastFact {
  /** e.g. "text (--fg on --bg)" or "accent #f15151 on ground". */
  label: string;
  /** The measured WCAG ratio, 1..21. */
  ratio: number;
  /** The floor this pair is judged against — `TEXT_CONTRAST_FLOOR` or `ACCENT_GROUND_CONTRAST_FLOOR`. */
  floor: number;
  pass: boolean;
}

/**
 * Every contrast fact worth reporting for this attempt: the ground/fg text
 * pair (if the kit derived both), and every DISTINCT accent hex this
 * attempt's render actually used against the ground (if the kit derived a
 * ground at all) — deliberately the same `usedHexes` input
 * `checkPaletteWithinKit` above already gates on, so "which accents are
 * being judged" never drifts between the gate and this fact.
 *
 * Reports facts for BOTH passes and failures — "a reviewer should see the
 * good numbers too" is the ticket's own acceptance line, and it is also
 * what makes an all-clear client's empty-warnings silence legible as "we
 * checked and it was fine" rather than "we didn't check."
 *
 * No `kit`/no `ground` still returns `[]` — the same refuse-to-guess rule
 * every other check in this module follows: nothing derivable means
 * nothing to report an opinion about, never a manufactured failure.
 */
export function assessContrastFacts(
  kit: { cssVars: Record<string, string> } | undefined,
  accentUsed: readonly string[],
): ContrastFact[] {
  const ground = kit?.cssVars["--bg"];
  const fg = kit?.cssVars["--fg"];
  const facts: ContrastFact[] = [];

  if (ground !== undefined && fg !== undefined) {
    const ratio = contrastRatio(fg, ground);
    facts.push({ label: "text (--fg on --bg)", ratio, floor: TEXT_CONTRAST_FLOOR, pass: ratio >= TEXT_CONTRAST_FLOOR });
  }

  if (ground !== undefined) {
    for (const hex of [...new Set(accentUsed.map((h) => h.toLowerCase()))]) {
      const ratio = contrastRatio(hex, ground);
      facts.push({
        label: `accent ${hex} on ground`,
        ratio,
        floor: ACCENT_GROUND_CONTRAST_FLOOR,
        pass: ratio >= ACCENT_GROUND_CONTRAST_FLOOR,
      });
    }
  }

  return facts;
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

// ─────────────────────────────────────────────────────────────────────────
// 4. Default render rules (Phase 0, brief item D) — the rules every client
//    is judged by when its frozen style config declares none, and the
//    deterministic half of checking them BEFORE a render is paid for.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Why these exist at all: the 2026-09-08 audit found `renderRules`
 * (`frozen.styleConfig.rules.filter(check === "render")`) empty for EVERY
 * live client, so `08b-visual-qa` passed each attempt with "no render rules
 * provided" and the vision `fitScore` sat at 5 on every slide — a judge with
 * nothing to judge against. Finding 9 of the same audit is what that
 * silence was hiding: cover slides that are a headline on blank ground (top
 * 60% empty), numbers set as prose, and closers with no call to action.
 *
 * These four are the floor a carousel has to clear regardless of client, and
 * they are worded so that the six bundled archetypes (`photo`,
 * `stat_callout`, `quote_card`, `comparison_card`, `list_takeaway`,
 * `headline_focus`) can satisfy every one of them today — Phase 2's template
 * work is out of scope, so a rule the bundled set could not meet would only
 * manufacture redrafts. A client whose config carries its own `render`
 * rules never sees these (`resolveRenderRules`): the defaults fill an
 * absence, they never override a client's stated standard.
 *
 * Ids are namespaced `default:` so a finding in the ledger or the gate
 * payload can never be mistaken for a rule the client authored. The copy
 * step receives the same list in `styleConfig.rules` when the defaults are
 * in force, so the writer is told the rules it will be judged by (copy
 * prompt @12 §7 states the same three devices in the writer's terms).
 */
export const DEFAULT_RENDER_RULES: StyleRule[] = [
  {
    id: "default:cover-carries-device",
    check: "render",
    description:
      "Slide 1 is a cover: a photograph, the `cover` archetype's graphic ground, or a figure device (stat, comparison, quote, list, or a `device` on the slide). A headline alone on empty ground is not a cover.",
  },
  {
    id: "default:two-elements-per-slide",
    check: "render",
    description:
      "Every slide carries at least two content elements (headline + body, figure + label, quote + attribution, image + headline, list with 2+ items, a number device, a closer's recap strip).",
  },
  {
    id: "default:numbers-are-devices",
    check: "render",
    description:
      "A slide whose headline or body opens with a number, percentage or currency amount renders that figure AS a device — a stat callout, a comparison card, or a `device` on the slide (figure, figure_pair, bars, timeline, versus, unit_grid) — never as prose.",
  },
  {
    id: "default:closer-carries-cta",
    check: "render",
    description:
      "The last slide of a carousel (the caption, for a single) carries a call to action or a question the reader can answer — that is what the `closer` archetype's takeaway plus accent-ruled question line is for.",
  },
  // Phase 3, item R. APPENDED, so the four ids above and their order are
  // untouched. The rule's text and its deterministic check live in
  // `scene-brief.ts` beside the schema that creates the case it guards.
  NO_IMAGE_MEANS_DEVICE_RULE,
];

/** Where an attempt's `renderRules` came from — the client's frozen config, or the defaults above filling an absence. */
export type RenderRuleSource = "client" | "default";

/**
 * The one place the "client rules or defaults" decision is made, so the
 * copy input, `07h`'s deterministic check and `08b`'s judge can never
 * disagree about which list is in force. A config with ONLY `check: "copy"`
 * rules has no render rules and gets the defaults — a copy rule says nothing
 * about the rendered slide.
 */
export function resolveRenderRules(frozenRules: readonly StyleRule[]): { source: RenderRuleSource; rules: StyleRule[] } {
  const clientRender = frozenRules.filter((r) => r.check === "render");
  return clientRender.length > 0 ? { source: "client", rules: clientRender } : { source: "default", rules: DEFAULT_RENDER_RULES };
}

/**
 * Slide `fields` that are layout metadata rather than prose — a hex code, a
 * direction token, brand furniture, the reviewer's typography controls.
 * Excluded from anything that counts or reads a slide's CONTENT: the
 * two-elements rule below, the workflow's `slidesTextFor` (topic guardrail
 * coverage) and the reviewer's editable-fields view. Lifted here from the
 * workflow's former local `NON_PROSE_FIELD_KEYS` so a new metadata field is
 * added in one place and every consumer agrees on it.
 */
export const LAYOUT_FIELD_KEYS: ReadonlySet<string> = new Set([
  "accentColor",
  "dir",
  "brandHandle",
  "seriesBadge",
  "fontScale",
  "textAlign",
  // Phase 2, item M. All four are code-derived layout metadata, never prose:
  // `groundStyle` names which token-driven ground the slide paints,
  // `slideIndex` is the numeral the glyph ground sets, `deviceFigures` is
  // the list of figures a rendered device paints — read by
  // `default:numbers-are-devices` below — and `deviceKind` is the proof that
  // the device actually reached a slot, read by `07k`'s skeleton signature
  // and by `collectDeviceIssues`. None of them counts as content.
  "groundStyle",
  "slideIndex",
  "deviceFigures",
  "deviceKind",
  // Phase 4, RFC-15 §7.2. The document's BCP-47 `lang` attribute — layout
  // metadata in the strictest sense: it is read by Chromium's font fallback
  // and by nothing else. It must not be counted by the two-elements rule (a
  // slide whose only other field is a headline would otherwise read as two
  // elements and pass a rule it fails), must not enter the topic-guardrail
  // corpus (`slidesTextFor`), and must not appear in the reviewer's
  // editable-fields view — "he" is not a thing a person edits on a slide.
  "lang",
]);

/**
 * Leads with a figure: an optional currency sign, digits with separators,
 * an optional unit — `%`, `k`/`M` shorthand, million/billion in English or
 * Hebrew. The `(?!\d{4}\b)` lookahead exempts a bare four-digit number so
 * "2026 was the year…" reads as a date, not a statistic; a genuine
 * four-digit count ("4200 teams") is the accepted cost of that exemption,
 * since a year opening a sentence is far more common in this copy than a
 * four-digit figure with no separator. No `g` flag on purpose — a stateful
 * `lastIndex` on a shared module-level regex is a classic source of
 * every-other-call misses.
 */
export const LEADS_WITH_FIGURE = /^\s*(?!\d{4}\b)(?:[$€£₪]\s?)?\d[\d.,]*\s?(?:%|[kKmM]\b|million|billion|אלף|מיליון|מיליארד)?/u;

/**
 * The small closer lexicon the deterministic pass accepts as a call to
 * action. Deliberately small: a MISS here is not a failure (see
 * `checkDefaultRenderRules`), it only hands the question to the judge, so
 * the list needs to be right when it matches, not exhaustive.
 */
export const CTA_LEXICON_LATIN = /\b(save|share|comment|tell us|try|download|book|sign up|follow|dm|reply)\b/i;
export const CTA_LEXICON_HEBREW = /(שמרו|שתפו|ספרו|נסו|הורידו|עקבו|מה דעתכם|כתבו לנו)/u;
/** A question the reader can answer — `?` plus the Arabic-script question mark, since `dir="rtl"` copy already renders here. */
const QUESTION_MARK = /[?؟]/u;

/**
 * Template basenames that ARE a designed element on their own (the cover
 * rule) — the archetypes that carry their frame without a photograph.
 *
 * `cover` and `closer` join them in Phase 2 (item M), and `cover` is the
 * interesting one: it is here even though it MAY have no hero and no device,
 * because `cover.html` is structurally incapable of rendering as a headline
 * on flat ground — its ground layer falls back from a full-bleed photograph
 * to an accent colour block with a diagonal keyline to a two-token gradient,
 * so there is no content combination that produces the bare plate this rule
 * exists to refuse. The pixel proof is the calibration test, not this
 * comment: `interest-floor-calibration.test.ts` renders a cover with neither
 * a hero nor a device and asserts it still clears the cover role's
 * imagery-or-device floor.
 */
const DEVICE_TEMPLATE_BASENAMES: ReadonlySet<string> = new Set(["stat-callout", "comparison-card", "quote-card", "list-takeaway", "cover", "closer"]);
/** `templateFileName("custom_x")` → `custom-x.html`; the prefix is the only thing a template path tells us about a model-authored archetype. */
const CUSTOM_TEMPLATE_PREFIX = "custom-";
const HEADLINE_FOCUS_BASENAME = "headline-focus";
const COVER_BASENAME = "cover";
const CLOSER_BASENAME = "closer";
const QUOTE_CARD_BASENAME = "quote-card";

/**
 * Archetypes whose bundled template declares a slot a `SlideDevice` fragment
 * can paint into — verified against the files, not assumed: only
 * `cover.html` and `headline-focus.html` carry `{{html:device}}`, and
 * `closer.html` carries `{{html:recap}}`, which `contentFor` fills with a
 * device when there is no recap strip to build.
 *
 * This exists so that `default:numbers-are-devices` never recommends a
 * mechanism the failing slide's archetype cannot render. `photo`/`text_only`
 * are absent because they route to the CLIENT's own configured
 * `slideTemplate`, a file this repo does not control and cannot assume has a
 * device slot; `stat_callout` and `comparison_card` are absent because they
 * ARE figure devices (`rendersFigureAsDevice` reads their own numerals);
 * `list_takeaway` and `quote_card` are absent because their middles are
 * already spoken for by rows and by a quotation.
 */
const DEVICE_SLOT_BASENAMES: ReadonlySet<string> = new Set([COVER_BASENAME, HEADLINE_FOCUS_BASENAME, CLOSER_BASENAME]);

/**
 * Whether a device could actually paint on THIS rendered slide.
 *
 * Not a property of the archetype alone: a `closer` has one elastic middle,
 * and a recap strip built from the carousel's own earlier slides takes it —
 * `contentFor` then drops the slide-level device. `deviceKind` is present
 * exactly when a device won that slot, so its presence (or the absence of a
 * recap) is the honest answer.
 */
function canCarryDevice(slide: Slide, base: string): boolean {
  if (!DEVICE_SLOT_BASENAMES.has(base)) return false;
  if (base !== CLOSER_BASENAME) return true;
  return slide.fields?.["deviceKind"] !== undefined || slide.htmlFragments?.["recap"] === undefined;
}

/**
 * Rendered prose fields a leading figure is NOT a defect in.
 *
 * `quoteText`/`attribution` are a verbatim quotation and its speaker —
 * restructuring someone's words into a bar chart is not a layout fix, it is
 * a misquote — and `sourceLine` is a citation, where a year or a sample size
 * leading the line is correct.
 */
const FIGURE_RULE_EXEMPT_FIELDS: ReadonlySet<string> = new Set(["quoteText", "attribution", "sourceLine"]);

/** The six device shapes, as the copy schema names them — quoted verbatim in the steer so the writer can act on it without opening the prompt. */
const DEVICE_KINDS_SENTENCE = "figure, figure_pair, bars, timeline, versus, unit_grid";

/**
 * The remedy sentence for a slide that led with a figure and rendered it as
 * prose — and it must name a mechanism THIS slide's archetype can actually
 * perform.
 *
 * Only three of the eight archetypes render a device
 * (`DEVICE_SLOT_BASENAMES`), so on the other five "give the slide a device"
 * is advice for the exact thing that was just silently dropped: the writer
 * did what §19 asked, `withDevice` emitted nothing, and the rule then failed
 * the slide for it. A steer has to be actionable or it trains the model to
 * ignore steers.
 */
function figureRemedyFor(slide: Slide, base: string): string {
  if (canCarryDevice(slide, base)) {
    return `give the slide a device carrying that figure (${DEVICE_KINDS_SENTENCE}), or lead with the noun`;
  }
  if (base === CLOSER_BASENAME) {
    return (
      "this closer's middle is already filled by the recap strip built from the earlier slides, so a device has nowhere to paint — " +
      "move the figure to a slide that can carry one (cover, headline_focus) or lead with the noun"
    );
  }
  return (
    `the "${base}" archetype has no device slot — set this slide as a stat_callout or a comparison_card (both of which ARE figure devices), ` +
    "move the figure onto the cover or a headline_focus slide, or lead with the noun"
  );
}

/**
 * The archetype a rendered slide's template path names, normalised: the
 * last path segment, without its extension, without the `-inv` suffix
 * IGSTYLE-10's ground/fg inversion appends (`stat-callout-inv.html` is
 * still a stat callout). The client's own base template (`photo` /
 * `text_only`, configurable filename) is whatever basename it has — every
 * check below treats "not a known archetype" as "the client's base slide".
 */
export function templateBasename(template: string): string {
  const file = template.split(/[\\/]/).pop() ?? template;
  const stem = file.replace(/\.[^.]+$/u, "");
  return stem.endsWith(INVERTED_TEMPLATE_SUFFIX) ? stem.slice(0, -INVERTED_TEMPLATE_SUFFIX.length) : stem;
}

export interface DefaultRenderRuleFailure {
  ruleId: string;
  /** Omitted for a whole-post finding; every rule below happens to name a slide. */
  slide?: number;
  reason: string;
}

export interface DefaultRenderRulesResult {
  /** Deterministic failures — a `continue` back to step 05 with NO render spent. Empty means every rule code could decide was met. */
  failures: DefaultRenderRuleFailure[];
  /**
   * Rules code could not decide, for `08b`'s judge — each carries its
   * original description plus a note saying exactly what code looked for
   * and did not find, so the model judges the residue, not the whole rule.
   * Never contains a rule that passed deterministically: re-asking the
   * model a question code already answered is the pattern this whole module
   * exists to remove.
   */
  residue: StyleRule[];
}

/** Non-empty prose field values of one assembled slide, layout metadata excluded. */
function proseFieldsOf(slide: Slide): Array<[key: string, value: string]> {
  return Object.entries(slide.fields ?? {}).filter(([key, value]) => !LAYOUT_FIELD_KEYS.has(key) && value.trim().length > 0);
}

/**
 * How many content elements a rendered slide actually carries. Prose fields
 * (after `LAYOUT_FIELD_KEYS`), plus the hero image, plus a list's rows
 * fragment (the rows live in `htmlFragments`, never in `fields`).
 *
 * `headline-focus` ON THE COVER is the one case counted differently, and the
 * reason is in its own template: the body renders as a 31px subline under
 * the accent band beneath a 118px headline — a statement and its sub-line,
 * ONE lockup, not two competing elements — which on slide 1 is exactly the
 * "headline on blank ground" the cover rule exists to refuse. That slide is
 * already failed by the cover rule above (a headline_focus cover can never
 * carry `images.hero`, and the archetype is not a figure device), so this is
 * belt and braces rather than the deciding check; it stays because the two
 * rules answer different questions and a `custom` cover that resolves to
 * this template would otherwise be counted generously. Copy prompt @12 §7
 * tells the writer the same thing the cover rule enforces: `headline_focus`
 * is a mid-carousel turn, never slide 1, and a `kicker` does not make it a
 * cover.
 *
 * Mid-carousel the SAME archetype counts headline + body as two, because
 * that is what the prompt tells the writer (§7: "Uses `headline` and `body`";
 * the kicker is "optional" and recommended only for slide 1) and what the
 * rule's own description promises ("headline + body"). Until 2026-09-09 the
 * subtraction applied to every slide, so a prompt-compliant "turn in the
 * middle of the carousel" failed 07h on every attempt and, under a `reduced`
 * budget plan, was a hold on the second miss.
 */
function countContentElements(slide: Slide, isCover: boolean): number {
  const prose = proseFieldsOf(slide);
  const keys = new Set(prose.map(([key]) => key));
  let count = prose.length;
  if (isCover && templateBasename(slide.template) === HEADLINE_FOCUS_BASENAME && keys.has("headline") && keys.has("body")) count -= 1;
  if (slide.images?.["hero"]) count += 1;
  if (slide.htmlFragments?.["itemRows"]) count += 1;
  // Phase 2, item M: a rendered number device and a closer's recap strip are
  // content elements in exactly the way a list's rows are — a designed block
  // the reader looks at — and they live in `htmlFragments` for the same
  // reason (a variable number of children the renderer cannot loop over).
  if (slide.htmlFragments?.["device"]) count += 1;
  if (slide.htmlFragments?.["recap"]) count += 1;
  return count;
}

/**
 * The digits a figure token carries, separators and units stripped — the
 * comparable core of "42%", "₪1,200", "4.2x".
 *
 * Comparing digit runs rather than whole strings is what lets a headline's
 * "₪1,200 a month" match a device whose display reads "₪1,200" without
 * either side having to normalise currency symbols, thin spaces or the
 * Hebrew thousands separator.
 */
function digitsOf(value: string): string {
  return value.replace(/[^\d]/gu, "");
}

/**
 * Whether this rendered slide sets `figure` AS A DEVICE rather than as prose.
 *
 * Phase 2, item M.4 — this REPLACES the old "is the template a stat callout
 * or a comparison card" test, and the difference matters: `resolveLayout`
 * allows each structured archetype once per carousel, so under the old test
 * the second and third numeric fact in a post had nowhere designed to go,
 * which is why the rule's own text used to end with the apology "every other
 * numeric fact leads with the noun". With `device` declarable on any
 * archetype and rendered by three of them (`DEVICE_SLOT_BASENAMES`), the
 * honest question is whether THIS slide paints THIS figure as a designed
 * element.
 *
 * The candidate pool is what the slide actually renders: a device's own
 * painted figures (`deviceFigures`, emitted by `contentFor` beside the
 * fragment), a stat callout's big numeral, and a comparison card's two
 * sides — all of which are figure devices by construction.
 */
function rendersFigureAsDevice(slide: Slide, figure: string): boolean {
  const wanted = digitsOf(figure);
  if (wanted.length === 0) return false;
  const candidates = [
    ...(slide.fields?.["deviceFigures"] ?? "").split("|"),
    slide.fields?.["figure"] ?? "",
    slide.fields?.["leftLabel"] ?? "",
    slide.fields?.["leftBody"] ?? "",
    slide.fields?.["rightLabel"] ?? "",
    slide.fields?.["rightBody"] ?? "",
  ];
  return candidates.some((candidate) => digitsOf(candidate).includes(wanted));
}

function withNote(rule: StyleRule, note: string): StyleRule {
  return { ...rule, description: `${rule.description} (${note})` };
}

/**
 * The deterministic half of the default render rules, run on the ASSEMBLED
 * slides-data (`07c-emit-slides-data`) — after `resolveLayout` has decided
 * which template each slide really renders through and which slide really
 * has a hero image — and BEFORE `08-render-carousel`, so a failure costs a
 * copy redraft and nothing else (no Chromium render, no vision inspection,
 * no QA model call).
 *
 * Failures are things with a factual answer: is there a hero or a device on
 * slide 1; how many elements does slide N carry; does a slide open with a
 * figure and render as prose. The closer rule is the one that is NOT
 * deterministic in the failing direction: code can prove a CTA is present
 * (a question mark, a lexicon verb) but cannot prove one is absent — "what
 * would you do differently on Monday" is an invitation with no `?` and no
 * lexicon hit — so a miss is handed to the judge as `residue` with a note,
 * never failed. Same posture for a model-authored `custom` archetype on the
 * cover: its markup may well be a figure device, and a template path cannot
 * tell us, so the judge gets the question rather than the writer getting a
 * redraft it may not deserve.
 *
 * Reads only `copy.format`/`copy.caption` from the copy — the text checks
 * run on the fields the slide RENDERS, enumerated per slide by
 * `proseFieldsOf` rather than by a hard-coded field pair. `contentFor` names
 * a cover's prose `title`/`subtitle` and a closer's `takeaway`/`cta`, so a
 * check spelled `fields.headline`/`fields.body` silently skipped both of the
 * slides prompt @14 §7 makes slide 1 and the last slide. A quote card shows
 * neither; a list takeaway shows the headline only; failing a slide for a
 * figure in a body the template never displays would be a defect of the
 * check, not of the slide.
 */
export function checkDefaultRenderRules(slidesData: RenderCarouselInput, copy: InstagramCopyOutput): DefaultRenderRulesResult {
  const failures: DefaultRenderRuleFailure[] = [];
  const residue: StyleRule[] = [];
  const rule = (id: string): StyleRule => DEFAULT_RENDER_RULES.find((r) => r.id === id)!;
  const slides = slidesData.slides;
  if (slides.length === 0) return { failures, residue };

  // default:cover-carries-device — slide 1 needs a photograph or a device.
  //
  // A RENDERED device counts, whatever the archetype. The template basename
  // answers "can this archetype carry the frame on its own"; it cannot answer
  // "did this slide paint a figure device", and `headline_focus` — one of the
  // three archetypes that actually paints one (`DEVICE_SLOT_BASENAMES`, copy
  // @14 §19) — is deliberately absent from `DEVICE_TEMPLATE_BASENAMES`
  // because a bare headline_focus cover IS the defect. Reading the fragment
  // separates the two: a slide-1 headline_focus with `htmlFragments.device`
  // is exactly what `figureRemedyFor` ("move the figure onto the cover or a
  // headline_focus slide") and the interest floor's cover steer ("a device
  // built from the strongest number in this post") tell the writer to
  // produce, and failing it with "no hero image and no figure device" would
  // be a steer the code then refuses — untrue of the assembled slide, and the
  // unenforced-instruction-dressed-as-enforced defect in reverse.
  const cover = slides[0]!;
  const coverBase = templateBasename(cover.template);
  const coverCarriesDevice = (cover.htmlFragments?.["device"] ?? "").trim().length > 0;
  if (!cover.images?.["hero"] && !DEVICE_TEMPLATE_BASENAMES.has(coverBase) && !coverCarriesDevice) {
    if (coverBase.startsWith(CUSTOM_TEMPLATE_PREFIX)) {
      residue.push(withNote(rule("default:cover-carries-device"), "slide 1 is a model-authored custom archetype with no photograph; judge whether its markup carries a figure device"));
    } else {
      failures.push({
        ruleId: "default:cover-carries-device",
        slide: cover.n,
        reason: `slide ${cover.n} renders through "${cover.template}" with no hero image and no figure device — a headline alone on empty ground is not a cover`,
      });
    }
  }

  // default:two-elements-per-slide — counted on what renders, per slide.
  for (const [index, slide] of slides.entries()) {
    const isCover = index === 0;
    const count = countContentElements(slide, isCover);
    if (count < 2 && templateBasename(slide.template).startsWith(CUSTOM_TEMPLATE_PREFIX)) {
      // Same posture as the cover rule: a model-authored custom archetype's
      // markup may reference ANY of the shared fields (`{{kicker}}`,
      // `{{headline}}`, …) alongside its own slots, and the assembled slide
      // only carries the slots `contentFor` spread over the base — so the
      // count here undercounts by construction. The judge sees the render;
      // the writer does not get a redraft it may not deserve.
      residue.push(withNote(rule("default:two-elements-per-slide"), `slide ${slide.n} is a model-authored custom archetype whose field count (${count}) cannot be read from its template path; judge whether the render carries two content elements`));
      continue;
    }
    if (count < 2) {
      const present = proseFieldsOf(slide).map(([key]) => key);
      failures.push({
        ruleId: "default:two-elements-per-slide",
        slide: slide.n,
        reason:
          `slide ${slide.n} ("${templateBasename(slide.template)}") carries ${count} content element(s)` +
          `${present.length > 0 ? ` — ${present.join(", ")}` : ""}` +
          `${isCover && templateBasename(slide.template) === HEADLINE_FOCUS_BASENAME ? "; on the cover a headline_focus statement and its sub-line are one lockup, so it needs its kicker" : ""} — at least two are required`,
      });
    }
  }

  // default:numbers-are-devices — a leading figure has to be SET as a device
  // on the slide that opens with it (item M.4).
  //
  // Read off the fields the slide ACTUALLY RENDERS (`proseFieldsOf`), not a
  // fixed `headline`/`body` pair. `contentFor` emits neither of those names
  // for a `cover` (`eyebrow`/`title`/`subtitle`) or a `closer`
  // (`eyebrow`/`takeaway`/`cta`|`question`) — and prompt @14 §7 puts a cover
  // on slide 1 and a closer last, so the fixed pair left the rule blind on
  // the two slides carrying the post's strongest figure, which §19 says MUST
  // get a device. Under @13 slide 1 was a `photo`/`stat_callout` emitting
  // `headline`/`body` and was covered; the archetypes moved, the rule did
  // not.
  for (const slide of slides) {
    const base = templateBasename(slide.template);
    if (base.startsWith(CUSTOM_TEMPLATE_PREFIX)) continue;
    // A quote card's whole content is a quotation; see
    // `FIGURE_RULE_EXEMPT_FIELDS`.
    if (base === QUOTE_CARD_BASENAME) continue;
    for (const [field, text] of proseFieldsOf(slide)) {
      if (FIGURE_RULE_EXEMPT_FIELDS.has(field)) continue;
      const match = LEADS_WITH_FIGURE.exec(text);
      if (match === null) continue;
      const figure = match[0].trim();
      if (rendersFigureAsDevice(slide, figure)) break;
      failures.push({
        ruleId: "default:numbers-are-devices",
        slide: slide.n,
        reason:
          `slide ${slide.n}'s ${field} opens with the figure "${figure}" but renders as prose through "${slide.template}" — ` +
          figureRemedyFor(slide, base),
      });
      break; // one finding per slide is enough to send it back
    }
  }

  // default:closer-carries-cta — provable when present, never failed when absent.
  const closerText = copy.format === "single" ? copy.caption : proseFieldsOf(slides[slides.length - 1]!).map(([, value]) => value).join(" ");
  const hasCta = QUESTION_MARK.test(closerText) || CTA_LEXICON_LATIN.test(closerText) || CTA_LEXICON_HEBREW.test(closerText);
  if (!hasCta) {
    residue.push(withNote(rule("default:closer-carries-cta"), "no question mark or lexicon CTA found; judge whether the closer invites action"));
  }

  // Phase 3, item R: a slide that chose no picture at all must carry a device.
  const noImage = checkNoImageMeansDevice(slides, copy.slides);
  failures.push(...noImage.failures);
  for (const { note } of noImage.residue) residue.push(withNote(rule(NO_IMAGE_MEANS_DEVICE_RULE.id), note));

  return { failures, residue };
}

/** The `lastSelfCheckReason` body for a failing `07h` — one line per finding, so the next copy draft (and the eventual hold reason) name every slide that sent it back. */
export function formatDefaultRenderRuleFailures(failures: readonly DefaultRenderRuleFailure[]): string {
  return failures.map((f) => `${f.ruleId}${f.slide !== undefined ? ` (slide ${f.slide})` : ""}: ${f.reason}`).join("; ");
}
