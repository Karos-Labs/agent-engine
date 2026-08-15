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
  metadata: z.record(z.string(), z.unknown()),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;
