import { z } from "zod";
import { allowlistedRead, type ReadRuntime } from "./read.js";
import type { ConnectorReadOutcome } from "./types.js";

/**
 * Google Analytics 4 — the two entries in `connectors[1].read_methods_allowlist`:
 *
 *   properties.runReport · admin.read
 *
 * `"admin.read"` is not a Google method id the way the other five allowlist
 * entries are; it is a CATEGORY ("Admin API v1 (read)", per the same
 * connector's `api` field). It is enforced as the literal token it is, and
 * `adminReadProperty` below is the single Admin read this package performs
 * under it — the property's own metadata. That mismatch is reported as a
 * config finding rather than silently normalised, because a category token in
 * an allowlist whose stated job is making writes "physically uncallable" is
 * exactly the kind of soft edge that guard cannot afford.
 *
 * GA4 is `diagnostics_only` (`reproducibility.dependency_split`): it feeds no
 * deterministic Index. Its unconnected state is an explicit
 * empty-with-next-step, never a fake zero — which is why an unconnected client
 * gets `not_connected` from the sync rather than a zero-row report.
 */
const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GA4_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";

export const PROPERTIES_RUN_REPORT = "properties.runReport";
export const ADMIN_READ = "admin.read";

export const RunReportResponseSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string().optional() })).optional(),
  metricHeaders: z.array(z.object({ name: z.string().optional(), type: z.string().optional() })).optional(),
  rows: z
    .array(
      z.object({
        dimensionValues: z.array(z.object({ value: z.string().optional() })).optional(),
        metricValues: z.array(z.object({ value: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  rowCount: z.number().optional(),
  /** GA4 sets this when the response is sampled; a sampled number is not a measured one and the caller needs to see it. */
  metadata: z.object({ currencyCode: z.string().optional(), timeZone: z.string().optional() }).optional(),
});
export type RunReportResponse = z.infer<typeof RunReportResponseSchema>;

export const AdminPropertyResponseSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  timeZone: z.string().optional(),
  currencyCode: z.string().optional(),
  createTime: z.string().optional(),
  propertyType: z.string().optional(),
});
export type AdminPropertyResponse = z.infer<typeof AdminPropertyResponseSchema>;

export interface Ga4Auth {
  accessToken: string;
  /** The numeric GA4 property id, with or without the `properties/` prefix. */
  propertyId: string;
}

export interface RunReportRequest {
  dateRanges: readonly { startDate: string; endDate: string }[];
  dimensions?: readonly { name: string }[];
  metrics: readonly { name: string }[];
  dimensionFilter?: unknown;
  limit?: number;
}

function propertyPath(propertyId: string): string {
  return propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
}

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" } };
}

/** `properties.runReport` — the AI-referral channel sessions/conversions GEO-29 reads, plus organic referrals and key events. */
export async function runReport(auth: Ga4Auth, request: RunReportRequest, runtime: ReadRuntime): Promise<ConnectorReadOutcome<RunReportResponse>> {
  const body: Record<string, unknown> = { dateRanges: [...request.dateRanges], metrics: [...request.metrics] };
  if (request.dimensions) body["dimensions"] = [...request.dimensions];
  if (request.dimensionFilter !== undefined) body["dimensionFilter"] = request.dimensionFilter;
  if (request.limit !== undefined) body["limit"] = request.limit;

  return allowlistedRead(
    {
      connector: "ga4",
      method: PROPERTIES_RUN_REPORT,
      url: `${GA4_DATA_BASE}/${propertyPath(auth.propertyId)}:runReport`,
      init: { method: "POST", ...bearer(auth.accessToken), body: JSON.stringify(body) },
      vendor: "the GA4 Data API",
    },
    runtime,
    RunReportResponseSchema,
  );
}

/** The one Admin API read performed under the `admin.read` allowlist token: the property's own metadata (name, timezone, currency), needed to interpret a report's dates and money. */
export async function adminReadProperty(auth: Ga4Auth, runtime: ReadRuntime): Promise<ConnectorReadOutcome<AdminPropertyResponse>> {
  return allowlistedRead(
    {
      connector: "ga4",
      method: ADMIN_READ,
      url: `${GA4_ADMIN_BASE}/${propertyPath(auth.propertyId)}`,
      init: { method: "GET", ...bearer(auth.accessToken) },
      vendor: "the GA4 Admin API",
    },
    runtime,
    AdminPropertyResponseSchema,
  );
}
