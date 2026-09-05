import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ScrapedRecord, ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { createRedditAgentWorkflow } from "../src/workflow/create-reddit-agent-workflow.js";
import { createRedditThreadTools, parseAtomEntries, parseRedditThreadUrl, type DiscoverThreadsResult, type FetchThreadResult } from "../src/tools/reddit-threads.js";
import {
  DEFAULT_TARGET_THREAD_TITLE,
  DEFAULT_TARGET_THREAD_URL,
  DEFAULT_THREADS,
  fakeRedditFetch,
  fakeRouterSequence,
  finalTurn,
  makePromptStore,
  scoutDecline,
  scoutTurn,
  setupTestEnvironment,
  threadUrl,
  type TestEnvironment,
} from "./test-helpers.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring", metadata: {} };

function toolsFor(options: Parameters<typeof fakeRedditFetch>[0] = {}, scraper?: ScraperProvider) {
  const reddit = fakeRedditFetch(options);
  const tools = createRedditThreadTools({ fetchImpl: reddit.fetch, pauseBetweenFeedsMs: 0, sleep: async () => {}, ...(scraper ? { scraper } : {}) });
  return { tools, requests: reddit.requests };
}

async function discover(tools: ReturnType<typeof createRedditThreadTools>, input: Record<string, unknown>): Promise<DiscoverThreadsResult> {
  const outcome = await tools["reddit.discoverThreads"]!.execute(input, { ctx });
  if (outcome.status !== "success") throw new Error(`discover failed: ${outcome.status} ${"reason" in outcome ? outcome.reason : ""}`);
  return outcome.result as DiscoverThreadsResult;
}

describe("reddit.discoverThreads — live thread discovery from Reddit's own feeds", () => {
  it("parses a real Atom entry shape: title, link, author, published, and the poster's text without Reddit's boilerplate", () => {
    const xml =
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/NaturesHome</name></author><category term="marketing" label="r/marketing"/>' +
      '<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;I started posting for fun &amp;amp; it went viral.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; submitted by &lt;a href="https://www.reddit.com/user/NaturesHome"&gt; /u/NaturesHome &lt;/a&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/marketing/comments/1w7m1z0/x/"&gt;[link]&lt;/a&gt;&lt;/span&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/marketing/comments/1w7m1z0/x/"&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>' +
      '<id>t3_1w7m1z0</id><link href="https://www.reddit.com/r/marketing/comments/1w7m1z0/i_accidentally_hit_200k_followers/" /><updated>2026-09-05T00:44:18+00:00</updated><published>2026-09-05T00:44:18+00:00</published><title>I accidentally hit 200k followers</title></entry></feed>';
    const [entry] = parseAtomEntries(xml);
    expect(entry).toMatchObject({
      id: "t3_1w7m1z0",
      title: "I accidentally hit 200k followers",
      link: "https://www.reddit.com/r/marketing/comments/1w7m1z0/i_accidentally_hit_200k_followers/",
      author: "NaturesHome",
      published: "2026-09-05T00:44:18+00:00",
      text: "I started posting for fun & it went viral.",
    });
  });

  it("parses reddit.com thread URLs and nothing else", () => {
    expect(parseRedditThreadUrl("https://www.reddit.com/r/smallbusiness/comments/abc123/our_team/")).toEqual({ subreddit: "smallbusiness", threadId: "abc123" });
    expect(parseRedditThreadUrl("https://old.reddit.com/r/Startups/comments/XyZ9/")).toEqual({ subreddit: "Startups", threadId: "xyz9" });
    expect(parseRedditThreadUrl("https://www.reddit.com/r/smallbusiness/")).toBeUndefined();
    expect(parseRedditThreadUrl("https://example.com/r/x/comments/abc/")).toBeUndefined();
  });

  it("returns real thread URLs from every scanned community, ranked with keyword matches first and questions ahead of announcements", async () => {
    const { tools, requests } = toolsFor();
    const result = await discover(tools, { subreddits: ["r/smallbusiness", "startups"], keywords: ["CRM", "late-paying clients"] });

    expect(result.scanned.map((s) => [s.subreddit, s.source, s.fetched])).toEqual([
      ["smallbusiness", "reddit-feed", 2],
      ["startups", "reddit-feed", 2],
    ]);
    expect(requests).toEqual(["https://www.reddit.com/r/smallbusiness/new.rss?limit=25", "https://www.reddit.com/r/startups/new.rss?limit=25"]);

    const urls = result.candidates.map((c) => c.url);
    // The two keyword hits lead, then the remaining question, then the announcement.
    expect(urls.slice(0, 2).sort()).toEqual(
      ["https://www.reddit.com/r/smallbusiness/comments/def456/", "https://www.reddit.com/r/startups/comments/ghi789/"].sort(),
    );
    expect(urls[2]).toBe("https://www.reddit.com/r/smallbusiness/comments/abc123/");
    expect(urls[3]).toBe("https://www.reddit.com/r/startups/comments/jkl012/");

    const crm = result.candidates.find((c) => c.url.includes("ghi789"))!;
    expect(crm).toMatchObject({ subreddit: "startups", author: "founder_ish", keywordHits: ["CRM"], looksLikeQuestion: true, source: "reddit-feed" });
    expect(crm.excerpt).toContain("200 leads a month");
    expect(crm.postedAt).toBeTruthy();
  });

  it("drops threads already answered and threads older than maxAgeDays, and says how many it dropped", async () => {
    const old = { ...DEFAULT_THREADS[2]!, publishedAt: new Date(Date.now() - 12 * 86_400_000).toISOString() };
    const { tools } = toolsFor({ threads: [DEFAULT_THREADS[0]!, DEFAULT_THREADS[1]!, old] });
    const result = await discover(tools, { subreddits: ["smallbusiness", "startups"], excludeUrls: [DEFAULT_TARGET_THREAD_URL], maxAgeDays: 7 });

    expect(result.candidates.map((c) => c.url)).toEqual(["https://www.reddit.com/r/smallbusiness/comments/def456/"]);
    expect(result.filteredOut).toBe(2);
  });

  it("reports a community Reddit answers 404 for as notFound, and keeps scanning the others", async () => {
    const { tools } = toolsFor({ missingSubreddits: ["doesnotexist"] });
    const result = await discover(tools, { subreddits: ["doesnotexist", "smallbusiness"] });

    expect(result.scanned[0]).toMatchObject({ subreddit: "doesnotexist", source: "failed", notFound: true, fetched: 0 });
    expect(result.scanned[1]).toMatchObject({ subreddit: "smallbusiness", source: "reddit-feed", fetched: 2 });
    expect(result.candidates).toHaveLength(2);
  });

  it("falls back to the configured scraper when Reddit rate-limits, and says so per community", async () => {
    const searched: string[] = [];
    const scraper: ScraperProvider = {
      name: "fake-scraper",
      async searchSocial(_platform, query) {
        searched.push(query);
        const t = DEFAULT_THREADS[1]!;
        const record: ScrapedRecord = { id: threadUrl(t), url: threadUrl(t), title: t.title, text: t.body!, publishedAt: t.publishedAt!, author: t.author! };
        return [record];
      },
      async extractUrl() {
        return undefined;
      },
      async searchKeyword() {
        return [];
      },
      async socialHistory() {
        return [];
      },
      async fetchRaw() {
        return undefined;
      },
    };
    const { tools } = toolsFor({ statusFor: () => 429 }, scraper);
    const result = await discover(tools, { subreddits: ["smallbusiness"], keywords: ["late-paying clients"] });

    expect(result.scanned[0]).toMatchObject({ subreddit: "smallbusiness", source: "scraper", fetched: 1 });
    expect(result.scanned[0]!.error).toMatch(/429/);
    expect(searched[0]).toContain("subreddit:smallbusiness");
    expect(result.candidates[0]).toMatchObject({ url: "https://www.reddit.com/r/smallbusiness/comments/def456/", source: "scraper", keywordHits: ["late-paying clients"] });
  });

  it("reports failed (not notFound) when Reddit is unreachable and no scraper is configured", async () => {
    const { tools } = toolsFor({ statusFor: () => 503 });
    const result = await discover(tools, { subreddits: ["smallbusiness"] });
    expect(result.scanned[0]).toMatchObject({ subreddit: "smallbusiness", source: "failed" });
    expect(result.scanned[0]!.notFound).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });
});

describe("reddit.fetchThread — the poster's text and the existing replies", () => {
  it("reads the post body and top comments from the thread feed", async () => {
    const { tools } = toolsFor();
    const outcome = await tools["reddit.fetchThread"]!.execute({ url: DEFAULT_TARGET_THREAD_URL }, { ctx });
    expect(outcome.status).toBe("success");
    const thread = (outcome as { result: FetchThreadResult }).result;
    expect(thread).toMatchObject({ url: "https://www.reddit.com/r/smallbusiness/comments/abc123/", title: DEFAULT_TARGET_THREAD_TITLE, subreddit: "smallbusiness", author: "ops_owner_42", source: "reddit-feed" });
    expect(thread.body).toContain("client response times slipped on Fridays");
    expect(thread.body).not.toContain("submitted by");
    expect(thread.comments.map((c) => c.author)).toEqual(["first_commenter", "second_commenter"]);
    expect(thread.comments[0]!.body).toContain("meetings compress");
  });

  it("rejects a non-thread URL as a tooling error rather than guessing", async () => {
    const { tools } = toolsFor();
    const outcome = await tools["reddit.fetchThread"]!.execute({ url: "https://www.reddit.com/r/smallbusiness/" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("falls back to the scraper's page extraction when the feed is refused, and notes that replies are missing", async () => {
    const scraper: ScraperProvider = {
      name: "fake-scraper",
      async extractUrl(url) {
        return { id: url, url, title: "Our team tried a 4-day work week", text: "Full page text of the post." };
      },
      async searchSocial() {
        return [];
      },
      async searchKeyword() {
        return [];
      },
      async socialHistory() {
        return [];
      },
      async fetchRaw() {
        return undefined;
      },
    };
    const { tools } = toolsFor({ statusFor: () => 403 }, scraper);
    const outcome = await tools["reddit.fetchThread"]!.execute({ url: DEFAULT_TARGET_THREAD_URL }, { ctx });
    expect(outcome.status).toBe("success");
    const thread = (outcome as { result: FetchThreadResult }).result;
    expect(thread).toMatchObject({ source: "scraper", body: "Full page text of the post.", comments: [] });
    expect(thread.note).toMatch(/does not separate out the existing replies/);
  });
});

describe("the scanned path end to end: discover, scout, read the thread, draft against it", () => {
  const params = { runId: "reddit_scan_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment({ withTargetThread: false });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function draftFor(url: string, title: string, replyBody: string) {
    return finalTurn({ targetThreadUrl: url, targetThreadTitle: title, replyBody, targetSubreddit: "smallbusiness", disclosureIncluded: false, text: replyBody });
  }

  it("scouts a thread from the live scan and hands the draft the poster's text and the existing replies", async () => {
    const router = fakeRouterSequence([
      scoutTurn(),
      draftFor(DEFAULT_TARGET_THREAD_URL, DEFAULT_TARGET_THREAD_TITLE, "Friday response times were what slipped for us too. We put one person on a Friday rota and the complaints stopped inside a month."),
    ]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.targetThreadUrl).toBe("https://www.reddit.com/r/smallbusiness/comments/abc123/");
    expect(result.output.targetSubreddit).toBe("smallbusiness");
    expect(result.output.topic).toBe(DEFAULT_TARGET_THREAD_TITLE);
    expect(result.output.angle).toBe("personal-experience");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toEqual(expect.arrayContaining(["05-discover-threads", "06-scout-thread", "07-select-target-thread", "08-fetch-thread", "11-research-pull", "12-draft-reply"]));
    expect(ids).not.toContain("04a-plan-channel");

    // The scout saw real candidates from both configured communities...
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const scoutPrompt = String(calls[0]![0]);
    expect(scoutPrompt).toContain("https://www.reddit.com/r/smallbusiness/comments/def456/");
    expect(scoutPrompt).toContain("https://www.reddit.com/r/startups/comments/ghi789/");
    expect(scoutPrompt).toContain("200 leads a month");

    // ...and the draft saw the thread itself: the poster's body, the existing
    // replies, and the scout's brief. This is what "drafted from the title
    // alone" used to lack.
    const draftPrompt = String(calls[1]![0]);
    expect(draftPrompt).toContain("client response times slipped on Fridays");
    expect(draftPrompt).toContain("meetings compress into the four days");
    expect(draftPrompt).toContain("the anchor-day decision");
    expect(draftPrompt).toContain('"angle":"personal-experience"');

    // Research ran FOR the thread, with the thread's question as the query.
    const research = await durableStore.getStep(params.runId, "11-research-pull");
    expect((research?.output as { query: string }).query).toContain("4-day work week");

    // The decision names the thread, so the next scan excludes it.
    const decisions = await env.store.listJson<{ summary: string }>("acme", ["memory", "products", "reddit-agent", "decisions"]);
    expect(decisions.some((d) => d.data.summary.includes("comments/abc123/") && d.data.summary.includes("chosen by scout"))).toBe(true);
  }, 60_000);

  it("holds honestly when the scout declines every candidate, quoting its reason", async () => {
    const router = fakeRouterSequence([scoutDecline("all four are announcements or requests for freelancers; none asks something the client has done")]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_scan_decline" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/nothing worth replying to/i);
    expect(result.reason).toMatch(/requests for freelancers/);
    expect(result.reason).toMatch(/r\/smallbusiness, r\/startups/);
    expect(router.complete).toHaveBeenCalledTimes(1);
  });

  it("refuses a scout answer that names a URL outside the candidates, re-asks once, then proceeds", async () => {
    const router = fakeRouterSequence([
      scoutTurn({ url: "https://www.reddit.com/r/smallbusiness/comments/invented999/made_up/" }),
      scoutTurn(),
      draftFor(DEFAULT_TARGET_THREAD_URL, DEFAULT_TARGET_THREAD_TITLE, "We hit the same Friday problem and solved it with a rota."),
    ]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId: "reddit_scan_reask" });

    expect(result.status).toBe("completed");
    const ids = (await durableStore.listSteps("reddit_scan_reask")).map((s) => s.stepId);
    expect(ids).toContain("06-scout-thread-attempt-2");
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[1]![0])).toContain("not one of the candidate URLs");
  }, 60_000);

  it("holds, not fails, when the scan finds no fresh thread at all", async () => {
    const stale = DEFAULT_THREADS.map((t) => ({ ...t, publishedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }));
    const staleEnv = await setupTestEnvironment({ withTargetThread: false, reddit: { threads: stale } });
    const router = fakeRouterSequence([]);
    const workflowFn = createRedditAgentWorkflow({ ...staleEnv.workflowOptions, tools: staleEnv.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_scan_stale" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no fresh threads found in r\/smallbusiness, r\/startups/);
    expect(result.reason).toMatch(/4 thread\(s\) were older/);
    expect(router.complete).not.toHaveBeenCalled();
    await staleEnv.cleanup();
  });

  it("degrades, not holds, when Reddit cannot be read at all — an outage is not an empty week", async () => {
    const downEnv = await setupTestEnvironment({ withTargetThread: false, reddit: { statusFor: () => 503 } });
    const router = fakeRouterSequence([]);
    const workflowFn = createRedditAgentWorkflow({ ...downEnv.workflowOptions, tools: downEnv.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_scan_outage" });

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("unreachable");
    expect(result.failureReason).toMatch(/could not read any target community/);
    await downEnv.cleanup();
  });

  it("a requested subreddit narrows the scan to that one community", async () => {
    await env.store.writeJson("acme", ["client", "config"], { targetSubreddits: ["smallbusiness", "startups"] });
    const router = fakeRouterSequence([
      scoutTurn({ url: "https://www.reddit.com/r/startups/comments/ghi789/which_crm_for_a_5_person_b2b_saas/", angle: "comparison-decision-help" }),
      finalTurn({
        targetThreadUrl: "https://www.reddit.com/r/startups/comments/ghi789/",
        targetThreadTitle: DEFAULT_THREADS[2]!.title,
        replyBody: "At five people with 200 leads a month the pipeline view matters more than automation.",
        targetSubreddit: "startups",
        disclosureIncluded: false,
        text: "At five people with 200 leads a month the pipeline view matters more than automation.",
      }),
    ]);
    const workflowFn = createRedditAgentWorkflow({ ...env.workflowOptions, tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "reddit_scan_sub", input: { requestedSubreddit: "r/startups" } });

    expect(result.status).toBe("completed");
    expect(env.redditRequests.filter((u) => u.includes("/new.rss"))).toEqual(["https://www.reddit.com/r/startups/new.rss?limit=25"]);
  }, 60_000);
});
