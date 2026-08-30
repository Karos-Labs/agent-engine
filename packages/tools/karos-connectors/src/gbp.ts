import { z } from "zod";
import { allowlistedRead, type ReadRuntime } from "./read.js";
import type { ConnectorReadOutcome } from "./types.js";

/**
 * Google Business Profile — the three entries in
 * `connectors[3].read_methods_allowlist`:
 *
 *   mybusinessbusinessinformation.accounts.locations.list
 *   mybusinessbusinessinformation.locations.get
 *   businessprofileperformance.locations.getDailyMetricsTimeSeries
 *
 * This is the connector the allowlist exists for. Its scope is
 * `https://www.googleapis.com/auth/business.manage`, and
 * `connectors[3].oauth_scope_readonly` says so in capitals: *"WRITE-CAPABLE;
 * no read-only GBP scope exists"*. `scope_hardening` then makes the allowlist
 * the guard: *"google-data-sync enforces an explicit READ-method allowlist so
 * a write/post/review-reply endpoint is physically uncallable."*
 *
 * So every function in this file names its allowlist token, and there is no
 * generic "call GBP with this path" export. A review reply, a post, a location
 * update — none of them have a code path here, and adding one means adding the
 * method to `allowlist.ts` first.
 *
 * ## Reviews are NOT here, and that is the allowlist's doing
 *
 * `connectors[3].provides` lists "review rating + count", and the input
 * overlay wires `gbp_snapshot_hash` review aggregates into BOTH-NEW-01 and
 * GEO-14. But GBP reviews live on `mybusiness.googleapis.com/v4`'s
 * `accounts.locations.reviews.list`, which is on NEITHER allowlisted API
 * surface. Following the allowlist exactly means the review aggregate is not
 * reachable from this package, so it is not implemented and not faked. That
 * gap is a config finding, not an oversight — see this ticket's report.
 * (`karos-reputation/src/capture/gbp.ts` does read v4 reviews, under its own
 * separate `GOOGLE_BUSINESS_TOKEN` credential and its own contract; it is not
 * governed by this allowlist and is left untouched.)
 */
const BUSINESS_INFORMATION_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE_BASE = "https://businessprofileperformance.googleapis.com/v1";

export const LOCATIONS_LIST = "mybusinessbusinessinformation.accounts.locations.list";
export const LOCATIONS_GET = "mybusinessbusinessinformation.locations.get";
export const DAILY_METRICS_TIME_SERIES = "businessprofileperformance.locations.getDailyMetricsTimeSeries";

const LocationSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  storeCode: z.string().optional(),
  languageCode: z.string().optional(),
  categories: z
    .object({
      primaryCategory: z.object({ name: z.string().optional(), displayName: z.string().optional() }).optional(),
      additionalCategories: z.array(z.object({ name: z.string().optional(), displayName: z.string().optional() })).optional(),
    })
    .optional(),
  storefrontAddress: z.object({ addressLines: z.array(z.string()).optional(), locality: z.string().optional(), postalCode: z.string().optional(), regionCode: z.string().optional() }).optional(),
  phoneNumbers: z.object({ primaryPhone: z.string().optional() }).optional(),
  websiteUri: z.string().optional(),
  metadata: z.object({ placeId: z.string().optional(), mapsUri: z.string().optional(), hasVoiceOfMerchant: z.boolean().optional() }).optional(),
});
export type GbpLocation = z.infer<typeof LocationSchema>;

export const LocationsListResponseSchema = z.object({
  locations: z.array(LocationSchema).optional(),
  nextPageToken: z.string().optional(),
  totalSize: z.number().optional(),
});
export type LocationsListResponse = z.infer<typeof LocationsListResponseSchema>;

export const LocationGetResponseSchema = LocationSchema;
export type LocationGetResponse = z.infer<typeof LocationGetResponseSchema>;

export const DailyMetricsTimeSeriesResponseSchema = z.object({
  timeSeries: z
    .object({
      datedValues: z.array(z.object({ date: z.object({ year: z.number().optional(), month: z.number().optional(), day: z.number().optional() }).optional(), value: z.union([z.string(), z.number()]).optional() })).optional(),
    })
    .optional(),
});
export type DailyMetricsTimeSeriesResponse = z.infer<typeof DailyMetricsTimeSeriesResponseSchema>;

export interface GbpAuth {
  accessToken: string;
}

/**
 * `readMask` is required by the Business Information API and is itself a read
 * narrowing — asking for exactly the fields `connectors[3].provides` names
 * (verified listing/place_id, categories, NAP, profile completeness) rather
 * than the whole record.
 */
export const DEFAULT_LOCATION_READ_MASK = "name,title,categories,storefrontAddress,phoneNumbers,websiteUri,metadata,storeCode";

function bearer(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" } };
}

/** `mybusinessbusinessinformation.accounts.locations.list` — the client's locations under one account. */
export async function accountsLocationsList(
  auth: GbpAuth,
  request: { accountId: string; readMask?: string; pageSize?: number; pageToken?: string },
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome<LocationsListResponse>> {
  const accountPath = request.accountId.startsWith("accounts/") ? request.accountId : `accounts/${request.accountId}`;
  const query = new URLSearchParams({ readMask: request.readMask ?? DEFAULT_LOCATION_READ_MASK });
  if (request.pageSize !== undefined) query.set("pageSize", String(request.pageSize));
  if (request.pageToken !== undefined) query.set("pageToken", request.pageToken);

  return allowlistedRead(
    {
      connector: "gbp",
      method: LOCATIONS_LIST,
      url: `${BUSINESS_INFORMATION_BASE}/${accountPath}/locations?${query.toString()}`,
      init: { method: "GET", ...bearer(auth.accessToken) },
      vendor: "the GBP Business Information API",
    },
    runtime,
    LocationsListResponseSchema,
  );
}

/** `mybusinessbusinessinformation.locations.get` — one location's full record (NAP, categories, place_id). */
export async function locationsGet(auth: GbpAuth, request: { locationName: string; readMask?: string }, runtime: ReadRuntime): Promise<ConnectorReadOutcome<LocationGetResponse>> {
  const locationPath = request.locationName.startsWith("locations/") ? request.locationName : `locations/${request.locationName}`;
  const query = new URLSearchParams({ readMask: request.readMask ?? DEFAULT_LOCATION_READ_MASK });
  return allowlistedRead(
    {
      connector: "gbp",
      method: LOCATIONS_GET,
      url: `${BUSINESS_INFORMATION_BASE}/${locationPath}?${query.toString()}`,
      init: { method: "GET", ...bearer(auth.accessToken) },
      vendor: "the GBP Business Information API",
    },
    runtime,
    LocationGetResponseSchema,
  );
}

/** `businessprofileperformance.locations.getDailyMetricsTimeSeries` — one daily metric (e.g. `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`) over a date range. */
export async function getDailyMetricsTimeSeries(
  auth: GbpAuth,
  request: {
    locationName: string;
    dailyMetric: string;
    start: { year: number; month: number; day: number };
    end: { year: number; month: number; day: number };
  },
  runtime: ReadRuntime,
): Promise<ConnectorReadOutcome<DailyMetricsTimeSeriesResponse>> {
  const locationPath = request.locationName.startsWith("locations/") ? request.locationName : `locations/${request.locationName}`;
  const query = new URLSearchParams({
    dailyMetric: request.dailyMetric,
    "dailyRange.start_date.year": String(request.start.year),
    "dailyRange.start_date.month": String(request.start.month),
    "dailyRange.start_date.day": String(request.start.day),
    "dailyRange.end_date.year": String(request.end.year),
    "dailyRange.end_date.month": String(request.end.month),
    "dailyRange.end_date.day": String(request.end.day),
  });

  return allowlistedRead(
    {
      connector: "gbp",
      method: DAILY_METRICS_TIME_SERIES,
      url: `${PERFORMANCE_BASE}/${locationPath}:getDailyMetricsTimeSeries?${query.toString()}`,
      init: { method: "GET", ...bearer(auth.accessToken) },
      vendor: "the GBP Performance API",
    },
    runtime,
    DailyMetricsTimeSeriesResponseSchema,
  );
}
