/**
 * A lightweight, bounded exponential-backoff retry loop for transient LLM API
 * failures — HTTP 429 (rate limit), 5xx (server-side), or a network-level
 * timeout/connection error. A genuine 4xx client error (bad request, auth
 * failure, a schema the model can't satisfy) is never retried: retrying that
 * three times just wastes the same failure three times over (a cloud/runtime
 * resilience audit finding — previously a single transient 429 mid-run turned
 * one turn into `tooling_error`, degrading the whole run and requiring a
 * manual resume).
 */
export interface RetryOptions {
  /** Total attempts, counting the first — not just the number of retries. Default 3 (1 initial + up to 2 retries). */
  maxAttempts?: number;
  /** The first retry's delay; each subsequent retry doubles it. Default 300ms. */
  baseDelayMs?: number;
  /** Injectable so tests exercise the real retry path without a real wall-clock wait. Defaults to a real `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

/** Exported for `ResilientClaudeAdapter`, which classifies failover-worthiness (429/404) rather than same-transport retryability. */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as { status?: unknown; statusCode?: unknown };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" ? status : undefined;
}

function isRetryableNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { code?: unknown; name?: unknown; cause?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  // Both the Anthropic and OpenAI SDKs throw a distinctly-named connection/timeout error
  // (e.g. `APIConnectionError`, `APIConnectionTimeoutError`) that carries no HTTP status
  // at all — matched by class name rather than importing either SDK's error classes, so
  // this stays adapter-agnostic. `err.constructor.name` (not just `.name`) because a
  // custom Error subclass only gets a `.name` matching its class if its own constructor
  // explicitly sets `this.name` — `constructor.name` reflects the real class regardless.
  const name = typeof record.name === "string" ? record.name : undefined;
  const ctorName = err.constructor?.name;
  if ((name && /connection|timeout/i.test(name)) || (ctorName && /connection|timeout/i.test(ctorName))) return true;
  // A wrapped cause (e.g. `fetch failed`, { cause: <the real network error> } — RFC-01
  // §16.4's own logging convention) may carry the real retryable signal one level down.
  if (record.cause !== undefined && record.cause !== err) return isRetryableNetworkError(record.cause);
  return false;
}

/** Exported for adapter-specific tests that want to assert retryability directly without driving a full retry loop. */
export function isRetryableError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  return isRetryableNetworkError(err);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
