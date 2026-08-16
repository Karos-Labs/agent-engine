import { createModelRouterFromEnv } from "@agent-engine/core";
import { createAllKarosTools } from "@agent-engine/tools";
import { createApp } from "./app.js";
import { createDurableStoreFromEnv } from "./wiring/durable-store.js";
import { createServerPromptStore } from "./wiring/prompt-store.js";

/** Cloud Run injects `PORT`; 8080 is Cloud Run's own documented default for when it's unset locally. */
function resolvePort(): number {
  const raw = process.env.PORT;
  const parsed = raw ? Number(raw) : 8080;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8080;
}

function main(): void {
  const durableStore = createDurableStoreFromEnv();
  const promptStore = createServerPromptStore();
  const router = createModelRouterFromEnv();
  // No store argument: falls back to `createWorkspaceStore()`'s own
  // `KAROS_WORKSPACE_ROOT`-driven default (see `@agent-engine/tool-common`).
  const tools = createAllKarosTools();

  const app = createApp({ durableStore, runtimeDeps: { tools, promptStore, router } });

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
      process.exit();
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

main();
