/**
 * What each post DID, and which shape to reach for next.
 *
 * ## What this is for
 *
 * The owner's specification asks for the format to be chosen by measurement:
 * `format = argmax(sends/reach + saves/reach)` over the client's own history,
 * constrained by what the topic can support, with a bandit that keeps
 * exploring and a decay so a result from March stops deciding September.
 *
 * Today the format is chosen by ROTATION — `selectPostFormat` looks at what
 * was last DELIVERED and picks whichever of two formats has not been used.
 * That is a reasonable thing to do with no data, and it is what this module
 * falls back to. It is not a measurement, and it never becomes one by itself.
 *
 * ## Why it is built now, before there is any data
 *
 * Phase 6 connects the Instagram Graph API and starts filling `metrics`. If
 * the selector were built then, Phase 6 would be a data task AND a modelling
 * task at once, and the first weeks of real numbers would arrive with nothing
 * able to read them. Built now, Phase 6 writes records into a store that
 * already has a reader, and the selector starts working with no further code.
 *
 * Everything here is PURE. Reading and writing the store is the workflow's
 * job, through the same beliefs document `skeleton-memory.ts` and the budget
 * history already use; this module only decides.
 *
 * ## The honest state of it, today
 *
 * With an empty store every function here returns the rotation answer and
 * says so in `source`. Nothing pretends to have measured anything. A reader
 * of a gate payload sees `"rotation"` and knows exactly how much the choice
 * was worth.
 */

/**
 * The three shapes a post can take, which is the vocabulary the specification
 * asks the bandit to choose between.
 *
 * Deliberately NOT the same axis as `InstagramFormat` (`carousel` / `single`).
 * That field says how many images are published; these say what the post IS.
 * A `carousel-edu` and a `carousel-pov` are both carousels and they are not
 * the same product: one teaches a procedure and lives or dies on saves, the
 * other takes a position and lives or dies on sends. Collapsing them, which
 * is what the current rotation does, means the measurement can never tell
 * the difference between them either.
 */
export const POST_ARMS = ["carousel-edu", "carousel-pov", "single-deep"] as const;
export type PostArm = (typeof POST_ARMS)[number];

/** Where in the funnel this post is aimed (item C1). */
export const FUNNEL_STAGES = ["attention", "expertise", "decide"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * One shipped post, as the store remembers it.
 *
 * `metrics` is optional and stays undefined until Phase 6 fills it from the
 * Graph API. Everything else is written at ship time by the run that made the
 * post, which matters: a label applied afterwards by reading the post back is
 * a guess, and the whole value of this store is that the labels are what the
 * writer actually decided.
 */
export interface PostPerformanceRecord {
  /** The run that produced it. The join key when Phase 6 matches a published media id back to a run. */
  runId: string;
  /** Instagram's own media id, once the post is published and known. Absent for a post that has not shipped to the platform. */
  mediaId?: string;
  arm: PostArm;
  /**
   * Where in the funnel this post was aimed (item C1) — **absent on every
   * post today**, and deliberately absent rather than defaulted.
   *
   * Nothing in the run decides a funnel stage yet: that is the half of C1
   * this phase did not build, because deciding it properly means a field on
   * the topic claim and a prompt that argues for one. Writing `"expertise"`
   * on every record instead would give Phase 6 a column that looks like data,
   * is a constant, and would quietly make every cut by funnel stage return
   * the same answer.
   */
  funnelStage?: FunnelStage;
  /** §29's four shapes, when the writer declared one. */
  hookPattern?: string;
  /**
   * Whether the shipped caption opened lines with arrow bullets.
   *
   * Recorded so the NEXT post can be told. The owner, 2026-09-19: *"in every
   * post now you do these arrows in the text, like this. Once in a while it is
   * fine, but repetitive things like this look AI"* -- on a device the copy
   * prompt had explicitly PERMITTED (@23 section 2, "arrow bullets among prose
   * are not" refused), and which the writer therefore used every time.
   *
   * A prompt sentence cannot carry this on its own. "Use this at most one post
   * in three" asks a model with no memory across runs to count something it
   * cannot see, which is the class of instruction that reads well and does
   * nothing. The memory is here; the prompt only reads it.
   *
   * Optional, and absent on every record written before 2026-09-19. Absent is
   * NOT false: `arrowBulletSteer` counts only explicit `true`, so a history of
   * old records can never manufacture a steer out of what it did not record.
   */
  usedArrowBullets?: boolean;
  /**
   * The reviewer's 1-to-5 stars on the post, when they gave any.
   *
   * RFC-22 section 3.2's golden-set label, in the shape the owner chose on
   * 2026-09-20: collected at the gate from the person already looking at the
   * post, optional, and rewarded with a credit rather than required.
   *
   * **This is the only field in this record written by a HUMAN**, and that is
   * what makes it worth more than the rest of them put together. Everything
   * else here is the run's opinion of its own work; `metrics` will one day be
   * the platform's. This is a person saying whether they would post it, which
   * is the question RFC-22 section 3.3 says the judge is calibrated against.
   *
   * Absent on nearly every record, by design. See `GateResponseSchema.rating`
   * for why a required rating would be worth less than no rating at all.
   */
  ownerRating?: number;
  slideCount: number;
  /** Where the pictures came from — `generated`, `sourced`, `client`, `mixed`, `none`. Recorded for the same reason the arm is. */
  imageSource?: string;
  /** ISO-8601. Decay is measured from here. */
  publishedAt: string;
  metrics?: PostMetrics;
}

/**
 * The fields `meta.fetchMediaInsights` actually returns, named the way it
 * names them.
 *
 * Matching the tool's vocabulary rather than inventing a prettier one is
 * deliberate: the mapping from the Graph API to this store should be a
 * rename-free copy, because every rename is somewhere for a units mistake to
 * hide.
 */
export interface PostMetrics {
  reach: number;
  saved: number;
  shares: number;
  views?: number;
  profileVisits?: number;
  follows?: number;
}

/** The whole store, as it sits in the client's beliefs document. */
export interface PerformanceStore {
  records: PostPerformanceRecord[];
}

/** The beliefs key this store lives under. Sibling of `SKELETON_BELIEF_KEY` and the budget history in the same document. */
export const PERFORMANCE_BELIEF_KEY = "instagramPostPerformance";

/**
 * How many measured posts before the store is allowed to decide anything.
 *
 * Eight, from the specification. The number matters more than it looks: with
 * three arms, fewer than eight measured posts means at least one arm has one
 * observation or none, and an argmax over that is not a measurement, it is
 * the first post to get lucky deciding the next quarter.
 */
export const MIN_MEASURED_POSTS = 8;

/**
 * The share of runs that take a deliberately random arm.
 *
 * Twenty percent, from the specification. Without it the selector converges
 * on whichever arm won early and stops learning — and on a feed, that is not
 * a stable world: an arm that underperformed in a quiet month can be the
 * right one after the account grows.
 */
export const EXPLORATION_RATE = 0.2;

/**
 * The age at which an observation counts half as much.
 *
 * Ninety days, from the specification, applied as a smooth half-life rather
 * than a cliff. A cliff at ninety days would mean a post's evidence vanishes
 * overnight on an arbitrary morning; a half-life says the same thing about
 * the long run and nothing strange about any particular day.
 */
export const DECAY_HALF_LIFE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A post's score: sends per reach plus saves per reach.
 *
 * `shares` IS the send: the Graph API calls it `shares`, and it counts the
 * DM forwards and story reshares the platform's own ranking weighs most.
 *
 * `undefined` for a post with no metrics or no reach, and the difference
 * between "no reach" and "zero score" is the point — a post nobody saw says
 * nothing about its format, and averaging it in as a zero would punish an
 * arm for an outage or a bad posting hour.
 */
export function scoreOf(record: PostPerformanceRecord): number | undefined {
  const m = record.metrics;
  if (m === undefined) return undefined;
  if (!Number.isFinite(m.reach) || m.reach <= 0) return undefined;
  const shares = Number.isFinite(m.shares) ? m.shares : 0;
  const saved = Number.isFinite(m.saved) ? m.saved : 0;
  return shares / m.reach + saved / m.reach;
}

/** How much a post published at `publishedAt` still counts, seen from `now`. Always in (0, 1]. */
export function decayWeight(publishedAt: string, now: Date): number {
  const then = Date.parse(publishedAt);
  if (!Number.isFinite(then)) return 0; // an unparseable date is not evidence
  const days = Math.max(0, (now.getTime() - then) / DAY_MS);
  return Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS);
}

/** Every record that can actually contribute a number. */
export function measuredRecords(store: PerformanceStore): PostPerformanceRecord[] {
  return store.records.filter((r) => scoreOf(r) !== undefined);
}

export interface ArmSummary {
  arm: PostArm;
  /** Decay-weighted mean score. `undefined` when this arm has no measured post. */
  score?: number;
  /** How many measured posts stand behind it — reported because a mean of one is not a mean. */
  posts: number;
}

/** What the store knows about each arm, best first. */
export function summariseArms(store: PerformanceStore, now: Date): ArmSummary[] {
  return POST_ARMS.map((arm) => {
    const records = store.records.filter((r) => r.arm === arm && scoreOf(r) !== undefined);
    let weighted = 0;
    let weight = 0;
    for (const r of records) {
      const w = decayWeight(r.publishedAt, now);
      weighted += scoreOf(r)! * w;
      weight += w;
    }
    return weight > 0 ? { arm, score: weighted / weight, posts: records.length } : { arm, posts: records.length };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/**
 * What the TOPIC will support, independent of what performed well.
 *
 * From the specification: a proof or results post is a single or a short
 * carousel, because the evidence is one picture and a sentence and padding it
 * to eight slides is how a proof becomes a brochure; a how-to needs six to
 * eight, because a procedure with three steps is not a procedure.
 *
 * This runs BEFORE the measurement, and overrides it. An arm that performs
 * well on average is still the wrong arm for a post that cannot fill it.
 */
export function armsAllowedFor(payloadKind: string | undefined, stage: FunnelStage | undefined): PostArm[] {
  if (payloadKind === "proof" || payloadKind === "single-claim" || stage === "decide") {
    return ["single-deep", "carousel-pov"];
  }
  if (payloadKind === "walkthrough" || payloadKind === "checklist" || payloadKind === "glossary") {
    return ["carousel-edu"];
  }
  return [...POST_ARMS];
}

/** How many slides an arm wants, which item A12 reads. */
export function slideRangeFor(arm: PostArm): { min: number; max: number } {
  switch (arm) {
    case "carousel-edu":
      return { min: 6, max: 8 };
    case "carousel-pov":
      return { min: 4, max: 6 };
    case "single-deep":
      return { min: 1, max: 1 };
  }
}

/** Which ask fits where the reader is (item B3, §30). */
export function ctaKindFor(stage: FunnelStage, hasLeadAsset: boolean): "save" | "send" | "question" | "comment-for-asset" {
  if (stage === "attention") return "question";
  if (stage === "decide") return hasLeadAsset ? "comment-for-asset" : "send";
  return hasLeadAsset ? "comment-for-asset" : "save";
}

export interface ArmSelection {
  arm: PostArm;
  /**
   * How the arm was chosen. A gate payload shows this verbatim, so a reader
   * can tell a measured choice from a coin flip without reading code.
   */
  source: "argmax" | "explore" | "rotation" | "constrained";
  rule: string;
}

export interface SelectArmOptions {
  store: PerformanceStore;
  now: Date;
  /** Absent until item C1's other half exists; the topic constraint then rests on `payloadKind` alone. */
  stage?: FunnelStage;
  payloadKind?: string | undefined;
  /** Arms used by the last few posts, oldest first — what the rotation fallback reads. */
  recentArms?: readonly PostArm[];
  /** Injectable so a test is deterministic. Returns [0, 1). */
  random?: () => number;
}

/**
 * This run's arm.
 *
 * The order is: what the topic allows, then explore-or-exploit, then — if
 * there is not enough measured history to exploit — rotate. Each branch names
 * itself, and `rule` is written for a human reading a gate payload rather
 * than for a log parser.
 */
export function selectArm(options: SelectArmOptions): ArmSelection {
  const allowed = armsAllowedFor(options.payloadKind, options.stage);

  if (allowed.length === 1) {
    return {
      arm: allowed[0]!,
      source: "constrained",
      rule: `the topic's shape (${options.payloadKind ?? "unstated"}, ${options.stage}) supports only ${allowed[0]}`,
    };
  }

  const summaries = summariseArms(options.store, options.now).filter((s) => allowed.includes(s.arm));
  const measured = measuredRecords(options.store).length;
  const random = options.random ?? Math.random;

  if (measured >= MIN_MEASURED_POSTS) {
    if (random() < EXPLORATION_RATE) {
      const pick = allowed[Math.floor(random() * allowed.length)] ?? allowed[0]!;
      return {
        arm: pick,
        source: "explore",
        rule: `the ${Math.round(EXPLORATION_RATE * 100)}% exploration slot — this post deliberately takes ${pick} rather than the current best, so the ranking keeps learning`,
      };
    }
    const best = summaries.find((s) => s.score !== undefined);
    if (best !== undefined) {
      return {
        arm: best.arm,
        source: "argmax",
        rule:
          `${best.arm} has the highest sends+saves per reach over this client's own posts ` +
          `(${best.score!.toFixed(4)} across ${best.posts} measured post(s), 90-day decay)`,
      };
    }
  }

  // ── Rotation: the honest answer with no data ──
  const recent = options.recentArms ?? [];
  const unused = allowed.find((arm) => !recent.includes(arm));
  if (unused !== undefined) {
    return {
      arm: unused,
      source: "rotation",
      rule:
        `${measured} measured post(s) on record, fewer than the ${MIN_MEASURED_POSTS} this reads, ` +
        `so the arm rotates: the last ${recent.length} post(s) did not use ${unused}`,
    };
  }
  return {
    arm: allowed[0]!,
    source: "rotation",
    rule:
      `${measured} measured post(s) on record, fewer than the ${MIN_MEASURED_POSTS} this reads, ` +
      `and every allowed arm was used recently, so this post takes ${allowed[0]}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Reading and writing the store
// ─────────────────────────────────────────────────────────────────────────

/** How many records the store keeps. Older ones have decayed to nothing anyway, and a beliefs document is not an archive. */
export const MAX_STORED_POSTS = 60;

function isArm(value: unknown): value is PostArm {
  return typeof value === "string" && (POST_ARMS as readonly string[]).includes(value);
}

function isStage(value: unknown): value is FunnelStage {
  return typeof value === "string" && (FUNNEL_STAGES as readonly string[]).includes(value);
}

/**
 * Reads the store out of a beliefs document, tolerating anything a past
 * version or a hand edit left there — the same contract `readSkeletonHistory`
 * and `readBudgetHistory` hold themselves to.
 *
 * A record missing the fields that make it usable is DROPPED rather than
 * defaulted. A defaulted arm would put a real measurement behind an arm that
 * never ran it, which is worse than having one fewer record.
 */
export function readPerformanceStore(beliefs: unknown): PerformanceStore {
  const raw =
    beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[PERFORMANCE_BELIEF_KEY] : undefined;
  const records = raw !== null && typeof raw === "object" ? (raw as { records?: unknown }).records : undefined;
  if (!Array.isArray(records)) return { records: [] };

  const out: PostPerformanceRecord[] = [];
  for (const entry of records) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r["runId"] !== "string" || !isArm(r["arm"])) continue;
    // A stage that is present must be one of the three; an ABSENT one is the
    // normal case today and is not a reason to drop a real post.
    if (r["funnelStage"] !== undefined && !isStage(r["funnelStage"])) continue;
    if (typeof r["publishedAt"] !== "string" || !Number.isFinite(Date.parse(r["publishedAt"]))) continue;
    const metrics = r["metrics"];
    out.push({
      runId: r["runId"],
      arm: r["arm"],
      ...(isStage(r["funnelStage"]) ? { funnelStage: r["funnelStage"] } : {}),
      slideCount: typeof r["slideCount"] === "number" ? r["slideCount"] : 0,
      publishedAt: r["publishedAt"],
      ...(typeof r["mediaId"] === "string" ? { mediaId: r["mediaId"] } : {}),
      ...(typeof r["hookPattern"] === "string" ? { hookPattern: r["hookPattern"] } : {}),
      ...(typeof r["usedArrowBullets"] === "boolean" ? { usedArrowBullets: r["usedArrowBullets"] } : {}),
      // Range-checked on the way IN as well as on the way out: a stored 0 or 9
      // is not a rating a person gave, and a calibration that averages one is
      // measuring a bug.
      ...(typeof r["ownerRating"] === "number" && Number.isInteger(r["ownerRating"]) && r["ownerRating"] >= 1 && r["ownerRating"] <= 5
        ? { ownerRating: r["ownerRating"] }
        : {}),
      ...(typeof r["imageSource"] === "string" ? { imageSource: r["imageSource"] } : {}),
      ...(metrics !== null && typeof metrics === "object" ? { metrics: readMetrics(metrics as Record<string, unknown>) } : {}),
    });
  }
  return { records: out };
}

function readMetrics(raw: Record<string, unknown>): PostMetrics {
  const num = (key: string): number => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : 0);
  return {
    reach: num("reach"),
    saved: num("saved"),
    shares: num("shares"),
    ...(typeof raw["views"] === "number" ? { views: raw["views"] } : {}),
    ...(typeof raw["profileVisits"] === "number" ? { profileVisits: raw["profileVisits"] } : {}),
    ...(typeof raw["follows"] === "number" ? { follows: raw["follows"] } : {}),
  };
}

/**
 * The store with this run's post added, newest last, bounded.
 *
 * A record with the same `runId` REPLACES rather than duplicates: Phase 6
 * will come back to the same post later to attach its metrics, and a store
 * that grew a second row each time would count one post twice in every mean.
 */
export function withPost(store: PerformanceStore, record: PostPerformanceRecord): PerformanceStore {
  const kept = store.records.filter((r) => r.runId !== record.runId);
  return { records: [...kept, record].slice(-MAX_STORED_POSTS) };
}

/**
 * The arrow bullets the copy prompt permits: the glyph, the double glyph, a
 * guillemet, or either ASCII spelling.
 *
 * Anchored to a line start because that is what makes it a BULLET. An arrow
 * inside a sentence ("revenue fell 4% -> the round was pulled") is prose and
 * is none of this rule's business.
 */
const ARROW_BULLET = /(?:^|\r?\n)[ \t]*(?:→|⇒|»|->|=>)[ \t]+\S/u;

export function usesArrowBullets(caption: string): boolean {
  return ARROW_BULLET.test(caption);
}

/**
 * How many of this client's last posts opened lines with an arrow, and the
 * sentence the copy prompt is handed when that has become a habit.
 *
 * `undefined` -- no steer at all -- is the normal answer and the honest one
 * for a new client, for a client whose history predates the field, and for a
 * client who uses the device occasionally. A device in one of the last three
 * posts is a device; in two or more it is a signature, which is the line the
 * owner drew.
 *
 * The steer names ALTERNATIVES rather than banning the arrow outright,
 * deliberately. A ban would be the same mistake in the other direction: the
 * repo has already learned once (see `a-heuristic-check-is-a-note`) that a
 * blunt prohibition on a legitimate device costs more in flattened writing
 * than the tell costs in recognisability.
 */
export function arrowBulletSteer(store: PerformanceStore, lookback = 3): string | undefined {
  const recent = [...store.records]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, lookback);
  const used = recent.filter((r) => r.usedArrowBullets === true).length;
  if (used < 2) return undefined;
  return (
    `${used} of this client's last ${recent.length} posts opened lines in the caption with an arrow bullet. ` +
    `It is a real device and on this feed it has stopped being one: the same move every post reads as a template rather than as a writer. ` +
    `Write those lines some other way this time: as prose that carries its own turn, as a numbered list, or as plain short sentences on their own lines. ` +
    `This is about the repetition, not about the arrow: one arrow somewhere it genuinely earns is fine.`
  );
}
