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
  /** How many `awaiting_gate` runs one sweep READS, defaulting to `SWEEP_SCAN_LIMIT`. Injectable so the truncation warning can be driven by a test rather than only described. */
  scanLimit?: number;
}

/**
 * How many `awaiting_gate` runs one sweep reads.
 *
 * Raised from 200 on 2026-09-22, and the truncation made loud, because the
 * bound is not the benign one its old comment claimed. `listRunsByStatus`
 * applies Firestore's `.limit()` BEFORE it sorts the results by `updatedAt`
 * — the sort is in memory, over whatever slice the query returned — so a
 * backlog past the limit is not "the oldest N", it is an arbitrary N ordered
 * by document id. The runs left out are left out of every subsequent sweep
 * too, for as long as the backlog holds: a run parked at a gate would never
 * auto-approve, and nothing anywhere would say so.
 *
 * Measured 2026-09-22: 39 runs in prep, 3 in production. So this is a latent
 * defect, not an active one, and the proportionate fix is headroom plus a
 * warning that fires the moment the headroom runs out — not a composite
 * index for a query that has never yet needed one.
 */
const SWEEP_SCAN_LIMIT = 1_000;
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
  const scanLimit = deps.scanLimit ?? SWEEP_SCAN_LIMIT;

  router.post("/api/v1/maintenance/sweep-gate-timeouts", async (_req, res) => {
    const store = deps.durableStore;
    const response: SweepGateTimeoutsResponse = { scanned: 0, due: 0, resumed: [], skipped: [] };
    let waiting: RunRecord[];
    try {
      waiting = await store.listRunsByStatus("awaiting_gate", scanLimit);
    } catch (err) {
      logWarning(`gate-timeout sweep could not list waiting runs: ${describeError(err)}`);
      res.status(500).json({ error: "could not list runs awaiting a gate" });
      return;
    }
    response.scanned = waiting.length;
    if (waiting.length >= scanLimit) {
      // A full page means the read was cut off, and Firestore cut it off
      // before the ordering was applied — so the runs missing from this
      // sweep are missing from every sweep, not merely deferred to the next
      // one. The fix when this fires is a composite index on
      // (status, updatedAt) so the query can `orderBy` and take the OLDEST.
      logWarning(`gate-timeout sweep read a FULL page of ${scanLimit} runs awaiting a gate — older runs beyond it are invisible to this and every later sweep`, {
        event: "gate.sweep.truncated",
        scanned: waiting.length,
        limit: scanLimit,
        remedy: "create a composite index on agentEngineRuns(status, updatedAt) and order the query by updatedAt",
      });
    }

    for (const run of waiting) {
      const gateId = run.pendingGateId;
      if (gateId == null) continue;
      const gate = await store.getGate(gateId);
      if (!gate) continue;

      // A WEDGED run (2026-09-22): parked at a gate that already carries a
      // decision. Something recorded the decision and the run never moved —
      // a `/resume` whose continuation died after writing the response, or
      // the read/write race `runUntilParkedOrDone` now closes. This loop used
      // to `continue` past exactly these ("gate has a response, nothing to
      // time out"), which made the state permanent: nothing else in the
      // system calls `run()` unprompted. The decision is on record; applying
      // it is all that is missing, and it is due NOW, whatever the timeout says.
      const wedged = gate.response !== undefined;
      if (!wedged) {
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
      } else {
        logWarning(`gate-timeout sweep: run ${run.runId} is parked at gate ${gateId} which already carries a decision ("${gate.response!.decision}" by ${gate.response!.actor} at ${gate.response!.at}) — applying it`, {
          event: "gate.sweep.wedged_run",
          runId: run.runId,
          gateId,
          decision: gate.response!.decision,
        });
      }

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
