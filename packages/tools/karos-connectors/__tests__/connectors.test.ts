import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { cruxQueryRecord, runPagespeed, CruxOptInRequiredError } from "../src/crux.js";
import { adminReadProperty, runReport } from "../src/ga4.js";
import { accountsLocationsList, getDailyMetricsTimeSeries, locationsGet } from "../src/gbp.js";
import { searchAnalyticsQuery, sitemapsList, urlInspectionIndexInspect } from "../src/gsc.js";
import { createGoogleDataSync } from "../src/google-data-sync-tool.js";
import { createKarosConnectorsTools } from "../src/index.js";
import type { ReadRuntime } from "../src/read.js";
import { UNCONNECTED_SENTINEL } from "../src/types.js";

/**
 * ## Why this mock is a router and not a stub
 *
 * CI has no Google credentials, so the boundary has to be faked — but a fake
 * that answers the same canned object regardless of what was asked proves only
 * that the code can read a variable. The router below is written the way the
 * real APIs behave: it checks the path, the HTTP verb, the bearer (or the
 * `key` query parameter, for the two keyless PSI/CrUX endpoints) and the body
 * fields each method actually requires, and it answers with Google's real
 * error shapes when any of those are wrong. A client that builds the wrong URL
 * or forgets the Authorization header fails these tests with a 401/404, not a
 * green pass.
 */

const ACCESS_TOKEN = "ya29.test-access-token";
const REFRESH_TOKEN = "1//test-refresh-token";
const PSI_KEY = "psi-test-key";

interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

interface MockOptions {
  /** Status sequence keyed by a route id, consumed in order; anything past the end repeats the last entry. Absent means "always serve the real payload". */
  statuses?: Record<string, readonly number[]>;
  /** Route ids that should hang until their abort signal fires, for deadline tests. */
  hang?: readonly string[];
  /** Route ids that should answer 200 with a body that does NOT match the contract. */
  malformed?: readonly string[];
  retryAfter?: string;
}

function googleApiMock(options: MockOptions = {}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();

  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...(options.retryAfter ? { "retry-after": options.retryAfter } : {}) } });

  /** Google's real error envelope, so a client that logs `response.status` sees what it would see in production. */
  const googleError = (status: number, message: string): Response => json({ error: { code: status, message, status: status === 401 ? "UNAUTHENTICATED" : "FAILED_PRECONDITION" } }, status);

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    let body: unknown;
    if (typeof init?.body === "string") {
      body = init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    }
    calls.push({ url, method, headers, body });

    const routeId = classify(url, method);

    if (options.hang?.includes(routeId)) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      });
    }

    const sequence = options.statuses?.[routeId];
    if (sequence && sequence.length > 0) {
      const seen = counters.get(routeId) ?? 0;
      counters.set(routeId, seen + 1);
      const status = sequence[Math.min(seen, sequence.length - 1)] as number;
      if (status !== 200) return googleError(status, `injected ${status} for ${routeId}`);
    }

    if (options.malformed?.includes(routeId)) return json({ unexpected: "a 200 that is not this contract" });

    return serve(routeId, url, headers, body, googleError, json);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function classify(url: URL, method: string): string {
  const { hostname, pathname } = url;
  if (hostname === "oauth2.googleapis.com") return "oauth.token";
  if (hostname === "searchconsole.googleapis.com") {
    if (pathname.endsWith("/searchAnalytics/query")) return "gsc.searchAnalytics";
    if (pathname === "/v1/urlInspection/index:inspect") return "gsc.urlInspection";
    if (pathname.endsWith("/sitemaps")) return "gsc.sitemaps";
  }
  if (hostname === "analyticsdata.googleapis.com") return "ga4.runReport";
  if (hostname === "analyticsadmin.googleapis.com") return "ga4.adminProperty";
  if (hostname === "www.googleapis.com" && pathname === "/pagespeedonline/v5/runPagespeed") return "crux.pagespeed";
  if (hostname === "chromeuxreport.googleapis.com") return "crux.queryRecord";
  if (hostname === "mybusinessbusinessinformation.googleapis.com") return pathname.endsWith("/locations") ? "gbp.locationsList" : "gbp.locationsGet";
  if (hostname === "businessprofileperformance.googleapis.com") return "gbp.dailyMetrics";
  return `unrouted:${method} ${hostname}${pathname}`;
}

function serve(
  routeId: string,
  url: URL,
  headers: Headers,
  body: unknown,
  googleError: (status: number, message: string) => Response,
  json: (payload: unknown, status?: number) => Response,
): Response {
  const bearer = headers.get("authorization");
  const requireBearer = (): Response | null => (bearer === `Bearer ${ACCESS_TOKEN}` ? null : googleError(401, "Request had invalid authentication credentials."));
  const requireKey = (): Response | null => (url.searchParams.get("key") === PSI_KEY ? null : googleError(403, "The request is missing a valid API key."));
  const record = (body ?? {}) as Record<string, unknown>;

  switch (routeId) {
    case "oauth.token": {
      if (record["grant_type"] !== "refresh_token" || !record["client_id"] || !record["client_secret"] || record["refresh_token"] !== REFRESH_TOKEN) {
        return json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
      }
      return json({ access_token: ACCESS_TOKEN, expires_in: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer" });
    }
    case "gsc.searchAnalytics": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      if (!record["startDate"] || !record["endDate"]) return googleError(400, "startDate and endDate are required");
      return json({
        rows: [
          { keys: ["karos labs"], clicks: 42, impressions: 1180, ctr: 0.0356, position: 3.4 },
          { keys: ["ai seo agency"], clicks: 7, impressions: 940, ctr: 0.0074, position: 18.2 },
        ],
        responseAggregationType: "byProperty",
      });
    }
    case "gsc.urlInspection": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      if (!record["inspectionUrl"] || !record["siteUrl"]) return googleError(400, "inspectionUrl and siteUrl are required");
      return json({
        inspectionResult: {
          inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aexample.test",
          indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", lastCrawlTime: "2026-08-14T02:11:00Z", pageFetchState: "SUCCESSFUL" },
          mobileUsabilityResult: { verdict: "FAIL", issues: [{ issueType: "TAP_TARGETS_TOO_CLOSE", severity: "ERROR", message: "Clickable elements too close together" }] },
          richResultsResult: { verdict: "PASS" },
        },
      });
    }
    case "gsc.sitemaps": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      return json({ sitemap: [{ path: "https://example.test/sitemap.xml", lastSubmitted: "2026-07-01T09:00:00Z", isPending: false, isSitemapsIndex: true, errors: "0", warnings: "2" }] });
    }
    case "ga4.runReport": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      if (!Array.isArray(record["dateRanges"]) || !Array.isArray(record["metrics"])) return googleError(400, "dateRanges and metrics are required");
      return json({
        dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }],
        metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
        rows: [
          { dimensionValues: [{ value: "AI Assistant" }], metricValues: [{ value: "318" }] },
          { dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "9421" }] },
        ],
        rowCount: 2,
      });
    }
    case "ga4.adminProperty": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      return json({ name: "properties/447711223", displayName: "example.test — GA4", timeZone: "Europe/London", currencyCode: "GBP", propertyType: "PROPERTY_TYPE_ORDINARY" });
    }
    case "crux.pagespeed": {
      const missingKey = requireKey();
      if (missingKey) return missingKey;
      if (!url.searchParams.get("url")) return googleError(400, "url is required");
      return json({
        id: url.searchParams.get("url"),
        loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2410, category: "AVERAGE" } }, overall_category: "AVERAGE" },
        lighthouseResult: {
          categories: { performance: { score: 0.62 } },
          audits: { "largest-contentful-paint": { id: "largest-contentful-paint", title: "Largest Contentful Paint", score: 0.41, numericValue: 3120.5, displayValue: "3.1 s" } },
        },
      });
    }
    case "crux.queryRecord": {
      const missingKey = requireKey();
      if (missingKey) return missingKey;
      if (!record["origin"] && !record["url"]) return googleError(400, "origin or url is required");
      return json({
        record: {
          key: { origin: record["origin"], formFactor: record["formFactor"] },
          metrics: {
            largest_contentful_paint: { percentiles: { p75: 2410 } },
            interaction_to_next_paint: { percentiles: { p75: 184 } },
            cumulative_layout_shift: { percentiles: { p75: "0.08" } },
          },
        },
      });
    }
    case "gbp.locationsList": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      if (!url.searchParams.get("readMask")) return googleError(400, "readMask is required");
      return json({
        locations: [
          {
            name: "locations/1122334455",
            title: "Karos Labs — Shoreditch",
            categories: { primaryCategory: { name: "categories/gcid:marketing_agency", displayName: "Marketing agency" } },
            storefrontAddress: { addressLines: ["11 Bishopsgate"], locality: "London", postalCode: "EC2N 3AR", regionCode: "GB" },
            phoneNumbers: { primaryPhone: "+44 20 7946 0102" },
            websiteUri: "https://example.test/",
            metadata: { placeId: "ChIJtest0000000", hasVoiceOfMerchant: true },
          },
        ],
        totalSize: 1,
      });
    }
    case "gbp.locationsGet": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      return json({ name: "locations/1122334455", title: "Karos Labs — Shoreditch", metadata: { placeId: "ChIJtest0000000" } });
    }
    case "gbp.dailyMetrics": {
      const unauthorized = requireBearer();
      if (unauthorized) return unauthorized;
      if (!url.searchParams.get("dailyMetric")) return googleError(400, "dailyMetric is required");
      return json({
        timeSeries: {
          datedValues: [
            { date: { year: 2026, month: 7, day: 1 }, value: "142" },
            { date: { year: 2026, month: 7, day: 2 }, value: "137" },
          ],
        },
      });
    }
    default:
      return googleError(404, `no route for ${routeId}`);
  }
}

/** Records backoff waits instead of serving them — the real retry path, no real wall-clock wait. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; now: () => number; waits: number[] } {
  const waits: number[] = [];
  let clock = 0;
  return { waits, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } };
}

function runtimeFor(fetchImpl: typeof fetch, overrides: Partial<ReadRuntime> = {}): ReadRuntime {
  const clock = fakeClock();
  return { fetchImpl, sleep: clock.sleep, now: clock.now, ...overrides };
}

const GSC_AUTH = { accessToken: ACCESS_TOKEN, siteUrl: "sc-domain:example.test" };
const GA4_AUTH = { accessToken: ACCESS_TOKEN, propertyId: "447711223" };
const GBP_AUTH = { accessToken: ACCESS_TOKEN };
const CRUX_AUTH = { apiKey: PSI_KEY };
const OPTED_IN = { clientId: "acme", cruxOptIn: true };

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo", runKind: "recurring", metadata: {} };

describe("GSC client — the three allowlisted Search Console reads", () => {
  it("searchanalytics.query builds the real request and parses the real row shape", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await searchAnalyticsQuery(GSC_AUTH, { startDate: "2026-07-01", endDate: "2026-07-31", dimensions: ["query"], rowLimit: 100 }, runtimeFor(fetchImpl));

    expect(outcome.status).toBe("ok");
    expect(outcome.method).toBe("searchanalytics.query");
    expect(outcome.payload?.rows?.[0]).toEqual({ keys: ["karos labs"], clicks: 42, impressions: 1180, ctr: 0.0356, position: 3.4 });

    const call = calls[0]!;
    // The property is percent-encoded into the path — `sc-domain:` unencoded would 404.
    expect(call.url.toString()).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.test/searchAnalytics/query");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.body).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31", dimensions: ["query"], rowLimit: 100 });
  });

  it("urlInspection.index.inspect sends both required fields and parses Google's own issue list", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await urlInspectionIndexInspect(GSC_AUTH, "https://example.test/pricing", runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.inspectionResult.indexStatusResult?.coverageState).toBe("Submitted and indexed");
    expect(outcome.payload?.inspectionResult.mobileUsabilityResult?.issues?.[0]?.issueType).toBe("TAP_TARGETS_TOO_CLOSE");
    expect(calls[0]?.body).toEqual({ inspectionUrl: "https://example.test/pricing", siteUrl: "sc-domain:example.test" });
  });

  it("sitemaps.list is a GET on the property's sitemaps collection", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await sitemapsList(GSC_AUTH, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.sitemap?.[0]?.path).toBe("https://example.test/sitemap.xml");
    expect(calls[0]?.method).toBe("GET");
  });

  it("reports an unauthenticated read as UNAVAILABLE with the status, never as an empty success", async () => {
    const { fetchImpl } = googleApiMock();
    const outcome = await searchAnalyticsQuery({ accessToken: "expired", siteUrl: "sc-domain:example.test" }, { startDate: "2026-07-01", endDate: "2026-07-31" }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("HTTP 401");
    expect(outcome.payload).toBeUndefined();
  });

  it("treats a 200 whose body is not the contract as a failed read, not an empty one", async () => {
    // The AU11 rule: "we stopped understanding this API" and "there is no data"
    // must not look the same downstream.
    const { fetchImpl } = googleApiMock({ malformed: ["gsc.urlInspection"] });
    const outcome = await urlInspectionIndexInspect(GSC_AUTH, "https://example.test/pricing", runtimeFor(fetchImpl));
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("did not match the expected urlInspection.index.inspect shape");
    expect(outcome.payload).toBeUndefined();
  });
});

describe("GA4 client — properties.runReport and admin.read", () => {
  it("runReport posts the report body and parses the AI-referral channel rows", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await runReport(
      GA4_AUTH,
      { dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-31" }], metrics: [{ name: "sessions" }], dimensions: [{ name: "sessionDefaultChannelGroup" }] },
      runtimeFor(fetchImpl),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.rows?.[0]?.dimensionValues?.[0]?.value).toBe("AI Assistant");
    expect(calls[0]?.url.toString()).toBe("https://analyticsdata.googleapis.com/v1beta/properties/447711223:runReport");
    expect(calls[0]?.method).toBe("POST");
  });

  it("admin.read reads the property's own metadata on the Admin host", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await adminReadProperty(GA4_AUTH, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.timeZone).toBe("Europe/London");
    expect(calls[0]?.url.hostname).toBe("analyticsadmin.googleapis.com");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("PageSpeed/CrUX client — key-gated, and gated again per client", () => {
  it("runPagespeed sends the PSI key as a query parameter and no bearer at all", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await runPagespeed(CRUX_AUTH, { url: "https://example.test/", strategy: "mobile" }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.lighthouseResult?.categories?.performance?.score).toBe(0.62);
    expect(calls[0]?.url.searchParams.get("key")).toBe(PSI_KEY);
    expect(calls[0]?.url.searchParams.get("strategy")).toBe("mobile");
    // This connector carries no OAuth scope; sending one would be a second credential for a keyless API.
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("cruxQueryRecord returns the field p75 triple SEO-04 upgrades to", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await cruxQueryRecord(CRUX_AUTH, OPTED_IN, { origin: "https://example.test", formFactor: "PHONE" }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.record.metrics?.largest_contentful_paint?.percentiles?.p75).toBe(2410);
    expect(outcome.payload?.record.metrics?.interaction_to_next_paint?.percentiles?.p75).toBe(184);
    expect(calls[0]?.body).toEqual({ origin: "https://example.test", formFactor: "PHONE" });
  });

  it("refuses CrUX field data for a client without the per-client opt-in, and makes NO request (Defect-2)", async () => {
    const { fetchImpl, calls } = googleApiMock();
    await expect(cruxQueryRecord(CRUX_AUTH, { clientId: "acme", cruxOptIn: false }, { origin: "https://example.test" }, runtimeFor(fetchImpl))).rejects.toBeInstanceOf(CruxOptInRequiredError);
    expect(calls).toHaveLength(0);
  });
});

describe("GBP client — the write-capable scope, fenced to three reads", () => {
  it("accounts.locations.list sends a readMask and parses the listing/place_id/NAP payload", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const outcome = await accountsLocationsList(GBP_AUTH, { accountId: "accounts/998877" }, runtimeFor(fetchImpl));
    expect(outcome.status).toBe("ok");
    expect(outcome.payload?.locations?.[0]?.metadata?.placeId).toBe("ChIJtest0000000");
    expect(calls[0]?.url.pathname).toBe("/v1/accounts/998877/locations");
    expect(calls[0]?.url.searchParams.get("readMask")).toContain("storefrontAddress");
    expect(calls[0]?.method).toBe("GET");
  });

  it("locations.get and getDailyMetricsTimeSeries hit their own hosts with GET only", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const got = await locationsGet(GBP_AUTH, { locationName: "locations/1122334455" }, runtimeFor(fetchImpl));
    expect(got.status).toBe("ok");

    const series = await getDailyMetricsTimeSeries(
      GBP_AUTH,
      { locationName: "locations/1122334455", dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", start: { year: 2026, month: 7, day: 1 }, end: { year: 2026, month: 7, day: 2 } },
      runtimeFor(fetchImpl),
    );
    expect(series.status).toBe("ok");
    expect(series.payload?.timeSeries?.datedValues).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls[1]?.url.searchParams.get("dailyRange.start_date.day")).toBe("1");
  });
});

describe("the shared retry policy and deadline, exercised through a connector", () => {
  it("a 429 is retried by the shared policy and the read still succeeds", async () => {
    const { fetchImpl, calls } = googleApiMock({ statuses: { "gsc.searchAnalytics": [429, 429, 200] } });
    const clock = fakeClock();
    const outcome = await searchAnalyticsQuery(GSC_AUTH, { startDate: "2026-07-01", endDate: "2026-07-31" }, { fetchImpl, sleep: clock.sleep, now: clock.now });

    expect(outcome.status).toBe("ok");
    expect(outcome.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(clock.waits).toEqual([500, 1000]); // the shared DEFAULT_RETRY_POLICY schedule, not a per-connector one
  });

  it("honours a Retry-After the vendor sends on a 429", async () => {
    const { fetchImpl } = googleApiMock({ statuses: { "ga4.runReport": [429, 200] }, retryAfter: "2" });
    const clock = fakeClock();
    const outcome = await runReport(GA4_AUTH, { dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-31" }], metrics: [{ name: "sessions" }] }, { fetchImpl, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe("ok");
    expect(clock.waits).toEqual([2000]);
  });

  it("a persistent 503 spends every attempt and then tombstones with the status", async () => {
    const { fetchImpl, calls } = googleApiMock({ statuses: { "gbp.locationsList": [503] } });
    const clock = fakeClock();
    const outcome = await accountsLocationsList(GBP_AUTH, { accountId: "998877" }, { fetchImpl, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("HTTP 503");
    expect(outcome.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 403 — three identical refusals is not resilience", async () => {
    const { fetchImpl, calls } = googleApiMock({ statuses: { "crux.pagespeed": [403] } });
    const clock = fakeClock();
    const outcome = await runPagespeed(CRUX_AUTH, { url: "https://example.test/" }, { fetchImpl, sleep: clock.sleep, now: clock.now });
    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("HTTP 403");
    expect(calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
  });

  it("honours the deadline: a vendor that accepts and never answers becomes a bounded UNAVAILABLE, not a hung step", async () => {
    const { fetchImpl, calls } = googleApiMock({ hang: ["gsc.sitemaps"] });
    const started = Date.now();
    const outcome = await sitemapsList(GSC_AUTH, { fetchImpl, timeoutMs: 40 });
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe("UNAVAILABLE");
    expect(outcome.reason).toContain("did not respond within");
    // The deadline is not retried — spending the caller's budget three times over is the opposite of honouring it.
    expect(calls).toHaveLength(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("connectors.googleDataSync", () => {
  const env = { GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret", PSI_API_KEY: PSI_KEY };
  const connection = { clientId: "acme", refreshToken: REFRESH_TOKEN, gscSiteUrl: "sc-domain:example.test", ga4PropertyId: "447711223", gbpAccountId: "998877", cruxOptIn: true };

  it("mints one in-memory access token from the refresh token, then reads every connector and freezes four snapshot hashes", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const clock = fakeClock();
    const tool = createGoogleDataSync({ env, fetchImpl, runtime: { sleep: clock.sleep, now: clock.now } });

    const result = await tool.execute(
      {
        connection,
        reads: [
          { method: "searchanalytics.query", startDate: "2026-07-01", endDate: "2026-07-31", dimensions: ["query"] },
          { method: "properties.runReport", dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-31" }], metrics: [{ name: "sessions" }] },
          { method: "chromeuxreport.records:queryRecord", origin: "https://example.test" },
          { method: "mybusinessbusinessinformation.accounts.locations.list" },
        ],
      },
      { ctx },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.result.outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok", "ok"]);

    // One token mint for the three OAuth reads; the keyless CrUX read never triggers one.
    const tokenCalls = calls.filter((call) => call.url.hostname === "oauth2.googleapis.com");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: env.GOOGLE_OAUTH_CLIENT_ID });

    const hashes = result.result.snapshotHashes;
    for (const key of ["gsc_snapshot_hash", "ga_snapshot_hash", "crux_snapshot_hash", "gbp_snapshot_hash"] as const) {
      expect(hashes[key], key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("an unconnected client degrades to the UNCONNECTED sentinel on every hash — never a fabricated zero", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const tool = createGoogleDataSync({ env, fetchImpl });
    const result = await tool.execute(
      { connection: { clientId: "acme", cruxOptIn: false }, reads: [{ method: "sitemaps.list" }, { method: "admin.read" }] },
      { ctx },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.result.outcomes.every((outcome) => outcome.status === "not_connected")).toBe(true);
    expect(result.result.outcomes[0]?.reason).toContain("no stored Google refresh token");
    expect(Object.values(result.result.snapshotHashes)).toEqual([UNCONNECTED_SENTINEL, UNCONNECTED_SENTINEL, UNCONNECTED_SENTINEL, UNCONNECTED_SENTINEL]);
    // Nothing was asked of Google at all, including the token endpoint.
    expect(calls).toHaveLength(0);
  });

  it("a revoked grant is skipped rather than retried into an error — revoking cannot break the product", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const tool = createGoogleDataSync({ env, fetchImpl });
    const result = await tool.execute({ connection: { ...connection, revokedAt: "2026-08-02T10:00:00Z" }, reads: [{ method: "sitemaps.list" }] }, { ctx });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.result.outcomes[0]?.status).toBe("not_connected");
    expect(result.result.outcomes[0]?.reason).toContain("revoked");
    expect(result.result.snapshotHashes.gsc_snapshot_hash).toBe(UNCONNECTED_SENTINEL);
    expect(calls).toHaveLength(0);
  });

  it("a partial connect keeps the connected hash and leaves the rest at the sentinel", async () => {
    // The byte_order_guarantee's premise: connecting one source must not
    // fabricate anything for the others.
    const { fetchImpl } = googleApiMock();
    const tool = createGoogleDataSync({ env: { PSI_API_KEY: PSI_KEY }, fetchImpl });
    const result = await tool.execute(
      { connection: { clientId: "acme", cruxOptIn: true }, reads: [{ method: "pagespeedonline.runpagespeed", url: "https://example.test/" }, { method: "sitemaps.list" }] },
      { ctx },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.result.snapshotHashes.crux_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.result.snapshotHashes.gsc_snapshot_hash).toBe(UNCONNECTED_SENTINEL);
    expect(result.result.snapshotHashes.ga_snapshot_hash).toBe(UNCONNECTED_SENTINEL);
    expect(result.result.snapshotHashes.gbp_snapshot_hash).toBe(UNCONNECTED_SENTINEL);
  });

  it("reports not_available — not tooling_error — when the deployment configured no Google credentials at all", async () => {
    const { fetchImpl } = googleApiMock();
    const tool = createGoogleDataSync({ env: {}, fetchImpl });
    const result = await tool.execute({ connection: { clientId: "acme", cruxOptIn: false }, reads: [{ method: "sitemaps.list" }] }, { ctx });
    expect(result.status).toBe("not_available");
  });

  it("rejects a write method at the schema boundary — there is no union member that can express one", async () => {
    const { fetchImpl, calls } = googleApiMock();
    const tool = createGoogleDataSync({ env, fetchImpl });
    const result = await tool.execute(
      { connection, reads: [{ method: "mybusiness.accounts.locations.reviews.reply", comment: "thanks!" }] } as never,
      { ctx },
    );
    expect(result.status).toBe("tooling_error");
    if (result.status !== "tooling_error") throw new Error("unreachable");
    expect(result.reason).toContain("failed the tool's input schema");
    expect(calls).toHaveLength(0);
  });

  it("registers under one name and reaches Google through nothing else", () => {
    expect(Object.keys(createKarosConnectorsTools())).toEqual(["connectors.googleDataSync"]);
  });
});
