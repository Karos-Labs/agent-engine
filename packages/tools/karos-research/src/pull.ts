import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success } from "@agent-engine/tool-common";
import { latestRun, runSegments, type RunRecord } from "./runs.js";

const TOOL_VERSION = "1.0.0";

export const PullInputSchema = z.object({
  job: z.string().min(1),
  query: z.string().min(1),
  /** Freshness window — a cached run inside this window is returned instead of re-fetching. */
  window: z.string().min(1),
});
export type PullInput = z.infer<typeof PullInputSchema>;

export interface PullResult {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
  ageMs: number;
}

/**
 * Egress-bound, cached, freshness-enforced (RFC-01 §9.2): a cached run inside
 * `window` is returned as-is; otherwise a new run is fetched and recorded.
 *
 * Phase 1 has no real external egress adapter wired up yet (that's
 * production-adapter territory, out of this package's scope) — the "fetch"
 * below is a deterministic stand-in so the freshness/caching contract this
 * tool exists to enforce is fully real and testable, while the actual HTTP
 * call is a follow-up adapter swap, not a change to this tool's contract.
 */
export function createPull(store: WorkspaceStoreLike) {
  return defineTool<PullInput, PullResult>({
    name: "research.pull",
    version: TOOL_VERSION,
    inputSchema: PullInputSchema,
    async execute({ job, query, window }, { ctx }) {
      const windowMs = parseDurationMs(window);
      const cached = await latestRun(store, ctx.clientSlug, job);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= windowMs) {
          return success<PullResult>({ runId: cached.runId, query: cached.query, result: cached.result, fromCache: true, ageMs });
        }
      }

      const runId = randomUUID();
      const result = {
        note: "Phase 1 stand-in — no real external fetch wired up yet; see packages/tools/karos-research/src/pull.ts",
        query,
      };
      const record: RunRecord = { job, runId, query, result, at: Date.now() };
      await store.writeJson(ctx.clientSlug, runSegments(job, runId), record);

      return success<PullResult>({ runId, query, result, fromCache: false, ageMs: 0 });
    },
  });
}
