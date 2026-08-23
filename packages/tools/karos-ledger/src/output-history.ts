import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * How many past excerpts are kept per (client, agent). Oldest are dropped.
 *
 * A window rather than the full history, because de-duplication asks "has this
 * agent said this lately", not "has it ever". An agent that legitimately
 * revisits a theme twice a year should not be flagged for it, and an unbounded
 * list would make every run's read grow without bound for a check whose value
 * is concentrated in the recent past.
 */
export const OUTPUT_HISTORY_LIMIT = 25;

/**
 * How much of a deliverable is stored. Long enough for the trigram measure to
 * have real signal, short enough that the history document stays small.
 */
export const OUTPUT_EXCERPT_MAX_CHARS = 4000;

/** One past deliverable, as much of it as is kept. */
export interface OutputHistoryEntry {
  runId: string;
  excerpt: string;
  recordedAt: number;
}

/** Where one agent's excerpt log lives for a tenant. */
function segments(agentId: string): string[] {
  return ["ledger", "output-history", agentId];
}

export const RecordOutputExcerptInputSchema = z.object({
  /** Which agent produced it — history is compared within an agent, never across. */
  agentId: z.string().min(1),
  runId: z.string().min(1),
  excerpt: z.string(),
});
export type RecordOutputExcerptInput = z.infer<typeof RecordOutputExcerptInputSchema>;

export interface RecordOutputExcerptResult {
  recorded: boolean;
  total: number;
}

/**
 * Appends this run's deliverable to the agent's excerpt log, so the NEXT run
 * has something to compare against.
 *
 * Idempotent on `runId`: a resumed or retried run re-records over its own entry
 * rather than adding a second one. Without that, a run that resumed after a
 * gate would appear in history twice and a re-run would score as similar to
 * itself.
 *
 * An empty excerpt is not recorded at all. A run that produced nothing is not
 * a precedent, and storing it would let one failed run push a real deliverable
 * out of the window.
 */
export function createRecordOutputExcerpt(store: WorkspaceStoreLike) {
  return defineTool<RecordOutputExcerptInput, RecordOutputExcerptResult>({
    name: "ledger.recordOutputExcerpt",
    version: TOOL_VERSION,
    inputSchema: RecordOutputExcerptInputSchema,
    async execute({ agentId, runId, excerpt }, { ctx }) {
      const trimmed = excerpt.trim();
      const path = segments(agentId);
      const existing = (await store.readJson<OutputHistoryEntry[]>(ctx.clientSlug, path)) ?? [];

      if (!trimmed) {
        return success<RecordOutputExcerptResult>({ recorded: false, total: existing.length });
      }

      const entry: OutputHistoryEntry = {
        runId,
        excerpt: trimmed.slice(0, OUTPUT_EXCERPT_MAX_CHARS),
        recordedAt: Date.now(),
      };
      const next = [...existing.filter((e) => e.runId !== runId), entry].slice(-OUTPUT_HISTORY_LIMIT);

      await store.writeJson(ctx.clientSlug, path, next);
      return success<RecordOutputExcerptResult>({ recorded: true, total: next.length });
    },
  });
}

export const ListOutputExcerptsInputSchema = z.object({
  agentId: z.string().min(1),
  /** Excluded from the result — a run must not be compared against itself on resume. */
  excludeRunId: z.string().min(1).optional(),
});
export type ListOutputExcerptsInput = z.infer<typeof ListOutputExcerptsInputSchema>;

export interface ListOutputExcerptsResult {
  entries: OutputHistoryEntry[];
}

/** Read-only: every excerpt still inside the window for this tenant and agent. */
export function createListOutputExcerpts(store: WorkspaceStoreLike) {
  return defineTool<ListOutputExcerptsInput, ListOutputExcerptsResult>({
    name: "ledger.listOutputExcerpts",
    version: TOOL_VERSION,
    inputSchema: ListOutputExcerptsInputSchema,
    async execute({ agentId, excludeRunId }, { ctx }) {
      const existing = (await store.readJson<OutputHistoryEntry[]>(ctx.clientSlug, segments(agentId))) ?? [];
      const entries = excludeRunId ? existing.filter((e) => e.runId !== excludeRunId) : existing;
      return success<ListOutputExcerptsResult>({ entries });
    },
  });
}
