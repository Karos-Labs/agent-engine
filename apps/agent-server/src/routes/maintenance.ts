import { Router } from "express";
import { loadClientContentLanguage } from "@agent-engine/core";
import { describeError, logWarning } from "@agent-engine/telemetry";
import { isReclaimableRunning, parseGateDurationMs, RUN_LEASE_TTL_MS, WorkflowConcurrentRunError, WorkflowEngine, type RunRecord } from "@agent-engine/workflow";
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

/**
 * How many times one run may be handed back to a worker while making no
 * progress before the sweep stops feeding it.
 *
 * Three, spread across three scheduler ticks (minutes apart), and only ever
 * counted while the run sits on the SAME step -- a run that has moved is being
 * helped and its count resets. The bar is deliberately low: the case this
 * sweep exists for is a deploy rolling a worker mid-step, which succeeds on
 * the first retry. A run that has killed three workers at one step is not that
 * case, and a fourth will not change it.
 */
const MAX_RECLAIMS_AT_ONE_STEP = 3;
const DEFAULT_MAX_RESUMES = 5;

export interface SweepGateTimeoutsResponse {
  scanned: number;
  due: number;
  resumed: Array<{ runId: string; productId: string; status: string }>;
  skipped: Array<{ runId: string; reason: string }>;
  /** Abandoned `running` runs this tick picked back up — see `sweepAbandonedRuns`. */
  reclaimed?: Array<{ runId: string; productId: string; status: string; abandonedForMs: number }>;
}

/**
 * ORPHANED `running` RUNS, PICKED BACK UP.
 *
 * `WorkflowEngine.run()` has taken over an abandoned run since the lease
 * landed: `claimRun` accepts a `running` record whose heartbeat stopped more
 * than `RUN_LEASE_TTL_MS` ago, logs that it reclaimed it, and carries on from
 * the last checkpoint. It is a complete recovery mechanism with nothing that
 * triggers it — the same shape as the gate timeout above, and for the same
 * reason: nothing in this engine calls `run()` unprompted, and the portal only
 * calls it when a person acts. A run whose worker died is `running` forever,
 * and the portal shows it as in progress forever.
 *
 * Measured in prep on 2026-09-25: SIX instagram runs (thepitchbydeel,
 * geektime, kindlyyours, hankypanky) stuck `running` since 2026-09-24 with no
 * reason recorded — a worker roll, which is the routine event this lease was
 * written to survive. Nothing was ever going to move them.
 *
 * It runs BEFORE the gate pass and shares its resume budget. An abandoned run
 * is strictly the worse state: a gate that has not auto-approved yet is still
 * waiting correctly, while this one is not waiting for anything.
 *
 * The reclaim RULE is not restated here. `isReclaimableRunning` is the engine's
 * own predicate, shared with both stores, so this sweep cannot come to a
 * different answer than the claim it is about to attempt.
 */
async function sweepAbandonedRuns(
  deps: MaintenanceRouterDeps,
  engine: WorkflowEngine,
  clock: () => number,
  scanLimit: number,
  budget: number,
  response: SweepGateTimeoutsResponse,
): Promise<number> {
  if (budget <= 0) return 0;
  let running: RunRecord[];
  try {
    running = await deps.durableStore.listRunsByStatus("running", scanLimit);
  } catch (err) {
    // NEVER fatal to the tick. The gate pass below is the older, load-bearing
    // half of this route, and a failure to list one status must not stop the
    // other from running at all.
    logWarning(`abandoned-run sweep could not list running runs: ${describeError(err)}`);
    return 0;
  }
  const cutoff = clock() - RUN_LEASE_TTL_MS;
  const abandoned = running.filter((run) => isReclaimableRunning(run, cutoff));
  if (abandoned.length === 0) return 0;

  const reclaimed: NonNullable<SweepGateTimeoutsResponse["reclaimed"]> = [];
  let used = 0;
  for (const run of abandoned) {
    // ── A RUN THAT KILLS THE WORKER IT IS GIVEN ──
    //
    // Reclaiming is right for the case this sweep was written for: a deploy
    // rolls the worker mid-step and the run resumes from its last checkpoint.
    // It is wrong for a run that takes its new worker down too -- that one
    // gets a fresh worker every tick, kills it, and occupies a resume slot
    // another run needed. Seen within the hour this sweep shipped:
    // `pubsub-20296536359058757` (instagram, hankypanky) was reclaimed, ran,
    // and lost its heartbeat again on the same `00h3-persist-exemplar-library`.
    //
    // Counted only while the run sits on the SAME step. A run that has moved
    // is being helped, and its count starts over.
    const sameStep = run.reclaimedFromStepId != null && run.reclaimedFromStepId === (run.currentStepId ?? null);
    const attempt = sameStep ? (run.reclaimAttempts ?? 0) + 1 : 1;
    if (attempt > MAX_RECLAIMS_AT_ONE_STEP) {
      // FAILED, not left `running`. Leaving it is the exact defect this sweep
      // closed -- a run nobody will ever move, shown as in progress forever.
      // `failed` is terminal, visible, carries the reason, and a person can
      // re-dispatch it; the sweep never touches it again.
      const detail =
        `abandoned ${attempt - 1} times at step "${run.currentStepId ?? "unknown"}" without moving past it — ` +
        `this run takes down the worker it is given, so the sweep stopped handing it one`;
      logWarning(`abandoned-run sweep: giving up on run ${run.runId} — ${detail}`, {
        event: "run.sweep.gave_up",
        runId: run.runId,
        productId: run.productId,
        stepId: run.currentStepId ?? null,
        attempts: attempt - 1,
      });
      await deps.durableStore.updateRun(run.runId, { status: "failed", failureReason: detail, updatedAt: clock() });
      response.skipped.push({ runId: run.runId, reason: detail });
      continue;
    }
    if (used >= budget) {
      response.skipped.push({ runId: run.runId, reason: "abandoned, but this tick's resume budget is spent; next tick" });
      continue;
    }
    used += 1;
    const abandonedForMs = clock() - run.updatedAt;
    logWarning(`abandoned-run sweep: run ${run.runId} has been "running" with no heartbeat for ${Math.round(abandonedForMs / 1000)}s — picking it back up`, {
      event: "run.sweep.abandoned",
      runId: run.runId,
      productId: run.productId,
      abandonedForMs,
    });
    // Recorded BEFORE the resume, not after: a resume that takes the worker
    // down never reaches an "after". Writing it first is the only way the
    // next tick can know this attempt happened at all.
    await deps.durableStore.updateRun(run.runId, { reclaimedFromStepId: run.currentStepId ?? null, reclaimAttempts: attempt });
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
      reclaimed.push({ runId: run.runId, productId: run.productId, status: result.status, abandonedForMs });
    } catch (err) {
      // A live worker that heartbeat between our read and our claim wins, and
      // that is the lease working: we stand down rather than double-execute.
      const reason = err instanceof WorkflowConcurrentRunError ? "claimed by another caller" : describeError(err);
      logWarning(`abandoned-run sweep could not resume run ${run.runId}: ${reason}`);
      response.skipped.push({ runId: run.runId, reason });
    }
  }
  if (reclaimed.length > 0) response.reclaimed = reclaimed;
  return used;
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

    // ── the abandoned-run pass, FIRST ──
    //
    // Deliberately on this route rather than behind a new one. The scheduler
    // job that calls it already exists in both environments, and ten of this
    // fleet's fourteen cron routes have no scheduler pointing at them — an
    // eleventh unwired route would fix nothing on any real deployment.
    // Widening a sweep we already run costs no infrastructure and starts
    // working the moment this deploys.
    const spent = await sweepAbandonedRuns(deps, engine, clock, scanLimit, maxResumes, response);

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
      if (response.resumed.length + spent >= maxResumes) {
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
