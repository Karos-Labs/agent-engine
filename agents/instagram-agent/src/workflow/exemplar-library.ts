/**
 * RFC-26 Phase 3 — the client's EXEMPLAR LIBRARY, built in setup and read by
 * the Template Studio and the art director.
 *
 * The owner, 2026-09-24/25: harvest hundreds of posts from the client and its
 * competitors, take the ones that broke out of their own account's baseline,
 * judge what is well made, and use those as the source pool for layouts and
 * templates — automatically, in setup, with no approval gate.
 *
 * The tools do the work (`research.harvestInstagramExemplars`,
 * `media.judgeExemplars`); this module is the pure glue: which accounts to
 * read, what to keep, what the downstream prompts are told. Everything here
 * is deterministic and unit-tested; the workflow only calls it.
 */

/** The beliefs key the library lives under. Compact on purpose: DNA and techniques, never captions or pixels. */
export const EXEMPLAR_LIBRARY_BELIEF_KEY = "instagramExemplarLibrary";
/** Refreshed monthly: long enough to amortise the harvest, short enough that a niche's new format shows up. */
export const EXEMPLAR_LIBRARY_TTL_DAYS = 30;
/** After a failed harvest, try again after this, not on every run. */
export const EXEMPLAR_LIBRARY_RETRY_DAYS = 7;
/** Posts read per account. Five accounts x 100 = 500 posts, ~45 calls, ~$0.09. */
export const EXEMPLAR_POSTS_PER_ACCOUNT = 100;
/** Competitor sites resolved to Instagram handles per setup. */
export const EXEMPLAR_MAX_COMPETITORS = 6;
/** Breakout posts shown to the vision judge per setup (~$0.0015 each). */
export const EXEMPLAR_JUDGE_POSTS = 24;

export type ExemplarRole = "client" | "competitor" | "reference";

export interface HarvestPlan {
  accounts: Array<{ handle: string; role: ExemplarRole }>;
  competitorSites: Array<{ name: string; website: string }>;
}

function cleanHandle(handle: string): string | undefined {
  const bare = handle.trim().replace(/^@+/u, "").replace(/^https?:\/\/(www\.)?instagram\.com\//iu, "").replace(/\/.*$/u, "").toLowerCase();
  return /^[a-z0-9_.]{1,30}$/u.test(bare) ? bare : undefined;
}

/**
 * Which accounts setup harvests: the client's own Instagram accounts, the
 * brief's Instagram reference accounts, and the tracked competitors' websites
 * (the harvest resolves each to the handle the site itself links). Handles
 * are deduplicated; the client's own role wins over any other.
 */
export function planHarvest(input: {
  ownAccounts: ReadonlyArray<{ platform: string; username: string }>;
  referenceAccounts: ReadonlyArray<{ platform: string; handle: string }>;
  competitors: ReadonlyArray<{ name?: unknown; website?: unknown }>;
}): HarvestPlan {
  const accounts = new Map<string, ExemplarRole>();
  for (const own of input.ownAccounts) {
    if (own.platform !== "instagram") continue;
    const handle = cleanHandle(own.username);
    if (handle !== undefined) accounts.set(handle, "client");
  }
  for (const ref of input.referenceAccounts) {
    if (ref.platform !== "instagram") continue;
    const handle = cleanHandle(ref.handle);
    if (handle !== undefined && !accounts.has(handle)) accounts.set(handle, "reference");
  }
  const competitorSites: Array<{ name: string; website: string }> = [];
  for (const row of input.competitors) {
    if (typeof row.name !== "string" || typeof row.website !== "string") continue;
    const website = /^https?:\/\//iu.test(row.website) ? row.website : `https://${row.website}`;
    try {
      new URL(website);
    } catch {
      continue;
    }
    competitorSites.push({ name: row.name.trim(), website });
    if (competitorSites.length >= EXEMPLAR_MAX_COMPETITORS) break;
  }
  return { accounts: [...accounts.entries()].slice(0, 15).map(([handle, role]) => ({ handle, role })), competitorSites };
}

/** The harvest tool's exemplar row, as far as this module reads it. */
export interface HarvestedExemplar {
  url: string;
  handle: string;
  role: ExemplarRole;
  format: "carousel" | "reel" | "single";
  frames: string[];
  frameCount: number;
  hook: string;
  likes: number;
  comments: number;
  views?: number;
  percentile: number;
  liftOverBaseline?: number;
  outlier?: boolean;
}

/** What the judge is shown: breakouts first, stills before reels (the agent designs carousels). */
export function postsToJudge(exemplars: readonly HarvestedExemplar[], max = EXEMPLAR_JUDGE_POSTS): HarvestedExemplar[] {
  const still = (e: HarvestedExemplar) => Number(e.format !== "reel");
  return [...exemplars]
    .sort((a, b) => Number(b.outlier === true) - Number(a.outlier === true) || still(b) - still(a) || (b.liftOverBaseline ?? 0) - (a.liftOverBaseline ?? 0))
    .slice(0, max);
}

export interface LibraryEntry {
  handle: string;
  role: ExemplarRole;
  format: string;
  frameCount: number;
  /** Times its own account's median. */
  lift?: number;
  craft: number;
  dna: Record<string, unknown>;
  standout: string;
  hook: string;
  /** Reference-only copies in the media bucket. Never republished. */
  storedFrames: string[];
}

export interface ExemplarLibrary {
  version: 1;
  builtAt: string;
  status: "built" | "failed";
  /** Why a failed build failed, and what a built one could not read. */
  problems: string[];
  accounts: Array<{ handle: string; role: ExemplarRole; posts: number; medianCarouselFrames?: number }>;
  calibration?: { anchors: number; shift: number; note: string };
  entries: LibraryEntry[];
}

interface JudgedRow {
  ref: string;
  craft: number;
  dna: Record<string, unknown>;
  standout: string;
  storedFrames: string[];
  exemplar: boolean;
}

/** The library from one harvest and its judgement: the judged exemplars, best craft first. */
export function buildExemplarLibrary(input: {
  now: Date;
  harvest: { accounts: ReadonlyArray<{ handle: string; role: ExemplarRole; posts: number; medianCarouselFrames?: number }>; exemplars: readonly HarvestedExemplar[]; problems: readonly string[] };
  judged?: { judged: readonly JudgedRow[]; calibration?: { anchors: number; shift: number; note: string }; failures?: ReadonlyArray<{ ref: string; reason: string }> } | undefined;
  problems?: readonly string[];
}): ExemplarLibrary {
  const byUrl = new Map(input.harvest.exemplars.map((e) => [e.url, e]));
  const entries: LibraryEntry[] = (input.judged?.judged ?? [])
    .filter((j) => j.exemplar)
    .flatMap((j) => {
      const post = byUrl.get(j.ref);
      if (post === undefined) return [];
      return [
        {
          handle: post.handle,
          role: post.role,
          format: post.format,
          frameCount: post.frameCount,
          ...(post.liftOverBaseline !== undefined ? { lift: post.liftOverBaseline } : {}),
          craft: j.craft,
          dna: j.dna,
          standout: j.standout,
          hook: post.hook.slice(0, 140),
          storedFrames: j.storedFrames.slice(0, 5),
        },
      ];
    })
    .sort((a, b) => b.craft - a.craft || (b.lift ?? 0) - (a.lift ?? 0));
  return {
    version: 1,
    builtAt: input.now.toISOString(),
    status: entries.length > 0 ? "built" : "failed",
    problems: [...(input.problems ?? []), ...input.harvest.problems, ...(input.judged?.failures ?? []).map((f) => `judge: ${f.reason}`)].slice(0, 20),
    accounts: input.harvest.accounts.map((a) => ({ handle: a.handle, role: a.role, posts: a.posts, ...(a.medianCarouselFrames !== undefined ? { medianCarouselFrames: a.medianCarouselFrames } : {}) })),
    ...(input.judged?.calibration !== undefined ? { calibration: input.judged.calibration } : {}),
    entries,
  };
}

/** A failed build, remembered so setup waits `EXEMPLAR_LIBRARY_RETRY_DAYS` instead of re-paying every run. */
export function failedLibrary(now: Date, problems: readonly string[]): ExemplarLibrary {
  return { version: 1, builtAt: now.toISOString(), status: "failed", problems: [...problems].slice(0, 20), accounts: [], entries: [] };
}

export function readExemplarLibrary(value: unknown): ExemplarLibrary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Partial<ExemplarLibrary>;
  if (v.version !== 1 || typeof v.builtAt !== "string" || !Array.isArray(v.entries)) return undefined;
  return v as ExemplarLibrary;
}

/** `reuse` a fresh library, `wait` after a recent failure, `build` otherwise. */
export function exemplarLibraryAction(library: ExemplarLibrary | undefined, now: Date): "reuse" | "wait" | "build" {
  if (library === undefined) return "build";
  const ageDays = (now.getTime() - new Date(library.builtAt).getTime()) / 86_400_000;
  if (library.status === "failed") return ageDays < EXEMPLAR_LIBRARY_RETRY_DAYS ? "wait" : "build";
  return ageDays < EXEMPLAR_LIBRARY_TTL_DAYS ? "reuse" : "build";
}

function dnaLine(dna: Record<string, unknown>): string {
  const pick = (k: string) => (typeof dna[k] === "string" || typeof dna[k] === "number" ? String(dna[k]) : undefined);
  return [
    pick("coverType") && `cover ${pick("coverType")}`,
    pick("picturePlacement") && `picture ${pick("picturePlacement")}`,
    pick("elementGroupsPerSlide") && `${pick("elementGroupsPerSlide")} element groups`,
    pick("textDensity") && `${pick("textDensity")} text`,
    pick("emphasis") && pick("emphasis") !== "none" && `emphasis ${pick("emphasis")}`,
    pick("device") && pick("device") !== "none" && `device ${pick("device")}`,
    pick("groundStyle") && `ground ${pick("groundStyle")}`,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(", ");
}

/**
 * The Template Studio's reference-image notes: DESCRIPTIONS of proven posts,
 * never pixels (the studio's own rule). Breakouts from every harvested
 * account, so the pool of styles is wider than one house look. Competitor
 * handles are named as roles, not as brands to imitate.
 */
export function exemplarStudioNotes(library: ExemplarLibrary | undefined, max = 8): string[] {
  if (library === undefined || library.status !== "built") return [];
  return library.entries.slice(0, max).map((e) => {
    const lift = e.lift !== undefined ? `, ${e.lift}x its account's usual engagement` : "";
    return `A ${e.role} breakout ${e.format}${e.format === "carousel" ? ` of ${e.frameCount} frames` : ""} (craft ${e.craft}/5${lift}): ${dnaLine(e.dna)}. Transferable technique: ${e.standout}`;
  });
}

/**
 * The art director's `patterns` when the client's own feed could not be read
 * (the usual case: visual-pattern consent is rarely on file). Built from the
 * library the setup already paid for: what the client's OWN breakouts and the
 * niche's breakouts are made of, as categories and techniques.
 */
export function exemplarPatternEvidence(library: ExemplarLibrary | undefined): { versionId: string; generatedAt: string; reviewStatus: string; reference: string; templateHints: string[] } | undefined {
  if (library === undefined || library.status !== "built" || library.entries.length === 0) return undefined;
  const own = library.entries.filter((e) => e.role === "client");
  const niche = library.entries.filter((e) => e.role !== "client");
  const share = (entries: readonly LibraryEntry[], key: string): string => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const v = e.dna[key];
      if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v, n]) => `${v} ${Math.round((n / entries.length) * 100)}%`)
      .join(", ");
  };
  const block = (label: string, entries: readonly LibraryEntry[]): string[] =>
    entries.length === 0
      ? []
      : [
          `${label} (${entries.length} judged breakouts):`,
          `- picture placement: ${share(entries, "picturePlacement")}`,
          `- cover: ${share(entries, "coverType")}`,
          `- text density: ${share(entries, "textDensity")}; emphasis: ${share(entries, "emphasis")}`,
          `- ground: ${share(entries, "groundStyle")}`,
        ];
  return {
    versionId: `exemplars-${library.builtAt.slice(0, 10)}`,
    generatedAt: library.builtAt,
    reviewStatus: "unreviewed",
    reference: [
      "Measured from posts that broke out of their own account's baseline (engagement at 2x+ the account's median), judged for craft. Categories, not looks to copy.",
      ...block("The client's own breakouts", own),
      ...block("Breakouts across the niche (competitors and reference accounts)", niche),
    ].join("\n"),
    templateHints: library.entries.slice(0, 6).map((e) => e.standout),
  };
}

/**
 * RFC-26 Phase 4a: the library as a per-client PRIOR, first lever. When the
 * breakouts judged across the client's niche are photo-led, a client with no
 * stated preference and no industry default runs photo-first. Owner rulings
 * still bind: the band only raises the picture share, never lowers the floor.
 */
export const PHOTO_LED_SHARE_FOR_PHOTO_FIRST = 0.6;

export function photoLedShare(library: ExemplarLibrary | undefined): number | undefined {
  if (library === undefined || library.status !== "built" || library.entries.length < 5) return undefined;
  const photoLed = library.entries.filter((e) => {
    const placement = typeof e.dna["picturePlacement"] === "string" ? (e.dna["picturePlacement"] as string) : "";
    const cover = typeof e.dna["coverType"] === "string" ? (e.dna["coverType"] as string) : "";
    return ["full-bleed", "inset", "split", "mixed"].includes(placement) || /^(photo|person|product)/u.test(cover);
  }).length;
  return photoLed / library.entries.length;
}

export function densityFromLibrary(library: ExemplarLibrary | undefined): "photo-first" | undefined {
  const share = photoLedShare(library);
  return share !== undefined && share >= PHOTO_LED_SHARE_FOR_PHOTO_FIRST ? "photo-first" : undefined;
 * RFC-26 Phase 4c: the hook SHAPES that broke out in this niche, for the
 * writer (copy prompt section 32). Shares of the judged breakouts' hook
 * pattern plus the top transferable techniques. Shapes and techniques only:
 * no caption text, no handle, so nothing a competitor wrote can be copied.
 */
export function nicheHooksForCopy(library: ExemplarLibrary | undefined): string | undefined {
  if (library === undefined || library.status !== "built" || library.entries.length < 5) return undefined;
  const counts = new Map<string, number>();
  for (const e of library.entries) {
    const p = typeof e.dna["hookPattern"] === "string" ? (e.dna["hookPattern"] as string) : undefined;
    if (p !== undefined && p !== "other") counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const shares = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p, n]) => `${p} ${Math.round((n / library.entries.length) * 100)}%`)
    .join(", ");
  const techniques = library.entries
    .slice(0, 3)
    .map((e) => e.standout)
    .filter((t) => typeof t === "string" && t.length > 0);
  return `Hook shapes of ${library.entries.length} posts that broke out of their own account's baseline in this niche: ${shares}.` +
    (techniques.length > 0 ? ` Techniques they share: ${techniques.join("; ")}.` : "");
}
