import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { PubSub } from "@google-cloud/pubsub";
import { GooglePubSubQueueAdapter } from "../src/adapters/google-pubsub-adapter.js";
import { createQueueFromEnv, resolvePubSubFlowControl } from "../src/create-queue-from-env.js";

/**
 * A bound on how many run-jobs one consumer process holds (2026-09-22).
 *
 * `client.subscription(name)` with no options inherits the Node client's
 * default `flowControl.maxMessages` of 1000. This repo's consumer is a PULL
 * worker: `apps/agent-server/dist/queue-consumer.js`, `minScale=1`,
 * 1 vCPU / 2 GiB, `maxScale` 5 in prep and 20 in production. One message is a
 * whole workflow run executed inline, holding its downloaded media in process
 * memory for the life of the run. A thousand at once is not a slow instance,
 * it is an OOM — and because a pull consumer scales on CPU rather than on
 * subscription backlog, Cloud Run adds instances only after the damage, and
 * the redelivered messages land in the same shape.
 */

function fakeSubscription() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { close: vi.fn().mockResolvedValue(undefined) });
}

function fakePubSub(): { client: PubSub; subscription: ReturnType<typeof vi.fn> } {
  const subscription = vi.fn().mockReturnValue(fakeSubscription());
  return { client: { topic: vi.fn(), subscription } as unknown as PubSub, subscription };
}

describe("Pub/Sub flow control", () => {
  it("bounds messages in flight, and refuses the excess the server offers beyond that", () => {
    const { client, subscription } = fakePubSub();
    const adapter = new GooglePubSubQueueAdapter({ client, flowControl: { maxMessages: 4, maxExtensionMinutes: 60 } });

    adapter.subscribe("agent-engine-run-jobs-pull", async () => undefined);

    const [name, options] = subscription.mock.calls[0] as [string, { flowControl: unknown; maxExtensionTime: { totalOf(unit: "minute"): number } }];
    expect(name).toBe("agent-engine-run-jobs-pull");
    // `allowExcessMessages: false` matters as much as the count: left true
    // (the client default) the library hands over a whole server batch even
    // once the limit is reached, which makes the limit a suggestion.
    expect(options.flowControl).toEqual({ maxMessages: 4, allowExcessMessages: false });
    expect(options.maxExtensionTime.totalOf("minute")).toBe(60);
  });

  it("bounds an adapter built without any options at all, rather than inheriting the client's thousand", () => {
    // The default lives on the adapter too, not only in the env reader: a
    // direct construction (a script, a future second entry point) must not
    // quietly get 1000 back.
    const { client, subscription } = fakePubSub();
    new GooglePubSubQueueAdapter({ client }).subscribe("agent-engine-run-jobs-pull", async () => undefined);
    const [, options] = subscription.mock.calls[0] as [string, { flowControl: { maxMessages: number } }];
    expect(options.flowControl.maxMessages).toBe(4);
  });

  it("defaults to four per process rather than the client's thousand", () => {
    expect(resolvePubSubFlowControl({})).toEqual({ maxMessages: 4, maxExtensionMinutes: 60 });
  });

  it("takes an override from the environment", () => {
    expect(resolvePubSubFlowControl({ QUEUE_MAX_CONCURRENT_MESSAGES: "2", QUEUE_MAX_ACK_EXTENSION_MINUTES: "90" })).toEqual({
      maxMessages: 2,
      maxExtensionMinutes: 90,
    });
  });

  it("refuses a malformed override instead of quietly consuming nothing", () => {
    // The failure that matters: `maxMessages: 0` is a worker that pulls no
    // work at all and reports itself perfectly healthy while doing it.
    for (const bad of ["0", "-1", "lots", "2.5", ""]) {
      const env = { QUEUE_MAX_CONCURRENT_MESSAGES: bad };
      if (bad === "") {
        // An empty value reads as unset, which is the default — not an error.
        expect(resolvePubSubFlowControl(env).maxMessages).toBe(4);
        continue;
      }
      expect(() => resolvePubSubFlowControl(env)).toThrow(/QUEUE_MAX_CONCURRENT_MESSAGES/);
    }
  });

  it("reaches the adapter the server actually builds", () => {
    // The wiring, not just the option: a default that never reaches
    // `client.subscription` is a comment.
    const queue = createQueueFromEnv({ env: { PUBSUB_PROJECT_ID: "karoscmo-prep", QUEUE_MAX_CONCURRENT_MESSAGES: "3" } });
    expect(queue.providerId).toBe("google-pubsub");
    expect((queue as unknown as { flowControl: { maxMessages: number } }).flowControl.maxMessages).toBe(3);
  });
});
