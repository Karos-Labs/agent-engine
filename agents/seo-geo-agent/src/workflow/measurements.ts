import { inputKeyFor, type InputMeasurement, type InputMeasurementData, type ScoringBucketConfig } from "@agent-engine/tool-karos-seo-geo";
import { isPathDisallowed } from "@agent-engine/tool-karos-scraper";
import type { TechnicalSeoSnapshot } from "@agent-engine/tools";

/** A schema-valid placeholder `InputMeasurementData`, matched to the input's own normalization kind. Never read: `evaluateScoreFamily` only calls `evaluateNorm` when `coverage === "measured"` (see `karos-seo-geo/src/evaluate-scores.ts`), and every measurement this function produces is `coverage: "unavailable"`. */
function placeholderDataFor(normalization: string): InputMeasurementData {
  switch (normalization) {
    case "boolean":
      return { kind: "boolean", measured: false };
    case "count_with_target":
      return { kind: "count", actual: 0 };
    case "ratio_clamp":
      return { kind: "ratio", value: 0 };
    case "percentage":
      return { kind: "percentage", valuePct: 0 };
    case "lower_is_better_stepped":
      return { kind: "stepped", value: 0 };
    case "multi_bool":
      return { kind: "multiBool", subBools: [] };
    case "combine":
      return { kind: "combine", fields: {} };
    default:
      return { kind: "boolean", measured: false };
  }
}

/**
 * Phase 2 (RFC-04 §2): honest, unmeasured placeholder for every input this
 * bucket set declares — `coverage: "unavailable"`, never a fabricated
 * boolean/count. Used by `buildTechnicalMeasurements` below as the base for
 * every input it does not have a real, T-A1-derived signal for yet (Core Web
 * Vitals, on-page content parsing, keyword/content-gap NLP — none of which
 * this environment has a real tool for), and remains the WHOLE answer for a
 * caller with no crawl snapshot at all (`research.crawlTechnicalSeo` reported
 * `not_available`).
 */
export function buildUnavailableMeasurements(buckets: readonly ScoringBucketConfig[]): Record<string, InputMeasurement> {
  const measurements: Record<string, InputMeasurement> = {};
  for (const bucket of buckets) {
    bucket.inputs.forEach((input, index) => {
      const inputKey = inputKeyFor(bucket.name, index);
      measurements[inputKey] = { data: placeholderDataFor(input.params.normalization), coverage: "unavailable" };
    });
  }
  return measurements;
}

/** The 5 crawler user-agents `crawler_snippet_access[2]`'s GEO-01 multi_bool checks — verbatim from `scoring-config.data.ts`'s own measure text. */
const GEO01_ROBOTS_LEGS = ["OAI-SearchBot", "PerplexityBot", "ClaudeBot", "Googlebot", "Bingbot"] as const;

/** A page this snapshot crawled whose `noindex` is a known fact (never `undefined`) — the subset every noindex-dependent ratio below is honestly computed over. */
function pagesWithKnownNoindex(snapshot: TechnicalSeoSnapshot): Array<{ status: number; noindex: boolean }> {
  return snapshot.pages.filter((p): p is { url: string; status: number; noindex: boolean } => p.noindex !== undefined);
}

function ratioMeasurement(numerator: number, denominator: number): InputMeasurement {
  return { data: { kind: "ratio", value: denominator > 0 ? numerator / denominator : 0 }, coverage: "measured" };
}

function booleanMeasurement(value: boolean): InputMeasurement {
  return { data: { kind: "boolean", measured: value }, coverage: "measured" };
}

function multiBoolMeasurement(subBools: boolean[]): InputMeasurement {
  return { data: { kind: "multiBool", subBools }, coverage: "measured" };
}

/**
 * Overrides a handful of `buildUnavailableMeasurements`' placeholders with
 * REAL, `research.crawlTechnicalSeo`-derived measurements (T-A2/SCRUM-236) —
 * every override below is a directly observed HTTP fact (a status code, an
 * `x-robots-tag` header, a `robots.txt` disallow rule, a sitemap's own
 * presence/validity), never a fabricated pass. Everything this function does
 * NOT override stays `coverage: "unavailable"` exactly as before: there is
 * still no real Core Web Vitals tool, on-page content parser, or
 * keyword/content-gap NLP classifier in this environment, and claiming
 * otherwise would be exactly the fabrication this file's own header always
 * refused.
 *
 * Deliberately keyed by `(bucket.name, index)` via `inputKeyFor` rather than
 * `recId` — several `rec_id`s repeat across distinct legs within one bucket
 * (`BOTH-01` appears twice in `eligibility` alone), and the index is what
 * `evaluateScoreFamily` itself keys on.
 *
 * `bucketName` selects which handful of a bucket set's inputs this function
 * knows how to derive: `"eligibility"` (SEO_BUCKETS) and
 * `"crawler_snippet_access"` (GEO_READINESS_BUCKETS) are the two buckets
 * whose measures map cleanly onto real HTTP/robots.txt facts; every other
 * bucket name is a no-op here (its inputs stay whatever
 * `buildUnavailableMeasurements` already set).
 */
export function buildTechnicalMeasurements(
  buckets: readonly ScoringBucketConfig[],
  snapshot: TechnicalSeoSnapshot | undefined,
): Record<string, InputMeasurement> {
  const measurements = buildUnavailableMeasurements(buckets);
  if (!snapshot) return measurements;

  const knownPages = pagesWithKnownNoindex(snapshot);
  const reachableCount = knownPages.filter((p) => p.status === 200 && !p.noindex).length;
  const noNoindexCount = knownPages.filter((p) => !p.noindex).length;
  const notAuthWalledCount = snapshot.pages.filter((p) => p.status !== 401 && p.status !== 403 && p.status > 0).length;
  const sitemapPresentAndValid = (snapshot.sitemap?.entries.length ?? 0) > 0;
  const sitemapLineInRobots = (snapshot.robots?.sitemaps.length ?? 0) > 0;

  for (const bucket of buckets) {
    if (bucket.name === "eligibility") {
      // BOTH-01 full-snippet eligibility leg: pct of scoped URLs HTTP 200 AND not noindex.
      if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(reachableCount, knownPages.length);
      // BOTH-02: pct of scoped URLs reachable, anonymous, crawlable HTML (no auth/paywall status).
      if (snapshot.pages.length > 0) measurements[inputKeyFor(bucket.name, 1)] = ratioMeasurement(notAuthWalledCount, snapshot.pages.length);
      // BOTH-01 isolated noindex-only leg.
      if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 2)] = ratioMeasurement(noNoindexCount, knownPages.length);
      // BOTH-09: sitemap 200 + valid XML AND Sitemap: line in robots.txt AND 0 noindex among the (sitemap-derived) crawled set.
      measurements[inputKeyFor(bucket.name, 3)] = booleanMeasurement(
        sitemapPresentAndValid && sitemapLineInRobots && (knownPages.length === 0 || noNoindexCount === knownPages.length),
      );
      // index 4 (GEO-01) needs `gsc_ai_optout` from a GSC connector this
      // environment does not have wired (RFC-04 §4/§5) — left unavailable
      // rather than guessing the missing half of an AND condition true.
    }

    if (bucket.name === "crawler_snippet_access") {
      if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(reachableCount, knownPages.length);
      if (snapshot.robots && snapshot.pages.length > 0) {
        const notDisallowedForGooglebot = snapshot.pages.filter(
          (p) => p.status === 200 && !isPathDisallowed(snapshot.robots!, new URL(p.url).pathname, "Googlebot"),
        ).length;
        measurements[inputKeyFor(bucket.name, 1)] = ratioMeasurement(notDisallowedForGooglebot, snapshot.pages.length);
      }
      if (snapshot.robots) {
        const subBools = GEO01_ROBOTS_LEGS.map((bot) => !isPathDisallowed(snapshot.robots!, "/", bot));
        measurements[inputKeyFor(bucket.name, 2)] = multiBoolMeasurement(subBools);
      }
      // index 3 (GEO-08's bing_site_count) and index 4 (GEO-10's
      // entity/about-page legs) need a Bing-indexation connector this
      // environment does not have — left unavailable.
    }
  }

  return measurements;
}
