import { PubSub } from "@google-cloud/pubsub";
import { DEFAULT_MAX_ACK_EXTENSION_MINUTES, DEFAULT_MAX_CONCURRENT_MESSAGES, GooglePubSubQueueAdapter, type PubSubFlowControlOptions } from "./adapters/google-pubsub-adapter.js";
import type { QueueAdapter } from "./types.js";

export interface CreateQueueFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
}

export type QueueProvider = "pubsub";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** A positive integer from the environment, or the default — a malformed value must never silently become 0 (which would stop the worker consuming entirely). */
function readPositiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = readEnv(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`createQueueFromEnv: ${name}="${raw}" is not a positive integer`);
  }
  return parsed;
}

export function resolvePubSubFlowControl(env: Record<string, string | undefined>): PubSubFlowControlOptions {
  return {
    maxMessages: readPositiveInt(env, "QUEUE_MAX_CONCURRENT_MESSAGES", DEFAULT_MAX_CONCURRENT_MESSAGES),
    maxExtensionMinutes: readPositiveInt(env, "QUEUE_MAX_ACK_EXTENSION_MINUTES", DEFAULT_MAX_ACK_EXTENSION_MINUTES),
  };
}

/**
 * Which queue vendor `createQueueFromEnv` builds. Generic on purpose — this
 * is the one place the rest of the codebase learns which provider is behind
 * `QueueAdapter`, exactly like `MODEL_PROVIDER` is the one place a caller
 * learns which model vendor is behind a step's own adapter. `"pubsub"` is
 * the only implemented value today; adding a second provider means adding a
 * class in `adapters/`, a branch in `createQueueFromEnv` below, and a new
 * accepted value here — never touching a publisher or a consumer.
 */
export function resolveQueueProvider(env: Record<string, string | undefined>): QueueProvider {
  const raw = readEnv(env, "QUEUE_PROVIDER")?.toLowerCase();
  if (raw === undefined || raw === "pubsub") return "pubsub";
  throw new Error(`createQueueFromEnv: QUEUE_PROVIDER="${raw}" is not a known provider — only "pubsub" is implemented today`);
}

/**
 * Builds the Google Cloud Pub/Sub adapter. Authentication is Application
 * Default Credentials only, the same rule every other GCP client in this
 * repo follows (RFC-01 §16.3) — `new PubSub({projectId})` resolves ADC
 * itself; no key file or token is ever read from an env var here. The
 * client is memoized (constructed once, reused for every `publish`/
 * `subscribe` call) since it holds its own gRPC channel pool — building a
 * fresh one per call would be wasteful and would defeat Pub/Sub's own
 * connection reuse.
 */
function createGooglePubSubAdapter(env: Record<string, string | undefined>): GooglePubSubQueueAdapter {
  const projectId = readEnv(env, "PUBSUB_PROJECT_ID", "GOOGLE_CLOUD_PROJECT");
  if (!projectId) {
    throw new Error(
      "createQueueFromEnv: PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is required to build the Pub/Sub queue adapter — " +
        "set it to the GCP project whose Pub/Sub topics/subscriptions this deployment uses",
    );
  }

  let client: PubSub | undefined;
  const resolveClient = (): PubSub => {
    client ??= new PubSub({ projectId });
    return client;
  };

  return new GooglePubSubQueueAdapter({ client: resolveClient, flowControl: resolvePubSubFlowControl(env) });
}

/**
 * Builds a real, working `QueueAdapter` from environment configuration —
 * the queue-vendor counterpart to `createModelRouterFromEnv`
 * (`@agent-engine/core`). Every publisher and consumer in this codebase
 * depends only on the returned `QueueAdapter` interface, never on this
 * function's internals or on `@google-cloud/pubsub` directly.
 */
export function createQueueFromEnv(options: CreateQueueFromEnvOptions = {}): QueueAdapter {
  const env = options.env ?? process.env;
  const provider = resolveQueueProvider(env);

  switch (provider) {
    case "pubsub":
      return createGooglePubSubAdapter(env);
  }
}
