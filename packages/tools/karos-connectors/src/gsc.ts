import { z } from "zod";
import { allowlistedRead, type ReadRuntime } from "./read.js";
import type { ConnectorReadOutcome } from "./types.js";

/**
 * Google Search Console — the three methods `connectors[0].read_methods_allowlist`
 * permits, and only those:
 *
 *   searchanalytics.query · urlInspection.index.inspect · sitemaps.list
 *
 * Scope is `webmasters.readonly` (`connectors[0].oauth_scope_readonly`), which
 * is read-only at the grant level too, so the allowlist here is belt-and-braces
 * rather than the sole guard it is for `gbp`.
 *
 * GSC is a first-party SITE-DATA source, never an AI-answer engine
 * (`ladder_distinction`) — nothing in this file feeds an engine list, and the
 * `engine_vs_gsc_note` this package's config edits propose exists to keep that
 * distinction from eroding.
 */
const GSC_BASE = "https://searchconsole.googleapis.com";

export const SEARCH_ANALYTICS_QUERY = "searchanalytics.query";
export const URL_INSPECTION_INSPECT = "urlInspection.index.inspect";
export const SITEMAPS_LIST = "sitemaps.list";

/** One `searchAnalytics.query` row: `keys` holds one entry per requested dimension, in request order. */
export const SearchAnalyticsRowSchema = z.object({
  keys: z.array(z.string()).optional(),
  clicks: z.number().optional(),
  impressions: z.number().optional(),
  ctr: z.number().optional(),
  position: z.number().optional(),
});
export const SearchAnalyticsResponseSchema = z.object({
  rows: z.array(SearchAnalyticsRowSchema).optional(),
  responseAggregationType: z.string().optional(),
});
export type SearchAnalyticsResponse = z.infer<typeof SearchAnalyticsResponseSchema>;

export const UrlInspectionResponseSchema = z.object({
  inspectionResult: z.object({
    inspectionResultLink: z.string().optional(),
    indexStatusResult: z
      .object({
        verdict: z.string().optional(),
        coverageState: z.string().optional(),
        robotsTxtState: z.string().optional(),
        indexingState: z.string().optional(),
        lastCrawlTime: z.string().optional(),
        pageFetchState: z.string().optional(),
      })
      .optional(),
    mobileUsabilityResult: z.object({ verdict: z.string().optional(), issues: z.array(z.object({ issueType: z.string().optional(), severity: z.string().optional(), message: z.string().optional() })).optional() }).optional(),
    richResultsResult: z.object({ verdict: z.string().optional() }).optional(),
  }),
});
export type UrlInspectionResponse = z.infer<typeof UrlInspectionResponseSchema>;

export const SitemapsListResponseSchema = z.object({
  sitemap: z
    .array(
      z.object({
        path: z.string().optional(),
        lastSubmitted: z.string().optional(),
        lastDownloaded: z.string().optional(),
        isPending: z.boolean().optional(),
        isSitemapsIndex: z.boolean().optional(),
        errors: z.union([z.string(), z.number()]).optional(),
        warnings: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),
});
export type SitemapsListResponse = z.infer<typeof SitemapsListResponseSchema>;

export interface GscAuth {
  accessToken: string;
  /** `sc-domain:example.com` or `https://example.com/`; percent-encoded into the path, as the API requires. */
  siteUrl: string;
}

export interface SearchAnalyticsQueryRequest {
  startDate: string;
  endDate: string;
  dimensions?: readonly string[];
  rowLimit?: number;
  /** e.g. `[{ dimension: "searchAppearance", operator: "equals", expression: "AI_OVERVIEW" }]` for the Generative-AI performance rows GEO-28 reads. */
  dimensionFilterGroups?: readonly unknown[];
  type?: string;
}

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" } };
}

/** `searchanalytics.query` — the classic ranking family (position/impressions/clicks/CTR) and, with a `searchAppearance` filter, the AI-surface impressions GEO-28 upgrades to. */
export async function searchAnalyticsQuery(
  auth: GscAuth,
  request: SearchAnalyticsQueryRequest,
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome<SearchAnalyticsResponse>> {
  const url = `${GSC_BASE}/webmasters/v3/sites/${encodeURIComponent(auth.siteUrl)}/searchAnalytics/query`;
  const body: Record<string, unknown> = { startDate: request.startDate, endDate: request.endDate };
  if (request.dimensions) body["dimensions"] = [...request.dimensions];
  if (request.rowLimit !== undefined) body["rowLimit"] = request.rowLimit;
  if (request.dimensionFilterGroups) body["dimensionFilterGroups"] = [...request.dimensionFilterGroups];
  if (request.type !== undefined) body["type"] = request.type;

  return allowlistedRead(
    {
      connector: "gsc",
      method: SEARCH_ANALYTICS_QUERY,
      url,
      init: { method: "POST", ...bearer(auth.accessToken), body: JSON.stringify(body) },
      vendor: "the Search Console API",
    },
    runtime,
    SearchAnalyticsResponseSchema,
  );
}

/** `urlInspection.index.inspect` — Google's own enhancements/issues for one URL, the `google_own_recommendations` source. */
export async function urlInspectionIndexInspect(auth: GscAuth, inspectionUrl: string, runtime: ReadRuntime): Promise<ConnectorReadOutcome<UrlInspectionResponse>> {
  return allowlistedRead(
    {
      connector: "gsc",
      method: URL_INSPECTION_INSPECT,
      url: `${GSC_BASE}/v1/urlInspection/index:inspect`,
      init: { method: "POST", ...bearer(auth.accessToken), body: JSON.stringify({ inspectionUrl, siteUrl: auth.siteUrl }) },
      vendor: "the Search Console API",
    },
    runtime,
    UrlInspectionResponseSchema,
  );
}

/** `sitemaps.list` — submitted sitemaps for the property, which is one half of `url_scope` ("sitemap INTERSECT crawl_snapshot reachable URLs"). */
export async function sitemapsList(auth: GscAuth, runtime: ReadRuntime): Promise<ConnectorReadOutcome<SitemapsListResponse>> {
  return allowlistedRead(
    {
      connector: "gsc",
      method: SITEMAPS_LIST,
      url: `${GSC_BASE}/webmasters/v3/sites/${encodeURIComponent(auth.siteUrl)}/sitemaps`,
      init: { method: "GET", ...bearer(auth.accessToken) },
      vendor: "the Search Console API",
    },
    runtime,
    SitemapsListResponseSchema,
  );
}
