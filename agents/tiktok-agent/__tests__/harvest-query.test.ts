import { describe, expect, it } from "vitest";
import { FORMAT_ANCHOR, MAX_TOPIC_WORDS, buildHarvestQuery } from "../src/workflow/harvest-query.js";

/**
 * The search string open discovery actually types (RFC-25 Phase 2).
 *
 * Under the ALLOWLIST posture the show name did the narrowing and the raw
 * topic was a fine query. Open discovery removes the show, and a catalog row
 * on its own searches the whole of YouTube badly: it is written to be a good
 * SUBJECT for a short, not a good QUERY for a video search.
 *
 * RFC-25 §3 names search quality as the real risk here and says only real prep
 * runs will settle whether this is good enough. These tests pin the shape so
 * the thing that gets tuned afterwards is tunable.
 */

const CANDIDATE = {
  topic: "Why AI marketing budgets are being cut in half",
  angle: "Finance teams stopped believing the efficiency story",
  hook: "Your AI budget was cut by someone who never saw a demo",
  format: "commentary-clip" as const,
  whyNow: "Three CFO surveys landed this week",
  evidenceUrls: [],
  voiceoverRecommended: false,
};

describe("buildHarvestQuery", () => {
  it("always anchors on the format, because an open search otherwise returns anything but a conversation", () => {
    // News segments, ads, webinar recordings and lecture captures all match a
    // business subject. The commentary format needs someone SAYING something.
    expect(buildHarvestQuery({ topic: "AI marketing budgets" })).toContain(FORMAT_ANCHOR);
    expect(buildHarvestQuery({ topic: "" })).toContain(FORMAT_ANCHOR);
  });

  it("strips the framing words a catalog row is written with", () => {
    // "Why X is reshaping Y" is how a content planner writes a row and is
    // exactly how no podcast titles an episode.
    const query = buildHarvestQuery({ topic: "Why AI is reshaping the future of marketing budgets" });
    expect(query).not.toContain("why");
    expect(query).not.toContain("reshaping");
    expect(query).not.toContain("future");
    expect(query).toContain("marketing");
    expect(query).toContain("budgets");
  });

  it("keeps the query short, because a long one starves a video search", () => {
    // Every extra term is another thing a title has to contain, and podcast
    // titles are short.
    const query = buildHarvestQuery({
      topic: "Why artificial intelligence marketing budgets pricing procurement compliance governance are collapsing",
      industry: "B2B SaaS marketing",
      discovered: CANDIDATE,
    });
    expect(query.split(" ").length).toBeLessThanOrEqual(MAX_TOPIC_WORDS + 2 + 1);
  });

  it("lets the scout's angle colour a subject, without repeating it", () => {
    const query = buildHarvestQuery({ topic: "AI budgets", discovered: CANDIDATE });
    expect(query).toContain("budgets");
    // A word already in the subject is not spent twice.
    expect(query.split(" ").filter((w) => w === "budgets")).toHaveLength(1);
  });

  it("reaches for the industry only when the subject is thin", () => {
    // On a specific topic the industry would pull the search back towards
    // generic commentary, which is the opposite of what it is for.
    const thin = buildHarvestQuery({ topic: "budgets", industry: "healthcare recruitment" });
    expect(thin).toContain("healthcare");

    const specific = buildHarvestQuery({ topic: "nurse retention bonuses ward staffing ratios", industry: "healthcare recruitment" });
    expect(specific).not.toContain("healthcare");
  });

  it("never searches for the client itself", () => {
    // The client is not in the footage. Searching for them returns their own
    // channel, which is the one place this tier must not go — their own
    // footage is Tier 2a, and clipping yourself as if it were commentary is a
    // different product.
    const query = buildHarvestQuery({ topic: "AI budgets", industry: "B2B SaaS" });
    expect(query).not.toMatch(/karos|acme/i);
  });

  it("falls back to the raw topic rather than searching for the anchor alone", () => {
    // A row of pure framing words leaves nothing behind. "podcast" on its own
    // is a worse search than the row it came from.
    const query = buildHarvestQuery({ topic: "why the new era" });
    expect(query).toContain("why the new era");
    expect(query).toContain(FORMAT_ANCHOR);
  });

  it("is deterministic — the same run builds the same query twice", () => {
    // It is checkpointed and it appears in the trace; a query that drifted
    // between a run and its replay would make a bad clip unexplainable.
    const input = { topic: CANDIDATE.topic, industry: "B2B SaaS marketing", discovered: CANDIDATE };
    expect(buildHarvestQuery(input)).toBe(buildHarvestQuery(input));
  });
});
