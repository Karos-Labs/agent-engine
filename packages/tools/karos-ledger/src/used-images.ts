import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["ledger", "used-images"] as const;

/**
 * Cross-post image-reuse prevention (P0 parity audit Fix 3, agents/instagram-agent
 * vs carousel-agent-v2 SKILL.md's core rule 8: "never repeat a picture across
 * slides, posts or examples"). Before this, the image-vetting step could only
 * see the current carousel's own candidate pool — nothing checked a candidate
 * against images already shipped in a client's *prior* posts.
 *
 * This is a lightweight, purpose-built persisted set rather than a query over
 * `ledger.writeDeliverable`'s past records: `karos-ledger` ships no "list past
 * deliverables and pull out every image path" query tool today, and building
 * one would mean walking every historical deliverable's product-specific
 * shape (Instagram's `slides[].images.hero` is not a shape any other product
 * shares) just to reconstruct what this flat set gives directly. A workflow
 * calls `ledger.recordUsedImages` once a post actually ships (never before —
 * an image that never shipped was never "used") and `ledger.listUsedImages`
 * before vetting the next carousel's candidates.
 */
export const RecordUsedImagesInputSchema = z.object({
  imagePaths: z.array(z.string().min(1)),
});
export type RecordUsedImagesInput = z.infer<typeof RecordUsedImagesInputSchema>;

export interface RecordUsedImagesResult {
  added: number;
  total: number;
}

/** Idempotent per path: recording the same image path again (a resumed/retried delivery) is a no-op. */
export function createRecordUsedImages(store: WorkspaceStoreLike) {
  return defineTool<RecordUsedImagesInput, RecordUsedImagesResult>({
    name: "ledger.recordUsedImages",
    version: TOOL_VERSION,
    inputSchema: RecordUsedImagesInputSchema,
    async execute({ imagePaths }, { ctx }) {
      const existing = (await store.readJson<string[]>(ctx.clientSlug, [...SEGMENTS])) ?? [];
      const known = new Set(existing);

      let added = 0;
      for (const imagePath of imagePaths) {
        if (imagePath.length === 0 || known.has(imagePath)) continue;
        known.add(imagePath);
        existing.push(imagePath);
        added++;
      }

      if (added > 0) {
        await store.writeJson(ctx.clientSlug, [...SEGMENTS], existing);
      }

      return success<RecordUsedImagesResult>({ added, total: existing.length });
    },
  });
}

export const ListUsedImagesInputSchema = z.object({});
export type ListUsedImagesInput = z.infer<typeof ListUsedImagesInputSchema>;

export interface ListUsedImagesResult {
  imagePaths: string[];
}

/** Read-only lookup of every image path ever recorded as used for this tenant, across every prior post. */
export function createListUsedImages(store: WorkspaceStoreLike) {
  return defineTool<ListUsedImagesInput, ListUsedImagesResult>({
    name: "ledger.listUsedImages",
    version: TOOL_VERSION,
    inputSchema: ListUsedImagesInputSchema,
    async execute(_input, { ctx }) {
      const existing = (await store.readJson<string[]>(ctx.clientSlug, [...SEGMENTS])) ?? [];
      return success<ListUsedImagesResult>({ imagePaths: existing });
    },
  });
}
