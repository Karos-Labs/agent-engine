import { z } from "zod";
import { loadClientContentLanguage, RunKindSchema, type AgentDefinitionStore } from "@agent-engine/core";
import {
  WorkflowConcurrentRunError,
  WorkflowEngine,
  type DurableStepStore,
  type DynamicAgentRunReport,
  type RunStatus,
} from "@agent-engine/workflow";
import { buildRunReport } from "./report.js";
import { resolveWorkflowFn, UnknownProductError } from "./wiring/dynamic-workflows.js";
import type { AgentRuntimeDeps } from "./wiring/workflows.js";

// Charset-locked at the boundary so a path-traversal-shaped slug (`../../etc`,
// an embedded `/`, `\`, or NUL) never reaches a tool — same rule
// `routes/runs.ts` enforced before this logic was extracted out of it.
const CLIENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The one contract for "start a run", shared by every entry point that can
 * trigger one: `POST /api/v1/runs/start` (`routes/runs.ts`, which extends
 * this with two Portal-only pass-through fields it doesn't need), the
 * Pub/Sub push endpoint (`routes/queue.ts`), and the pull-based
 * `queue-consumer.ts`. Defining it once here is what guarantees those three
 * entry points can never validate a run request differently from one
 * another.
 *
 * `productId` is validated only against the shared charset, not
 * `KNOWN_PRODUCT_IDS`'s fixed enum (Task 2) — it may name either one of the
 * 12 hand-written products, or a dynamic agent's own `agentId` registered
 * via `POST /api/agents`. `resolveWorkflowFn` (called from `startRunJob`
 * below) is what actually distinguishes the two and fails clearly if
 * neither matches.
 */
export const RunJobRequestSchema = z.object({
  clientSlug: z.string().min(1).regex(CLIENT_SLUG_PATTERN, "clientSlug must be lowercase alphanumeric segments separated by hyphens"),
  productId: z.string().min(1).regex(CLIENT_SLUG_PATTERN, "productId must be lowercase alphanumeric segments separated by hyphens"),
  runKind: RunKindSchema,
  /**
   * What THIS run was asked to do -- a portal brief, a requested topic, a
   * chosen lane. Optional: a scheduled run has no request of its own.
   *
   * agent-middleware has been publishing this as `input` since it was built
   * (see its `to_engine_message`, whose comment notes the engine would read it
   * "once it knows how"). Zod stripped it, so a client's typed brief reached
   * the broker and stopped there, and the agent picked its own topic instead
   * of the one that was asked for -- wrong output rather than a failure, which
   * is why it went unnoticed.
   *
   * Deliberately NOT merged into client config: that is the client's standing
   * configuration, shared by every run, so two concurrent runs would race and
   * the second would draft against the first's brief.
   */
  input: z.record(z.string(), z.unknown()).optional(),
  /**
   * Which catalogued model each AI stage should use for THIS run, keyed by the
   * stage's own step id — Agent Studio's per-stage model selection.
   *
   * Separate from `input` on purpose. `input` is what the run was asked to do
   * and belongs to the person who dispatched it; this is how the agent is
   * configured to do it and belongs to whoever administers the agent. Folding
   * them together would let a run brief re-point a stage's model, which is a
   * spend and a quality decision, not a request.
   *
   * A key naming no stage is ignored rather than rejected: the map is authored
   * against a stage list that changes when an agent is edited, and a stale
   * entry should not fail a run that is otherwise fine.
   */
  stageModels: z.record(z.string(), z.string().min(1)).optional(),
});
export type RunJobRequest = z.infer<typeof RunJobRequestSchema>;

export interface StartRunJobDeps {
  durableStore: DurableStepStore;
  runtimeDeps: AgentRuntimeDeps;
  /** Looked up when `productId` doesn't match one of the 12 hand-written products (Task 2). Omit only for a deployment that will never dispatch a dynamic agent — `resolveWorkflowFn` throws a clear error rather than silently no-op'ing if one is actually needed. */
  agentDefinitionStore?: AgentDefinitionStore;
}

export type StartRunJobOutcome =
  | {
      outcome: "started";
      runId: string;
      status: RunStatus;
      pendingGateId?: string;
      report: DynamicAgentRunReport;
    }
  | {
      /** `runId` was already mid-flight when this call landed — RFC-01 §8.4a's atomic claim, surfaced here rather than as a thrown error. */
      outcome: "conflict";
      runId: string;
      message: string;
    }
  | {
      /** `productId` named neither a fixed product nor a registered dynamic agent (Task 2) — a client error (HTTP 400 at `/runs/start`), distinct from `"error"` below (an unexpected failure actually running a resolved workflow). */
      outcome: "not_found";
      runId: string;
      message: string;
    }
  | {
      outcome: "error";
      runId: string;
      message: string;
    };

/**
 * Starts (or, for a `runId` that already exists, safely re-enters —
 * `WorkflowEngine.run`'s own idempotent-no-op-after-completed behaviour,
 * see its doc comment) exactly one run. `runId` is the caller's to choose:
 * `routes/runs.ts` generates a fresh one per HTTP request, while a
 * queue-triggered caller derives one deterministically from the message id
 * so an at-least-once redelivery can never double-run a job (see
 * `routes/queue.ts`).
 */
export async function startRunJob(request: RunJobRequest, runId: string, deps: StartRunJobDeps): Promise<StartRunJobOutcome> {
  const engine = new WorkflowEngine(deps.durableStore);

  let workflowFn;
  try {
    workflowFn = await resolveWorkflowFn(request.productId, deps.runtimeDeps, deps.agentDefinitionStore);
  } catch (err) {
    if (err instanceof UnknownProductError) {
      return { outcome: "not_found", runId, message: err.message };
    }
    return { outcome: "error", runId, message: err instanceof Error ? err.message : String(err) };
  }

  // AU34 (SCRUM-312). Read once per run, here, because this is where the
  // tenant-scoped workspace store is actually in hand — Layer 2 has no I/O of
  // its own (RFC-01 §4), so a `BaseAgent` can never look this up itself. It is
  // the CLIENT's standing configuration, so it is deliberately not taken from
  // the request: a caller cannot re-point a copy step's model by claiming a
  // language in a run brief. `loadClientContentLanguage` returns undefined
  // (never throws) for a client who has stated nothing or whose store read
  // fails, which leaves every step on exactly the model it had.
  const contentLanguage = await loadClientContentLanguage(deps.runtimeDeps.workspaceStore, request.clientSlug);

  try {
    const result = await engine.run(workflowFn, {
      runId,
      clientSlug: request.clientSlug,
      productId: request.productId,
      runKind: request.runKind,
      ...(request.input !== undefined ? { input: request.input } : {}),
      ...(request.stageModels !== undefined ? { stageModels: request.stageModels } : {}),
      ...(contentLanguage !== undefined ? { contentLanguage } : {}),
    });
    const report = await buildRunReport(deps.durableStore, runId, request.productId);
    return {
      outcome: "started",
      runId,
      status: result.status,
      ...(result.status === "awaiting_gate" ? { pendingGateId: result.pendingGateId } : {}),
      report,
    };
  } catch (err) {
    if (err instanceof WorkflowConcurrentRunError) {
      return { outcome: "conflict", runId, message: err.message };
    }
    return { outcome: "error", runId, message: err instanceof Error ? err.message : String(err) };
  }
}
