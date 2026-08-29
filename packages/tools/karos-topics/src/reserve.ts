import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, success } from "@agent-engine/tool-common";
import { normalizeTopic, readCatalog, reservationSegments, writeCatalog, type ReservationRecord } from "./catalog.js";
import { performTopUp } from "./top-up.js";

const TOOL_VERSION = "1.0.0";

/**
 * carousel-agent-v2 SKILL.md setup step 04: "floor 5 unused rows per lane."
 * Below this, the runner is expected to invent+append new evidenced
 * candidates before picking (step 03) rather than deplete the lane further.
 */
export const LANE_FLOOR = 5;

export const ReserveInputSchema = z.object({
  /** Caller-supplied idempotency key (RFC-01 §9.1 rule 2) — replaying it returns the same reservation, never a second one. */
  reservationKey: z.string().min(1).describe("Caller-supplied idempotency key — replaying it returns the same reservation, never a second one."),
  // count/excludeTopics have no existing TSDoc to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  count: z.number().int().positive().describe("How many topics to reserve off the catalog floor."),
  excludeTopics: z.array(z.string()).default([]).describe("Topics to exclude from consideration even if available on the floor."),
  /**
   * Optional lane filter + floor guard (carousel-agent-v2's cadence model —
   * SKILL.md step 03: "candidates are unused rows in the lane chosen at step
   * 01" / "below the floor of 5 unused rows in that lane, invent new
   * candidates... before picking. Never pick from a lane you just emptied.").
   *
   * Omitted entirely (the only mode every non-Instagram caller in this repo
   * uses today — blog-agent, x-agent, linkedin-agent, reddit-agent,
   * newsletter-agent, campaign-orchestrator): behaves exactly as this tool
   * always has — every available topic regardless of lane is eligible, and
   * no floor check or proactive top-up ever runs. This field is additive and
   * changes nothing for a caller that doesn't pass it.
   */
  lane: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional lane filter + floor guard (carousel-agent-v2's cadence model). Omitted (the default): every available topic regardless of lane is eligible, and no floor check or proactive top-up ever runs.",
    ),
});
export type ReserveInput = z.infer<typeof ReserveInputSchema>;

export interface ReserveResult {
  reservationKey: string;
  topics: string[];
  created: boolean;
}

/**
 * Reserves `count` topics off the no-repeat catalog floor. Idempotent on
 * `reservationKey`: a retried call with the same key returns the exact same
 * reservation instead of consuming more of the catalog.
 *
 * When `lane` is supplied, this also owns the "floor of 5" guard end to end
 * (a deliberate choice over pushing it into the workflow layer, documented
 * here rather than in the caller): before counting anything, it checks the
 * lane's current total available-row count against `LANE_FLOOR` and, if
 * already at or below it, proactively calls `performTopUp` (Fix 1's
 * topics.topUp wiring) so a well-behaved run tops up *before* this
 * reservation would consume more of an already-thin lane. Phase 1 has no
 * real "invent new evidenced topics" capability anywhere in this repo yet
 * (the same documented class of gap as `research.pull`'s own stand-in
 * search backend) — this call passes an empty topics array, so it is a
 * real, exercised call that is a genuine no-op until that capability exists,
 * never a fabricated one. After that (whether or not it did anything), a
 * reservation that would leave the lane below the floor is refused as a
 * `content_fail` naming the lane and the shortfall — a genuine floor breach,
 * not a tooling error, so a caller can `WorkflowHeld` on it exactly like an
 * empty-catalog breach already does.
 */
export function createReserve(store: WorkspaceStoreLike) {
  return defineTool<ReserveInput, ReserveResult>({
    name: "topics.reserve",
    description:
      "Reserves `count` topics off the no-repeat catalog floor. Idempotent on reservationKey. When lane is supplied, also enforces and proactively tops up against the lane's floor of 5 unused rows, refusing (content_fail) a reservation that would breach it.",
    version: TOOL_VERSION,
    inputSchema: ReserveInputSchema,
    async execute({ reservationKey, count, excludeTopics, lane }, { ctx }) {
      const existing = await store.readJson<ReservationRecord>(ctx.clientSlug, reservationSegments(reservationKey));
      if (existing) {
        return success<ReserveResult>({ reservationKey, topics: existing.topics, created: false });
      }

      const excluded = new Set(excludeTopics.map(normalizeTopic));
      let catalog = await readCatalog(store, ctx.clientSlug);

      let laneAvailableTotal: number | undefined;
      if (lane !== undefined) {
        laneAvailableTotal = catalog.filter((r) => r.status === "available" && r.lane === lane).length;
        if (laneAvailableTotal <= LANE_FLOOR) {
          // Proactive top-up BEFORE this reservation touches the lane (Fix 1) —
          // see this function's own doc comment for why this is a documented
          // no-op today, not a fabricated capability.
          await performTopUp(store, ctx.clientSlug, [], lane);
          catalog = await readCatalog(store, ctx.clientSlug);
          laneAvailableTotal = catalog.filter((r) => r.status === "available" && r.lane === lane).length;
        }
      }

      const available = catalog.filter((r) => r.status === "available" && !excluded.has(r.normalized) && (lane === undefined || r.lane === lane));

      if (available.length < count) {
        return contentFail<ReserveResult>(
          `only ${available.length} of the ${count} requested topics are available${lane !== undefined ? ` in lane "${lane}"` : ""} on the catalog floor`,
        );
      }

      if (lane !== undefined) {
        const remainingAfterReserve = laneAvailableTotal! - count;
        if (remainingAfterReserve < LANE_FLOOR) {
          return contentFail<ReserveResult>(
            `reserving ${count} topic(s) from lane "${lane}" would leave only ${remainingAfterReserve} unused row(s), below the floor of ${LANE_FLOOR} — holding rather than depleting the lane's cadence buffer`,
          );
        }
      }

      const chosen = available.slice(0, count);
      const chosenNormalized = new Set(chosen.map((r) => r.normalized));
      for (const record of catalog) {
        if (chosenNormalized.has(record.normalized)) {
          record.status = "reserved";
          record.reservationKey = reservationKey;
        }
      }
      await writeCatalog(store, ctx.clientSlug, catalog);

      const topics = chosen.map((r) => r.topic);
      const reservation: ReservationRecord = { reservationKey, topics, status: "reserved" };
      await store.writeJson(ctx.clientSlug, reservationSegments(reservationKey), reservation);

      return success<ReserveResult>({ reservationKey, topics, created: true });
    },
  });
}
