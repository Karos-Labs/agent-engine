import { Router } from "express";
import { loadClientContentLanguage } from "@agent-engine/core";
import { describeError, logWarning } from "@agent-engine/telemetry";
import { parseGateDurationMs, WorkflowConcurrentRunError, WorkflowEngine, type RunRecord } from "@agent-engine/workflow";
import { resolveWorkflowFn } from "../wiring/dynamic-workflows.js";
import type { RunsRouterDeps } from "./runs.js";

export interface MaintenanceRouterDeps extends RunsRouterDeps {
  /** Injectable clock (epoch ms) — the sweep's notion of "now" AND the engine's, so a test can age a gate without sleeping. */
  clock?: () => number;
  /** How many due runs one sweep resumes before answering. Each resume runs the rest of that workflow inline. */
  maxResumesPerSweep?: number;
}

/** How many `awaiting_gate` runs one sweep reads. Far above any real backlog; a bound, not a budget. */
const SWEEP_SCAN_LIMIT = 200;
const DEFAULT_MAX_RESUMES = 5;

export interface SweepGateTimeoutsResponse {
  scanned: number;
  due: number;
  resumed: Array<{ runId: string; productId: string; status: string }>;
  skipped: Array<{ runId: string; reason: string }>;
}

/**
 * `POST /api/v1/maintenance/sweep-gate-timeouts` — makes "approve itself
 * after an hour" actually happen on time.
 *
 * `runStepGate` resolves an `auto_approve` timeout LAZILY: the next call
 * into `run()` after the window has elapsed synthesizes the approval and the
 * workflow continues. Nothing in this engine calls `run()` on its own — a
 * resume request from the portal does, and the portal only issues one when a
 * person acts. So a review nobody answered stayed `awaiting_gate` for as long
 * as nobody opened it, whatever the timeout said (prep has no scheduler at
 * all; production's schedulers all target the portal). Product rule
 * 2026-09-08: a client who starts an agent and hears nothing back gets the
 * deliverable approved within the hour. This route is what a Cloud Scheduler
 * job calls every few minutes to enforce it.
 *
 * It is deliberately thin: it finds runs at a gate whose `auto_approve`
 * window has elapsed and calls `run()` on them — exactly what `/resume` does
 * after a human decision, minus the decision. The approval itself is still
 * made by `runStepGate`, recorded under `system:gate-timeout`, so the audit
 * trail is the same whether the sweep or a late page view got there first.
 * A `hold`/`escalate` gate is never touched.
 *
 * Cross-tenant by nature, so it is mounted BEHIND the service-identity
 * middleware (a Cloud Scheduler OIDC token from an allow-listed service
 * account) and IN FRONT of the tenant-assertion middleware, which would
 * otherwise demand a single client's assertion for a request that belongs
 * to no client.
 *
 * Each resume runs the remainder of its workflow inline (an approved TikTok
 * clip uploads and records itself; an approved landing page publishes), so
 * one sweep caps how many it resumes and reports the rest as due; the next
 * tick takes them.
 */
export function createMaintenanceRouter(deps: MaintenanceRouterDeps): Router {
  const router = Router();
  const clock = deps.clock ?? Date.now;
  const engine = new WorkflowEngine(deps.durableStore, clock);
  const maxResumes = deps.maxResumesPerSweep ?? DEFAULT_MAX_RESUMES;

  router.post("/api/v1/maintenance/sweep-gate-timeouts", async (_req, res) => {
    const store = deps.durableStore;
    const response: SweepGateTimeoutsResponse = { scanned: 0, due: 0, resumed: [], skipped: [] };
    let waiting: RunRecord[];
    try {
      waiting = await store.listRunsByStatus("awaiting_gate", SWEEP_SCAN_LIMIT);
    } catch (err) {
      logWarning(`gate-timeout sweep could not list waiting runs: ${describeError(err)}`);
      res.status(500).json({ error: "could not list runs awaiting a gate" });
      return;
    }
    response.scanned = waiting.length;

    for (const run of waiting) {
      const gateId = run.pendingGateId;
      if (gateId == null) continue;
      const gate = await store.getGate(gateId);
      if (!gate || gate.response !== undefined) continue;
      if (gate.timeout?.onTimeout !== "auto_approve") continue;
      const durationMs = parseGateDurationMs(gate.timeout.duration);
      if (durationMs === undefined) continue;

      // The gate step's own `startedAt` is when the gate opened (preserved
      // across replays — see `gateStepStartedAt`); the run's `updatedAt` is
      // the fallback for a record from before gates checkpointed themselves.
      const localId = gateId.startsWith(`${run.runId}__`) ? gateId.slice(run.runId.length + 2) : gateId;
      const stepId = gate.slotId !== undefined ? `${gate.slotId}::${localId}` : localId;
      const gateStep = await store.getStep(run.runId, stepId);
      const openedAt = gateStep?.startedAt ?? run.updatedAt;
      if (clock() - openedAt < durationMs) continue;

      response.due += 1;
      if (response.resumed.length >= maxResumes) {
        response.skipped.push({ runId: run.runId, reason: `sweep already resumed ${maxResumes} runs; next tick` });
        continue;
      }

      try {
        const workflowFn = await resolveWorkflowFn(run.productId, deps.runtimeDeps, deps.agentDefinitionStore);
        const contentLanguage = await loadClientContentLanguage(deps.runtimeDeps.workspaceStore, run.clientSlug);
        const result = await engine.run(workflowFn, {
          runId: run.runId,
          clientSlug: run.clientSlug,
          productId: run.productId,
          runKind: run.runKind,
          ...(contentLanguage !== undefined ? { contentLanguage } : {}),
        });
        response.resumed.push({ runId: run.runId, productId: run.productId, status: result.status });
      } catch (err) {
        const reason = err instanceof WorkflowConcurrentRunError ? "claimed by another caller" : describeError(err);
        logWarning(`gate-timeout sweep could not resume run ${run.runId}: ${reason}`);
        response.skipped.push({ runId: run.runId, reason });
      }
    }

    res.status(200).json(response);
  });

  return router;
}
