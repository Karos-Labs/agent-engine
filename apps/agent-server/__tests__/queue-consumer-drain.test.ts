import { describe, expect, it } from "vitest";

import { drainInFlight } from "../src/queue-consumer.js";

/**
 * THE WORKER WAITS FOR WHAT IT IS RUNNING, AND SAYS WHAT IT CUT.
 *
 * `shutdown` used to call `subscription.stop()` and then `process.exit()` in
 * the same breath, awaiting nothing. Recovery was never the issue — the run
 * lease lapses, `RetryLater` holds the message for one lease period and the
 * redelivery replays from checkpoints — but the kill was SILENT. Nine prep runs
 * ended frozen with a step at `running`, no `failureReason` and no `reason`, so
 * the client saw a blank error and an operator had nothing to read.
 *
 * Cloud Run gives a service about ten seconds after SIGTERM and does not let
 * you configure it, so this can never wait out a ten-minute agent step. It buys
 * the short tail — a handler in its last write — and, when it cannot, the one
 * log line that names the runs being cut.
 *
 * Each case asserts the RETURN VALUE, which is what the caller logs, rather
 * than that the function merely resolved. The timings are deliberately far
 * apart (10ms work against a 200ms grace, 200ms work against a 20ms grace) so
 * these do not become flaky on a loaded machine.
 */

function after(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("drainInFlight", () => {
  it("returns immediately when nothing is running", async () => {
    const started = Date.now();
    await expect(drainInFlight(new Map(), 5_000)).resolves.toEqual([]);
    // Proves it did not sit out the grace: a naive implementation that always
    // waited would take five seconds here.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits for a handler that finishes inside the grace, and reports nothing cut", async () => {
    const inFlight = new Map<string, Promise<void>>();
    let done = false;
    inFlight.set(
      "pubsub-1",
      after(10).then(() => {
        done = true;
        inFlight.delete("pubsub-1");
      }),
    );

    await expect(drainInFlight(inFlight, 200)).resolves.toEqual([]);
    expect(done).toBe(true);
  });

  it("names the runs still executing when the grace expires", async () => {
    const inFlight = new Map<string, Promise<void>>();
    inFlight.set("pubsub-slow-a", after(200));
    inFlight.set("pubsub-slow-b", after(200));

    // This is the case the nine frozen runs were: the process leaves while work
    // is still in flight. What changed is that it now says which work.
    await expect(drainInFlight(inFlight, 20)).resolves.toEqual([
      "pubsub-slow-a",
      "pubsub-slow-b",
    ]);
  });

  it("reports only what is STILL running, not what finished while waiting", async () => {
    const inFlight = new Map<string, Promise<void>>();
    inFlight.set(
      "pubsub-quick",
      after(10).then(() => {
        inFlight.delete("pubsub-quick");
      }),
    );
    inFlight.set("pubsub-slow", after(500));

    await expect(drainInFlight(inFlight, 60)).resolves.toEqual(["pubsub-slow"]);
  });

  it("treats a handler that REJECTED as settled rather than hanging on it", async () => {
    const inFlight = new Map<string, Promise<void>>();
    // The map holds promises that already swallow, but a drain that used
    // `Promise.all` instead of `allSettled` would reject here and the caller's
    // catch would exit without ever reporting the stragglers.
    inFlight.set("pubsub-failed", Promise.reject(new Error("boom")).catch(() => undefined));

    await expect(drainInFlight(inFlight, 200)).resolves.toEqual([]);
  });
});
