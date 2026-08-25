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
import { logError } from "@agent-engine/telemetry";
import { RunJobRequestSchema, startRunJob } from "./run-job.js";
import { createAgentDefinitionStoreFromEnv } from "./wiring/agent-definitions-store.js";
import { createDurableStoreFromEnv } from "./wiring/durable-store.js";
import { createServerPromptStore } from "./wiring/prompt-store.js";
import { createServerQueueAdapter, runJobsSubscriptionName } from "./wiring/queue.js";
import { createServerTools } from "./wiring/tools.js";
import { createServerTemplateStore } from "./wiring/template-store.js";
import { createServerWorkspaceStore } from "./wiring/workspace-store.js";
import { createServer } from "node:http";
import { resolveInstagramRepoRoot } from "./wiring/workflows.js";

async function main(): Promise<void> {
  // This is a queue consumer, not an HTTP server, but Cloud Run *services*
  // (unlike Jobs) require the container to listen on $PORT to pass the
  // startup/liveness probe — without this, `gcloud run deploy` times out
  // waiting for a port that never opens. Mirrors karosCMO/agent-service's
  // own worker-main.ts, which hits the exact same requirement.
  const port = Number(process.env["PORT"] ?? 8080);
  createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, role: "worker" }));
  }).listen(port, () => console.log(`queue-consumer: health server listening on :${port}`));

  const durableStore = createDurableStoreFromEnv();
  const promptStore = createServerPromptStore();
  const router = createModelRouterFromEnv();
  const workspaceStore = createServerWorkspaceStore();
  const tools = createServerTools(workspaceStore);
  const runtimeDeps = { tools, promptStore, router, workspaceStore, repoRoot: resolveInstagramRepoRoot(), templateStore: createServerTemplateStore() };
  const agentDefinitionStore = createAgentDefinitionStoreFromEnv();

  const queue = createServerQueueAdapter();
  const subscriptionName = runJobsSubscriptionName();

  console.log(`queue-consumer: pull-subscribing to "${subscriptionName}" (provider: ${queue.providerId})`);

  const subscription = queue.subscribe(subscriptionName, async (message) => {
    const parsed = RunJobRequestSchema.safeParse(message.payload);
    if (!parsed.success) {
      logError("queue-consumer: message failed run-job validation", undefined, { messageId: message.id, issues: parsed.error.issues });
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
    const outcome = await startRunJob(parsed.data, runId, { durableStore, runtimeDeps, agentDefinitionStore });

    if (outcome.outcome === "error" || outcome.outcome === "not_found") {
      // "not_found" (Task 2: productId named neither a fixed product nor a registered
      // dynamic agent) is just as permanent as a schema-validation failure above — same
      // NACK-and-let-the-subscription's-own-DLQ-policy-decide handling, not a special case.
      logError("queue-consumer: run job failed to start", undefined, {
        messageId: message.id,
        outcome: outcome.outcome,
        clientSlug: parsed.data.clientSlug,
        productId: parsed.data.productId,
        reason: outcome.message,
      });
      throw new Error(outcome.message);
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
      .catch((err: unknown) => logError("queue-consumer: error while stopping the pull subscription", err))
      .finally(() => process.exit());
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logError("queue-consumer: fatal error during startup", err);
  process.exit(1);
});
