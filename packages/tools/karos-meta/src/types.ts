import { z } from "zod";

export type MetaFetchImpl = typeof fetch;

export interface MetaCredentials {
  /**
   * Karos Labs' own Meta Business Manager System User token. Never
   * per-client — see the README for why this connector carries one shared
   * credential instead of a per-client OAuth pair.
   */
  systemUserToken?: string;
  /**
   * Second gate on `meta.publishInstagramPost` (see `env.ts`/`publish.ts`).
   * `false` unless `META_PUBLISH_ENABLED` is explicitly set — a deployment
   * with a token configured for reads has NOT thereby opted into posting.
   */
  publishEnabled: boolean;
}

/**
 * Same three-way shape `karos-connectors`' `ConnectorReadOutcome` uses, for
 * the same reason: a read that could not run says so, and never returns an
 * empty success that reads downstream as "measured zero". Declared locally
 * rather than imported from `karos-connectors` — that package is the Google
 * connector pack for the SEO/GEO scorer specifically (its `ConnectorKey`
 * union is pinned against `connectors-config.data.ts`), and Instagram/
 * Facebook insights are not a SEO/GEO signal, so this stays its own package
 * with its own (smaller) contract instead of widening that one.
 */
export const META_READ_STATUSES = ["ok", "UNAVAILABLE", "not_connected"] as const;
export type MetaReadStatus = (typeof META_READ_STATUSES)[number];

export interface MetaReadOutcome<TPayload = unknown> {
  /** Which of this package's read functions produced this outcome — the audit trail, mirrors `ConnectorReadOutcome.method`. */
  method: string;
  status: MetaReadStatus;
  /** Present on `UNAVAILABLE`/`not_connected`; the honest reason, never a fabricated value. */
  reason?: string;
  payload?: TPayload;
  /** HTTP attempts actually spent, so a caller can see a retried 429/5xx in its telemetry rather than inferring it. */
  attempts?: number;
}

/**
 * One client's Meta connection, as this package needs it: which Page (and,
 * once resolved, which Instagram professional account) Karos Labs' System
 * User may read for them. No token lives here — the one token is the
 * deployment's `META_SYSTEM_USER_TOKEN`, injected via `MetaCredentials`.
 */
export interface MetaConnection {
  clientId: string;
  /** The client's Facebook Page id — what a client actually has to hand when they set this up, whether or not Karos Labs sells Facebook as a channel. */
  pageId?: string;
  /** Resolved once via `resolveInstagramBusinessAccountId` and cached by the caller; this package never persists it. */
  igBusinessAccountId?: string;
  /** Set when the client removed Karos Labs as a Business Manager partner. */
  revokedAt?: string | null;
}

export const MetaConnectionSchema = z.object({
  clientId: z.string().min(1).describe("The Karos client this connection belongs to; every read is scoped to it by the caller."),
  pageId: z.string().min(1).optional().describe("The client's Facebook Page id — required to resolve their linked Instagram professional account."),
  igBusinessAccountId: z.string().min(1).optional().describe("The Instagram professional account id, once resolved. Supplying it skips the Page lookup."),
  revokedAt: z.string().nullable().optional().describe("Set when the client removed Karos Labs as a partner in their Business Manager; a revoked row is skipped and reports not_connected."),
});

/** The Instagram media types the insights endpoint treats differently — see `metricsForMediaType` in `insights.ts`. */
export const MEDIA_TYPES = ["FEED", "REELS", "STORY"] as const;
export type MetaMediaType = (typeof MEDIA_TYPES)[number];

export interface MetaMediaSummary {
  id: string;
  mediaType: MetaMediaType;
  caption?: string;
  timestamp?: string;
  permalink?: string;
}

/**
 * The six metrics the portal reports, normalized to one shape. `null` —
 * never a fabricated `0` — marks a metric the media TYPE does not support
 * (e.g. `follows`/`profileVisits` are not offered for REELS), matching the
 * "pull what you can, never invent a zero" rule this codebase's other
 * connectors already follow (`karos-connectors`' `UNCONNECTED_SENTINEL`,
 * `analytics-providers.ts`'s "pull what you can" comment).
 */
export interface MetaMediaInsights {
  mediaId: string;
  reach: number | null;
  views: number | null;
  saved: number | null;
  shares: number | null;
  follows: number | null;
  profileVisits: number | null;
}

/**
 * What a client's Instagram post needs, at the level this package's caller
 * (an agent step) actually has it: one image, already hosted somewhere
 * publicly fetchable, plus an optional caption. Video/Reels and carousels are
 * NOT covered by `publishInstagramImagePost` — Meta's container flow for
 * those needs status polling this package does not yet implement (see
 * `publish.ts`'s module header); adding them is a follow-up, not a silent gap.
 */
export interface InstagramImagePostInput {
  /** Must be a public HTTPS URL — Meta's servers fetch it, this package never uploads bytes directly. */
  imageUrl: string;
  caption?: string;
}

export interface MetaPublishResult {
  /** The Instagram media id of the now-live post. */
  mediaId: string;
  /** `https://www.instagram.com/p/<shortcode>/`-shaped permalink, when Meta returns one for the freshly published media. */
  permalink?: string;
}
