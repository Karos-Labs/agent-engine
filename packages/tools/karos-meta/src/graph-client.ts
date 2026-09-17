import { z } from "zod";
import { DEFAULT_RETRY_POLICY, describeFetchFailure, fetchWithRetry, type RetryPolicy } from "@agent-engine/tool-common";
import type { MetaFetchImpl, MetaReadOutcome } from "./types.js";

/**
 * Pinned to match the version this codebase's existing Meta callers already
 * use — `karosCMO/src/lib/integrations/oauth.ts` and `publishers.ts` both
 * call `v20.0`. Bumping it is a deliberate, separately-reviewed change, not
 * something this package should drift from on its own.
 */
export const GRAPH_API_VERSION = "v20.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface GraphRuntime {
  fetchImpl: MetaFetchImpl;
  policy?: RetryPolicy;
  /** Per-attempt deadline. */
  timeoutMs?: number;
  /** Wall-clock budget across all attempts and backoffs. */
  totalBudgetMs?: number;
  /** Injectable purely so tests exercise the real backoff path without a real wall-clock wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Meta's own error envelope (`{"error": {...}}`), parsed so a caller can
 * tell "the token is dead" (code 190) from "this permission has not cleared
 * App Review yet for an asset outside the app's own roles" (code 10, or the
 * 2xx `error_subcode`s Meta documents for that) from an ordinary failure,
 * instead of reporting every non-2xx the same way.
 */
export const GraphErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

export class GraphAccessError extends Error {
  readonly httpStatus: number;
  readonly code: number | undefined;
  readonly errorSubcode: number | undefined;
  readonly fbtraceId: string | undefined;

  constructor(httpStatus: number, metaMessage?: string, code?: number, errorSubcode?: number, fbtraceId?: string) {
    super(metaMessage ?? `Meta Graph API returned HTTP ${httpStatus} with no parseable error body`);
    this.name = "GraphAccessError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.errorSubcode = errorSubcode;
    this.fbtraceId = fbtraceId;
  }

  /**
   * True for the shape Meta returns while a permission is still in
   * Development Mode, or awaiting App Review, for an asset outside the
   * app's own roles — code 10 ("permission denied" for this action), or the
   * 200-series subcodes Meta documents for "application does not have
   * permission for this action". Distinguishing this from a dead token
   * (code 190) is the whole reason to parse the body rather than just
   * checking the HTTP status.
   */
  get isPendingAppReview(): boolean {
    return this.code === 10 || (this.errorSubcode !== undefined && this.errorSubcode >= 200 && this.errorSubcode < 300);
  }

  get isTokenDead(): boolean {
    return this.code === 190;
  }
}

async function parseGraphError(response: Response): Promise<GraphAccessError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new GraphAccessError(response.status);
  }
  const parsed = GraphErrorBodySchema.safeParse(body);
  if (!parsed.success) return new GraphAccessError(response.status);
  const { message, code, error_subcode, fbtrace_id } = parsed.data.error;
  return new GraphAccessError(response.status, message, code, error_subcode, fbtrace_id);
}

/**
 * One bounded, retried Graph API GET. Every read in this package goes
 * through here — never a bare `fetch` — so timeout/retry policy and error
 * parsing stay in one place.
 *
 * This package is no longer read-only: `graphPost` below is the write
 * counterpart, used by `publish.ts`. The safety property this codebase asked
 * for is not "no write function exists" anymore — it's a two-gate check
 * (`META_SYSTEM_USER_TOKEN` configured AND `META_PUBLISH_ENABLED` explicitly
 * set) enforced once, at the tool boundary in `index.ts`, before either
 * `publish.ts` function is ever called. See that file's module header.
 */
export async function graphGet<TSchema extends z.ZodType>(
  method: string,
  path: string,
  params: Record<string, string>,
  token: string,
  runtime: GraphRuntime,
  schema: TSchema,
): Promise<MetaReadOutcome<z.infer<TSchema>>> {
  const url = new URL(`${GRAPH_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);

  const dead = (reason: string, attempts: number): MetaReadOutcome<z.infer<TSchema>> => ({ method, status: "UNAVAILABLE", reason, attempts });

  // Counted by wrapping the injected fetcher rather than by asking the retry
  // helper: a caller that wants to see a retried 429 in its telemetry needs
  // the count even on the success path (same reasoning as `karos-connectors`' `allowlistedRead`).
  let attempts = 0;
  const countingFetch: MetaFetchImpl = (input, init) => {
    attempts += 1;
    return runtime.fetchImpl(input, init);
  };

  let response: Response;
  try {
    response = await fetchWithRetry(countingFetch as (url: string, init?: RequestInit) => Promise<Response>, url.toString(), {
      policy: runtime.policy ?? DEFAULT_RETRY_POLICY,
      ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
      ...(runtime.totalBudgetMs !== undefined ? { totalBudgetMs: runtime.totalBudgetMs } : {}),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.now ? { now: runtime.now } : {}),
    });
  } catch (err) {
    return dead(describeFetchFailure(err, "the Meta Graph API"), attempts);
  }

  if (!response.ok) {
    const graphError = await parseGraphError(response);
    const hint = graphError.isTokenDead
      ? " — the System User token is dead or was revoked; a new one has to be generated in Meta Business Settings"
      : graphError.isPendingAppReview
        ? " — this permission has not cleared Meta App Review yet (or the app is still in Development Mode for this asset)"
        : "";
    return dead(`the Meta Graph API returned HTTP ${response.status} for ${method}${hint}: ${graphError.message}`, attempts);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return dead(`the Meta Graph API returned a body that is not JSON: ${err instanceof Error ? err.message : String(err)}`, attempts);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // A 200 whose body does not match the contract is a failed read, not an
    // empty one — same rule `karos-connectors`' `allowlistedRead` applies.
    return dead(`the Meta Graph API response did not match the expected ${method} shape: ${parsed.error.message}`, attempts);
  }

  return { method, status: "ok", payload: parsed.data as z.infer<TSchema>, attempts };
}

/**
 * `exactOptionalPropertyTypes` treats `payload?: T` as "absent or T", never
 * "absent, T, or explicitly undefined" — so a failure branch that wants to
 * hand back everything except the payload has to actually drop the key
 * rather than set it to `undefined`. This is the one place that happens.
 */
export function omitPayload<T>(outcome: MetaReadOutcome<T>): MetaReadOutcome<never> {
  const { payload: _payload, ...rest } = outcome;
  return rest;
}

/**
 * One bounded, retried Graph API POST — form-encoded body, same as Meta's own
 * examples for `/media`, `/media_publish` and `/feed`. Mirrors `graphGet`
 * almost exactly (same retry/attempt-counting/error-parsing shape) so the two
 * stay obviously consistent; the only differences are the HTTP method and
 * that params travel in the body rather than the query string.
 *
 * `access_token` still goes in with the rest of `params` rather than as a
 * header — Meta's Graph API accepts it either way for a POST, and every
 * existing caller in this codebase (`oauth.ts`, `publishers.ts`) already
 * sends it this way, so a captured request looks the same regardless of
 * which code path sent it.
 */
export async function graphPost<TSchema extends z.ZodType>(
  method: string,
  path: string,
  params: Record<string, string>,
  token: string,
  runtime: GraphRuntime,
  schema: TSchema,
): Promise<MetaReadOutcome<z.infer<TSchema>>> {
  const url = new URL(`${GRAPH_API_BASE}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  const dead = (reason: string, attempts: number): MetaReadOutcome<z.infer<TSchema>> => ({ method, status: "UNAVAILABLE", reason, attempts });

  let attempts = 0;
  const countingFetch: MetaFetchImpl = (input, init) => {
    attempts += 1;
    return runtime.fetchImpl(input, init);
  };

  let response: Response;
  try {
    response = await fetchWithRetry(countingFetch as (url: string, init?: RequestInit) => Promise<Response>, url.toString(), {
      init: { method: "POST", body: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } },
      policy: runtime.policy ?? DEFAULT_RETRY_POLICY,
      ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
      ...(runtime.totalBudgetMs !== undefined ? { totalBudgetMs: runtime.totalBudgetMs } : {}),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.now ? { now: runtime.now } : {}),
    });
  } catch (err) {
    return dead(describeFetchFailure(err, "the Meta Graph API"), attempts);
  }

  if (!response.ok) {
    const graphError = await parseGraphError(response);
    const hint = graphError.isTokenDead
      ? " — the System User token is dead or was revoked; a new one has to be generated in Meta Business Settings"
      : graphError.isPendingAppReview
        ? " — this permission has not cleared Meta App Review yet (or the app is still in Development Mode for this asset)"
        : "";
    return dead(`the Meta Graph API returned HTTP ${response.status} for ${method}${hint}: ${graphError.message}`, attempts);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return dead(`the Meta Graph API returned a body that is not JSON: ${err instanceof Error ? err.message : String(err)}`, attempts);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return dead(`the Meta Graph API response did not match the expected ${method} shape: ${parsed.error.message}`, attempts);
  }

  return { method, status: "ok", payload: parsed.data as z.infer<TSchema>, attempts };
}
