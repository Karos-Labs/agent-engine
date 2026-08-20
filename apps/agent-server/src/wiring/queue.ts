import { createQueueFromEnv, type QueueAdapter } from "@agent-engine/queue";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Builds the `QueueAdapter` this server publishes to / consumes from — see `@agent-engine/queue` for the vendor-agnostic contract and `.env.example` for every provider's env vars. */
export function createServerQueueAdapter(env: Record<string, string | undefined> = process.env): QueueAdapter {
  return createQueueFromEnv({ env });
}

/** The Pub/Sub topic run-job messages are published to. Named generically (not e.g. `PUBSUB_TOPIC_RUN_JOBS`-only) so a future non-Pub/Sub provider reuses the same variable. */
export function runJobsTopicName(env: Record<string, string | undefined> = process.env): string {
  return readEnv(env, "QUEUE_TOPIC_RUN_JOBS") ?? "agent-engine-run-jobs";
}

/** The subscription the pull-based `queue-consumer.ts` (local dev, or a dedicated worker) reads from. The production push route (`routes/queue.ts`) doesn't use this at all — Pub/Sub delivers directly to it over HTTP. */
export function runJobsSubscriptionName(env: Record<string, string | undefined> = process.env): string {
  return readEnv(env, "QUEUE_SUBSCRIPTION_RUN_JOBS") ?? "agent-engine-run-jobs-pull";
}
