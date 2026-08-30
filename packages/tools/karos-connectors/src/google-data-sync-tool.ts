import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { CONNECTOR_KEYS, ReadMethodNotAllowedError, type ConnectorKey } from "./allowlist.js";
import { mintAccessToken } from "./access-token.js";
import { cruxQueryRecord, runPagespeed, CruxOptInRequiredError, CRUX_QUERY_RECORD, PAGESPEED_RUNPAGESPEED } from "./crux.js";
import { adminReadProperty, runReport, ADMIN_READ, PROPERTIES_RUN_REPORT } from "./ga4.js";
import { accountsLocationsList, getDailyMetricsTimeSeries, locationsGet, DAILY_METRICS_TIME_SERIES, LOCATIONS_GET, LOCATIONS_LIST } from "./gbp.js";
import { searchAnalyticsQuery, sitemapsList, urlInspectionIndexInspect, SEARCH_ANALYTICS_QUERY, SITEMAPS_LIST, URL_INSPECTION_INSPECT } from "./gsc.js";
import type { ReadRuntime } from "./read.js";
import { readConnectorCredentialsFromEnv } from "./env.js";
import { GoogleConnectionSchema, UNCONNECTED_SENTINEL, type ConnectorCredentials, type ConnectorFetchImpl, type ConnectorReadOutcome, type GoogleConnection } from "./types.js";

// 1.0.0 — first cut (SCRUM-232 / T-A6).
const TOOL_VERSION = "1.0.0";

const DateSchema = z.object({ year: z.number().int(), month: z.number().int(), day: z.number().int() });

/**
 * One requested read, keyed on the connector's own allowlist token. The union
 * IS the allowlist's public face: there is no "arbitrary path" member, so a
 * caller cannot express a write, and `allowlistedRead` re-checks the token
 * anyway before any URL is built.
 */
const ReadRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal(SEARCH_ANALYTICS_QUERY),
    startDate: z.string().describe("Inclusive ISO start date (YYYY-MM-DD) for the Search Analytics window."),
    endDate: z.string().describe("Inclusive ISO end date (YYYY-MM-DD) for the Search Analytics window."),
    dimensions: z.array(z.string()).optional().describe("Search Analytics dimensions, e.g. [\"query\"] or [\"page\",\"date\"]."),
    rowLimit: z.number().int().positive().max(25_000).optional().describe("Maximum rows to return (Search Console's own cap is 25000)."),
    type: z.string().optional().describe("Search type, e.g. \"web\" — used to scope the AI-surface report GEO-28 reads."),
  }),
  z.object({
    method: z.literal(URL_INSPECTION_INSPECT),
    inspectionUrl: z.string().min(1).describe("The exact URL to inspect; must be inside the connected property."),
  }),
  z.object({ method: z.literal(SITEMAPS_LIST) }),
  z.object({
    method: z.literal(PROPERTIES_RUN_REPORT),
    dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string() })).min(1).describe("GA4 report date ranges."),
    metrics: z.array(z.object({ name: z.string() })).min(1).describe("GA4 metric names, e.g. [{name:\"sessions\"}]."),
    dimensions: z.array(z.object({ name: z.string() })).optional().describe("GA4 dimension names, e.g. [{name:\"sessionDefaultChannelGroup\"}] for the AI-referral channel."),
    limit: z.number().int().positive().optional().describe("Maximum GA4 rows to return."),
  }),
  z.object({ method: z.literal(ADMIN_READ) }),
  z.object({
    method: z.literal(PAGESPEED_RUNPAGESPEED),
    url: z.string().min(1).describe("The page to run the Lighthouse lab audit against."),
    strategy: z.enum(["mobile", "desktop"]).optional().describe("Which Lighthouse form factor to audit."),
  }),
  z.object({
    method: z.literal(CRUX_QUERY_RECORD),
    origin: z.string().optional().describe("Origin to read CrUX field data for; supply this or url."),
    url: z.string().optional().describe("Exact URL to read CrUX field data for; supply this or origin."),
    formFactor: z.enum(["PHONE", "DESKTOP", "TABLET", "ALL_FORM_FACTORS"]).optional().describe("CrUX form factor to slice by."),
  }),
  z.object({
    method: z.literal(LOCATIONS_LIST),
    readMask: z.string().optional().describe("Business Information readMask; defaults to exactly the fields the connector config says GBP provides."),
    pageSize: z.number().int().positive().optional().describe("Page size for the locations listing."),
  }),
  z.object({
    method: z.literal(LOCATIONS_GET),
    locationName: z.string().min(1).describe("The location resource name (locations/{id}) to read."),
    readMask: z.string().optional().describe("Business Information readMask for this location."),
  }),
  z.object({
    method: z.literal(DAILY_METRICS_TIME_SERIES),
    locationName: z.string().min(1).describe("The location resource name (locations/{id}) to read performance for."),
    dailyMetric: z.string().min(1).describe("The daily metric to fetch, e.g. BUSINESS_IMPRESSIONS_DESKTOP_SEARCH."),
    start: DateSchema.describe("Inclusive start date of the daily range."),
    end: DateSchema.describe("Inclusive end date of the daily range."),
  }),
]);
export type ConnectorReadRequest = z.infer<typeof ReadRequestSchema>;

export const GoogleDataSyncInputSchema = z.object({
  connection: GoogleConnectionSchema.describe("The client's Google connection — a revoked or absent one degrades to Layer 2 rather than erroring."),
  reads: z.array(ReadRequestSchema).min(1).describe("The allowlisted connector reads to perform this sync, each named by its own read_methods_allowlist token."),
});
export type GoogleDataSyncInput = z.infer<typeof GoogleDataSyncInputSchema>;

export interface GoogleDataSyncResult {
  clientId: string;
  outcomes: ConnectorReadOutcome[];
  /**
   * `reproducibility.new_hashes`, resolved for this run. A connector with no
   * successful read resolves to the `UNCONNECTED` sentinel — the value the
   * digest writer's sentinel-collapse is defined against — never a zero and
   * never an empty string.
   */
  snapshotHashes: Record<"gsc_snapshot_hash" | "ga_snapshot_hash" | "crux_snapshot_hash" | "gbp_snapshot_hash", string>;
}

const SNAPSHOT_HASH_KEYS: Record<ConnectorKey, keyof GoogleDataSyncResult["snapshotHashes"]> = {
  gsc: "gsc_snapshot_hash",
  ga4: "ga_snapshot_hash",
  crux: "crux_snapshot_hash",
  gbp: "gbp_snapshot_hash",
};

/** Which connector owns each allowlisted method — the only mapping in this package, so a method can never be dispatched under the wrong connector's allowlist. */
const METHOD_CONNECTOR: Record<ConnectorReadRequest["method"], ConnectorKey> = {
  [SEARCH_ANALYTICS_QUERY]: "gsc",
  [URL_INSPECTION_INSPECT]: "gsc",
  [SITEMAPS_LIST]: "gsc",
  [PROPERTIES_RUN_REPORT]: "ga4",
  [ADMIN_READ]: "ga4",
  [PAGESPEED_RUNPAGESPEED]: "crux",
  [CRUX_QUERY_RECORD]: "crux",
  [LOCATIONS_LIST]: "gbp",
  [LOCATIONS_GET]: "gbp",
  [DAILY_METRICS_TIME_SERIES]: "gbp",
};

/** Only the OAuth connectors need a bearer token; crux is key-gated and must never trigger a token mint. */
function needsAccessToken(method: ConnectorReadRequest["method"]): boolean {
  return METHOD_CONNECTOR[method] !== "crux";
}

function unavailable(connector: ConnectorKey, method: string, reason: string): ConnectorReadOutcome {
  return { connector, method, status: "UNAVAILABLE", reason };
}

function notConnected(connector: ConnectorKey, method: string, reason: string): ConnectorReadOutcome {
  return { connector, method, status: "not_connected", reason };
}

/** A frozen digest of what this connector actually returned — the "captured-once-then-frozen" rule (`scorer_reads_snapshot_only`): the scorer reads this, Google is never re-asked live. */
function snapshotHashOf(payloads: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(payloads), "utf8").digest("hex");
}

export interface CreateGoogleDataSyncOptions {
  /** Defaults to `process.env` — injectable so a workflow (or a test) supplies credentials without mutating the real process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — injectable so tests supply canned responses instead of hitting Google. */
  fetchImpl?: ConnectorFetchImpl;
  /** Retry/deadline overrides, threaded straight into the shared `fetchWithRetry`. */
  runtime?: Omit<ReadRuntime, "fetchImpl">;
}

async function dispatch(
  read: ConnectorReadRequest,
  connection: GoogleConnection,
  credentials: ConnectorCredentials,
  accessToken: string | null,
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome> {
  const connector = METHOD_CONNECTOR[read.method];
  const psiApiKey = credentials.psiApiKey;
  const gscSiteUrl = connection.gscSiteUrl ?? credentials.gscSiteUrl;

  // Switched on `read.method` rather than on the connector so the discriminated
  // union narrows: each branch sees only its own method's parameters, which is
  // what makes "no union member can express a write" a compile-time property
  // and not a comment.
  switch (read.method) {
    case PAGESPEED_RUNPAGESPEED: {
      if (!psiApiKey) return notConnected(connector, read.method, "missing env PSI_API_KEY");
      return runPagespeed({ apiKey: psiApiKey }, { url: read.url, ...(read.strategy ? { strategy: read.strategy } : {}) }, runtime);
    }
    case CRUX_QUERY_RECORD: {
      if (!psiApiKey) return notConnected(connector, read.method, "missing env PSI_API_KEY");
      return cruxQueryRecord(
        { apiKey: psiApiKey },
        connection,
        { ...(read.origin !== undefined ? { origin: read.origin } : {}), ...(read.url !== undefined ? { url: read.url } : {}), ...(read.formFactor ? { formFactor: read.formFactor } : {}) },
        runtime,
      );
    }
    case SEARCH_ANALYTICS_QUERY: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!gscSiteUrl) return notConnected(connector, read.method, "no Search Console property configured for this client (connection.gscSiteUrl / GSC_SITE_URL)");
      return searchAnalyticsQuery(
        { accessToken, siteUrl: gscSiteUrl },
        {
          startDate: read.startDate,
          endDate: read.endDate,
          ...(read.dimensions ? { dimensions: read.dimensions } : {}),
          ...(read.rowLimit !== undefined ? { rowLimit: read.rowLimit } : {}),
          ...(read.type !== undefined ? { type: read.type } : {}),
        },
        runtime,
      );
    }
    case URL_INSPECTION_INSPECT: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!gscSiteUrl) return notConnected(connector, read.method, "no Search Console property configured for this client (connection.gscSiteUrl / GSC_SITE_URL)");
      return urlInspectionIndexInspect({ accessToken, siteUrl: gscSiteUrl }, read.inspectionUrl, runtime);
    }
    case SITEMAPS_LIST: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!gscSiteUrl) return notConnected(connector, read.method, "no Search Console property configured for this client (connection.gscSiteUrl / GSC_SITE_URL)");
      return sitemapsList({ accessToken, siteUrl: gscSiteUrl }, runtime);
    }
    case PROPERTIES_RUN_REPORT: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!connection.ga4PropertyId) return notConnected(connector, read.method, "no GA4 property id configured for this client");
      return runReport(
        { accessToken, propertyId: connection.ga4PropertyId },
        { dateRanges: read.dateRanges, metrics: read.metrics, ...(read.dimensions ? { dimensions: read.dimensions } : {}), ...(read.limit !== undefined ? { limit: read.limit } : {}) },
        runtime,
      );
    }
    case ADMIN_READ: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!connection.ga4PropertyId) return notConnected(connector, read.method, "no GA4 property id configured for this client");
      return adminReadProperty({ accessToken, propertyId: connection.ga4PropertyId }, runtime);
    }
    case LOCATIONS_LIST: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      if (!connection.gbpAccountId) return notConnected(connector, read.method, "no GBP account id configured for this client");
      return accountsLocationsList(
        { accessToken },
        { accountId: connection.gbpAccountId, ...(read.readMask ? { readMask: read.readMask } : {}), ...(read.pageSize !== undefined ? { pageSize: read.pageSize } : {}) },
        runtime,
      );
    }
    case LOCATIONS_GET: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      return locationsGet({ accessToken }, { locationName: read.locationName, ...(read.readMask ? { readMask: read.readMask } : {}) }, runtime);
    }
    case DAILY_METRICS_TIME_SERIES: {
      if (accessToken === null) return notConnected(connector, read.method, "no Google access token for this client");
      return getDailyMetricsTimeSeries({ accessToken }, { locationName: read.locationName, dailyMetric: read.dailyMetric, start: read.start, end: read.end }, runtime);
    }
  }
}

/**
 * `connectors.googleDataSync` — the `google-data-sync` job of
 * `connectors-config.data.ts`, as a tool.
 *
 * It performs only allowlisted READ methods, resolves each connector's
 * snapshot hash for the run, and degrades honestly: an unconnected, revoked,
 * or uncredentialed connector reports `not_connected` and its hash resolves to
 * `UNCONNECTED`, which is precisely the Layer-2 default the whole overlay is
 * designed around ("connecting is never a hard dependency"; "revoking cannot
 * break the product").
 *
 * `not_available` is reserved for the deployment-level case — no Google app
 * credentials AND no PSI key at all, i.e. this deployment has not enabled
 * Google connectors — matching how `media.*` distinguishes "not enabled here"
 * from "broke", rather than reporting a `tooling_error` for a configuration
 * choice.
 */
export function createGoogleDataSync(options: CreateGoogleDataSyncOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = readConnectorCredentialsFromEnv(env);

  return defineTool<GoogleDataSyncInput, GoogleDataSyncResult>({
    name: "connectors.googleDataSync",
    description:
      "Reads a client's connected Google first-party data (Search Console, GA4, PageSpeed/CrUX, Business Profile) through an enforced read-only method allowlist, and reports each connector's frozen snapshot hash. A connector that is unconnected, revoked, or missing a credential reports not_connected and resolves to the UNCONNECTED sentinel — never a fabricated zero.",
    version: TOOL_VERSION,
    inputSchema: GoogleDataSyncInputSchema,
    async execute({ connection, reads }) {
      const hasOauthApp = Boolean(credentials.oauthClientId && credentials.oauthClientSecret);
      if (!hasOauthApp && !credentials.psiApiKey) {
        return notAvailable(
          "this deployment has no Google connector credentials configured (GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET for GSC/GA4/GBP, PSI_API_KEY for PageSpeed/CrUX) — the SEO/GEO score is fully computable without them (Layer 2), so this is a deployment choice, not a failure",
        );
      }

      const runtime: ReadRuntime = { fetchImpl, ...(options.runtime ?? {}) };

      // Minted once per sync, held in memory only, and never for a crux-only
      // run: `access_token NOT persisted (minted in memory each sync)`.
      let accessToken: string | null = null;
      let tokenReason = "";
      if (reads.some((read) => needsAccessToken(read.method))) {
        const minted = await mintAccessToken(connection, credentials, runtime);
        if (minted.ok) accessToken = minted.token.accessToken;
        else tokenReason = minted.reason;
      }

      const outcomes: ConnectorReadOutcome[] = [];
      for (const read of reads) {
        const connector = METHOD_CONNECTOR[read.method];
        if (accessToken === null && needsAccessToken(read.method)) {
          outcomes.push(notConnected(connector, read.method, tokenReason || "no Google access token for this client"));
          continue;
        }
        try {
          outcomes.push(await dispatch(read, connection, credentials, accessToken, runtime));
        } catch (err) {
          // The two guards this package enforces surface as their own honest
          // outcomes rather than as a tool-level throw: neither is a fault,
          // both are the design working.
          if (err instanceof ReadMethodNotAllowedError) {
            outcomes.push(unavailable(connector, read.method, err.message));
            continue;
          }
          if (err instanceof CruxOptInRequiredError) {
            outcomes.push(notConnected(connector, read.method, err.message));
            continue;
          }
          throw err;
        }
      }

      const snapshotHashes = Object.fromEntries(Object.values(SNAPSHOT_HASH_KEYS).map((key) => [key, UNCONNECTED_SENTINEL])) as GoogleDataSyncResult["snapshotHashes"];
      for (const connector of CONNECTOR_KEYS) {
        const payloads = outcomes.filter((outcome) => outcome.connector === connector && outcome.status === "ok").map((outcome) => outcome.payload);
        if (payloads.length > 0) snapshotHashes[SNAPSHOT_HASH_KEYS[connector]] = snapshotHashOf(payloads);
      }

      return success({ clientId: connection.clientId, outcomes, snapshotHashes });
    },
  });
}
