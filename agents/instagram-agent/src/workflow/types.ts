import { z } from "zod";
import type { ContentMode, DegradedContextGroundingMarker, TrendCandidate } from "@agent-engine/workflow";
import { SlideDeviceSchema } from "./slide-devices.js";
// Phase 3, item R: the scene brief. A VALUE import, and deliberately from a
// module that imports nothing but zod — see `scene-brief.ts`'s own header for
// why (types.ts <- visual-qa-pre-checks.ts <- scene-brief.ts would otherwise
// be a runtime cycle).
import { VisualNeedFieldSchema } from "./scene-brief.js";
// RFC-19 (Phase 6): the degrade marker a run carries when a QUALITY gate refused the attempt that shipped.
// A TYPE-only import from a module that imports nothing at all, so it cannot create a cycle.
import type { SelfCheckDegradeMarker } from "./self-check-degrade.js";

// ─────────────────────────────────────────────────────────────────────────
// Style config + brand tokens (RFC-03 step 02 — "freeze the small files")
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single content rule from the client's style config. `check` names which
 * half of the pipeline the rule is checkable against — `"copy"` (a text
 * rule, checked deterministically against slide text inside step 07's
 * self-check: banned words/chars, `compliance` framing) or `"render"` (only
 * checkable on the rendered pixels/structured slide output — step 08b's
 * visual QA, see `InstagramVisualQaAgent`).
 *
 * P0 parity-audit fix: this used to be `z.literal("copy")` only, which
 * rejected every real legacy-shaped `02-style-config.json` at intake, since
 * `assets/style-config-template.json`'s own 5 worked examples are 100%
 * `check: "render"` rules (nothing-overlaps, no-empty-closer, figures-are-
 * designed, mono-face-sparingly, real-photo-person-chips — none of them are
 * text rules). A prior version of this comment attributed the original
 * `"copy"`-only narrowing to an invented RFC-03 quote ("you don't need every
 * legacy field, just enough to genuinely validate") that does not appear
 * anywhere in RFC-03 — there was never an RFC instruction to drop `"render"`
 * support. Widening this to `z.enum(["copy", "render"])` is a deliberate
 * fidelity fix to match the real template's rule-type contract, not a
 * response to anything RFC-03 said.
 */
export const StyleRuleSchema = z.object({
  id: z.string().min(1),
  check: z.enum(["copy", "render"]),
  description: z.string().min(1),
});
export type StyleRule = z.infer<typeof StyleRuleSchema>;

/**
 * The canvas block, shaped identically to `publish.renderCarousel`'s own
 * `CanvasSchema` (`@agent-engine/tool-karos-publish`) so step 02's frozen
 * config can be passed straight into the render tool's input at step 08
 * with zero translation — one canvas definition, not two that could drift.
 * `scale` has no default here (unlike the render tool's own schema): a
 * client's style config must say `2` explicitly, on purpose — RFC-03's step
 * 02 is a parse-*and*-validate gate, and silently defaulting a client's own
 * frozen config file to the right value would hide a real client-config bug
 * instead of catching it at intake.
 */
export const StyleConfigCanvasSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  scale: z.number(),
  slides_min: z.number().int().positive(),
  slides_max: z.number().int().positive(),
});
export type StyleConfigCanvas = z.infer<typeof StyleConfigCanvasSchema>;

/**
 * The compliance block (regulated clients only, but present with defaults
 * either way — RFC-03's `compliance: {regulated, required_framing[],
 * never_say[]}`). When `regulated` is true, step 07's self-check requires
 * every `required_framing` phrase to appear somewhere in the post's copy and
 * refuses any `never_say` phrase anywhere in it.
 */
export const StyleComplianceSchema = z.object({
  regulated: z.boolean(),
  required_framing: z.array(z.string()).default([]),
  never_say: z.array(z.string()).default([]),
});
export type StyleCompliance = z.infer<typeof StyleComplianceSchema>;

/**
 * The frozen `02-style-config.json` shape (RFC-03 §1 required-reading list,
 * item 1) — step 02 parses the client's config against this schema and
 * throws `WorkflowBlockedIntake` on any failure (missing file, wrong
 * version, malformed canvas, `scale !== 2`, etc.) rather than ever falling
 * back to defaults silently. This is the "parse-check-or-HALT" gate.
 */
export const StyleConfigSchema = z.object({
  style_config_version: z.number().int().positive(),
  canvas: StyleConfigCanvasSchema,
  rules: z.array(StyleRuleSchema).default([]),
  banned_words: z.array(z.string()).default([]),
  banned_chars: z.array(z.string()).default([]),
  compliance: StyleComplianceSchema,
});
export type StyleConfig = z.infer<typeof StyleConfigSchema>;

/**
 * The brand-tokens half of step 02's "freeze the small files" (RFC-03 §3
 * step 02) — just enough to feed the render step's `templateDir` and to
 * give slide copy a couple of on-brand fields (`accentColor`) without
 * pulling in the full legacy brand-kit file. `templateDir` is repo-relative
 * on purpose: it flows straight into `publish.renderCarousel`'s own
 * `templateDir` input, which `assertInside` (RFC-03 §1 required-reading
 * item 2) refuses to accept as an absolute path.
 *
 * RESOLVED (karoslabs/agent-engine#4): a real, non-`__tests__` default now
 * ships at `agents/instagram-agent/assets/templates/default/slide.html`
 * (`slideTemplate` still defaults to `"slide.html"`, matching it) — a new
 * client's `templateDir` should point there unless/until it has its own.
 * Adapted from karos-agents' legacy `marketing-services` CSS design tokens
 * for visual parity — see that file's own doc comment for exactly what was
 * and wasn't ported.
 */
export const BrandTokensSchema = z.object({
  templateDir: z.string().min(1),
  /** The single shared slide template file (repo-relative to `templateDir`) every slide renders through — RFC-03 §1's "one static renderer/template serves every client" fix #2, never a per-agent-invented template. */
  slideTemplate: z.string().min(1).default("slide.html"),
  accentColor: z.string().min(1).optional(),
  logoPath: z.string().min(1).optional(),
  /**
   * Optional photographic direction, used only by the generative tier
   * (`image.generate`) when retrieval could not fill a slide.
   *
   * All optional, so no existing client config breaks by their absence, and a
   * client without them gets the same neutral brief as before. They exist
   * because a flat "photographic image of X" returns a generic stock-looking
   * frame — the same weakness that made retrieval insufficient — and lighting,
   * aesthetic and palette are what make a generated slide look like it belongs
   * to this client rather than to nobody.
   */
  aesthetic: z.string().min(1).optional(),
  lighting: z.string().min(1).optional(),
  palette: z.array(z.string().min(1)).max(6).optional(),
  visualMood: z.string().min(1).optional(),
  /**
   * Explicit render-token overrides — the hand-authored escape hatch that
   * beats every derivation in `brand-render-tokens.ts`. Role names mirror
   * karos-landing's `BrandColorRolesSchema` (the in-repo precedent for
   * "colors are roles, not a palette list"). Everything optional: most
   * clients get their tokens DERIVED from `client/brand.json` (which the
   * portal already edits), and a required field here would hard-block every
   * existing client at step 02's refuse-to-guess parse.
   */
  renderTokens: z
    .object({
      ground: z.string().min(1).optional(),
      /**
       * A SECOND ground this client's posts may render on, instead of
       * `ground`, chosen once per post.
       *
       * Absent for every client today, and that is the correct default: with
       * no second ground declared, every post renders on `ground` and a
       * carousel can never be part one colour and part another. A client gets
       * alternation only by their own brand record saying which other shade
       * fits — the owner's rule of 2026-09-20, after `karoslabs` (one ground,
       * `#f2f1ec`, one accent) had a quarter of its posts rendered on near
       * black because the engine inverted `ground` against `fg` on its own.
       *
       * Read from the client's documents like every other colour here. Never
       * derived, never defaulted, never inferred from having a dark neutral
       * in the palette — most brands have one and it is not a page ground.
       */
      altGround: z.string().min(1).optional(),
      surface: z.string().min(1).optional(),
      fg: z.string().min(1).optional(),
      fg2: z.string().min(1).optional(),
      line: z.string().min(1).optional(),
      accentInk: z.string().min(1).optional(),
      /**
       * IGSTYLE-1. An override for the brand ACCENT itself — distinct from
       * every other key here, which `deriveBrandRenderTokens` has always
       * read from this object. `brandAccent` is derived only from
       * `client/brand.json` today (`b["accent"]` /
       * `b["colors"]["primaryAccent"]`); this is the field that gives a
       * reviewer's or a learned preference's accent pick somewhere to live
       * without touching that derivation. Added here (not wired into
       * derivation yet) so `StyleOverrides` below can be typed as exactly
       * the seven roles `StyleEditSchema` (`@agent-engine/core`) accepts —
       * IGSTYLE-3 is what makes `deriveBrandRenderTokens` actually honor
       * it; this ticket only defines and threads the shape ("no behaviour
       * change").
       */
      accent: z.string().min(1).optional(),
      fontDisplay: z.string().min(1).optional(),
      fontBody: z.string().min(1).optional(),
      fontMono: z.string().min(1).optional(),
      /** Badge/eyebrow treatment; unset means derived from brand data. See `BadgeStyle`. */
      badgeStyle: z.enum(["pill", "brackets", "underline", "plain"]).optional(),
    })
    .optional(),
  /** A standing series badge ("PITCH SCHOOL | LESSON 15") rendered on every slide when set. */
  seriesBadge: z.string().min(1).max(48).optional(),
});
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

/**
 * IGSTYLE-1. The wire shape Layers 1 (learned) and 2 (this run's directive)
 * of style resolution both speak — deliberately typed as exactly what
 * `client/brand.json`'s hand-authored escape hatch already accepts, so a
 * layer's patch and a human's standing config override are
 * indistinguishable to every downstream consumer
 * (`deriveBrandRenderTokens`, `buildBrandHeadHtml`, `paletteForSlide`,
 * `assembleSlidesData`). `NonNullable` because a "patch" with no keys set is
 * `{}`, never `undefined` — see `mergeStyleOverrides`.
 */
export type StyleOverrides = NonNullable<BrandTokens["renderTokens"]>;

/**
 * Last-wins merge over DEFINED keys only — `undefined` in a later patch
 * never erases a value an earlier patch set, so a caller can pass a
 * partially-filled `StyleEditSchema` object (only the roles a reviewer
 * actually picked) without it clobbering the rest of the merge.
 *
 * Order matters and is the caller's to get right — §2.2's architecture
 * calls this as `mergeStyleOverrides(baseline.renderTokens, learned,
 * directive)`, so Layer 2 (this run's active directive) is always passed
 * LAST and therefore wins any key it sets, exactly as the architecture
 * diagram's "L2 wins" requires.
 */
export function mergeStyleOverrides(...patches: ReadonlyArray<StyleOverrides | undefined>): StyleOverrides {
  const merged: Record<string, string> = {};
  for (const patch of patches) {
    if (patch === undefined) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as StyleOverrides;
}

/** What step 02 hands forward to every later step. */
export interface InstagramFrozenConfig {
  /** Subjects this client does not engage with, frozen from the same read as the style config so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  styleConfig: StyleConfig;
  brandTokens: BrandTokens;
  /**
   * Phase 4 (RFC-16 §1.7 level 1) — the client's standing `instagramConceptMode`,
   * frozen from the SAME config read as `forbiddenTopics` so the concept
   * selector needs no second one. `undefined` for every client in the fleet
   * today, which resolves to `"auto"`.
   */
  conceptMode?: ConceptMode;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 01 — open run / claim post number
// ─────────────────────────────────────────────────────────────────────────

/** What step 01 hands forward. `postId` is the run's own idempotency key (RFC-01 §9.1 rule 2) — stable across resumes of the same `runId`. */
export interface InstagramRunClaim {
  postId: string;
  postNumber: number;
  /** An optional client-supplied steer (lane/subject) for this run — may pick a lane, never relax the topics-catalog lock (RFC-03 §3 step 01's note). */
  requestedLane?: string;
  requestedSubject?: string;
  /**
   * The post format for this run (2026-09): `carousel`, `single`, or `auto`
   * (rotate). From the run input's `requestedFormat` first, then the client's
   * standing `instagramFormat` config; absent means `carousel`, exactly as
   * every run before formats existed.
   */
  requestedFormat?: "carousel" | "single" | "auto";
  /**
   * 2026-09-23: how picture-led this client's carousels are (`imagery-floor.ts`,
   * `PICTURE_BANDS`). From the run input's `pictureDensity` first, then the
   * client's `instagramPictureDensity` config; absent means `standard`, the
   * band every run used before this existed.
   */
  pictureDensity?: "standard" | "photo-first";
  /**
   * 2026-09-23: the client's news mode (stage 3 of the reference-looks plan).
   * From the run input's `requestedMode: "news_flash"` first, then the
   * client's `instagramPostModes` config containing `"news_flash"`. A single
   * post in news mode renders on the `news-frame` cover.
   */
  newsFlash?: boolean;
  /**
   * 2026-09-23: an editorial series the run asked for (`the_list`,
   * `by_the_numbers`, ...), from the run input's `requestedSeries`, then the
   * client's learned preference. Honoured by `04i2` when the catalogue has it.
   */
  requestedSeries?: string;
  /** Which source decided the post type this run, for the trace: the run input, the client config, or the client's learned preference. */
  postTypeSource?: "run-input" | "client-config" | "client-preference" | "industry-default";
}

// ─────────────────────────────────────────────────────────────────────────
// Step 03 — claim topic
// ─────────────────────────────────────────────────────────────────────────

/** Where step 03's subject came from — decides whether there is a dedup reservation to commit at step 09. `trend` (2026-09): the scout's on-brand candidate took the slot. */
/**
 * Where this run's subject came from. `planned` is a row off the strategy map
 * (C1 / C7 §2.6) — added when the loop landed, and deliberately distinct from
 * `reserved` (the topics catalog) and from `research` (the industry seed):
 * only `planned` carries a `strategyRowId` onto the subject row.
 */
export type InstagramTopicSource = "reserved" | "requested" | "trend" | "research" | "planned";

/**
 * Why a scouted story was NOT the one posted about (RFC-13 §E, 2026-09).
 *
 * `outranked-by-request` / `-catalog` / `-trend`: a person's typed subject, a
 * planned catalog row, or a stronger trend took the slot. `lower-rank`: the
 * candidate lost the scoring inside its own group. `off-mode`: it was tagged
 * for a content mode other than the one this run rotated to.
 */
export type TopicAlternativeReason = "lower-rank" | "off-mode" | "outranked-by-request" | "outranked-by-catalog" | "outranked-by-trend";

/**
 * A subject the run considered and did not take, kept so the reviewer at the
 * gate sees what was NOT chosen rather than only what was. `engine` and
 * `score` are filled by Phase 1's topic engines; Phase 0's scout candidates
 * carry `brandFit`/`interest`/`mode` and the deterministic `score`.
 */
export interface TopicAlternative {
  topic: string;
  headline?: string;
  brandFit?: number;
  interest?: number;
  mode?: ContentMode;
  engine?: string;
  score?: number;
  reason: TopicAlternativeReason;
}

/**
 * How the subject was weighed. `plannedScore` is what a catalog row is worth
 * (`PLANNED_ROW_SCORE`), `bestCandidateScore` the strongest scouted story's
 * `brandFit × interest × distance`, and `rule` the one sentence that says
 * which precedence rule decided — so a reviewer can disagree with a rule
 * rather than with a number.
 */
export interface TopicWeighting {
  plannedScore?: number;
  bestCandidateScore?: number;
  rule: string;
}

/**
 * Whether the trend scout actually saw this week's stories. `no-documents`:
 * the research pull answered with nothing to scout; `unavailable`: the
 * scraper was not configured or was down, recorded on the claim instead of
 * holding a run whose subject a person had already planned.
 */
export type TopicScoutStatus = "ran" | "no-documents" | "unavailable";

export interface InstagramTopicClaim {
  /**
   * OPTIONAL, because only a `"reserved"` claim has one.
   *
   * It used to be required, which encoded the assumption that the topics
   * catalog is the sole possible origin of a subject — and that assumption is
   * exactly what made a client with no seeded catalog unable to run this agent
   * at all: `topics.reserve` reported a floor breach, step 03 threw
   * `WorkflowHeld`, and the run ended having produced nothing. `topics.commit`
   * at step 09 is now conditional on this field, matching what `x-agent` has
   * always done with its own `XTopicReservation.reservationKey`.
   */
  reservationKey?: string;
  topic: string;
  source: InstagramTopicSource;
  /** Present when `source === "trend"`: the scouted candidate, with its angle, hook, why-now and brand-fit bridge. */
  trend?: TrendCandidate;
  /**
   * The content mode this run rotated to (`selectContentMode` over the
   * decision log), set by `03g-select-topic`. Optional because step 03's own
   * seed claim predates the selection; every claim past 03g carries it.
   */
  mode?: ContentMode;
  /** The scouted stories this run did not post about, and why — filled by `resolveTopicClaim`. */
  alternatives?: TopicAlternative[];
  /** How the chosen subject was weighed against the alternatives. */
  weighting?: TopicWeighting;
  /** Whether the scout ran, saw nothing, or could not run. */
  scoutStatus?: TopicScoutStatus;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 04 — research (InstagramResearchAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One sourced fact — "every fact that will reach a slide needs a source +
 * date" (RFC-03 §3 step 04) — and, since `instagram-research@2` (RFC-13 §J),
 * a FACT CARD: the same claim plus what kind of thing it is, where exactly it
 * came from, and whether that source is primary.
 *
 * `claim` stays the verbatim key everything downstream traces through
 * (`checkSlidesData` matches every slide's `sourceRef` against it, the angle
 * step's `restsOn` names it, `dedupeFactCards` normalises it) — the new
 * fields are all additive and all read-only steering:
 *
 * - `kind` decides which archetype the claim WANTS (a stat belongs in a
 *   `stat_callout`, a quote in a `quote_card`, an event gets dated) — copy
 *   prompt §17. Defaults to `stat` because that is what the extraction step
 *   returned exclusively before this field existed.
 * - `url` is the traceable source, when the document had one. `source` stays
 *   the human-readable attribution that gets printed ON the slide.
 * - `quote` carries the speaker's own words verbatim for a `kind: "quote"`
 *   card, capped so a whole paragraph cannot ride in as a pull-quote.
 * - `primary` marks the report/study/client document itself rather than an
 *   article restating it. `dedupeFactCards` keeps the primary card when two
 *   say the same thing, and `factCardsForPrompt` shows primaries first.
 */
export const ResearchFactSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  date: z.string().min(1),
  url: z.string().optional(),
  kind: z.enum(["stat", "quote", "event", "definition"]).default("stat"),
  quote: z.string().max(240).optional(),
  primary: z.boolean().default(false),
});
export type ResearchFactKind = z.output<typeof ResearchFactSchema>["kind"];
/**
 * Deliberately the schema's INPUT shape, not its output.
 *
 * `kind` and `primary` carry zod defaults, so anything that came through
 * `ResearchOutputSchema.parse` (every agent output, which is the only path
 * facts reach the workflow by) always has them at runtime. But fact lists are
 * also hand-built — test fixtures, ledger rows written before `@2` — and
 * those legitimately omit both. Typing the export as the input shape keeps
 * them valid and forces every consumer to handle a missing `kind` the way
 * `fact-cards.ts` does (as `"stat"`) instead of trusting a default it may not
 * have been parsed through.
 */
export type ResearchFact = z.input<typeof ResearchFactSchema>;

/**
 * `InstagramResearchAgent`'s output. `rawPayloadRef` is the `research.pull`
 * run id whose raw payload was captured verbatim (by `research.pull` itself,
 * before this agent ever sees it) — RFC-03 §1's "verbatim raw payload
 * capture" requirement is satisfied by `research.pull`'s own design, not
 * reimplemented here; this field just carries the pointer forward so step
 * 07's self-check and step 09's ledger record can trace every fact back to it.
 */
export const ResearchOutputSchema = z.object({
  topic: z.string().min(1),
  /**
   * `.max(30)` since `@2` (RFC-13 §J): the prompt asks for 12-24 cards, and
   * the ceiling is what keeps a model that decided to list every sentence in
   * every document from turning one step's output into the copy prompt's
   * whole context. `dedupeFactCards` then caps the SHIPPED set at 24.
   */
  facts: z.array(ResearchFactSchema).min(1).max(30),
  rawPayloadRef: z.string().min(1),
});
/** The input shape, for the same reason `ResearchFact` is — see its comment. */
export type ResearchOutput = z.input<typeof ResearchOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 05 — write copy (InstagramCopyAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's copy — "one idea each" (RFC-03 §3 step 05). `visualNeed` is
 * what step 06 vets a picture against — since Phase 3 item R it is a scene
 * brief rather than a keyword string, defined and read in `scene-brief.ts`;
 * `sourceRef` must name one of step
 * 04's `facts[].claim` values verbatim, which is exactly what step 07's
 * self-check verifies ("every claim traces to a source").
 */
/**
 * Which archetype `assembleSlidesData` renders this slide as.
 *
 * Ported from the legacy `karos-agents` archetype set (2026-08) — see
 * `assets/templates/default/` for one HTML template per value, and
 * `references/legacy-archetype-port.md` for what was and wasn't carried over
 * from the legacy design system.
 *
 * Not every slide wants a photograph, which is the whole point: a bare
 * percentage reads better as 300px type on a solid ground than as a caption
 * over a stock desk, and a direct quote wants quotation styling rather than a
 * scrim. Before this set existed every slide demanded a photo, so a carousel
 * had one visual rhythm and every slide competed for the same stock imagery.
 *
 * Two values are special:
 *
 * - `"photo"` is the default, so any caller predating this field is unchanged.
 * - `"text_only"` is the guaranteed-delivery floor: the workflow reassigns a
 *   slide here when every image tier and the rights gate leave it with no
 *   usable picture (see `ImageSelectionSchema`). It is no longer what every
 *   other archetype degrades to, though — Phase 2, item M: a slide whose
 *   requested archetype cannot be satisfied now degrades through
 *   `fallbackArchetypeFor` to the best archetype its CONTENT can fill, and
 *   only reaches `text_only` when it truly has nothing but a headline and a
 *   body (or when the client's own `templateDir` holds nothing else). Every
 *   degrade path used to converge here, which is how a lost photograph
 *   turned into the mostly-grey slide the owner named as the defect.
 *
 * `"cover"` and `"closer"` (Phase 2, item M) are the two POSITIONAL
 * archetypes: slide 1 is the grid thumbnail, the last slide is the save
 * moment. They inherit `resolveLayout`'s once-per-carousel rule for free,
 * which is correct by nature — a carousel has one cover and one close.
 */
export const InstagramSlideLayoutSchema = z.enum([
  "photo",
  "text_only",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
  "headline_focus",
  "cover",
  "closer",
  "custom",
]);
export type InstagramSlideLayout = z.infer<typeof InstagramSlideLayoutSchema>;

/**
 * ══ PHASE 5.5, BRIEF ITEM B: EVERY STRING IN THE COPY CONTRACT IS BOUNDED ══
 *
 * Read this once and the `.max()` on every field below stops looking arbitrary.
 *
 * ## Why they exist at all
 *
 * `05-write-copy` inherited `DEFAULT_MAX_TOKENS = 16384` because it declared no
 * ceiling, and on 2026-09-16 five of six attempts across three prep runs died
 * at it for $0 (`messages-api-adapter.ts`'s `max_tokens` branch). The ceiling
 * is raised to `COPY_MAX_TOKENS` in `instagram-copy-agent.ts`, and that alone
 * would be a fix that cannot be regression-tested: until this block, the
 * schema's MAXIMUM SERIALISED OUTPUT WAS INFINITE. `headline` and `body` were
 * `z.string().min(1)` with no upper bound, as were `sourceRef`, `caption`, and
 * every string on the four archetype content blocks. There was no number to
 * assert against a ceiling, so `__tests__/copy-schema-length.test.ts` — the
 * guard that fails CI when a future field pushes the maximal draft past the
 * ceiling — was literally unwritable. The bounds and the test ship together.
 *
 * ## How each number was chosen, and the rule that generated it
 *
 * **A schema max on a model output is a coin flip that loses the whole draft**
 * (the `altText` `max(125)` defect cost two of three live runs their hashtags
 * on the same day). So no bound here is a design preference about length. Each
 * one clears BOTH of two floors, and the second one is the load-bearing half:
 *
 *   1. **At least 1.5x the longest value the field has ever carried**, measured
 *      over the six prep runs of 2026-09-16 (8 completed drafts, 61 slides).
 *   2. **At least 2x the gate that already governs it.**
 *      `slide-word-budget.ts` holds a slide's `headline` plus `body` to
 *      `MAX_WORDS_PER_SLIDE = 30` and one structured block — a list row, a
 *      comparison column — to `MAX_WORDS_PER_BLOCK = 20`. At the ~7 characters
 *      a word this agent's two languages average, that is ~210 characters a
 *      slide and ~140 a block. The gate RETURNS a draft with a finding and
 *      costs the run nothing; the schema kills it. So the schema must never be
 *      the thing that fires first, on any field, ever.
 *
 * | field | longest seen | gate equivalent | bound |
 * |---|---|---|---|
 * | `headline` + `body` | 109 + 269 | ~210 | 200 + 600 |
 * | `sourceRef` | 194 | exempt (a citation) | 300 |
 * | `caption` | 1,516 | none | 2,200, Instagram's own limit |
 * | `stat.subLabel` | 93 | ~210 with the headline | 200 |
 * | `stat.source` | 52 | exempt (a citation) | 120 |
 * | `quote.text` | 79 | ~210 | 300 |
 * | `quote.attribution` | 45 | exempt | 120 |
 * | `comparison.*Label` + `*Body` | 20 + 127 | ~140 a column | 60 + 220 |
 * | `items[].title` + `.note` | 66 + 134 | ~140 a row | 140 + 210 |
 *
 * `kicker` (38 seen, 48 bound) and `SlideEmphasisSchema`'s spans (32 seen, 48
 * bound) were already bounded and are unchanged.
 *
 * ## The headroom this leaves, and why it is not larger
 *
 * `__tests__/copy-schema-length.test.ts` measures the maximal draft these
 * bounds permit at ~16,100 output tokens against the 19,200 it is allowed
 * (60% of `COPY_MAX_TOKENS`). The spare 16% is deliberate and it is SMALL:
 * `scene-brief.ts` is about to gain a `subject` block in the same phase, worth
 * roughly 700 tokens of it. A bound loosened here is spent out of that margin,
 * and the test says so by failing.
 */

/**
 * `stat_callout`'s content. `figure` carries its own unit or symbol ("73%",
 * "4.2x", "$1.8B") exactly as the legacy contract did — a separate unit field
 * invites "4.2" + "x" being typeset apart, and the figure's own string length
 * is what picks its type size.
 *
 * `source` is required, not optional: the legacy system's rule was "every
 * figure names its source on the slide", and a big unattributed number is
 * precisely the shape of a claim a reader should distrust. Its bound is the
 * same 120 `slide-devices.ts` gives a device's `source`, because it is the same
 * kind of string doing the same job on the same plate.
 */
export const SlideStatSchema = z.object({
  figure: z.string().min(1).max(12),
  subLabel: z.string().min(1).max(200),
  source: z.string().min(1).max(120),
});

/**
 * `quote_card`'s content — the pull-quote and who said it.
 *
 * `text` gets the loosest ratio in the table (3.8x the longest ever seen)
 * deliberately: a pull quote is the one field whose length is not the writer's
 * to choose, since §27 of the copy prompt forbids paraphrasing a source's
 * prose. A quote that has to be cut to fit a schema is a quote that gets
 * silently reworded instead.
 */
export const SlideQuoteSchema = z.object({
  text: z.string().min(1).max(300),
  attribution: z.string().min(1).max(120),
});

/** `comparison_card`'s content — two sides, each a short label plus a line of detail. */
export const SlideComparisonSchema = z.object({
  leftLabel: z.string().min(1).max(60),
  leftBody: z.string().min(1).max(220),
  rightLabel: z.string().min(1).max(60),
  rightBody: z.string().min(1).max(220),
});

/**
 * `list_takeaway`'s content. Two to four rows: the legacy `meaning` layout
 * pins its rows at a fixed offset in a 1440px column with 46px padding each,
 * so five would overflow the canvas rather than shrink to fit.
 */
export const SlideListSchema = z
  .array(z.object({ title: z.string().min(1).max(140), note: z.string().min(1).max(210).optional() }))
  .min(2)
  .max(4);

/**
 * `custom`'s content — a model-authored typographic archetype for the rare
 * case none of the six standard ones fit. Not a full HTML document:
 * `bodyHtml` is a markup FRAGMENT (goes inside the shared shell's `<body>`,
 * built by `buildCustomArchetypeDocument`) and `css` is rules only (spliced
 * in separately, by `composeDocument`, the same way any registry template's
 * `cssStyles` already is) — never a `<script>`/`<style>` tag of its own.
 *
 * `archetypeId` must start with `custom_`: its file lands in the same
 * per-run directory the five real structured archetypes' files do, and this
 * prefix is what keeps it from ever colliding with one of them (checked
 * again, at runtime, in `create-instagram-agent-workflow.ts` — a schema
 * regex is one edit away from being loosened later).
 *
 * `slots`/`fields` follow the renderer's own escaped-substitution
 * convention: every `{{key}}` `bodyHtml` uses must be a declared slot (or
 * the always-available `kicker`/`dir`), and every value in `fields` is
 * substituted as escaped text — there is no raw/`{{html:...}}` form for
 * model-authored content, deliberately, since that split is what keeps a
 * copy field from being an injection point (see `assertSafeMarkup`).
 */
/**
 * How many `{{key}}` slots one authored archetype may declare, and therefore
 * how many entries `fields` may carry. One number, referenced by both, because
 * the contract is that they are the same set: every declared slot has a value
 * and every value fills a declared slot.
 */
export const MAX_CUSTOM_ARCHETYPE_SLOTS = 8;

/**
 * The identifier shape, shared by the brief that names an archetype and the
 * markup that fills it.
 *
 * `.max(47)` is `"custom_"` plus the regex's own 40, so it refuses nothing the
 * regex accepts. It is there because a bound a machine can read is worth
 * having: `__tests__/copy-schema-length.test.ts` walks this schema and refuses
 * any string whose maximum it cannot determine, and a length implied by a
 * regex is a length no walker can determine.
 */
const CustomArchetypeIdSchema = z
  .string()
  .max(47)
  .regex(/^custom_[a-z0-9_]{3,40}$/, "must start with 'custom_' and contain only lowercase letters, digits, and underscores");

/** A `{{key}}` slot name. Alphanumeric plus underscore, because it is interpolated into markup by exact match. */
const CustomArchetypeSlotSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9_]+$/);

export const SlideCustomArchetypeSchema = z.object({
  archetypeId: CustomArchetypeIdSchema,
  name: z.string().min(1).max(60),
  /** One sentence: why none of the six standard archetypes fit this slide. */
  rationale: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(4000),
  css: z.string().max(4000).default(""),
  slots: z.array(CustomArchetypeSlotSchema).min(1).max(MAX_CUSTOM_ARCHETYPE_SLOTS),
  /**
   * The value for every declared slot.
   *
   * `2000` a value and NO CAP AT ALL on the number of entries was the single
   * largest term in the copy schema's maximum: 8 slots' worth of markup plus an
   * unbounded record of 2,000-character values, on every one of eight slides.
   * A value is now bounded by the same 600 `body` gets — it IS a body, set in a
   * shape the writer designed — and the record carries at most as many entries
   * as there are slots.
   */
  fields: z
    .record(CustomArchetypeSlotSchema, z.string().max(600))
    .refine((f) => Object.keys(f).length <= MAX_CUSTOM_ARCHETYPE_SLOTS, {
      message: `at most ${MAX_CUSTOM_ARCHETYPE_SLOTS} fields, one per declared slot`,
    }),
});
export type SlideCustomArchetype = z.infer<typeof SlideCustomArchetypeSchema>;

/**
 * ══ PHASE 5.5 ITEM B3: THE MARKUP IS HOISTED OUT OF THE COPY STEP ══
 *
 * `customArchetype` was up to 4,000 (`bodyHtml`) + 4,000 (`css`) + an unbounded
 * record of 2,000-character values, authored INSIDE the draft, on a step whose
 * output ceiling five of six attempts hit on 2026-09-16. It was also the wrong
 * thing to be there: it is markup rather than copy, the writer authors it at
 * most once or twice per carousel, and a markup mistake failed the whole draft
 * rather than the one slide it belonged to.
 *
 * So the copy step now emits a BRIEF — which archetype, called what, why, and
 * which slots it needs, about sixty output tokens — and
 * `05f-author-custom-archetype` (`InstagramCustomArchetypeAgent`) authors the
 * markup against it in its own bounded step. A failure there degrades THAT
 * SLIDE through `assembleSlidesData`'s existing ladder, at the cost of one
 * $0.030 call rather than a $0.35 draft.
 *
 * The identity of the archetype stays with the WRITER, deliberately: the markup
 * step receives `archetypeId`, `name` and `rationale` and does not re-emit
 * them, so it cannot quietly rename or re-justify a design the writer chose.
 * `composeCustomArchetype` is the only way the two halves are joined.
 */
export const SlideCustomArchetypeBriefSchema = z.object({
  archetypeId: CustomArchetypeIdSchema,
  name: z.string().min(1).max(60),
  /** One sentence naming the SHAPE none of the standard archetypes can make. */
  rationale: z.string().min(1).max(300),
  /**
   * The `{{key}}` names this design needs, in reading order.
   *
   * The writer declares them because the writer knows what the slide has to
   * say; `05f` must use exactly this set, which is what keeps a design that
   * reads only standard field names (and is therefore promotable to a stored
   * template) a decision the writer can make.
   */
  slots: z.array(CustomArchetypeSlotSchema).min(1).max(MAX_CUSTOM_ARCHETYPE_SLOTS),
});
export type SlideCustomArchetypeBrief = z.infer<typeof SlideCustomArchetypeBriefSchema>;

/** `InstagramCustomArchetypeAgent`'s output — the markup half only. See `SlideCustomArchetypeBriefSchema`. */
export const CustomArchetypeMarkupSchema = SlideCustomArchetypeSchema.pick({
  bodyHtml: true,
  css: true,
  slots: true,
  fields: true,
});
export type CustomArchetypeMarkup = z.infer<typeof CustomArchetypeMarkupSchema>;

/**
 * Join the writer's brief to the markup step's output.
 *
 * The ONE place the two halves meet, so there is one place to read when asking
 * what a stored custom archetype is made of. `slots` comes from the MARKUP,
 * not the brief: `05f` may legitimately drop a slot it found it did not need,
 * and `assertSafeMarkup` plus `custom-archetype-checks.ts` validate `bodyHtml`
 * against the slots it actually declares. A slot the markup added that the
 * brief never asked for is still checked there, not here.
 */
export function composeCustomArchetype(brief: SlideCustomArchetypeBrief, markup: CustomArchetypeMarkup): SlideCustomArchetype {
  return {
    archetypeId: brief.archetypeId,
    name: brief.name,
    rationale: brief.rationale,
    bodyHtml: markup.bodyHtml,
    css: markup.css,
    slots: markup.slots,
    fields: markup.fields,
  };
}

/**
 * The copy fields a mark may be aimed at — the COPY's OWN field names, never
 * a template slot.
 *
 * That distinction is load-bearing (RFC-17 §5.1). The model wrote `headline`
 * and `body`; it does not know that `contentFor` routes `headline` to `title`
 * on a cover and to `takeaway` on a closer, or that a `photo` slide that lost
 * its picture becomes `text_only`. Keeping the contract on the copy's fields
 * puts that mapping in exactly one place, and a layout downgrade keeps the
 * marks working instead of aiming them at a slot that no longer exists.
 */
export const EMPHASIS_FIELDS = ["headline", "body", "quote", "item"] as const;

/**
 * RFC-17 - which words on a slide carry a MARK.
 *
 * The owner's reference accounts mark emphasis per word, in rotating colours
 * and mixed kinds, and that is what makes their type read as considered
 * rather than generated. This is the only new field the whole phase adds to
 * the copy contract, and it is optional, so every existing gate, dedupe
 * corpus, language judge and hygiene check keeps reading exactly the string
 * it reads today.
 *
 * **A flat array of VERBATIM SPANS, and nothing else**: `["Runway", "nobody
 * noticed"]`. No field name, no row index, no tag. `resolveSlideMarks` finds
 * each span by bounded exact match, and `slides-data.ts` walks the slide's
 * fields in reading order (headline, body, quote, then list rows) consuming
 * each span at the FIRST place it has not already been marked.
 *
 * **Verbatim text, never offsets.** `isolateForeignRuns` inserts two
 * `\p{Cf}` characters per Latin run into every rendered RTL field, and the
 * Phase 4 native editor rewrites copy after drafting, so any character
 * offset authored against the model's own string is wrong by the time the
 * field reaches the document. A span that no longer occurs is DROPPED and
 * reported, never resolved to the wrong words.
 *
 * == WHY THERE IS NO `field`, NO TAG AND NO UNION (RFC-17 6.4) ============
 *
 * This schema carried `{field, itemIndex?, text}` until the design system
 * phase, and a tagged string form (`"h:Anti-AI"`, `"i1:runway"`) was written
 * and then REFUSED. Both are recorded here because this is exactly where the
 * next reader will propose bringing one back, and the reasons are
 * CORRECTNESS reasons rather than the cost saving:
 *
 * 1. **A field the model can name is a field it can get WRONG, and the
 *    failure is SILENT.** `{"field":"body","text":"Runway"}` when `Runway`
 *    sits in `item[2]` resolves to nothing: the mark is simply absent, and no
 *    gate fires, because marks are furniture and furniture never holds a run.
 *    That is the worst failure mode this mechanism can have. A search cannot
 *    name the wrong field. **The tag form is the same defect at a lower
 *    price**, which is why being cheaper did not save it.
 * 2. **A tag needs an escape rule.** `"h:Comment "AI": why"` has no
 *    unambiguous parse, and adding an escape costs the tokens the tag saved.
 * 3. **A Latin tag in front of a Hebrew span is new bidi surface** on every
 *    single RTL mark, which is precisely the hazard Phase 4's
 *    `isolateForeignRuns` and the foreign-run boundary rule in
 *    `resolveSlideMarks` were built to contain. A bare span adds none.
 * 4. **A UNION OF TWO WIRE FORMATS ENFORCES NEITHER.** The refused design was
 *    `z.array(z.union([CompactEmphasisSchema, StructuredEmphasisSchema]))`,
 *    which keeps the `itemIndex` silent drop alive beside a second format the
 *    model will also emit. That is not a migration path: it is the original
 *    defect retained, plus a new one. One shape, or the contract is not a
 *    contract.
 *
 * The cost fell too, `copyAttempt` 0.184 to 0.181, which is what keeps a cold
 * Hebrew run at three drafting attempts. That is the fourth reason, not the
 * first.
 *
 * **`.max(8)` here, `MAX_MARKS_PER_SLIDE = 5` in `emphasis-marks.ts`.** The
 * gap is deliberate and follows the philosophy already written into this
 * schema's siblings: FURNITURE MUST NEVER BE ABLE TO REJECT A DRAFT. A hard
 * `.max(5)` would fail an entire $0.181 copy attempt over a sixth mark. A
 * ninth mark degrades: the extras are dropped in code, where a drop is free.
 * `MAX_MARK_CHARS` is looser than the six-word cap for the same reason.
 *
 * The model chooses WHICH WORDS. It never chooses the colour, the weight, or
 * how the mark is drawn: it cannot see the ground, and `rf-6/slide-01`, a
 * near-black plate whose emphasis is a gradient in the glyphs with no swatch
 * anywhere, proves the ground is what decides.
 */

/** The longest span a mark may carry, in characters. The six-word cap in `emphasis-marks.ts` is the tighter of the two. */
export const MAX_MARK_CHARS = 48;

export const SlideEmphasisSchema = z.array(z.string().min(2).max(MAX_MARK_CHARS)).max(8);
export type SlideEmphasis = z.infer<typeof SlideEmphasisSchema>;

export const InstagramSlideCopySchema = z.object({
  n: z.number().int().positive(),
  headline: z.string().min(1).max(200),
  body: z.string().min(1).max(600),
  /**
   * Phase 3, item R: a scene brief, not twelve words.
   *
   * The union keeps the legacy bare string parsing — every in-flight
   * checkpoint, every existing fixture and a model that regresses to a
   * sentence — while the object form carries what each consumer actually
   * needs: `scene` for generation, `why` for the vet's claim judgment,
   * `searchTerms` for the keyword index, and `source` for the decision to
   * skip image sourcing altogether. The shape and the one reader every
   * consumer goes through (`normaliseVisualNeed`) live in `scene-brief.ts`.
   */
  visualNeed: VisualNeedFieldSchema,
  /** A `facts[].claim` copied verbatim, which step 07 traces back character for character — so the bound is 2.1x the longest claim any of the six 2026-09-16 runs put here (194). */
  sourceRef: z.string().min(1).max(300),
  layout: InstagramSlideLayoutSchema.default("photo"),
  /**
   * The archetype-specific content, all optional.
   *
   * Optional rather than a discriminated union on `layout`, deliberately: the
   * model picks the layout AND fills the matching block, and those are two
   * chances to be inconsistent. A union turns any mismatch into a whole-output
   * schema rejection, which costs the entire draft (and, at the retry cap, the
   * run). Keeping them optional means a `stat_callout` that arrives without a
   * `stat` degrades to `text_only` on its own headline and body — which every
   * slide always has — and the carousel still ships.
   *
   * `assembleSlidesData` is where that degradation is decided; nothing here
   * assumes the model got it right.
   */
  stat: SlideStatSchema.optional(),
  quote: SlideQuoteSchema.optional(),
  comparison: SlideComparisonSchema.optional(),
  items: SlideListSchema.optional(),
  /**
   * The AUTHORED markup for a `layout: "custom"` slide.
   *
   * Still here, still optional, still read by everything downstream
   * (`assembleSlidesData`, `custom-archetype-memory.ts`, the promotion path) —
   * but since Phase 5.5 the COPY STEP no longer writes it. `05f` does, through
   * `composeCustomArchetype`, which is why `InstagramCopyDraftSchema` below
   * omits this one key. See `SlideCustomArchetypeBriefSchema` for the why.
   */
  customArchetype: SlideCustomArchetypeSchema.optional(),
  /** What the writer wants `05f-author-custom-archetype` to build, when a slide's shape needs a layout none of the standard archetypes has. */
  customArchetypeBrief: SlideCustomArchetypeBriefSchema.optional(),
  /**
   * An object this slide's archetype asks for that the fact cards genuinely
   * cannot fill — named HERE, and never in `headline` or `body`.
   *
   * On 2026-09-16 geektime's slide 4 shipped the sentence *"לא נמצא ציטוט
   * משתתף ישיר בחומרים; השקף נושא את הטענה בכותרת ובגוף"* to the reader. The
   * model was not hallucinating: `editorial-series.ts` told the writer, in the
   * block handed to it, to *"say so in that slide's content"*. A writer obeying
   * an instruction is a fixed instruction, not a fixed model, and an
   * instruction that has no field to write into will always write into the
   * prose. This is that field.
   *
   * Optional and never gating: a slide that filled its archetype omits it, and
   * a run whose series step never fired reads exactly as it did. What reads it
   * is `07a`'s degrade path (the slide gets a designed object plate and a
   * `degradeMarker` on the gate payload) and `craft-hygiene.ts`'s work-note
   * clause, which returns a draft that narrated the gap in prose instead.
   *
   * 160 characters: one sentence naming one missing object, and short enough
   * that it is obviously not somewhere to move the slide's copy to.
   */
  unfillable: z.string().min(1).max(160).optional(),
  /** A short mono eyebrow above a `headline_focus` statement. Optional on every archetype. */
  kicker: z.string().min(1).max(48).optional(),
  /**
   * Phase 2, item M — a number device, available on EVERY archetype rather
   * than only on the two that happen to be built around a figure.
   *
   * This is what removes `default:numbers-are-devices`'s old apology ("only
   * one of each exists per carousel, so every other numeric fact leads with
   * the noun"): `resolveLayout` allows each structured archetype once per
   * carousel, so before this field a second or third figure in a post had
   * nowhere designed to go and was set as prose. A device is typed DATA the
   * copy model authors; `slide-devices.ts` — first-party code — authors the
   * markup, because `{{html:}}` substitution is unescaped and a copy field
   * must never be able to reach it.
   */
  device: SlideDeviceSchema.optional(),
  /**
   * RFC-17 (Phase 5) — which words on this slide carry a mark. See
   * `SlideEmphasisSchema` for the whole contract.
   *
   * Optional, and dropped silently when absent: a draft with no `emphasis`
   * renders exactly as it does today. Nothing downstream of this field can
   * hold or fail a run.
   */
  emphasis: SlideEmphasisSchema.optional(),
});
export type InstagramSlideCopy = z.infer<typeof InstagramSlideCopySchema>;

/**
 * The two shapes an Instagram post takes (2026-09).
 *
 * `carousel` is the 6-8 slide format every run produced until now. `single`
 * is one designed image and a DEEP caption: the caption carries the argument
 * the slides used to, in short lines, and the one slide is the hook. The
 * workflow decides the format (a run request, the client's `instagramFormat`
 * setting, or an `auto` rotation) and hands it to the copy step, which echoes
 * it back; `checkSlidesData` holds the slide count to it.
 */
export const INSTAGRAM_FORMATS = ["carousel", "single"] as const;
export const InstagramFormatSchema = z.enum(INSTAGRAM_FORMATS);
export type InstagramFormat = z.infer<typeof InstagramFormatSchema>;

/**
 * Phase 5 (RFC-18 §3.7) — WHAT the post gives a reader, declared by the
 * writer.
 *
 * The 2026-09-08 audit's charge had two halves. Phase 0 answered "is this
 * relevant to what the client does?"; this enum is part of the answer to
 * "will anyone save this?". A reader keeps a glossary, a ranking or a
 * comparison; they do not keep six true sentences. Declaring the payload up
 * front gives the carousel a STRUCTURAL REASON for its slide count — the
 * count is whatever the declared structure needs — instead of "N slides
 * because N was configured", and it is the first editorial input that has
 * ever existed anywhere near the format decision.
 *
 * Eight output tokens on the copy step (priced in `STEP_COST_ESTIMATES_USD.
 * copyAttempt`'s @16 → @17 note as ≈ +$0.00015 an attempt). Deliberately NOT
 * a per-slide `soWhat` field, which RFC-18 §3.2 declines at ≈ +250 output
 * tokens on every attempt for text nothing renders.
 *
 * `single-claim` is the DEFAULT so no existing fixture, no in-flight
 * checkpoint and no stored copy output breaks: a draft written before this
 * field existed parses unchanged and reads as the kind it actually was.
 * `07i-value-signals`' `payloadShape` check is what holds a carousel to a
 * kind its structure can actually carry.
 */
export const INSTAGRAM_PAYLOAD_KINDS = [
  "glossary",
  "ranking",
  "comparison",
  "checklist",
  "timeline",
  "myth-vs-fact",
  "walkthrough",
  "single-claim",
] as const;
export const InstagramPayloadKindSchema = z.enum(INSTAGRAM_PAYLOAD_KINDS);
export type InstagramPayloadKind = z.infer<typeof InstagramPayloadKindSchema>;

/**
 * THERE IS NO DEFAULT, and that is the decision rather than an omission.
 *
 * RFC-18 §3.7 asked for `.default("single-claim")`, and an earlier cut of this
 * file shipped both that constant and a `payloadKindOf()` reader for it. Both
 * were dead — every consumer passed the raw field — and reviving them would
 * have been worse than deleting them, because a defaulted read makes
 * `checkPayloadShape`'s `single-claim` rule fire on any carousel that merely
 * FAILED TO DECLARE: "a carousel is a structure; single-claim belongs to the
 * single-image format". A resumed checkpoint written before this field existed,
 * and every fixture that predates it, would be refused for a rule nobody wrote
 * about them.
 *
 * So absent means NO OPINION, `checkPayloadShape` returns `{ ok: true }` for it
 * (`value-signals.ts`), and the declaration is bought from the writer by the
 * prompt rather than by a default here. The residual gap is real and named in
 * the PR: a live writer that omits the field escapes the shape check, and
 * closing that properly means requiring the declaration of a live draft without
 * refusing the fixtures that predate it.
 */

/**
 * The four hook shapes the copy guide teaches (§29), as a closed set.
 *
 * A closed set rather than free text because the whole point of the field is
 * that Phase 6 can GROUP by it: "contrarian hooks send 1.8x what number
 * hooks do on this account" is a sentence you can only write if the hooks
 * were labelled the same way every week. A string field would be labelled
 * four different ways by four runs.
 */
export const InstagramHookPatternSchema = z.enum(["number_outcome", "contrarian", "mistake", "relatable_pov"]);
export type InstagramHookPattern = z.infer<typeof InstagramHookPatternSchema>;

/** `InstagramCopyAgent`'s output — six to eight slides for a carousel (RFC-03 §3 step 05), exactly one for a single-image post; `checkSlidesData` enforces the count per format. */
export const InstagramCopyOutputSchema = z.object({
  /** The format this copy was written for. Defaults to `carousel` so every existing caller and fixture keeps its shape. */
  format: InstagramFormatSchema.default("carousel"),
  /**
   * Phase 5 (RFC-18 §3.7) — the structure this post's slides ARE, declared by
   * the writer and checked for nothing but consistency at `07i`.
   *
   * ## `.optional()`, not `.default("single-claim")`, and the difference matters
   *
   * RFC-18 §3.7 asks for `.default("single-claim")` and states the goal in the
   * same sentence: *"so no existing fixture or in-flight checkpoint breaks"*.
   * A `.default()` delivers half of that and breaks the other half. Zod's
   * OUTPUT type for a defaulted key is REQUIRED — `z.infer` strips the
   * `undefined` — so while a stored draft written before this field existed
   * still parses, every object literal annotated `: InstagramCopyOutput`
   * stops compiling: `test-helpers.ts`'s `goodCopyOutput()`,
   * `bidi-isolation.test.ts`'s `hebrewCopy()` and
   * `language-compliance-gate.test.ts`'s `hebrewCopy()` are three such
   * literals in files this package does not own, and a fixture that no longer
   * compiles is a fixture break by any reading.
   *
   * `.optional()` delivers the whole goal: absent parses and absent compiles.
   * The one thing `.default()` would have bought — a defaulted READ — is NOT
   * bought anywhere, deliberately: see the block above this schema. Every
   * consumer passes this field raw, and `checkPayloadShape` treats an absent
   * declaration as "no opinion" rather than as `single-claim`.
   */
  payloadKind: InstagramPayloadKindSchema.optional(),
  /**
   * Phase 5.6 (item B2) — which of §29's four shapes this post's hook IS,
   * declared by the writer.
   *
   * ## Why the performance work needs it
   *
   * Phase 6 re-ranks hooks by sends-per-reach on this client's own posts. It
   * cannot do that without a key to rank BY, and deriving one after the fact
   * from the hook's text is exactly the kind of retro-classification that
   * produces a tidy chart from nothing. The label has to be written at the
   * same time as the hook, by whoever chose the shape.
   *
   * ## `.optional()`, for the reason `payloadKind` above is optional
   *
   * Not because the field is optional to a writer — the prompt requires it,
   * and `checkCraftHygiene` sends a draft back that omits it. Optional on the
   * WIRE, so that a model which forgets one enum value does not lose the
   * whole step's structured output and take the caption, the slides and the
   * sourcing down with it. That failure has happened here before, over five
   * characters of alt text, and the fix was the same shape: let the model
   * overshoot, then have code insist.
   *
   * An absent value is recorded as absent. Nothing infers one.
   */
  hookPattern: InstagramHookPatternSchema.optional(),

  slides: z.array(InstagramSlideCopySchema).min(1).max(8),
  /**
   * The post's own caption — the text Instagram shows below the carousel,
   * separate from anything baked into the slide images themselves.
   *
   * Every slide always had `headline`/`body`, and until 2026-08 that was
   * mistaken for "the post has text": a reviewer approving in the portal saw
   * either nothing (the gate payload carried no caption at all) or a raw dump
   * of every slide's field values including `accentColor`'s hex code — never
   * a real caption a human wrote to accompany the images. Required, because
   * an Instagram carousel with no caption is exactly the defect this field
   * exists to close.
   *
   * `2200` is not a house number: it is Instagram's own caption limit, so a
   * caption over it could not be published whatever this schema said. The
   * longest caption any of the six 2026-09-16 prep runs wrote was 1,516
   * characters, which is the same ~1.5x margin every other bound in this file
   * carries, arrived at from the other direction.
   */
  caption: z.string().min(1).max(2200),
});
export type InstagramCopyOutput = z.infer<typeof InstagramCopyOutputSchema>;

/**
 * ══ WHAT `05-write-copy` ITSELF MAY EMIT ══
 *
 * `InstagramCopyOutputSchema` minus the one key the copy step no longer writes.
 *
 * Two schemas rather than one, and the difference is the whole of item B3.
 * `InstagramCopyOutput` is the shape the REST OF THE WORKFLOW carries, and it
 * keeps `customArchetype` because `05f-author-custom-archetype` writes it back
 * onto the slide before anything renders. `InstagramCopyDraft` is the shape the
 * MODEL is asked for, and it cannot contain markup at all — which is what makes
 * the maximal serialised draft a finite number that
 * `__tests__/copy-schema-length.test.ts` can hold against `COPY_MAX_TOKENS`.
 *
 * A draft is assignable to `InstagramCopyOutput` by construction (an omitted
 * optional key), so nothing downstream needed a change or a cast.
 *
 * `.omit()` STRIPS rather than refuses: a model that emits `customArchetype`
 * anyway loses the key and keeps its draft. That is the same fail-open
 * reasoning `SlideEmphasisSchema` states at length — furniture must never be
 * able to reject a draft — and here it also means the migration cannot fail: a
 * checkpoint written by the previous prompt re-parses, minus a block that is
 * about to be rebuilt by `05f`.
 */
export const InstagramCopyDraftSchema = InstagramCopyOutputSchema.extend({
  slides: z.array(InstagramSlideCopySchema.omit({ customArchetype: true })).min(1).max(8),
});
export type InstagramCopyDraft = z.infer<typeof InstagramCopyDraftSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 06 — source + vet images (InstagramImageVettingAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's image candidate pool entry — a repo-relative path plus a
 * short human-readable description the vetting agent judges against the
 * slide's `visualNeed`. Phase 1 has no real internet image-search tool
 * (RFC-03 §1) so this pool is caller-provided (a workflow input), standing
 * in for the "fetch + open + look at it" step of the real tool.
 */
export const ImageCandidateSchema = z.object({
  path: z.string().min(1),
  description: z.string().min(1),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

/**
 * How defensible one candidate's licence is, as a closed class.
 *
 * `editorial-only` is new in Phase 5.5 and it is the reason this enum exists
 * at all: a press photograph of a named public figure is routinely licensed
 * for editorial use and not for advertising, and until now such a candidate
 * had nowhere to land but `unknown`, which the rights gate refuses outright.
 * Carrying the class lets a COMMENTARY post use it and a PROMOTIONAL one not,
 * which is the actual rule rather than a proxy for it.
 *
 * ## Why the enum lives HERE and the policy lives in `entity-imagery.ts`
 *
 * `ImageSelectionSchema` needs the enum, and `entity-imagery.ts` imports
 * `concept-direction.ts` (for the illustration clause), which imports half the
 * workflow. Declaring it there and importing it here would close a runtime
 * cycle through this file — the same trap `scene-brief.ts`'s header documents.
 * The enum is a vocabulary; `licenceClassFor`, `licenceAdmissible` and
 * `creditLineFor` are the policy, and they stay with the rights commentary.
 */
export const LICENCE_CLASSES = ["blanket", "attributable", "editorial-only", "unknown"] as const;
export const LicenceClassSchema = z.enum(LICENCE_CLASSES);
export type LicenceClass = z.infer<typeof LicenceClassSchema>;

/**
 * One slide's vetting verdict. `imagePath: null` means "no candidate in the
 * pool honestly satisfies this slide's need".
 *
 * Until 2026-08 a `null` here always held the *whole* post (RFC-03 §1's
 * legacy-defect fix, preserved exactly: never ship a placeholder, a
 * rights-encumbered image, or a reused one). That guarantee is unchanged —
 * this schema still refuses every one of those. What changed is what happens
 * *instead* of holding: after every image-sourcing tier (retrieval, scrape,
 * generation) has genuinely been tried and a slide still has no usable
 * picture, the workflow now reassigns that slide's `layout` to `"text_only"`
 * (`InstagramSlideLayoutSchema`) and ships it without a photo — a real,
 * designed archetype the render template already supports, not a
 * placeholder standing in for a missing one. A run only holds now if the
 * copy/rights/compliance self-checks themselves fail, never solely because a
 * picture could not be found.
 *

 * `license`/`rightsUsable`/`watermarkFree` (P0 parity-audit Fix 4) restore
 * carousel-agent-v2 SKILL.md step 06's real vetting requirement — "Is it
 * rights-usable, watermark-free, and of the right era? Record per image: the
 * source URL, the licence, and the check verdict" — which this schema used
 * to drop entirely (only `imagePath`/`reason` existed; a code *comment*
 * described the legacy requirement but it never reached the schema or the
 * prompt the model actually sees). Every selected image needs its own
 * verdict on all three, whether or not `imagePath` is null (a `null`
 * selection still records why nothing qualified, including rights/watermark
 * concerns if that's what disqualified a candidate). The workflow treats
 * `rightsUsable: false` or `watermarkFree: false` exactly like `imagePath:
 * null` — holding the whole post, never shipping a rights-encumbered or
 * watermarked image.
 */
export const ImageSelectionSchema = z.object({
  n: z.number().int().positive(),
  imagePath: z.string().min(1).nullable(),
  reason: z.string().min(1),
  /** The licence/source basis for this verdict (e.g. "CC0, Unsplash", "client-owned asset", "n/a — no candidate qualified"). */
  license: z.string().min(1),
  /** False when the candidate is not clear to use commercially (unclear/incompatible licence, unverifiable source, etc.) — never shipped regardless of visual fit. */
  rightsUsable: z.boolean(),
  /** False when the candidate carries a visible watermark, stock-site overlay, or other embedded marking — never shipped regardless of visual fit. */
  watermarkFree: z.boolean(),
  /**
   * Does the picture show what the slide CLAIMS (headline + body), not
   * merely the objects `visualNeed` lists? 5 = the picture is evidence for
   * the claim; 3 = compatible and generic, nothing contradicts; 1-2 = a
   * different subject, team, place or era, or the picture contradicts the
   * claim. Required on every selection, `null` ones included, because the
   * defect this closes (RFC-13 §F: client photos of one team's fans shipped
   * under another team's headline, prep 2026-09) was a vet that judged
   * objects and never the claim — an absent score would let that return.
   * The workflow re-checks `claimMatch < MIN_CLAIM_MATCH` deterministically
   * in `isUnfillable`; the model's own threshold is never trusted alone.
   */
  claimMatch: z.number().int().min(1).max(5),
  /** Why the score — names what in the picture does or does not carry the slide's claim. Required, so a low score is checkable rather than a black box. */
  claimMatchReason: z.string().min(1),
  /**
   * Phase 5.5, item A3. Does this picture show the slide's `subject.noun` and
   * its `mustShow` clauses — WHAT IS IN FRAME, judged apart from the grade,
   * the light and the framing `scene` also describes?
   *
   * This is the score the selection floor moves onto, and it exists because
   * `claimMatch` alone could not see the 2026-09-16 failure. karoslabs' cover
   * pool held four correct photographs of server racks; the vet scored the
   * pool `claimMatch 1` and refused all of them, and its own reason says why:
   * *"The other candidates are server infrastructure, but none feature the
   * 'long exposure' effect that the `why` section states is necessary."* The
   * subject was right and the treatment was wrong, and one number could not
   * say so.
   *
   * OPTIONAL on the wire, and that is a file-ownership fact rather than a
   * design preference: several `ImageSelection`s are CONSTRUCTED in the
   * workflow (the typographic placeholder at `06`, the cover promoted by the
   * interest re-layout) and a required field would be a breaking change to a
   * file this package's image work does not own. `selectionPasses` therefore
   * falls back to the `claimMatch` floor and REPORTS that it did, so a vet
   * that silently stopped emitting the field shows up as a basis on the gate
   * payload instead of as a quietly restored old threshold. Prompt `@6`
   * requires it on every selection.
   */
  subjectMatch: z.number().int().min(1).max(5).optional(),
  /** Why the subject score — names what is in frame, never how it was shot. */
  subjectMatchReason: z.string().min(1).optional(),
  /**
   * How defensible this candidate's licence is, as a CLASS rather than as
   * prose. `license` stays (it is the human-readable basis a reviewer reads);
   * this is the machine-readable half the rights gate and the credit line need.
   * Derived in code by `licenceClassFor` when the model omits it.
   */
  licenceClass: LicenceClassSchema.optional(),
  /**
   * WARN-ONLY this phase, gating nothing. Eight stock clichés the owner named
   * in one sentence ("stock desks and cranes"); thepitchbydeel's 2026-09-16
   * post shipped a yellow gantry crane under a headline about specialised
   * agents.
   *
   * It ships unarmed on purpose. `instagram-floor-candidates-falsified`
   * records three separators this project killed with the control that
   * measured them, and a cliché detector that refuses a correct photograph of
   * a real handshake is exactly that shape of mistake. Three prep runs of
   * recorded verdicts first, then a decision.
   */
  stockCliche: z.enum(["handshake", "open-plan-office", "crane", "abstract-network", "lightbulb", "chess", "rocket", "glowing-brain"]).optional(),
});
export type ImageSelection = z.infer<typeof ImageSelectionSchema>;

/**
 * A selection whose `claimMatch` is below this is unfillable, exactly like a
 * `null` `imagePath` or a failed rights/watermark verdict: the slide takes
 * the existing text-only downgrade path. 3 ("compatible and generic") is the
 * floor because a generic-but-honest picture is what most stock pools can
 * offer; 1-2 is a picture that says something the slide does not.
 *
 * Still the floor on the CLAIM axis, and still re-checked deterministically.
 * What changed in Phase 5.5 is that it is no longer the only axis — see
 * `selectionPasses`.
 */
export const MIN_CLAIM_MATCH = 3;

/**
 * The subject floor: 4, not 3.
 *
 * It is a whole step stricter than `MIN_CLAIM_MATCH` because the two numbers
 * are answering different questions. `claimMatch 3` is documented, correctly,
 * as *"compatible and generic… A stock desk under a slide about desk work"* —
 * an honest floor for "does this contradict the claim". `subjectMatch` asks
 * "is this a picture OF the thing", and "generically compatible" is not a yes.
 * A 3 on this axis is the stock desk, which is the picture the owner looked at
 * and said was not a picture.
 */
export const MIN_SUBJECT_MATCH = 4;

/** Why a selection passed or failed the floor, so the gate payload can show the basis instead of a boolean. */
export interface SelectionFloorVerdict {
  passes: boolean;
  /** `"subject"` — the `@6` floor ran. `"claim-fallback"` — the vet emitted no `subjectMatch` and the pre-5.5 floor was used. */
  basis: "subject" | "claim-fallback";
  reason: string;
}

/**
 * THE SELECTION FLOOR, in one place.
 *
 * ```
 * rightsUsable && watermarkFree && (subjectMatch >= 4 || (subjectMatch >= 3 && claimMatch >= 4))
 * ```
 *
 * The second limb is what stops this from being a flat raise. A picture that
 * is one honest step of abstraction from the subject (`subjectMatch 3`) but is
 * unmistakably evidence for what the slide claims (`claimMatch 4`) is a good
 * selection and always was — a photograph of an OpenAI office under a headline
 * about OpenAI's decision. What the floor now refuses is the pairing that
 * shipped all three of the 2026-09-16 posts' pictures: generically compatible
 * on both axes.
 *
 * `imagePath === null` is NOT tested here. A null selection is unfillable by
 * construction and every caller already handles it; folding it in would let a
 * caller that forgot the null check believe this function had done it.
 */
export function selectionPasses(selection: Pick<ImageSelection, "rightsUsable" | "watermarkFree" | "claimMatch" | "subjectMatch">): SelectionFloorVerdict {
  if (!selection.rightsUsable) return { passes: false, basis: "subject", reason: "the candidate is not rights-usable" };
  if (!selection.watermarkFree) return { passes: false, basis: "subject", reason: "the candidate is watermarked" };

  const subject = selection.subjectMatch;
  if (subject === undefined) {
    const passes = selection.claimMatch >= MIN_CLAIM_MATCH;
    return {
      passes,
      basis: "claim-fallback",
      reason: `the vet returned no subjectMatch, so the pre-5.5 claim floor was applied (claimMatch ${selection.claimMatch}/5, floor ${MIN_CLAIM_MATCH})`,
    };
  }

  if (subject >= MIN_SUBJECT_MATCH) return { passes: true, basis: "subject", reason: `the picture shows the briefed subject (subjectMatch ${subject}/5)` };
  if (subject >= MIN_CLAIM_MATCH && selection.claimMatch >= 4) {
    return { passes: true, basis: "subject", reason: `one step of abstraction from the subject (subjectMatch ${subject}/5) but evidence for the claim (claimMatch ${selection.claimMatch}/5)` };
  }
  return {
    passes: false,
    basis: "subject",
    reason: `subjectMatch ${subject}/5 is under the ${MIN_SUBJECT_MATCH}/5 floor and claimMatch ${selection.claimMatch}/5 does not carry it — the picture is compatible with the slide rather than of its subject`,
  };
}

/**
 * How far a vetted candidate may be placed: as the whole plate, inside it, or
 * not at all.
 *
 * ## Why the floor needed a middle rung
 *
 * `selectionPasses` is a pass/fail, and a fail meant the slide got NOTHING.
 * Geektime's prep slide 6 of 2026-09-18 asked for a conference stage and was
 * offered one: `subjectMatch 3, claimMatch 2`, refused as *"an anonymous
 * crowd rather than a picture of the specific entity"*. The slide shipped
 * with no picture, and the carousel shipped with none at all.
 *
 * Both of the owner's rulings are right and they are about different
 * placements. On 2026-09-16, looking at a generic stock photograph filling a
 * plate: *that is not a picture* — which is what `MIN_SUBJECT_MATCH` was
 * raised to 4 for, and it stands. On 2026-09-18: *"not every image has to be
 * a background. Images can appear inside the post as part of it, even if it
 * is a small part... it really adds when there is an image inside."*
 *
 * A generically compatible photograph filling a 1080x1440 plate is filler.
 * The same photograph in a 300px band beside type is editorial illustration,
 * which is the register the second ruling asks for and which no carousel has
 * shipped yet. So the floor for the GROUND is unchanged, and a candidate that
 * misses it can still be placed inside a plate.
 *
 * ## What still refuses, and why that line is where it is
 *
 * `claimMatch` below `MIN_CLAIM_MATCH` is a picture that says something the
 * slide does not — a CONTRADICTION, not a weak match. That refuses at every
 * placement, because a band is as published as a ground. It is also the axis
 * the fabricated-figure incident turned on, and nothing here loosens it.
 */
export type SelectionPlacement = "full-bleed" | "bounded" | "refuse";

export interface SelectionPlacementVerdict {
  placement: SelectionPlacement;
  reason: string;
}

export function selectionPlacement(
  selection: Pick<ImageSelection, "rightsUsable" | "watermarkFree" | "claimMatch" | "subjectMatch">,
): SelectionPlacementVerdict {
  const ground = selectionPasses(selection);
  if (ground.passes) return { placement: "full-bleed", reason: ground.reason };
  if (!selection.rightsUsable || !selection.watermarkFree) return { placement: "refuse", reason: ground.reason };
  if (selection.claimMatch < MIN_CLAIM_MATCH) {
    return {
      placement: "refuse",
      reason: `claimMatch ${selection.claimMatch}/5 is under the ${MIN_CLAIM_MATCH}/5 floor — the picture says something the slide does not, which no placement makes acceptable`,
    };
  }
  return {
    placement: "bounded",
    reason:
      `${ground.reason}; compatible without contradicting (claimMatch ${selection.claimMatch}/5), so it is placed INSIDE the plate ` +
      `beside the type rather than as its ground`,
  };
}

/**
 * ── A `null` THE VET'S OWN SCORES DO NOT SUPPORT. ──
 *
 * `selectionPlacement` above is a ladder: ground, or inside the plate, or
 * refused. A vet that returns `imagePath: null` has taken the third rung. This
 * function asks whether its own numbers agreed.
 *
 * ## The run this is measured on
 *
 * `pubsub-21902648165262839`, 2026-09-20, slides 1 and 6. The pool held two
 * Wikimedia pictures of ChatGPT and a Pexels shot of the ChatGPT interface,
 * for slides whose subject was ChatGPT. The vet returned `null` on both, with
 * `subjectMatch 3, claimMatch 3` and the reason *"only shows the ChatGPT logo
 * on a phone and does not illustrate the UI layout of sponsored ads beneath
 * organic responses"* -- the slide's PROPOSITION, which no photograph can
 * depict, marked against the picture twice.
 *
 * Those exact scores are `selectionPlacement`'s middle rung: **bounded**, a
 * picture set inside the plate beside the type. The machinery to use the
 * picture existed, was correct, and never saw it, because the vet had already
 * thrown the path away. Both carousels shipped with zero and one pictures.
 *
 * ## What this returns and what it deliberately does not do
 *
 * It reports a CONTRADICTION; it does not repair one. A null selection carries
 * no `imagePath`, so nothing downstream can recover the picture from here --
 * the honest remedy is upstream (`instagram-image-vet@7` section 1d tells the
 * vet to return the candidate and let the ladder decide) and in the rescue
 * path. What this buys is that the failure can never again be silent: a vet
 * that refuses a picture its own numbers would have placed is now a fact the
 * run can print, rather than a slide that is simply empty.
 *
 * `undefined` `subjectMatch` returns false. The pre-5.5 vets did not report
 * one, and a missing number is not evidence of a contradiction.
 */
export function nullSelectionContradictsItsScores(
  selection: Pick<ImageSelection, "imagePath" | "rightsUsable" | "watermarkFree" | "claimMatch" | "subjectMatch">,
): boolean {
  if (selection.imagePath !== null) return false;
  if (selection.subjectMatch === undefined) return false;
  return selectionPlacement(selection).placement !== "refuse";
}

export const ImageVettingOutputSchema = z.object({
  selections: z.array(ImageSelectionSchema).min(1),
});
export type ImageVettingOutput = z.infer<typeof ImageVettingOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 08b — post-render visual QA (InstagramVisualQaAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One `check: "render"` rule's verdict against a single rendered attempt.
 * `slide` is omitted for a whole-post-level rule (e.g. "never repeat a
 * picture across slides") that isn't about one specific slide.
 */
export const VisualQaFindingSchema = z.object({
  ruleId: z.string().min(1),
  slide: z.number().int().positive().optional(),
  passed: z.boolean(),
  note: z.string().min(1),
});
export type VisualQaFinding = z.infer<typeof VisualQaFindingSchema>;

/**
 * `InstagramVisualQaAgent`'s output (P0 parity-audit Fix 2) — carousel-agent-v2
 * SKILL.md step 08: "look at the PNGs... check the `check: 'render'` rules
 * from the frozen config: nothing overlapping, no near-empty slide, the
 * closer carries a device. A fail here is `RETURN: 05`." This repo has no
 * real vision-capable image-inspection tool wired in yet (the same
 * documented class of gap as `InstagramImageVettingAgent`'s own text-only
 * candidate judging), so this agent is a deliberate text-proxy stand-in: it
 * judges plausibility from the same structured `fields`/`images` data
 * `slides-data.json` carries, never actual pixels. `pass: false` routes the
 * workflow back through the SAME step-07 self-check retry loop (RETURN: 05
 * equivalent), not a separate mechanism.
 */
export const VisualQaOutputSchema = z.object({
  pass: z.boolean(),
  findings: z.array(VisualQaFindingSchema).default([]),
});
export type VisualQaOutput = z.infer<typeof VisualQaOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 (RFC-16) — the CONCEPT mode's run-surface types
//
// The DECISION types (`ConceptSignals`, the pattern vocabulary, the
// legibility verdicts) live in `concept-direction.ts`, which is pure and
// imports nothing from the workflow. What lives HERE is the two things the
// run's own surface needs: the override the run/client can set, and the
// audit trail a reviewer reads on the gate payload and the deliverable.
// ─────────────────────────────────────────────────────────────────────────

/**
 * RFC-16 §1.7's override, most specific first.
 *
 * `"off"` on the CLIENT config is a standing opt-out and beats any per-run
 * request. `"on"` on the RUN INPUT bypasses the score, the recognition gate
 * and the cooldown — and nothing else: not the grounding floor, not the
 * palette/colour gates, not the budget gates, not the safety policy. Those
 * are not preferences, which is why this is a three-value enum rather than a
 * boolean that could read as "force it".
 */
export const INSTAGRAM_CONCEPT_MODES = ["auto", "on", "off"] as const;
export type ConceptMode = (typeof INSTAGRAM_CONCEPT_MODES)[number];

/**
 * Anything but the three known values is ignored, exactly as `01-open-run`
 * ignores an unknown `requestedFormat`: a typo in a run dialog or a client
 * config must not switch a whole feed into (or out of) the concept mode.
 */
export function readConceptMode(value: unknown): ConceptMode | undefined {
  return typeof value === "string" && (INSTAGRAM_CONCEPT_MODES as readonly string[]).includes(value) ? (value as ConceptMode) : undefined;
}

/** One scoring term of RFC-16 §1.4, itemised the way `AngleScore.rule` and `RankComponents` are. */
export interface ConceptScoreTerm {
  term: string;
  points: number;
  why?: string;
}

/**
 * RFC-16 §1.7 — the concept decision and its arithmetic, surfaced in the gate
 * payload beside `visualDirection` and on the persisted deliverable **on
 * every run, including the ones where it declined**.
 *
 * Present-on-every-run is the load-bearing half. A report that appeared only
 * when the mode fired would make "this client never gets concept images" and
 * "this client's stories never qualify" look identical to a reviewer, and the
 * measured selection rate — the number §1.6 refuses to guess in advance — would
 * have no denominator.
 */
export interface ConceptReport {
  /** The mode that actually governed, after the client config and the run input were resolved against each other. */
  mode: ConceptMode;
  /** Which of the three levels decided it: `"client config"`, `"run input"` or `"default"`. */
  modeSource: string;
  /** Did the story clear §1.5's nine preconditions? */
  eligible: boolean;
  /** Did `04n-design-concept` actually run — i.e. was the $0.029 Sonnet call bought? */
  fired: boolean;
  /** Did a concept image end up on the shipped slide? Strictly narrower than `fired` (§6.4): the concept has to WIN. */
  shipped: boolean;
  /** The one sentence that states the decision and its arithmetic. Always present, on both verdicts. */
  rule: string;
  score?: number;
  threshold?: number;
  terms?: readonly ConceptScoreTerm[];
  recognition?: { entities: readonly string[]; basis: string };
  grounding?: { basis: string; floor: number; brandFit?: number; briefFit?: number; angleFit?: number };
  /** `postsSinceLastConcept` is `null`, not `0`, when this account has never shipped one — "never" and "the most recent post" are opposite facts. */
  cooldown?: { postsSinceLastConcept: number | null; required: number; usedInWindow: number; window: number; ceiling: number };
  /** The eligible pattern subset `04l` computed and handed to `04m` — never the full seven. */
  patterns?: readonly string[];
  /**
   * What the client's `generatedLikeness` consent record permits, in the
   * reviewer's own view. For the whole fleet on day one this reads
   * `status: "absent"` with two empty lists, which is the conservative
   * default and is exactly what the owner is being asked to look at.
   */
  likeness?: {
    status: string;
    marks: readonly string[];
    figures: readonly string[];
    ownMarks: boolean;
    /** Phase 5.5, item A2 — the permit's own words, shown ONLY when `consentRelevant`. A blocking-sounding note printed every week is a note nobody reads. */
    scopeNote?: string;
    /** Whether `04b3` found a person whose likeness this run would actually need a permit for. `false` on a post about a pricing change, which is most of them. */
    consentRelevant?: boolean;
  };
  /** Present once `04m` returned something the legibility guard accepted. */
  concept?: {
    pattern: string;
    anchor: string;
    situation: string;
    readsAs: string;
    decodesTo: string;
    restsOn: string;
    paletteRole: string;
    typeZone: string;
    usesPermittedMarks: readonly string[];
  };
  /** The slide `04n` chose, when it chose one. */
  slideN?: number;
  /**
   * Why no concept image shipped, in the house style — the declined
   * precondition, the failed legibility clause, the budget posture, the
   * generation outcome, or "the photograph already on the slide scored as
   * well or better". Absent only when `shipped` is true.
   */
  declineReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 07 — emit slides-data.json (the publish.renderCarousel input contract)
// ─────────────────────────────────────────────────────────────────────────

/** The result of step 07's self-check — mirrors `GateVerdictKind`'s pass/content_fail shape without pulling in the full `GateVerdict` union (this is workflow-internal, never a tool outcome). */
export type SlidesDataSelfCheck = { ok: true } | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────
// Final workflow result
// ─────────────────────────────────────────────────────────────────────────

export interface InstagramAgentWorkflowResult {
  /**
   * Present when a reviewer ran the cycle out of rounds or rejected the post
   * outright.
   *
   * The carousel is kept and marked rather than the run ending, so the work
   * survives for whoever has to act on it, and the topic reservation is
   * released rather than consumed. Absent on an approval.
   */
  reviewOutcome?: { outcome: "revisions_exhausted" | "rejected"; detail: string };
  postId: string;
  topic: string;
  slideCount: number;
  renderedCount: number;
  deliverableId: string;
  /** SCRUM-242 (T-A10) — present only when this run's branding-guidelines context doc was absent; a human reviewer must see this, not merely a system that fetched it. */
  contextGrounding?: DegradedContextGroundingMarker;
  /**
   * Phase 0 cost controls (owner's rule, 2026-09-09) — present only when the
   * run's spend crossed the hard max and the rest of the run took the
   * cheapest complete path (text-only image gaps, no vision inspection, no
   * optional visual-QA model call). The run still COMPLETED and delivered;
   * a budget is an adaptation, never a hold.
   */
  budget?: { status: "degraded"; reason: string };
  /**
   * Phase 2, item L (RFC-14) — present only when the visual-interest floor
   * was STILL failing on the final drafting attempt (or the run was past its
   * hard max, where escalation is suppressed).
   *
   * The run COMPLETED and delivered: an empty-looking slide is a
   * picture/layout problem, and this workflow's standing promise is that one
   * never costs the post (`zero-held-guarantee.test.ts`). The marker is what
   * keeps "shipped degraded" distinguishable from "shipped fine", with the
   * measured numbers in the reason.
   */
  visualInterest?: { status: "degraded"; reason: string };
  /**
   * Phase 4 (RFC-15/16) — present only when the target language was NOT verified on the post that shipped:
   * the native editor still flagged it after two rounds, it could not be judged at all, or (RFC-19 §4 item 4)
   * the draft was in the wrong script entirely.
   *
   * The run COMPLETED and delivered, exactly as it does for `budget` and `visualInterest`. The `unverified`
   * case is the one that matters most: it is the state the original geektime carousel shipped in, and what
   * changed is that it now says so to a person who can still reject it.
   *
   * **Declared here late, and the gap is worth recording.** The workflow has emitted this field beside
   * `visualInterest` since Phase 4, but the interface never listed it — so the one marker a reviewer most
   * needs to read off the typed return was reachable only through a cast, and every test that wanted it read
   * `deliverable.grounding.language` instead. The emit was right; the type was silent. Declaring it makes the
   * two agree and lets RFC-19's wrong-script case assert the marker it sets.
   */
  language?: { status: "degraded"; reason: string };
  /**
   * RFC-19 (Phase 6) — present only when a QUALITY GATE refused the attempt that actually shipped: the
   * slide self-check, craft hygiene, the script or conventions checks, the relevance judge, a default render
   * rule, the palette gate, or visual QA.
   *
   * The run COMPLETED and delivered. The owner's rule is that a low score must produce a different attempt
   * or a degraded delivery, never a dead run — so the gate still REFUSES (no bar moved), the attempt walks
   * forward, and this marker carries which checks did not pass, in each gate's own words, with the step id
   * that produced them.
   *
   * ABSENT, never empty, on a clean run. A marker attached unconditionally would be the "silently shipping a
   * bad post" failure in reverse; `zero-held-quality.test.ts` asserts the absence as well as the presence.
   */
  selfCheck?: SelfCheckDegradeMarker;
}
