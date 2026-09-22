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
import { RetryLater } from "@agent-engine/queue";
import { initTelemetry, logError, shutdownTelemetry } from "@agent-engine/telemetry";
import { RUN_LEASE_TTL_MS } from "@agent-engine/workflow";
import { RunJobRequestSchema, startRunJob } from "./run-job.js";
import { createAgentDefinitionStoreFromEnv } from "./wiring/agent-definitions-store.js";
import { createDurableStoreFromEnv } from "./wiring/durable-store.js";
import { createServerPromptStore } from "./wiring/prompt-store.js";
import { createServerQueueAdapter, runJobsSubscriptionName } from "./wiring/queue.js";
import { createServerTools } from "./wiring/tools.js";
import { createServerTemplateStore } from "./wiring/template-store.js";
import { assertFirestoreDatabaseIdOrExit } from "./wiring/firestore-database-id.js";
import { createServerWorkspaceStore } from "./wiring/workspace-store.js";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstagramRepoRoot } from "./wiring/workflows.js";

/**
 * Wait for the handlers that are still running, and report the ones that were
 * not finished when the grace ran out.
 *
 * Exported so the behaviour can be asserted rather than described: the whole
 * point of this function is what it does at the two edges — resolving as soon
 * as the last handler settles, and naming the stragglers when it cannot — and
 * both of those are invisible from inside `main`.
 *
 * Takes the live map, not a snapshot: a handler that clears itself while we
 * wait should shorten the wait, and a straggler must be reported under the
 * runId it still holds.
 */
export async function drainInFlight(
  inFlight: Map<string, Promise<void>>,
  graceMs: number,
): Promise<string[]> {
  if (inFlight.size === 0) return [];
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), graceMs);
  });
  try {
    const settled = Promise.allSettled([...inFlight.values()]).then(() => "settled" as const);
    const winner = await Promise.race([settled, expired]);
    return winner === "settled" ? [] : [...inFlight.keys()];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // AU60: refuse to start on an unrecognised FIRESTORE_DATABASE_ID. Absent or
  // empty silently resolves to "(default)" — production client data — in all
  // five Firestore clients, so this runs before any store is constructed.
  assertFirestoreDatabaseIdOrExit();

  // THE PROCESS THAT RUNS EVERY AGENT HAD NO TELEMETRY AT ALL (2026-09-22).
  //
  // `initTelemetry()` was called in `server.ts` and only there. Both deployed
  // workers — `agent-engine-prep-worker` and `agent-engine-prod-worker` —
  // run THIS file (`node apps/agent-server/dist/queue-consumer.js`), and the
  // HTTP server only serves the API. So no `TracerProvider` and no
  // `MeterProvider` were ever registered in the process that actually executes
  // runs: every `workflow.run` / `workflow.step.*` / `tool.call.*` /
  // `model.call.*` span from AU42/SCRUM-326 was created against the OTel
  // API's no-op tracer and discarded, and every counter with it.
  //
  // Measured, not inferred: Cloud Monitoring held ZERO metric descriptors
  // matching `workload.googleapis.com/agent_engine*` in either project. Which
  // is also why an alert policy on "runs ending degraded" could not be built
  // — the metric it would read does not exist.
  //
  // No-ops without GOOGLE_CLOUD_PROJECT — see packages/telemetry/src/tracer.ts.
  await initTelemetry();

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

  /**
   * THE HANDLERS THAT ARE RUNNING RIGHT NOW, so shutdown can wait for them and
   * — more importantly — SAY WHAT IT CUT.
   *
   * A worker roll used to `process.exit()` the instant the subscription closed,
   * without waiting for anything. What that produced in prep was nine runs
   * frozen with a step still marked `running`, no `failureReason` and no
   * `reason` at all: a run the client sees as failed with a blank error, and an
   * operator has nothing to read. Recovery itself was never the problem — the
   * lease lapses, `RetryLater` holds the message for one lease period, and the
   * redelivery replays from checkpoints — but a silent kill is indistinguishable
   * from a bug until someone reads Pub/Sub.
   *
   * Keyed by runId so the log names the runs, not a count.
   */
  const inFlight = new Map<string, Promise<void>>();

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
    // so this can never double-run a job. A CONTINUATION (`/resume` handing a
    // gate decision's remaining work to this worker — see
    // `RunJobRequestSchema.runId`) names the existing run instead.
    const runId = parsed.data.runId ?? `pubsub-${message.id}`;
    // Registered BEFORE the await and cleared in `finally`, so the window in
    // which a run is executing is exactly the window in which shutdown can see
    // it. The tracked promise deliberately swallows — it exists to be awaited
    // by `shutdown`, and the real outcome is handled below by this handler.
    const started = startRunJob(parsed.data, runId, { durableStore, runtimeDeps, agentDefinitionStore });
    inFlight.set(runId, started.then(() => undefined, () => undefined));
    let outcome;
    try {
      outcome = await started;
    } finally {
      inFlight.delete(runId);
    }

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
    if (outcome.outcome === "conflict") {
      // Hold the message for one lease period, THEN let it redeliver. Acking
      // here is what stranded two runs on 2026-09-03: a deploy killed the
      // worker mid-run, Pub/Sub redelivered 22 seconds later, the run's lease
      // had not yet lapsed so the claim was refused — and acking threw away
      // the only message that could ever have resumed it. A bare NACK (the
      // 2026-09-03 fix) stranded prep run pubsub-21157277198365907 on
      // 2026-09-10 the other way round: five redeliveries ten seconds apart
      // all met the same live-looking lease and the message dead-lettered
      // 90 seconds after the deploy, four minutes before the lease would have
      // lapsed. `RetryLater` spends one delivery attempt per lease period.
      //
      // Redelivery then converges either way. If a live execution really does
      // own the run, it finishes and the status becomes terminal, at which
      // point the next delivery claims it and replays from checkpoints — a
      // cheap no-op, since every completed step short-circuits (RFC-01 §8.1).
      // If the owner is dead, the lease has lapsed by the time the message
      // comes back and the redelivery resumes the run properly.
      logError("queue-consumer: run could not be claimed, holding the message for one lease period before redelivery", undefined, {
        messageId: message.id,
        runId: outcome.runId,
        clientSlug: parsed.data.clientSlug,
        productId: parsed.data.productId,
        reason: outcome.message,
        retryInMs: RUN_LEASE_TTL_MS + 15_000,
      });
      throw new RetryLater(RUN_LEASE_TTL_MS + 15_000, `run "${outcome.runId}" is already claimed; redelivering after its lease can lapse: ${outcome.message}`);
    }
    console.log(`queue-consumer: run "${outcome.runId}" -> ${outcome.status}`);
  });

  /**
   * HOW LONG SHUTDOWN WAITS FOR RUNNING HANDLERS.
   *
   * Cloud Run sends SIGTERM and then SIGKILLs the container about ten seconds
   * later, and for a *service* that window is not configurable — `gcloud run
   * deploy` has no termination-grace flag — so this cannot be raised into
   * something that would let a ten-minute agent step finish. It is not meant
   * to: a step that long is recovered by the lease + `RetryLater` + checkpoint
   * replay path, which already works.
   *
   * What the wait buys is the short tail — a handler in its final Firestore
   * write, or one that has just resolved and is about to clear itself — which
   * is the difference between a clean terminal status and a run frozen at
   * `running` with no reason on it. Nine prep runs ended that way.
   *
   * Overridable for the local `dev:queue-consumer` process, where there is no
   * external killer and finishing the message you are on is simply nicer.
   */
  const DRAIN_GRACE_MS = Number(process.env["QUEUE_DRAIN_GRACE_MS"] ?? 8_000);

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    const draining = [...inFlight.keys()];
    console.log(
      `${signal} received — stopping the pull subscription` +
        (draining.length ? `; draining ${draining.length} in-flight run(s) for up to ${DRAIN_GRACE_MS}ms: ${draining.join(", ")}` : ""),
    );

    void subscription
      .stop()
      .catch((err: unknown) => logError("queue-consumer: error while stopping the pull subscription", err))
      // Stopping delivery FIRST means nothing new joins the set while we wait.
      .then(() => drainInFlight(inFlight, DRAIN_GRACE_MS))
      .then((stillRunning) => {
        if (stillRunning.length) {
          // THE LINE THAT WAS MISSING. A run cut here does come back by
          // redelivery once its lease lapses, but until now nothing anywhere
          // said it had been cut — so the step frozen at `running` read as an
          // unexplained failure to everyone downstream, including the client.
          logError(
            "queue-consumer: shutdown grace expired with runs still executing; they resume on redelivery once their lease lapses",
            undefined,
            { signal, graceMs: DRAIN_GRACE_MS, runIds: stillRunning },
          );
        } else {
          console.log(`queue-consumer: drained cleanly after ${signal}`);
        }
        // `BatchSpanProcessor` buffers for ~5s: without this, the spans of
        // whatever the worker was doing when it was told to stop —
        // disproportionately the ones worth having — die in the buffer.
        return shutdownTelemetry();
      })
      .catch((err: unknown) => {
        logError("queue-consumer: error while draining in-flight runs", err);
      })
      .finally(() => {
        process.exit();
      });
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * ONLY BOOT WHEN THIS FILE IS THE ENTRY POINT.
 *
 * `main()` used to run on import, which is fine for the two things that run
 * this module (`dev:queue-consumer` and the worker's `CMD`) and fatal for
 * anything that wants to read a function out of it: importing the module
 * connected to Pub/Sub, failed on the missing credentials and called
 * `process.exit(1)` — so `drainInFlight`, the one piece of shutdown behaviour
 * worth asserting, could not be tested at all. Both real entry points invoke
 * the file directly, so both still match.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    logError("queue-consumer: fatal error during startup", err);
    process.exit(1);
  });
}
