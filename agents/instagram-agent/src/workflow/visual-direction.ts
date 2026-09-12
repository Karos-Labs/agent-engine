import { z } from "zod";
import type { ClientBrief } from "@agent-engine/tools";
import { isPlaceholderBriefValue } from "./client-brief.js";
import type { BrandTokens } from "./types.js";

/**
 * RFC-13 Phase 3, item Q — **per-client visual direction, derived once at
 * setup**, and the thing that finally reads it.
 *
 * ## The defect this removes
 *
 * `image.generate`'s brief has one fallback line:
 *
 * ```
 * Style: realistic photography, natural lighting, clean composition.
 * ```
 *
 * Every Instagram client reaches it, because the only thing the workflow ever
 * passed as art direction was `artDirectionFor(frozen.brandTokens)` and
 * `BrandTokens.aesthetic` / `.lighting` / `.palette` / `.visualMood` are all
 * optional fields no client config in the fleet actually sets. So every
 * generated image for every client is drawn to the same twelve words, which
 * is precisely the "generic stock" failure `buildBrief`'s own doc comment
 * warns about — and it is the image half of the owner's 2026-09-10 complaint
 * that the output "looks like AI".
 *
 * ## Two facts that decided the shape of this module
 *
 * 1. **`media.ingestVisualPatterns` / `media.getVisualPatterns` already ARE
 *    the artefact item Q describes**: consent-gated, versioned per client,
 *    `patterns[]` carrying `appliesTo`/`evidence`/`confidence`,
 *    `templateHints[]`, a human review state and
 *    `renderVisualPatternReference()`. They are dark only because nothing
 *    calls them and `artDirectionFor` ignored them. Nothing here builds a
 *    parallel store; the profile is EVIDENCE that flows in.
 * 2. **`research.pull` already accepts `includeVisualPatterns`** (added in
 *    1.2.0; the read path, the schema and the payload fold all exist and the
 *    file is at 1.3.0) with no caller. Wiring it is a caller change in
 *    `research-lanes.ts`, so `pull.ts` is untouched and unbumped.
 *
 * ## Why the derived direction lives in beliefs, not in the versioned profile
 *
 * There is no `WorkspaceStore` handle in this workflow — only
 * `options.templateStore` and `options.repoRoot` — and widening a versioned,
 * consent-gated tool to accept agent-authored prose would force an
 * `INGEST_TOOL_VERSION` bump for a write it was never designed to take. So
 * the direction is stored under `VISUAL_DIRECTION_BELIEF_KEY` through the
 * `memory.updateBeliefs({ diff })` the workflow already makes at `09b`,
 * exactly as the run-budget and skeleton histories are. `updateBeliefs`
 * merges a diff, so sibling keys never fight. Migrating it into the versioned
 * profile once a workspace writer exists is a named follow-up, not this
 * change.
 *
 * ## The discipline: every line names its basis
 *
 * `VisualDirectionLineSchema.basis` is REQUIRED. A direction line without an
 * evidence URL, a brand-kit token or a site page behind it is not a fact
 * about this client, it is the model's taste wearing the client's name — and
 * it would then steer roughly a quarter of their generated images
 * (`VISUAL_DIRECTION_TTL_DAYS`). A line with nothing behind it belongs in
 * `gaps`, which is the same discipline `stampAgentBrief` already enforces on
 * the client brief.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. Where it lives, and for how long
// ─────────────────────────────────────────────────────────────────────────

/** The beliefs key the derived direction lives under. Sibling of `RUN_BUDGET_BELIEF_KEY` and `SKELETON_BELIEF_KEY` in the same document. */
export const VISUAL_DIRECTION_BELIEF_KEY = "instagramVisualDirection";

/**
 * How long a derived direction stands before `00d` asks for a new one.
 *
 * Ninety days — a quarter. Two reasons it is that long and not shorter: the
 * derivation costs ~$0.042 of the SEPARATE per-client setup budget (target
 * $2.00, hard max $3.00) and re-paying it weekly would be most of a run's
 * whole budget for an answer that does not change weekly; and a house style
 * that is re-derived every run is not a house style — the point of a standing
 * direction is that a quarter of posts look like one client, which is exactly
 * the consistency the neutral one-liner destroyed.
 */
export const VISUAL_DIRECTION_TTL_DAYS = 90;

/** How many generation-ready lines the art director is asked for. Four is the floor a fallback must also clear; ten is where a brief stops being a brief. */
export const VISUAL_DIRECTION_LINES_MIN = 4;
export const VISUAL_DIRECTION_LINES_MAX = 10;

/**
 * The beliefs key a FAILED derivation is remembered under, and how long that
 * memory stands.
 *
 * Without it, `00d` re-resolves `derive` on every subsequent run for a client
 * whose art-director turn failed (or whose belief write failed), and re-pays
 * ~$0.075 of `00d1` + `00d2` every week for the same failure. That is
 * recurring spend booked to a budget whose whole premise is "one-off per
 * client, amortised" — and it is invisible to the run's $1.00/$1.50
 * accounting, because the setup meter is a different meter. A run whose true
 * spend is ~$1.06 would keep reporting ~$0.98.
 *
 * Seven days, not ninety: a failure is usually transient (a router blip, a
 * schema miss, a store write), so the retry has to come back long before the
 * success TTL would. One retry a week is cheap; one a run is a leak. The
 * fallback direction stays in force in the meantime, so nothing about the
 * pictures degrades while the marker stands — only the re-billing stops.
 */
export const VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY = "instagramVisualDirectionAttempt";
export const VISUAL_DIRECTION_RETRY_DAYS = 7;

/** A derivation that was tried and did not stick. Written by `00d3` on the failure path, read by `checkVisualDirection`. */
export const VisualDirectionAttemptSchema = z.object({
  version: z.literal(1),
  attemptedAt: z.string().min(1),
  /** Plain language, for the ledger and the gate: which step failed and how. */
  failedWith: z.string().min(1).max(240),
});
export type VisualDirectionAttempt = z.infer<typeof VisualDirectionAttemptSchema>;

/** The stored failure marker, or `undefined` — including for the `null` a successful run writes to clear it. */
export function readVisualDirectionAttempt(beliefs: unknown): VisualDirectionAttempt | undefined {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return undefined;
  const parsed = VisualDirectionAttemptSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The named gap recorded when the client's own posts could not be read.
 *
 * Consent for `media.ingestVisualPatterns` is usually absent, so this is the
 * COMMON path, not the exceptional one. It is a named reason on the gate
 * rather than a failure: a direction derived from the brand kit and the brief
 * is still an enormous improvement on one hardcoded sentence, and the reader
 * of the gate payload needs to know which of the two they are looking at.
 */
export const VISUAL_PATTERNS_UNAVAILABLE_GAP =
  "visualPatternsUnavailable: the client's own posts were not read (no visual-pattern consent on file, or nothing ingested yet) — the direction rests on the brand kit, the brief and the client's site";

/**
 * The ceiling on ONE gap sentence, and the ceiling on how many are kept.
 *
 * Named constants rather than literals inside the schema because the writers
 * of `gaps` are mostly CODE, not the model: `00d1`'s `not_available` reasons
 * quote a tool's own message verbatim, and those run past 240 characters
 * routinely (`media.ingestVisualPatterns`' consent reason is 253 on its own,
 * which makes the assembled sentence 376). The model's own gaps are capped by
 * the schema it answers under; the code-assembled ones were not, and an
 * over-long gap is not a cosmetic defect — the document is then REFUSED by
 * `readVisualDirection`'s `safeParse` on the next run, `00d` resolves `derive`
 * again, and `00d1` + `00d2` (~$0.075 of the per-client setup budget) are
 * re-paid on EVERY run. That is precisely the recurring-spend leak
 * `VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY` exists to stop, arriving through the
 * success path where no failure marker is written.
 *
 * So every writer of a gap clamps through `clampGap`, and
 * `finaliseVisualDirection` re-parses what it built before anyone can persist
 * it: a document that cannot be read back is never written.
 */
export const GAP_MAX_CHARS = 240;
export const GAPS_MAX = 12;

// ─────────────────────────────────────────────────────────────────────────
// 2. The schema
// ─────────────────────────────────────────────────────────────────────────

/**
 * One generation-ready sentence, with the evidence that earned it.
 *
 * `basis` is required for the reason in this module's header: an unbacked
 * line is a gap, not an assertion. `confidence` travels with it so a reviewer
 * reading the belief document can tell a pattern seen in eleven of the
 * client's own posts from one inferred off a single site page.
 */
export const VisualDirectionLineSchema = z.object({
  line: z.string().min(1).max(200).describe("One instruction an image model can act on, written in English."),
  basis: z.string().min(1).max(160).describe("An evidence URL from the client's own posts, a brand-kit token name, or a site page. Required — a line with no basis belongs in gaps."),
  confidence: z.enum(["high", "medium", "low"]),
});
export type VisualDirectionLine = z.infer<typeof VisualDirectionLineSchema>;

/**
 * The per-client generation style every generated image in a run inherits
 * (item S). One id, one sentence: the id is what a later run pins so a set
 * reads as one set, the sentence is what actually reaches the image model.
 */
export const VisualStyleLockSchema = z.object({
  id: z.string().min(1).max(40).describe("A stable slug for this style, e.g. \"warm-documentary\". Pinned per run so every generated image in one carousel shares a treatment."),
  line: z.string().min(1).max(200),
});
export type VisualStyleLock = z.infer<typeof VisualStyleLockSchema>;

/**
 * The four axes, the forbid list and the lines, shared verbatim between the
 * stored document and the agent's own output schema so the two cannot drift.
 *
 * The axis arrays carry `.default([])` while `lines` does not, and that split
 * is deliberate. `lines` IS the direction — it is what `buildArtDirection`
 * turns into the generation brief's `notes` — so a turn that returns fewer
 * than four has not answered the question. The axes are an index into the
 * lines for a human reading the belief document; losing a whole quarter's
 * direction because the model had nothing to say about lighting would be the
 * wrong trade, and the owner's standing rule is that a step adapts and
 * delivers rather than failing. (This is the one place the implementation is
 * looser than spec Q.2, which lists the axes as required.)
 */
const VISUAL_DIRECTION_FIELDS = {
  subject: z.array(z.string().min(1).max(160)).max(4).default([]).describe("What is in frame: the objects, people and places this client's images are of."),
  light: z.array(z.string().min(1).max(160)).max(3).default([]),
  palette: z.array(z.string().min(1).max(40)).max(6).default([]).describe("Named or hex colours the frame should sit in."),
  treatment: z.array(z.string().min(1).max(160)).max(3).default([]).describe("Lens, grade, depth of field, grain — how the frame is rendered rather than what it shows."),
  forbid: z.array(z.string().min(1).max(80)).max(10).default([]).describe("What must never appear. Reaches image.generate as an explicit negative block."),
  lines: z.array(VisualDirectionLineSchema).min(VISUAL_DIRECTION_LINES_MIN).max(VISUAL_DIRECTION_LINES_MAX),
  styleLock: VisualStyleLockSchema,
  gaps: z.array(z.string().min(1).max(GAP_MAX_CHARS)).max(GAPS_MAX).default([]),
} as const;

/**
 * Which evidence the direction was actually derived from.
 *
 * Named on the gate payload as `visualDirection.source`, because the honest
 * answer for most clients is `brand+brief` — consent for reading their own
 * feed is usually absent — and a reviewer must be able to tell "this is what
 * your posts look like" from "this is what your brand kit and positioning
 * imply".
 */
export const VISUAL_DIRECTION_SOURCES = ["patterns", "patterns+brand", "brand+brief", "brand"] as const;
export type VisualDirectionSource = (typeof VISUAL_DIRECTION_SOURCES)[number];

export const VisualDirectionSchema = z.object({
  version: z.literal(1),
  /** ISO 8601. Compared against `VISUAL_DIRECTION_TTL_DAYS` by `checkVisualDirection`. */
  generatedAt: z.string().min(1),
  /** `"instagram-art-director@1"`, or `"fallback"` when a budget lever skipped the agent step. */
  generatedBy: z.string().min(1),
  ...VISUAL_DIRECTION_FIELDS,
  source: z.enum(VISUAL_DIRECTION_SOURCES),
});
export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

/**
 * What `instagram-art-director` returns: the authored half only.
 *
 * `version`, `generatedAt`, `generatedBy` and `source` are code's to write —
 * a model cannot be trusted to report which evidence it actually had, and
 * `source` is the field a reviewer uses to decide how much to believe the
 * rest.
 */
export const ArtDirectorOutputSchema = z.object({ ...VISUAL_DIRECTION_FIELDS });
export type ArtDirectorOutput = z.infer<typeof ArtDirectorOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// 3. Reading it back
// ─────────────────────────────────────────────────────────────────────────

/**
 * The stored direction, or `undefined`.
 *
 * A malformed belief returns `undefined` rather than throwing: this is read
 * at `00d`, before anything has been spent, and a document written by an
 * older schema must degrade to "derive a new one", never to a dead run.
 */
export function readVisualDirection(beliefs: unknown): VisualDirection | undefined {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[VISUAL_DIRECTION_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return undefined;
  const parsed = VisualDirectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Whole days since `generatedAt`, floored and never negative; `undefined` for an unparseable stamp (which then reads as stale). */
export function visualDirectionAgeDays(direction: Pick<VisualDirection, "generatedAt">, now: Date): number | undefined {
  const at = Date.parse(direction.generatedAt);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/** What `00d-check-visual-direction` decides. `unavailable` is a budget outcome, not an error — the caller then uses `fallbackVisualDirection`. */
export interface VisualDirectionCheck {
  action: "reuse" | "derive" | "unavailable";
  direction?: VisualDirection;
  ageDays?: number;
  /** Plain-language, for the ledger and the gate payload. Always set. */
  reason: string;
}

/**
 * `00d-check-visual-direction`: reuse, derive, or neither.
 *
 * Free — one beliefs read the workflow already makes. `allowDerive` is the
 * setup plan's fifth lever (`planSetupBudget(...).visualDirection`); when it
 * is off and nothing is stored the answer is `unavailable`, and the run
 * proceeds on `fallbackVisualDirection`. There is no fourth outcome: a budget
 * lever must never be able to stop a run.
 *
 * A RECENT FAILED ATTEMPT is the third reason to answer `unavailable`. A
 * derivation that failed and left nothing behind used to resolve `derive`
 * again on the very next run, and the run after that — re-paying `00d1` +
 * `00d2` (~$0.075) every time on a budget that is supposed to be a per-client
 * one-off. Inside `VISUAL_DIRECTION_RETRY_DAYS` the marker stands, the
 * fallback direction carries the run, and the money is not spent twice for
 * the same answer.
 */
export function checkVisualDirection(beliefs: unknown, options: { now: Date; allowDerive: boolean }): VisualDirectionCheck {
  const stored = readVisualDirection(beliefs);
  const attempt = readVisualDirectionAttempt(beliefs);
  const attemptAgeDays = attempt === undefined ? undefined : visualDirectionAgeDays({ generatedAt: attempt.attemptedAt }, options.now);
  /** A failure is "recent" only when its stamp parses: an unreadable stamp must not silence the retry forever. */
  const retryHeld = attempt !== undefined && attemptAgeDays !== undefined && attemptAgeDays < VISUAL_DIRECTION_RETRY_DAYS;
  const retryReason =
    attempt === undefined
      ? ""
      : `the last derivation failed ${attemptAgeDays ?? "an unknown number of"} day(s) ago (${attempt.failedWith}) and the ${VISUAL_DIRECTION_RETRY_DAYS}-day retry window has not passed`;
  if (stored !== undefined) {
    const ageDays = visualDirectionAgeDays(stored, options.now);
    if (ageDays !== undefined && ageDays < VISUAL_DIRECTION_TTL_DAYS) {
      return { action: "reuse", direction: stored, ageDays, reason: `a visual direction from ${stored.generatedBy} is ${ageDays} day(s) old, inside the ${VISUAL_DIRECTION_TTL_DAYS}-day TTL (source: ${stored.source})` };
    }
    if (!options.allowDerive || retryHeld) {
      return {
        action: "reuse",
        direction: stored,
        ...(ageDays !== undefined ? { ageDays } : {}),
        // Stale beats absent: a quarter-old direction for THIS client is
        // still that client's direction, and the alternative here is the
        // generic fallback.
        reason: retryHeld
          ? `the stored visual direction is stale (${ageDays ?? "unknown"} day(s)) but ${retryReason} — reusing it rather than re-paying for a derivation that just failed`
          : `the stored visual direction is stale (${ageDays ?? "unknown"} day(s)) but the setup budget turned the art-direction step off — reusing it rather than dropping to brand tokens`,
      };
    }
    return { action: "derive", ...(ageDays !== undefined ? { ageDays } : {}), reason: `the stored visual direction is ${ageDays ?? "of unknown age"} day(s) old, past the ${VISUAL_DIRECTION_TTL_DAYS}-day TTL` };
  }
  if (!options.allowDerive) {
    return { action: "unavailable", reason: "no visual direction on file and the setup budget turned the art-direction step off — the run uses the brand-kit fallback" };
  }
  if (retryHeld) {
    return { action: "unavailable", reason: `no visual direction on file and ${retryReason} — the run uses the brand-kit fallback` };
  }
  return { action: "derive", reason: "no visual direction on file for this client" };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Evidence, and which evidence wins
// ─────────────────────────────────────────────────────────────────────────

/**
 * A visual-pattern profile as this module needs it.
 *
 * Structurally identical to `karos-research`'s `ResearchVisualPatterns` (the
 * shape `research.pull({ includeVisualPatterns: true })` folds into its
 * payload) and buildable from a `VisualPatternProfile` with
 * `renderVisualPatternReference`. Declared structurally rather than imported
 * so this module takes no package dependency for four strings — and so the
 * same code reads the profile whichever of the two routes it arrived by.
 */
export interface VisualPatternEvidence {
  versionId: string;
  generatedAt: string;
  /** `"unreviewed"` | `"approved"` | `"corrected"`. A human-corrected profile is the strongest evidence this pipeline can hold. */
  reviewStatus: string;
  /** The rendered prose block — the same words a reviewer reads in the stored document. */
  reference: string;
  templateHints?: readonly string[];
}

/**
 * Evidence precedence, as a number so it can be compared rather than
 * re-argued at each call site.
 *
 * A REVIEWED profile outranks an unreviewed one, which outranks the brand kit
 * plus the brief, which outranks the brand kit alone. The reviewed/unreviewed
 * split is the important one: `renderVisualPatternReference` itself appends
 * "this profile has not been reviewed by a human yet — prefer the brand kit
 * where the two disagree", so an unreviewed profile is explicitly weaker than
 * its own prose suggests.
 */
export const VISUAL_EVIDENCE_RANK = { reviewedPatterns: 4, patterns: 3, brandAndBrief: 2, brand: 1 } as const;

/** True when a human has looked at this profile — `review.status !== "unreviewed"`, the split the ranking turns on. */
export function isReviewedProfile(evidence: Pick<VisualPatternEvidence, "reviewStatus">): boolean {
  return evidence.reviewStatus !== "unreviewed";
}

export function visualEvidenceRank(evidence: { patterns?: VisualPatternEvidence | undefined; brief?: unknown }): number {
  if (evidence.patterns !== undefined) {
    return isReviewedProfile(evidence.patterns) ? VISUAL_EVIDENCE_RANK.reviewedPatterns : VISUAL_EVIDENCE_RANK.patterns;
  }
  return evidence.brief !== undefined ? VISUAL_EVIDENCE_RANK.brandAndBrief : VISUAL_EVIDENCE_RANK.brand;
}

/**
 * The one profile to use when several versions are on file.
 *
 * A human-reviewed version wins over any machine-written one even when the
 * machine-written one is newer — a reviewer's corrections are the only
 * ground truth here, and a later automatic ingestion does not overturn them.
 * Among equals, the highest version number.
 */
export function pickVisualPatternProfile<T extends { version: number; review: { status: string } }>(profiles: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const profile of profiles) {
    if (best === undefined) {
      best = profile;
      continue;
    }
    const rank = (p: T): number => (p.review.status === "unreviewed" ? 0 : 1);
    if (rank(profile) > rank(best) || (rank(profile) === rank(best) && profile.version > best.version)) best = profile;
  }
  return best;
}

/** Everything `00d2` hands the art director, assembled by code at `00d1` so the agent is a fixed one-call bill. */
export interface VisualDirectionEvidenceBundle {
  clientSlug: string;
  brandTokens?: BrandTokens | undefined;
  /** The resolved render tokens (`effectiveKit.cssVars`), which is where a client's real ground/ink/accent hexes are. */
  renderTokens?: Readonly<Record<string, string>> | undefined;
  brief?: ClientBrief | undefined;
  patterns?: VisualPatternEvidence | undefined;
  /** Up to three of the client's own pages, already fetched by ScrappyCoco at `00c2`/`00d1`. */
  sitePages?: ReadonlyArray<{ url: string; title?: string | undefined; text: string }> | undefined;
  /**
   * `media.inspectImages` DESCRIPTIONS of the client's own post images —
   * never the pixels, which is both cheaper and avoids storing them.
   *
   * **No caller supplies these today**, and on a ScrappyCoco-only stack none
   * can: `research.socialHistory` returns post text and engagement and no
   * image URL at all, so there is nothing for `media.inspectImages` to look
   * at (`00c2` names that as an absent signal). The field is plumbing for the
   * day one arrives; `prompts/instagram-art-director/1.md` deliberately does
   * NOT advertise it as an input or as a `basis` kind, because a prompt that
   * offers a source the caller never supplies is an invitation to cite one.
   */
  ownImageNotes?: readonly string[] | undefined;
  companyName?: string | undefined;
  targetLanguage?: string | undefined;
  /** Named problems the gatherer already hit (a failed page fetch, a `not_available` ingestion). Folded into `gaps`. */
  problems?: readonly string[] | undefined;
}

/** The hand-assembled agent input. Flat and bounded on purpose: it is injected whole into one prompt. */
export interface ArtDirectorInput {
  channel: "instagram";
  clientSlug: string;
  linesWanted: { min: number; max: number };
  companyName?: string;
  positioning?: string;
  icp?: string;
  coreTerms?: string[];
  differentiators?: string[];
  forbiddenTopics?: string[];
  /** The photographic tokens only — `templateDir`/`slideTemplate` are render plumbing and say nothing about how a photograph should look. */
  brandTokens?: Record<string, string>;
  brandPalette?: string[];
  renderTokens?: Record<string, string>;
  /** `renderVisualPatternReference(profile)` verbatim, so the model is steered by the same prose a human can correct. */
  visualPatterns?: string;
  visualPatternsVersionId?: string;
  visualPatternsReviewStatus?: string;
  templateHints?: string[];
  sitePages?: Array<{ url: string; title?: string; text: string }>;
  ownImageNotes?: string[];
  targetLanguage?: string;
  /** What the evidence did not contain. The prompt turns these into `gaps`, never into confident lines. */
  gaps: string[];
}

/** Per-source ceilings, so one long site page cannot crowd the profile out of the prompt. */
const SITE_PAGE_CHARS = 2_500;
const MAX_SITE_PAGES = 3;
const MAX_IMAGE_NOTES = 8;
const IMAGE_NOTE_CHARS = 400;

/**
 * The one sentence the deterministic fallback direction ships that a CONCEPT
 * image must never receive (RFC-16 §4.3).
 *
 * `fallbackVisualDirection` emits it for every client whose brief has a
 * `positioning.whatWeSell`, and `buildArtDirection` joins it into `art.notes`,
 * which `image.generate` appends VERBATIM. It is exactly the right instruction
 * for the other 5-in-6 runs and exactly the wrong one for the frame whose
 * whole job is to be a metaphor, so `buildConceptArtDirection` drops it BY
 * IDENTITY — a `startsWith` against this constant rather than a regex over
 * prose that would also catch an author's own literalism line.
 *
 * **This constant and the sentence below it are a pair.** Nothing in the type
 * system ties them together, so `concept-budget-and-art.test.ts` pins that the
 * line `fallbackVisualDirection` actually emits still starts with this prefix:
 * editing the sentence without editing the constant would leave the drop
 * silently doing nothing, which is the failure mode a `startsWith` is worth
 * having a test for. Change one, change both.
 */
export const ANTI_METAPHOR_LINE_PREFIX = "Show what is actually sold as a real object, screen or workplace rather than an abstract metaphor:";

/**
 * The standing product policy every generated image carries, on BOTH
 * direction paths (RFC-16 §4.4).
 *
 * `instagram-art-director@1` §4.3 tells the agent to put these in `forbid`
 * ("legible text or signage in frame, logos and brand marks, recognisable real
 * people …") and says they are standing product policy needing no basis — so
 * an AUTHORED direction has them. `fallbackVisualDirection` populated `forbid`
 * solely from `brief.forbidden.topics`, so every client on the brand-kit
 * fallback path — which is most of the fleet, since visual-pattern consent is
 * usually absent — had **no** brand-mark or real-person entry at all. That was
 * live from Phase 3 until this fix.
 *
 * Kept to the two entries that are a rights question rather than a taste one.
 * `image.generate`'s own constraint line already bans text, lettering and
 * watermarks unconditionally, so repeating those here would spend two of the
 * ten `forbid` slots on something already enforced.
 */
export const STANDING_IMAGE_FORBID: readonly string[] = ["logos and brand marks", "recognisable real people"];

function clamp(value: string, max: number): string {
  const tidy = value.replace(/\s+/gu, " ").trim();
  return tidy.length <= max ? tidy : `${tidy.slice(0, max - 1).trimEnd()}…`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const tidy = value?.trim();
  return tidy !== undefined && tidy.length > 0 ? tidy : undefined;
}

/**
 * Every gap, on its way into the document, through the schema's own ceiling.
 *
 * The one function both writers use. A tool's `not_available` reason is
 * quoted verbatim into a gap and those reasons are long; clamping at the
 * point of assembly is what keeps the assembled document readable back —
 * see `GAP_MAX_CHARS`.
 */
export function clampGap(gap: string): string {
  return clamp(gap, GAP_MAX_CHARS);
}

/** De-duplicated, clamped, capped — the gap list exactly as the schema will accept it. */
function tidyGaps(gaps: Iterable<string>): string[] {
  const out: string[] = [];
  for (const raw of gaps) {
    const gap = clampGap(raw);
    if (gap.length > 0 && !out.includes(gap)) out.push(gap);
  }
  return out.slice(0, GAPS_MAX);
}

/**
 * Every absolute URL that appeared anywhere in the evidence handed to the art
 * director.
 *
 * `basis` is the one discipline protecting the lines, and nothing was checking
 * it: `prompts/instagram-art-director/1.md` §2 makes "a named site page" a
 * legitimate basis kind, so a model with no site page in its input can still
 * answer with a plausible-looking URL, and the line then reads as evidence for
 * a quarter of this client's generated images. A URL that never appeared in
 * the input is not evidence — it is the model's taste wearing a citation — and
 * `finaliseVisualDirection` demotes the line carrying it to a gap.
 */
function urlsIn(value: unknown): Set<string> {
  const found = new Set<string>();
  for (const match of JSON.stringify(value ?? "").matchAll(/https?:\/\/[^\s"'<>\\)\]]+/gu)) {
    found.add(match[0].replace(/[.,;:]+$/u, "").toLowerCase());
  }
  return found;
}

/** The URLs one `basis` string cites, normalised the same way `urlsIn` normalises the evidence. */
function urlsCitedBy(basis: string): string[] {
  return [...urlsIn(basis)];
}

/**
 * A brief field, or `undefined` when its value is one of
 * `deriveClientBrief`'s placeholders — plus the gap that says so.
 *
 * `deriveClientBrief` writes human-facing sentences ABOUT MISSING DATA into
 * `positioning.oneLiner` and `icp.summary` for a client with no description,
 * tagline, name or industry — the exact client shape item Q exists for. Piped
 * into a generation brief they produce "Photograph the work itself: an
 * unnamed business: no profile description, tagline, name or industry on
 * file", and the same string reached the run-wide style lock on EVERY
 * generated image. A diffusion model either ignores that or tries to render
 * the words; either way it is strictly worse than the neutral twelve-word
 * line item Q replaces.
 *
 * So the value is skipped and the fact is recorded as a `gap`, which is this
 * module's standing rule: a line you cannot ground is a gap, not an
 * assertion.
 */
function groundable(value: string | undefined, field: string, gaps: string[]): string | undefined {
  const tidy = nonEmpty(value);
  if (tidy === undefined) return undefined;
  if (isPlaceholderBriefValue(tidy) || readsAsMissingData(tidy)) {
    gaps.push(`the brief's ${field} is a placeholder recording that the data is missing, so no direction line was derived from it`);
    return undefined;
  }
  return tidy;
}

/**
 * Belt and braces over `isPlaceholderBriefValue`'s exact-match list: any value
 * that READS as a statement about absent data, whatever wrote it.
 *
 * The exact-match list is the contract and this is the net under it — a future
 * placeholder written somewhere else, or one whose wording drifts, must not
 * silently become an instruction to an image model.
 */
function readsAsMissingData(value: string): boolean {
  return /\bno\b[^.]{0,60}\bon file\b/iu.test(value) || /\bunnamed business\b/iu.test(value);
}

/**
 * Assembles `00d2-derive-visual-direction`'s whole input, and decides the
 * `source` label the result will carry.
 *
 * Everything the agent reads is gathered here rather than fetched by the
 * agent, which is why it can run `allowedTools: []`, `maxSteps: 1` — a fixed
 * one-call bill on the setup meter instead of an open-ended research loop.
 */
export function buildVisualDirectionInput(bundle: VisualDirectionEvidenceBundle): {
  input: ArtDirectorInput;
  gaps: string[];
  source: VisualDirectionSource;
  /** Every URL the evidence actually contained, for `finaliseVisualDirection`'s `basis` cross-check. */
  evidenceUrls: string[];
} {
  // Clamped HERE, at the point of assembly, because most of these are a
  // tool's own `not_available` reason quoted verbatim and those run long —
  // see `GAP_MAX_CHARS` for what an unclamped one costs on every later run.
  const gaps: string[] = (bundle.problems ?? []).map(clampGap);
  const brief = bundle.brief;
  const tokens = bundle.brandTokens;
  const patterns = bundle.patterns;

  if (patterns === undefined) gaps.push(VISUAL_PATTERNS_UNAVAILABLE_GAP);
  else if (!isReviewedProfile(patterns)) {
    gaps.push(`the visual-pattern profile ${patterns.versionId} has not been reviewed by a human — prefer the brand kit where the two disagree`);
  }
  if (brief === undefined) gaps.push("no persisted client brief — the direction rests on the brand kit and the site alone");

  const photographicTokens: Record<string, string> = {};
  if (nonEmpty(tokens?.aesthetic) !== undefined) photographicTokens["aesthetic"] = tokens!.aesthetic!;
  if (nonEmpty(tokens?.lighting) !== undefined) photographicTokens["lighting"] = tokens!.lighting!;
  if (nonEmpty(tokens?.visualMood) !== undefined) photographicTokens["visualMood"] = tokens!.visualMood!;
  if (nonEmpty(tokens?.accentColor) !== undefined) photographicTokens["accentColor"] = tokens!.accentColor!;
  if (Object.keys(photographicTokens).length === 0 && (tokens?.palette ?? []).length === 0) {
    gaps.push("the brand kit declares no photographic tokens (aesthetic, lighting, palette, visualMood) — this is the default state for a client nobody has art-directed, and the reason this step exists");
  }

  const sitePages = (bundle.sitePages ?? [])
    .filter((page) => nonEmpty(page.text) !== undefined)
    .slice(0, MAX_SITE_PAGES)
    .map((page) => ({ url: page.url, ...(nonEmpty(page.title) !== undefined ? { title: page.title! } : {}), text: clamp(page.text, SITE_PAGE_CHARS) }));
  // Two different facts, and they used to be reported as one. A gap saying
  // the site "could not be read" when no fetch was ever made for this step
  // rides the gate payload and sends a reviewer chasing a scraper fault that
  // does not exist. `undefined` means the caller supplied no pages (the
  // studio block did not run this run, so nothing was fetched); `[]` means a
  // fetch was made and came back with nothing usable.
  if (sitePages.length === 0) {
    gaps.push(
      bundle.sitePages === undefined
        ? "no page of the client's own site was fetched for this step — the direction rests on the brand kit and the brief"
        : "the client's own site could not be read",
    );
  }

  const ownImageNotes = (bundle.ownImageNotes ?? []).slice(0, MAX_IMAGE_NOTES).map((note) => clamp(note, IMAGE_NOTE_CHARS));

  const source: VisualDirectionSource =
    patterns !== undefined
      ? Object.keys(photographicTokens).length > 0 || (tokens?.palette ?? []).length > 0 || bundle.renderTokens !== undefined
        ? "patterns+brand"
        : "patterns"
      : brief !== undefined
        ? "brand+brief"
        : "brand";

  const input: ArtDirectorInput = {
    channel: "instagram",
    clientSlug: bundle.clientSlug,
    linesWanted: { min: VISUAL_DIRECTION_LINES_MIN, max: VISUAL_DIRECTION_LINES_MAX },
    ...(nonEmpty(bundle.companyName) !== undefined ? { companyName: bundle.companyName!.trim() } : {}),
    ...(brief !== undefined ? { positioning: clamp(`${brief.positioning.oneLiner} ${brief.positioning.whatWeSell}`, 600) } : {}),
    ...(brief !== undefined ? { icp: clamp([brief.icp.summary, ...brief.icp.pains].filter((s) => s.length > 0).join("; "), 400) } : {}),
    ...(brief !== undefined ? { coreTerms: [...brief.coreTerms].slice(0, 12) } : {}),
    ...(brief !== undefined && brief.positioning.differentiators.length > 0 ? { differentiators: [...brief.positioning.differentiators].slice(0, 6) } : {}),
    ...(brief !== undefined && brief.forbidden.topics.length > 0 ? { forbiddenTopics: [...brief.forbidden.topics].slice(0, 10) } : {}),
    ...(Object.keys(photographicTokens).length > 0 ? { brandTokens: photographicTokens } : {}),
    ...((tokens?.palette ?? []).length > 0 ? { brandPalette: [...tokens!.palette!] } : {}),
    ...(bundle.renderTokens !== undefined ? { renderTokens: { ...bundle.renderTokens } } : {}),
    ...(patterns !== undefined ? { visualPatterns: patterns.reference, visualPatternsVersionId: patterns.versionId, visualPatternsReviewStatus: patterns.reviewStatus } : {}),
    ...(patterns !== undefined && (patterns.templateHints ?? []).length > 0 ? { templateHints: [...patterns.templateHints!] } : {}),
    sitePages,
    ...(ownImageNotes.length > 0 ? { ownImageNotes } : {}),
    ...(nonEmpty(bundle.targetLanguage) !== undefined ? { targetLanguage: bundle.targetLanguage! } : {}),
    gaps,
  };

  return { gaps, source, input, evidenceUrls: [...urlsIn(input)] };
}

/**
 * The agent's answer plus the four fields code owns — what `00d3` persists,
 * or `undefined` when what came back cannot be persisted.
 *
 * `gaps` from the assembly are merged with the model's own, clamped and
 * de-duplicated: the model can only name gaps it noticed inside the evidence,
 * and code knows what never reached the evidence at all.
 *
 * Three things this function guarantees, each of which was a defect:
 *
 * 1. **Every gap fits the schema.** The model's do by construction; the
 *    code-assembled ones quote tool reasons verbatim and did not. See
 *    `GAP_MAX_CHARS` for the recurring-spend leak an over-long one causes.
 * 2. **Every `basis` that cites a URL cites a URL the evidence contained.**
 *    Nothing checked this, and the prompt explicitly offers "a named site
 *    page" as a basis kind — so a model handed no site page could answer with
 *    a plausible URL and that line would steer a quarter of this client's
 *    generated images. A line citing a source that was never in the input is
 *    demoted to a `gap`, which is the module's own rule: a line you cannot
 *    ground is a gap, not an assertion.
 * 3. **What comes out can be read back in.** The result is re-parsed through
 *    `VisualDirectionSchema` — the same parse `readVisualDirection` will do on
 *    the next run — so a document that would be refused on the read is never
 *    written. `undefined` means "this turn produced nothing storable", which
 *    the caller treats exactly as a failed turn: warn, record the attempt
 *    marker, and carry the run on `fallbackVisualDirection`.
 */
export function finaliseVisualDirection(
  output: ArtDirectorOutput,
  meta: {
    source: VisualDirectionSource;
    generatedBy: string;
    now: Date;
    gaps?: readonly string[];
    /** Every URL the evidence carried (`buildVisualDirectionInput(...).evidenceUrls`). Omit to skip the citation cross-check. */
    evidenceUrls?: readonly string[];
  },
): VisualDirection | undefined {
  const gaps: string[] = [...(meta.gaps ?? []), ...output.gaps];

  const known = meta.evidenceUrls === undefined ? undefined : new Set(meta.evidenceUrls.map((url) => url.toLowerCase()));
  const lines: VisualDirectionLine[] = [];
  for (const line of output.lines) {
    const invented = known === undefined ? [] : urlsCitedBy(line.basis).filter((url) => !known.has(url));
    if (invented.length === 0) {
      lines.push(line);
      continue;
    }
    gaps.push(`a line was dropped because its basis cited ${invented[0]}, which was not in the evidence handed to the art director: ${line.line}`);
  }

  if (lines.length < VISUAL_DIRECTION_LINES_MIN) return undefined;

  const parsed = VisualDirectionSchema.safeParse({
    version: 1,
    generatedAt: meta.now.toISOString(),
    generatedBy: meta.generatedBy,
    subject: output.subject,
    light: output.light,
    palette: output.palette,
    treatment: output.treatment,
    forbid: output.forbid,
    lines,
    styleLock: output.styleLock,
    source: meta.source,
    gaps: tidyGaps(gaps),
  });
  return parsed.success ? parsed.data : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. The fallback — why the neutral one-liner is unreachable in practice
// ─────────────────────────────────────────────────────────────────────────

/**
 * A direction derived with no model call at all, from the brand kit and the
 * brief.
 *
 * This is the insurance that makes item Q's promise true even when a budget
 * lever turns the art-direction step off (lever 5 of `planSetupBudget`) or
 * the agent turn comes back malformed: the client still gets lines that are
 * about THEM, so `buildArtDirection` still returns an `art` object and
 * `image.generate` still never reaches
 * `"Style: realistic photography, natural lighting, clean composition."`.
 *
 * Every line names its basis, exactly as an authored one must. The function
 * returns `undefined` rather than padding when fewer than
 * `VISUAL_DIRECTION_LINES_MIN` lines can be grounded — a fabricated line is
 * worse than no direction, because it would steer a quarter of this client's
 * images on the strength of nothing.
 *
 * **A brief PLACEHOLDER is not grounding.** `deriveClientBrief` writes
 * sentences about missing data into `positioning.oneLiner` and `icp.summary`
 * for a client with no description, tagline, name or industry, and those used
 * to be piped verbatim into the image brief and the run-wide style lock.
 * `groundable` skips them and records a gap. For a client with nothing else
 * either, this function now returns `undefined` and `image.generate` reaches
 * its own neutral line — which is worse than a real direction and better than
 * telling a diffusion model to photograph "an unnamed business: no profile
 * description, tagline, name or industry on file".
 */
export function fallbackVisualDirection(tokens: BrandTokens | undefined, brief?: ClientBrief, options?: { now?: Date }): VisualDirection | undefined {
  const now = options?.now ?? new Date();
  const lines: VisualDirectionLine[] = [];
  const subject: string[] = [];
  const light: string[] = [];
  const palette: string[] = [];
  const treatment: string[] = [];
  const forbid: string[] = [];
  const gaps: string[] = [];
  /** The subject the style lock is written about, or `undefined` when nothing in the brief could be grounded. */
  let styleLockSubject: string | undefined;

  const aesthetic = nonEmpty(tokens?.aesthetic);
  const lighting = nonEmpty(tokens?.lighting);
  const mood = nonEmpty(tokens?.visualMood);
  const accent = nonEmpty(tokens?.accentColor);
  const kitPalette = (tokens?.palette ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  const ground = nonEmpty(tokens?.renderTokens?.ground);

  if (aesthetic !== undefined) {
    treatment.push(aesthetic);
    lines.push({ line: clamp(`Shoot in a ${aesthetic} register.`, 200), basis: "brand kit: aesthetic", confidence: "high" });
  }
  if (lighting !== undefined) {
    light.push(lighting);
    lines.push({ line: clamp(`Light the frame as ${lighting}.`, 200), basis: "brand kit: lighting", confidence: "high" });
  }
  if (kitPalette.length > 0) {
    palette.push(...kitPalette.slice(0, 6));
    lines.push({ line: clamp(`Keep the frame inside the brand palette: ${kitPalette.slice(0, 6).join(", ")}.`, 200), basis: "brand kit: palette", confidence: "high" });
  }
  if (accent !== undefined) {
    if (!palette.includes(accent) && palette.length < 6) palette.push(accent);
    // The accent has to be a THING in the frame. As an overlay it would sit
    // exactly where the template then draws live text — the same argument
    // `buildBrief`'s own accent line already makes.
    lines.push({ line: clamp(`Let the brand accent ${accent} appear once as a real object or surface in the frame, never as a colour overlay.`, 200), basis: "brand kit: accentColor", confidence: "high" });
  }
  if (mood !== undefined) {
    treatment.push(mood);
    lines.push({ line: clamp(`The frame should feel ${mood}.`, 200), basis: "brand kit: visualMood", confidence: "medium" });
  }
  if (ground !== undefined) {
    lines.push({
      line: clamp(`Compose against grounds close to ${ground}, so the photograph meets the slide's own background without a visible seam.`, 200),
      basis: "brand kit: renderTokens.ground",
      confidence: "medium",
    });
  }

  // The standing product policy, FIRST and unconditionally — before the
  // brief's own topics and outside the `brief !== undefined` block below.
  //
  // First, because `forbid` is capped at ten entries by the schema and a
  // client with a long forbidden-topics list must not be the client whose
  // images may draw a recognisable face. Unconditionally, because the hole
  // this closes was widest on exactly the clients with no brief at all: a
  // brand-kit-only direction had an empty `forbid`.
  for (const entry of STANDING_IMAGE_FORBID) {
    if (!forbid.includes(entry)) forbid.push(entry);
  }

  if (brief !== undefined) {
    const oneLiner = groundable(brief.positioning.oneLiner, "positioning.oneLiner", gaps);
    const whatWeSell = groundable(brief.positioning.whatWeSell, "positioning.whatWeSell", gaps);
    const icp = groundable(brief.icp.summary, "icp.summary", gaps);
    const terms = brief.coreTerms.map((t) => t.trim()).filter((t) => t.length > 0);

    if (oneLiner !== undefined) {
      subject.push(clamp(oneLiner, 160));
      lines.push({ line: clamp(`Photograph the work itself: ${oneLiner}`, 200), basis: "client brief: positioning.oneLiner", confidence: "medium" });
    }
    if (whatWeSell !== undefined) {
      if (subject.length < 4) subject.push(clamp(whatWeSell, 160));
      lines.push({
        // KEEP IN SYNC with `ANTI_METAPHOR_LINE_PREFIX`, which
        // `buildConceptArtDirection` drops this line by. Written out rather
        // than interpolated so the constant stays a pin with a test that can
        // fail rather than a tautology.
        line: clamp(`Show what is actually sold as a real object, screen or workplace rather than an abstract metaphor: ${whatWeSell}`, 200),
        basis: "client brief: positioning.whatWeSell",
        confidence: "medium",
      });
    }
    if (icp !== undefined) {
      if (subject.length < 4) subject.push(clamp(icp, 160));
      lines.push({ line: clamp(`Where a person belongs in frame, it is this one: ${icp}`, 200), basis: "client brief: icp.summary", confidence: "medium" });
    }
    if (terms.length > 0) {
      if (subject.length < 4) subject.push(clamp(terms.slice(0, 4).join(", "), 160));
      lines.push({
        line: clamp(`Prefer subjects that literally show ${terms.slice(0, 3).join(", ")} over generic office stock.`, 200),
        basis: "client brief: coreTerms",
        confidence: "medium",
      });
    }
    for (const topic of brief.forbidden.topics) {
      const tidy = nonEmpty(topic);
      if (tidy !== undefined && forbid.length < 10 && !forbid.includes(clamp(tidy, 80))) forbid.push(clamp(tidy, 80));
    }
    // The style lock is a SUBJECT sentence, so it needs a grounded subject or
    // it needs not to exist. Same order the lines are derived in.
    styleLockSubject = oneLiner ?? whatWeSell ?? (terms.length > 0 ? terms.slice(0, 3).join(", ") : undefined);
  }

  // Belt and braces over `groundable`: whatever wrote it, a line that reads
  // as a statement about absent data is not an instruction an image model can
  // act on, and it is the run-wide style lock's neighbour on every call.
  const grounded = lines.filter((line) => !readsAsMissingData(line.line));
  if (grounded.length < lines.length) gaps.push("a derived line was dropped because it read as a statement about missing data rather than about this client");
  if (grounded.length < VISUAL_DIRECTION_LINES_MIN) return undefined;

  const styleLockParts = [aesthetic, lighting, kitPalette.length > 0 ? `a palette of ${kitPalette.slice(0, 3).join(", ")}` : undefined].filter((p): p is string => p !== undefined);
  let styleLock: VisualStyleLock;
  if (styleLockParts.length > 0) {
    styleLock = { id: "brand-kit", line: clamp(`Every generated image in this set shares one treatment: ${styleLockParts.join(", ")}, one subject per frame, no composite.`, 200) };
  } else if (styleLockSubject !== undefined) {
    styleLock = {
      id: "client-brief",
      line: clamp(
        `Every generated image in this set shares one treatment: plain documentary photography of ${styleLockSubject}, one subject per frame, shallow depth of field, no composite.`,
        200,
      ),
    };
  } else {
    // Nothing to lock a style to. The old code reached for the one-liner
    // regardless and, for a client with no declared tokens, stamped "plain
    // documentary photography of an unnamed business: no profile
    // description, tagline, name or industry on file" onto EVERY generated
    // image in the run. No direction at all is better: `buildArtDirection`
    // then carries only the brand tokens, which is what this client has.
    return undefined;
  }

  return {
    version: 1,
    generatedAt: now.toISOString(),
    // Deliberately queryable: a direction nobody paid a model for should be
    // distinguishable in the belief document from one that was authored.
    generatedBy: "fallback:brand-kit-and-brief",
    subject: subject.slice(0, 4),
    light: light.slice(0, 3),
    palette: palette.slice(0, 6),
    treatment: treatment.slice(0, 3),
    forbid,
    lines: grounded.slice(0, VISUAL_DIRECTION_LINES_MAX),
    styleLock,
    source: brief !== undefined ? "brand+brief" : "brand",
    gaps: tidyGaps([
      VISUAL_PATTERNS_UNAVAILABLE_GAP,
      "derived deterministically from the brand kit and the brief without an art-direction model call — no line here is evidence from the client's own posts",
      ...gaps,
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. What finally reads it
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `art` object `image.generate` takes — the direction winning over the
 * brand token, field by field.
 *
 * This is `artDirectionFor(tokens)` from the workflow file, widened by one
 * argument and lifted here so it has a test of its own. The integrator swaps
 * the single call site (`workflow:~4404`); the old function's behaviour with
 * `direction === undefined` is preserved exactly, so a client with no
 * direction is byte-identical to today.
 *
 * `accentColor` is the one field the direction cannot override: it is a brand
 * FACT (the hex the slide's own chrome is drawn in), not an art-direction
 * opinion, and an image whose accent object is a different orange from the
 * template's accent rule reads as a mistake rather than as a choice.
 *
 * Returns `undefined` when there is nothing at all to say, which is what
 * makes `image.generate`'s neutral fallback still reachable in principle —
 * and, with `fallbackVisualDirection` in front of it, unreachable in practice
 * for any client with either a brand kit or a brief.
 */
export function buildArtDirection(tokens: BrandTokens | undefined, direction?: VisualDirection): Record<string, unknown> | undefined {
  const aesthetic = direction?.subject[0] ?? nonEmpty(tokens?.aesthetic);
  const lighting = direction?.light[0] ?? nonEmpty(tokens?.lighting);
  const palette = (direction?.palette.length ?? 0) > 0 ? direction!.palette : (tokens?.palette ?? []).length > 0 ? [...tokens!.palette!] : undefined;
  const accentColor = nonEmpty(tokens?.accentColor);
  const mood = direction?.treatment[0] ?? nonEmpty(tokens?.visualMood);
  // Every line, joined: the lines ARE the direction, and `notes` is the one
  // field `buildBrief` appends verbatim. Ten lines of at most 200 characters
  // is ~2k characters, which is a rounding error against an image charge.
  const notes = (direction?.lines.length ?? 0) > 0 ? direction!.lines.map((l) => l.line).join(" ") : undefined;
  const forbid = (direction?.forbid.length ?? 0) > 0 ? direction!.forbid : undefined;
  const styleLock = direction?.styleLock.line;

  const art = {
    ...(aesthetic !== undefined ? { aesthetic } : {}),
    ...(lighting !== undefined ? { lighting } : {}),
    ...(palette !== undefined ? { palette } : {}),
    ...(accentColor !== undefined ? { accentColor } : {}),
    ...(mood !== undefined ? { mood } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(forbid !== undefined ? { forbid } : {}),
    ...(styleLock !== undefined ? { styleLock } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}

/**
 * What the ONE slide carrying a concept (RFC-16) hands `image.generate`:
 * `buildArtDirection`'s object with three differences, and no others.
 *
 * 1. The anti-metaphor line is dropped, by identity against
 *    `ANTI_METAPHOR_LINE_PREFIX` — see that constant. It is dropped from
 *    `lines` BEFORE they are joined, because `notes` is one joined string by
 *    the time `buildArtDirection` is done with it and a substring surgery on
 *    prose is exactly the fragile thing the constant exists to avoid.
 * 2. `paletteRole` is appended: the concept's own answer to WHICH object in
 *    the frame carries the brand accent. The generic path says "carry the
 *    accent somewhere as a real object"; this path names it.
 * 3. `productionNote` is appended when the concept wrote one. It is RELATIVE
 *    by schema and by prompt ("push the locked style to its most dramatic
 *    end"), never a style of its own — a client whose style lock is flat and
 *    bright gets a flat, bright metaphor, which is the correct outcome.
 *
 * Everything else is byte-identical to `buildArtDirection`: the same palette,
 * the same `forbid` (which a concept can only ever ADD to, never shorten), the
 * same `styleLock` — and the same `accentColor`, which stays un-overridable
 * because it is a brand FACT rather than an art-direction opinion. The owner's
 * "brand colours still govern, absolutely" is that sentence, in code.
 *
 * Returns `undefined` in the one case `buildArtDirection` does — nothing at
 * all to say. Unreachable on the concept path, where eligibility precondition
 * 6 and legibility clause L8 both require a palette or an accent before a
 * concept is authored at all, and kept honest rather than papered over with an
 * art object that is only a note.
 */
export function buildConceptArtDirection(
  tokens: BrandTokens | undefined,
  direction: VisualDirection | undefined,
  // Structural rather than an import of `Concept`: this module is read by the
  // setup path too and must not depend on the concept module. `| undefined` is
  // explicit because the repo runs `exactOptionalPropertyTypes`, and a
  // zod-inferred `.optional()` field is `string | undefined` — a caller
  // handing over a whole validated concept object must just typecheck.
  concept: { readonly paletteRole: string; readonly productionNote?: string | undefined },
): Record<string, unknown> | undefined {
  const withoutAntiMetaphor =
    direction === undefined ? undefined : { ...direction, lines: direction.lines.filter((l) => !l.line.trimStart().startsWith(ANTI_METAPHOR_LINE_PREFIX)) };
  const art = buildArtDirection(tokens, withoutAntiMetaphor);
  if (art === undefined) return undefined;

  const additions = [nonEmpty(concept.paletteRole), nonEmpty(concept.productionNote)]
    .filter((part): part is string => part !== undefined)
    .map((part) => sentence(clamp(part, 200)));
  if (additions.length === 0) return art;

  const base = typeof art.notes === "string" ? art.notes : undefined;
  return { ...art, notes: [base, ...additions].filter((part): part is string => part !== undefined && part.length > 0).join(" ") };
}

/** A phrase the generator reads as an instruction rather than as a fragment: `notes` is appended verbatim, so the punctuation is ours to get right. */
function sentence(value: string): string {
  return /[.!?…]$/u.test(value) ? value : `${value}.`;
}
