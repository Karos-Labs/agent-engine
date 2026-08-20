import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { GateResponseSchema, RunKindSchema } from "@agent-engine/core";
import { GateAlreadyResolvedError, WorkflowConcurrentRunError, WorkflowEngine, type DurableStepStore } from "@agent-engine/workflow";
import { buildRunReport } from "../report.js";
import { KNOWN_PRODUCT_IDS, buildWorkflowForProduct, isKnownProductId, type AgentRuntimeDeps, type ProductId } from "../wiring/workflows.js";

export interface RunsRouterDeps {
  durableStore: DurableStepStore;
  runtimeDeps: AgentRuntimeDeps;
  /** Injectable for deterministic tests; defaults to `crypto.randomUUID`. */
  generateRunId?: () => string;
  /** Injectable for deterministic tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

// Charset-locked at the API boundary so a path-traversal-shaped slug
// (`../../etc`, an embedded `/`, `\`, or NUL) never reaches a tool — the
// per-tool `sanitizeSegment` calls throughout `packages/tools/*` are
// defense-in-depth, not the only fence, once this holds at ingress.
const CLIENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const StartRunRequestSchema = z.object({
  clientSlug: z.string().min(1).regex(CLIENT_SLUG_PATTERN, "clientSlug must be lowercase alphanumeric segments separated by hyphens"),
  productId: z.enum(KNOWN_PRODUCT_IDS),
  runKind: RunKindSchema,
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
    decision: z.enum(["approve", "reject"]),
    actor: z.string().min(1),
    notes: z.string().optional(),
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
    const workflowFn = buildWorkflowForProduct(productId, deps.runtimeDeps);

    try {
      const result = await engine.run(workflowFn, { runId, clientSlug, productId, runKind });
      const report = await buildRunReport(deps.durableStore, runId, productId);
      res.status(201).json({
        runId,
        status: result.status,
        ...(result.status === "awaiting_gate" ? { pendingGateId: result.pendingGateId } : {}),
        report,
      });
    } catch (err) {
      if (err instanceof WorkflowConcurrentRunError) {
        // Astronomically unlikely for a freshly generated runId, but a defensive backstop
        // if the id generator is ever swapped for something less collision-proof.
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "run failed unexpectedly", message: err instanceof Error ? err.message : String(err) });
    }
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
    const productId = mapProductId(runRecord.productId);
    if (!productId) {
      res.status(500).json({ error: `run "${runId}" has an unrecognized productId "${runRecord.productId}"` });
      return;
    }

    const report = await buildRunReport(deps.durableStore, runId, productId);
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
