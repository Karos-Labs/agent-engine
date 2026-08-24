import {
  ScraperError,
  type RawPage,
  type ScrapeOptions,
  type ScrapedRecord,
  type ScraperProvider,
  type SearchOptions,
  type SocialHistoryRequest,
  type SocialPlatform,
} from "./provider.js";

/** Verified live against the account before this was written. */
const DEFAULT_BASE_URL = "https://api.scrappycoco.ai/api/v1";

/**
 * The synchronous execution endpoint.
 *
 * The published docs only describe the async queue (`POST /scrapers/jobs`,
 * HTTP 202, then poll `GET /jobs/{id}`), which would make every scrape a
 * two-phase affair inside a workflow step. `POST /scrapers/execute` returns
 * `execution_mode: "request_response"` with the records inline. Probed
 * directly: `/scrapers/run` and `/scrapers/runs` are 404, `/scrapers/execute`
 * is 200. Kept in one constant because it is undocumented and therefore the
 * most likely thing here to need changing.
 */
const EXECUTE_PATH = "/scrapers/execute";

/** Which capability answers each social platform's account-history question. */
const HISTORY_CAPABILITY: Record<SocialPlatform, { capability: string; inputKey: string }> = {
  x: { capability: "account_posts", inputKey: "username" },
  instagram: { capability: "account_posts", inputKey: "username" },
  tiktok: { capability: "account_posts", inputKey: "username" },
  // Reddit has no "account posts"; the equivalent is a user's activity feed.
  reddit: { capability: "user_activity", inputKey: "username" },
};

interface ExecuteResponse {
  status?: unknown;
  records?: unknown;
  selected_provider?: unknown;
  usage?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Image URLs hide in different places per platform, so this collects from all of them. */
function collectImageUrls(record: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const outputs = record["outputs"];
  const json = typeof outputs === "object" && outputs !== null ? (outputs as Record<string, unknown>)["json"] : undefined;

  for (const source of [json, record]) {
    if (typeof source !== "object" || source === null) continue;
    const bag = source as Record<string, unknown>;
    for (const key of ["display_url", "thumbnail_src", "thumbnail_url", "image_url", "imageUrl", "image"]) {
      const value = asString(bag[key]);
      if (value) found.add(value);
    }
  }

  // Carousel posts nest their images; a regex over the serialised payload picks
  // those up without this file needing to model every provider's shape.
  if (json !== undefined) {
    try {
      const matches = JSON.stringify(json).match(/https?:\/\/[^"\\ ]+\.(?:jpg|jpeg|png|webp)[^"\\ ]*/g) ?? [];
      for (const match of matches) found.add(match);
    } catch {
      // A payload that will not serialise simply contributes no extra URLs.
    }
  }

  return [...found];
}

function toRecord(raw: unknown): ScrapedRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const url = asString(item["url"]);
  const id = asString(item["id"]) ?? url;
  if (id === undefined) return undefined;

  const engagementRaw = item["engagement"];
  const engagement =
    typeof engagementRaw === "object" && engagementRaw !== null
      ? (() => {
          const bag = engagementRaw as Record<string, unknown>;
          const likes = asNumber(bag["likes"]);
          const comments = asNumber(bag["comments"]);
          const views = asNumber(bag["views"]);
          return likes === undefined && comments === undefined && views === undefined
            ? undefined
            : { ...(likes !== undefined ? { likes } : {}), ...(comments !== undefined ? { comments } : {}), ...(views !== undefined ? { views } : {}) };
        })()
      : undefined;

  const images = collectImageUrls(item);

  return {
    id,
    url: url ?? id,
    ...(asString(item["title"]) ? { title: asString(item["title"])! } : {}),
    ...(asString(item["text"]) ? { text: asString(item["text"])! } : {}),
    ...(asString(item["published_at"]) ? { publishedAt: asString(item["published_at"])! } : {}),
    ...(asString(item["author"]) ? { author: asString(item["author"])! } : {}),
    ...(images.length > 0 ? { imageUrls: images } : {}),
    ...(engagement ? { engagement } : {}),
    ...(asString(item["capability"]) ? { capability: asString(item["capability"])! } : {}),
    raw,
  };
}

export interface ScrappyCocoOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Default per-request ceiling. A search plus several page loads legitimately takes tens of seconds. */
  timeoutMs?: number;
  /**
   * Supplies the `Idempotency-Key` every billable POST requires. Injected so a
   * test is deterministic and so a caller can make a retry reuse a key
   * deliberately rather than by accident.
   */
  idempotencyKey?: () => string;
}

/**
 * ScrappyCoco, behind `ScraperProvider`.
 *
 * Every capability returns the same normalised record shape
 * (`{url, title, text, published_at, author, engagement, outputs, metadata}`),
 * which is what makes one mapping function serve web search, page extraction
 * and five social platforms alike.
 *
 * ## Billing is per call, and that shapes the interface
 *
 * A `web.search_web` execution bills about $0.007. Nothing here retries a
 * successful-but-unhelpful call, nothing fans out across capabilities
 * speculatively, and `limit` is always passed through rather than defaulted
 * generously. `Idempotency-Key` is sent on every execution because the API
 * requires it on billable POSTs, and reusing a key with different input is a
 * 409 rather than a double charge.
 */
export function createScrappyCocoScraper(options: ScrappyCocoOptions): ScraperProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const defaultTimeoutMs = options.timeoutMs ?? 120_000;
  let counter = 0;
  const nextKey = options.idempotencyKey ?? (() => `karos-${Date.now()}-${++counter}`);

  async function execute(
    source: string,
    capability: string,
    input: Record<string, unknown>,
    limit: number,
    timeoutMs: number,
  ): Promise<ScrapedRecord[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${EXECUTE_PATH}`, {
        method: "POST",
        headers: {
          "X-API-Key": options.apiKey,
          "Content-Type": "application/json",
          "Idempotency-Key": nextKey(),
        },
        body: JSON.stringify({ source, capability, input, limit }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ScraperError(`scrappycoco ${source}.${capability} failed: ${(error as Error).message}`);
    }

    if (!response.ok) {
      // These three need genuinely different fixes, so they are named rather
      // than folded into one "request failed".
      const hint =
        response.status === 401 || response.status === 403
          ? " (invalid or unauthorised SCRAPPYCOCO_API_KEY)"
          : response.status === 402
            ? " (account out of credit)"
            : response.status === 429
              ? " (rate limited)"
              : "";
      throw new ScraperError(`scrappycoco ${source}.${capability} returned ${response.status}${hint}`, response.status);
    }

    let body: ExecuteResponse;
    try {
      body = (await response.json()) as ExecuteResponse;
    } catch (error) {
      throw new ScraperError(`scrappycoco ${source}.${capability} returned a non-JSON body: ${(error as Error).message}`);
    }

    const status = asString(body.status);
    // A 200 carrying a terminal non-success status is still a failure; without
    // this it would look like a query that found nothing.
    if (status !== undefined && status !== "completed" && status !== "partial") {
      throw new ScraperError(`scrappycoco ${source}.${capability} finished as "${status}"`);
    }

    const records = Array.isArray(body.records) ? body.records : [];
    return records
      .map(toRecord)
      .filter((r): r is ScrapedRecord => r !== undefined)
      .slice(0, limit);
  }

  return {
    name: "scrappycoco",

    async extractUrl(url: string, opts: ScrapeOptions = {}): Promise<ScrapedRecord | undefined> {
      const records = await execute("web", "extract_content", { url }, 1, opts.timeoutMs ?? defaultTimeoutMs);
      return records[0];
    },

    async searchKeyword(query: string, opts: SearchOptions = {}): Promise<ScrapedRecord[]> {
      const limit = opts.limit ?? 4;
      return execute(
        "web",
        "search_web",
        {
          query,
          ...(opts.country ? { country: opts.country } : {}),
          ...(opts.includeDomains && opts.includeDomains.length > 0 ? { include_domains: [...opts.includeDomains] } : {}),
        },
        limit,
        opts.timeoutMs ?? defaultTimeoutMs,
      );
    },

    async socialHistory(request: SocialHistoryRequest): Promise<ScrapedRecord[]> {
      const mapping = HISTORY_CAPABILITY[request.platform];
      const limit = request.limit ?? 12;
      // A leading @ is how humans write handles and how every provider rejects them.
      const username = request.username.replace(/^@+/, "");
      return execute(
        request.platform,
        mapping.capability,
        { [mapping.inputKey]: username },
        limit,
        request.timeoutMs ?? defaultTimeoutMs,
      );
    },

    async searchSocial(platform: SocialPlatform, query: string, opts: ScrapeOptions = {}): Promise<ScrapedRecord[]> {
      return execute(platform, "search_posts", { query }, opts.limit ?? 6, opts.timeoutMs ?? defaultTimeoutMs);
    },

    async fetchRaw(url: string, opts: ScrapeOptions = {}): Promise<RawPage | undefined> {
      const record = await this.extractUrl(url, opts);
      if (record === undefined) return undefined;
      const raw = record.raw as Record<string, unknown> | undefined;
      const outputs = raw && typeof raw["outputs"] === "object" && raw["outputs"] !== null ? (raw["outputs"] as Record<string, unknown>) : undefined;
      return {
        url: record.url,
        ...(record.text ? { text: record.text } : {}),
        ...(asString(outputs?.["html"]) ? { html: asString(outputs?.["html"])! } : {}),
        ...(record.title ? { title: record.title } : {}),
      };
    },
  };
}
