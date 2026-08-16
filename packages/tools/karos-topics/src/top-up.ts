import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { normalizeTopic, readCatalog, writeCatalog } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const TopUpInputSchema = z.object({
  topics: z.array(z.string().min(1)),
});
export type TopUpInput = z.infer<typeof TopUpInputSchema>;

export interface TopUpResult {
  added: number;
  catalogSize: number;
}

/** Idempotent per topic: adding the same topic (by trimmed, lowercased form) again is a no-op. */
export function createTopUp(store: WorkspaceStoreLike) {
  return defineTool<TopUpInput, TopUpResult>({
    name: "topics.topUp",
    version: TOOL_VERSION,
    inputSchema: TopUpInputSchema,
    async execute({ topics }, { ctx }) {
      const catalog = await readCatalog(store, ctx.clientSlug);
      const known = new Set(catalog.map((r) => r.normalized));

      let added = 0;
      for (const topic of topics) {
        const normalized = normalizeTopic(topic);
        if (normalized.length === 0 || known.has(normalized)) continue;
        known.add(normalized);
        catalog.push({ topic: topic.trim(), normalized, status: "available" });
        added++;
      }

      if (added > 0) {
        await writeCatalog(store, ctx.clientSlug, catalog);
      }

      return success<TopUpResult>({ added, catalogSize: catalog.length });
    },
  });
}
