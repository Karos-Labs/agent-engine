import { z } from "zod";
import { GateSchema, RunKindSchema } from "@agent-engine/core";

/**
 * The run-level outcome taxonomy (RFC-01 §6), extended with two domain
 * outcomes (RFC-01 §16.2 / RFC-02 §3): `held` ("nothing honestly cleared the
 * gates" — a legitimate, non-failure empty result) and `blocked_intake` (the
 * client hasn't supplied required inputs yet — a client-side gap, not an
 * agent fault). Neither is ever conflated with `failed`/`degraded` — that
 * conflation is exactly the bug this taxonomy exists to prevent.
 *
 * Distinct from `AgentExecutionResult.status` in `@agent-engine/core`, which
 * is Layer 2's step-execution scope. `"running"` is this store's own
 * transient marker for a run actively executing (or paused between
 * resumes); it is never a terminal outcome a `WorkflowEngine.run()` call
 * itself resolves to.
 */
export const RunStatusSchema = z.enum(["running", "completed", "failed", "degraded", "awaiting_gate", "held", "blocked_intake"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** A per-run dollar ceiling, enforced before each `step.agent` call, not audited after (RFC-01 §8.1). */
export const WorkflowBudgetSchema = z.object({
  maxTotalCostUsd: z.number().positive().optional(),
});
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;

/** The run-level record — `agentEngineRuns/{runId}` in the Firestore adapter (RFC-01 §8.4a). */
export const RunRecordSchema = z.object({
  runId: z.string().min(1),
  clientSlug: z.string().min(1),
  productId: z.string().min(1),
  runKind: RunKindSchema,
  status: RunStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  budget: WorkflowBudgetSchema.optional(),
  totalCostUsd: z.number().nonnegative().optional(),
  failureReason: z.string().optional(),
  pendingGateId: z.string().optional(),
  /** Explains a `held`/`blocked_intake` outcome — kept distinct from `failureReason` since neither is a failure (RFC-01 §16.2). */
  reason: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const StepKindSchema = z.enum(["code", "agent"]);
export type StepKind = z.infer<typeof StepKindSchema>;

/**
 * One step's checkpoint — `agentEngineRuns/{runId}/steps/{stepId}` (RFC-01
 * §8.4a). `status` here is Layer 1's own execution-checkpoint status (did
 * the step itself run to completion), not the content-level verdict a
 * `step.agent` call's `output` (an `AgentExecutionResult`) may carry — Layer
 * 1 makes zero content judgments (RFC-01 §4), it only records what ran.
 */
export const StepRecordSchema = z.object({
  stepId: z.string().min(1),
  kind: StepKindSchema,
  status: z.enum(["completed", "failed"]),
  output: z.unknown(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  startedAt: z.number(),
  completedAt: z.number(),
  error: z.string().optional(),
});
export type StepRecord = z.infer<typeof StepRecordSchema>;

/** One fan-out slot's checkpoint — `agentEngineRuns/{runId}/slots/{slotId}` (RFC-01 §8.4a). */
export const SlotRecordSchema = z.object({
  slotId: z.string().min(1),
  /** The `fanout()` call this slot belongs to, for scoping `listSlots`. */
  fanoutId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  output: z.unknown(),
  durationMs: z.number().nonnegative(),
  startedAt: z.number(),
  completedAt: z.number(),
  error: z.string().optional(),
});
export type SlotRecord = z.infer<typeof SlotRecordSchema>;

/**
 * A registered gate — `agentEngineGates/{gateId}` (RFC-01 §8.4a), a
 * top-level collection (not nested under the run) since an approvals UI
 * needs to list pending gates across runs. Reuses `@agent-engine/core`'s
 * own `Gate` contract (RFC-01 §8.3) verbatim, adding only the store key.
 */
export const GateRecordSchema = GateSchema.extend({
  gateId: z.string().min(1),
});
export type GateRecord = z.infer<typeof GateRecordSchema>;

/**
 * The small internal interface every durable-workflow primitive is built
 * against (RFC-01 §8.4's "swap the adapter, not the workflow code" principle)
 * — `step.code`/`step.agent`/`step.gate`/`fanout` never talk to Firestore or
 * an in-memory Map directly, only to this.
 *
 * Every write is idempotent on its record's own id — a retried `saveStep`/
 * `saveSlot`/`saveGate` with the same key lands on the same record (RFC-01
 * §9.1 rule 2 / §8.4a's `set(...,{merge:true})` idiom), never a duplicate.
 */
export interface DurableStepStore {
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** Idempotent create: returns the existing record unchanged if one is already there. */
  createRunIfNotExists(run: RunRecord): Promise<RunRecord>;
  updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<void>;

  getStep(runId: string, stepId: string): Promise<StepRecord | undefined>;
  saveStep(runId: string, step: StepRecord): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;

  getSlot(runId: string, slotId: string): Promise<SlotRecord | undefined>;
  saveSlot(runId: string, slot: SlotRecord): Promise<void>;
  listSlots(runId: string, fanoutId: string): Promise<SlotRecord[]>;

  getGate(gateId: string): Promise<GateRecord | undefined>;
  saveGate(gate: GateRecord): Promise<void>;
}
