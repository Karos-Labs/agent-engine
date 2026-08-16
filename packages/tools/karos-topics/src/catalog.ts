import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

export type TopicStatus = "available" | "reserved" | "committed";

export interface TopicRecord {
  topic: string;
  normalized: string;
  status: TopicStatus;
  reservationKey?: string;
}

export interface ReservationRecord {
  reservationKey: string;
  topics: string[];
  status: "reserved" | "committed" | "released";
}

export const CATALOG_SEGMENTS = ["topics", "catalog"] as const;

export function reservationSegments(reservationKey: string): string[] {
  return ["topics", "reservations", reservationKey];
}

export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

export async function readCatalog(store: WorkspaceStoreLike, clientSlug: string): Promise<TopicRecord[]> {
  return (await store.readJson<TopicRecord[]>(clientSlug, [...CATALOG_SEGMENTS])) ?? [];
}

export async function writeCatalog(store: WorkspaceStoreLike, clientSlug: string, catalog: TopicRecord[]): Promise<void> {
  await store.writeJson(clientSlug, [...CATALOG_SEGMENTS], catalog);
}
