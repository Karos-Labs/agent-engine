import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { GateResponseSchema, HEX_COLOR, loadClientContentLanguage, type AgentDefinitionStore } from "@agent-engine/core";
import { describeError } from "@agent-engine/telemetry";
import { GateAlreadyResolvedError, WorkflowConcurrentRunError, WorkflowEngine, type DurableStepStore } from "@agent-engine/workflow";
import { buildRunReport } from "../report.js";
import { RunJobRequestSchema, type RunJobRequest } from "../run-job.js";
import { resolveWorkflowFn, UnknownProductError } from "../wiring/dynamic-workflows.js";
import { isKnownProductId, type AgentRuntimeDeps, type WorkflowFn } from "../wiring/workflows.js";
import { enforceTenantEntitlement } from "../auth/tenant-assertion.js";
import { respondInternalError, respondWithLoggedDetail } from "./error-response.js";

/** Hands a run-job off to the queue. Returns the id the consumer will derive from the published message. */
export type EnqueueRunJob = (request: RunJobRequest) => Promise<{ runId: string }>;

export interface RunsRouterDeps {
  durableStore: DurableStepStore;
  runtimeDeps: AgentRuntimeDeps;
  /**
   * Looked up via `resolveWorkflowFn` whenever a `productId` isn't one of the
   * fixed products (Task 2's dynamic agents) — by `startRunJob` for
   * `/runs/start`, and by `/runs/:runId/resume` for the productId on the stored
   * run record (SCRUM-315). Omit only if this deployment never dispatches one
   * over HTTP; omitting it makes every dynamic agent unstartable AND
   * unresumable, which `resolveWorkflowFn` says in as many words rather than
   * failing vaguely.
   */
  agentDefinitionStore?: AgentDefinitionStore;
  /**
   * Publishes a run-job message and returns the id the consumer will derive
   * from it (AU66 / SCRUM-364). Injected rather than constructed here, like
   * every other real-client dependency in this codebase.
   *
   * The injection is what lets `scripts/smoke-test-server.ts` keep working
   * without GCP AND without this route staying synchronous for its benefit:
   * the smoke test does not actually need the ROUTE to execute a run, it needs
   * a run to happen on a machine with no Pub/Sub. So it supplies an
   * in-process implementation of enqueueing, and the route's own contract —
   * "hand this off and return" — is identical in both.
   */
  enqueueRunJob?: EnqueueRunJob;
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
        /**
         * IGSTYLE-1. Mirrored inline (that duplication is deliberate in this
         * file, per `StartRunRequestSchema`'s own precedent) rather than
         * imported, so this route's 400 on a malformed hex happens at THIS
         * boundary — the real `StyleEditSchema` re-validates it again once
         * spread into `GateResponseSchema.safeParse` below, so the two
         * cannot silently diverge into "the route accepted it but the
         * engine rejected it."
         */
        style: z
          .object({
            ground: z.string().regex(HEX_COLOR).optional(),
            fg: z.string().regex(HEX_COLOR).optional(),
            accent: z.string().regex(HEX_COLOR).optional(),
            surface: z.string().regex(HEX_COLOR).optional(),
            fg2: z.string().regex(HEX_COLOR).optional(),
            line: z.string().regex(HEX_COLOR).optional(),
            accentInk: z.string().regex(HEX_COLOR).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

/** `/api/v1/runs/...` — start, resume, and status, per RFC-01 §7/§8. */
export function createRunsRouter(deps: RunsRouterDeps): Router {
  const router = Router();
  const generateRunId = deps.generateRunId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const engine = new WorkflowEngine(deps.durableStore);

  /**
   * `POST /api/v1/runs/start` — ENQUEUES a run and returns immediately
   * (AU66 / SCRUM-364). It no longer executes anything.
   *
   * ## What this route used to be
   *
   * It ran the entire workflow inside one HTTP request. That is fine for a
   * 5-second run and catastrophic for a 17-minute one, because Cloud Run's
   * request timeout is 300s and this service does not set
   * `--no-cpu-throttling`: once the request is severed the container's CPU is
   * throttled, network-bound work carries on, and CPU-bound work dies.
   *
   * Reproduced, twice, on prep. Both runs 504'd at ~300s, both continued in the
   * background, and both died at `08-render-carousel` with
   * `browserType.launch: Timeout 180000ms exceeded` — Chromium launching ~9
   * minutes after the request that was supposedly driving it had ended. Cost:
   * $0.333 for the second one, and a diagnosis that initially blamed the wrong
   * layer.
   *
   * ## Why enqueue rather than the alternatives
   *
   * Nothing in production used this route: karosCMO publishes to Pub/Sub, and
   * the only run-jobs subscription is a PULL one consumed by
   * `agent-engine-prep-worker`, which has `--no-cpu-throttling` and
   * `min-instances=1` and completed 12 of 12 instagram renders. So this was
   * never a broken production path — it was a TRAP that anyone testing fell
   * into.
   *
   * Deleting it would remove a documented API. `--no-cpu-throttling` would make
   * the symptom vanish while leaving a whole workflow inside one request and
   * billing idle CPU — it hides the problem. Enqueueing collapses the system to
   * ONE EXECUTION PATH, which is the property actually worth having, and closes
   * the "inline whole-run execution in the HTTP request" item that has been
   * open across two audits.
   */
  router.post("/api/v1/runs/start", async (req, res) => {
    const parsed = StartRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", details: parsed.error.issues });
      return;
    }
    const { clientSlug, productId, runKind } = parsed.data;

    // AU46 / SCRUM-329: the request names its own target clientSlug (unlike
    // the runId-addressed routes below, there is no stored record to read it
    // from), so entitlement is checked directly against the parsed body,
    // before anything else about the request is acted on.
    if (enforceTenantEntitlement(req, res, clientSlug)) return;

    // Validated BEFORE publishing, and kept synchronous on purpose. Resolving a
    // productId is a name lookup and, for a dynamic agent, one store read — it
    // does not execute anything, so enqueueing is no reason to stop doing it.
    // Without this an unknown productId returns 202 and fails minutes later in
    // a worker, which is a strictly worse answer to a strictly client error.
    if (!isKnownProductId(productId)) {
      const spec = await deps.agentDefinitionStore?.get(productId);
      if (!spec) {
        res.status(400).json({
          error: `productId "${productId}" is neither a known fixed product nor a registered dynamic agent`,
        });
        return;
      }
    }

    if (!deps.enqueueRunJob) {
      // Deliberately NOT a synchronous fallback. Executing here when the queue
      // is unconfigured would reinstate the exact trap this ticket removes, and
      // it would do it on precisely the machines least able to notice.
      respondInternalError(
        res,
        "runs/start cannot enqueue: no queue is configured for this deployment. Set PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and QUEUE_TOPIC_RUN_JOBS. " +
          "This route no longer executes runs itself — see AU66 / SCRUM-364.",
        undefined,
      );
      return;
    }

    try {
      const { runId } = await deps.enqueueRunJob({ clientSlug, productId, runKind });
      // 202, not 201: nothing has been created yet beyond a queued message.
      // The run record appears when the worker claims it. `runId` is the id the
      // consumer WILL derive from this message, so a caller can poll
      // `/runs/:runId/status` immediately — it 404s until the worker starts,
      // which is the honest answer to "is it running yet".
      res.status(202).json({ runId, status: "queued" });
    } catch (err) {
      respondInternalError(res, `runs/start could not enqueue the run: ${describeError(err)}`, undefined);
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
    // AU46 / SCRUM-329: this route is addressed by runId alone, so
    // entitlement can only be checked once the run record — and the
    // clientSlug it actually belongs to — has been read back. Checked before
    // the gate-status check below so a non-entitled caller learns nothing
    // about a foreign tenant's run beyond "a run with this id exists"
    // (which the 404 above already would have revealed either way).
    if (enforceTenantEntitlement(req, res, runRecord.clientSlug)) return;
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
    // SCRUM-315 / AU6. Resolved through the SAME function `/runs/start` uses (via
    // `startRunJob` → `resolveWorkflowFn`), which is the whole fix: this route used
    // to narrow the stored productId to `KNOWN_PRODUCT_IDS` and 500 on anything
    // else, so a dynamic agent (Task 2), dispatched by an `agentId` that is
    // DELIBERATELY not one of the fixed 13, could be started but never resumed —
    // the one entry point in the system that could not handle one. `/status`
    // already handled an arbitrary productId; the asymmetry was the bug.
    //
    // Kept ahead of `resolveGate` for the same reason the old check was: an
    // unresolvable productId must not consume the human's one-shot gate decision
    // and leave the run unresumable in a second, worse way. It costs one store
    // read, executes nothing, and cannot be deferred past the write it protects.
    let workflowFn: WorkflowFn;
    try {
      workflowFn = await resolveWorkflowFn(runRecord.productId, deps.runtimeDeps, deps.agentDefinitionStore);
    } catch (err) {
      if (err instanceof UnknownProductError) {
        // 500 rather than `/runs/start`'s 400, on purpose: the caller of `/resume`
        // supplies only a runId — this productId came off the STORED run record, so
        // an id that no longer resolves (a deleted definition, a deployment with no
        // AgentDefinitionStore wired) is a server-side fault the client cannot fix
        // by sending a different request.
        res.status(500).json({ error: `run "${runId}" has an unresumable productId: ${err.message}` });
        return;
      }
      respondInternalError(res, `resume could not resolve a workflow for run ${runId}`, err);
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
      respondWithLoggedDetail(res, 404, "gate not found", `resolveGate failed for run ${runId} gate ${gateId}`, err);
      return;
    }

    // AU34 (SCRUM-312). Re-read on resume for the same reason `budget` and
    // `input` are recovered from the run record inside `engine.run`: the second
    // half of a gated run has to draft under the same rules as the first.
    // Without it, a Hebrew-language client's copy step resolves to a
    // Hebrew-capable model before the gate and silently falls back to the
    // compiled default after it — the exact shape of silent wrong output this
    // ticket exists to remove. It is the CLIENT's standing configuration, not
    // per-run state, so re-reading it is equivalent to carrying it forward.
    const contentLanguage = await loadClientContentLanguage(deps.runtimeDeps.workspaceStore, runRecord.clientSlug);

    try {
      const result = await engine.run(workflowFn, {
        runId,
        clientSlug: runRecord.clientSlug,
        productId: runRecord.productId,
        runKind: runRecord.runKind,
        ...(contentLanguage !== undefined ? { contentLanguage } : {}),
      });
      // `runRecord.productId`, not a narrowed `ProductId`: `buildRunReport` takes a
      // plain string and has handled a dynamic agent's id since `/status` started
      // passing one (see its `else` branch).
      const report = await buildRunReport(deps.durableStore, runId, runRecord.productId);
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
      respondInternalError(res, `resume failed unexpectedly for run ${runId}`, err);
    }
  });

  router.get("/api/v1/runs/:runId/status", async (req, res) => {
    const { runId } = req.params as { runId: string };
    const runRecord = await deps.durableStore.getRun(runId);
    if (!runRecord) {
      res.status(404).json({ error: `no run found for "${runId}"` });
      return;
    }
    // AU46 / SCRUM-329: this is the exact cross-tenant read the ticket
    // closes — runId-guessing against another client's run — so it is
    // checked here even though the route is otherwise read-only.
    if (enforceTenantEntitlement(req, res, runRecord.clientSlug)) return;
    // Read-only: buildRunReport handles an arbitrary productId string (Task 2's dynamic
    // agents included) via its own generic fallback, so this route never needs to reject
    // one. /resume no longer does either — it resolves the stored productId through
    // `resolveWorkflowFn` exactly as /runs/start does (SCRUM-315); the two routes' notions
    // of "a productId this server can handle" are the same one again.
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
