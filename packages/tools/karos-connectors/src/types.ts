import { z } from "zod";
import type { ConnectorKey } from "./allowlist.js";

/** Injectable HTTP fetcher — every network-calling client here takes this instead of reaching for the global `fetch`, so tests supply canned responses instead of hitting Google. Mirrors `ReputationFetchImpl`. */
export type ConnectorFetchImpl = typeof fetch;

/**
 * `reproducibility.unconnected_sentinel` (`connectors-config.data.ts:224`):
 * the literal a snapshot hash resolves to when a client has not connected that
 * Google product. It is deliberately a value, never `null` and never `0` —
 * "never a fabricated zero" is the config's own rule (`source_ladder_terminal`),
 * and the digest writer's sentinel-collapse is defined in terms of this exact
 * string.
 */
export const UNCONNECTED_SENTINEL = "UNCONNECTED";

/**
 * One connector read's outcome. Deliberately the same three-way shape
 * `karos-reputation`'s capture legs use (`ok` / `UNAVAILABLE` / skipped),
 * because it encodes the same rule: a leg that could not run says so, and
 * never returns an empty success that reads downstream as "measured zero".
 */
export const CONNECTOR_READ_STATUSES = ["ok", "UNAVAILABLE", "not_connected"] as const;
export type ConnectorReadStatus = (typeof CONNECTOR_READ_STATUSES)[number];

export interface ConnectorReadOutcome<TPayload = unknown> {
  connector: ConnectorKey;
  /** The allowlisted method token this read used — the audit trail for `write_method_protection`. */
  method: string;
  status: ConnectorReadStatus;
  /** Present on `UNAVAILABLE`/`not_connected`; the honest reason, never a fabricated value. */
  reason?: string;
  payload?: TPayload;
  /** HTTP attempts actually spent, so a caller can see a retried 429 in its telemetry rather than inferring it. */
  attempts?: number;
}

/**
 * The credentials a single sync run may use, all injected. Nothing in this
 * package reads `process.env` at module load — the repo's standing rule (see
 * `apps/agent-server/src/wiring/tools.ts`: "no tool reads process.env at
 * module load; everything is constructor-injected from one composition root").
 */
export interface ConnectorCredentials {
  /** PSI/CrUX server secret. `connectors-config.data.ts:255`: "PSI_API_KEY server secret — no per-client OAuth scope". */
  psiApiKey?: string;
  /** Google OAuth app credentials, used ONLY to mint a short-lived access token from a client's refresh token. */
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Agency-property fallback path for GSC (`connectors-config.data.ts:28`, RFC-04 §4) — a service-account key JSON string. */
  gscServiceAccountKey?: string;
  gscSiteUrl?: string;
}

/**
 * A client's Google connection, as this package needs it. The token TABLE
 * (`client_google_tokens`, RLS zero-anon) is infrastructure that does not
 * exist in this repo — `connectors-config.data.ts:257` calls it out as such —
 * so the caller supplies the row's already-decrypted refresh token, or an
 * access token it minted itself. Nothing here persists either
 * ("access_token NOT persisted (minted in memory each sync)").
 */
export interface GoogleConnection {
  clientId: string;
  /** Absent/revoked means the connector reports `not_connected` and its snapshot hash resolves to `UNCONNECTED_SENTINEL`. */
  refreshToken?: string | undefined;
  accessToken?: string | undefined;
  revokedAt?: string | null | undefined;
  gscSiteUrl?: string | undefined;
  ga4PropertyId?: string | undefined;
  gbpAccountId?: string | undefined;
  /** `per_client_gate` (Defect-2): crux field data un-drops ONLY on a per-client opt-in, never on the global PSI_API_KEY landing. */
  cruxOptIn?: boolean | undefined;
}

export const GoogleConnectionSchema = z.object({
  clientId: z.string().min(1).describe("The Karos client this connection belongs to; every read is scoped to it server-side."),
  refreshToken: z.string().min(1).optional().describe("The client's already-decrypted Google OAuth refresh token, from the zero-anon client_google_tokens row."),
  accessToken: z.string().min(1).optional().describe("A short-lived access token the caller already minted; supplied instead of a refresh token. Never persisted."),
  revokedAt: z.string().nullable().optional().describe("Set when the client revoked the grant; a revoked row is skipped and its snapshot hash resolves to UNCONNECTED."),
  gscSiteUrl: z.string().min(1).optional().describe("The Search Console property (sc-domain:example.com or https://example.com/) to read."),
  ga4PropertyId: z.string().min(1).optional().describe("The GA4 numeric property id to run reports against."),
  gbpAccountId: z.string().min(1).optional().describe("The Google Business Profile account id whose locations may be listed."),
  cruxOptIn: z
    .boolean()
    .default(false)
    .describe("Defect-2 per-client gate: CrUX field data is read only when this client opted in, never merely because PSI_API_KEY landed org-wide."),
});
