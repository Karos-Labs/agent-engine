import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import type { HypothesisRecord } from "./read.js";

const TOOL_VERSION = "1.0.0";

export const ResolveHypothesisInputSchema = z.object({
  hypothesisId: z.string().min(1),
  resolution: z.string().min(1),
  evidence: z.array(z.string()).optional(),
});
export type ResolveHypothesisInput = z.infer<typeof ResolveHypothesisInputSchema>;

export interface ResolveHypothesisResult {
  hypothesisId: string;
  status: "resolved";
}

/**
 * Transitions an existing hypothesis to `status: "resolved"`. If no
 * hypothesis exists for `hypothesisId` yet, that's the legitimate
 * "doesn't exist yet" case (RFC-01 §6) — returns `not_available` rather than
 * throwing or `content_fail`.
 *
 * Resolving the same hypothesis twice (even with different resolutions) is
 * not a special case: it just overwrites the record at the same path, same
 * as any other write here. There's no separate idempotency key to track
 * because the write target (`hypothesisId`) is already the natural one.
 */
export function createResolveHypothesis(store: WorkspaceStoreLike) {
  return defineTool<ResolveHypothesisInput, ResolveHypothesisResult>({
    name: "memory.resolveHypothesis",
    version: TOOL_VERSION,
    inputSchema: ResolveHypothesisInputSchema,
    async execute({ hypothesisId, resolution, evidence }, { ctx }) {
      const segments = ["memory", "hypotheses", hypothesisId];
      const existing = await store.readJson<HypothesisRecord>(ctx.clientSlug, segments);
      if (existing === undefined) {
        return notAvailable(`no hypothesis found for id "${hypothesisId}"`);
      }

      await store.writeJson(ctx.clientSlug, segments, {
        ...existing,
        status: "resolved" as const,
        resolution,
        ...(evidence !== undefined ? { evidence } : {}),
        resolvedAt: Date.now(),
      });
      return success<ResolveHypothesisResult>({ hypothesisId, status: "resolved" });
    },
  });
}
