import { describe, expect, it } from "vitest";
import {
  SUBJECT_REPEAT_STRENGTH,
  TOPIC_ENGINE_ROTATION_HOLD,
  TOPIC_ENGINE_ROTATION_MULTIPLIER,
  rankTopicCandidates,
  subjectClusterPenalty,
  topicSubjectCluster,
} from "../src/workflow/topic-selection.js";
import type { TrendCandidate } from "@agent-engine/workflow";

/**
 * # TOPIC VARIETY (2026-09-20)
 *
 * The owner, on a feed where karoslabs' subjects were ChatGPT, GEO, ChatGPT:
 * *"יש הרבה נושאים חמים בעולם או נושאים מעניינים שאפשר לדבר עליהם בהקשרי כל
 * חברה ... שלא יהיו נושאים חזרתיים מדי בלי גיוון מעניין"* — and, on the same
 * day, that this is about every client, each with its own topics.
 *
 * ## The run these numbers come from
 *
 * `pubsub-21904879061334183`. All five topic engines fired and produced
 * signals; the ranking then read:
 *
 * ```
 * 38.81  niche-news          Sponsored AI Agents in Search   <- won
 * 25.00  niche-news          Autonomous Agent Governance
 * 21.60  niche-news          Conversational Intent
 * 20.00  audience-questions  Founder Content Strategy
 * 18.39  reference-accounts  Growth Strategy Playbooks
 * 15.74  evergreen           Multi-Agent System Design
 *  ----  own-assets          (nothing offered)
 * ```
 *
 * The variety mechanism was alive and outvoted by its own scoring: news
 * carried a freshness multiplier up to 1.35 while evergreen sat at 1.0 AND
 * paid a further 0.8 for being off-mode — the same fact charged twice — and
 * nothing anywhere remembered that the two posts before this one had also been
 * about AI search.
 *
 * Every number below is from that run. Nothing in this file, or in the code it
 * tests, knows what a karoslabs subject is: the engines are the fleet's five
 * and the subjects are derived from each candidate's own words.
 */

function candidate(over: Partial<TrendCandidate> & { topic: string }): TrendCandidate {
  return {
    headline: `${over.topic} — the source's own phrasing`,
    mode: "hot-news",
    brandFit: 5,
    interest: 4,
    brandFitReason: "core domain",
    angle: "an angle",
    hook: "a hook",
    sourceUrls: [],
    hasNumbers: false,
    mediaHint: "none",
    ...over,
  } as TrendCandidate;
}

const baseOptions = {
  mode: "hot-news" as const,
  brief: { offers: [] },
  recentExcerpts: [],
  avoidTopics: [],
};

describe("subject clusters: the same subject in different words", () => {
  it("scores a repeat of an already-covered subject down, however differently it is worded", () => {
    // Not one shingle in common, which is why `candidateDistance` scored this
    // pair 1.0 and let the third AI-search post through.
    const shipped = [topicSubjectCluster("AI Search Visibility")!];
    const repeat = subjectClusterPenalty({ topic: "Sponsored AI Agents in Search" }, shipped);

    expect(repeat, "a subject the feed just covered took no penalty at all").toBeLessThan(1);
    // Sized to be able to overturn the 2.5x lead news had on the real run.
    expect(repeat).toBeLessThan(0.8);
  });

  it("leaves a genuinely different subject alone", () => {
    const shipped = [topicSubjectCluster("AI Search Visibility")!, topicSubjectCluster("GEO and AI Answer Engines")!];
    expect(subjectClusterPenalty({ topic: "Pricing Experiments for Seed Startups" }, shipped)).toBe(1);
  });

  it("costs nothing on a client's first post, when there is no history to repeat", () => {
    expect(subjectClusterPenalty({ topic: "Anything At All" }, [])).toBe(1);
  });

  it("is graded, not a switch: a half-shared subject takes about half the penalty of a full repeat", () => {
    const full = subjectClusterPenalty({ topic: "Pricing Experiments" }, [topicSubjectCluster("Pricing Experiments")!]);
    const half = subjectClusterPenalty({ topic: "Pricing Ladders" }, [topicSubjectCluster("Pricing Experiments")!]);
    expect(full).toBeCloseTo(1 - SUBJECT_REPEAT_STRENGTH, 5);
    expect(half).toBeGreaterThan(full);
    expect(half).toBeLessThan(1);
  });

  it("says nothing about a topic with no content words rather than bucketing it with everything", () => {
    expect(topicSubjectCluster("the and of")).toBeUndefined();
    expect(subjectClusterPenalty({ topic: "the and of" }, ["anything"])).toBe(1);
  });
});

describe("engine rotation: the lane that produced the last posts steps back", () => {
  it("penalises an engine this client used for its last runs, and leaves the others alone", () => {
    const news = candidate({ topic: "Sponsored AI Agents in Search", engine: "niche-news" });
    const ever = candidate({ topic: "Multi Agent System Design", engine: "evergreen", mode: "deep-value" });

    const held = rankTopicCandidates([news, ever], {
      ...baseOptions,
      recentTopicEngines: ["niche-news", "niche-news"],
    });
    const free = rankTopicCandidates([news, ever], { ...baseOptions, recentTopicEngines: [] });

    const rowOf = (r: ReturnType<typeof rankTopicCandidates>, topic: string) => r.ranked.find((x) => x.candidate.topic === topic)!;
    expect(rowOf(held, news.topic).components.engineRotation).toBe(TOPIC_ENGINE_ROTATION_MULTIPLIER);
    expect(rowOf(held, ever.topic).components.engineRotation).toBe(1);
    expect(rowOf(free, news.topic).components.engineRotation).toBe(1);
  });

  it("only holds the last `TOPIC_ENGINE_ROTATION_HOLD` posts, so an engine comes back", () => {
    const news = candidate({ topic: "A News Subject", engine: "niche-news" });
    // Newest first: niche-news is older than the hold window here.
    const history = ["evergreen", "own-assets", "niche-news", "niche-news"];
    expect(history.slice(0, TOPIC_ENGINE_ROTATION_HOLD)).not.toContain("niche-news");
    const ranked = rankTopicCandidates([news], { ...baseOptions, recentTopicEngines: history });
    expect(ranked.ranked[0]!.components.engineRotation).toBe(1);
  });

  it("still lets a held engine win when it has the only real story — rotation is a preference, never a veto", () => {
    const strongNews = candidate({ topic: "A Strong News Subject", engine: "niche-news", brandFit: 5, interest: 5 });
    const weakEvergreen = candidate({ topic: "A Weak Evergreen Angle", engine: "evergreen", brandFit: 2, interest: 2 });
    const ranked = rankTopicCandidates([strongNews, weakEvergreen], {
      ...baseOptions,
      recentTopicEngines: ["niche-news", "niche-news"],
    });
    expect(ranked.ranked[0]!.candidate.topic).toBe(strongNews.topic);
  });
});

describe("the whole thing, on the run that caused it", () => {
  it("stops the third AI-search post from leading, and puts a different lane in front", () => {
    // The real candidates and their real scout scores.
    const candidates = [
      candidate({ topic: "Sponsored AI Agents in Search", engine: "niche-news", brandFit: 5, interest: 5 }),
      candidate({ topic: "Autonomous Agent Governance", engine: "niche-news", brandFit: 5, interest: 4 }),
      candidate({ topic: "Founder Content Strategy", engine: "audience-questions", brandFit: 5, interest: 4 }),
      candidate({ topic: "Growth Strategy Playbooks", engine: "reference-accounts", brandFit: 4, interest: 4 }),
      candidate({ topic: "Multi Agent System Design", engine: "evergreen", brandFit: 5, interest: 4 }),
    ];
    // What the feed had just published, twice.
    const recent = [topicSubjectCluster("AI Search Visibility")!, topicSubjectCluster("GEO and AI Answer Engines")!];

    const ranked = rankTopicCandidates(candidates, {
      ...baseOptions,
      recentTopicEngines: ["niche-news", "niche-news"],
      recentSubjectClusters: recent,
    });

    const winner = ranked.ranked[0]!;
    expect(winner.candidate.topic, "the feed published a third post on the subject it had just covered twice").not.toBe("Sponsored AI Agents in Search");
    expect(winner.components.engine).not.toBe("niche-news");

    // And the repeat is genuinely beaten, not merely edged out.
    const repeat = ranked.ranked.find((r) => r.candidate.topic === "Sponsored AI Agents in Search")!;
    expect(repeat.score).toBeLessThan(winner.score);
  });

  it("does not simply hand every run to evergreen: with a fresh subject and no engine held, news still leads", () => {
    const candidates = [
      candidate({ topic: "A Brand New Development", engine: "niche-news", brandFit: 5, interest: 5, publishedAt: new Date().toISOString() }),
      candidate({ topic: "A Standing Evergreen Angle", engine: "evergreen", brandFit: 5, interest: 4 }),
    ];
    const ranked = rankTopicCandidates(candidates, { ...baseOptions, recentTopicEngines: ["evergreen"], recentSubjectClusters: [] });
    expect(ranked.ranked[0]!.candidate.topic).toBe("A Brand New Development");
  });
});

describe("evergreen is no longer charged twice for being undated", () => {
  it("gives an evergreen candidate the same engine bonus as a news one, leaving freshness to do that work", () => {
    const ever = candidate({ topic: "A Standing Angle", engine: "evergreen" });
    const news = candidate({ topic: "A Dated Story", engine: "niche-news" });
    const ranked = rankTopicCandidates([ever, news], { ...baseOptions, mode: "hot-news" });
    const rowOf = (topic: string) => ranked.ranked.find((r) => r.candidate.topic === topic)!;
    // Off a deep-value week, which is exactly where the 0.8 used to apply.
    expect(rowOf(ever.topic).components.engineBonus).toBe(rowOf(news.topic).components.engineBonus);
  });
});
