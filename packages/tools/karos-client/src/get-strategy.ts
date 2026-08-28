import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * Where a client's per-agent setup document lives:
 * `clients/<clientSlug>/strategy/<agent>.json`.
 *
 * The workspace store appends `.json` and stores a record per key, so the
 * markdown rides inside a `{ markdown }` envelope — the same shape
 * `landing/intake.json` already uses for the landing bundle's `intake.md`.
 */
const SEGMENT = "strategy";

export const GetStrategyInputSchema = z.object({
  agent: z
    .string()
    .min(1)
    .describe(
      "Which agent's setup document to read, e.g. \"x-agent\". Distinct from the running product id on purpose: two products can share one strategy document, and a document can outlive the agent that first needed it.",
    ),
  key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional sub-document — a per-seat or per-account intake rather than the account-level one. Kept separate because it can describe a different voice and must never be blended into the account-level document.",
    ),
});
export type GetStrategyInput = z.infer<typeof GetStrategyInputSchema>;

export interface StrategyDocument {
  agent: string;
  key: string | null;
  markdown: string;
  /**
   * The same charter as machine-readable fields, when whatever wrote it had
   * them.
   *
   * `markdown` is what reaches a model, and for a long time it was the only
   * thing stored — which is fine for a prompt and useless to a code step. The
   * reddit channel setup records a list of subreddits that `00-intake-check`
   * has to compare against, and re-parsing prose to recover a list somebody
   * already had as an array is the kind of round trip that works until a
   * heading is reworded.
   *
   * Optional and untyped here on purpose: each agent knows the shape of its own
   * charter, and this package is a read-only view that should not have to.
   */
  data?: Record<string, unknown>;
  /** Free-form provenance the migration records (source path, commit, date). */
  source?: Record<string, unknown>;
}

/**
 * `client.getStrategy` — the client's own setup/strategy document for one
 * agent, as dynamic run context.
 *
 * These are the filled-in intake forms that decide what an account is *for*:
 * what it should be known for, what it must never post, which accounts it
 * engages. In the lab repo they live as markdown under
 * `clients/<slug>/internal/<agent>/`, and until now nothing in agent-engine
 * could read them — a run only ever saw profile/brand/voice-rules, which say
 * how the client sounds but not what this particular account is chartered to
 * do.
 *
 * `not_available` rather than an error when absent: a client who has not been
 * set up for an agent is an ordinary state, and the caller decides whether
 * that is fatal. `x-agent` treats a missing document as blocked intake; a
 * caller that can proceed without one is free to.
 */
export function createGetStrategy(store: WorkspaceStoreLike) {
  return defineTool<GetStrategyInput, StrategyDocument>({
    name: "client.getStrategy",
    description:
      "The client's own setup/strategy document for one agent, as dynamic run context: what an account is chartered to post, what it must never post, and which accounts it engages. Reports not_available (not an error) when the client has not been set up for this agent.",
    version: TOOL_VERSION,
    inputSchema: GetStrategyInputSchema,
    async execute({ agent, key }, { ctx }) {
      const segments = key ? [SEGMENT, agent, key] : [SEGMENT, agent];
      const doc = await store.readJson<{
        markdown?: unknown;
        data?: Record<string, unknown>;
        source?: Record<string, unknown>;
      }>(ctx.clientSlug, segments);

      if (!doc) {
        return notAvailable<StrategyDocument>(
          `no ${agent} setup document for client "${ctx.clientSlug}"${key ? ` (key "${key}")` : ""} — expected clients/${ctx.clientSlug}/${segments.join("/")}.json`,
        );
      }
      if (typeof doc.markdown !== "string" || doc.markdown.trim().length === 0) {
        // An empty document is worse than a missing one: it would silently
        // hand the model no charter while looking configured.
        return notAvailable<StrategyDocument>(
          `the ${agent} setup document for client "${ctx.clientSlug}" has no "markdown" content`,
        );
      }

      return success<StrategyDocument>({
        agent,
        key: key ?? null,
        markdown: doc.markdown,
        ...(doc.data ? { data: doc.data } : {}),
        ...(doc.source ? { source: doc.source } : {}),
      });
    },
  });
}
