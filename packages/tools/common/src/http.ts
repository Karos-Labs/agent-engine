/**
 * The one bounded-and-retried outbound HTTP stack for the tool layer.
 *
 * ## Why this file exists here
 *
 * `docs/AUDIT-2026-08-25-architecture-optimization-plan.md:56` (matrix row R5)
 * counts "3–4 fetch stacks" across the tool packages — the scraper with no
 * timeout at all, media's `fetchJson`, media's `brand-logo.ts` downloader, and
 * reputation's `fetchWithDeadline`, which it names "the best one". Retry
 * exists in exactly one tool. Its prescribed action is verbatim: *"Promote
 * reputation's `fetchWithDeadline` + a shared retry policy into
 * `tools/common`; adopt everywhere."*
 *
 * `fetchWithDeadline`, `isDeadlineError` and `describeFetchFailure` below are
 * moved from `packages/tools/karos-reputation/src/capture/http.ts` unchanged —
 * same signatures, same default budget, same behaviour — and that file is now
 * a re-export shim so the reputation adapters keep the exact stack they were
 * written and tested against. `fetchWithRetry` is the second half of R5, the
 * part that did not exist anywhere: a single retry policy instead of one
 * bespoke `await delay(3000)` per adapter.
 *
 * ## The reputation doc comment this inherits, because the reasoning still holds
 *
 * Every leg that uses this already degrades correctly when a vendor says no: a
 * missing key or an HTTP error produces a dead-leg tombstone rather than a
 * silent zero (ADAPTERS.md rule 1). What none of them bounded was TIME. A
 * vendor that accepts the connection and then never answers held the step open
 * until the container's own request deadline killed it, which loses the whole
 * run mid-flight — strictly worse than the tombstone the same adapter would
 * have written for an outright refusal.
 *
 * So a timeout here is not an error path bolted on; it is the same dead-leg
 * path the adapter already has, reached by a different route. The same is true
 * of a retry that gives up: `fetchWithRetry` returns the last *response* on a
 * retryable status rather than throwing, so a caller's existing
 * `if (!response.ok) return dead(...)` branch stays the one place a refusal
 * turns into a tombstone.
 */

/**
 * One outbound request's budget. Review and Google APIs answer in well under a
 * second when healthy, so this is far above normal and exists only to bound
 * the pathological case.
 */
export const CAPTURE_TIMEOUT_MS = 15_000;

export type CaptureFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Adds a deadline to one request, preserving whatever init the caller passed.
 * A caller that already set its own `signal` keeps it — a deliberate per-call
 * budget beats this default.
 */
export async function fetchWithDeadline(
  fetchImpl: CaptureFetch,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = CAPTURE_TIMEOUT_MS,
): Promise<Response> {
  if (init.signal) return fetchImpl(url, init);
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** True when a thrown error is this deadline firing rather than a transport failure. */
export function isDeadlineError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** A dead-leg reason line that says which of the two happened. */
export function describeFetchFailure(err: unknown, vendor: string): string {
  if (isDeadlineError(err)) return `${vendor} did not respond within ${CAPTURE_TIMEOUT_MS / 1000}s`;
  return `${vendor} could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * The statuses worth asking again about. 429 and the 5xx family are the
 * vendor saying "not now"; every 4xx below 429 is the vendor saying "not ever
 * with these arguments", and retrying those burns the budget to arrive at the
 * same answer. 408 and 425 are in because both are explicitly "the request
 * timed out / arrived too early, send it again".
 */
export const RETRYABLE_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

export interface RetryPolicy {
  /** TOTAL attempts including the first, so `1` means "no retry". */
  readonly maxAttempts: number;
  /** Backoff before the second attempt; each later wait multiplies by `backoffFactor`, capped at `maxDelayMs`. */
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  readonly retryableStatuses: readonly number[];
  /** Cap on a `Retry-After` the vendor asks for. Without it a hostile or mistaken header parks a run for hours. */
  readonly maxRetryAfterMs: number;
}

/**
 * Three attempts, half-a-second base, exponential, capped at 5s per wait.
 * Deliberately small: these calls sit inside a step that has its own budget,
 * and a retry schedule that outlives the step is a retry schedule that turns
 * one slow vendor into a failed run.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
  backoffFactor: 2,
  retryableStatuses: RETRYABLE_STATUSES,
  maxRetryAfterMs: 10_000,
};

export interface FetchWithRetryOptions {
  init?: RequestInit;
  /** Per-ATTEMPT deadline, handed to `fetchWithDeadline`. Defaults to `CAPTURE_TIMEOUT_MS`. */
  timeoutMs?: number;
  policy?: RetryPolicy;
  /**
   * Wall-clock budget across ALL attempts and the waits between them. A retry
   * is not started when the elapsed time plus its own backoff would already
   * exceed this, so the caller's overall deadline is honoured rather than
   * multiplied by `maxAttempts`.
   */
  totalBudgetMs?: number;
  /** Injectable purely so tests exercise the real backoff path without a real wall-clock wait — the `captureAppstore` convention. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, same reason. */
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Retry-After` in its delta-seconds form (the form Google's APIs send).
 * An HTTP-date form, a negative, or anything unparseable yields `null` and the
 * caller falls back to its own backoff rather than trusting a bad header.
 */
export function parseRetryAfterMs(headerValue: string | null, maxRetryAfterMs: number): number | null {
  if (headerValue === null) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxRetryAfterMs);
}

/** How long to wait before attempt number `attempt` (1-based: the wait before attempt 2 is `initialDelayMs`). */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const raw = policy.initialDelayMs * policy.backoffFactor ** (attempt - 2);
  return Math.min(Math.max(raw, 0), policy.maxDelayMs);
}

/**
 * One request, bounded per attempt and retried on the statuses and transport
 * failures that are worth asking again about.
 *
 * Two deliberate non-behaviours:
 *
 * - A retryable status that survives every attempt is RETURNED, not thrown.
 *   The adapters already turn `!response.ok` into a tombstone with the status
 *   in the reason line; throwing here would route that through the generic
 *   catch instead and lose which status it was.
 * - A deadline (`TimeoutError`/`AbortError`) is NOT retried. The caller asked
 *   for a time budget; spending it three times over is the opposite of
 *   honouring it. It rethrows immediately so `describeFetchFailure` can say
 *   "did not respond within Ns" — the distinction that file exists to keep.
 */
export async function fetchWithRetry(fetchImpl: CaptureFetch, url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget = options.totalBudgetMs;

  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithDeadline(fetchImpl, url, options.init ?? {}, timeoutMs);
      if (!policy.retryableStatuses.includes(response.status)) return response;
      lastResponse = response;
      lastError = undefined;
    } catch (err) {
      // A deadline is the caller's budget arriving, not a flaky vendor.
      if (isDeadlineError(err)) throw err;
      lastError = err;
      lastResponse = undefined;
    }

    if (attempt === policy.maxAttempts) break;

    const retryAfter = lastResponse ? parseRetryAfterMs(lastResponse.headers.get("retry-after"), policy.maxRetryAfterMs) : null;
    const waitMs = retryAfter ?? backoffDelayMs(attempt + 1, policy);
    // Starting a wait we cannot afford to finish just delays the same failure.
    if (budget !== undefined && now() - startedAt + waitMs >= budget) break;
    await sleep(waitMs);
    if (budget !== undefined && now() - startedAt >= budget) break;
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
