import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const ReadInputSchema = z.object({
  scope: z.enum(["beliefs", "decisions", "hypotheses"]),
  /**
   * Only decisions/hypotheses recorded at or after this epoch-ms timestamp.
   * Ignored for `scope: "beliefs"` (a single merged document, not a list).
   */
  since: z.number().int().nonnegative().optional(),
  /**
   * Caps how many decisions/hypotheses come back. Applying either `since` or
   * `limit` switches the list to most-recent-first (AU12: an unbounded read
   * has no implied order beyond "whatever the store returned"; a caller
   * asking to bound history wants the recent end of it). Omitting both
   * keeps the original unbounded, store-order behavior for existing callers.
   * Ignored for `scope: "beliefs"`.
   */
  limit: z.number().int().positive().max(500).optional(),
});
export type ReadInput = z.infer<typeof ReadInputSchema>;

export interface DecisionRecord {
  decisionId: string;
  summary: string;
  rationale?: string;
  [key: string]: unknown;
}

export interface HypothesisRecord {
  hypothesisId: string;
  statement: string;
  status: "open" | "resolved";
  resolution?: string;
  evidence?: string[];
  [key: string]: unknown;
}

/**
 * A single discriminated result shape covering all three scopes — the caller
 * switches on `scope` to know which of `beliefs`/`items` is populated. Kept
 * as one type (rather than three separate tool outputs) since `read` is one
 * tool with one `execute` return type.
 */
export type ReadResult =
  | { scope: "beliefs"; beliefs: Record<string, unknown> }
  | { scope: "decisions"; items: DecisionRecord[] }
  | { scope: "hypotheses"; items: HypothesisRecord[] };

/**
 * Structured, retrieved-not-loaded-whole instance memory (RFC-01 §9.1): a
 * caller asks for one scope at a time rather than pulling the whole memory
 * document into context. An empty/default state (no beliefs set yet, no
 * decisions or hypotheses appended yet) is the normal starting condition, not
 * a missing-data error, so all three branches return `success`, never
 * `not_available`.
 */
/**
 * Bounds a history list per AU12 (`since` filters, either `since` or `limit`
 * switches to most-recent-first before `limit` truncates it). A no-op when
 * neither is given, so the unbounded default preserves its original,
 * store-order behavior for existing callers.
 */
function boundHistory<T extends Record<string, unknown>>(items: T[], since: number | undefined, limit: number | undefined): T[] {
  if (since === undefined && limit === undefined) return items;
  const at = (item: T): number => (typeof item["at"] === "number" ? (item["at"] as number) : 0);
  let result = since === undefined ? items : items.filter((item) => at(item) >= since);
  result = [...result].sort((a, b) => at(b) - at(a));
  return limit === undefined ? result : result.slice(0, limit);
}

export function createRead(store: WorkspaceStoreLike) {
  return defineTool<ReadInput, ReadResult>({
    name: "memory.read",
    version: TOOL_VERSION,
    inputSchema: ReadInputSchema,
    async execute({ scope, since, limit }, { ctx }) {
      if (scope === "beliefs") {
        const beliefs = (await store.readJson<Record<string, unknown>>(ctx.clientSlug, ["memory", "beliefs"])) ?? {};
        return success<ReadResult>({ scope: "beliefs", beliefs });
      }
      if (scope === "decisions") {
        const entries = await store.listJson<DecisionRecord>(ctx.clientSlug, ["memory", "decisions"]);
        const items = boundHistory(entries.map((e) => e.data), since, limit);
        return success<ReadResult>({ scope: "decisions", items });
      }
      const entries = await store.listJson<HypothesisRecord>(ctx.clientSlug, ["memory", "hypotheses"]);
      const items = boundHistory(entries.map((e) => e.data), since, limit);
      return success<ReadResult>({ scope: "hypotheses", items });
    },
  });
}
