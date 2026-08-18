import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

export type TopicStatus = "available" | "reserved" | "committed";

/**
 * The lane every topic belongs to (carousel-agent-v2 SKILL.md's cadence
 * model — setup step 04 seeds "at least two weeks of cadence per lane,
 * floor 5 unused rows per lane", and the runner's step 03 dedups and floor-
 * checks *within* the chosen lane, never across the whole catalog). Required,
 * not optional: every real topic legacy ever seeded belonged to exactly one
 * lane, so a `TopicRecord` with no lane is not a partial record, it's a data
 * bug. Callers with no lane concept of their own (every non-Instagram agent
 * in this repo today) never pass one explicitly and get `DEFAULT_LANE`
 * assigned automatically by `topics.topUp` — see that tool's own doc comment.
 */
export interface TopicRecord {
  topic: string;
  normalized: string;
  status: TopicStatus;
  lane: string;
  reservationKey?: string;
}

/**
 * The lane assigned to a topic when the caller doesn't specify one —
 * every non-Instagram caller today (blog-agent, x-agent, linkedin-agent,
 * reddit-agent, newsletter-agent, campaign-orchestrator) has no lane concept
 * of its own and never passes `lane` to `topics.topUp`/`topics.reserve`.
 * Their entire catalog lives in this one implicit lane, and since they also
 * never pass `lane` to `topics.reserve`, lane filtering/floor-checking never
 * activates for them either — this constant only matters for what gets
 * written to disk, not for any behavior change on their read path.
 */
export const DEFAULT_LANE = "general";

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
