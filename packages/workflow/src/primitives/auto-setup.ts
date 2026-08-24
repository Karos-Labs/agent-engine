import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";

/**
 * Inline onboarding, run as a workflow's own first step instead of as a
 * separate agent somebody has to remember to dispatch.
 *
 * ## Why this is inline and not another setup product
 *
 * The engine already has detached setup agents (`linkedin-setup-agent`,
 * `reddit-setup-agent`), and they work — for the channels they cover, when
 * someone runs them. What they cannot do is stop a drafting run that was
 * dispatched against a client who was never set up. That failure has a shape,
 * and it is documented at length inside
 * `agents/instagram-agent/.../create-instagram-agent-workflow.ts`'s step 03:
 *
 *   "nothing in this repo ever seeds a topics catalog with real rows
 *   (`topics.topUp` is called by exactly one caller — `topics.reserve`'s own
 *   proactive top-up, with an empty array, a documented no-op), so a client
 *   whose catalog was never seeded out of band could not run this agent AT
 *   ALL. Every run died at step 03."
 *
 * That step now falls back rather than dying, which fixed the outage but left
 * the cause: a client with no catalog runs *permanently* in fallback, which
 * means permanently without the dedup lock the catalog exists to provide. This
 * closes that by seeding the catalog on the way past.
 *
 * ## It seeds from real research, never from invention
 *
 * The topics written here are the titles of documents `research.pull` actually
 * retrieved. That matters: a deterministic code step inventing plausible
 * subjects is exactly the fabrication the step-03 comment refuses, and this
 * helper is a code step. Real headlines are real subjects, attributable to a
 * URL, so seeding from them adds no claim the engine cannot stand behind.
 *
 * ## It never fails a run
 *
 * Every problem degrades to a recorded reason. Setup is an improvement to the
 * conditions a run executes under, not a precondition for executing: a client
 * whose catalog could not be seeded should still get their post, through the
 * same fallback that carried them before this existed.
 */

export interface AutoSetupOptions {
  tools: AgentToolRegistry;
  ctx: AgentContext;
  /** Lane the seeded topics belong to. Omit for agents with no lane concept. */
  lane?: string;
  /**
   * Catalog size at or above which setup does nothing. A healthy client must
   * not pay for a research call on every run.
   */
  minimumCatalogSize?: number;
  /** Cache key for the seeding research, so repeated runs reuse one fetch. */
  researchJob?: string;
  /** What to research for topic candidates. Usually built from the client's own industry. */
  researchQuery: string;
  /** Freshness window for that research. */
  researchWindow?: string;
}

export interface AutoSetupResult {
  /** True when the catalog was actually seeded. */
  ran: boolean;
  catalogSizeBefore: number;
  catalogSizeAfter: number;
  topicsAdded: number;
  /** What was missing, or why nothing was done. Always populated. */
  notes: string[];
}

/** Below this the catalog cannot support a reservation, so seeding is worth a research call. */
const DEFAULT_MINIMUM_CATALOG_SIZE = 3;

export async function runAutoSetup(options: AutoSetupOptions): Promise<AutoSetupResult> {
  const { tools, ctx, lane, researchQuery } = options;
  const minimum = options.minimumCatalogSize ?? DEFAULT_MINIMUM_CATALOG_SIZE;
  const notes: string[] = [];

  const topUp = tools["topics.topUp"];
  if (topUp === undefined) {
    return { ran: false, catalogSizeBefore: 0, catalogSizeAfter: 0, topicsAdded: 0, notes: ["topics.topUp is not registered; nothing to seed with"] };
  }

  // An empty top-up is a documented no-op that still returns `catalogSize`,
  // which makes it the cheapest way to ask how big the catalog is without
  // adding a read-only tool for one caller.
  const inspect = await topUp.execute({ topics: [], ...(lane ? { lane } : {}) }, { ctx });
  if (inspect.status !== "success") {
    return { ran: false, catalogSizeBefore: 0, catalogSizeAfter: 0, topicsAdded: 0, notes: [`could not inspect the topic catalog: ${inspect.status}`] };
  }
  const catalogSizeBefore = (inspect.result as { catalogSize: number }).catalogSize;

  if (catalogSizeBefore >= minimum) {
    return {
      ran: false,
      catalogSizeBefore,
      catalogSizeAfter: catalogSizeBefore,
      topicsAdded: 0,
      notes: [`catalog already holds ${catalogSizeBefore} topic(s); setup not needed`],
    };
  }
  notes.push(`catalog holds ${catalogSizeBefore} topic(s), below the minimum of ${minimum}`);

  const research = tools["research.pull"];
  if (research === undefined) {
    notes.push("research.pull is not registered, so no real topics could be sourced");
    return { ran: false, catalogSizeBefore, catalogSizeAfter: catalogSizeBefore, topicsAdded: 0, notes };
  }

  const pulled = await research.execute(
    {
      job: options.researchJob ?? "auto-setup-topic-seed",
      query: researchQuery,
      window: options.researchWindow ?? "24h",
      maxResults: 6,
    },
    { ctx },
  );

  if (pulled.status !== "success") {
    // `not_available` (no scraper configured) and `tooling_error` (an outage)
    // both land here. Neither is a reason to stop the run: the caller's own
    // fallback still works, it just works without a dedup lock.
    notes.push(
      `research for topic seeding was unusable (${pulled.status}${"reason" in pulled ? `: ${pulled.reason}` : ""}), so the catalog was left as it is`,
    );
    return { ran: false, catalogSizeBefore, catalogSizeAfter: catalogSizeBefore, topicsAdded: 0, notes };
  }

  const payload = (pulled.result as { result?: { documents?: Array<{ title?: string }> } }).result;
  const candidates = (payload?.documents ?? [])
    .map((d) => (d.title ?? "").trim())
    .filter((t) => t.length > 0)
    // A page title long enough to be a paragraph is a page title, not a topic.
    .filter((t) => t.length <= 120);

  if (candidates.length === 0) {
    notes.push("the research returned no usable titles to seed topics from");
    return { ran: false, catalogSizeBefore, catalogSizeAfter: catalogSizeBefore, topicsAdded: 0, notes };
  }

  const seeded = await topUp.execute({ topics: candidates, ...(lane ? { lane } : {}) }, { ctx });
  if (seeded.status !== "success") {
    notes.push(`seeding the catalog failed: ${seeded.status}`);
    return { ran: false, catalogSizeBefore, catalogSizeAfter: catalogSizeBefore, topicsAdded: 0, notes };
  }

  const { added, catalogSize } = seeded.result as { added: number; catalogSize: number };
  notes.push(`seeded ${added} topic(s) from ${candidates.length} researched title(s)`);
  return { ran: added > 0, catalogSizeBefore, catalogSizeAfter: catalogSize, topicsAdded: added, notes };
}
