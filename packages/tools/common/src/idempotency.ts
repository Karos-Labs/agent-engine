import { z } from "zod";

/**
 * The typed acknowledgement every idempotent write returns (RFC-01 §9.1 rule
 * 2 / §9.1 rule 4): a handle, not the payload back — `created` distinguishes
 * a genuinely new record from a replayed write hitting the same
 * caller-supplied key.
 */
export const IdempotentWriteResultSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
});
export type IdempotentWriteResult = z.infer<typeof IdempotentWriteResultSchema>;
