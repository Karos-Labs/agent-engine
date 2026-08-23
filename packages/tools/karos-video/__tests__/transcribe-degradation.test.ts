import { describe, expect, it } from "vitest";
import { createTranscribe } from "../src/tools/transcribe.js";

/**
 * How `video.transcribe` behaves when the world is not cooperating.
 *
 * The distinction under test is who is supposed to act. "This deployment has
 * never been given a key" is answered by an operator; "ElevenLabs returned a
 * 502" is answered by retrying; "ElevenLabs accepted the connection and went
 * quiet" is answered by giving up rather than holding the run open until the
 * container dies. Reporting all three the same way is how the first one gets
 * mistaken for an outage — which is exactly how it read in prep.
 */

const CTX = { runId: "r1", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "recurring" } as never;

function transcribeWith(opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  return createTranscribe({
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    env: opts.env ?? {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl as never } : {}),
    // No real disk: this suite is about the network boundary, and a missing
    // fixture file would fail every case before it reached one.
    readFileImpl: async () => Buffer.from("fake-media-bytes"),
  });
}

describe("video.transcribe degradation", () => {
  it("reports an unconfigured deployment as not_available, not as a failure", async () => {
    // The whole point: nobody broke anything, the feature was never enabled
    // here. Retrying will not help and an on-call reading "tooling_error"
    // would go looking for an outage that does not exist.
    const outcome = await transcribeWith({ env: {} }).execute({ videoPath: "/tmp/a.mp4" } as never, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    if (outcome.status !== "not_available") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/has not enabled transcription/);
  });

  it("still reports a vendor error as a tooling_error", async () => {
    const outcome = await transcribeWith({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchImpl: (async () =>
        new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch,
    }).execute({ videoPath: "/tmp/a.mp4" } as never, { ctx: CTX });

    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/502/);
  });

  it("gives up on a vendor that never answers, and says so", async () => {
    // A hung upload used to hold the step open until the container's own
    // request deadline killed it, losing the run mid-flight. A slow vendor
    // should cost one step, not the work before it.
    const outcome = await transcribeWith({
      env: { ELEVENLABS_API_KEY: "k" },
      timeoutMs: 40,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Behave like a real fetch: reject when the caller's signal fires.
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
          });
        })) as unknown as typeof fetch,
    }).execute({ videoPath: "/tmp/a.mp4" } as never, { ctx: CTX });

    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/did not respond within/);
  });

  it("passes a deadline on the request at all", async () => {
    // The property that makes the test above possible in production rather
    // than only under a cooperative stub.
    let seen: AbortSignal | null | undefined;
    await transcribeWith({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen = init?.signal;
        return new Response(JSON.stringify({ words: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    }).execute({ videoPath: "/tmp/a.mp4" } as never, { ctx: CTX });

    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("separates unreachable from timed out", async () => {
    const outcome = await transcribeWith({
      env: { ELEVENLABS_API_KEY: "k" },
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    }).execute({ videoPath: "/tmp/a.mp4" } as never, { ctx: CTX });

    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/could not be reached/);
    expect(outcome.reason).not.toMatch(/did not respond within/);
  });
});
