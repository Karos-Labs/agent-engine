import { describe, expect, it } from "vitest";
import type { AgentContext, AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { ClientBriefSchema, type ClientBrief, type SocialHistoryPost } from "@agent-engine/tools";
import {
  AUDIENCE_QUESTIONS_JOB,
  COMMUNITY_DOMAINS,
  REFERENCE_POST_MAX_AGE_DAYS,
  buildCommunityQueries,
  evergreenSignals,
  extractCommunityQuestions,
  gatherTopicSignals,
  ownAssetSignals,
  scoreReferencePosts,
} from "../src/workflow/topic-engines.js";

/**
 * The four topic engines beyond niche news (RFC-13 §I). Pure helpers first,
 * then the one orchestrating call driven with stub tools — the property that
 * matters there is that EVERY source is best-effort: a missing account, an
 * unconfigured scraper or a tool that throws must narrow the signals and name
 * the gap, never fail the step.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function post(over: Partial<SocialHistoryPost> & { username: string }): SocialHistoryPost {
  return {
    platform: "instagram",
    url: `https://instagram.test/${over.username}/${over.publishedAt ?? "x"}/${over.engagement?.likes ?? 0}`,
    excerpt: "a post about pricing",
    publishedAt: daysAgo(2),
    ...over,
  };
}

function brief(overrides: Record<string, unknown> = {}): ClientBrief {
  return ClientBriefSchema.parse({
    version: 1,
    channel: "instagram",
    generatedAt: "2026-09-01T00:00:00.000Z",
    generatedBy: "agent",
    sources: [{ kind: "profile", ref: "client.getProfile" }],
    positioning: { oneLiner: "A retainer-pricing consultancy for creative agencies", whatWeSell: "pricing workshops and a retainer calculator" },
    icp: { summary: "owners of 5-30 person creative agencies", roles: ["agency founders"], pains: ["retainers that lose money by month three"] },
    offers: [],
    coreTerms: ["marketing", "agencies", "pricing", "retainers"],
    referenceAccounts: [],
    forbidden: {},
    language: {},
    evergreenAngles: [],
    ownAssets: [],
    confidence: "high",
    gaps: [],
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 2 — reference accounts
// ─────────────────────────────────────────────────────────────────────────

describe("scoreReferencePosts", () => {
  it("ranks a 500-like post above a 20-like one from the same account", () => {
    const scored = scoreReferencePosts(
      [
        post({ username: "peer", engagement: { likes: 20 }, publishedAt: daysAgo(1) }),
        post({ username: "peer", engagement: { likes: 500 }, publishedAt: daysAgo(3) }),
        post({ username: "peer", engagement: { likes: 60 }, publishedAt: daysAgo(5) }),
      ],
      { now: NOW },
    );
    expect(scored.map((p) => p.url)).toEqual([
      "https://instagram.test/peer/2026-09-07T12:00:00.000Z/500",
      "https://instagram.test/peer/2026-09-05T12:00:00.000Z/60",
      "https://instagram.test/peer/2026-09-09T12:00:00.000Z/20",
    ]);
    expect(scored[0]!.engagementScore).toBeGreaterThan(scored[2]!.engagementScore);
    // Normalised, so the prompt (and the engine bonus in `rankTopicCandidates`)
    // reads a share, never a follower-count-dependent absolute.
    for (const p of scored) expect(p.engagementScore).toBeGreaterThanOrEqual(0), expect(p.engagementScore).toBeLessThanOrEqual(1);
  });

  it("does not let a big account's median post beat a small account's outlier", () => {
    // The whole reason engagement is normalised WITHIN an account: a 200k
    // publication's ordinary post out-engages a practitioner's best post every
    // time, and the practitioner's outlier is the one that says what this
    // audience actually stops for.
    const big = [400, 420, 440, 460].map((likes, i) => post({ username: "bigpub", engagement: { likes }, publishedAt: daysAgo(i + 1) }));
    const small = [5, 6].map((likes, i) => post({ username: "tinypro", engagement: { likes }, publishedAt: daysAgo(i + 1) })).concat([
      post({ username: "tinypro", engagement: { likes: 300 }, publishedAt: daysAgo(3) }),
    ]);
    const scored = scoreReferencePosts([...big, ...small], { now: NOW });
    const outlier = scored.find((p) => p.handle === "tinypro" && p.url.endsWith("/300"))!;
    const bigMedian = scored.filter((p) => p.handle === "bigpub").map((p) => p.engagementScore).sort((a, b) => a - b)[2]!;
    expect(outlier.engagementScore).toBeGreaterThan(bigMedian);
  });

  it(`drops a post older than ${REFERENCE_POST_MAX_AGE_DAYS} days, keeps one with no date at all, and skips posts with no text or url`, () => {
    const scored = scoreReferencePosts(
      [
        post({ username: "peer", engagement: { likes: 9000 }, publishedAt: daysAgo(31) }),
        post({ username: "peer", engagement: { likes: 10 }, publishedAt: daysAgo(29) }),
        { platform: "x", username: "peer", url: "https://x.test/undated", excerpt: "no date from this provider" },
        { platform: "x", username: "peer", url: "https://x.test/empty", excerpt: "   " },
        { platform: "x", username: "peer", url: "", excerpt: "no url" },
      ],
      { now: NOW },
    );
    expect(scored.map((p) => p.url)).toEqual(expect.arrayContaining(["https://x.test/undated"]));
    expect(scored.some((p) => p.url.endsWith("/9000"))).toBe(false);
    expect(scored.some((p) => p.url.endsWith("/empty"))).toBe(false);
    // The 29-day-old post and the undated one: the other three were dropped.
    expect(scored).toHaveLength(2);
  });

  it("counts missing engagement fields as zero and keeps the recency order when nothing distinguishes the posts", () => {
    const scored = scoreReferencePosts(
      [
        post({ username: "peer", publishedAt: daysAgo(9), url: "https://x.test/old" }),
        post({ username: "peer", publishedAt: daysAgo(1), url: "https://x.test/new" }),
        post({ username: "peer", publishedAt: daysAgo(5), url: "https://x.test/mid" }),
      ],
      { now: NOW },
    );
    expect(scored.map((p) => p.url)).toEqual(["https://x.test/new", "https://x.test/mid", "https://x.test/old"]);
    // No spread within the account: everything sits at the midpoint and the
    // date decides, rather than a provider's silence reading as "unpopular".
    expect(new Set(scored.map((p) => p.engagementScore))).toEqual(new Set([0.5]));
  });

  it("weights a comment above a like and a view far below one", () => {
    const scored = scoreReferencePosts(
      [
        post({ username: "a", engagement: { comments: 40 }, url: "https://x.test/comments" }),
        post({ username: "a", engagement: { likes: 40 }, url: "https://x.test/likes" }),
        post({ username: "a", engagement: { views: 40 }, url: "https://x.test/views" }),
      ],
      { now: NOW },
    );
    expect(scored.map((p) => p.url)).toEqual(["https://x.test/comments", "https://x.test/likes", "https://x.test/views"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Engine 3 — audience questions
// ─────────────────────────────────────────────────────────────────────────

describe("buildCommunityQueries", () => {
  it("asks the vocabulary question from the core terms and the person question from the ICP", () => {
    expect(buildCommunityQueries(brief())).toEqual(['"marketing agencies" how OR why OR anyone', "agency founders retainers that lose money by month three"]);
  });

  it("falls back to the ICP summary and a third core term when the brief has no roles or pains", () => {
    const queries = buildCommunityQueries(brief({ icp: { summary: "owners of 5-30 person creative agencies" } }));
    expect(queries[0]).toBe('"marketing agencies" how OR why OR anyone');
    expect(queries[1]).toBe("owners of 5-30 person creative agencies pricing");
  });

  it("still produces the vocabulary question from a one-term brief, and never a duplicate pair", () => {
    const queries = buildCommunityQueries(brief({ coreTerms: ["pricing"], icp: { summary: "pricing" } }));
    expect(queries[0]).toBe('"pricing" how OR why OR anyone');
    expect(new Set(queries).size).toBe(queries.length);
  });
});

describe("extractCommunityQuestions", () => {
  it("keeps what a person asked, in any script, and drops an article shaped like a topic", () => {
    const questions = extractCommunityQuestions([
      { title: "How do agencies price retainers?", url: "https://reddit.com/r/agency/1" },
      { title: "למה סוכנויות מתמחרות ככה?", url: "https://www.reddit.com/r/israel/2" },
      { title: "איך מתמחרים ריטיינר", url: "https://reddit.com/r/israel/3" },
      { title: "Agency pricing report 2026", url: "https://example.test/report", content: "A study of 400 agencies." },
      { title: "Anyone else seeing retainer creep", url: "https://news.ycombinator.com/item?id=1" },
      { title: "Pricing", url: "https://quora.com/q/1", content: "Should retainers be capped by hours?" },
      { title: "Why margins slip", url: undefined, content: "Why do margins slip?" },
    ]);
    expect(questions.map((q) => q.question)).toEqual([
      "How do agencies price retainers?",
      "למה סוכנויות מתמחרות ככה?",
      // No question mark: a platform that strips it still leaves the interrogative opener.
      "איך מתמחרים ריטיינר",
      "Anyone else seeing retainer creep",
      "Should retainers be capped by hours?",
    ]);
    expect(questions[0]!.community).toBe("reddit.com");
    // `www.` normalised away so two Reddit threads read as one community.
    expect(questions[1]!.community).toBe("reddit.com");
    expect(questions[4]!.url).toBe("https://quora.com/q/1");
  });

  it("takes one question per document and de-duplicates repeats of the same question", () => {
    const questions = extractCommunityQuestions([
      { title: "How do agencies price retainers?", url: "https://reddit.com/1", content: "How do agencies price retainers? I keep guessing." },
      { title: "how do agencies PRICE retainers?", url: "https://quora.com/2" },
    ]);
    expect(questions).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Engines 4 and 5 — the client's own material
// ─────────────────────────────────────────────────────────────────────────

const PRODUCT_DOC = [
  "# Our approach",
  "We work closely with clients.",
  "",
  "## How Northwind cut onboarding to 3 days",
  "Northwind's ops team rebuilt the intake form and dropped time-to-first-value from 11 days.",
  "",
  "## Why it matters",
  "Because retainers churn in month three.",
  "",
  "## 3 דרכים לקצר אונבורדינג",
  "שלוש דרכים שעבדו אצל לקוחות שלנו.",
].join("\n");

describe("ownAssetSignals", () => {
  it("keeps the brief's own assets and only the headings that name a figure, a date or a proper noun", () => {
    const signals = ownAssetSignals(
      brief({ ownAssets: [{ title: "Retainer calculator", kind: "data", summary: "our own model of 120 retainers", sourceRef: "client.getKnowledge/assets" }] }),
      { productInformation: PRODUCT_DOC, marketStrategy: "## The 2026 pricing shift\nAgencies moved to value pricing." },
    );
    expect(signals.map((a) => a.title)).toEqual([
      "Retainer calculator",
      "How Northwind cut onboarding to 3 days",
      // No letter case in Hebrew: the figure rule is what fires, honestly.
      "3 דרכים לקצר אונבורדינג",
      "The 2026 pricing shift",
    ]);
    expect(signals[1]).toMatchObject({
      summary: "Northwind's ops team rebuilt the intake form and dropped time-to-first-value from 11 days.",
      sourceRef: "product-information#How Northwind cut onboarding to 3 days",
    });
    expect(signals.map((a) => a.title)).not.toContain("Our approach");
    expect(signals.map((a) => a.title)).not.toContain("Why it matters");
  });

  it("returns nothing rather than noise when there is no brief list and no qualifying heading", () => {
    expect(ownAssetSignals(brief(), { productInformation: "# Our approach\nWe work closely with clients." })).toEqual([]);
    expect(ownAssetSignals(brief(), {})).toEqual([]);
  });
});

describe("evergreenSignals", () => {
  it("drops an angle another channel already covered and keeps the rest, de-duplicated", () => {
    const angles = ["how pricing pages lie", "what practitioners get wrong about retainers", "How pricing pages lie"];
    const kept = evergreenSignals(brief({ evergreenAngles: angles }), ['Posted about how pricing pages lie (lane: knowledge)']);
    expect(kept).toEqual(["what practitioners get wrong about retainers"]);
  });

  it("keeps everything when nothing has been covered", () => {
    expect(evergreenSignals(brief({ evergreenAngles: ["a", "the retainer that lost money"] }), [])).toEqual(["a", "the retainer that lost money"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// gatherTopicSignals — the one orchestrating call, on stub tools
// ─────────────────────────────────────────────────────────────────────────

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

function stubTool(name: string, handler: (args: Record<string, unknown>) => unknown): AgentTool {
  return {
    name,
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      return handler(args as Record<string, unknown>) as never;
    },
  } as unknown as AgentTool;
}

const REFERENCE_BRIEF_FIELDS = {
  referenceAccounts: [
    { platform: "instagram", handle: "@peer", why: "the ICP follows them" },
    { platform: "x", handle: "pricingnerd", why: "publishes the numbers" },
  ],
  evergreenAngles: ["what practitioners get wrong about retainers"],
  ownAssets: [{ title: "Retainer calculator", kind: "data", summary: "our own model of 120 retainers", sourceRef: "client.getKnowledge/assets" }],
};

function pullTool(calls: Array<Record<string, unknown>>, result: unknown = undefined): AgentTool {
  return stubTool("research.pull", (args) => {
    calls.push(args);
    return {
      status: "success",
      result:
        result ?? {
          fromCache: false,
          result: { documents: [{ title: "How do agencies price retainers?", url: "https://reddit.com/r/agency/1" }] },
        },
    };
  });
}

describe("gatherTopicSignals", () => {
  it("still returns questions, own assets and evergreen angles when the reference accounts cannot be read, naming the gap", async () => {
    const pullCalls: Array<Record<string, unknown>> = [];
    const tools: AgentToolRegistry = {
      "research.socialHistory": stubTool("research.socialHistory", () => ({ status: "not_available", reason: "no scraper is configured" })),
      "research.pull": pullTool(pullCalls),
    };
    const gathered = await gatherTopicSignals(tools, ctx, {
      brief: brief(REFERENCE_BRIEF_FIELDS),
      contextDocs: { productInformation: PRODUCT_DOC },
      avoidTopics: [],
      includeDomainsSupported: true,
      now: NOW,
    });

    expect(gathered.signals.referencePosts).toEqual([]);
    expect(gathered.notes.some((n) => n.includes("not_available") && n.includes("reference-accounts"))).toBe(true);
    // Engines 3-5 are untouched by engine 2's outage.
    expect(gathered.signals.audienceQuestions.map((q) => q.question)).toEqual(["How do agencies price retainers?"]);
    expect(gathered.signals.ownAssets.map((a) => a.title)).toContain("How Northwind cut onboarding to 3 days");
    expect(gathered.signals.evergreen).toEqual(["what practitioners get wrong about retainers"]);
    // Two community queries ran and neither was cached; nothing was scraped for
    // the accounts, so only the queries are billed.
    expect(gathered.scraperExecutions).toBe(2);
  });

  it("reads the brief's accounts on a 24h window, scores them, and counts one billed execution per account only when the read was live", async () => {
    const historyCalls: Array<Record<string, unknown>> = [];
    const tools: AgentToolRegistry = {
      "research.socialHistory": stubTool("research.socialHistory", (args) => {
        historyCalls.push(args);
        return {
          status: "success",
          result: {
            fromCache: false,
            problems: ["@pricingnerd could not be read: profile is private"],
            posts: [post({ username: "peer", engagement: { likes: 500 } }), post({ username: "peer", engagement: { likes: 20 } })],
          },
        };
      }),
      "research.pull": pullTool([], { fromCache: true, result: { documents: [] } }),
    };
    const gathered = await gatherTopicSignals(tools, ctx, {
      brief: brief(REFERENCE_BRIEF_FIELDS),
      contextDocs: {},
      avoidTopics: [],
      includeDomainsSupported: true,
      now: NOW,
    });

    expect(historyCalls[0]).toEqual({ accounts: [{ platform: "instagram", username: "peer" }, { platform: "x", username: "pricingnerd" }], window: "24h" });
    expect(gathered.signals.referencePosts.map((p) => p.handle)).toEqual(["peer", "peer"]);
    // The named per-account problem travels; a private profile must not hide
    // behind "history unavailable".
    expect(gathered.notes.some((n) => n.includes("profile is private"))).toBe(true);
    // Two accounts scraped live, both community queries served from cache.
    expect(gathered.scraperExecutions).toBe(2);
  });

  it("filters the community queries to community domains when research.pull supports it, and says so when it does not", async () => {
    const supported: Array<Record<string, unknown>> = [];
    await gatherTopicSignals({ "research.pull": pullTool(supported) }, ctx, {
      brief: brief(),
      contextDocs: {},
      avoidTopics: [],
      includeDomainsSupported: true,
      now: NOW,
    });
    expect(supported).toHaveLength(2);
    expect(supported[0]).toMatchObject({ job: AUDIENCE_QUESTIONS_JOB, window: "7d", maxResults: 6, includeDomains: [...COMMUNITY_DOMAINS] });

    const unsupported: Array<Record<string, unknown>> = [];
    const gathered = await gatherTopicSignals({ "research.pull": pullTool(unsupported) }, ctx, {
      brief: brief(),
      contextDocs: {},
      avoidTopics: [],
      includeDomainsSupported: false,
      now: NOW,
    });
    expect(unsupported[0]).not.toHaveProperty("includeDomains");
    expect(gathered.notes.some((n) => n.includes("without a domain filter"))).toBe(true);
  });

  it("names every missing source instead of failing: no accounts in the brief, no tools registered, and a tool that throws", async () => {
    const noAccounts = await gatherTopicSignals({ "research.pull": pullTool([]) }, ctx, {
      brief: brief(),
      contextDocs: {},
      avoidTopics: [],
      includeDomainsSupported: true,
      now: NOW,
    });
    expect(noAccounts.notes.some((n) => n.includes("no reference accounts"))).toBe(true);
    expect(noAccounts.notes.some((n) => n.includes("no own assets"))).toBe(true);

    const noTools = await gatherTopicSignals({}, ctx, {
      brief: brief(REFERENCE_BRIEF_FIELDS),
      contextDocs: {},
      avoidTopics: [],
      includeDomainsSupported: true,
      now: NOW,
    });
    expect(noTools.notes.some((n) => n.includes("research.socialHistory is not registered"))).toBe(true);
    expect(noTools.notes.some((n) => n.includes("research.pull is not registered"))).toBe(true);
    // Engines 4 and 5 reach no tool at all, so they answer in full.
    expect(noTools.signals).toEqual({
      referencePosts: [],
      audienceQuestions: [],
      ownAssets: [{ title: "Retainer calculator", summary: "our own model of 120 retainers", sourceRef: "client.getKnowledge/assets" }],
      evergreen: ["what practitioners get wrong about retainers"],
    });

    const throwing = await gatherTopicSignals(
      {
        "research.socialHistory": stubTool("research.socialHistory", () => {
          throw new Error("socket hang up");
        }),
        "research.pull": stubTool("research.pull", () => {
          throw new Error("429 from the vendor");
        }),
      },
      ctx,
      { brief: brief(REFERENCE_BRIEF_FIELDS), contextDocs: {}, avoidTopics: [], includeDomainsSupported: true, now: NOW },
    );
    expect(throwing.notes.some((n) => n.includes("socket hang up"))).toBe(true);
    expect(throwing.notes.filter((n) => n.includes("429 from the vendor"))).toHaveLength(2);
    expect(throwing.scraperExecutions).toBe(0);
  });

  it("notes an evergreen list that is entirely covered elsewhere, so the reviewer sees why that engine was silent", async () => {
    const gathered = await gatherTopicSignals({ "research.pull": pullTool([]) }, ctx, {
      brief: brief({ evergreenAngles: ["what practitioners get wrong about retainers"] }),
      contextDocs: {},
      avoidTopics: ["what practitioners get wrong about retainers, said on LinkedIn on Tuesday"],
      includeDomainsSupported: true,
      now: NOW,
    });
    expect(gathered.signals.evergreen).toEqual([]);
    expect(gathered.notes.some((n) => n.includes("overlap a subject another channel already covered"))).toBe(true);
  });
});
