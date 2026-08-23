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
  metadata: z.record(z.string(), z.unknown()),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;
