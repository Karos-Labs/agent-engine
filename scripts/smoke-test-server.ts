/**
 * End-to-end smoke test for apps/agent-server (Phase 6): proves the whole
 * HTTP surface — health check, run start, human-gate resume, status polling
 * — works together against a real (in-process, ephemeral-port) HTTP server,
 * using the same in-memory/fixture dependencies apps/agent-server/__tests__
 * already relies on (no real GCP or Anthropic call — the router is scripted).
 *
 * Run with:
 *   npx tsx scripts/smoke-test-server.ts
 */
import type { AddressInfo } from "node:net";
import { createApp } from "../apps/agent-server/src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "../apps/agent-server/__tests__/test-helpers.js";
import { startRunJob } from "../apps/agent-server/src/run-job.js";
import { randomUUID } from "node:crypto";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function section(title: string): void {
  console.log();
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
}

function sub(title: string): void {
  console.log();
  console.log(`${BOLD}${title}${RESET}`);
  console.log(`${DIM}${"-".repeat(70)}${RESET}`);
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function narrate(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

interface HealthResponse {
  status: string;
}

interface RunResponse {
  runId: string;
  status: string;
  pendingGateId?: string;
  report?: { domainOutcome: string; steps: Array<{ stepId: string; status: string }> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  section("AGENT-SERVER SMOKE TEST");
  narrate("Starting an in-process createApp() instance with fixture dependencies (WorkspaceStore in a temp dir, MemoryDurableStepStore, smartFakeRouter)...");

  const env: TestEnvironment = await setupTestEnvironment();
  // AU66 / SCRUM-364: `/runs/start` ENQUEUES now; it does not execute.
  //
  // This smoke test never actually needed the ROUTE to be synchronous — it
  // needed a run to happen on a machine with no Pub/Sub. So it supplies its own
  // implementation of "enqueue", which runs the job in-process. The route's
  // contract is identical either way: hand it off, return 202.
  //
  // Keeping the route synchronous for this script's benefit would have been the
  // tail wagging the dog, and would have preserved the trap for everyone else.
  const app = createApp({
    durableStore: env.durableStore,
    runtimeDeps: env.runtimeDeps,
    enqueueRunJob: async (request) => {
      const runId = `smoke-${randomUUID()}`;
      await startRunJob(request, runId, { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps });
      return { runId };
    },
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  ok(`server listening on ${baseUrl}`);

  try {
    // ── 1. GET /healthz ──
    sub("[1/4] GET /healthz");
    const healthRes = await fetch(`${baseUrl}/healthz`);
    const healthBody = (await healthRes.json()) as HealthResponse;
    if (healthRes.status !== 200 || healthBody.status !== "ok") {
      throw new Error(`expected 200 {status:"ok"}, got ${healthRes.status} ${JSON.stringify(healthBody)}`);
    }
    ok(`200 ${JSON.stringify(healthBody)}`);

    // ── 2. POST /api/v1/runs/start (campaign orchestrator) ──
    sub("[2/4] POST /api/v1/runs/start — productId: campaign-orchestrator");
    const startRes = await fetch(`${baseUrl}/api/v1/runs/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" }),
    });
    const startBody = (await startRes.json()) as RunResponse;
    // 202 + queued: the route hands off and returns. Nothing is created yet
    // beyond the handoff, so the run's real state is read from /status.
    if (startRes.status !== 202 || startBody.status !== "queued") {
      throw new Error(`expected 202 "queued", got ${startRes.status} ${JSON.stringify(startBody)}`);
    }
    const { runId } = startBody;
    ok(`202 runId="${runId}" status="queued"`);

    sub("[2b/4] GET /api/v1/runs/:runId/status — the enqueued run reached its gate");
    const queuedStatusRes = await fetch(`${baseUrl}/api/v1/runs/${runId}/status`);
    const queuedStatus = (await queuedStatusRes.json()) as RunResponse;
    if (queuedStatusRes.status !== 200 || queuedStatus.status !== "awaiting_gate") {
      throw new Error(`expected 200 "awaiting_gate", got ${queuedStatusRes.status} ${JSON.stringify(queuedStatus)}`);
    }
    const pendingGateId = queuedStatus.pendingGateId;
    ok(`200 status="awaiting_gate" pendingGateId="${pendingGateId}"`);

    // ── 3. POST /api/v1/runs/:runId/resume — approve the campaign review gate ──
    sub("[3/4] POST /api/v1/runs/:runId/resume — approve");
    const resumeRes = await fetch(`${baseUrl}/api/v1/runs/${runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gateId: "13-campaign-review",
        resolution: { decision: "approve", actor: "smoke-test@karoslabs.com" },
      }),
    });
    const resumeBody = (await resumeRes.json()) as RunResponse;
    if (resumeRes.status !== 200) {
      throw new Error(`expected 200 from resume, got ${resumeRes.status} ${JSON.stringify(resumeBody)}`);
    }
    ok(`200 status="${resumeBody.status}"`);

    // ── 4. GET /api/v1/runs/:runId/status — poll until completed ──
    sub("[4/4] GET /api/v1/runs/:runId/status — poll until completed");
    const maxAttempts = 20;
    let statusBody: RunResponse = resumeBody;
    let attempt = 0;
    while (statusBody.status !== "completed" && attempt < maxAttempts) {
      attempt += 1;
      await sleep(250);
      const pollRes = await fetch(`${baseUrl}/api/v1/runs/${runId}/status`);
      statusBody = (await pollRes.json()) as RunResponse;
      narrate(`poll ${attempt}: status="${statusBody.status}"`);
    }
    if (statusBody.status !== "completed" || !statusBody.report) {
      throw new Error(`run never reached "completed" after ${maxAttempts} polls — last status: "${statusBody.status}"`);
    }
    const { report } = statusBody;
    if (report.domainOutcome !== "delivered") {
      throw new Error(`expected domainOutcome "delivered", got "${report.domainOutcome}"`);
    }
    const slotSteps = report.steps.filter((s) => s.stepId.startsWith("channel-fanout__slot_"));
    ok(`completed — domainOutcome="${report.domainOutcome}", ${report.steps.length} steps, ${slotSteps.length} channel fan-out slots`);

    section("FINAL DynamicAgentRunReport");
    console.log(JSON.stringify(report, null, 2));

    section("SMOKE TEST PASSED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.cleanup();
  }
}

main().catch((err) => {
  console.error();
  console.error(`${RED}${BOLD}SMOKE TEST FAILED${RESET}`);
  console.error(err);
  process.exitCode = 1;
});
