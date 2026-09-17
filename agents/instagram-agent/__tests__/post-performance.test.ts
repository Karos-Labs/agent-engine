import { describe, expect, it } from "vitest";
import {
  armsAllowedFor,
  ctaKindFor,
  DECAY_HALF_LIFE_DAYS,
  decayWeight,
  EXPLORATION_RATE,
  MAX_STORED_POSTS,
  MIN_MEASURED_POSTS,
  PERFORMANCE_BELIEF_KEY,
  POST_ARMS,
  readPerformanceStore,
  scoreOf,
  selectArm,
  slideRangeFor,
  summariseArms,
  withPost,
  type PostArm,
  type PostPerformanceRecord,
  type PerformanceStore,
} from "../src/workflow/post-performance.js";

/**
 * Phase 5.6, items C1 and C2.
 *
 * Every consumer of Phase 6's data, built and tested against data that does
 * not exist yet. That is the thing worth being careful about: a selector
 * tested only on hand-made stores can be confidently wrong in exactly the way
 * the real store will be shaped, so each test below states what it is
 * standing in for, and the empty-store cases — the ones that run in
 * production TODAY — are as thorough as the measured ones.
 */

const NOW = new Date("2026-09-18T00:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function post(over: Partial<PostPerformanceRecord> & { runId: string; arm: PostArm }): PostPerformanceRecord {
  return {
    funnelStage: "expertise",
    slideCount: 7,
    publishedAt: daysAgo(10),
    ...over,
  };
}

const store = (records: PostPerformanceRecord[]): PerformanceStore => ({ records });

describe("scoreOf — sends plus saves, per reach", () => {
  it("adds shares-per-reach to saves-per-reach", () => {
    const r = post({ runId: "a", arm: "carousel-edu", metrics: { reach: 1000, shares: 20, saved: 50 } });
    expect(scoreOf(r)).toBeCloseTo(0.07, 6);
  });

  it("has NO score for an unmeasured post, which is different from a score of zero", () => {
    expect(scoreOf(post({ runId: "a", arm: "carousel-edu" }))).toBeUndefined();
  });

  it("has NO score for a post nobody saw — a zero would punish the format for an outage", () => {
    expect(scoreOf(post({ runId: "a", arm: "carousel-edu", metrics: { reach: 0, shares: 0, saved: 0 } }))).toBeUndefined();
  });

  it("does score a post that was seen and kept by nobody — that IS evidence", () => {
    expect(scoreOf(post({ runId: "a", arm: "carousel-edu", metrics: { reach: 800, shares: 0, saved: 0 } }))).toBe(0);
  });
});

describe("decayWeight — ninety days is a half-life, not a cliff", () => {
  it("counts today's post fully", () => {
    expect(decayWeight(daysAgo(0), NOW)).toBeCloseTo(1, 6);
  });

  it("counts a post from exactly one half-life ago at half", () => {
    expect(decayWeight(daysAgo(DECAY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 6);
  });

  it("never reaches zero, and never goes negative for a future date", () => {
    expect(decayWeight(daysAgo(3650), NOW)).toBeGreaterThan(0);
    expect(decayWeight(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBeCloseTo(1, 6);
  });

  it("treats an unparseable date as no evidence at all", () => {
    expect(decayWeight("last tuesday", NOW)).toBe(0);
  });
});

describe("summariseArms", () => {
  it("weights a recent post above an old one with the same score", () => {
    const summaries = summariseArms(
      store([
        post({ runId: "old", arm: "carousel-edu", publishedAt: daysAgo(180), metrics: { reach: 1000, shares: 100, saved: 0 } }),
        post({ runId: "new", arm: "carousel-edu", publishedAt: daysAgo(1), metrics: { reach: 1000, shares: 0, saved: 0 } }),
      ]),
      NOW,
    );
    const edu = summaries.find((s) => s.arm === "carousel-edu")!;
    // Two observations, 0.1 and 0.0. An unweighted mean would be 0.05. The old
    // one is 180 days back — two half-lives, so it weighs 0.25 against the
    // new one's ~0.99 — and the weighted mean is 0.1 * 0.25 / 1.2423 ≈ 0.0201.
    // Asserted as a band rather than a round number, because a round number
    // here would have been chosen to pass rather than derived.
    expect(edu.score).toBeGreaterThan(0.019);
    expect(edu.score).toBeLessThan(0.021);
    expect(edu.posts).toBe(2);
  });

  it("reports an arm with no measured post as scoreless rather than as zero", () => {
    const summaries = summariseArms(store([]), NOW);
    expect(summaries).toHaveLength(POST_ARMS.length);
    expect(summaries.every((s) => s.score === undefined && s.posts === 0)).toBe(true);
  });
});

describe("armsAllowedFor — what the topic can support, before what performed well", () => {
  it("refuses to pad a proof into an eight-slide carousel", () => {
    expect(armsAllowedFor("proof", "expertise")).not.toContain("carousel-edu");
  });

  it("holds a walkthrough to the educational carousel — a three-slide procedure is not a procedure", () => {
    expect(armsAllowedFor("walkthrough", "expertise")).toEqual(["carousel-edu"]);
  });

  it("treats the decide stage as a proof shape whatever the payload says", () => {
    expect(armsAllowedFor(undefined, "decide")).not.toContain("carousel-edu");
  });

  it("allows everything when the topic declares nothing", () => {
    expect(armsAllowedFor(undefined, "expertise")).toEqual([...POST_ARMS]);
  });
});

describe("slideRangeFor / ctaKindFor", () => {
  it("gives the educational carousel the specification's six to eight", () => {
    expect(slideRangeFor("carousel-edu")).toEqual({ min: 6, max: 8 });
  });

  it("makes a single-deep exactly one slide", () => {
    expect(slideRangeFor("single-deep")).toEqual({ min: 1, max: 1 });
  });

  it("asks a stranger a question and asks a warm reader to keep or forward", () => {
    expect(ctaKindFor("attention", false)).toBe("question");
    expect(ctaKindFor("expertise", false)).toBe("save");
    expect(ctaKindFor("decide", false)).toBe("send");
  });

  it("only offers the comment-for-asset ask when there IS an asset — promising one that does not exist is a lie", () => {
    expect(ctaKindFor("expertise", true)).toBe("comment-for-asset");
    expect(ctaKindFor("expertise", false)).not.toBe("comment-for-asset");
  });
});

describe("selectArm with an EMPTY store — the path that runs in production today", () => {
  it("rotates, and says plainly that it is rotating rather than measuring", () => {
    const pick = selectArm({ store: store([]), now: NOW, stage: "expertise", recentArms: ["carousel-edu"] });
    expect(pick.source).toBe("rotation");
    expect(pick.arm).not.toBe("carousel-edu");
    expect(pick.rule).toContain("0 measured post(s)");
  });

  it("still returns an arm when every allowed one was used recently — it never returns nothing", () => {
    const pick = selectArm({ store: store([]), now: NOW, stage: "expertise", recentArms: [...POST_ARMS] });
    expect(POST_ARMS).toContain(pick.arm);
    expect(pick.source).toBe("rotation");
  });

  it("lets the topic override the rotation outright", () => {
    const pick = selectArm({ store: store([]), now: NOW, stage: "expertise", payloadKind: "walkthrough", recentArms: ["carousel-edu"] });
    expect(pick).toMatchObject({ arm: "carousel-edu", source: "constrained" });
  });

  it("does NOT exploit a store with fewer than the minimum measured posts, however lopsided it looks", () => {
    const lopsided = store([
      post({ runId: "1", arm: "single-deep", metrics: { reach: 1000, shares: 900, saved: 900 } }),
      post({ runId: "2", arm: "carousel-edu", metrics: { reach: 1000, shares: 0, saved: 0 } }),
    ]);
    const pick = selectArm({ store: lopsided, now: NOW, stage: "expertise", recentArms: [], random: () => 0.99 });
    expect(pick.source).toBe("rotation");
  });
});

describe("selectArm with a MEASURED store", () => {
  const measured = (): PerformanceStore =>
    store([
      ...Array.from({ length: 4 }, (_, i) =>
        post({ runId: `edu${i}`, arm: "carousel-edu", metrics: { reach: 1000, shares: 5, saved: 5 } }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        post({ runId: `pov${i}`, arm: "carousel-pov", metrics: { reach: 1000, shares: 60, saved: 40 } }),
      ),
    ]);

  it("takes the best-measured arm, and quotes the number it took it on", () => {
    const pick = selectArm({ store: measured(), now: NOW, stage: "expertise", recentArms: [], random: () => 0.99 });
    expect(pick).toMatchObject({ arm: "carousel-pov", source: "argmax" });
    expect(pick.rule).toContain("0.1000");
    expect(pick.rule).toContain("4 measured post(s)");
  });

  it("explores on the exploration slot instead, so the ranking keeps learning", () => {
    const pick = selectArm({ store: measured(), now: NOW, stage: "expertise", recentArms: [], random: () => 0 });
    expect(pick.source).toBe("explore");
    expect(pick.rule).toContain(`${Math.round(EXPLORATION_RATE * 100)}%`);
  });

  it("exploits just above the exploration threshold and explores just below it", () => {
    const above = selectArm({ store: measured(), now: NOW, stage: "expertise", random: () => EXPLORATION_RATE + 0.01 });
    const below = selectArm({ store: measured(), now: NOW, stage: "expertise", random: () => EXPLORATION_RATE - 0.01 });
    expect(above.source).toBe("argmax");
    expect(below.source).toBe("explore");
  });

  it("STILL obeys the topic: the best arm does not get to be the wrong shape", () => {
    const pick = selectArm({ store: measured(), now: NOW, stage: "expertise", payloadKind: "walkthrough", random: () => 0.99 });
    expect(pick).toMatchObject({ arm: "carousel-edu", source: "constrained" });
  });

  it(`needs ${MIN_MEASURED_POSTS} measured posts exactly — seven rotates, eight decides`, () => {
    const seven = store(measured().records.slice(0, 7));
    expect(selectArm({ store: seven, now: NOW, stage: "expertise", random: () => 0.99 }).source).toBe("rotation");
    expect(selectArm({ store: measured(), now: NOW, stage: "expertise", random: () => 0.99 }).source).toBe("argmax");
  });
});

describe("the store on disk", () => {
  it("reads back what it wrote", () => {
    const written = withPost({ records: [] }, post({ runId: "r1", arm: "single-deep", hookPattern: "contrarian" }));
    const round = readPerformanceStore({ [PERFORMANCE_BELIEF_KEY]: written });
    expect(round.records).toHaveLength(1);
    expect(round.records[0]).toMatchObject({ runId: "r1", arm: "single-deep", hookPattern: "contrarian" });
  });

  it("REPLACES a record for the same run, because Phase 6 comes back to attach metrics", () => {
    const first = withPost({ records: [] }, post({ runId: "r1", arm: "carousel-edu" }));
    const second = withPost(first, post({ runId: "r1", arm: "carousel-edu", metrics: { reach: 100, shares: 1, saved: 2 } }));
    expect(second.records).toHaveLength(1);
    expect(second.records[0]!.metrics).toBeDefined();
  });

  it(`keeps at most ${MAX_STORED_POSTS}, dropping the oldest`, () => {
    let s: PerformanceStore = { records: [] };
    for (let i = 0; i < MAX_STORED_POSTS + 5; i += 1) s = withPost(s, post({ runId: `r${i}`, arm: "carousel-edu" }));
    expect(s.records).toHaveLength(MAX_STORED_POSTS);
    expect(s.records[0]!.runId).toBe("r5");
  });

  it("keeps a record with NO funnel stage — that is every post today, and an absence is not corruption", () => {
    const beliefs = {
      [PERFORMANCE_BELIEF_KEY]: { records: [{ runId: "no-stage", arm: "carousel-edu", publishedAt: daysAgo(1), slideCount: 7 }] },
    };
    const read = readPerformanceStore(beliefs);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]!.funnelStage).toBeUndefined();
  });

  it("DROPS a record whose arm or stage it cannot trust, rather than defaulting one", () => {
    const beliefs = {
      [PERFORMANCE_BELIEF_KEY]: {
        records: [
          { runId: "ok", arm: "carousel-edu", funnelStage: "expertise", publishedAt: daysAgo(1), slideCount: 7 },
          { runId: "bad-arm", arm: "reel", funnelStage: "expertise", publishedAt: daysAgo(1) },
          // A stage that is WRONG is still a reason to drop: it means something
          // wrote a label this code does not understand.
          { runId: "bad-stage", arm: "carousel-edu", funnelStage: "middle", publishedAt: daysAgo(1) },
          { runId: "bad-date", arm: "carousel-edu", funnelStage: "expertise", publishedAt: "whenever" },
          { runId: "no-run-id-key" },
        ],
      },
    };
    const read = readPerformanceStore(beliefs);
    expect(read.records.map((r) => r.runId)).toEqual(["ok"]);
  });

  it("survives anything at all in the beliefs slot", () => {
    for (const junk of [undefined, null, 42, "text", {}, { [PERFORMANCE_BELIEF_KEY]: 7 }, { [PERFORMANCE_BELIEF_KEY]: { records: "no" } }]) {
      expect(readPerformanceStore(junk)).toEqual({ records: [] });
    }
  });
});
