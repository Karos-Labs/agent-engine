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
  /**
   * What the caller asked for on THIS run, as opposed to standing client
   * configuration: a requested topic, a chosen lane, the brief a person
   * typed into the portal.
   *
   * Persisted rather than kept in memory because a run that pauses at a
   * human gate resumes in a different process -- and often a different
   * container -- and the second half must draft against the same brief as
   * the first. Reading it back off the record is the only way that holds.
   */
  input: z.record(z.string(), z.unknown()).optional(),
  /**
   * `failureReason`/`pendingGateId`/`reason` are `.nullable()` as well as
   * `.optional()`: every terminal (or re-entrant) transition in
   * `WorkflowEngine.run()` explicitly writes `null` into whichever of these
   * three don't apply to the new status, rather than leaving a prior
   * transition's value sitting there under `merge:true` semantics — a run
   * that failed once, was retried, and completed must not still report the
   * old `failureReason` forever (a reliability audit finding). `undefined`/
   * absent means "never set" (a fresh run); `null` means "explicitly not
   * applicable to the current status."
   */
  failureReason: z.string().nullable().optional(),
  pendingGateId: z.string().nullable().optional(),
  /** Explains a `held`/`blocked_intake` outcome — kept distinct from `failureReason` since neither is a failure (RFC-01 §16.2). */
  reason: z.string().nullable().optional(),
  /**
   * The step currently executing, for real-time progress reporting — set the
   * moment a step's "running" checkpoint is written (`runStepCode`/
   * `runStepAgent`, before the step's own function runs), left pointing at
   * the last step once the run reaches a terminal status (harmless: a reader
   * gates on `status` first, per `serializeToDynamicAgentRunReport`'s own
   * `runIsInFlight` check). `undefined` on a run from before this field
   * existed, or one with no steps recorded yet.
   */
  currentStepId: z.string().nullable().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * What kind of step produced a checkpoint. `"gate"` is a human/policy approval
 * (`step.gate`), and it was added because gates used to produce NO checkpoint at
 * all: `runStepGate` registered its `agentEngineGates/{gateId}` record and threw
 * `AwaitingGateSignal`, so every reader built on the `steps` subcollection
 * skipped straight over it. On a real x-agent run that meant the step sequence
 * read 14 → 16, with the human review step — the one step a person actually
 * participates in — invisible, and `apps/agent-server`'s report builder carrying
 * a `resolvedGateStepRecords` join to synthesize the row back after the fact.
 *
 * A gate's checkpoint is `"running"` from registration until a response is
 * recorded, which is genuinely how long the step takes: the wait is the step.
 */
export const StepKindSchema = z.enum(["code", "agent", "gate"]);
export type StepKind = z.infer<typeof StepKindSchema>;

/**
 * One step's checkpoint — `agentEngineRuns/{runId}/steps/{stepId}` (RFC-01
 * §8.4a). `status` here is Layer 1's own execution-checkpoint status (did
 * the step itself run to completion), not the content-level verdict a
 * `step.agent` call's `output` (an `AgentExecutionResult`) may carry — Layer
 * 1 makes zero content judgments (RFC-01 §4), it only records what ran.
 *
 * `"running"` is a transient, real-time-progress-only state: `runStepCode`/
 * `runStepAgent` write it (with only `stepId`/`kind`/`status`/`startedAt`
 * populated) immediately before calling the step's own function, so a reader
 * watching Firestore mid-run sees "step X is in flight" rather than nothing
 * at all until it finishes. The later `"completed"`/`"failed"` write lands on
 * the SAME document (`saveStep`'s `set(...,{merge:true})`), filling in
 * `completedAt`/`costUsd`/`durationMs`/`output` — never a second document, so
 * a resumed run's `getStep(...).status === "completed"` skip-check is
 * unaffected. `output`/`costUsd`/`durationMs`/`completedAt` are `.optional()`
 * for exactly this reason: a `"running"` record genuinely doesn't have them
 * yet.
 */
export const StepRecordSchema = z.object({
  stepId: z.string().min(1),
  kind: StepKindSchema,
  status: z.enum(["running", "completed", "failed"]),
  output: z.unknown().optional(),
  costUsd: z.number().nonnegative().optional(),
  /**
   * The three-way input-token split behind `costUsd`, plus the output count
   * (SCRUM-361b). Present on `agent` steps; absent on `code`/`gate` steps,
   * which burn no tokens.
   *
   * This exists because of what its absence cost. Cache writes were billed at
   * 1x instead of 1.25x, and the size of that error could not be recovered
   * from our own telemetry AT ALL: Firestore stored `costUsd` and no token
   * counts, BigQuery merged cached and uncached into one column, and the
   * adapter merged writes into uncached before either of them saw it. Three
   * collapses stacked, so THE ERROR ERASED ITS OWN EVIDENCE and could only be
   * bounded from above.
   *
   * Fixing the arithmetic without recording the split would leave the next
   * drift exactly as unmeasurable. Same reasoning as `unitUsage` below: a cost
   * with no derivation cannot be checked.
   */
  tokenUsage: z
    .object({
      cached: z.number().int().nonnegative(),
      uncached: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
  /**
   * The non-token units this step consumed, and the SKU that priced them
   * (SCRUM-361). Present only on steps that consumed any — which today means
   * generative media.
   *
   * Persisted alongside `costUsd` rather than discarded after multiplication,
   * because a cost with no derivation cannot be checked. That is not
   * hypothetical here: the run that exposed this gap could be reconciled
   * against Vertex's publisher metrics ONLY because those metrics existed
   * outside our telemetry. Anthropic-on-Vertex emits none, and both our own
   * sinks collapse what they store — Firestore keeps `costUsd` and no token
   * counts at all, and BigQuery merges cached and uncached input into one
   * column. Storing the units is what stops this number joining them.
   */
  unitUsage: z
    .array(z.object({ model: z.string().min(1), unit: z.string().min(1), quantity: z.number().nonnegative() }))
    .optional(),
  durationMs: z.number().nonnegative().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
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
 * The outcome of `claimRun` — whether *this* call's `patch` actually landed.
 * `run` is always the record as it stands after the call: the freshly
 * patched one when `claimed`, or whatever another writer left in place when
 * not — a caller checking `claimed` never needs a second read to see why it
 * lost the race.
 */
export interface RunClaimResult {
  claimed: boolean;
  run: RunRecord;
}

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
  /**
   * Atomically transitions an existing run: `patch` is applied only if the
   * run's *current* status is one of `allowedFromStatuses` — the
   * optimistic-concurrency guard against two near-simultaneous resumes (or a
   * resume racing a still-in-flight run) both proceeding past the same
   * checkpoint (a reliability audit finding). `FirestoreDurableStepStore`
   * implements this with a real transaction; `MemoryDurableStepStore`'s
   * synchronous check-then-write body is already race-free under Node's
   * single-threaded event loop (no `await` between the read and the write).
   * Throws — never silently no-ops — if the run does not exist at all, the
   * same "caller bug, not a valid state" contract `updateRun` already has.
   */
  claimRun(runId: string, allowedFromStatuses: readonly RunStatus[], patch: Partial<Omit<RunRecord, "runId">>): Promise<RunClaimResult>;

  getStep(runId: string, stepId: string): Promise<StepRecord | undefined>;
  saveStep(runId: string, step: StepRecord): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;

  getSlot(runId: string, slotId: string): Promise<SlotRecord | undefined>;
  saveSlot(runId: string, slot: SlotRecord): Promise<void>;
  listSlots(runId: string, fanoutId: string): Promise<SlotRecord[]>;

  getGate(gateId: string): Promise<GateRecord | undefined>;
  saveGate(gate: GateRecord): Promise<void>;
}
