import { describe, expect, it } from "vitest";
import {
  CAPTURE_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  describeFetchFailure,
  fetchWithDeadline,
  fetchWithRetry,
  isDeadlineError,
  parseRetryAfterMs,
  type CaptureFetch,
  type RetryPolicy,
} from "../src/http.js";

/**
 * The shared outbound HTTP stack (audit row R5). These tests exist because the
 * two properties this file promises — a request is bounded in TIME, and a
 * "not now" from a vendor is asked again — are both properties that a stack
 * can silently lose while still returning 200s in every happy-path test.
 */

/** A fetch that answers with a real `Response` and records exactly what it was asked for. */
function recordingFetch(statuses: readonly (number | Error)[], headers: Record<string, string> = {}): { fetchImpl: CaptureFetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetchImpl: CaptureFetch = async (url, init) => {
    calls.push(init ? { url, init } : { url });
    const next = statuses[Math.min(index, statuses.length - 1)] as number | Error;
    index += 1;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ ok: next }), { status: next, headers });
  };
  return { fetchImpl, calls };
}

/** Records every backoff wait instead of serving it, so the real schedule is asserted without a real wall-clock wait. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; now: () => number; waits: number[] } {
  const waits: number[] = [];
  let clock = 0;
  return {
    waits,
    now: () => clock,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
  };
}

describe("fetchWithDeadline", () => {
  it("bounds a request that never answers, and reports it as a deadline rather than a transport failure", async () => {
    // A vendor that accepts the connection and then goes silent — the exact
    // case this helper exists for. The fetch honours the injected signal, as
    // a real fetch does, so the abort has to actually arrive for this to end.
    const hangingFetch: CaptureFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        });
      });

    const started = Date.now();
    await expect(fetchWithDeadline(hangingFetch, "https://example.test/slow", {}, 40)).rejects.toMatchObject({ name: "TimeoutError" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);

    const err = new Error("aborted");
    err.name = "TimeoutError";
    expect(isDeadlineError(err)).toBe(true);
    expect(describeFetchFailure(err, "the vendor")).toBe(`the vendor did not respond within ${CAPTURE_TIMEOUT_MS / 1000}s`);
  });

  it("leaves a caller's own signal alone — a deliberate per-call budget beats the default", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const fetchImpl: CaptureFetch = async (_url, init) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    };
    await fetchWithDeadline(fetchImpl, "https://example.test", { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("fetchWithRetry", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const { fetchImpl, calls } = recordingFetch([429, 429, 200]);
    const clock = fakeClock();
    const response = await fetchWithRetry(fetchImpl, "https://example.test/a", { sleep: clock.sleep, now: clock.now });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(3);
    // 500ms then 1000ms — DEFAULT_RETRY_POLICY's initial delay and its x2 factor.
    expect(clock.waits).toEqual([500, 1000]);
  });

  it("retries a 503 and, having spent every attempt, RETURNS the last response rather than throwing", async () => {
    // Returning is the contract: the adapters turn `!response.ok` into a
    // tombstone carrying the status, and throwing would route that through a
    // generic catch and lose which status it was.
    const { fetchImpl, calls } = recordingFetch([503]);
    const clock = fakeClock();
    const response = await fetchWithRetry(fetchImpl, "https://example.test/b", { sleep: clock.sleep, now: clock.now });
    expect(response.status).toBe(503);
    expect(calls.length).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it("does not retry a 403 — the vendor said 'not ever with these arguments'", async () => {
    const { fetchImpl, calls } = recordingFetch([403]);
    const clock = fakeClock();
    const response = await fetchWithRetry(fetchImpl, "https://example.test/c", { sleep: clock.sleep, now: clock.now });
    expect(response.status).toBe(403);
    expect(calls.length).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it("honours a Retry-After the vendor sends, capped so a bad header cannot park a run", async () => {
    const { fetchImpl } = recordingFetch([429, 200], { "retry-after": "3" });
    const clock = fakeClock();
    await fetchWithRetry(fetchImpl, "https://example.test/d", { sleep: clock.sleep, now: clock.now });
    expect(clock.waits).toEqual([3000]);

    expect(parseRetryAfterMs("3", 10_000)).toBe(3000);
    expect(parseRetryAfterMs("99999", 10_000)).toBe(10_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT", 10_000)).toBeNull();
    expect(parseRetryAfterMs("-5", 10_000)).toBeNull();
    expect(parseRetryAfterMs(null, 10_000)).toBeNull();
  });

  it("retries a transport failure but NEVER a deadline — spending the caller's budget three times over is the opposite of honouring it", async () => {
    const transport = new Error("ECONNRESET");
    const { fetchImpl: flaky, calls: flakyCalls } = recordingFetch([transport, 200]);
    const clock = fakeClock();
    const recovered = await fetchWithRetry(flaky, "https://example.test/e", { sleep: clock.sleep, now: clock.now });
    expect(recovered.status).toBe(200);
    expect(flakyCalls.length).toBe(2);

    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { fetchImpl: slow, calls: slowCalls } = recordingFetch([timeout]);
    await expect(fetchWithRetry(slow, "https://example.test/f", { sleep: clock.sleep, now: clock.now })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(slowCalls.length).toBe(1);
  });

  it("stops when the total budget would be exceeded rather than multiplying it by maxAttempts", async () => {
    const patient: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, initialDelayMs: 400, maxDelayMs: 400 };
    const { fetchImpl, calls } = recordingFetch([500]);
    const clock = fakeClock();
    const response = await fetchWithRetry(fetchImpl, "https://example.test/g", { policy: patient, sleep: clock.sleep, now: clock.now, totalBudgetMs: 900 });
    expect(response.status).toBe(500);
    // 400 + 400 = 800 spent; a third 400ms wait would cross 900, so it is never started.
    expect(clock.waits).toEqual([400, 400]);
    expect(calls.length).toBe(3);
  });

  it("caps its own backoff at maxDelayMs", () => {
    expect(backoffDelayMs(2, DEFAULT_RETRY_POLICY)).toBe(500);
    expect(backoffDelayMs(3, DEFAULT_RETRY_POLICY)).toBe(1000);
    expect(backoffDelayMs(9, DEFAULT_RETRY_POLICY)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });
});
