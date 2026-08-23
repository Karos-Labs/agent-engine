import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError, notAvailable } from "@agent-engine/tool-common";
import { latestRun, runSegments, type RunRecord } from "./runs.js";
import { ResearchBackendError, type ResearchPayload, type ResearchSearchBackend } from "./backends.js";

const TOOL_VERSION = "1.0.0";

export const PullInputSchema = z.object({
  job: z.string().min(1),
  query: z.string().min(1),
  /** Freshness window — a cached run inside this window is returned instead of re-fetching. */
  window: z.string().min(1),
  /**
   * How many sources to retrieve. The payload is injected whole into the
   * extraction agent's prompt, so this is a token bill as much as a breadth
   * setting: a handful of real sources beats a pile of them.
   */
  maxResults: z.number().int().min(1).max(10).default(4),
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
 * ## The stand-in, and why it had to go
 *
 * This shipped with no egress: the "fetch" was a deterministic stand-in
 * returning `{note: "Phase 1 stand-in...", query}`, so the caching and
 * freshness contract was real while the search was not. It was invisible in
 * exactly the way that matters. prep run pubsub-21066191524607951 is the
 * receipt: the extraction agent reported the only fact it could see ("the
 * research payload for this run is a Phase 1 stand-in with no real external
 * data fetched"), and the copy agent then wrote a client-facing carousel
 * about the broken pipeline. Nothing failed. It just produced worthless
 * content, quietly, on every content agent in the engine.
 *
 * So an unconfigured deployment now reports `not_available` rather than
 * handing back a placeholder that reads like data. That is a deliberate
 * behaviour change: a run that cannot research now stops with a reason
 * naming the missing credential, instead of drafting from nothing. Failing
 * loudly is the lesser harm — a held run costs a retry, a published carousel
 * about our own plumbing costs a client's trust.
 */
export function createPull(store: WorkspaceStoreLike, backend?: ResearchSearchBackend) {
  return defineTool<PullInput, PullResult>({
    name: "research.pull",
    version: TOOL_VERSION,
    inputSchema: PullInputSchema,
    async execute({ job, query, window, maxResults }, { ctx }) {
      const windowMs = parseDurationMs(window);
      const cached = await latestRun(store, ctx.clientSlug, job);

      if (cached) {
        const ageMs = Date.now() - cached.at;
        if (ageMs <= windowMs) {
          return success<PullResult>({ runId: cached.runId, query: cached.query, result: cached.result, fromCache: true, ageMs });
        }
      }

      if (backend === undefined) {
        return notAvailable(
          "research.pull: no external research backend configured — set APIFY_TOKEN so real sources can be fetched " +
            "(see packages/tools/karos-research/README.md). Refusing to return a placeholder payload: an agent that " +
            "drafts from one writes about the missing data instead of the topic.",
        );
      }

      let documents;
      try {
        documents = await backend.search(query, maxResults);
      } catch (error) {
        if (error instanceof ResearchBackendError) {
          // A search outage is tooling, never content. Reporting it as an
          // empty-but-successful payload is what let a broken pipeline read
          // as a topic with nothing to say about it.
          return toolingError(error.message);
        }
        throw error;
      }

      const result: ResearchPayload = {
        provider: backend.name,
        query,
        fetchedAt: new Date().toISOString(),
        documents,
        // An honest empty answer is distinguishable from a missing backend,
        // and says so in the payload the extraction agent will read.
        ...(documents.length === 0
          ? { note: `${backend.name} returned no results for this query; no facts are available for this run.` }
          : {}),
      };

      const runId = randomUUID();
      const record: RunRecord = { job, runId, query, result, at: Date.now() };
      await store.writeJson(ctx.clientSlug, runSegments(job, runId), record);

      return success<PullResult>({ runId, query, result, fromCache: false, ageMs: 0 });
    },
  });
}
