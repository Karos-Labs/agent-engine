import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const ReadInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  scope: z.enum(["beliefs", "decisions", "hypotheses"]).describe("Which slice of instance memory to retrieve — one scope at a time rather than the whole memory document."),
  /**
   * Only decisions/hypotheses recorded at or after this epoch-ms timestamp.
   * Ignored for `scope: "beliefs"` (a single merged document, not a list).
   */
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Only decisions/hypotheses recorded at or after this epoch-ms timestamp. Ignored for scope 'beliefs', which is a single merged document rather than a list."),
  /**
   * Caps how many decisions/hypotheses come back. Applying either `since` or
   * `limit` switches the list to most-recent-first (AU12: an unbounded read
   * has no implied order beyond "whatever the store returned"; a caller
   * asking to bound history wants the recent end of it). Omitting both
   * keeps the original unbounded, store-order behavior for existing callers.
   * Ignored for `scope: "beliefs"`.
   */
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Caps how many decisions/hypotheses come back. Passing either since or limit switches the list to most-recent-first; omitting both keeps the unbounded store order. Ignored for scope 'beliefs'."),
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
    description:
      "Structured, retrieved-not-loaded-whole instance memory: reads one scope (beliefs, decisions, or hypotheses) at a time. An empty/default state is the normal starting condition, never not_available.",
    version: TOOL_VERSION,
    inputSchema: ReadInputSchema,
    async execute({ scope, since, limit }, { ctx }) {
      if (scope === "beliefs") {
        const beliefs = (await store.readJson<Record<string, unknown>>(ctx.clientSlug, ["memory", "beliefs"])) ?? {};
        return success<ReadResult>({ scope: "beliefs", beliefs });
      }
      if (scope === "decisions") {
        // Product-scoped (AU24) — see the matching note on `createAppendDecision`.
        // Deliberately NOT merged with any pre-fix, client-wide-only decision rows
        // still sitting on disk at the old `["memory","decisions",...]` path: those
        // rows carry no `productId` field (the schema never had one), so there is no
        // reliable way to attribute an old row to one product without guessing from
        // its free-text `summary` — which is exactly the kind of silent, looks-right-
        // isn't guess this fix exists to remove. A client's per-product rotation state
        // (e.g. LinkedIn's "last archetype") starts empty the first run after this
        // ships rather than being backfilled from a guess; see the package README for
        // the full migration note.
        const entries = await store.listJson<DecisionRecord>(ctx.clientSlug, ["memory", "products", ctx.productId, "decisions"]);
        const items = boundHistory(entries.map((e) => e.data), since, limit);
        return success<ReadResult>({ scope: "decisions", items });
      }
      const entries = await store.listJson<HypothesisRecord>(ctx.clientSlug, ["memory", "hypotheses"]);
      const items = boundHistory(entries.map((e) => e.data), since, limit);
      return success<ReadResult>({ scope: "hypotheses", items });
    },
  });
}
