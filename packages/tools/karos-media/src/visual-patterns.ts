import { z } from "zod";
import { logWarning } from "@agent-engine/telemetry";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, contentFail, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { ScraperError, type ScrapedRecord, type ScraperProvider, type SocialPlatform } from "@agent-engine/tool-karos-scraper";

/**
 * SCRUM-321 (AU37) — historical post ingestion and per-client visual pattern
 * profiles.
 *
 * ## What this is for
 *
 * Every aesthetic decision this engine makes today comes from one static,
 * generic template. A client whose own account has been publishing for three
 * years — with a palette, a crop, a caption shape and an engagement record
 * that says which of those actually landed — contributes nothing to it. This
 * reads that account, asks a vision model what the high performers have in
 * common, and stores the answer as prose a human can read and disagree with.
 *
 * ## Three rules this file is built around
 *
 * 1. **Consent is a gate, not a note.** `readVisualPatternConsent` runs before
 *    the `ScraperProvider` is touched at all, and returns "denied" for an
 *    absent record, an unreadable record, a non-`granted` status, and an
 *    account the consent record does not name. The scraper is not merely
 *    ignored on the denied path — it is never called, which is the only form
 *    of the guarantee that is observable from outside.
 *
 * 2. **The stored form is prose.** An embedding would be smaller, faster and
 *    completely uncorrectable. What is written here is named patterns with an
 *    observation sentence, the post URLs that evidence them, and a confidence
 *    word — a document a strategist can open, read, and mark wrong.
 *
 * 3. **Versions are appended, never overwritten.** Each ingestion writes
 *    `clients/<slug>/client/visual-patterns/v0001.json`, `v0002.json`, … so a
 *    profile that drifts is diffable against the one that preceded it, and a
 *    human correction is just another version with `review.status:
 *    "corrected"`.
 */

// 1.0.0 — new in SCRUM-321 (AU37).
const INGEST_TOOL_VERSION = "1.0.0";
const GET_TOOL_VERSION = "1.0.0";

/** Where a client's versioned visual-pattern profiles live, as `WorkspaceStoreLike` segments. */
export const VISUAL_PATTERNS_SEGMENTS = ["client", "visual-patterns"] as const;

/**
 * Where the consent record lives.
 *
 * Deliberately its own document rather than a key in `client/config`. Three
 * reasons, in order of weight: an absent file is an unambiguous "no", which is
 * the fail-closed default this feature needs; a consent decision carries
 * provenance (who granted it, when, for which accounts) that has no business
 * competing for space in a free-form `Record<string, unknown>` runtime config
 * every other writer also edits; and revoking consent should not mean editing
 * the document that also holds unrelated runtime settings.
 */
export const CLIENT_CONSENT_SEGMENTS = ["client", "consent"] as const;

/** The vision model asked what the high performers have in common. Priced in `packages/core/src/telemetry/pricing.ts`. */
export const DEFAULT_VISION_MODEL = "gemini-2.5-flash";

/** Ceiling on one downloaded reference image. Well under any model's inline-data limit, and enough for a layout read. */
const MAX_IMAGE_BYTES = 4_000_000;

/** Image content-types the vision step will forward. Anything else is skipped rather than guessed at. */
const VISION_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** How much of a post's caption travels into the analysis prompt. */
const CAPTION_EXCERPT_CHARS = 400;

// ─────────────────────────────────────────────────────────────────────────────
// Consent
// ─────────────────────────────────────────────────────────────────────────────

/** One account the client has agreed we may read. */
export interface ConsentedAccount {
  readonly platform: SocialPlatform;
  /** Handle without a leading `@`. Compared case-insensitively. */
  readonly username: string;
}

/**
 * The client's decision about historical-post ingestion.
 *
 * `status` is an explicit word, not a boolean, so "never asked" (no record at
 * all), "asked and declined" (`denied`) and "granted then withdrawn"
 * (`revoked`) are three distinguishable states rather than one falsy value.
 */
export interface VisualPatternConsent {
  readonly status: "granted" | "denied" | "revoked";
  readonly grantedAt?: string;
  readonly grantedBy?: string;
  /**
   * The accounts consent covers. Required in practice: a `granted` status with
   * no accounts named grants nothing, because consent to read "the client's
   * public history" without naming whose history it is cannot be checked.
   */
  readonly accounts?: readonly ConsentedAccount[];
  readonly note?: string;
}

/** `clients/<slug>/client/consent.json`. Open-ended so other consented capabilities can add their own block later. */
export interface ClientConsentRecord {
  readonly visualPatternIngestion?: VisualPatternConsent;
  readonly [key: string]: unknown;
}

/** The gate's answer. `granted: false` means no egress of any kind is permitted for this client. */
export interface VisualPatternConsentDecision {
  readonly granted: boolean;
  /** Why, in the words the refusal will be reported in. Always populated, including on the granted path. */
  readonly reason: string;
  /** The accounts consent actually covers. Empty whenever `granted` is false. */
  readonly accounts: readonly ConsentedAccount[];
  readonly grantedAt?: string;
  readonly grantedBy?: string;
}

function normaliseHandle(username: string): string {
  return username.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Reads the client's consent record and decides whether historical-post
 * ingestion may run at all.
 *
 * Fails closed on every path that is not an explicit yes — including a store
 * read that throws. An unreadable consent record is not "unknown, proceed"; a
 * capability that reads a client's account history on a storage hiccup is
 * exactly the failure mode a consent gate exists to prevent.
 *
 * Exported (rather than kept private to the tool) so the gate has one
 * definition: `research.pull`'s payload path and any future consumer check the
 * same function, and a second copy cannot drift into permissiveness.
 */
export async function readVisualPatternConsent(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<VisualPatternConsentDecision> {
  let record: ClientConsentRecord | undefined;
  try {
    record = await store.readJson<ClientConsentRecord>(clientSlug, [...CLIENT_CONSENT_SEGMENTS]);
  } catch (error) {
    logWarning("visual-patterns: consent record could not be read; failing closed", {
      clientSlug,
      error: (error as Error).message,
    });
    return {
      granted: false,
      reason: `consent record for "${clientSlug}" could not be read (${(error as Error).message}) — failing closed, no account history was fetched`,
      accounts: [],
    };
  }

  if (record === undefined) {
    return {
      granted: false,
      reason:
        `no consent record exists at clients/${clientSlug}/client/consent.json — historical-post ingestion reads a client's ` +
        "public account history and requires an explicit, recorded opt-in. Absent consent is not implied consent.",
      accounts: [],
    };
  }

  const consent = record.visualPatternIngestion;
  if (consent === undefined) {
    return {
      granted: false,
      reason: `clients/${clientSlug}/client/consent.json carries no "visualPatternIngestion" block — this client has never been asked, so no ingestion runs`,
      accounts: [],
    };
  }

  if (consent.status !== "granted") {
    return {
      granted: false,
      reason: `visual-pattern ingestion consent for "${clientSlug}" is "${consent.status}", not "granted" — no account history was fetched`,
      accounts: [],
    };
  }

  const accounts = (consent.accounts ?? []).filter((a) => normaliseHandle(a.username).length > 0);
  if (accounts.length === 0) {
    return {
      granted: false,
      reason:
        `visual-pattern ingestion consent for "${clientSlug}" is "granted" but names no accounts — consent to read "the client's ` +
        "history\" that does not say whose history cannot be checked, so it grants nothing",
      accounts: [],
    };
  }

  return {
    granted: true,
    reason: `consent granted for ${accounts.length} account(s)`,
    accounts: accounts.map((a) => ({ platform: a.platform, username: normaliseHandle(a.username) })),
    ...(consent.grantedAt !== undefined ? { grantedAt: consent.grantedAt } : {}),
    ...(consent.grantedBy !== undefined ? { grantedBy: consent.grantedBy } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The stored profile
// ─────────────────────────────────────────────────────────────────────────────

/** Which axis of the aesthetic a pattern is about. Fixed vocabulary so a reviewer can scan by category. */
export type VisualPatternAxis = "imagery" | "layout" | "typography" | "colour" | "caption" | "engagement";

/** One learned pattern, in the form a human can agree or disagree with. */
export interface VisualPattern {
  /** A short name, e.g. "warm interior light". */
  readonly label: string;
  /** One or two sentences saying what was actually observed. This is the correctable part. */
  readonly observation: string;
  readonly appliesTo: VisualPatternAxis;
  /** URLs of the posts this was drawn from, so a reviewer can go look. */
  readonly evidence: readonly string[];
  readonly confidence: "low" | "medium" | "high";
}

/** One high-performing post the profile was derived from. Kept so the profile is auditable, not just readable. */
export interface VisualPatternSourcePost {
  readonly platform: string;
  readonly url: string;
  readonly publishedAt?: string;
  /** The ranking score this post earned — see `engagementScore`. */
  readonly engagementScore: number;
  readonly engagement?: { readonly likes?: number; readonly comments?: number; readonly views?: number };
  /** The reference image actually shown to the vision model, when there was one. */
  readonly imageUrl?: string;
  readonly excerpt?: string;
}

/** Bumped when the on-disk shape changes, so an old profile is recognisable rather than silently misread. */
export const VISUAL_PATTERN_SCHEMA_ID = "karos.visual-patterns/v1";

/**
 * One version of a client's visual-pattern profile.
 *
 * Every field here is prose, a number, or a URL — nothing in it is an
 * embedding or a score a person cannot argue with. That is the whole design
 * constraint: a learned aesthetic nobody can inspect is a learned aesthetic
 * nobody can correct.
 */
export interface VisualPatternProfile {
  readonly schema: typeof VISUAL_PATTERN_SCHEMA_ID;
  /** 1-based, monotonically increasing per client. */
  readonly version: number;
  /** The store id this version is filed under, e.g. `v0003`. */
  readonly versionId: string;
  readonly clientSlug: string;
  readonly generatedAt: string;
  readonly generatedBy: {
    readonly tool: string;
    readonly toolVersion: string;
    readonly visionModel: string;
    readonly scraper: string;
  };
  /** The consent this read was performed under, copied in so the profile carries its own justification. */
  readonly consent: {
    readonly grantedAt?: string;
    readonly grantedBy?: string;
    readonly accountsRead: readonly ConsentedAccount[];
  };
  /**
   * The human-review state. A machine-written version is always `unreviewed`;
   * a reviewer who corrects the prose files the corrected document as the next
   * version with `corrected`, which is why this lives on the version rather
   * than beside it.
   */
  readonly review: {
    readonly status: "unreviewed" | "approved" | "corrected";
    readonly reviewedBy?: string;
    readonly reviewedAt?: string;
    readonly notes?: string;
  };
  /** A paragraph a strategist can read on its own. */
  readonly summary: string;
  readonly patterns: readonly VisualPattern[];
  /** Plain-language steers for template selection, e.g. "full-bleed photo, caption below". */
  readonly templateHints: readonly string[];
  readonly sourcePosts: readonly VisualPatternSourcePost[];
  /** What the ingestion actually managed to see. Named problems, never a silent shortfall. */
  readonly coverage: {
    readonly accountsRequested: number;
    readonly accountsConsented: number;
    readonly postsSeen: number;
    readonly postsAnalysed: number;
    readonly problems: readonly string[];
  };
}

function versionIdFor(version: number): string {
  return `v${String(version).padStart(4, "0")}`;
}

/**
 * Reads a client's current (highest-numbered) visual-pattern profile, or
 * `undefined` when none has ever been ingested.
 *
 * Exported for callers that need the profile without going through the tool
 * boundary — `research.pull` folds it into its payload this way, exactly as it
 * folds in `readOutputHistory` from `karos-ledger`. Two definitions of where a
 * profile lives is one definition too many.
 */
export async function readVisualPatternProfile(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<VisualPatternProfile | undefined> {
  const versions = await listVisualPatternProfiles(store, clientSlug);
  return versions.at(-1);
}

/** Every stored version for a client, oldest first. */
export async function listVisualPatternProfiles(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<VisualPatternProfile[]> {
  const entries = await store.listJson<VisualPatternProfile>(clientSlug, [...VISUAL_PATTERNS_SEGMENTS]);
  return entries
    .map((e) => e.data)
    .filter((p): p is VisualPatternProfile => p !== null && typeof p === "object" && typeof p.version === "number")
    .sort((a, b) => a.version - b.version);
}

/**
 * Renders a profile as the reference block that goes into a copy prompt or a
 * template-selection prompt.
 *
 * Plain text on purpose. This is the same prose a reviewer reads in the stored
 * document, so what the model is steered by and what a human can correct are
 * the same words — not a rendering of it that can drift.
 */
export function renderVisualPatternReference(profile: VisualPatternProfile): string {
  const lines: string[] = [
    `Client visual patterns (${profile.versionId}, generated ${profile.generatedAt}, review: ${profile.review.status}).`,
    "Learned from this client's own highest-engagement past posts. Treat as this client's house style, not as a rule.",
    "",
    profile.summary,
  ];

  if (profile.patterns.length > 0) {
    lines.push("", "Patterns:");
    for (const pattern of profile.patterns) {
      lines.push(`- [${pattern.appliesTo}] ${pattern.label} (${pattern.confidence} confidence): ${pattern.observation}`);
    }
  }

  if (profile.templateHints.length > 0) {
    lines.push("", "Template steers:");
    for (const hint of profile.templateHints) lines.push(`- ${hint}`);
  }

  if (profile.review.status === "unreviewed") {
    lines.push("", "This profile has not been reviewed by a human yet — prefer the brand kit where the two disagree.");
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How "high-performing" is decided.
 *
 * Comments count triple: leaving one costs more than tapping a like, so it is
 * the stronger signal that a post landed. Views are divided down because they
 * arrive an order of magnitude larger than either and would otherwise be the
 * only thing the ranking sees. A post the provider reports no engagement for
 * scores zero and is excluded from analysis rather than ranked at the bottom —
 * "no data" is not "performed badly".
 */
export function engagementScore(engagement: ScrapedRecord["engagement"]): number {
  if (!engagement) return 0;
  return (engagement.likes ?? 0) + 3 * (engagement.comments ?? 0) + Math.round((engagement.views ?? 0) / 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// The vision step
// ─────────────────────────────────────────────────────────────────────────────

/** One part of a multimodal request — text, or an image the caller has already fetched. */
export type VisionPart = { readonly text: string } | { readonly inlineData: { readonly data: string; readonly mimeType: string } };

/**
 * The vision call, narrowed to what this tool uses, so the package does not
 * take a type dependency on the whole `@google/genai` surface — the same seam
 * (and the same fake-in-tests story) as `ImageGenerationClient` in
 * `generate-image.ts`.
 */
export interface VisionAnalysisClient {
  models: {
    generateContent(request: {
      model: string;
      contents: Array<{ role?: string; parts: VisionPart[] }>;
      config?: Record<string, unknown>;
    }): Promise<{
      candidates?: Array<{
        finishReason?: string | undefined;
        content?: { parts?: Array<{ text?: string }> } | undefined;
      }>;
      promptFeedback?: { blockReason?: string } | undefined;
      /**
       * SCRUM-391: the real per-call token counts, same field the model
       * router's own `gemini-adapter.ts` reads off this same SDK's response
       * shape. Absent (rather than zeroed) is a legitimate value from a fake
       * client in a test that is not exercising cost — every real call
       * reports it.
       */
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    }>;
  };
}

/** What the vision model is asked to return. Parsed strictly — a malformed analysis is reported, never stored. */
const VisionResponseSchema = z.object({
  summary: z.string().min(1),
  patterns: z
    .array(
      z.object({
        label: z.string().min(1),
        observation: z.string().min(1),
        appliesTo: z.enum(["imagery", "layout", "typography", "colour", "caption", "engagement"]).default("imagery"),
        evidence: z.array(z.string()).default([]),
        confidence: z.enum(["low", "medium", "high"]).default("medium"),
      }),
    )
    .min(1),
  templateHints: z.array(z.string()).default([]),
});

const ANALYSIS_INSTRUCTIONS = [
  "You are looking at a client's own highest-engagement social posts, newest metrics attached.",
  "Describe what these posts have in COMMON visually and structurally — the house style a new post should sit inside.",
  "Do not describe the posts one by one, and do not invent a pattern you can only see in a single post.",
  "",
  "Answer with JSON only, no prose outside it, in exactly this shape:",
  "{",
  '  "summary": "one paragraph a strategist can read on its own",',
  '  "patterns": [{"label": "...", "observation": "...", "appliesTo": "imagery|layout|typography|colour|caption|engagement", "evidence": ["post url", "..."], "confidence": "low|medium|high"}],',
  '  "templateHints": ["plain-language steer for template selection", "..."]',
  "}",
  "",
  "Every pattern must cite at least one post URL from the material below in `evidence`.",
  "Use `low` confidence rather than dropping a pattern you are unsure of — a reviewer can delete it, but cannot recover one you never wrote down.",
].join("\n");

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** Downloads one reference image as inline base64, or `undefined` for anything that is not a usable image. */
async function fetchInlineImage(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ data: string; mimeType: string } | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  // Refused rather than guessed, for the same reason `find-images.ts` refuses
  // an unrecognised content-type: an HTML error page forwarded to a vision
  // model as an image produces a confident analysis of nothing.
  if (!VISION_IMAGE_TYPES.has(mimeType)) return undefined;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;

  return { data: bytes.toString("base64"), mimeType };
}

// ─────────────────────────────────────────────────────────────────────────────
// media.ingestVisualPatterns
// ─────────────────────────────────────────────────────────────────────────────

const SOCIAL_PLATFORMS = ["x", "instagram", "reddit", "tiktok"] as const;

export const IngestVisualPatternsInputSchema = z.object({
  accounts: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS).describe("Which social platform this account is on."),
        username: z.string().min(1).describe("The account's handle on that platform, with or without a leading @."),
      }),
    )
    .min(1)
    .max(4)
    .describe(
      "The client's own accounts to read. Every account named here is checked against the client's recorded consent before any scrape happens; an account consent does not name is skipped, not read.",
    ),
  postsPerAccount: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(12)
    .describe("How far back to read per account. Each account is one billed scrape whatever this is, but a deeper read costs more provider time."),
  topPosts: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(6)
    .describe("How many of the highest-engagement posts to actually analyse. Each one costs an image download and travels into the vision prompt."),
});
export type IngestVisualPatternsInput = z.input<typeof IngestVisualPatternsInputSchema>;

export interface IngestVisualPatternsResult {
  /** The version just written. */
  version: number;
  versionId: string;
  /** Where it landed, as reported by the store backend. */
  storedAt: string;
  patternCount: number;
  postsAnalysed: number;
  accountsRead: ConsentedAccount[];
  /** The full profile, so a caller does not have to read it back to use it. */
  profile: VisualPatternProfile;
}

export interface IngestVisualPatternsOptions {
  store: WorkspaceStoreLike;
  /** The account-history backend. Absent means the tool reports `not_available` per call. */
  scraper?: ScraperProvider | undefined;
  /** The vision model. Absent means `not_available`; tests inject a fake, exactly as `image.generate`'s tests do. */
  visionClient?: VisionAnalysisClient | undefined;
  visionModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `media.ingestVisualPatterns` — reads a consenting client's own past
 * high-performing posts and writes a new, reviewable visual-pattern profile
 * version.
 *
 * The consent check is the first thing that happens and the scraper is
 * resolved only after it passes, so "no consent, no ingestion" is a property
 * of the control flow rather than of a comment. Everything downstream of it
 * degrades honestly: an account that fails to scrape becomes a named problem
 * on `coverage`, a post with no engagement data is excluded from ranking
 * rather than scored zero and kept, and a vision response that will not parse
 * is a `content_fail` rather than a profile full of nothing.
 */
export function createIngestVisualPatterns(options: IngestVisualPatternsOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const visionModel = options.visionModel ?? DEFAULT_VISION_MODEL;

  return defineTool<IngestVisualPatternsInput, IngestVisualPatternsResult>({
    name: "media.ingestVisualPatterns",
    description:
      "Opt-in: reads a consenting client's own past high-performing posts, asks a vision model what the high performers have visually in common, and stores the answer as a new reviewable version under client/visual-patterns. Refuses without an explicit recorded consent record naming the accounts — an absent or unreadable consent record means no scrape happens at all.",
    version: INGEST_TOOL_VERSION,
    inputSchema: IngestVisualPatternsInputSchema,
    async execute(rawInput, { ctx }) {
      // `defineTool` has already parsed this against the schema with defaults
      // applied (same note as find-images.ts / pull.ts) — the cast reflects
      // that rather than re-parsing.
      const input = rawInput as z.output<typeof IngestVisualPatternsInputSchema>;

      // ── THE GATE. Nothing below this line runs without an explicit yes, and
      // nothing above it touches the network. ──
      const consent = await readVisualPatternConsent(options.store, ctx.clientSlug);
      if (!consent.granted) {
        return notAvailable(`media.ingestVisualPatterns: ${consent.reason}`);
      }

      const consented = new Set(consent.accounts.map((a) => `${a.platform}/${normaliseHandle(a.username)}`));
      const requested = input.accounts.map((a) => ({ platform: a.platform as SocialPlatform, username: normaliseHandle(a.username) }));
      const permitted = requested.filter((a) => consented.has(`${a.platform}/${a.username}`));
      const refused = requested.filter((a) => !consented.has(`${a.platform}/${a.username}`));

      if (permitted.length === 0) {
        return notAvailable(
          `media.ingestVisualPatterns: none of the requested accounts (${requested.map((a) => `${a.platform}/@${a.username}`).join(", ")}) ` +
            `appear in "${ctx.clientSlug}"'s recorded consent — no account history was fetched`,
        );
      }

      if (options.scraper === undefined) {
        return notAvailable(
          "media.ingestVisualPatterns: no scraper configured — set SCRAPPYCOCO_API_KEY so a client's own account history can be read " +
            "(see packages/tools/karos-media/README.md)",
        );
      }
      if (options.visionClient === undefined) {
        return notAvailable(
          "media.ingestVisualPatterns: no vision model is configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) so past " +
            "posts can be analysed. Refusing to store a profile derived from captions alone: a visual pattern nobody looked at is not a visual pattern.",
        );
      }
      const scraper = options.scraper;
      const visionClient = options.visionClient;

      const problems: string[] = refused.map(
        (a) => `${a.platform}/@${a.username} was requested but is not named in this client's consent record — skipped, not read`,
      );

      // ── Read ──
      const seen: Array<{ record: ScrapedRecord; platform: SocialPlatform }> = [];
      for (const account of permitted) {
        try {
          const posts = await scraper.socialHistory({
            platform: account.platform,
            username: account.username,
            limit: input.postsPerAccount,
          });
          for (const record of posts) seen.push({ record, platform: account.platform });
        } catch (error) {
          // Named per account, as `research.pull`'s history builder is:
          // "history unavailable" is useless when one of three handles is wrong.
          const message = error instanceof ScraperError ? error.message : (error as Error).message;
          problems.push(`could not read ${account.platform}/@${account.username}: ${message}`);
        }
      }

      if (seen.length === 0) {
        return contentFail(
          `media.ingestVisualPatterns: ${permitted.map((a) => `${a.platform}/@${a.username}`).join(", ")} returned no posts` +
            (problems.length > 0 ? ` (${problems.join("; ")})` : "") +
            " — nothing to learn a visual pattern from",
        );
      }

      // ── Rank ──
      const ranked = seen
        .map(({ record, platform }) => ({ record, platform, score: engagementScore(record.engagement) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.topPosts);

      if (ranked.length === 0) {
        return contentFail(
          `media.ingestVisualPatterns: none of the ${seen.length} post(s) read carry engagement figures, so "high-performing" cannot be ` +
            "determined. Refusing to learn an aesthetic from an unranked sample.",
        );
      }

      // ── Look ──
      const parts: VisionPart[] = [{ text: ANALYSIS_INSTRUCTIONS }];
      const sourcePosts: VisualPatternSourcePost[] = [];
      let imagesShown = 0;

      for (const entry of ranked) {
        const { record, platform, score } = entry;
        const imageUrl = record.imageUrls?.[0];
        const excerpt = record.text ?? record.title;
        const engagementLine = [
          `Post: ${record.url}`,
          `Platform: ${platform}`,
          record.publishedAt ? `Published: ${record.publishedAt}` : undefined,
          `Engagement score: ${score}` +
            (record.engagement
              ? ` (likes ${record.engagement.likes ?? 0}, comments ${record.engagement.comments ?? 0}, views ${record.engagement.views ?? 0})`
              : ""),
          excerpt ? `Caption: ${excerpt.slice(0, CAPTION_EXCERPT_CHARS)}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n");
        parts.push({ text: engagementLine });

        let inlineUrl: string | undefined;
        if (imageUrl !== undefined) {
          const inline = await fetchInlineImage(fetchImpl, imageUrl);
          if (inline) {
            parts.push({ inlineData: inline });
            inlineUrl = imageUrl;
            imagesShown += 1;
          } else {
            problems.push(`reference image for ${record.url} could not be fetched as an image — analysed from its caption and metrics only`);
          }
        }

        sourcePosts.push({
          platform,
          url: record.url,
          ...(record.publishedAt !== undefined ? { publishedAt: record.publishedAt } : {}),
          engagementScore: score,
          ...(record.engagement !== undefined ? { engagement: record.engagement } : {}),
          ...(inlineUrl !== undefined ? { imageUrl: inlineUrl } : {}),
          ...(excerpt !== undefined ? { excerpt: excerpt.slice(0, CAPTION_EXCERPT_CHARS) } : {}),
        });
      }

      if (imagesShown === 0) {
        return contentFail(
          "media.ingestVisualPatterns: none of the top posts yielded a fetchable reference image, so there was nothing for a vision " +
            `model to look at${problems.length > 0 ? ` (${problems.join("; ")})` : ""} — no profile written`,
        );
      }

      let responseText: string | undefined;
      // SCRUM-391: the REAL token counts Gemini's own response reports —
      // captured here (not estimated) so the usage reported below reflects
      // what this exact call actually consumed. `?? 0` mirrors
      // `router/adapters/gemini-adapter.ts`'s own handling of an absent
      // `usageMetadata` (never throws over a missing usage field).
      let promptTokens = 0;
      let outputTokens = 0;
      try {
        const response = await visionClient.models.generateContent({
          model: visionModel,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json" },
        });
        promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
        outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
        if (response.promptFeedback?.blockReason) {
          return contentFail(`media.ingestVisualPatterns: the vision model blocked the analysis (${response.promptFeedback.blockReason})`);
        }
        responseText = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? undefined;
      } catch (error) {
        return toolingError(`media.ingestVisualPatterns: the vision model call failed — ${(error as Error).message}`);
      }

      if (responseText === undefined || responseText.trim().length === 0) {
        return contentFail("media.ingestVisualPatterns: the vision model returned no text, so there is no analysis to store");
      }

      let analysis: z.infer<typeof VisionResponseSchema>;
      try {
        analysis = VisionResponseSchema.parse(JSON.parse(stripCodeFence(responseText)));
      } catch (error) {
        // Deliberately a content_fail, not a stored profile with empty
        // patterns: an unreadable analysis is not a client with no house style.
        return contentFail(
          `media.ingestVisualPatterns: the vision model's analysis did not parse as the requested JSON shape — ${(error as Error).message}`,
        );
      }

      // ── Store, as a new version ──
      const existing = await listVisualPatternProfiles(options.store, ctx.clientSlug);
      const version = (existing.at(-1)?.version ?? 0) + 1;
      const versionId = versionIdFor(version);

      const profile: VisualPatternProfile = {
        schema: VISUAL_PATTERN_SCHEMA_ID,
        version,
        versionId,
        clientSlug: ctx.clientSlug,
        generatedAt: new Date().toISOString(),
        generatedBy: {
          tool: "media.ingestVisualPatterns",
          toolVersion: INGEST_TOOL_VERSION,
          visionModel,
          scraper: scraper.name,
        },
        consent: {
          ...(consent.grantedAt !== undefined ? { grantedAt: consent.grantedAt } : {}),
          ...(consent.grantedBy !== undefined ? { grantedBy: consent.grantedBy } : {}),
          accountsRead: permitted,
        },
        review: { status: "unreviewed" },
        summary: analysis.summary,
        patterns: analysis.patterns.map((p) => ({
          label: p.label,
          observation: p.observation,
          appliesTo: p.appliesTo,
          evidence: p.evidence,
          confidence: p.confidence,
        })),
        templateHints: analysis.templateHints,
        sourcePosts,
        coverage: {
          accountsRequested: requested.length,
          accountsConsented: permitted.length,
          postsSeen: seen.length,
          postsAnalysed: ranked.length,
          problems,
        },
      };

      const written = await options.store.writeJson(ctx.clientSlug, [...VISUAL_PATTERNS_SEGMENTS, versionId], profile);

      // This tool makes a real, billed generative call, so it reports what it
      // consumed rather than letting the step record $0 — the shape
      // `packages/workflow/__tests__/cost-accuracy-golden.test.ts` exists to
      // enforce after two real image generations were costed at $0.000000.
      //
      // SCRUM-391: this used to report a single synthetic `{unit:
      // "vision-analysis", quantity: 1}` — one flat "unit" per call, priced at
      // $0 because `UNIT_PRICING` had no row for that made-up SKU. But
      // `gemini-2.5-flash` (unlike `gemini-2.5-flash-image`, a genuinely flat
      // per-image SKU) is billed BY TOKEN, and prompt/image size varies call to
      // call — so a flat per-call rate would have been an invented number, not
      // a verified one. Reports the REAL captured `promptTokens`/`outputTokens`
      // instead, against the two `gemini-2.5-flash-vision-analysis-*-token`
      // rows in `UNIT_PRICING` (telemetry/pricing.ts), each derived from
      // `MODEL_PRICING["gemini-2.5-flash"]`'s own sourced per-token rate — so
      // this bills at the model's real, verified price, exactly, rather than
      // an estimate.
      return success<IngestVisualPatternsResult>(
        {
          version,
          versionId,
          storedAt: written.filePath,
          patternCount: profile.patterns.length,
          postsAnalysed: ranked.length,
          accountsRead: permitted,
          profile,
        },
        [
          { model: "gemini-2.5-flash-vision-analysis-input-token", unit: "input-token", quantity: promptTokens },
          { model: "gemini-2.5-flash-vision-analysis-output-token", unit: "output-token", quantity: outputTokens },
        ],
      );
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// media.getVisualPatterns
// ─────────────────────────────────────────────────────────────────────────────

export const GetVisualPatternsInputSchema = z.object({
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Which stored version to read. Omitted means the newest — pass an older number to see what the profile said before it was re-ingested or corrected."),
});
export type GetVisualPatternsInput = z.input<typeof GetVisualPatternsInputSchema>;

export interface GetVisualPatternsResult {
  profile: VisualPatternProfile;
  /** Every version on file, newest last, so a reviewer can see the history without a second call. */
  versions: Array<{ version: number; versionId: string; generatedAt: string; reviewStatus: string; patternCount: number }>;
  /** The profile rendered as the exact prose block a copy or template-selection prompt receives. */
  reference: string;
}

/**
 * `media.getVisualPatterns` — reads a client's stored profile back out in the
 * form a person, and a prompt, both actually consume.
 *
 * No consent check here, on purpose, and the distinction matters: consent
 * gates *reading the client's account history*, which is egress. This reads a
 * document already stored in the client's own workspace under a consent that
 * was checked when it was written — and each profile carries that consent
 * inline. Gating the read as well would mean a revoked consent silently
 * hid a record the client is entitled to see and correct.
 */
export function createGetVisualPatterns(store: WorkspaceStoreLike) {
  return defineTool<GetVisualPatternsInput, GetVisualPatternsResult>({
    name: "media.getVisualPatterns",
    description:
      "Reads back a client's stored visual-pattern profile — the named patterns learned from their own past high-performing posts, in reviewable prose, plus the version history and the exact reference block a copy or template-selection prompt receives. Reports not_available when no profile has been ingested for this client.",
    version: GET_TOOL_VERSION,
    inputSchema: GetVisualPatternsInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof GetVisualPatternsInputSchema>;
      const all = await listVisualPatternProfiles(store, ctx.clientSlug);
      if (all.length === 0) {
        return notAvailable(
          `media.getVisualPatterns: no visual-pattern profile has been ingested for "${ctx.clientSlug}" yet — run media.ingestVisualPatterns ` +
            "(which requires this client's recorded opt-in) first",
        );
      }

      const profile = input.version === undefined ? all.at(-1)! : all.find((p) => p.version === input.version);
      if (profile === undefined) {
        return notAvailable(
          `media.getVisualPatterns: "${ctx.clientSlug}" has no version ${input.version} — stored versions are ${all.map((p) => p.version).join(", ")}`,
        );
      }

      return success<GetVisualPatternsResult>({
        profile,
        versions: all.map((p) => ({
          version: p.version,
          versionId: p.versionId,
          generatedAt: p.generatedAt,
          reviewStatus: p.review.status,
          patternCount: p.patterns.length,
        })),
        reference: renderVisualPatternReference(profile),
      });
    },
  });
}
