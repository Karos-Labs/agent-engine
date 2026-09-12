import { z } from "zod";
import { TemplateDefinitionSchema, extractSupportedFields, type TemplateDefinition } from "@agent-engine/tool-karos-templates";
import type { ClientBrief } from "@agent-engine/tools";
import { isolateForeignRuns } from "./bidi-isolate.js";
import { resolveExpectedScript } from "./language-gate.js";
import { scriptTypographyFor } from "./script-fonts.js";
import { assessContrastFacts, checkPaletteWithinKit, LAYOUT_FIELD_KEYS, LEADS_WITH_FIGURE, type ContrastFact } from "./visual-qa-pre-checks.js";

/**
 * Phase 2, item N — the **Template Studio**: 4-6 templates generated PER
 * CLIENT at setup, on their own budget meter, and refused unless they render
 * and MEASURE well.
 *
 * The owner's complaint (2026-09-10) is the reason this file exists in the
 * shape it does: *"there are boring templates too — at Karos Labs you see a
 * mostly-grey screen; nobody wants those posts."* Generating templates is not
 * the feature. Generating templates **that cannot be boring** is, and the
 * only way to know is to render one and measure the pixels. So the studio's
 * centre of gravity is not the authoring call — it is the eight-gate
 * validation battery in `validateStudioTemplate`, of which gate 6 (the
 * item-L interest floor at the template's declared role, with a calibration
 * margin) is the one that answers the complaint: a generated template that
 * is boring is refused at generation, not discovered in production.
 *
 * ## Three architectural constraints, verified against the code, that shape
 * everything here
 *
 * 1. **A studio template MUST reuse one of the eight ROUTABLE archetype
 *    ids.** `templateForLayout` (slides-data.ts) maps only the fixed layout
 *    enum to `LAYOUT_TEMPLATE_FILES`, and `materializeTemplates` writes
 *    `templateFileName(archetypeId)`, which is byte-identical to those
 *    filenames. A template carrying a NEW archetypeId is a routing dead end:
 *    nothing in the workflow can ever pick it. A studio row is therefore *a
 *    better implementation of a routable archetype FOR THIS CLIENT*, at most
 *    one per `(client, archetypeId)` — which is exactly what
 *    `studioTemplateId` encodes, so the uniqueness constraint is the id.
 * 2. **Approval is the existing `enabled` boolean, not a new field.**
 *    `resolveBest` already skips a candidate with `enabled: false`, so
 *    storing the set disabled implements "until approval the bundled set is
 *    used" with zero new filters, and the row stays visible to the portal.
 * 3. **There is no WorkspaceStore handle in this workflow** (only
 *    `options.templateStore` and `options.repoRoot`), so there is no studio
 *    manifest file. The store rows themselves (`derivedFrom`, `role`,
 *    `enabled`, `qualityScore`) are the record, and the setup-budget history
 *    goes to the beliefs document.
 *
 * ## Why the safety and render seams are injected rather than imported
 *
 * `validateStudioTemplate` takes its safety, render and interest-floor
 * dependencies as an argument (`StudioValidationDeps`). Two reasons, one
 * structural and one practical:
 *
 * - **Structural.** Gates 5, 6 and 8 need a real Chromium render and the
 *   channel's editorial policy; gates 3 and 4 need the template package's
 *   markup safety. Injecting them keeps this module pure and unit-testable
 *   (every gate can be made to fail in isolation, which is how the battery is
 *   proved), and it keeps a channel policy out of a tool package.
 * - **Practical.** The two safety functions the studio needs live in
 *   `karos-templates` and are consumed through that package's built `dist/`
 *   (`assertSafeMarkup`'s opt-in `allowImageSlots`/`allowHtmlSlots`
 *   allowlist, and `buildStudioTemplateDocument`). The workflow constructs
 *   the deps object once; see this file's `StudioValidationDeps` doc comment
 *   for the exact wiring.
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. What a studio template is allowed to be
// ─────────────────────────────────────────────────────────────────────────

/** The interest-floor role a template is judged at — a cover and a closer must carry something; an interior slide may be one quiet all-type turn. */
export type StudioRole = "cover" | "interior" | "closer";

/**
 * The eight archetype ids the workflow can actually ROUTE a slide to.
 *
 * Not a style preference — a routing fact (constraint 1 above). `cover` and
 * `closer` are item M's two new bundled archetypes; the other six are the
 * layout enum's existing members. `text_only` is deliberately absent: it
 * routes to the client's own base template rather than to a registry row, so
 * a studio row claiming it could never be materialised.
 */
export const ROUTABLE_ARCHETYPE_IDS: readonly string[] = [
  "cover",
  "closer",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
  "headline_focus",
  "photo",
];

/** The role each routable archetype is judged at when a draft does not say. Slide 1 is a cover and the last slide is a closer, so those two ids carry their roles in their names. */
export const ROLE_BY_ARCHETYPE: Readonly<Record<string, StudioRole>> = {
  cover: "cover",
  closer: "closer",
  photo: "interior",
  stat_callout: "interior",
  quote_card: "interior",
  comparison_card: "interior",
  list_takeaway: "interior",
  headline_focus: "interior",
};

/**
 * The standing furniture every archetype's document receives, whatever its
 * declared slots are — `LAYOUT_FIELD_KEYS` (the render-rule module's own set,
 * reused rather than re-listed so the two cannot drift) plus the per-slide
 * `kicker`.
 */
export const STANDING_FURNITURE_SLOTS: ReadonlySet<string> = new Set([...LAYOUT_FIELD_KEYS, "kicker"]);

/**
 * What `contentFor` can actually supply, per archetype.
 *
 * Derived from `slides-data.ts`'s own `contentFor` switch (plus item M's
 * `cover`/`closer` cases and the `device` html fragment). This is the set
 * gate 2 checks against, and it is per-archetype rather than global on
 * purpose: a generated `quote_card` that reads `{{figure}}` is not a
 * template with an unusual slot, it is a template with a hole — nothing in
 * the pipeline will ever fill it, and `supportedFields` exists precisely to
 * expose that before a render rather than after.
 */
export const SLOTS_BY_ARCHETYPE: Readonly<Record<string, readonly string[]>> = {
  cover: ["eyebrow", "title", "subtitle", "hero", "device"],
  closer: ["takeaway", "cta", "question", "recap", "device"],
  stat_callout: ["figure", "subLabel", "body", "sourceLine", "device"],
  quote_card: ["quoteText", "attribution", "device"],
  comparison_card: ["headline", "body", "leftLabel", "leftBody", "rightLabel", "rightBody", "device"],
  list_takeaway: ["headline", "itemRows", "device"],
  headline_focus: ["headline", "body", "device"],
  photo: ["headline", "body", "hero", "device"],
};

/** Every slot name any archetype can supply — the union of `SLOTS_BY_ARCHETYPE`, for a message that can name the whole vocabulary. */
export const KNOWN_SLOT_NAMES: ReadonlySet<string> = new Set(Object.values(SLOTS_BY_ARCHETYPE).flat());

/** Slots that may be filled through the renderer's privileged `{{image:...}}` form. Only the hero: it is the only image a slide's content model has. */
export const PRIVILEGED_IMAGE_SLOTS: readonly string[] = ["hero"];

/** Slots that may be filled through the privileged `{{html:...}}` form, because code (never a model) builds their markup. */
export const PRIVILEGED_HTML_SLOTS: readonly string[] = ["device", "recap", "itemRows"];

/**
 * How long a generated set stands before the studio regenerates it.
 *
 * 120 days, against the Client Brief's 30: a brief tracks what the client
 * SAYS (positioning moves, offers change), a template set tracks how their
 * niche LOOKS, which moves far more slowly — and a regeneration costs the
 * whole setup budget while a brief refresh costs one Sonnet call. A brand-kit
 * change does not stale the set at all: the brand head fragment is spliced at
 * materialization time on every run, so a kit change re-themes every stored
 * row automatically.
 */
export const STUDIO_TTL_DAYS = 120;

/**
 * How long a setup that stored NOTHING stands before another one is paid for.
 *
 * The store rows are the studio's only durable record (spec finding 11
 * deleted the manifest), so a setup that stored zero templates leaves the
 * store exactly as it found it — and "no rows" then reads as "never tried".
 * Both zero-store paths are reachable and both are handled as warns that fall
 * through: the design-brief turn can fail its schema, and every candidate can
 * be dropped by the eight gates. Without a cooldown the next weekly run
 * re-resolves `generate` and re-pays `00c3` plus N x `00c4` plus repairs, on
 * its own meter, unbounded — against an item that is documented, twice, as
 * running "at most once per client per 120 days".
 *
 * 30 days rather than the full 120: a zero-store setup usually means a
 * transient failure (a malformed turn, an unreachable reference account) or a
 * client whose brief has nothing to design from yet, and a month is long
 * enough that the bill is bounded to roughly one setup a month in the worst
 * case while short enough that a fixed cause is picked up without an
 * operator. `refreshTemplates` overrides it immediately, which is the escape
 * hatch for "we fixed it, try now".
 */
export const STUDIO_EMPTY_SETUP_COOLDOWN_DAYS = 30;

/** The actor recorded on a studio row's first feedback entry. Deliberately queryable: "which templates did the studio write, and when". */
export const STUDIO_ACTOR = "studio";

/**
 * Id prefix, and the `(client, archetypeId)` uniqueness constraint in one
 * string.
 *
 * `studio_<clientSlug>_<archetypeId>` is DERIVED, not allocated: two setups
 * for the same client and archetype land on the same row rather than
 * accumulating near-duplicates, which is what makes "at most one studio
 * template per (client, archetype)" a property of the id rather than a check
 * somebody has to remember to run. It also makes a resumed `00c8` idempotent.
 */
export const STUDIO_ID_PREFIX = "studio_";

export function studioTemplateId(clientSlug: string, archetypeId: string): string {
  return `${STUDIO_ID_PREFIX}${clientSlug}_${archetypeId}`;
}

/**
 * Whether a stored row was written by the studio. Read off the id, which is
 * the same fact as the `(client, archetypeId)` constraint.
 *
 * The colon form is accepted too: every other id in this registry is
 * colon-separated (`bundled:stat_callout`, `ai_generated:<archetype>:<ts>`),
 * so a hand-written row or an operator following that convention must not be
 * invisible to the lifecycle check — being invisible would mean regenerating
 * over it.
 */
export function isStudioTemplateId(id: string): boolean {
  return id.startsWith(STUDIO_ID_PREFIX) || id.startsWith("studio:");
}

// ─────────────────────────────────────────────────────────────────────────
// 2. `00c-check-template-studio` — does this client already have a set?
// ─────────────────────────────────────────────────────────────────────────

/** The subset of a stored template row this check reads. Structurally satisfied by `TemplateDefinition`. */
export interface StudioStoredRow {
  id: string;
  archetypeId: string;
  enabled: boolean;
  updatedAt?: number | undefined;
  createdAt?: number | undefined;
  role?: StudioRole | undefined;
  derivedFrom?: { formatLabel: string } | undefined;
}

export type StudioAction = "reuse" | "generate" | "awaiting-approval";

/**
 * One past setup, as `00c` reads it — the `at` and `templatesStored` fields
 * of a `SetupBudgetRecord` in the beliefs document under
 * `SETUP_BUDGET_BELIEF_KEY`.
 *
 * This is the durable trace a zero-store setup DOES leave, and passing it in
 * is what stops "no rows" being read as "never tried". Declared structurally
 * so this module keeps no dependency on `run-budget.ts`.
 */
export interface StudioSetupAttempt {
  at: string;
  templatesStored: number;
}

export interface StudioRowSummary {
  templateId: string;
  archetypeId: string;
  enabled: boolean;
  role?: StudioRole;
  formatLabel?: string;
  ageDays: number;
}

export interface StudioCheck {
  action: StudioAction;
  /** Why, in a sentence the run record carries. */
  reason: string;
  rows: StudioRowSummary[];
  /** Every archetype this client has a studio row for, stale rows included. A REPORTING field. */
  archetypeIds: string[];
  /** Studio rows past the TTL. Their presence is what turns `reuse` into `generate`. */
  staleArchetypeIds: string[];
  /**
   * The archetypes the duplicate guard must actually refuse — and the ONLY
   * one of these three lists a generation path may pass to
   * `planStudioTemplates` / `validateStudioTemplate`.
   *
   * `archetypeIds` includes the stale rows, and a refresh exists precisely to
   * re-author those. Feeding the full list into the duplicate guard rejects
   * every proposal as "this client already has a studio template for X" — the
   * TTL refresh then authors nothing, stores nothing, leaves the same stale
   * rows behind, and takes the identical branch on the next run, re-paying
   * the setup bill forever. So: fresh rows only, and on an explicit
   * `refreshTemplates` **nothing** is taken, because the run asked for the
   * whole set again.
   *
   * Re-authoring an archetype that already has a row is the intended
   * behaviour, not a collision: the studio id is deterministic
   * (`studio_<client>_<archetype>`), so `promoteTemplate` upserts the same
   * row rather than accumulating duplicates.
   */
  freshArchetypeIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ageDaysOf(row: StudioStoredRow, now: number): number {
  const at = row.updatedAt ?? row.createdAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return Number.NaN;
  return Math.floor((now - at) / DAY_MS);
}

/**
 * Free store read, then three answers:
 *
 * - **`generate`** — no studio rows for this client AND no recent setup that
 *   stored none, or every row is past `STUDIO_TTL_DAYS`, or the run asked
 *   (`refreshTemplates`). This is the only branch that spends money, and a
 *   normal weekly run never takes it.
 * - **`awaiting-approval`** — rows exist and are fresh, but none is enabled.
 *   Regenerating here would be the worst of both: it spends the setup budget
 *   again AND overwrites the exact rows a human has been asked to look at.
 * - **`reuse`** — at least one fresh enabled row, or a setup inside
 *   `STUDIO_EMPTY_SETUP_COOLDOWN_DAYS` that stored nothing. Nothing is spent.
 *
 * An undatable row (no `createdAt`/`updatedAt`) counts as STALE, the same way
 * `resolveBriefFreshness` treats an unreadable `generatedAt` as a refresh
 * reason: trusting an age nobody can read is how a set from an old prompt
 * version quietly stands forever.
 */
export function checkTemplateStudio(input: {
  rows: readonly StudioStoredRow[];
  now?: Date;
  refreshRequested?: boolean;
  /** Past setups from `SETUP_BUDGET_BELIEF_KEY`, oldest first. Omit and a zero-store setup is invisible again. */
  setupHistory?: readonly StudioSetupAttempt[];
}): StudioCheck {
  const now = (input.now ?? new Date()).getTime();
  const studioRows = input.rows.filter((r) => isStudioTemplateId(r.id));
  const rows: StudioRowSummary[] = studioRows.map((r) => ({
    templateId: r.id,
    archetypeId: r.archetypeId,
    enabled: r.enabled,
    ...(r.role !== undefined ? { role: r.role } : {}),
    ...(r.derivedFrom !== undefined ? { formatLabel: r.derivedFrom.formatLabel } : {}),
    ageDays: ageDaysOf(r, now),
  }));
  const stale = rows.filter((r) => Number.isNaN(r.ageDays) || r.ageDays > STUDIO_TTL_DAYS);
  const archetypeIds = [...new Set(rows.map((r) => r.archetypeId))].sort();
  const staleArchetypeIds = [...new Set(stale.map((r) => r.archetypeId))].sort();
  // Only a FRESH row is a duplicate worth refusing — see `freshArchetypeIds`.
  const freshArchetypeIds = archetypeIds.filter((id) => !staleArchetypeIds.includes(id));

  if (input.refreshRequested === true) {
    // The run asked for the whole set again, so nothing is taken: every
    // archetype is re-authorable and `promoteTemplate` upserts the same
    // deterministic ids.
    return { action: "generate", reason: "this run asked for a fresh template set (refreshTemplates)", rows, archetypeIds, staleArchetypeIds, freshArchetypeIds: [] };
  }
  if (rows.length === 0) {
    // "No rows" is TWO different situations, and paying the setup bill again
    // is only right for one of them. A setup that ran and stored nothing
    // leaves the store untouched, so the beliefs history is the only place
    // that remembers it happened — see `STUDIO_EMPTY_SETUP_COOLDOWN_DAYS`.
    const lastAttempt = [...(input.setupHistory ?? [])]
      .map((attempt) => ({ attempt, at: Date.parse(attempt.at) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((a, b) => b.at - a.at)[0];
    // Only a ZERO-store attempt earns the cooldown. A past setup that stored
    // rows and has none now is a deletion, not a failure, and regenerating is
    // the right answer there.
    if (lastAttempt !== undefined && lastAttempt.attempt.templatesStored === 0) {
      const ageDays = Math.floor((now - lastAttempt.at) / DAY_MS);
      if (ageDays >= 0 && ageDays < STUDIO_EMPTY_SETUP_COOLDOWN_DAYS) {
        return {
          action: "reuse",
          reason:
            `a setup ${ageDays} day(s) ago stored no templates, so this run uses the bundled archetypes rather than re-paying the setup bill — ` +
            `the next attempt is ${STUDIO_EMPTY_SETUP_COOLDOWN_DAYS - ageDays} day(s) away, or immediately with refreshTemplates`,
          rows,
          archetypeIds,
          staleArchetypeIds,
          freshArchetypeIds,
        };
      }
    }
    return { action: "generate", reason: "no studio templates for this client yet — generating the first set", rows, archetypeIds, staleArchetypeIds, freshArchetypeIds };
  }
  if (stale.length === rows.length) {
    return {
      action: "generate",
      reason: `all ${rows.length} studio template(s) are past the ${STUDIO_TTL_DAYS}-day TTL (or carry no readable date) — regenerating the set`,
      rows,
      archetypeIds,
      staleArchetypeIds,
      freshArchetypeIds,
    };
  }
  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length === 0) {
    return {
      action: "awaiting-approval",
      reason: `${rows.length} studio template(s) are stored but none is approved yet — this run renders on the bundled archetypes, and the set is on the review gate for approval`,
      rows,
      archetypeIds,
      staleArchetypeIds,
      freshArchetypeIds,
    };
  }
  return {
    action: "reuse",
    reason: `${enabled.length} approved studio template(s) for ${enabled.map((r) => r.archetypeId).join(", ")}, newest ${Math.min(...enabled.map((r) => (Number.isNaN(r.ageDays) ? STUDIO_TTL_DAYS : r.ageDays)))} day(s) old`,
    rows,
    archetypeIds,
    staleArchetypeIds,
    freshArchetypeIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. `00c2` — reading what actually performs, and SAYING WHAT WAS MISSING
// ─────────────────────────────────────────────────────────────────────────

/** One reference post, structurally the `SocialHistoryPost` `research.socialHistory` returns (declared here so this package takes no dependency on the research tool package). */
export interface StudioReferencePost {
  platform: string;
  username: string;
  url: string;
  excerpt: string;
  publishedAt?: string | undefined;
  engagement?: { likes?: number | undefined; comments?: number | undefined; views?: number | undefined } | undefined;
}

/** The three engagement fields `research.socialHistory` can return, in a fixed order so a row's `signalsAvailable` is deterministic. */
export const ENGAGEMENT_SIGNALS = ["likes", "comments", "views"] as const;
export type EngagementSignal = (typeof ENGAGEMENT_SIGNALS)[number];

export interface FormatEvidenceRow {
  /** The ranker's own label — never a claim about a platform's taxonomy. */
  format: string;
  accounts: string[];
  postCount: number;
  /**
   * Per-account z-normalised engagement, averaged across accounts.
   *
   * ABSENT when no numeric field existed for any post in this row. Optional
   * on purpose: the only way to produce a number you were not given is to
   * invent one.
   */
  normalisedScore?: number;
  signalsAvailable: EngagementSignal[];
  /** Named, not counted: "views absent for 4 of 6 accounts". */
  signalsAbsent: string[];
  exampleUrls: string[];
}

/**
 * How few posts an account can contribute before its z-scores are called out
 * as weak. Two posts give a standard deviation; they do not give a
 * distribution.
 */
const MIN_POSTS_FOR_STRONG_Z = 3;

/** Up to six example URLs travel per row — enough for a designer to look, not enough to turn the prompt into a link dump. */
const MAX_EXAMPLE_URLS = 6;

/**
 * The format detectors, in order — FIRST MATCH WINS, which is why the order
 * is part of the contract.
 *
 * These are deliberately coarse and deliberately honest: the label is "what
 * this ranker calls the shape of the text", not a claim about what the
 * platform or the account owner would call it. `LEADS_WITH_FIGURE` is reused
 * from the render-rule module rather than re-written, so "this post opens on
 * a number" means the same thing to the studio and to `07h`.
 *
 * Hebrew tokens sit beside the Latin ones because Hebrew is a first-class
 * target language here (client `geektime`) and a detector that only reads
 * English would silently classify every Hebrew post as "single statement".
 */
const FORMAT_DETECTORS: ReadonlyArray<{ label: string; test: (text: string) => boolean }> = [
  {
    label: "numbered list",
    // The Hebrew alternative deliberately has no trailing `\b`: JavaScript's
    // word boundary is ASCII-only, so a Hebrew letter followed by a space is
    // NOT a boundary and `\b` there can never match.
    test: (t) => /^\s*\d+[).:]/.test(t) || /\b\d+\s+(ways|things|lessons|tips|reasons|mistakes|steps|rules)\b/i.test(t) || /(^|\s)\d+\s+(דרכים|טיפים|סיבות|טעויות|שלבים|כללים|דברים)/u.test(t),
  },
  { label: "stat-led", test: (t) => LEADS_WITH_FIGURE.test(t) || /\d+(\.\d+)?\s?%/.test(t.slice(0, 120)) },
  { label: "quote", test: (t) => /^\s*["“”'«]/.test(t) || /["“][^"”]{20,}["”]\s*[—–-]\s*\S/u.test(t) },
  { label: "how-to", test: (t) => /\bhow (to|we|i)\b/i.test(t) || /\b(step-by-step|playbook)\b/i.test(t) || /(איך |כך )/u.test(t) },
  { label: "question", test: (t) => /[?؟]/u.test(t.slice(0, 160)) },
  { label: "announcement", test: (t) => /\b(launching|launched|introducing|announcing|now available|we shipped|new:)\b/i.test(t) || /(משיקים|השקנו|חדש:)/u.test(t) },
  { label: "behind the scenes", test: (t) => /\b(behind the scenes|we tried|our team|lessons from|what we learned)\b/i.test(t) || /(מאחורי הקלעים|מה למדנו)/u.test(t) },
];

const FALLBACK_FORMAT_LABEL = "single statement";

/** Which format a post's text reads as. Pure and total — every post lands somewhere, so no post is silently dropped from the evidence. */
export function classifyPostFormat(excerpt: string): string {
  const text = excerpt.trim();
  for (const detector of FORMAT_DETECTORS) {
    if (detector.test(text)) return detector.label;
  }
  return FALLBACK_FORMAT_LABEL;
}

function accountKey(post: StudioReferencePost): string {
  return `${post.platform}/@${post.username.replace(/^@/, "").toLowerCase()}`;
}

function signalValue(post: StudioReferencePost, signal: EngagementSignal): number | undefined {
  const raw = post.engagement?.[signal];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * Rank the formats the brief's reference accounts actually post in — and
 * state plainly which engagement signals were available and which were not.
 *
 * ## Why the normalisation is PER ACCOUNT
 *
 * Absolute likes across accounts of different sizes is not a comparison. A
 * 400k-follower account's most ordinary post out-likes a 3k-follower
 * account's best post by an order of magnitude, so an absolute ranking would
 * simply rediscover which reference account is biggest and design six
 * templates for its house style. Each account's posts are z-scored against
 * that account's OWN distribution first; a format's score is then the mean of
 * the per-account means, so every account gets one vote.
 *
 * ## Why `normalisedScore` is optional and `signalsAbsent` is not
 *
 * `research.socialHistory` returns `engagement { likes?, comments?, views? }`
 * and only for x/instagram/reddit/tiktok. Whole accounts come back with no
 * numeric field at all. A shape that required a score would force this
 * function to invent one; a shape that requires the ABSENCE list forces it to
 * say what it did not have. With no numeric field anywhere the rows carry no
 * score and the notes say the ranking is qualitative — which is a usable
 * answer, just not the one a dashboard would prefer.
 */
export function rankReferenceFormats(posts: readonly StudioReferencePost[]): { rows: FormatEvidenceRow[]; notes: string[] } {
  const notes: string[] = [];
  const usable = posts.filter((p) => typeof p.excerpt === "string" && p.excerpt.trim().length > 0);
  if (usable.length === 0) {
    notes.push("no readable reference posts — the design brief has to work from the brand kit, the client brief and the client's own site alone");
    return { rows: [], notes };
  }

  // Per (account, signal) distribution, over the posts that actually carry
  // that signal. A standard deviation of 0 (one post, or identical figures)
  // yields z = 0 for every post: no information, and no fake spread.
  const byAccount = new Map<string, StudioReferencePost[]>();
  for (const post of usable) {
    const key = accountKey(post);
    const bucket = byAccount.get(key);
    if (bucket) bucket.push(post);
    else byAccount.set(key, [post]);
  }

  const stats = new Map<string, { mean: number; sd: number }>();
  for (const [account, accountPosts] of byAccount) {
    for (const signal of ENGAGEMENT_SIGNALS) {
      const values = accountPosts.map((p) => signalValue(p, signal)).filter((v): v is number => v !== undefined);
      if (values.length === 0) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      stats.set(`${account}|${signal}`, { mean, sd: Math.sqrt(variance) });
    }
  }

  /** A post's engagement as the mean of its available per-signal z-scores, or `undefined` when it carried no numeric field. */
  const zOf = (post: StudioReferencePost): number | undefined => {
    const account = accountKey(post);
    const zs: number[] = [];
    for (const signal of ENGAGEMENT_SIGNALS) {
      const value = signalValue(post, signal);
      if (value === undefined) continue;
      const stat = stats.get(`${account}|${signal}`);
      if (stat === undefined) continue;
      zs.push(stat.sd > 0 ? (value - stat.mean) / stat.sd : 0);
    }
    return zs.length === 0 ? undefined : zs.reduce((a, b) => a + b, 0) / zs.length;
  };

  const groups = new Map<string, StudioReferencePost[]>();
  for (const post of usable) {
    const label = classifyPostFormat(post.excerpt);
    const bucket = groups.get(label);
    if (bucket) bucket.push(post);
    else groups.set(label, [post]);
  }

  const rows: FormatEvidenceRow[] = [];
  for (const [format, groupPosts] of groups) {
    const accounts = [...new Set(groupPosts.map(accountKey))].sort();
    // One vote per account: the mean of each account's own post z-scores,
    // then the mean of those.
    const perAccount: number[] = [];
    for (const account of accounts) {
      const zs = groupPosts.filter((p) => accountKey(p) === account).map(zOf).filter((z): z is number => z !== undefined);
      if (zs.length > 0) perAccount.push(zs.reduce((a, b) => a + b, 0) / zs.length);
    }
    const signalsAvailable = ENGAGEMENT_SIGNALS.filter((signal) => groupPosts.some((p) => signalValue(p, signal) !== undefined));
    const signalsAbsent: string[] = [];
    for (const signal of ENGAGEMENT_SIGNALS) {
      const without = accounts.filter((account) => !groupPosts.some((p) => accountKey(p) === account && signalValue(p, signal) !== undefined));
      if (without.length > 0) signalsAbsent.push(`${signal} absent for ${without.length} of ${accounts.length} accounts (${without.join(", ")})`);
    }
    rows.push({
      format,
      accounts,
      postCount: groupPosts.length,
      ...(perAccount.length > 0 ? { normalisedScore: Math.round((perAccount.reduce((a, b) => a + b, 0) / perAccount.length) * 1000) / 1000 } : {}),
      signalsAvailable: [...signalsAvailable],
      signalsAbsent,
      exampleUrls: groupPosts.map((p) => p.url).filter((u) => typeof u === "string" && u.length > 0).slice(0, MAX_EXAMPLE_URLS),
    });
  }

  // Score desc (unscored last), then the frequency, then the label — a total
  // order, so the same evidence always produces the same brief.
  rows.sort((a, b) => {
    const sa = a.normalisedScore;
    const sb = b.normalisedScore;
    if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
    if (sa !== undefined && sb === undefined) return -1;
    if (sa === undefined && sb !== undefined) return 1;
    if (a.postCount !== b.postCount) return b.postCount - a.postCount;
    return a.format.localeCompare(b.format);
  });

  const scored = rows.filter((r) => r.normalisedScore !== undefined).length;
  if (scored === 0) {
    notes.push(
      "no numeric engagement field was returned for any post — this ranking is QUALITATIVE (format frequency only) and must not be described as a performance ranking",
    );
  }
  const withoutFigures = usable.filter((p) => ENGAGEMENT_SIGNALS.every((s) => signalValue(p, s) === undefined)).length;
  if (withoutFigures > 0 && scored > 0) {
    notes.push(`${withoutFigures} of ${usable.length} posts carried no engagement figures and count toward frequency only`);
  }
  if (byAccount.size === 1) {
    notes.push(
      `every post came from 1 account (${[...byAccount.keys()][0]}) — per-account normalisation cannot compare across accounts, so these scores rank within that one account only`,
    );
  }
  const thin = [...byAccount.entries()].filter(([, p]) => p.length < MIN_POSTS_FOR_STRONG_Z).map(([account, p]) => `${account} (${p.length})`);
  if (thin.length > 0) {
    notes.push(`fewer than ${MIN_POSTS_FOR_STRONG_Z} posts from ${thin.join(", ")} — a z-score over so few posts is weak evidence`);
  }
  return { rows, notes };
}

/**
 * The evidence block, verbatim, as the design-brief and designer calls
 * receive it — and as `assertNoInventedMetrics` checks a citation against.
 *
 * One function, two readers, deliberately: if the block the model saw and the
 * block the assertion checks could differ, the assertion would be theatre.
 */
export function formatEvidenceBlock(rows: readonly FormatEvidenceRow[], notes: readonly string[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      `- ${row.format}: ${row.postCount} post(s) across ${row.accounts.length} account(s) [${row.accounts.join(", ")}]; ` +
        (row.normalisedScore !== undefined ? `per-account normalised score ${row.normalisedScore}` : "NO SCORE (no numeric engagement field)") +
        `; signals available: ${row.signalsAvailable.length > 0 ? row.signalsAvailable.join(", ") : "none"}` +
        (row.signalsAbsent.length > 0 ? `; signals absent: ${row.signalsAbsent.join("; ")}` : "") +
        (row.exampleUrls.length > 0 ? `; examples: ${row.exampleUrls.join(" ")}` : ""),
    );
  }
  if (lines.length === 0) lines.push("- no format evidence at all");
  for (const note of notes) lines.push(`- NOTE: ${note}`);
  return lines.join("\n");
}

/** Any numeric claim, with an optional unit — the shape a fabricated metric takes ("3.2x more saves", "40% higher"). */
const NUMERIC_CLAIM = /\d+(?:\.\d+)?\s*(?:%|x|k|m)?/gi;

const squash = (value: string): string => value.replace(/\s+/g, "").toLowerCase();

/**
 * Refuses a `derivedFrom.why` that cites a number the evidence never
 * contained.
 *
 * The second of the two invented-metric defences (the first is the schema:
 * optional score, required absence list). A model handed an honest evidence
 * block will still, given the chance, write "carousels get 3.2x more saves"
 * because that sentence is what this genre of copy sounds like. Every numeric
 * token in the citation must appear verbatim in the block the model was
 * given — whitespace-insensitively, so "3.2 x" in the evidence covers "3.2x"
 * in the claim, and nothing else does.
 *
 * Strict on purpose, including years and counts: a number that is right by
 * luck is still a number nobody sourced.
 */
export function assertNoInventedMetrics(citation: string, evidenceBlock: string): { ok: true } | { ok: false; reason: string } {
  const haystack = squash(evidenceBlock);
  for (const match of citation.matchAll(NUMERIC_CLAIM)) {
    const token = match[0];
    if (!haystack.includes(squash(token))) {
      return {
        ok: false,
        reason: `the citation claims "${token.trim()}", which does not appear anywhere in the evidence this call was given — a metric that was not measured must not be stated`,
      };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. The three agent contracts (00c3 design brief, 00c4/00c7 designer,
//    00c6 set review) and the inputs code hands them
// ─────────────────────────────────────────────────────────────────────────

/**
 * What paints the template's ground layer.
 *
 * `image` is the only value that licenses `{{image:hero}}`, and that link is
 * gate 3: a cover claiming a photographic ground must actually read a hero,
 * and one claiming a colour block must not smuggle an image slot it has no
 * source for.
 */
export const StudioGroundSchema = z.enum(["image", "colour-block", "gradient", "flat"]);
export type StudioGround = z.infer<typeof StudioGroundSchema>;

export const StudioRoleSchema = z.enum(["cover", "interior", "closer"]);

/** The evidence a designer must attach to its own template. Mirrors `TemplateDerivedFromSchema` in `karos-templates`, which is the authority for the stored row. */
export const StudioDerivedFromSchema = z.object({
  formatLabel: z.string().min(1).max(80),
  accounts: z.array(z.string().min(1)).max(8).default([]),
  postCount: z.number().int().nonnegative().default(0),
  normalisedScore: z.number().optional(),
  signalsAvailable: z.array(z.string().min(1)).max(3).default([]),
  signalsAbsent: z.array(z.string().min(1)).max(6).default([]),
  exampleUrls: z.array(z.string().min(1)).max(MAX_EXAMPLE_URLS).default([]),
  /** One paragraph: why THIS layout for THAT measured format. Checked by `assertNoInventedMetrics`. */
  why: z.string().min(1).max(400),
});
export type StudioDerivedFrom = z.infer<typeof StudioDerivedFromSchema>;

/**
 * One template, as the designer agent returns it.
 *
 * A FRAGMENT and a STYLESHEET, never a document: `buildStudioTemplateDocument`
 * writes the doctype, the head, the token block, the fixed canvas and the
 * `window.__CAROUSEL_READY__` script. That split is not ceremony — the
 * ready-flag script is what the renderer waits for, and a model that can
 * author it can also author a script that never sets it, or one that fetches.
 */
export const StudioTemplateDraftSchema = z.object({
  /** One of the eight routable ids (gate 1). A new id would be a routing dead end. */
  archetypeId: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
  role: StudioRoleSchema,
  layoutType: z.enum(["photo", "typographic"]),
  ground: StudioGroundSchema,
  /** The slots this template reads, `{{slot}}`-shaped names only. */
  slots: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).min(1).max(10),
  bodyHtml: z.string().min(1).max(6000),
  css: z.string().min(1).max(8000),
  /** The designer's own sample values, one per declared slot (gate 2). The RENDER uses code-built content instead (gate 5). */
  sample: z.record(z.string(), z.string().max(600)),
  derivedFrom: StudioDerivedFromSchema,
});
export type StudioTemplateDraft = z.infer<typeof StudioTemplateDraftSchema>;

/** `00c3-write-design-brief` — the format thesis every designer call reads. */
export const StudioDesignBriefOutputSchema = z.object({
  /** Two or three sentences: what this client's feed should look like, and why, given the evidence. */
  thesis: z.string().min(1).max(1200),
  templates: z
    .array(
      z.object({
        archetypeId: z.string().min(1).max(40),
        role: StudioRoleSchema,
        /** The measured format this template implements, by the label the evidence block used. */
        formatLabel: z.string().min(1).max(80),
        ground: StudioGroundSchema,
        /** Why this client should run this archetype. Checked by `assertNoInventedMetrics`. */
        why: z.string().min(1).max(400),
      }),
    )
    .min(2)
    .max(8),
  /** The rules that make the set read as ONE system: type roles, accent discipline, ground policy. */
  setRules: z.array(z.string().min(1).max(300)).min(1).max(10),
  signalsAvailable: z.array(z.string().min(1)).max(3).default([]),
  /** What the evidence did NOT have. Required by the schema so it cannot be quietly omitted. */
  signalsAbsent: z.array(z.string().min(1)).max(8),
  gaps: z.array(z.string().min(1).max(200)).max(8).default([]),
});
export type StudioDesignBriefOutput = z.infer<typeof StudioDesignBriefOutputSchema>;

/** `00c6-review-template-set` — the residue only: does the set read as one system? */
export const StudioSetReviewOutputSchema = z.object({
  perTemplate: z
    .array(
      z.object({
        archetypeId: z.string().min(1).max(40),
        verdict: z.enum(["keep", "repair", "drop"]),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(8),
  /** One note on the set as a whole. */
  setNote: z.string().min(1).max(600),
});
export type StudioSetReviewOutput = z.infer<typeof StudioSetReviewOutputSchema>;

/** Per-document/per-page ceilings on what reaches a setup call. A setup is one bounded bill, not a per-client lottery. */
const STUDIO_INPUT_PAGE_CHARS = 2500;
const STUDIO_INPUT_IMAGE_NOTES = 12;

/** What `00c2` gathered, each field empty when that read found nothing. Nothing here is required: a client with only a brief still gets a set. */
export interface StudioEvidenceBundle {
  clientSlug: string;
  brief?: ClientBrief | undefined;
  /** `--bg`/`--fg`/`--accent`/`--f-*` as the brand kit resolved them, plus the accent ring. */
  kit?: { cssVars: Record<string, string>; palette?: readonly string[] } | undefined;
  sitePages?: ReadonlyArray<{ url: string; title?: string | undefined; text: string }> | undefined;
  referenceFormats?: { rows: readonly FormatEvidenceRow[]; notes: readonly string[] } | undefined;
  /** `media.inspectImages` descriptions of reference-post images — the designer reads DESCRIPTIONS, never competitors' pixels. */
  imageNotes?: readonly string[] | undefined;
  /** The resolved target language, when there is one. Drives gate 8. */
  targetLanguage?: string | undefined;
  /** Named shortfalls from the gather step: an unreadable account, no scraper at all, consent withheld. */
  problems?: readonly string[] | undefined;
}

export interface StudioDesignBriefInput {
  channel: "instagram";
  clientSlug: string;
  templatesWanted: number;
  routableArchetypes: readonly string[];
  slotsByArchetype: Readonly<Record<string, readonly string[]>>;
  positioning?: string;
  icp?: string;
  coreTerms?: string[];
  forbiddenTopics?: string[];
  targetLanguage?: string;
  brandTokens?: Record<string, string>;
  accentRing?: string[];
  sitePages: Array<{ url: string; title?: string; text: string }>;
  /** The verbatim block `assertNoInventedMetrics` checks every citation against. */
  formatEvidence: string;
  referenceImageNotes: string[];
  gaps: string[];
}

const clamp = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max)}…`);

/**
 * Hand-assembles the design-brief call's whole input.
 *
 * Every source is gathered by `00c2` and clamped here, which is what makes
 * `00c3` a fixed one-call bill (`allowedTools: []`, `maxSteps: 1`) rather
 * than an open-ended research loop. `gaps` carries what could not be read
 * verbatim, so the thesis names the same shortfalls instead of designing
 * around a hole it cannot see.
 */
export function buildDesignBriefInput(bundle: StudioEvidenceBundle, templatesWanted: number): { input: StudioDesignBriefInput; gaps: string[] } {
  const gaps: string[] = [...(bundle.problems ?? [])];
  const brief = bundle.brief;
  if (brief === undefined) gaps.push("no persisted client brief — the thesis rests on the brand kit and the site alone");
  const rows = bundle.referenceFormats?.rows ?? [];
  const notes = bundle.referenceFormats?.notes ?? [];
  if (rows.length === 0) gaps.push("no reference-account posts could be read — no measured format evidence for this niche");
  if (bundle.kit === undefined) gaps.push("no brand kit on file — the templates must work on the engine's default tokens");
  const sitePages = (bundle.sitePages ?? [])
    .filter((p) => typeof p.text === "string" && p.text.trim().length > 0)
    .map((p) => ({ url: p.url, ...(p.title ? { title: p.title } : {}), text: clamp(p.text.trim(), STUDIO_INPUT_PAGE_CHARS) }));
  if (sitePages.length === 0) gaps.push("the client's own site could not be read");
  const imageNotes = (bundle.imageNotes ?? []).slice(0, STUDIO_INPUT_IMAGE_NOTES).map((n) => clamp(n, 400));
  if (imageNotes.length === 0) gaps.push("no reference-post images were inspected — formats were ranked from post text alone");

  return {
    gaps,
    input: {
      channel: "instagram",
      clientSlug: bundle.clientSlug,
      templatesWanted,
      routableArchetypes: ROUTABLE_ARCHETYPE_IDS,
      slotsByArchetype: SLOTS_BY_ARCHETYPE,
      ...(brief !== undefined ? { positioning: clamp(`${brief.positioning.oneLiner} ${brief.positioning.whatWeSell}`.trim(), 600) } : {}),
      ...(brief !== undefined ? { icp: clamp([brief.icp.summary, ...brief.icp.pains].filter((s) => s.length > 0).join("; "), 400) } : {}),
      ...(brief !== undefined ? { coreTerms: [...brief.coreTerms].slice(0, 12) } : {}),
      ...(brief !== undefined && brief.forbidden.topics.length > 0 ? { forbiddenTopics: [...brief.forbidden.topics].slice(0, 12) } : {}),
      ...(bundle.targetLanguage !== undefined ? { targetLanguage: bundle.targetLanguage } : {}),
      ...(bundle.kit !== undefined ? { brandTokens: { ...bundle.kit.cssVars } } : {}),
      ...(bundle.kit?.palette !== undefined ? { accentRing: [...bundle.kit.palette] } : {}),
      sitePages,
      formatEvidence: formatEvidenceBlock(rows, notes),
      referenceImageNotes: imageNotes,
      gaps,
    },
  };
}

/** One planned template: which routable archetype, at which role, deriving from which measured format. */
export interface PlannedStudioTemplate {
  archetypeId: string;
  role: StudioRole;
  formatLabel: string;
  ground: StudioGround;
  why: string;
}

export interface StudioPlan {
  templates: PlannedStudioTemplate[];
  /** Entries the thesis asked for that code refused, each with the reason. Reported, never thrown. */
  rejected: Array<{ archetypeId: string; reason: string }>;
}

/**
 * Turn the design brief's proposal into the exact list `00c4` will author,
 * enforcing every constraint code owns rather than trusting the thesis:
 * routable ids only, one row per archetype, at most `budgetTemplates` of
 * them, and the role the archetype is actually judged at.
 *
 * A thesis that names nine templates or invents `split_diagonal` does not
 * fail the setup — the offending entries are recorded in `rejected` and the
 * rest are authored. The bundled eight are underneath either way.
 */
export function planStudioTemplates(
  brief: Pick<StudioDesignBriefOutput, "templates">,
  options: { budgetTemplates: number; existingArchetypeIds?: readonly string[] },
): StudioPlan {
  const taken = new Set(options.existingArchetypeIds ?? []);
  const templates: PlannedStudioTemplate[] = [];
  const rejected: StudioPlan["rejected"] = [];
  for (const entry of brief.templates) {
    if (!ROUTABLE_ARCHETYPE_IDS.includes(entry.archetypeId)) {
      rejected.push({
        archetypeId: entry.archetypeId,
        reason: `"${entry.archetypeId}" is not one of the eight routable archetype ids (${ROUTABLE_ARCHETYPE_IDS.join(", ")}) — nothing in the workflow could ever route a slide to it`,
      });
      continue;
    }
    if (taken.has(entry.archetypeId)) {
      rejected.push({ archetypeId: entry.archetypeId, reason: `this client already has a studio template for "${entry.archetypeId}" — at most one per (client, archetype)` });
      continue;
    }
    if (templates.length >= Math.max(0, Math.floor(options.budgetTemplates))) {
      rejected.push({ archetypeId: entry.archetypeId, reason: `the setup budget allows ${options.budgetTemplates} template(s) this setup` });
      continue;
    }
    taken.add(entry.archetypeId);
    templates.push({
      archetypeId: entry.archetypeId,
      // The role the archetype is JUDGED at wins over the thesis's own
      // opinion: a `cover` row graded as an interior slide would be exempt
      // from the one clause covers exist to satisfy.
      role: ROLE_BY_ARCHETYPE[entry.archetypeId] ?? entry.role,
      formatLabel: entry.formatLabel,
      ground: entry.ground,
      why: entry.why,
    });
  }
  return { templates, rejected };
}

export interface StudioDesignerInput {
  channel: "instagram";
  clientSlug: string;
  archetypeId: string;
  role: StudioRole;
  formatLabel: string;
  ground: StudioGround;
  why: string;
  /** The slots `contentFor` can supply for THIS archetype — the only names the template may read. */
  availableSlots: readonly string[];
  standingFurniture: readonly string[];
  privilegedImageSlots: readonly string[];
  privilegedHtmlSlots: readonly string[];
  thesis: string;
  setRules: readonly string[];
  formatEvidence: string;
  brandTokens?: Record<string, string>;
  targetLanguage?: string;
  scriptFamilies?: { display: readonly string[]; body: readonly string[]; typeScale: number };
  canvas: { width: number; height: number };
  /** Present on a REPAIR call only: the gates that refused, with their measured numbers verbatim. */
  repairFindings?: string[];
  previous?: { bodyHtml: string; css: string };
}

/** The canvas every slide document is built at. Fixed: `validateRenderInputs` accepts `canvas.scale: 2` and nothing else, so every measured PNG is 2160x2880. */
export const STUDIO_CANVAS = { width: 1080, height: 1440 } as const;

/**
 * Hand-assembles one designer call's input — one call per template, never one
 * for the set.
 *
 * That is a cost decision with a quality reason: at ~$0.051 a call, six calls
 * cost $0.31 of a $2.00 budget, and in exchange a schema failure or a refused
 * gate costs ONE template instead of six. It also gives each template the
 * whole context window for one layout rather than a sixth of it.
 */
export function buildDesignerInput(input: {
  planned: PlannedStudioTemplate;
  brief: Pick<StudioDesignBriefOutput, "thesis" | "setRules">;
  bundle: StudioEvidenceBundle;
  repair?: { findings: readonly string[]; previous: { bodyHtml: string; css: string } } | undefined;
}): StudioDesignerInput {
  const script = scriptTypographyFor(input.bundle.targetLanguage);
  return {
    channel: "instagram",
    clientSlug: input.bundle.clientSlug,
    archetypeId: input.planned.archetypeId,
    role: input.planned.role,
    formatLabel: input.planned.formatLabel,
    ground: input.planned.ground,
    why: input.planned.why,
    availableSlots: SLOTS_BY_ARCHETYPE[input.planned.archetypeId] ?? [],
    standingFurniture: [...STANDING_FURNITURE_SLOTS],
    privilegedImageSlots: PRIVILEGED_IMAGE_SLOTS,
    privilegedHtmlSlots: PRIVILEGED_HTML_SLOTS,
    thesis: input.brief.thesis,
    setRules: input.brief.setRules,
    formatEvidence: formatEvidenceBlock(input.bundle.referenceFormats?.rows ?? [], input.bundle.referenceFormats?.notes ?? []),
    ...(input.bundle.kit !== undefined ? { brandTokens: { ...input.bundle.kit.cssVars } } : {}),
    ...(input.bundle.targetLanguage !== undefined ? { targetLanguage: input.bundle.targetLanguage } : {}),
    ...(script !== undefined
      ? { scriptFamilies: { display: script.spec.display, body: script.spec.body, typeScale: script.spec.typeScale } }
      : {}),
    canvas: { ...STUDIO_CANVAS },
    ...(input.repair !== undefined ? { repairFindings: [...input.repair.findings], previous: input.repair.previous } : {}),
  };
}

export interface StudioSetReviewInput {
  channel: "instagram";
  clientSlug: string;
  thesis: string;
  setRules: readonly string[];
  templates: Array<{
    archetypeId: string;
    role: StudioRole;
    formatLabel: string;
    /** What `media.inspectImages` saw in OUR OWN rendered sample. The review grades what the designer produced, not only what it read. */
    sampleDescription?: string;
    measured?: Record<string, number>;
  }>;
}

/** Hand-assembles the Flash set-review call. Cheap because the factual half is already answered: the eight gates ran, and their numbers travel with each row. */
export function buildSetReviewInput(input: {
  clientSlug: string;
  brief: Pick<StudioDesignBriefOutput, "thesis" | "setRules">;
  validated: ReadonlyArray<{ draft: StudioTemplateDraft; validation: StudioTemplateValidation; sampleDescription?: string | undefined }>;
}): StudioSetReviewInput {
  return {
    channel: "instagram",
    clientSlug: input.clientSlug,
    thesis: input.brief.thesis,
    setRules: input.brief.setRules,
    templates: input.validated.map((row) => ({
      archetypeId: row.draft.archetypeId,
      role: row.draft.role,
      formatLabel: row.draft.derivedFrom.formatLabel,
      ...(row.sampleDescription !== undefined ? { sampleDescription: row.sampleDescription } : {}),
      ...(row.validation.ltr !== undefined ? { measured: measuredSummary(row.validation.ltr.metrics, row.validation.ltr.margin) } : {}),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Sample content, built BY CODE
// ─────────────────────────────────────────────────────────────────────────

/**
 * The strings the validation render fills a template with.
 *
 * Built by code from the client's own brief, never by the model — gate 5's
 * whole point. A template handed copy its own author chose can pass by
 * flattery: a two-word headline in a layout that breaks at eight words
 * measures beautifully. Code fills every declared slot with content of a
 * KNOWN, TYPICAL length, so the render measures the template rather than the
 * sample.
 */
export interface StudioSampleSeed {
  /** A short line for a title/headline slot — 6 to 10 words is the carousel's own norm. */
  headline: string;
  /** Two sentences for a body slot. */
  body: string;
  eyebrow: string;
  figure: string;
  figureLabel: string;
  source: string;
  quote: string;
  attribution: string;
  items: string[];
  comparison: { leftLabel: string; leftBody: string; rightLabel: string; rightBody: string };
  takeaway: string;
  cta: string;
  question: string;
  accentHex: string;
  brandHandle: string;
  seriesBadge: string;
  /** A repo-relative image path for a `hero` slot, when the caller has one. Absent means the ground layer must hold the frame on its own. */
  heroPath?: string | undefined;
  dir: "ltr" | "rtl";
  /**
   * Phase 4, RFC-15 §7.2 — the BCP-47 tag for the document's `{{lang}}` slot.
   *
   * Optional, and absent fills `"en"`: that is the literal every template and
   * the code-written shell carried before this phase, so a caller that knows
   * nothing about the language renders exactly what it rendered before.
   */
  lang?: string | undefined;
}

/**
 * A glyph-coverage probe per script, used ONLY when the client's own brief
 * carries no text in their target script.
 *
 * Not content and never shipped: gate 8 asks whether the script's font
 * actually loaded and whether real glyphs painted (`textShare > 0`), which
 * needs characters in that script and nothing more. A Latin sample would pass
 * gate 8 while telling us nothing, which is the failure mode this exists to
 * remove — the prep audit's Hebrew-in-a-Latin-font defect had no symptom for
 * exactly that reason.
 */
export const SCRIPT_GLYPH_PROBE: Readonly<Record<string, string>> = {
  Hebrew: "כותרת לדוגמה לבדיקת גופן",
  Arabic: "عنوان تجريبي لاختبار الخط",
  Greek: "Δοκιμαστικός τίτλος γραμματοσειράς",
  Cyrillic: "Пробный заголовок для шрифта",
  Devanagari: "फ़ॉन्ट परीक्षण शीर्षक",
  Thai: "หัวข้อทดสอบฟอนต์",
  Armenian: "Տառատեսակի փորձնական վերնագիր",
  Georgian: "შრიფტის სატესტო სათაური",
  Japanese: "フォント確認用の見出し",
  Korean: "폰트 확인용 제목",
  Chinese: "字体测试标题",
};

/** Words of a brief sentence that make a sample headline — long enough to wrap once at display size, which is where a layout breaks. */
const SAMPLE_HEADLINE_WORDS = 9;

function firstSentence(text: string | undefined, fallback: string): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return fallback;
  const match = /^[^.!?׃…]+[.!?…]?/u.exec(trimmed);
  return (match?.[0] ?? trimmed).trim();
}

function firstWords(text: string, words: number): string {
  const parts = text.split(/\s+/u).filter((w) => w.length > 0);
  return parts.slice(0, words).join(" ");
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((w) => w.length > 0).length;
}

/**
 * THE SHAPE GATE 8 HAS NEVER MEASURED (Phase 4, RFC-15 §7.4).
 *
 * Every RTL seed until now was Hebrew and nothing but Hebrew — the client's
 * own brief sentence, or `SCRIPT_GLYPH_PROBE`. So gate 8 has proved that the
 * script font loads and that pure Hebrew fits, and has never once rendered
 * the thing a real Hebrew tech post is actually made of: a Latin product
 * name mid-sentence, a parenthesised Latin acronym, a percentage and a year
 * range, all inside a Hebrew line.
 *
 * That shape is harder than either pure script on its own, in two ways the
 * existing seeds cannot expose:
 *
 *  1. It is the only shape the bidi isolates apply to, so it is the only one
 *     that measures the BYTES a real run renders (two extra characters per
 *     Latin run).
 *  2. `headline-focus.html` and `stat-callout.html` size display type from an
 *     in-page `textContent.length` breakpoint picked against Latin glyph
 *     widths. A mixed line moves that count, which can tip the slide onto a
 *     larger step — and the step that catches that is `probe.overflow`, which
 *     gate 8 already fails on.
 *
 * A template that clips this is the bug. The threshold is not.
 */
const MIXED_DIRECTION_SEED_RTL = {
  /** A Latin product name mid-sentence, ending in a full stop — the case that puts the period on the wrong side of the line. */
  headline: "גוגל השיקה את Gemini 3.",
  /** A parenthesised Latin acronym, a percentage and a year range in one Hebrew sentence. */
  body: "הדיפלוי של API v2 (GPT-4) ירד ב-38% בין 2020-2024, והצוות ממשיך למדוד.",
  /** A device/figure label, where the label sits under a numeral in a tight lockup. */
  deviceLabel: "שימוש ב-API v2, 2020-2024",
} as const;

/**
 * `base` with the mixed-direction fragment appended, held to the SAME word
 * budget the seed already used.
 *
 * Held to `maxWords` wherever there is room, so a longer seed cannot fail a
 * template for a LENGTH reason that has nothing to do with bidi. Two things
 * are never traded away for that budget, and `minBaseWords` is the floor that
 * says so: the mixed fragment is always present in full (it is the point),
 * and at least a couple of words of the base survive — the base is the
 * client's own script, and a seed with no in-script words left would stop
 * proving that the script font loaded, which is gate 8's other half.
 */
function withMixedDirection(base: string, mixed: string, maxWords: number, minBaseWords = 2): string {
  const keep = Math.max(maxWords - wordCount(mixed), minBaseWords);
  return `${firstWords(base, keep)} ${mixed}`.trim();
}

/**
 * Derive the sample seed from what this client's own brief and kit actually
 * say.
 *
 * `dir: "rtl"` (gate 8) switches the text source: the brief's own words when
 * they are in the target script, the script probe when they are not. That
 * distinction matters because a Hebrew client whose brief happens to be
 * written in English would otherwise be RTL-validated with Latin glyphs.
 *
 * Phase 4 adds two things to the RTL half, both so gate 8 measures what a
 * real run renders rather than an easier cousin of it: the mixed-direction
 * fragment (`MIXED_DIRECTION_SEED_RTL`), and the SAME bidi isolates
 * `contentFor` composes into a real slide. Neither touches the LTR seed, so
 * an English client's studio render is byte-identical to before.
 */
export function studioSampleSeedFromBrief(input: {
  brief?: ClientBrief | undefined;
  kit?: { cssVars: Record<string, string>; palette?: readonly string[] } | undefined;
  clientSlug: string;
  targetLanguage?: string | undefined;
  dir?: "ltr" | "rtl";
  heroPath?: string | undefined;
  /** The BCP-47 tag for the `{{lang}}` slot, injected by the caller (the language brief owns the resolution). Absent fills `"en"`. */
  bcp47?: string | undefined;
}): StudioSampleSeed {
  const dir = input.dir ?? "ltr";
  const brief = input.brief;
  const positioning = firstSentence(brief?.positioning.oneLiner, `${input.clientSlug} helps its customers get one specific job done faster`);
  const icp = firstSentence(brief?.icp.summary, "the operator who owns this problem day to day");
  const term = brief?.coreTerms?.[0] ?? input.clientSlug;

  let headline = firstWords(positioning, SAMPLE_HEADLINE_WORDS);
  let body = `${positioning} ${icp}`.trim();
  let eyebrow = term;
  let figureLabel = firstWords(icp, 5);
  if (dir === "rtl") {
    const script = input.targetLanguage !== undefined ? resolveExpectedScript(input.targetLanguage) : undefined;
    const inScript = script !== undefined && script.test.test(positioning);
    if (!inScript) {
      const probe = script !== undefined ? SCRIPT_GLYPH_PROBE[script.name] : undefined;
      if (probe !== undefined) {
        headline = probe;
        body = `${probe} ${probe}`;
        eyebrow = probe.split(/\s+/u)[0] ?? probe;
      }
    }
    // Phase 4, RFC-15 §7.4 — headline, body and the device label each carry
    // the mixed-direction shape, held to their own existing word budget.
    // The headline keeps the seed's own named budget rather than whatever the
    // probe happened to be, so the full glyph probe survives in front of the
    // mixed fragment and gate 8's "did the script font load" half is intact.
    headline = withMixedDirection(headline, MIXED_DIRECTION_SEED_RTL.headline, SAMPLE_HEADLINE_WORDS);
    body = withMixedDirection(body, MIXED_DIRECTION_SEED_RTL.body, wordCount(body));
    figureLabel = withMixedDirection(figureLabel, MIXED_DIRECTION_SEED_RTL.deviceLabel, wordCount(figureLabel));
  }

  // The same isolation `contentFor` applies to a real slide's rendered text,
  // over the same scope: prose only. `figure` is excluded for the reason
  // `.num-figure` is excluded from `DISPLAY_SELECTORS` — a bare numeral in a
  // lockup. `accentHex` is a hex code, and `brandHandle`/`seriesBadge` are
  // standing furniture the templates already isolate with `<bdi>`.
  const iso = (text: string): string => isolateForeignRuns(text, dir);

  return {
    headline: iso(headline),
    body: iso(body),
    eyebrow: iso(eyebrow),
    figure: "63%",
    figureLabel: iso(figureLabel),
    source: iso("internal data, 2026"),
    quote: iso(firstWords(positioning, 14)),
    attribution: iso(`— ${input.clientSlug}`),
    items: [firstWords(positioning, 5), firstWords(icp, 5), firstWords(`${term} in practice`, 5)].map(iso),
    comparison: {
      leftLabel: iso("before"),
      leftBody: iso(firstWords(icp, 6)),
      rightLabel: iso("after"),
      rightBody: iso(firstWords(positioning, 6)),
    },
    takeaway: iso(firstWords(positioning, 7)),
    cta: dir === "rtl" ? "שמרו את הפוסט" : "Save this for your next planning round",
    question: dir === "rtl" ? "מה הייתם משנים?" : "Which of these would you change first?",
    accentHex: input.kit?.cssVars["--accent"] ?? input.kit?.palette?.[0] ?? "#C8FF4D",
    brandHandle: `@${input.clientSlug}`,
    seriesBadge: dir === "rtl" ? "מדריך" : "playbook",
    ...(input.heroPath !== undefined ? { heroPath: input.heroPath } : {}),
    dir,
    lang: input.bcp47 ?? "en",
  };
}

/** What a render is handed: the escaped fields, the raw html fragments, and any image paths. Mirrors `publish.renderCarousel`'s own slide shape. */
export interface StudioSampleContent {
  fields: Record<string, string>;
  htmlFragments: Record<string, string>;
  imagePaths: Record<string, string>;
}

/** A code-built device fragment for a `device` slot, so a template that declares one is measured WITH it. Deliberately minimal: item M's `slide-devices.ts` owns the real library. */
function sampleDeviceFragment(seed: StudioSampleSeed): string {
  return `<div class="device device-figure"><span class="device-figure-value">${seed.figure}</span><span class="device-figure-label">${escapeText(seed.figureLabel)}</span></div>`;
}

function sampleRecapFragment(seed: StudioSampleSeed): string {
  const plates = seed.items.map((item) => `<li class="recap-plate">${escapeText(item)}</li>`).join("");
  return `<ul class="recap-strip">${plates}</ul>`;
}

function sampleListRows(seed: StudioSampleSeed): string {
  return seed.items.map((item, i) => `<li class="list-row"><span class="list-index">${i + 1}</span><span class="list-text">${escapeText(item)}</span></li>`).join("");
}

/** The same escaping `fillTemplate` applies to a `{{slot}}` value — applied here because these fragments go in through the RAW `{{html:...}}` channel. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Fill every slot a draft declares with code-built content of typical length.
 *
 * Unknown slot names cannot reach here: gate 2 has already refused anything
 * outside `SLOTS_BY_ARCHETYPE`, so this switch is total over what survives.
 */
export function buildStudioSampleContent(draft: Pick<StudioTemplateDraft, "slots" | "archetypeId">, seed: StudioSampleSeed): StudioSampleContent {
  const fields: Record<string, string> = {
    accentColor: seed.accentHex,
    dir: seed.dir,
    // Phase 4, RFC-15 §7.2 — the shell's `{{lang}}`. A seed that carries no
    // tag fills `"en"`, which is the literal the shell hardcoded before.
    lang: seed.lang ?? "en",
    fontScale: "m",
    textAlign: "start",
    kicker: seed.eyebrow,
    brandHandle: seed.brandHandle,
    seriesBadge: seed.seriesBadge,
  };
  const htmlFragments: Record<string, string> = {};
  const imagePaths: Record<string, string> = {};

  for (const slot of draft.slots) {
    switch (slot) {
      case "headline":
      case "title":
        fields[slot] = seed.headline;
        break;
      case "subtitle":
      case "body":
        fields[slot] = seed.body;
        break;
      case "eyebrow":
        fields[slot] = seed.eyebrow;
        break;
      case "figure":
        fields[slot] = seed.figure;
        break;
      case "subLabel":
        fields[slot] = seed.figureLabel;
        break;
      case "sourceLine":
        fields[slot] = seed.source;
        break;
      case "quoteText":
        fields[slot] = seed.quote;
        break;
      case "attribution":
        fields[slot] = seed.attribution;
        break;
      case "leftLabel":
        fields[slot] = seed.comparison.leftLabel;
        break;
      case "leftBody":
        fields[slot] = seed.comparison.leftBody;
        break;
      case "rightLabel":
        fields[slot] = seed.comparison.rightLabel;
        break;
      case "rightBody":
        fields[slot] = seed.comparison.rightBody;
        break;
      case "takeaway":
        fields[slot] = seed.takeaway;
        break;
      case "cta":
        fields[slot] = seed.cta;
        break;
      case "question":
        fields[slot] = seed.question;
        break;
      case "itemRows":
        htmlFragments[slot] = sampleListRows(seed);
        break;
      case "device":
        htmlFragments[slot] = sampleDeviceFragment(seed);
        break;
      case "recap":
        htmlFragments[slot] = sampleRecapFragment(seed);
        break;
      case "hero":
        if (seed.heroPath !== undefined) imagePaths[slot] = seed.heroPath;
        break;
      default:
        // Unreachable while gate 2 runs first; a slot nobody can fill is a
        // hole, and reporting it beats rendering it.
        break;
    }
  }
  return { fields, htmlFragments, imagePaths };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. The eight gates
// ─────────────────────────────────────────────────────────────────────────

/** The measured pixel facts a validation render returns. Structurally the `SlideMetrics` `publish.renderCarousel` attaches when `measure: true`. */
export interface StudioSlideMetrics {
  backgroundHex: string;
  backgroundMatchesBrandGround: boolean;
  flatBackgroundShare: number;
  inkShare: number;
  occupiedShare: number;
  /** The content mask (`render-carousel` 1.2.0) — a decorative ground does not satisfy it, which is what stops gate 6 approving a template that renders as texture. */
  contentOccupiedShare: number;
  largestEmptyRect: { x: number; y: number; w: number; h: number };
  largestEmptyRectShare: number;
  largestEmptyContentRect: { x: number; y: number; w: number; h: number };
  largestEmptyContentRectShare: number;
  imageryShare: number;
  graphicShare: number;
  imageryOrDeviceShare: number;
  textShare: number;
  accentShare: number;
  accentPresent: boolean;
  edgeDensity: number;
  quantisedColourCount: number;
  clippedEdgeShare: number;
}

/** The DOM facts a validation render returns. Structurally the `SlideProbe` `probe: true` attaches. */
export interface StudioSlideProbe {
  n: number;
  overflow: boolean;
  overflowing: string[];
  offscreen: string[];
  elementCount: number;
  textBoxShare: number;
  fontFamiliesUsed: string[];
}

export type StudioRenderOutcome =
  | { ok: true; metrics: StudioSlideMetrics; probe: StudioSlideProbe; slidePath?: string; slideUrl?: string }
  | { ok: false; reason: string };

export interface StudioRenderRequest {
  archetypeId: string;
  /** The complete document code built — the model never authors this. */
  document: string;
  content: StudioSampleContent;
  dir: "ltr" | "rtl";
  targetLanguage?: string | undefined;
}

/** One interest-floor finding, structurally item L's `InterestFinding`. */
export interface StudioInterestFinding {
  kind: string;
  sentence: string;
  measured?: Record<string, number>;
}

/**
 * The share thresholds gate 6 measures HEADROOM against.
 *
 * Supplied by the caller from `interest-floor.ts`'s own named constants
 * rather than copied here: two copies of a threshold is how a template gets
 * validated against a number the run no longer uses.
 */
export interface StudioInterestThresholds {
  largestEmptyRectCeiling: Readonly<Record<StudioRole, number>>;
  occupiedShareFloor: Readonly<Record<StudioRole, number>>;
  flatBackgroundCeiling: number;
  imageryOrDeviceFloor: number;
  textShareCeiling: number;
}

/**
 * How much room a slide has before it would fail its role's floor, in share
 * points, plus the clause that is tightest.
 *
 * Only the four SHARE-OF-FRAME clauses take part — dead space, substance,
 * cover/closer device, wall of text. The INTEGRITY clauses are deliberately
 * excluded: `INK_SHARE_FLOOR` (0.015), `CLIPPED_EDGE_SHARE_CEILING` (0.004)
 * and clause G's `CONTENT_OCCUPIED_SHARE_FLOOR` (0.06/0.09) are all set close
 * enough to zero that a 0.05 margin against them is either arithmetically
 * impossible or a stricter rule than the rule, and none of them is about
 * taste — they say "the render looks broken" or "there is nothing here to
 * read", which are pass/fail questions `checkInterestFloor` already answers
 * and gate 6 already fails a template on. A margin is calibration room, and
 * only a threshold with room to spare can have any.
 *
 * Clause G still GATES here, through `deps.interest.check` — which is the
 * real `checkInterestFloor` — and that is the part that matters for a
 * generated template: `instagram-template-designer@1` §6 offers a very
 * low-contrast display-face glyph field as a ground, and a template whose
 * ground is the only thing that paints is refused at generation rather than
 * discovered in production.
 *
 * Clause D (substance) is an AND — flat AND idle — so its headroom is the
 * LARGER of the two distances: a slide that is busy is safe however flat its
 * ground is, and vice versa.
 */
export function interestHeadroom(
  metrics: StudioSlideMetrics,
  role: StudioRole,
  thresholds: StudioInterestThresholds,
): { margin: number; tightest: string } {
  const clauses: Array<{ clause: string; headroom: number }> = [
    { clause: "dead-space", headroom: thresholds.largestEmptyRectCeiling[role] - metrics.largestEmptyRectShare },
    {
      clause: "empty",
      headroom: Math.max(thresholds.flatBackgroundCeiling - metrics.flatBackgroundShare, metrics.occupiedShare - thresholds.occupiedShareFloor[role]),
    },
    { clause: "text-wall", headroom: thresholds.textShareCeiling - metrics.textShare },
  ];
  if (role !== "interior") {
    clauses.push({ clause: "no-device", headroom: metrics.imageryOrDeviceShare - thresholds.imageryOrDeviceFloor });
  }
  let tightest = clauses[0]!;
  for (const candidate of clauses) {
    if (candidate.headroom < tightest.headroom) tightest = candidate;
  }
  return { margin: Math.round(tightest.headroom * 1000) / 1000, tightest: tightest.clause };
}

/**
 * The calibration margin a STORED template must clear, against a run's 0.
 *
 * A run's slide is one post: it fails the floor, it is re-laid-out or
 * redrafted, and the next post is a fresh draw. A template is a standing
 * asset that every future post for this client renders through, so it is held
 * to the floor plus room — 0.05 share points, about half a line of body text
 * at this canvas. A design that only just clears the floor with code-built
 * sample copy will not clear it with a real headline two words longer.
 */
export const STUDIO_INTEREST_MARGIN = 0.05;

/** Ratio of the sample's ink that may be text before a template is called a wall of text at sample length. Reported through the floor's own clause, never re-judged here. */
export interface StudioInterestPolicy {
  check(input: { metrics: StudioSlideMetrics; probe: StudioSlideProbe; role: StudioRole }): { findings: readonly StudioInterestFinding[] };
  thresholds: StudioInterestThresholds;
}

/**
 * The seams gate 3, 4, 5, 6 and 8 need.
 *
 * The workflow builds this once, at `00c1`:
 *
 * ```ts
 * const deps: StudioValidationDeps = {
 *   assertSafeMarkup,                    // from @agent-engine/tool-karos-templates
 *   buildStudioTemplateDocument,         // ditto (safety.ts)
 *   composeDocument,                     // ditto (materialize.ts)
 *   render: makeStudioRenderer({ tools, repoRoot, runId }),   // writes the doc to the run's
 *                                        // template cache, calls publish.renderCarousel with
 *                                        // canvas.scale 2, measure: true, probe: true
 *   interest: {
 *     check: ({ metrics, probe, role }) => checkInterestFloor(metrics, probe, role, {}),
 *     thresholds: INTEREST_THRESHOLDS,   // from interest-floor.ts's own constants
 *   },
 * };
 * ```
 */
export interface StudioValidationDeps {
  /** `assertSafeMarkup` with the opt-in allowlist. Run-authored custom archetypes keep the stricter contract by passing no options; the studio passes only what it declared. */
  assertSafeMarkup(
    bodyHtml: string,
    css: string,
    slots: readonly string[],
    options?: { allowImageSlots?: readonly string[]; allowHtmlSlots?: readonly string[] },
  ): { ok: true } | { ok: false; reason: string };
  /**
   * Code builds the document SHELL around the model's fragment: doctype,
   * head, font links, the `:root` token block, the reset, the fixed 1080x1440
   * canvas, the standing brand furniture and the `__CAROUSEL_READY__` script
   * the renderer waits on.
   *
   * `karos-templates`' `buildStudioTemplateDocument(bodyHtml)`.
   */
  buildStudioTemplateDocument(bodyHtml: string): string;
  /**
   * The package's own `composeDocument`, so the validation render sees the
   * SAME document materialization will write at render time — the template's
   * own `<style>`, then the shared device sheet, then the client's brand head,
   * in that precedence order. Injected rather than called directly so the
   * shared-sheet parameter (item M) can be passed the moment it exists
   * without this module tracking that package's build.
   */
  composeDocument(definition: TemplateDefinition, brandHeadHtml?: string, brandBodyHtml?: string, extraHeadHtml?: string): string;
  render(request: StudioRenderRequest): Promise<StudioRenderOutcome>;
  interest: StudioInterestPolicy;
}

/** One refused gate, named WITH ITS NUMBER — both the gate's and the measurement's. */
export interface StudioGateFailure {
  gate: number;
  id: string;
  reason: string;
  measured?: Record<string, number>;
}

export interface StudioRenderMeasurement {
  metrics: StudioSlideMetrics;
  probe: StudioSlideProbe;
  margin: number;
  tightest: string;
  findings: StudioInterestFinding[];
  slideUrl?: string;
  slidePath?: string;
}

export interface StudioTemplateValidation {
  archetypeId: string;
  ok: boolean;
  failures: StudioGateFailure[];
  /** Facts that do not refuse a template: an accent out of band, a colour count of two. */
  warnings: string[];
  document?: string;
  content?: StudioSampleContent;
  ltr?: StudioRenderMeasurement;
  rtl?: StudioRenderMeasurement;
  contrast?: ContrastFact[];
}

/** The gate ids, in the order the spec numbers them — the numbers are the contract, so a failure can be talked about by number. */
export const STUDIO_GATE_IDS: Readonly<Record<number, string>> = {
  1: "gate-1-routable-archetype",
  2: "gate-2-slot-contract",
  3: "gate-3-markup-safety",
  4: "gate-4-code-owns-the-document",
  5: "gate-5-real-render",
  6: "gate-6-interest-floor",
  7: "gate-7-contrast-and-palette",
  8: "gate-8-rtl-and-script-fonts",
};

const fail = (gate: number, reason: string, measured?: Record<string, number>): StudioGateFailure => ({
  gate,
  id: STUDIO_GATE_IDS[gate]!,
  reason,
  ...(measured !== undefined ? { measured } : {}),
});

/** The measured numbers that travel to a repair call, a set review and the gate payload. Rounded, because a reviewer reads them. */
export function measuredSummary(metrics: StudioSlideMetrics, margin?: number): Record<string, number> {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    flatBackgroundShare: r(metrics.flatBackgroundShare),
    occupiedShare: r(metrics.occupiedShare),
    largestEmptyRectShare: r(metrics.largestEmptyRectShare),
    imageryOrDeviceShare: r(metrics.imageryOrDeviceShare),
    textShare: r(metrics.textShare),
    inkShare: r(metrics.inkShare),
    accentShare: r(metrics.accentShare),
    ...(margin !== undefined ? { margin: r(margin) } : {}),
  };
}

/** The privileged `{{image:x}}` / `{{html:x}}` slots a fragment actually reads. */
function privilegedSlotsUsed(bodyHtml: string): { imageSlots: string[]; htmlSlots: string[] } {
  const imageSlots = [...bodyHtml.matchAll(/\{\{image:([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]!);
  const htmlSlots = [...bodyHtml.matchAll(/\{\{html:([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]!);
  return { imageSlots: [...new Set(imageSlots)], htmlSlots: [...new Set(htmlSlots)] };
}

/** Shapes a model can produce that mean "I authored a document, not a fragment" (gate 4). */
const DOCUMENT_SHAPED = /<!doctype|<html\b|<head\b|<body\b/i;

/**
 * The complete document a studio template renders as — the code-owned shell
 * around the model's fragment, with the template's own stylesheet, the shared
 * device sheet and the client's brand head composed in, in that order.
 *
 * Composed through the template package's own `composeDocument` rather than a
 * local splice, deliberately: this is the document `materializeTemplates`
 * will write on every future run, and a validation render of anything else
 * would be measuring a page that never ships.
 *
 * Note what the shell does NOT do: paint a ground. The template's own CSS
 * paints its ground, and whether that ground actually holds the frame is not
 * a question a CSS grep can answer — it is what gate 6 measures. A template
 * declaring `ground: "colour-block"` and painting nothing fails the interest
 * floor on the pixels, which is the only honest verdict available.
 */
export function composeStudioDocument(
  draft: Pick<StudioTemplateDraft, "bodyHtml" | "css" | "archetypeId" | "name" | "layoutType">,
  deps: Pick<StudioValidationDeps, "buildStudioTemplateDocument" | "composeDocument">,
  extras: { brandHeadHtml?: string | undefined; extraHeadHtml?: string | undefined } = {},
): string {
  const shell = deps.buildStudioTemplateDocument(draft.bodyHtml);
  const definition = TemplateDefinitionSchema.parse({
    id: `${STUDIO_ID_PREFIX}preview_${draft.archetypeId}`,
    archetypeId: draft.archetypeId,
    name: draft.name,
    layoutType: draft.layoutType,
    htmlTemplate: shell,
    cssStyles: draft.css,
    source: "ai_generated",
  });
  return deps.composeDocument(definition, extras.brandHeadHtml, undefined, extras.extraHeadHtml);
}

/**
 * The eight-gate battery. A template cannot be stored until it renders and
 * MEASURES.
 *
 * Order of execution is cheapest-first — the five free gates (1, 2, 3, 4 and
 * 7) run before the three that open a browser (5, 6, 8) — while the reported
 * numbers stay the spec's, because a failure has to be nameable by number.
 * A single refusal short-circuits the expensive gates: there is nothing to
 * learn from rendering a template whose slots are wrong.
 *
 * Nothing here throws. Every outcome is a `StudioGateFailure`, because a
 * setup must never fail a run — the bundled eight are always underneath.
 */
export async function validateStudioTemplate(
  input: {
    draft: StudioTemplateDraft;
    clientSlug: string;
    /** Studio archetypes already stored or already authored this setup — gate 1's duplicate half. */
    existingArchetypeIds?: readonly string[];
    kit?: { cssVars: Record<string, string>; palette?: readonly string[] } | undefined;
    /** The resolved target language. A non-Latin one arms gate 8. */
    targetLanguage?: string | undefined;
    seed: StudioSampleSeed;
    /** The RTL seed, when gate 8 is armed. Defaults to the LTR seed with `dir: "rtl"`. */
    rtlSeed?: StudioSampleSeed | undefined;
    /** The evidence block the designer was given — `derivedFrom.why` is checked against it. */
    evidenceBlock?: string | undefined;
    /** The client's brand-kit head fragment, so the sample is measured in the client's own tokens rather than the engine defaults. */
    brandHeadHtml?: string | undefined;
    /** The shared sheet every rendered document receives (item M's `deviceCssBlock()`), so a template declaring a device slot is measured WITH the device styled. */
    extraHeadHtml?: string | undefined;
  },
  deps: StudioValidationDeps,
): Promise<StudioTemplateValidation> {
  const draft = input.draft;
  const failures: StudioGateFailure[] = [];
  const warnings: string[] = [];
  const result: StudioTemplateValidation = { archetypeId: draft.archetypeId, ok: false, failures, warnings };

  // ── Gate 1: a routable id, and only one per (client, archetype).
  if (!ROUTABLE_ARCHETYPE_IDS.includes(draft.archetypeId)) {
    failures.push(
      fail(
        1,
        `archetypeId "${draft.archetypeId}" is not one of the eight routable ids (${ROUTABLE_ARCHETYPE_IDS.join(", ")}) — templateForLayout maps only the fixed layout enum to filenames, so nothing could ever route a slide to it`,
      ),
    );
  } else if ((input.existingArchetypeIds ?? []).includes(draft.archetypeId)) {
    failures.push(fail(1, `this client already has a studio template for "${draft.archetypeId}" — at most one per (client, archetypeId), and the id "${studioTemplateId(input.clientSlug, draft.archetypeId)}" would overwrite it`));
  }
  const declaredRole = ROLE_BY_ARCHETYPE[draft.archetypeId] ?? draft.role;
  if (draft.role !== declaredRole) {
    warnings.push(`the draft calls "${draft.archetypeId}" a ${draft.role}; it is judged as a ${declaredRole}, which is the role the interest floor uses`);
  }

  // ── Gate 2: the slot contract.
  const extracted = extractSupportedFields(draft.bodyHtml + draft.css);
  const declared = [...new Set(draft.slots)];
  const supportable = SLOTS_BY_ARCHETYPE[draft.archetypeId] ?? [];
  for (const name of extracted) {
    if (STANDING_FURNITURE_SLOTS.has(name)) continue;
    if (!declared.includes(name)) {
      failures.push(fail(2, `the markup reads {{${name}}}, which is not a declared slot (declared: ${declared.join(", ") || "none"}) — an undeclared placeholder renders as a hole`));
      continue;
    }
    if (!supportable.includes(name)) {
      failures.push(
        fail(
          2,
          `slot "${name}" is not one contentFor can supply for archetype "${draft.archetypeId}" (it supplies ${supportable.join(", ") || "nothing"}) — nothing in the pipeline would ever fill it`,
        ),
      );
    }
  }
  for (const name of declared) {
    if (!extracted.includes(name)) {
      failures.push(fail(2, `slot "${name}" is declared but the markup never reads {{${name}}} — a declared slot nothing reads is content thrown away`));
    }
    const sampleValue = draft.sample[name];
    if (typeof sampleValue !== "string" || sampleValue.trim().length === 0) {
      failures.push(fail(2, `the sample does not fill declared slot "${name}" — a template that cannot demonstrate its own slots has not been shown to work`));
    }
  }

  // ── Gate 3: safety, with the opt-in allowlist.
  const used = privilegedSlotsUsed(draft.bodyHtml);
  const allowImageSlots: string[] = [];
  const allowHtmlSlots: string[] = [];
  for (const slot of used.imageSlots) {
    if (!PRIVILEGED_IMAGE_SLOTS.includes(slot)) {
      failures.push(fail(3, `{{image:${slot}}} is not an allowed image slot (only ${PRIVILEGED_IMAGE_SLOTS.join(", ")}) — the renderer resolves an image slot to a bounds-checked local file, and there is no source for that name`));
      continue;
    }
    if (draft.ground !== "image") {
      failures.push(fail(3, `{{image:${slot}}} is read but the declared ground is "${draft.ground}" — an image slot is only licensed when the template declares a photographic ground, otherwise the slide has no ground when no picture is found`));
      continue;
    }
    if (!declared.includes(slot)) {
      failures.push(fail(3, `{{image:${slot}}} is read but "${slot}" is not a declared slot`));
      continue;
    }
    allowImageSlots.push(slot);
  }
  for (const slot of used.htmlSlots) {
    if (!PRIVILEGED_HTML_SLOTS.includes(slot)) {
      failures.push(fail(3, `{{html:${slot}}} is not an allowed html slot (only ${PRIVILEGED_HTML_SLOTS.join(", ")}) — the raw substitution form is reserved for fragments CODE builds, and nothing builds "${slot}"`));
      continue;
    }
    if (!declared.includes(slot)) {
      failures.push(fail(3, `{{html:${slot}}} is read but "${slot}" is not a declared slot — the raw form needs an explicit declaration, not an implicit one`));
      continue;
    }
    allowHtmlSlots.push(slot);
  }
  if (draft.ground === "image" && !used.imageSlots.includes("hero")) {
    failures.push(fail(3, `the declared ground is "image" but the markup never reads {{image:hero}} — a photographic ground with no picture in it is the grey screen this studio exists to prevent`));
  }
  const safety = deps.assertSafeMarkup(draft.bodyHtml, draft.css, declared, {
    ...(allowImageSlots.length > 0 ? { allowImageSlots } : {}),
    ...(allowHtmlSlots.length > 0 ? { allowHtmlSlots } : {}),
  });
  if (!safety.ok) failures.push(fail(3, safety.reason));

  // ── Gate 4: code owns the document.
  if (DOCUMENT_SHAPED.test(draft.bodyHtml)) {
    failures.push(fail(4, "bodyHtml contains a doctype/html/head/body tag — the model authors a FRAGMENT and a stylesheet; code writes the document, the token block and the __CAROUSEL_READY__ script the renderer waits for"));
  }
  if (/__CAROUSEL_READY__/.test(draft.bodyHtml) || /__CAROUSEL_READY__/.test(draft.css)) {
    failures.push(fail(4, "the fragment references __CAROUSEL_READY__ — the one script every rendered slide needs is the harness's to write, never the template's"));
  }

  // ── Gate 7 (free, so it runs before the browser opens): contrast + palette.
  const accentsUsed = [input.seed.accentHex];
  const contrast = assessContrastFacts(input.kit, accentsUsed);
  result.contrast = contrast;
  for (const fact of contrast) {
    if (!fact.pass) {
      failures.push(fail(7, `${fact.label} measures ${fact.ratio.toFixed(2)}:1 against a ${fact.floor}:1 floor — a template stored below the contrast floor is unreadable for every future post`, { ratio: Math.round(fact.ratio * 100) / 100, floor: fact.floor }));
    }
  }
  const palette = checkPaletteWithinKit(accentsUsed, input.kit?.palette ?? []);
  if (!palette.ok) failures.push(fail(7, palette.reason ?? "the sample paints an accent outside the brand kit's ring"));

  // The citation check, when the caller supplied the evidence the designer saw.
  if (input.evidenceBlock !== undefined) {
    const cited = assertNoInventedMetrics(draft.derivedFrom.why, input.evidenceBlock);
    if (!cited.ok) failures.push(fail(2, `derivedFrom.why: ${cited.reason}`));
  }

  if (failures.length > 0) return result;

  // ── Gate 5: a real Chromium render of CODE-BUILT sample content.
  const content = buildStudioSampleContent(draft, input.seed);
  result.content = content;
  const document = composeStudioDocument(draft, deps, { brandHeadHtml: input.brandHeadHtml, extraHeadHtml: input.extraHeadHtml });
  result.document = document;
  const ltr = await deps.render({ archetypeId: draft.archetypeId, document, content, dir: input.seed.dir, ...(input.targetLanguage !== undefined ? { targetLanguage: input.targetLanguage } : {}) });
  if (!ltr.ok) {
    failures.push(fail(5, `the sample did not render: ${ltr.reason}`));
    return result;
  }

  // ── Gate 6: the interest floor at the declared role, with the calibration margin.
  const ltrFloor = deps.interest.check({ metrics: ltr.metrics, probe: ltr.probe, role: declaredRole });
  const ltrHeadroom = interestHeadroom(ltr.metrics, declaredRole, deps.interest.thresholds);
  result.ltr = {
    metrics: ltr.metrics,
    probe: ltr.probe,
    margin: ltrHeadroom.margin,
    tightest: ltrHeadroom.tightest,
    findings: [...ltrFloor.findings],
    ...(ltr.slideUrl !== undefined ? { slideUrl: ltr.slideUrl } : {}),
    ...(ltr.slidePath !== undefined ? { slidePath: ltr.slidePath } : {}),
  };
  for (const finding of ltrFloor.findings) {
    failures.push(fail(6, `interest floor (${finding.kind}) at role "${declaredRole}": ${finding.sentence}`, measuredSummary(ltr.metrics, ltrHeadroom.margin)));
  }
  if (ltrFloor.findings.length === 0 && ltrHeadroom.margin < STUDIO_INTEREST_MARGIN) {
    failures.push(
      fail(
        6,
        `the render clears the ${declaredRole} floor but only by ${ltrHeadroom.margin.toFixed(3)} on the "${ltrHeadroom.tightest}" clause, under the ${STUDIO_INTEREST_MARGIN} calibration margin a STORED template is held to — a design this close to the floor with code-built sample copy will fail it with a real headline two words longer`,
        measuredSummary(ltr.metrics, ltrHeadroom.margin),
      ),
    );
  }
  if (ltr.metrics.accentPresent === false) warnings.push("the sample painted no accent pixels — the brand's accent moment is missing from this layout");
  if (ltr.metrics.quantisedColourCount < 3) warnings.push(`the sample paints only ${ltr.metrics.quantisedColourCount} distinct colour(s)`);
  if (!ltr.metrics.backgroundMatchesBrandGround) warnings.push(`the measured background ${ltr.metrics.backgroundHex} is not the brand ground`);

  // ── Gate 8: RTL and the script fonts, when the client's language needs them.
  const script = scriptTypographyFor(input.targetLanguage);
  if (script !== undefined) {
    const rtlSeed = input.rtlSeed ?? { ...input.seed, dir: "rtl" as const };
    // The same document: `dir` is a FIELD (`<html dir="{{dir}}">`), not a
    // second build, so an RTL render exercises the very bytes the LTR one did.
    const rtlDocument = document;
    const rtlContent = buildStudioSampleContent(draft, rtlSeed);
    const rtl = await deps.render({ archetypeId: draft.archetypeId, document: rtlDocument, content: rtlContent, dir: "rtl", ...(input.targetLanguage !== undefined ? { targetLanguage: input.targetLanguage } : {}) });
    if (!rtl.ok) {
      failures.push(fail(8, `the ${script.script} sample did not render: ${rtl.reason}`));
      return result;
    }
    const rtlFloor = deps.interest.check({ metrics: rtl.metrics, probe: rtl.probe, role: declaredRole });
    const rtlHeadroom = interestHeadroom(rtl.metrics, declaredRole, deps.interest.thresholds);
    result.rtl = {
      metrics: rtl.metrics,
      probe: rtl.probe,
      margin: rtlHeadroom.margin,
      tightest: rtlHeadroom.tightest,
      findings: [...rtlFloor.findings],
      ...(rtl.slideUrl !== undefined ? { slideUrl: rtl.slideUrl } : {}),
      ...(rtl.slidePath !== undefined ? { slidePath: rtl.slidePath } : {}),
    };
    if (rtl.probe.overflow) {
      failures.push(fail(8, `the ${script.script} render overflows its box (${rtl.probe.overflowing.slice(0, 3).join(", ") || "unnamed element"}) — the templates size display type from an in-page text length breakpoint, and this script's glyph widths pick a size that does not fit`));
    }
    if (rtl.metrics.textShare <= 0) {
      failures.push(fail(8, `the ${script.script} render painted no text pixels — the script's glyphs did not render (tofu, or a font that never loaded)`, { textShare: rtl.metrics.textShare }));
    }
    const expectedFamilies = script.spec.display.concat(script.spec.body);
    if (!rtl.probe.fontFamiliesUsed.some((family) => expectedFamilies.some((expected) => family.toLowerCase().includes(expected.toLowerCase())))) {
      failures.push(
        fail(8, `the ${script.script} render used ${rtl.probe.fontFamiliesUsed.join(", ") || "no named family"} — none of the script stack (${expectedFamilies.join(", ")}) actually loaded, so the glyphs are being painted by a fallback face`),
      );
    }
    for (const finding of rtlFloor.findings) {
      failures.push(fail(8, `${script.script} interest floor (${finding.kind}): ${finding.sentence}`, measuredSummary(rtl.metrics, rtlHeadroom.margin)));
    }
    if (rtlFloor.findings.length === 0 && rtlHeadroom.margin < STUDIO_INTEREST_MARGIN) {
      failures.push(
        fail(8, `the ${script.script} render clears the floor by only ${rtlHeadroom.margin.toFixed(3)} on "${rtlHeadroom.tightest}", under the ${STUDIO_INTEREST_MARGIN} margin`, measuredSummary(rtl.metrics, rtlHeadroom.margin)),
      );
    }
  }

  result.ok = failures.length === 0;
  return result;
}

/** The findings a repair call is handed — every refused gate by NUMBER, with its measured figures verbatim. */
export function formatStudioFailures(validation: StudioTemplateValidation): string[] {
  return validation.failures.map((failure) => {
    const numbers = failure.measured === undefined ? "" : ` [measured ${Object.entries(failure.measured).map(([k, v]) => `${k}=${v}`).join(", ")}]`;
    return `${failure.id}: ${failure.reason}${numbers}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Storing the survivors, and reporting the set
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `promoteTemplate` options for one surviving template.
 *
 * Structurally typed rather than importing `PromoteOptions`, so this module
 * needs no compile-time knowledge of the store's own option bag; the caller
 * spreads it plus the `store` handle. `enabled: false` and the score are the
 * two decisions that matter and both are explained where they are declared
 * (`DEFAULT_QUALITY_STUDIO` in `karos-templates/src/types.ts`).
 */
export interface StudioPromotion {
  id: string;
  archetypeId: string;
  name: string;
  htmlTemplate: string;
  cssStyles: string;
  layoutType: "photo" | "typographic";
  source: "ai_generated";
  clientSlug: string;
  actor: string;
  note: string;
  now: number;
  qualityScore: number;
  enabled: false;
  derivedFrom: StudioDerivedFrom;
  role: StudioRole;
}

export function buildStudioPromotion(input: {
  draft: StudioTemplateDraft;
  validation: StudioTemplateValidation;
  clientSlug: string;
  document: string;
  qualityScore: number;
  now: number;
}): StudioPromotion {
  // The numbers go into the row's own first feedback entry, so the evidence
  // that let a template in is readable from the row a year later without a
  // run trace to cross-reference.
  const ltr = input.validation.ltr;
  const numbers = ltr === undefined ? undefined : measuredSummary(ltr.metrics, ltr.margin);
  const measured = numbers === undefined ? "" : ` measured occupied ${numbers["occupiedShare"]}, flat ${numbers["flatBackgroundShare"]}, floor margin ${numbers["margin"]};`;
  return {
    id: studioTemplateId(input.clientSlug, input.draft.archetypeId),
    archetypeId: input.draft.archetypeId,
    name: input.draft.name,
    htmlTemplate: input.document,
    cssStyles: input.draft.css,
    layoutType: input.draft.layoutType,
    source: "ai_generated",
    clientSlug: input.clientSlug,
    actor: STUDIO_ACTOR,
    note: `generated at setup from the "${input.draft.derivedFrom.formatLabel}" format;${measured} disabled until a human approves it at the review gate`,
    now: input.now,
    qualityScore: input.qualityScore,
    enabled: false,
    derivedFrom: input.draft.derivedFrom,
    role: ROLE_BY_ARCHETYPE[input.draft.archetypeId] ?? input.draft.role,
  };
}

/** What the review gate and the deliverable carry as `templateStudio`. */
export interface StudioReport {
  action: StudioAction;
  reason: string;
  templates: Array<{
    templateId: string;
    archetypeId: string;
    role: StudioRole;
    formatLabel: string;
    why: string;
    measured?: Record<string, number>;
    slideUrl?: string;
    rtlChecked: boolean;
  }>;
  dropped: Array<{ archetypeId: string; reason: string }>;
  warnings: string[];
  signalsAvailable: string[];
  signalsAbsent: string[];
  notes: string[];
}

/**
 * Assemble the studio's own report.
 *
 * Everything a reviewer needs to approve or reject the SET, and nothing they
 * would have to open a log to find: what was stored, what it was derived
 * from, the numbers it measured, what was dropped and why, and — kept
 * deliberately prominent — which engagement signals the whole exercise was
 * missing.
 */
export function summarizeStudio(input: {
  check: StudioCheck;
  stored: ReadonlyArray<{ promotion: StudioPromotion; validation: StudioTemplateValidation }>;
  dropped: ReadonlyArray<{ archetypeId: string; reason: string }>;
  evidence?: { rows: readonly FormatEvidenceRow[]; notes: readonly string[] } | undefined;
  notes?: readonly string[] | undefined;
}): StudioReport {
  const signalsAvailable = [...new Set((input.evidence?.rows ?? []).flatMap((r) => r.signalsAvailable))].sort();
  const signalsAbsent = [...new Set((input.evidence?.rows ?? []).flatMap((r) => r.signalsAbsent))];
  return {
    action: input.check.action,
    reason: input.check.reason,
    templates: input.stored.map(({ promotion, validation }) => ({
      templateId: promotion.id,
      archetypeId: promotion.archetypeId,
      role: promotion.role,
      formatLabel: promotion.derivedFrom.formatLabel,
      why: promotion.derivedFrom.why,
      ...(validation.ltr !== undefined ? { measured: measuredSummary(validation.ltr.metrics, validation.ltr.margin) } : {}),
      ...(validation.ltr?.slideUrl !== undefined ? { slideUrl: validation.ltr.slideUrl } : {}),
      rtlChecked: validation.rtl !== undefined,
    })),
    dropped: input.dropped.map((d) => ({ ...d })),
    warnings: input.stored.flatMap(({ promotion, validation }) => validation.warnings.map((w) => `${promotion.archetypeId}: ${w}`)),
    signalsAvailable,
    signalsAbsent,
    notes: [...(input.evidence?.notes ?? []), ...(input.notes ?? [])],
  };
}

/** The one-line studio note for the ledger and the run record. */
export function studioNote(report: StudioReport): string {
  if (report.action !== "generate") return `template studio: ${report.action} — ${report.reason}`;
  const dropped = report.dropped.length === 0 ? "" : `, ${report.dropped.length} dropped (${report.dropped.map((d) => `${d.archetypeId}: ${d.reason}`).join("; ")})`;
  return `template studio: ${report.templates.length} template(s) stored disabled pending approval${dropped}`;
}
