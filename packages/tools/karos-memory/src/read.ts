import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const ReadInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  scope: z.enum(["beliefs", "decisions", "hypotheses"]).describe("Which slice of instance memory to retrieve — one scope at a time rather than the whole memory document."),
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
export function createRead(store: WorkspaceStoreLike) {
  return defineTool<ReadInput, ReadResult>({
    name: "memory.read",
    description:
      "Structured, retrieved-not-loaded-whole instance memory: reads one scope (beliefs, decisions, or hypotheses) at a time. An empty/default state is the normal starting condition, never not_available.",
    version: TOOL_VERSION,
    inputSchema: ReadInputSchema,
    async execute({ scope }, { ctx }) {
      if (scope === "beliefs") {
        const beliefs = (await store.readJson<Record<string, unknown>>(ctx.clientSlug, ["memory", "beliefs"])) ?? {};
        return success<ReadResult>({ scope: "beliefs", beliefs });
      }
      if (scope === "decisions") {
        const entries = await store.listJson<DecisionRecord>(ctx.clientSlug, ["memory", "decisions"]);
        return success<ReadResult>({ scope: "decisions", items: entries.map((e) => e.data) });
      }
      const entries = await store.listJson<HypothesisRecord>(ctx.clientSlug, ["memory", "hypotheses"]);
      return success<ReadResult>({ scope: "hypotheses", items: entries.map((e) => e.data) });
    },
  });
}
