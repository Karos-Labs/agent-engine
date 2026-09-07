import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, parseDurationMs, success, toolingError } from "@agent-engine/tool-common";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";
const JOB = "core-web-vitals";
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export const FetchCoreWebVitalsInputSchema = z.object({
  url: z.string().min(1).describe("The page to measure — normally the client's homepage."),
  strategy: z.enum(["mobile", "desktop"]).default("mobile").describe("PageSpeed strategy. Mobile is what Google's own thresholds are judged on."),
  window: z.string().min(1).default("7d").describe("Freshness window — a measurement of the same URL/strategy inside it is returned instead of re-running PageSpeed."),
});
export type FetchCoreWebVitalsInput = z.input<typeof FetchCoreWebVitalsInputSchema>;

/** Real-user (CrUX) 75th-percentile field data — the `p75` the scoring config's `technical_cwv` bucket measures. */
export interface CoreWebVitalsField {
  /** `url` when Chrome had enough traffic for this exact page; `origin` when PageSpeed fell back to the whole site's data. */
  source: "url" | "origin";
  overallCategory?: string;
  lcpP75Ms?: number;
  inpP75Ms?: number;
  /** CLS as a unitless score (0.1 = "good" boundary). */
  clsP75?: number;
  fcpP75Ms?: number;
  ttfbP75Ms?: number;
}

/** Lighthouse lab run — diagnostic only. Not a p75, so it never feeds the CWV inputs; kept for the narrative and the SEO audits it carries. */
export interface CoreWebVitalsLab {
  performanceScore?: number;
  seoScore?: number;
  lcpMs?: number;
  cls?: number;
  totalBlockingTimeMs?: number;
  speedIndexMs?: number;
  /** Lighthouse audit pass/fail by id, for the handful the scoring config reads (viewport, is-crawlable, document-title, meta-description, canonical, hreflang, http-status-code, image-alt, robots-txt). */
  audits: Record<string, boolean | undefined>;
  lighthouseVersion?: string;
}

export interface CoreWebVitalsSnapshot {
  url: string;
  strategy: "mobile" | "desktop";
  fetchedAt: string;
  field?: CoreWebVitalsField;
  lab?: CoreWebVitalsLab;
  /** True when the request went out without an API key (shared anonymous quota, rate-limited fast). */
  anonymous: boolean;
}

export interface FetchCoreWebVitalsResult {
  runId: string;
  snapshot: CoreWebVitalsSnapshot;
  fromCache: boolean;
  ageMs: number;
}

export interface CoreWebVitalsToolOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The API key. `PSI_API_KEY` matches the `psi-api-key` Secret Manager entry prep already carries. */
export function resolvePageSpeedApiKey(env: Record<string, string | undefined>): string | undefined {
  return env["PSI_API_KEY"]?.trim() || undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Pure: PageSpeed's JSON -> the snapshot. Exported so the mapping is testable against a recorded response without a network. */
export function parsePageSpeedResponse(url: string, strategy: "mobile" | "desktop", body: unknown, anonymous: boolean, fetchedAt = new Date().toISOString()): CoreWebVitalsSnapshot {
  const root = rec(body);
  const pick = (experience: Record<string, unknown>, source: "url" | "origin"): CoreWebVitalsField | undefined => {
    const metrics = rec(experience["metrics"]);
    if (Object.keys(metrics).length === 0) return undefined;
    const percentile = (key: string) => num(rec(metrics[key])["percentile"]);
    const lcp = percentile("LARGEST_CONTENTFUL_PAINT_MS");
    const inp = percentile("INTERACTION_TO_NEXT_PAINT");
    const cls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE");
    const fcp = percentile("FIRST_CONTENTFUL_PAINT_MS");
    const ttfb = percentile("EXPERIMENTAL_TIME_TO_FIRST_BYTE");
    const overall = experience["overall_category"];
    return {
      source,
      ...(typeof overall === "string" ? { overallCategory: overall } : {}),
      ...(lcp !== undefined ? { lcpP75Ms: lcp } : {}),
      ...(inp !== undefined ? { inpP75Ms: inp } : {}),
      // CrUX reports CLS scaled by 100 as an integer percentile.
      ...(cls !== undefined ? { clsP75: cls / 100 } : {}),
      ...(fcp !== undefined ? { fcpP75Ms: fcp } : {}),
      ...(ttfb !== undefined ? { ttfbP75Ms: ttfb } : {}),
    };
  };
  const urlExperience = rec(root["loadingExperience"]);
  const originFallback = urlExperience["origin_fallback"] === true;
  const field = pick(urlExperience, originFallback ? "origin" : "url") ?? pick(rec(root["originLoadingExperience"]), "origin");

  const lighthouse = rec(root["lighthouseResult"]);
  const audits = rec(lighthouse["audits"]);
  const categories = rec(lighthouse["categories"]);
  const auditPass = (id: string): boolean | undefined => {
    const score = num(rec(audits[id])["score"]);
    return score === undefined ? undefined : score >= 0.9;
  };
  const auditNumeric = (id: string): number | undefined => num(rec(audits[id])["numericValue"]);
  let lab: CoreWebVitalsLab | undefined;
  if (Object.keys(audits).length > 0) {
    const auditIds = ["viewport", "is-crawlable", "document-title", "meta-description", "canonical", "hreflang", "http-status-code", "image-alt", "robots-txt", "crawlable-anchors", "link-text", "structured-data"];
    const auditMap: Record<string, boolean | undefined> = {};
    for (const id of auditIds) if (id in audits) auditMap[id] = auditPass(id);
    const perf = num(rec(categories["performance"])["score"]);
    const seo = num(rec(categories["seo"])["score"]);
    const lcpMs = auditNumeric("largest-contentful-paint");
    const clsLab = auditNumeric("cumulative-layout-shift");
    const tbt = auditNumeric("total-blocking-time");
    const speedIndex = auditNumeric("speed-index");
    lab = {
      ...(perf !== undefined ? { performanceScore: Math.round(perf * 100) } : {}),
      ...(seo !== undefined ? { seoScore: Math.round(seo * 100) } : {}),
      ...(lcpMs !== undefined ? { lcpMs } : {}),
      ...(clsLab !== undefined ? { cls: clsLab } : {}),
      ...(tbt !== undefined ? { totalBlockingTimeMs: tbt } : {}),
      ...(speedIndex !== undefined ? { speedIndexMs: speedIndex } : {}),
      audits: auditMap,
      ...(typeof lighthouse["lighthouseVersion"] === "string" ? { lighthouseVersion: lighthouse["lighthouseVersion"] as string } : {}),
    };
  }

  return {
    url,
    strategy,
    fetchedAt,
    ...(field ? { field } : {}),
    ...(lab ? { lab } : {}),
    anonymous,
  };
}

/**
 * `research.fetchCoreWebVitals`: Google PageSpeed Insights v5 for one URL —
 * the CrUX 75th-percentile field data (`LCP`/`INP`/`CLS`) the `technical_cwv`
 * bucket scores, plus the Lighthouse lab run for the handful of SEO audits the
 * config reads (viewport, crawlability). Field data is the real-user number the
 * config's `p75` measures name; the lab numbers are kept as diagnostics only
 * and never stand in for a p75.
 *
 * Runs with `PSI_API_KEY` when configured. With no key it still tries once on
 * the anonymous quota — that quota is shared and exhausts quickly, so a 429
 * reports `not_available` naming the key rather than a placeholder.
 */
export function createFetchCoreWebVitals(store: WorkspaceStoreLike, options: CoreWebVitalsToolOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 150_000;
  return defineTool<FetchCoreWebVitalsInput, FetchCoreWebVitalsResult>({
    name: "research.fetchCoreWebVitals",
    description:
      "Measures one URL's Core Web Vitals through Google PageSpeed Insights: real-user CrUX p75 LCP/INP/CLS (falling back to origin-level data when the page itself has too little traffic) plus a Lighthouse lab run's performance/SEO audits. Cached per URL and strategy inside the freshness window. Uses PSI_API_KEY when set; reports not_available when the anonymous quota is exhausted.",
    version: TOOL_VERSION,
    inputSchema: FetchCoreWebVitalsInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof FetchCoreWebVitalsInputSchema>;
      const query = `${input.strategy} ${input.url}`;
      const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, query);
      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= parseDurationMs(input.window)) {
          return success<FetchCoreWebVitalsResult>({ runId: cached.runId, snapshot: cached.result as CoreWebVitalsSnapshot, fromCache: true, ageMs });
        }
      }

      const apiKey = resolvePageSpeedApiKey(env);
      const params = new URLSearchParams();
      params.set("url", input.url);
      params.set("strategy", input.strategy);
      params.append("category", "PERFORMANCE");
      params.append("category", "SEO");
      if (apiKey) params.set("key", apiKey);

      // PageSpeed runs a full Lighthouse pass on Google's side before answering,
      // which on a heavy news homepage routinely takes 60-120s; the first prep
      // run against a real client hit the old 90s ceiling. One retry on a
      // timeout/abort: the second attempt usually lands because PageSpeed
      // caches the Lighthouse result it had already started computing.
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2 && !response; attempt++) {
        try {
          response = await fetchImpl(`${PSI_ENDPOINT}?${params.toString()}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          lastError = error;
          const name = (error as { name?: string }).name ?? "";
          if (!/Timeout|Abort/i.test(name) && !/timeout|aborted/i.test((error as Error).message ?? "")) break;
        }
      }
      if (!response) {
        return toolingError(`research.fetchCoreWebVitals: PageSpeed request failed: ${(lastError as Error)?.message ?? String(lastError)}`);
      }
      if (response.status === 429 || response.status === 403) {
        return notAvailable(
          `research.fetchCoreWebVitals: PageSpeed Insights answered ${response.status}${apiKey ? "" : " on the anonymous quota"} — set PSI_API_KEY (Secret Manager: psi-api-key) so Core Web Vitals can be measured. Refusing to return a placeholder.`,
        );
      }
      if (!response.ok) {
        // A 400/500 for one URL is a real measurement failure for this page (a URL Lighthouse could not load), not a missing capability.
        let detail = "";
        try {
          detail = JSON.stringify(rec(rec(await response.json())["error"])["message"] ?? "").slice(0, 300);
        } catch {
          detail = "";
        }
        return toolingError(`research.fetchCoreWebVitals: PageSpeed Insights answered ${response.status} for ${input.url} ${detail}`.trim());
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return toolingError(`research.fetchCoreWebVitals: PageSpeed returned a non-JSON body: ${(error as Error).message}`);
      }
      const snapshot = parsePageSpeedResponse(input.url, input.strategy, body, apiKey === undefined);
      const runId = randomUUID();
      const record: RunRecord = { job: JOB, runId, query, result: snapshot, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<FetchCoreWebVitalsResult>({ runId, snapshot, fromCache: false, ageMs: 0 });
    },
  });
}
