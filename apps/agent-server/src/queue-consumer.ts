/**
 * A long-running pull-based consumer for run-job messages — the
 * alternative to `routes/queue.ts`'s push endpoint. Two real uses:
 *
 *   1. Local development: testing "publish a message, watch a job run"
 *      without a public HTTPS URL for Pub/Sub to push to (impossible to get
 *      locally without a tunnel). `npm run dev:queue-consumer` (from
 *      `apps/agent-server`, or `--workspace=@agent-engine/agent-server`
 *      from the repo root) plus `npm run demo:queue-publish` (repo root)
 *      to send it one message.
 *   2. A dedicated pull-based worker in production, if push (the default —
 *      see README) isn't wanted: run this as its own always-on process
 *      (e.g. a second Cloud Run service with `--no-cpu-throttling` or
 *      `--min-instances=1`, since a persistent pull connection needs the
 *      process kept alive between messages) instead of configuring a push
 *      subscription at all.
 *
 * Builds the exact same runtime dependencies `server.ts` does — this is a
 * second entry point into the same run-starting logic (`run-job.ts`), not a
 * different code path.
 */
import { createModelRouterFromEnv } from "@agent-engine/core";
import { createAllKarosTools } from "@agent-engine/tools";
import { RunJobRequestSchema, startRunJob } from "./run-job.js";
import { createDurableStoreFromEnv } from "./wiring/durable-store.js";
import { createServerPromptStore } from "./wiring/prompt-store.js";
import { createServerQueueAdapter, runJobsSubscriptionName } from "./wiring/queue.js";
import { createServerWorkspaceStore } from "./wiring/workspace-store.js";

async function main(): Promise<void> {
  const durableStore = createDurableStoreFromEnv();
  const promptStore = createServerPromptStore();
  const router = createModelRouterFromEnv();
  const tools = createAllKarosTools(createServerWorkspaceStore());
  const runtimeDeps = { tools, promptStore, router };

  const queue = createServerQueueAdapter();
  const subscriptionName = runJobsSubscriptionName();

  console.log(`queue-consumer: pull-subscribing to "${subscriptionName}" (provider: ${queue.providerId})`);

  const subscription = queue.subscribe(subscriptionName, async (message) => {
    const parsed = RunJobRequestSchema.safeParse(message.payload);
    if (!parsed.success) {
      console.error(`queue-consumer: message ${message.id} failed run-job validation`, parsed.error.issues);
      // Throwing here is what makes the adapter NACK — a permanently-invalid
      // message can't self-heal on retry, but the subscription's own
      // max-delivery-attempts + dead-letter-topic config (.env.example) is
      // what decides how long it keeps trying, not this handler.
      throw new Error("invalid run-job payload");
    }

    // Same deterministic-runId reasoning as the push route (routes/queue.ts):
    // a redelivery of the same unacked message reuses the same message id,
    // so this can never double-run a job.
    const runId = `pubsub-${message.id}`;
    const outcome = await startRunJob(parsed.data, runId, { durableStore, runtimeDeps });

    if (outcome.outcome === "error") {
      throw new Error(outcome.message); // NACK -> Pub/Sub redelivers per the subscription's backoff policy.
    }
    console.log(`queue-consumer: run "${outcome.runId}" -> ${outcome.outcome === "started" ? outcome.status : "already-running"}`);
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — stopping the pull subscription`);
    subscription
      .stop()
      .catch((err: unknown) => console.error("error while stopping the pull subscription", err))
      .finally(() => process.exit());
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal error during queue-consumer startup", err);
  process.exit(1);
});
