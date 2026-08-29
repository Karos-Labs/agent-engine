import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { DEFAULT_LANE, normalizeTopic, readCatalog, writeCatalog } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const TopUpInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from performTopUp's usage.
  topics: z.array(z.string().min(1)).describe("New topics to add to the catalog floor. Idempotent per topic: adding the same topic again is a no-op."),
  /** Which lane these topics belong to (carousel-agent-v2's cadence model). Omit for a caller with no lane concept — every added row lands in `DEFAULT_LANE`. */
  lane: z
    .string()
    .min(1)
    .optional()
    .describe("Which lane these topics belong to (carousel-agent-v2's cadence model). Omit for a caller with no lane concept — every added row lands in DEFAULT_LANE."),
});
export type TopUpInput = z.infer<typeof TopUpInputSchema>;

export interface TopUpResult {
  added: number;
  catalogSize: number;
}

/**
 * The actual top-up logic, factored out of the tool wrapper so `topics.reserve`
 * can invoke it directly as a plain function call (Fix 1's proactive
 * top-up-before-floor-breach path — see `reserve.ts`) without going through
 * the tool registry a second time. Idempotent per topic: adding the same
 * topic (by trimmed, lowercased form) again is a no-op.
 */
export async function performTopUp(store: WorkspaceStoreLike, clientSlug: string, topics: string[], lane?: string): Promise<TopUpResult> {
  const catalog = await readCatalog(store, clientSlug);
  const known = new Set(catalog.map((r) => r.normalized));
  const resolvedLane = lane ?? DEFAULT_LANE;

  let added = 0;
  for (const topic of topics) {
    const normalized = normalizeTopic(topic);
    if (normalized.length === 0 || known.has(normalized)) continue;
    known.add(normalized);
    catalog.push({ topic: topic.trim(), normalized, status: "available", lane: resolvedLane });
    added++;
  }

  if (added > 0) {
    await writeCatalog(store, clientSlug, catalog);
  }

  return { added, catalogSize: catalog.length };
}

/** Idempotent per topic: adding the same topic (by trimmed, lowercased form) again is a no-op. */
export function createTopUp(store: WorkspaceStoreLike) {
  return defineTool<TopUpInput, TopUpResult>({
    name: "topics.topUp",
    description: "Adds new topics to the no-repeat catalog floor, optionally into a named lane. Idempotent per topic: adding the same topic (by trimmed, lowercased form) again is a no-op.",
    version: TOOL_VERSION,
    inputSchema: TopUpInputSchema,
    async execute({ topics, lane }, { ctx }) {
      return success<TopUpResult>(await performTopUp(store, ctx.clientSlug, topics, lane));
    },
  });
}
