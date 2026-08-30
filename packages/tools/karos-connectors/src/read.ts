import type { z } from "zod";
import { DEFAULT_RETRY_POLICY, describeFetchFailure, fetchWithRetry, type RetryPolicy } from "@agent-engine/tool-common";
import { assertReadMethodAllowed, type ConnectorKey } from "./allowlist.js";
import type { ConnectorFetchImpl, ConnectorReadOutcome } from "./types.js";

/**
 * The single chokepoint every Google read in this package goes through.
 *
 * Three things happen here and nowhere else, which is the point:
 *
 * 1. `assertReadMethodAllowed` runs FIRST, before the URL is even handed to
 *    the fetcher, so a write endpoint is unreachable rather than merely
 *    un-called (`security.write_method_protection`, FLAG-1).
 * 2. The request is bounded and retried by the ONE shared stack
 *    (`@agent-engine/tool-common`'s `fetchWithDeadline`/`fetchWithRetry` —
 *    audit row R5), never a per-connector copy.
 * 3. The response body is `safeParse`d at the boundary before anything
 *    downstream sees it — the same rule SCRUM-296/AU11 imposed on
 *    `karos-reputation`'s adapters after a `"N/A"` rating became `NaN` and
 *    landed un-flagged in a scored field.
 */
export interface ReadRuntime {
  fetchImpl: ConnectorFetchImpl;
  policy?: RetryPolicy;
  /** Per-attempt deadline. */
  timeoutMs?: number;
  /** Wall-clock budget across all attempts and backoffs. */
  totalBudgetMs?: number;
  /** Injectable purely so tests exercise the real backoff path without a real wall-clock wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AllowlistedReadRequest {
  connector: ConnectorKey;
  /** The allowlist token, e.g. `"searchanalytics.query"`. Checked before the URL is used. */
  method: string;
  url: string;
  init?: RequestInit;
  /** Human-readable vendor name for the failure line, e.g. "the Search Console API". */
  vendor: string;
}

export async function allowlistedRead<TSchema extends z.ZodType>(
  request: AllowlistedReadRequest,
  runtime: ReadRuntime,
  schema: TSchema,
): Promise<ConnectorReadOutcome<z.infer<TSchema>>> {
  assertReadMethodAllowed(request.connector, request.method);

  const dead = (reason: string, attempts: number): ConnectorReadOutcome<z.infer<TSchema>> => ({
    connector: request.connector,
    method: request.method,
    status: "UNAVAILABLE",
    reason,
    attempts,
  });

  // Counted by wrapping the injected fetcher rather than by asking the retry
  // helper: the helper returns a Response, and a caller that wants to see a
  // retried 429 in its telemetry needs the count even on the success path.
  let attempts = 0;
  const countingFetch: ConnectorFetchImpl = (input, init) => {
    attempts += 1;
    return runtime.fetchImpl(input, init);
  };

  let response: Response;
  try {
    response = await fetchWithRetry(countingFetch as (url: string, init?: RequestInit) => Promise<Response>, request.url, {
      ...(request.init ? { init: request.init } : {}),
      policy: runtime.policy ?? DEFAULT_RETRY_POLICY,
      ...(runtime.timeoutMs !== undefined ? { timeoutMs: runtime.timeoutMs } : {}),
      ...(runtime.totalBudgetMs !== undefined ? { totalBudgetMs: runtime.totalBudgetMs } : {}),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.now ? { now: runtime.now } : {}),
    });
  } catch (err) {
    return dead(describeFetchFailure(err, request.vendor), attempts);
  }

  if (!response.ok) {
    return dead(`${request.vendor} returned HTTP ${response.status} for ${request.method}`, attempts);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return dead(`${request.vendor} returned a body that is not JSON: ${err instanceof Error ? err.message : String(err)}`, attempts);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // A 200 whose body does not match the contract is a failed read, not an
    // empty one — the difference between "no data" and "we stopped
    // understanding this API" is the whole reason for the tombstone rule.
    return dead(`${request.vendor} response did not match the expected ${request.method} shape: ${parsed.error.message}`, attempts);
  }

  return { connector: request.connector, method: request.method, status: "ok", payload: parsed.data as z.infer<TSchema>, attempts };
}
