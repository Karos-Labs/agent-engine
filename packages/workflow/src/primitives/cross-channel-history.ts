import type { AgentContext, AgentToolRegistry, DedupeHistoryEntry } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * What this client has ALREADY SAID, everywhere — the cross-channel memory
 * every content agent reads before it picks a subject (2026-09).
 *
 * ## What was wrong
 *
 * Anti-repetition was per agent: the X agent compared a draft against the X
 * agent's own last 25 posts, the LinkedIn agent against LinkedIn's, and neither
 * knew what the other had shipped that morning, let alone what the client had
 * posted themselves from their phone. A client running three channels could
 * get the same launch story three times in a week, each one passing every
 * dedupe check it faced.
 *
 * ## What this reads
 *
 * 1. Every channel agent's own excerpt ledger (`ledger.listOutputExcerpts`,
 *    the rolling 25-entry window each agent writes on delivery), not only the
 *    calling agent's.
 * 2. The client's own recent posts on the accounts they configured
 *    (`research.socialHistory`, cached so the day's runs share one scrape).
 *
 * Both halves are best-effort: a ledger that cannot be read or a scraper that
 * is not configured narrows the memory, it never stops a run. The result is
 * shaped as `DedupeHistoryEntry[]` so it drops straight into the existing
 * `checkOutputDedupe` scorer, and as a directive that names the channel each
 * post ran on so the writer sees "you said this on LinkedIn on Tuesday", not
 * an anonymous paragraph.
 */

/** Every agent whose deliverable is a post a client publishes. Read for all of them regardless of which one is running. */
export const CHANNEL_AGENT_IDS = ["x-agent", "linkedin-agent", "instagram-agent", "tiktok-agent", "blog-agent", "newsletter-agent", "reddit-agent"] as const;

export interface CrossChannelEntry extends DedupeHistoryEntry {
  /** `x-agent`, `linkedin-agent`, … for a ledger entry; `x`, `instagram`, … for a post scraped from the client's own account. */
  channel: string;
  origin: "ledger" | "social";
  recordedAt?: string;
  url?: string;
  /**
   * Only ever present on an `origin: "social"` entry — a ledger excerpt is
   * something WE drafted, and it has no public reception to report.
   *
   * `research.socialHistory` has always returned this and this reader was the
   * one place that dropped it. RFC-15 §3.3 ranks a client's own posts for
   * few-shot selection by engagement first, and without the field that rank
   * silently falls through to prose length and then recency — which selects
   * the client's LONGEST recent posts as the model of their voice rather than
   * their best-received ones.
   */
  engagement?: { likes?: number; comments?: number; views?: number };
}

export interface CrossChannelHistory {
  entries: CrossChannelEntry[];
  /** Per-source notes: what could not be read and why. Empty when everything answered. */
  notes: string[];
  /**
   * True when the social read was served from `research.socialHistory`'s
   * cache, so a caller metering a billed scrape can tell a real scrape from a
   * free cache hit. `undefined` when no social accounts were read at all.
   */
  socialFromCache?: boolean;
}

export interface SocialAccountRef {
  platform: "x" | "instagram" | "reddit" | "tiktok";
  username: string;
}

/**
 * The client's own accounts, from their standing configuration.
 *
 * Explicit `socialAccounts: [{platform, username}]` in `client/config.json`
 * wins; the handles the channel agents already read (`xHandle`, and the
 * brand kit's Instagram `handle`) are folded in so a client who configured an
 * X handle for posting is read on X without a second setting. LinkedIn is
 * absent because the scraper seam has no LinkedIn capability.
 */
export function socialAccountsFromClient(config: Record<string, unknown> | undefined, brand: Record<string, unknown> | undefined): SocialAccountRef[] {
  const accounts: SocialAccountRef[] = [];
  const push = (platform: SocialAccountRef["platform"], raw: unknown) => {
    if (typeof raw !== "string") return;
    const username = raw.trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+\//i, "").replace(/\/.*$/, "");
    if (username.length === 0) return;
    if (!accounts.some((a) => a.platform === platform && a.username.toLowerCase() === username.toLowerCase())) accounts.push({ platform, username });
  };
  const explicit = config?.["socialAccounts"];
  if (Array.isArray(explicit)) {
    for (const entry of explicit) {
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)["platform"] === "string") {
        const platform = (entry as Record<string, unknown>)["platform"] as string;
        if (platform === "x" || platform === "instagram" || platform === "reddit" || platform === "tiktok") push(platform, (entry as Record<string, unknown>)["username"]);
      }
    }
  }
  push("x", config?.["xHandle"]);
  push("instagram", config?.["instagramHandle"] ?? brand?.["instagramHandle"] ?? brand?.["handle"]);
  push("tiktok", config?.["tiktokHandle"]);
  return accounts.slice(0, 6);
}

export interface ReadCrossChannelHistoryOptions {
  stepId: string;
  /** Defaults to every channel agent. */
  agentIds?: readonly string[];
  socialAccounts?: readonly SocialAccountRef[];
  /**
   * Freshness bar for the social read, passed straight through to
   * `research.socialHistory` (whose schema default is `"6h"`).
   *
   * It matters because the cache is keyed by the ACCOUNT SET, not by the
   * window: several callers in the same run share one scrape only if they
   * also agree on how stale a scrape they will accept. A caller that meters
   * "did this cost a scrape?" must pass the same window as the caller it
   * expects to have paid, or it can under-count on a long-running or resumed
   * run.
   */
  window?: string;
}

/**
 * Reads the cross-channel memory, checkpointed under `stepId`. Ledger entries
 * for every channel first (newest last, as the ledger keeps them), then the
 * client's own social posts. `excludeRunId` is this run, so a resumed run is
 * never compared against its own earlier delivery.
 */
export async function readCrossChannelHistory(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: ReadCrossChannelHistoryOptions,
): Promise<CrossChannelHistory> {
  return wf.step.code(options.stepId, async (): Promise<CrossChannelHistory> => {
    const entries: CrossChannelEntry[] = [];
    const notes: string[] = [];
    let socialFromCache: boolean | undefined;

    const list = tools["ledger.listOutputExcerpts"];
    if (!list) {
      notes.push("ledger.listOutputExcerpts is not registered; no shipped-output history was read");
    } else {
      for (const agentId of options.agentIds ?? CHANNEL_AGENT_IDS) {
        try {
          const outcome = await list.execute({ agentId, excludeRunId: wf.runId }, { ctx });
          if (outcome.status !== "success") continue;
          const items = (outcome.result as { entries: Array<{ runId: string; excerpt: string; recordedAt?: number }> }).entries;
          for (const e of items) {
            entries.push({
              runId: e.runId,
              excerpt: e.excerpt,
              channel: agentId,
              origin: "ledger",
              ...(typeof e.recordedAt === "number" ? { recordedAt: new Date(e.recordedAt).toISOString() } : {}),
            });
          }
        } catch (error) {
          notes.push(`could not read ${agentId}'s output history: ${(error as Error).message}`);
        }
      }
    }

    const accounts = options.socialAccounts ?? [];
    const social = tools["research.socialHistory"];
    if (accounts.length > 0) {
      if (!social) {
        notes.push("research.socialHistory is not registered; the client's own accounts were not read");
      } else {
        try {
          const outcome = await social.execute({ accounts: [...accounts], ...(options.window ? { window: options.window } : {}) }, { ctx });
          if (outcome.status === "success") {
            const result = outcome.result as {
              posts: Array<{ platform: string; username: string; url: string; excerpt: string; publishedAt?: string; engagement?: { likes?: number; comments?: number; views?: number } }>;
              problems: string[];
              fromCache?: boolean;
            };
            socialFromCache = result.fromCache === true;
            for (const post of result.posts) {
              entries.push({
                runId: `social:${post.platform}:${post.url}`,
                excerpt: post.excerpt,
                channel: post.platform,
                origin: "social",
                url: post.url,
                ...(post.publishedAt ? { recordedAt: post.publishedAt } : {}),
                ...(post.engagement ? { engagement: post.engagement } : {}),
              });
            }
            notes.push(...result.problems);
          } else {
            notes.push(`the client's own accounts could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
          }
        } catch (error) {
          notes.push(`the client's own accounts could not be read: ${(error as Error).message}`);
        }
      }
    }

    return { entries, notes, ...(socialFromCache === undefined ? {} : { socialFromCache }) };
  });
}

/** How many recent posts reach the drafting prompt. Bounded like `pastFeedback` — history must not push the brief out of the window. */
const DIRECTIVE_LIMIT = 12;
const DIRECTIVE_EXCERPT_CHARS = 400;

const CHANNEL_LABEL: Record<string, string> = {
  "x-agent": "X (drafted by us)",
  "linkedin-agent": "LinkedIn (drafted by us)",
  "instagram-agent": "Instagram (drafted by us)",
  "tiktok-agent": "TikTok (drafted by us)",
  "blog-agent": "blog (drafted by us)",
  "newsletter-agent": "newsletter (drafted by us)",
  "reddit-agent": "Reddit (drafted by us)",
  x: "X (the client's own account)",
  instagram: "Instagram (the client's own account)",
  tiktok: "TikTok (the client's own account)",
  reddit: "Reddit (the client's own account)",
};

/**
 * The do-not-repeat directive, across every channel. Newest first, the
 * channel named on every line, so a writer on X sees that LinkedIn covered
 * the launch on Tuesday. `undefined` for an empty memory so a caller spreads
 * it conditionally and a first run's prompt is byte-identical to before.
 */
export function crossChannelDirective(history: CrossChannelHistory): string | undefined {
  if (history.entries.length === 0) return undefined;
  const ordered = [...history.entries].sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? "")).slice(0, DIRECTIVE_LIMIT);
  const lines = ordered.map((e, i) => {
    const when = e.recordedAt ? ` · ${e.recordedAt.slice(0, 10)}` : "";
    return `${i + 1}. [${CHANNEL_LABEL[e.channel] ?? e.channel}${when}] ${e.excerpt.replace(/\s+/g, " ").slice(0, DIRECTIVE_EXCERPT_CHARS)}`;
  });
  return [
    "This client RECENTLY PUBLISHED the posts below — across EVERY channel, including posts they made themselves. A subject covered on any one of them is covered: do not repeat it here, not the topic, not the hook, not the angle, not the example, even though this is a different platform. Writing the same idea in different words, or for a different audience, is still a repeat. Pick the adjacent idea none of these touched.",
    ...lines,
  ].join("\n");
}

/** The subjects already covered, one line each, for a topic picker to steer around. */
export function crossChannelAvoidTopics(history: CrossChannelHistory): string[] {
  const topics: string[] = [];
  for (const e of history.entries) {
    const first = e.excerpt
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l.length > 12);
    if (first && !topics.includes(first)) topics.push(first.slice(0, 160));
  }
  return topics;
}
