import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Message, PubSub } from "@google-cloud/pubsub";
import { GooglePubSubQueueAdapter } from "../src/adapters/google-pubsub-adapter.js";

/**
 * A minimal duck-typed `Message`-shaped fake: a real `EventEmitter` (so
 * `subscription.on`/`removeListener` behave exactly like the real Pub/Sub
 * client's `Subscription`) plus the handful of fields/methods
 * `GooglePubSubQueueAdapter.subscribe` actually reads.
 */
function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    data: Buffer.from(JSON.stringify({ hello: "world" }), "utf8"),
    attributes: {},
    publishTime: { toISOString: () => "2026-08-20T00:00:00.000Z" },
    deliveryAttempt: 1,
    ack: vi.fn(),
    nack: vi.fn(),
    ...overrides,
  } as unknown as Message;
}

/** A duck-typed `Subscription`: a real EventEmitter plus a `close()` spy. */
function fakeSubscription() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { close: vi.fn().mockResolvedValue(undefined) });
}

function fakePubSub(overrides: { topic?: unknown; subscription?: unknown } = {}): PubSub {
  return {
    topic: vi.fn().mockReturnValue(overrides.topic ?? {}),
    subscription: vi.fn().mockReturnValue(overrides.subscription ?? fakeSubscription()),
  } as unknown as PubSub;
}

describe("GooglePubSubQueueAdapter", () => {
  describe("publish", () => {
    it("calls client.topic(name).publishMessage({json: payload}) and returns the messageId", async () => {
      const publishMessage = vi.fn().mockResolvedValue("generated-message-id-1");
      const client = fakePubSub({ topic: { publishMessage } });
      const adapter = new GooglePubSubQueueAdapter({ client });

      const result = await adapter.publish("my-topic", { clientSlug: "acme", productId: "linkedin-agent" });

      expect(client.topic).toHaveBeenCalledWith("my-topic");
      expect(publishMessage).toHaveBeenCalledWith({ json: { clientSlug: "acme", productId: "linkedin-agent" } });
      expect(result).toEqual({ messageId: "generated-message-id-1" });
    });

    it("includes attributes in the publishMessage call when provided", async () => {
      const publishMessage = vi.fn().mockResolvedValue("generated-message-id-2");
      const client = fakePubSub({ topic: { publishMessage } });
      const adapter = new GooglePubSubQueueAdapter({ client });

      await adapter.publish("my-topic", { a: 1 }, { source: "demo-script" });

      expect(publishMessage).toHaveBeenCalledWith({ json: { a: 1 }, attributes: { source: "demo-script" } });
    });

    it("reports the provider id", () => {
      const adapter = new GooglePubSubQueueAdapter({ client: fakePubSub() });
      expect(adapter.providerId).toBe("google-pubsub");
    });
  });

  describe("subscribe", () => {
    it("calls client.subscription(name) and delivers a correctly-shaped QueueMessage, acking on handler success", async () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client });

      const handler = vi.fn().mockResolvedValue(undefined);
      adapter.subscribe("my-subscription", handler);

      expect(client.subscription).toHaveBeenCalledWith("my-subscription");

      const message = fakeMessage({
        id: "msg-42",
        data: Buffer.from(JSON.stringify({ clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" }), "utf8"),
        attributes: { source: "test" },
        deliveryAttempt: 2,
      });
      sub.emit("message", message);

      // The handler runs inside a fire-and-forget async IIFE — flush microtasks.
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]![0];
      expect(received).toEqual({
        id: "msg-42",
        payload: { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" },
        attributes: { source: "test" },
        publishTime: "2026-08-20T00:00:00.000Z",
        deliveryAttempt: 2,
      });
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.nack).not.toHaveBeenCalled();
    });

    it("nacks (not acks) when the handler throws, without crashing the process", async () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client });

      const handler = vi.fn().mockRejectedValue(new Error("boom"));
      adapter.subscribe("my-subscription", handler);

      const message = fakeMessage();
      sub.emit("message", message);
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(message.nack).toHaveBeenCalledTimes(1);
      expect(message.ack).not.toHaveBeenCalled();
    });

    it("nacks non-JSON message data without ever invoking the handler", async () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client });

      const handler = vi.fn().mockResolvedValue(undefined);
      adapter.subscribe("my-subscription", handler);

      const message = fakeMessage({ data: Buffer.from("not valid json{{{", "utf8") });
      sub.emit("message", message);
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler).not.toHaveBeenCalled();
      expect(message.nack).toHaveBeenCalledTimes(1);
      expect(message.ack).not.toHaveBeenCalled();
    });

    it("stop() removes both listeners and closes the underlying subscription", async () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client });

      const handler = vi.fn().mockResolvedValue(undefined);
      const subscription = adapter.subscribe("my-subscription", handler);

      expect(sub.listenerCount("message")).toBe(1);
      expect(sub.listenerCount("error")).toBe(1);

      await subscription.stop();

      expect(sub.listenerCount("message")).toBe(0);
      expect(sub.listenerCount("error")).toBe(0);
      expect(sub.close).toHaveBeenCalledTimes(1);

      // A message emitted after stop() must not reach the (now-removed) handler.
      sub.emit("message", fakeMessage());
      await new Promise((resolve) => setImmediate(resolve));
      expect(handler).not.toHaveBeenCalled();
    });

    it("logs (does not throw) when the subscription reports a stream error", () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client });
      adapter.subscribe("my-subscription", vi.fn());

      expect(() => sub.emit("error", new Error("stream broke"))).not.toThrow();
    });
  });

  describe("client resolver-function form", () => {
    it("works identically to the static-client form for publish", async () => {
      const publishMessage = vi.fn().mockResolvedValue("resolved-message-id");
      const client = fakePubSub({ topic: { publishMessage } });
      const adapter = new GooglePubSubQueueAdapter({ client: () => client });

      const result = await adapter.publish("my-topic", { a: 1 });

      expect(client.topic).toHaveBeenCalledWith("my-topic");
      expect(result).toEqual({ messageId: "resolved-message-id" });
    });

    it("works identically to the static-client form for subscribe", async () => {
      const sub = fakeSubscription();
      const client = fakePubSub({ subscription: sub });
      const adapter = new GooglePubSubQueueAdapter({ client: () => client });

      const handler = vi.fn().mockResolvedValue(undefined);
      adapter.subscribe("my-subscription", handler);

      const message = fakeMessage();
      sub.emit("message", message);
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(message.ack).toHaveBeenCalledTimes(1);
    });
  });
});
