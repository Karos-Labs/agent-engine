/**
 * One JSON record per draft, stored at `["publish", "drafts", draftId]`
 * (RFC-01 §9.2) — tenant-scoped by `WorkspaceStore` construction, keyed by
 * the caller-supplied `draftId` so every write in this package is naturally
 * idempotent on that id.
 */
export interface DraftRecord {
  draftId: string;
  platform: string;
  content: unknown;
  status: "draft" | "scheduled";
  publishAt?: string;
  createdAt: number;
  updatedAt: number;
}

export function draftSegments(draftId: string): string[] {
  return ["publish", "drafts", draftId];
}
