/**
 * Bounded fetch for the review-capture adapters.
 *
 * Every leg here already degrades correctly when a vendor says no: a missing
 * key or an HTTP error produces a dead-leg tombstone rather than a silent zero
 * (ADAPTERS.md rule 1). What none of them bounded was TIME. A vendor that
 * accepts the connection and then never answers held the step open until the
 * container's own request deadline killed it, which loses the whole run
 * mid-flight — strictly worse than the tombstone the same adapter would have
 * written for an outright refusal.
 *
 * So a timeout here is not an error path bolted on; it is the same dead-leg
 * path the adapter already has, reached by a different route.
 */

/**
 * One capture leg's budget. Review APIs answer in well under a second when
 * healthy, so this is far above normal and exists only to bound the
 * pathological case.
 */
export const CAPTURE_TIMEOUT_MS = 15_000;

export type CaptureFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Adds a deadline to one capture request, preserving whatever init the caller
 * passed. A caller that already set its own `signal` keeps it — a deliberate
 * per-call budget beats this default.
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
