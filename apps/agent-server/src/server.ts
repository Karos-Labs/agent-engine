import { createModelRouterFromEnv } from "@agent-engine/core";
import { initTelemetry, shutdownTelemetry } from "@agent-engine/telemetry";
import { createApp } from "./app.js";
import { createAgentDefinitionStoreFromEnv } from "./wiring/agent-definitions-store.js";
import { createDurableStoreFromEnv } from "./wiring/durable-store.js";
import { createServerPromptStore } from "./wiring/prompt-store.js";
import { createQueuePushVerifier } from "./wiring/queue-push-auth.js";
import { createServerTools } from "./wiring/tools.js";
import { createRunJobPublisher } from "./wiring/enqueue-run-job.js";
import { createServiceIdentityConfigFromEnv } from "./wiring/auth.js";
import { createServerTemplateStore } from "./wiring/template-store.js";
import { assertFirestoreDatabaseIdOrExit } from "./wiring/firestore-database-id.js";
import { createServerWorkspaceStore } from "./wiring/workspace-store.js";
import { resolveInstagramRepoRoot } from "./wiring/workflows.js";

/** Cloud Run injects `PORT`; 8080 is Cloud Run's own documented default for when it's unset locally. */
function resolvePort(): number {
  const raw = process.env.PORT;
  const parsed = raw ? Number(raw) : 8080;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8080;
}

/** Unset (the default, safe for local dev): the push route accepts any request with a syntactically valid envelope — fine when nothing has configured Pub/Sub to push here yet. Set `PUBSUB_PUSH_AUDIENCE_URL` before pointing a real push subscription at this service (see README's Pub/Sub section). */
function resolveQueuePushConfig(): { queuePushAudienceUrl?: string } {
  const pushAudienceUrl = process.env["PUBSUB_PUSH_AUDIENCE_URL"];
  return pushAudienceUrl ? { queuePushAudienceUrl: pushAudienceUrl } : {};
}

async function main(): Promise<void> {
  // AU60: refuse to start on an unrecognised FIRESTORE_DATABASE_ID. Absent or
  // empty silently resolves to "(default)" — production client data — in all
  // five Firestore clients, so this runs before any store is constructed.
  assertFirestoreDatabaseIdOrExit();

  // No-ops without GOOGLE_CLOUD_PROJECT — see packages/telemetry/src/tracer.ts.
  await initTelemetry();

  const durableStore = createDurableStoreFromEnv();
  const promptStore = createServerPromptStore();
  const router = createModelRouterFromEnv();
  // GCS-backed when GCS_WORKSPACE_BUCKET is set (required for a real, stateless
  // Cloud Run deployment — see wiring/workspace-store.ts); file-backed otherwise. Shared with
  // reputation-agent's own claims/ledgers below, not just the tool registry, so both agree on
  // where tenant state actually lives.
  const workspaceStore = createServerWorkspaceStore();
  const tools = createServerTools(workspaceStore);
  const agentDefinitionStore = createAgentDefinitionStoreFromEnv();

  const app = createApp({
    durableStore,
    runtimeDeps: { tools, promptStore, router, workspaceStore, repoRoot: resolveInstagramRepoRoot(), templateStore: createServerTemplateStore() },
    agentDefinitionStore,
    // AU66: `/runs/start` enqueues rather than executing. `undefined` here means
    // no queue is configurable (local dev), and the route says so specifically
    // rather than falling back to running the job in the request.
    ...(() => {
      const enqueueRunJob = createRunJobPublisher();
      return enqueueRunJob ? { enqueueRunJob } : {};
    })(),
    ...resolveQueuePushConfig(),
    verifyPushIdToken: createQueuePushVerifier(),
    auth: createServiceIdentityConfigFromEnv(),
  });

  const port = resolvePort();
  const server = app.listen(port, () => {
    console.log(`agent-server listening on port ${port}`);
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — draining connections before exit`);

    server.close((err) => {
      if (err) {
        console.error("error while closing server", err);
        process.exitCode = 1;
      }
      // Flush whatever spans BatchSpanProcessor was still buffering — without
      // this, the trace of the request that was in flight when SIGTERM
      // landed (disproportionately the one worth having) is dropped, not
      // just delayed. Best-effort: a stuck exporter must not hold the
      // process open past the 10s grace window below.
      shutdownTelemetry()
        .catch((e: unknown) => console.error("error flushing telemetry on shutdown", e))
        .finally(() => process.exit());
    });

    // Cloud Run gives a limited grace period after SIGTERM before SIGKILL —
    // don't wait indefinitely on a connection that never drains.
    setTimeout(() => {
      console.error("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal error during startup", err);
  process.exit(1);
});
