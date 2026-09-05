import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, createKarosIntakeTools, WorkspaceStore } from "@agent-engine/tools";
import type { CaptureFetch } from "@agent-engine/tool-common";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import type { CreateRedditAgentWorkflowOptions } from "../src/workflow/create-reddit-agent-workflow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A router whose `.complete()` replays a fixed sequence of turns in order. */
export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

export function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

// ── A fake Reddit, served as the Atom feeds the real tools read ──────────────

export interface FakeThread {
  id: string;
  subreddit: string;
  title: string;
  slug?: string;
  author?: string;
  body?: string;
  /** ISO 8601. Defaults to "a few hours ago". */
  publishedAt?: string;
  comments?: Array<{ author: string; body: string }>;
}

export interface FakeRedditOptions {
  threads?: FakeThread[];
  /** Communities whose feed answers 404. */
  missingSubreddits?: string[];
  /** Override the status for a URL (e.g. 429 for everything). Return undefined for normal handling. */
  statusFor?: (url: string) => number | undefined;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/** Every thread the default fake Reddit knows about. */
export const DEFAULT_THREADS: FakeThread[] = [
  {
    id: "abc123",
    subreddit: "smallbusiness",
    slug: "our_team_tried_a_4_day_week",
    title: "Our team tried a 4-day work week: anyone else run a trial like this?",
    author: "ops_owner_42",
    body: "We're a 12-person agency and just finished a one-quarter trial of a 4-day week. Output held up but client response times slipped on Fridays. Anyone else run a trial like this? What broke for you that didn't show up in the first month?",
    publishedAt: hoursAgo(6),
    comments: [
      { author: "first_commenter", body: "We did it for six months. The thing nobody warns you about is that meetings compress into the four days and eat the gain." },
      { author: "second_commenter", body: "Depends entirely on whether your clients expect same-day replies." },
    ],
  },
  {
    id: "def456",
    subreddit: "smallbusiness",
    slug: "late_paying_clients",
    title: "How do you handle late-paying clients without souring the relationship?",
    author: "invoice_tired",
    body: "Two of my biggest clients pay 45 to 60 days late every single time. I don't want to lose them. What actually works?",
    publishedAt: hoursAgo(20),
    comments: [{ author: "cash_flow_guy", body: "Deposits up front. Non-negotiable after the first late payment." }],
  },
  {
    id: "ghi789",
    subreddit: "startups",
    slug: "which_crm_for_a_5_person_b2b_saas",
    title: "Which CRM for a 5 person B2B SaaS startup? Marketing automation is a nice-to-have.",
    author: "founder_ish",
    body: "Bootstrapped, five people, about 200 leads a month. We need pipeline tracking and basic email sequences. What would you pick and why?",
    publishedAt: hoursAgo(30),
    comments: [],
  },
  {
    id: "jkl012",
    subreddit: "startups",
    slug: "i_accidentally_hit_200k_followers",
    title: "I accidentally hit 200k followers",
    author: "viral_by_luck",
    body: "Posted a video for fun, it blew up. Sharing because it still feels unreal.",
    publishedAt: hoursAgo(3),
    comments: [],
  },
];

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function threadUrl(t: FakeThread): string {
  return `https://www.reddit.com/r/${t.subreddit}/comments/${t.id}/${t.slug ?? "thread"}/`;
}

function postEntry(t: FakeThread): string {
  const html = `<!-- SC_OFF --><div class="md"><p>${escapeXml(t.body ?? "")}</p></div><!-- SC_ON --> submitted by <a href="https://www.reddit.com/user/${t.author ?? "someone"}"> /u/${t.author ?? "someone"} </a> <span><a href="${threadUrl(t)}">[link]</a></span> <span><a href="${threadUrl(t)}">[comments]</a></span>`;
  const when = t.publishedAt ?? hoursAgo(4);
  return `<entry><author><name>/u/${t.author ?? "someone"}</name></author><category term="${t.subreddit}" label="r/${t.subreddit}"/><content type="html">${escapeXml(html)}</content><id>t3_${t.id}</id><link href="${threadUrl(t)}" /><updated>${when}</updated><published>${when}</published><title>${escapeXml(t.title)}</title></entry>`;
}

function commentEntry(t: FakeThread, c: { author: string; body: string }, index: number): string {
  const html = `<!-- SC_OFF --><div class="md"><p>${escapeXml(c.body)}</p></div><!-- SC_ON -->`;
  const when = hoursAgo(1);
  return `<entry><author><name>/u/${c.author}</name></author><category term="${t.subreddit}" label="r/${t.subreddit}"/><content type="html">${escapeXml(html)}</content><id>t1_c${index}${t.id}</id><link href="${threadUrl(t)}c${index}/" /><updated>${when}</updated><title>/u/${c.author} on ${escapeXml(t.title)}</title></entry>`;
}

function feed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><updated>${hoursAgo(0)}</updated>${entries.join("")}</feed>`;
}

export function fakeRedditFetch(options: FakeRedditOptions = {}): { fetch: CaptureFetch; requests: string[] } {
  const threads = options.threads ?? DEFAULT_THREADS;
  const missing = new Set((options.missingSubreddits ?? []).map((s) => s.toLowerCase()));
  const requests: string[] = [];
  const respond = (status: number, body: string, type = "application/atom+xml") => new Response(body, { status, headers: { "content-type": type } });

  const fetchImpl: CaptureFetch = async (url) => {
    requests.push(url);
    const forced = options.statusFor?.(url);
    if (forced !== undefined) return respond(forced, forced === 429 ? "rate limited" : "error", "text/plain");

    const listing = /^https:\/\/www\.reddit\.com\/r\/([A-Za-z0-9_]+)\/new\.rss/i.exec(url);
    if (listing) {
      const sub = listing[1]!.toLowerCase();
      if (missing.has(sub)) return respond(404, "<html>not found</html>", "text/html");
      return respond(200, feed(threads.filter((t) => t.subreddit.toLowerCase() === sub).map(postEntry)));
    }
    const thread = /^https:\/\/www\.reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)\/\.rss/i.exec(url);
    if (thread) {
      const t = threads.find((x) => x.id.toLowerCase() === thread[2]!.toLowerCase());
      if (!t) return respond(404, "<html>not found</html>", "text/html");
      return respond(200, feed([postEntry(t), ...(t.comments ?? []).map((c, i) => commentEntry(t, c, i))]));
    }
    return respond(404, "<html>unknown fixture url</html>", "text/html");
  };
  return { fetch: fetchImpl, requests };
}

// ── Model turns for the two judgment steps ───────────────────────────────────

/** A scout turn that picks `url` (default: the 4-day-week thread) with a sensible brief. */
export function scoutTurn(
  overrides: { url?: string; angle?: "thorough-value" | "personal-experience" | "comparison-decision-help" | "correction-with-receipts"; why?: string; whatToAdd?: string[]; requiresDisclosure?: boolean } = {},
): () => CompletionResult<unknown> {
  return finalTurn({
    selected: {
      url: overrides.url ?? DEFAULT_TARGET_THREAD_URL,
      why: overrides.why ?? "A real question the client has first-hand experience with, and the existing replies miss the client-facing angle.",
      angle: overrides.angle ?? "personal-experience",
      whatToAdd: overrides.whatToAdd ?? ["what happened to client response times", "the anchor-day decision", "how long before judging it"],
      requiresDisclosure: overrides.requiresDisclosure ?? false,
    },
    runnersUp: [],
  });
}

/** A scout turn that declines every candidate. */
export function scoutDecline(passReason: string): () => CompletionResult<unknown> {
  return finalTurn({ selected: null, passReason, runnersUp: [] });
}

/**
 * The topic guardrail's verdict turn. Needed whenever the run has forbidden
 * topics (an auto-derived charter always carries `offLimitsTopics`): the
 * guardrail is a model step and consumes a router turn after the draft.
 */
export function guardrailTurn(): () => CompletionResult<unknown> {
  return finalTurn({ violatedTopics: [] });
}

/** A planner turn for the auto-setup path. */
export function plannerTurn(
  overrides: { subreddits?: Array<{ name: string; why: string }>; keywords?: string[]; offLimits?: string[] } = {},
): () => CompletionResult<unknown> {
  return finalTurn({
    targetSubreddits: overrides.subreddits ?? [
      { name: "smallbusiness", why: "Owners ask operational questions the client answers for a living." },
      { name: "startups", why: "Early teams ask about tooling and process the client has run." },
      { name: "marketing", why: "Practitioners compare approaches the client has measured." },
    ],
    searchKeywords: overrides.keywords ?? ["4-day week", "client response times", "agency operations", "late-paying clients", "CRM"],
    offLimitsTopics: overrides.offLimits ?? ["competitor comparisons"],
    voiceNotes: "First person, plain, specific. Say what was tried and what happened. No pitch.",
    disclosureLine: "Disclosure: I work at Acme, which does this for clients.",
  });
}

// ── The test environment ─────────────────────────────────────────────────────

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  /** Every URL the fake Reddit was asked for, in order. */
  redditRequests: string[];
  /** Spread into `createRedditAgentWorkflow(...)`: the fake Reddit, no scraper, no pauses. */
  workflowOptions: Pick<CreateRedditAgentWorkflowOptions, "redditFetch" | "scraper" | "redditPauseMs">;
  cleanup: () => Promise<void>;
}

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

/** The thread a caller names when a test wants the requested-thread path (no scan, no scout). */
export const DEFAULT_TARGET_THREAD_URL = threadUrl(DEFAULT_THREADS[0]!);
export const DEFAULT_TARGET_THREAD_TITLE = DEFAULT_THREADS[0]!.title;

export async function setupTestEnvironment(
  opts: { withTargetSubreddits?: boolean; withBrand?: boolean; withTargetThread?: boolean; reddit?: FakeRedditOptions } = {},
): Promise<TestEnvironment> {
  const withTargetSubreddits = opts.withTargetSubreddits ?? true;
  const withBrand = opts.withBrand ?? true;
  const withTargetThread = opts.withTargetThread ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reddit-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts).
  // Tests still need deterministic offline data, so they opt in here; nothing
  // in `apps/` does.
  // `intake.saveStrategy` is merged in exactly as `apps/agent-server`'s
  // composition root does: `createAllKarosTools` excludes it by design, and
  // the auto-setup path needs it to record a charter.
  const tools = { ...createAllKarosTools(store, undefined, { scraper: createOfflineScraper() }), ...createKarosIntakeTools(store) };
  const reddit = fakeRedditFetch(opts.reddit);

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  void seedCtx;
  await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS", description: "Acme builds operations software for small agencies." });
  await store.writeJson("acme", ["client", "voice-rules"], { tone: "conversational, no jargon" });
  if (withBrand) {
    await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  }
  // Config always exists (the workspace is provisioned); what varies is whether
  // it names target communities and whether it names a thread.
  await store.writeJson("acme", ["client", "config"], {
    ...(withTargetSubreddits ? { targetSubreddits: ["smallbusiness", "startups"] } : {}),
    ...(withTargetSubreddits && withTargetThread ? { requestedThreadUrl: DEFAULT_TARGET_THREAD_URL, requestedThreadTitle: DEFAULT_TARGET_THREAD_TITLE } : {}),
  });

  return {
    rootDir,
    store,
    tools,
    redditRequests: reddit.requests,
    workflowOptions: { redditFetch: reddit.fetch, scraper: null, redditPauseMs: 0 },
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
