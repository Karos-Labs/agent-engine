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
   * Studio's per-stage model override for THIS run (SCRUM-384 / AU34's
   * sibling field), keyed by step id — see `RunWorkflowParams.stageModels`'s
   * own doc comment for what it drives.
   *
   * Persisted for the identical reason `input` is: a run that pauses at a
   * human gate resumes in a different process, and the post-gate half has to
   * draft under the same per-stage model choice as the pre-gate half. Unlike
   * `contentLanguage` (AU34/SCRUM-312), there is no external client-standing
   * store to re-read this from at resume time -- it is a one-shot choice made
   * for this run alone -- so the run record is the only place it can survive
   * the gate. Before this field existed, `stageModels` reached the runtime
   * for the first half only and was never written here, so the second half
   * silently lost it (SCRUM-384).
   */
  stageModels: z.record(z.string(), z.string().min(1)).optional(),
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
  /**
   * Which execution currently holds this run's lease — a random id minted per
   * `WorkflowEngine.run()` call, not a machine or instance identity.
   *
   * Exists so a worker that has lost its lease can find out. `updatedAt` alone
   * says a lease is alive; it cannot say whose. When a run is reclaimed after
   * its lease expires, the reclaiming execution writes a new owner here, and
   * the old execution's next heartbeat sees an id that is not its own and
   * stands down instead of extending a lease it no longer holds.
   *
   * `undefined` on a run recorded before this field existed, and on any run
   * whose execution predates it — both read as "no owner", which is treated as
   * reclaimable rather than as a claim, since a run with no recorded owner is
   * exactly the abandoned case this field was added to recover.
   */
  leaseOwner: z.string().nullable().optional(),
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
  /**
   * What this step's execution resolved to (AU67 / SCRUM-365).
   *
   * ## The bug this replaces
   *
   * Two correct designs produced a wrong result. RFC-01 §6 says a tool reports
   * failure as an OUTCOME — a returned value. `runStepCode` listened for
   * EXCEPTIONS. Nothing translated between them, so a correctly-reported
   * failure arrived at the recorder as a successful return and was persisted as
   * `completed`.
   *
   * AU8 did not cause this; AU8 REVEALED it. Before AU8 the outcome was wrong
   * (`karos-video`'s gates smuggled `verdict: "tooling_error"` inside
   * `status: "success"`) and the step said completed. After AU8 the outcome was
   * right and the step STILL said completed — which is how it became visible
   * that only one layer had ever implemented the contract.
   *
   * Observed live: prep run `2303f93f-0d11-4805-b0e8-ab661442712f` recorded
   * `08-render-carousel-attempt-1` as `completed` at $0.000000 while
   * `publish.renderCarousel` had reported a `tooling_error` and the RUN was
   * `degraded`.
   *
   * ## Why not just "failed"
   *
   * `failed` is too blunt, and collapsing into it would be the same conflation
   * one level up. `not_available` is a legitimate, DESIGNED state — a
   * capability deliberately absent — while `tooling_error` is a fault, and
   * `content_fail` is a real judgment about content that a revision loop
   * expects to see. The capture-tier vocabulary (MEASURED / ESTIMATED /
   * UNAVAILABLE) is the prior art: reuse the distinction, do not flatten it.
   *
   * `failed` is kept, narrowed to what it always actually meant here: the body
   * THREW, so there is no outcome at all and no output to replay.
   *
   * `budget_exceeded` joined the set in AU68 / SCRUM-366, when `step.agent`
   * started recording its own verdict. It is `AgentExecutionStatus`'s fourth
   * value and has no `step.code` counterpart — a tool outcome cannot be
   * `budget_exceeded`, only an agent loop can. Mapping it onto `tooling_error`
   * would have been the same flattening this list exists to refuse: a ReAct
   * loop that ran out of its configured turn budget did not malfunction, it hit
   * a ceiling someone chose.
   *
   * ## Resume is unaffected — deliberately
   *
   * Four sites skip a step on resume, and they now ask
   * {@link isCheckpointedStepStatus} rather than `=== "completed"`. Every value
   * except `running` and `failed` carries an `output` and is replayable, which
   * is exactly the set that was replayable before. Nothing re-runs that did not
   * re-run yesterday.
   */
  status: z.enum(["running", "completed", "content_fail", "not_available", "tooling_error", "budget_exceeded", "failed"]),
  output: z.unknown().optional(),
  costUsd: z.number().nonnegative().optional(),
  /**
   * The non-token units this step consumed, and the SKU that priced them
   * (the per-unit cost work — shipped without a Jira ticket). Present only on steps that consumed any — which today means
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
export type StepRecordStatus = StepRecord["status"];

/**
 * Whether a step's recorded status means "this ran to a terminal outcome and
 * its output is replayable" — the question the four resume sites are actually
 * asking (AU67 / SCRUM-365).
 *
 * They used to ask `status === "completed"`, which happened to be the same set
 * because a tool failure was MISRECORDED as completed. Widening the vocabulary
 * without this predicate would have silently changed resume semantics: every
 * step whose tool returned `tooling_error`/`content_fail`/`not_available` would
 * start re-running on resume, re-spending money and repeating side effects that
 * had already happened.
 *
 * `running` is in flight and has no output. `failed` means the body THREW, so
 * there is nothing to replay. Everything else carries an outcome.
 */
export function isCheckpointedStepStatus(status: StepRecordStatus): boolean {
  return status !== "running" && status !== "failed";
}

/** One fan-out slot's checkpoint — `agentEngineRuns/{runId}/slots/{slotId}` (RFC-01 §8.4a). */
export const SlotRecordSchema = z.object({
  slotId: z.string().min(1),
  /** The `fanout()` call this slot belongs to, for scoping `listSlots`. */
  fanoutId: z.string().min(1),
  /**
   * What this slot resolved to — the same vocabulary as {@link StepRecordSchema}
   * minus `running` (a slot has no in-flight checkpoint) and minus
   * `budget_exceeded` (a slot body is arbitrary code, not an agent loop; an
   * agent loop inside it records its own step).
   *
   * Widened in AU68 / SCRUM-366. `fanout` was examined as a PRODUCER during
   * AU67 and found NOT structurally safe — `fn` is arbitrary caller code
   * exactly like `step.code`'s body, so a slot handing back a tool outcome
   * recorded `completed` for a `tooling_error`. AU67 deferred it because
   * widening this enum is not a one-line change; this is that change.
   *
   * It misreported nothing at the time, and that was a property of the six
   * `.fanout(` call sites rather than of the primitive — which is exactly the
   * kind of guarantee that stops holding the first time somebody fans out over
   * a tool call.
   */
  status: z.enum(["completed", "content_fail", "not_available", "tooling_error", "failed"]),
  output: z.unknown(),
  durationMs: z.number().nonnegative(),
  startedAt: z.number(),
  completedAt: z.number(),
  error: z.string().optional(),
});
export type SlotRecord = z.infer<typeof SlotRecordSchema>;
export type SlotRecordStatus = SlotRecord["status"];

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
 * Whether a `running` run's lease has expired, making it safe to reclaim.
 *
 * One definition, shared by both stores, because a lease rule that differs
 * between the in-memory store the tests run against and the Firestore store
 * production runs against is a rule nothing actually verifies.
 *
 * A run with NO `leaseOwner` is reclaimable on the same terms as an expired
 * one rather than being treated as claimed: that is what a run recorded before
 * this field existed looks like, and it is also exactly the abandoned shape the
 * lease was added to recover. Refusing those would leave every run stranded
 * before this change stranded forever.
 *
 * The lease is deliberately NOT a fence. A worker partitioned from Firestore
 * long enough to lose its lease while still executing will keep executing, and
 * a reclaiming worker will re-run whatever step the first one had in flight —
 * duplicated spend on that step, not corruption, since every completed step is
 * checkpointed by id and replays from its checkpoint rather than re-executing.
 * `leaseOwner` narrows that window (the stale worker stands down at its next
 * heartbeat) but does not close it; closing it needs a fencing token carried on
 * every write, which is a much larger change than the outage that prompted this.
 */
export function isReclaimableRunning(run: RunRecord, reclaimRunningBefore: number | undefined): boolean {
  if (reclaimRunningBefore === undefined) return false;
  if (run.status !== "running") return false;
  return run.updatedAt <= reclaimRunningBefore;
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
   *
   * `reclaimRunningBefore` is the LEASE. A `running` run is normally refused
   * (an execution is in flight), but a `running` run whose `updatedAt` is at or
   * before this timestamp is treated as abandoned and claimed anyway. Omit it
   * and `running` is refused unconditionally, which is the behaviour every
   * caller had before the lease existed.
   *
   * Why it is needed: on 2026-09-03 a deploy restarted the worker two minutes
   * into two runs. Pub/Sub redelivered both messages, `claimRun` refused them
   * because the status was still `running`, and both runs sat in `running`
   * forever — `updatedAt` frozen at the second they were created, no worker
   * owning them, and no path back. Any restart, deploy or scale-down did that.
   */
  claimRun(
    runId: string,
    allowedFromStatuses: readonly RunStatus[],
    patch: Partial<Omit<RunRecord, "runId">>,
    reclaimRunningBefore?: number,
  ): Promise<RunClaimResult>;

  getStep(runId: string, stepId: string): Promise<StepRecord | undefined>;
  saveStep(runId: string, step: StepRecord): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;

  getSlot(runId: string, slotId: string): Promise<SlotRecord | undefined>;
  saveSlot(runId: string, slot: SlotRecord): Promise<void>;
  listSlots(runId: string, fanoutId: string): Promise<SlotRecord[]>;

  getGate(gateId: string): Promise<GateRecord | undefined>;
  saveGate(gate: GateRecord): Promise<void>;
}
