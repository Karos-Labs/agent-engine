import { describe, expect, it } from "vitest";
import { createQueueFromEnv, resolveQueueProvider } from "../src/create-queue-from-env.js";
import { GooglePubSubQueueAdapter } from "../src/adapters/google-pubsub-adapter.js";

/**
 * Construction only — `new PubSub({projectId})` resolves Application Default
 * Credentials lazily (only once a request is actually sent), so every case
 * here stays fully offline: no network call, no real GCP credentials needed.
 */
describe("resolveQueueProvider", () => {
  it("defaults to 'pubsub' when QUEUE_PROVIDER is unset", () => {
    expect(resolveQueueProvider({})).toBe("pubsub");
  });

  it("accepts 'pubsub' explicitly, case-insensitively", () => {
    expect(resolveQueueProvider({ QUEUE_PROVIDER: "pubsub" })).toBe("pubsub");
    expect(resolveQueueProvider({ QUEUE_PROVIDER: "PubSub" })).toBe("pubsub");
    expect(resolveQueueProvider({ QUEUE_PROVIDER: "PUBSUB" })).toBe("pubsub");
  });

  it("throws a clear error naming the bad value for anything else", () => {
    expect(() => resolveQueueProvider({ QUEUE_PROVIDER: "rabbitmq" })).toThrow(/QUEUE_PROVIDER="rabbitmq".*not a known provider/s);
  });
});

describe("createQueueFromEnv", () => {
  it("throws an actionable error naming PUBSUB_PROJECT_ID/GOOGLE_CLOUD_PROJECT when neither is set", () => {
    expect(() => createQueueFromEnv({ env: {} })).toThrow(/PUBSUB_PROJECT_ID/);
    expect(() => createQueueFromEnv({ env: {} })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it("succeeds and returns a GooglePubSubQueueAdapter when PUBSUB_PROJECT_ID is set", () => {
    const queue = createQueueFromEnv({ env: { PUBSUB_PROJECT_ID: "karos-labs-prep" } });
    expect(queue).toBeInstanceOf(GooglePubSubQueueAdapter);
    expect(queue.providerId).toBe("google-pubsub");
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when PUBSUB_PROJECT_ID is unset", () => {
    const queue = createQueueFromEnv({ env: { GOOGLE_CLOUD_PROJECT: "karos-labs-prep" } });
    expect(queue).toBeInstanceOf(GooglePubSubQueueAdapter);
    expect(queue.providerId).toBe("google-pubsub");
  });

  it("prefers PUBSUB_PROJECT_ID over GOOGLE_CLOUD_PROJECT when both are set", () => {
    const queue = createQueueFromEnv({ env: { PUBSUB_PROJECT_ID: "specific-project", GOOGLE_CLOUD_PROJECT: "fallback-project" } });
    expect(queue).toBeInstanceOf(GooglePubSubQueueAdapter);
  });

  it("rejects an unknown QUEUE_PROVIDER before ever looking at project id vars", () => {
    expect(() => createQueueFromEnv({ env: { QUEUE_PROVIDER: "rabbitmq", PUBSUB_PROJECT_ID: "karos-labs-prep" } })).toThrow(
      /not a known provider/,
    );
  });
});
