import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosTopicsTools } from "../src/index.js";
import { LANE_FLOOR } from "../src/reserve.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "instagram-agent",
  runKind: "recurring",
  metadata: {},
};

/**
 * Fix 1 (P0 parity audit, agents/instagram-agent vs carousel-agent-v2
 * SKILL.md step 03): the topic catalog's "floor of 5 unused rows per lane"
 * is restored as a real, lane-scoped guard in `topics.reserve`, plus the
 * proactive `topics.topUp` wiring below the floor. These tests exercise the
 * lane filter, the floor breach, and the proactive top-up call independent
 * of `agents/instagram-agent`'s own workflow-level tests.
 */
describe("topics.reserve: lane filter + floor of 5 (carousel-agent-v2 SKILL.md step 03)", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosTopicsTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-topics-lane-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosTopicsTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("filters candidates to the requested lane, never borrowing rows from a different lane", async () => {
    // Lane-x has NO rows at all; lane-y is well-stocked. If lane filtering
    // leaked, reserving from lane-x would silently succeed off lane-y's pool.
    await tools["topics.topUp"]!.execute({ topics: ["c-lane-y", "d-lane-y", "e-lane-y", "f-lane-y", "g-lane-y", "h-lane-y"], lane: "lane-y" }, { ctx });

    const result = await tools["topics.reserve"]!.execute({ reservationKey: "res_x", count: 1, excludeTopics: [], lane: "lane-x" }, { ctx });
    expect(result.status).toBe("content_fail");
    if (result.status !== "content_fail") throw new Error("unreachable");
    expect(result.reason).toMatch(/lane "lane-x"/);
    expect(result.reason).toMatch(/only 0 of the 1 requested/);
  });

  it("reports a genuine floor breach (naming the lane and the shortfall) when reserving would leave the lane below the floor of 5", async () => {
    // Exactly at the floor: 5 unused rows in "quarterly-wins".
    await tools["topics.topUp"]!.execute(
      { topics: ["topic-1", "topic-2", "topic-3", "topic-4", "topic-5"], lane: "quarterly-wins" },
      { ctx },
    );

    const result = await tools["topics.reserve"]!.execute(
      { reservationKey: "res_1", count: 1, excludeTopics: [], lane: "quarterly-wins" },
      { ctx },
    );

    expect(result.status).toBe("content_fail");
    if (result.status !== "content_fail") throw new Error("unreachable");
    expect(result.reason).toMatch(/lane "quarterly-wins"/);
    expect(result.reason).toMatch(/floor of 5/);

    // Nothing was actually reserved -- a floor breach must never partially consume the lane.
    const catalog = await store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.every((r) => r.status === "available")).toBe(true);
  });

  it("does NOT breach the floor when enough headroom remains after the reservation", async () => {
    await tools["topics.topUp"]!.execute(
      { topics: ["topic-1", "topic-2", "topic-3", "topic-4", "topic-5", "topic-6"], lane: "quarterly-wins" },
      { ctx },
    );

    // 6 available, reserving 1 leaves exactly 5 -- at the floor, not below it.
    const result = await tools["topics.reserve"]!.execute(
      { reservationKey: "res_1", count: 1, excludeTopics: [], lane: "quarterly-wins" },
      { ctx },
    );
    expect(result.status).toBe("success");
  });

  it("reserving from a DIFFERENT lane than the one near its floor is completely unaffected", async () => {
    // "quarterly-wins" is critically low (at the floor)...
    await tools["topics.topUp"]!.execute(
      { topics: ["topic-1", "topic-2", "topic-3", "topic-4", "topic-5"], lane: "quarterly-wins" },
      { ctx },
    );
    // ...but "behind-the-scenes" is healthy.
    await tools["topics.topUp"]!.execute(
      { topics: ["bts-1", "bts-2", "bts-3", "bts-4", "bts-5", "bts-6", "bts-7", "bts-8"], lane: "behind-the-scenes" },
      { ctx },
    );

    const otherLaneResult = await tools["topics.reserve"]!.execute(
      { reservationKey: "res_bts", count: 2, excludeTopics: [], lane: "behind-the-scenes" },
      { ctx },
    );
    expect(otherLaneResult.status).toBe("success");
    expect((otherLaneResult as { result: { topics: string[] } }).result.topics).toHaveLength(2);

    // "quarterly-wins" is still exactly as it was -- reserving from the other
    // lane must never touch it.
    const stillBreaches = await tools["topics.reserve"]!.execute(
      { reservationKey: "res_qw", count: 1, excludeTopics: [], lane: "quarterly-wins" },
      { ctx },
    );
    expect(stillBreaches.status).toBe("content_fail");
  });

  it("proactively invokes the topics.topUp path when a lane is at or below the floor before reserving (exercised, not just asserted by outcome)", async () => {
    // Seed a lane comfortably above the floor and one sitting exactly at it.
    await tools["topics.topUp"]!.execute({ topics: ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10"], lane: "healthy-lane" }, { ctx });
    await tools["topics.topUp"]!.execute({ topics: ["t1", "t2", "t3", "t4", "t5"], lane: "thin-lane" }, { ctx });

    const readSpy = vi.spyOn(store, "readJson");

    // Above the floor: no proactive top-up needed, so the catalog is read
    // exactly once (the initial read inside topics.reserve itself).
    readSpy.mockClear();
    await tools["topics.reserve"]!.execute({ reservationKey: "res_healthy", count: 1, excludeTopics: [], lane: "healthy-lane" }, { ctx });
    const catalogReadsHealthy = readSpy.mock.calls.filter((call) => call[1]?.[0] === "topics" && call[1]?.[1] === "catalog").length;
    expect(catalogReadsHealthy).toBe(1);

    // At the floor: the proactive top-up path runs (a real call into
    // performTopUp, itself reading the catalog once), plus this function's
    // own post-top-up re-read -- three catalog reads total, not one.
    readSpy.mockClear();
    await tools["topics.reserve"]!.execute({ reservationKey: "res_thin", count: 1, excludeTopics: [], lane: "thin-lane" }, { ctx });
    const catalogReadsThin = readSpy.mock.calls.filter((call) => call[1]?.[0] === "topics" && call[1]?.[1] === "catalog").length;
    expect(catalogReadsThin).toBeGreaterThan(catalogReadsHealthy);

    readSpy.mockRestore();
  });

  it("a lane omitted entirely behaves exactly as before: no filter, no floor check (backward compatibility for non-Instagram callers)", async () => {
    await tools["topics.topUp"]!.execute({ topics: ["only-one"] }, { ctx }); // no lane -> DEFAULT_LANE
    const result = await tools["topics.reserve"]!.execute({ reservationKey: "res_1", count: 1, excludeTopics: [] }, { ctx });
    // Only 1 topic total, well below LANE_FLOOR -- if the floor guard applied
    // here it would refuse this; it must succeed exactly like it always has.
    expect(result.status).toBe("success");
    expect(LANE_FLOOR).toBe(5);
  });
});
