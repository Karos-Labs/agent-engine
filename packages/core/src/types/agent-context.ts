import { z } from "zod";

/**
 * The kind of run a step is executing inside — drives which Layer 1 workflow
 * shape is producing it (RFC-01 §5.1 / §8).
 */
export const RunKindSchema = z.enum(["setup", "recurring", "manager", "orchestrator"]);
export type RunKind = z.infer<typeof RunKindSchema>;

/**
 * Identity threaded through every BaseAgent step and every Layer 3 tool call.
 * Tenant (`clientSlug`/`productId`) is bound here and never accepted as a
 * model-supplied tool argument — see RFC-01 §9.1 rule 1.
 */
export const AgentContextSchema = z.object({
  runId: z.string().min(1),
  clientSlug: z.string().min(1),
  productId: z.string().min(1),
  /** Set when this step is one unit of a fan-out. */
  slotId: z.string().min(1).optional(),
  runKind: RunKindSchema,
  /**
   * Per-stage model overrides for THIS run, keyed by the stage's
   * `AgentStepConfig.id` — Studio's per-stage model selection, delivered at
   * dispatch.
   *
   * It rides on the context rather than being threaded into every agent's
   * constructor because that is the one place every step already passes
   * through: `BaseAgent.runOneTurn` has `ctx` in hand at the moment it calls
   * the router, so one resolution point covers all fourteen hand-written
   * agents and the dynamic runner alike. The alternative was editing every
   * agent class, and the classes that got missed would have failed silently
   * by continuing to use their compiled-in default.
   *
   * A stage id that names nothing is ignored, not an error: the map is
   * authored against a stage list that can change under it, and a stale key
   * should not take down a run that is otherwise fine.
   */
  stageModels: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * The language THIS client publishes in — AU31/SCRUM-309's BrandKit
   * `language` field, read once per run from the tenant's own stored
   * configuration (`loadClientContentLanguage`) and threaded down here rather
   * than re-read per step.
   *
   * It rides on the context for the same reason `stageModels` does, and for
   * one more: Layer 2 has no I/O except through Layer 3 tools (RFC-01 §4), so
   * a `BaseAgent` cannot go and read the workspace store itself. The read
   * happens once, at dispatch, where the store is already in hand; every step
   * of the run then sees the same value, and `applyClientLanguagePolicy`
   * (AU34/SCRUM-312) uses it to re-point copy steps at a model that can
   * actually write in it.
   *
   * Free text on purpose ("Hebrew", "he", "he-IL") — it is AU31's field
   * verbatim, not a re-normalized copy of it. Absent means "this client has
   * stated nothing", which leaves every step on exactly the model it had.
   */
  contentLanguage: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;
