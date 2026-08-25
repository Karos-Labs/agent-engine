import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { GateResponseSchema, type AgentDefinitionStore } from "@agent-engine/core";
import { GateAlreadyResolvedError, WorkflowConcurrentRunError, WorkflowEngine, type DurableStepStore } from "@agent-engine/workflow";
import { buildRunReport } from "../report.js";
import { RunJobRequestSchema, startRunJob } from "../run-job.js";
import { buildWorkflowForProduct, isKnownProductId, type AgentRuntimeDeps, type ProductId } from "../wiring/workflows.js";

export interface RunsRouterDeps {
  durableStore: DurableStepStore;
  runtimeDeps: AgentRuntimeDeps;
  /** Looked up by `startRunJob` (via `resolveWorkflowFn`) when `/runs/start`'s `productId` isn't one of the 12 fixed products (Task 2's dynamic agents). Omit only if this deployment never dispatches one over HTTP. */
  agentDefinitionStore?: AgentDefinitionStore;
  /** Injectable for deterministic tests; defaults to `crypto.randomUUID`. */
  generateRunId?: () => string;
  /** Injectable for deterministic tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * `RunJobRequestSchema` (`../run-job.ts`) plus two Portal-only fields no
 * other run-starting entry point (the Pub/Sub push route, the queue
 * consumer) needs to know about — kept as an `.extend()` rather than a
 * second hand-copied schema so `clientSlug`/`productId`/`runKind`
 * validation can never drift between the HTTP route and the queue-triggered
 * paths.
 */
const StartRunRequestSchema = RunJobRequestSchema.extend({
  /**
   * Accepted for forward compatibility with the Portal's own request shape,
   * but not currently consumed: none of the six workflow factories accept a
   * per-run input override today — each one reads entirely from persisted
   * client state (`client.getConfig`, the topic catalog, memory) via its own
   * internal tool calls. Wiring this through would mean adding a write path
   * to `karos-client` (currently entirely read-only) or a new per-run
   * override mechanism to every workflow, neither of which this phase asked
   * for — so it's validated and accepted, not silently dropped, but it has
   * no effect on the run yet.
   */
  inputParams: z.record(z.string(), z.unknown()).optional(),
  specId: z.string().optional(),
});

const ResumeRunRequestSchema = z.object({
  gateId: z.string().min(1),
  resolution: z.object({
    /**
     * `revise` re-enters the drafting loop with `feedback` injected instead of
     * holding the run (see `GateResponseSchema`'s own note). Widened here in
     * lockstep with that schema; an agent that does not implement revision
     * treats it as non-approve and holds, which is the safe default.
     */
    decision: z.enum(["approve", "revise", "reject"]),
    actor: z.string().min(1),
    notes: z.string().optional(),
    /** Change request on `revise`, optional guidance on `approve`. */
    feedback: z.string().optional(),
    /** Per-slide notes on the templates that rendered this output. */
    templateFeedback: z
      .array(
        z.object({
          slide: z.number().int().positive(),
          templateId: z.string().min(1),
          verdict: z.enum(["approved", "revise"]),
          note: z.string().min(1),
          promote: z.boolean().optional(),
        }),
      )
      .optional(),
    /** In-place edits the reviewer made before approving — applied verbatim by the workflow (see `ReviewEditsSchema`). */
    edits: z
      .object({
        caption: z.string().min(1).max(2200).optional(),
        slides: z
          .array(
            z.object({
              n: z.number().int().positive(),
              fields: z.record(z.string(), z.string().max(2000)).optional(),
              fontScale: z.enum(["s", "m", "l"]).optional(),
              textAlign: z.enum(["start", "center", "end"]).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
});

function mapProductId(candidate: string): ProductId | undefined {
  return isKnownProductId(candidate) ? candidate : undefined;
}

/** `/api/v1/runs/...` — start, resume, and status, per RFC-01 §7/§8. */
export function createRunsRouter(deps: RunsRouterDeps): Router {
  const router = Router();
  const generateRunId = deps.generateRunId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const engine = new WorkflowEngine(deps.durableStore);

  router.post("/api/v1/runs/start", async (req, res) => {
    const parsed = StartRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.issues });
      return;
    }
    const { clientSlug, productId, runKind } = parsed.data;

    const runId = generateRunId();
    // Shared with the Pub/Sub push route and the pull-based queue consumer
    // (`run-job.ts`) — this is the one place "start a run" actually happens.
    const outcome = await startRunJob({ clientSlug, productId, runKind }, runId, deps);

    if (outcome.outcome === "conflict") {
      // Astronomically unlikely for a freshly generated runId, but a defensive backstop
      // if the id generator is ever swapped for something less collision-proof.
      res.status(409).json({ error: outcome.message });
      return;
    }
    if (outcome.outcome === "not_found") {
      // A client error — productId named neither a fixed product nor a registered dynamic
      // agent (Task 2) — not a server-side failure, so 400, not 500.
      res.status(400).json({ error: outcome.message });
      return;
    }
    if (outcome.outcome === "error") {
      res.status(500).json({ error: "run failed unexpectedly", message: outcome.message });
      return;
    }
    res.status(201).json({
      runId: outcome.runId,
      status: outcome.status,
      ...(outcome.pendingGateId !== undefined ? { pendingGateId: outcome.pendingGateId } : {}),
      report: outcome.report,
    });
  });

  router.post("/api/v1/runs/:runId/resume", async (req, res) => {
    const { runId } = req.params as { runId: string };
    const parsed = ResumeRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.issues });
      return;
    }

    const runRecord = await deps.durableStore.getRun(runId);
    if (!runRecord) {
      res.status(404).json({ error: `no run found for "${runId}"` });
      return;
    }
    // Fast, common-case rejection for the exact scenario the concurrency audit finding
    // named: resuming a run that isn't actually paused at a gate (already running,
    // already completed, or resumed by someone else a moment ago). The store-level
    // claimRun inside engine.run() below is the real, race-proof backstop — this check
    // just turns the ordinary sequential case into a clean, fast 409 instead of a wasted
    // resolveGate call followed by a claim failure.
    if (runRecord.status !== "awaiting_gate") {
      res.status(409).json({ error: `run "${runId}" is not awaiting a gate (current status: "${runRecord.status}")` });
      return;
    }
    const productId = mapProductId(runRecord.productId);
    if (!productId) {
      res.status(500).json({ error: `run "${runId}" has an unrecognized productId "${runRecord.productId}"` });
      return;
    }

    const { gateId, resolution } = parsed.data;
    const responseParsed = GateResponseSchema.safeParse({
      decision: resolution.decision,
      actor: resolution.actor,
      ...(resolution.notes !== undefined ? { reason: resolution.notes } : {}),
      // `notes` doubles as `feedback` when the caller sent no explicit
      // `feedback`, so a client that only knows about `notes` can still drive
      // a `revise` (whose schema REQUIRES feedback) rather than getting a 400
      // it has no way to interpret.
      ...(resolution.feedback !== undefined
        ? { feedback: resolution.feedback }
        : resolution.notes !== undefined
          ? { feedback: resolution.notes }
          : {}),
      ...(resolution.templateFeedback !== undefined ? { templateFeedback: resolution.templateFeedback } : {}),
      // This re-map is an ALLOWLIST: a field accepted by ResumeRunRequestSchema
      // but not spread here is silently dropped before the engine ever sees it.
      ...(resolution.edits !== undefined ? { edits: resolution.edits } : {}),
      at: now(),
    });
    if (!responseParsed.success) {
      res.status(400).json({ error: "invalid gate resolution", details: responseParsed.error.issues });
      return;
    }

    try {
      await engine.resolveGate(runId, gateId, responseParsed.data);
    } catch (err) {
      if (err instanceof GateAlreadyResolvedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const workflowFn = buildWorkflowForProduct(productId, deps.runtimeDeps);
    try {
      const result = await engine.run(workflowFn, {
        runId,
        clientSlug: runRecord.clientSlug,
        productId: runRecord.productId,
        runKind: runRecord.runKind,
      });
      const report = await buildRunReport(deps.durableStore, runId, productId);
      res.status(200).json({
        runId,
        status: result.status,
        ...(result.status === "awaiting_gate" ? { pendingGateId: result.pendingGateId } : {}),
        report,
      });
    } catch (err) {
      if (err instanceof WorkflowConcurrentRunError) {
        // The true race-closing backstop: a second resume request that slipped past the
        // status pre-check above (both read "awaiting_gate" before either wrote) loses
        // here instead, at the store's atomic claim.
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "resume failed unexpectedly", message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/v1/runs/:runId/status", async (req, res) => {
    const { runId } = req.params as { runId: string };
    const runRecord = await deps.durableStore.getRun(runId);
    if (!runRecord) {
      res.status(404).json({ error: `no run found for "${runId}"` });
      return;
    }
    // Unlike /resume (which still only knows how to build/re-run a FIXED product's workflow
    // — see below), status is read-only: buildRunReport already handles an arbitrary
    // productId string (Task 2's dynamic agents included) via its own generic fallback, so
    // this route never needs to reject one the way /resume's mapProductId gate still does.
    const report = await buildRunReport(deps.durableStore, runId, runRecord.productId);
    res.status(200).json({
      runId,
      status: runRecord.status,
      // != null (not !== undefined): a terminal transition now explicitly clears this to
      // `null` rather than leaving a prior awaiting_gate's value sitting there (see
      // WorkflowEngine.run()'s terminalRunFields) — both "never set" and "explicitly
      // cleared" must be omitted from the response, only a real pending id included.
      ...(runRecord.pendingGateId != null ? { pendingGateId: runRecord.pendingGateId } : {}),
      report,
    });
  });

  return router;
}
