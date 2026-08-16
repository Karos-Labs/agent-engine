import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import type { CampaignChannel } from "../src/agent/campaign-strategy-agent.js";
import type { ChannelRuntimeOptions } from "../src/workflow/create-campaign-workflow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAMPAIGN_PROMPTS_ROOT = path.join(HERE, "..", "prompts");

const CHANNEL_PROMPTS_DIR: Record<CampaignChannel, string> = {
  x: path.join(HERE, "..", "..", "x-agent", "prompts"),
  linkedin: path.join(HERE, "..", "..", "linkedin-agent", "prompts"),
  reddit: path.join(HERE, "..", "..", "reddit-agent", "prompts"),
  blog: path.join(HERE, "..", "..", "blog-agent", "prompts"),
  newsletter: path.join(HERE, "..", "..", "newsletter-agent", "prompts"),
};

export function makeCampaignPromptStore(): FilePromptStore {
  return new FilePromptStore(CAMPAIGN_PROMPTS_ROOT);
}

export function makeChannelPromptStores(): Record<CampaignChannel, FilePromptStore> {
  return {
    x: new FilePromptStore(CHANNEL_PROMPTS_DIR.x),
    linkedin: new FilePromptStore(CHANNEL_PROMPTS_DIR.linkedin),
    reddit: new FilePromptStore(CHANNEL_PROMPTS_DIR.reddit),
    blog: new FilePromptStore(CHANNEL_PROMPTS_DIR.blog),
    newsletter: new FilePromptStore(CHANNEL_PROMPTS_DIR.newsletter),
  };
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

/** One valid, gate-passing draft per channel — reused across tests so the fan-out's happy path is consistent everywhere. */
export function goodChannelDraft(channel: CampaignChannel): unknown {
  switch (channel) {
    case "x":
      return {
        text: "More teams are testing 4-day weeks this quarter. Early internal data [1] shows steady output with fewer sick days.",
        hook: "More teams are testing 4-day weeks this quarter.",
        angle: "data-point",
        targetHandle: "@acmecorp",
        mediaRefs: [],
      };
    case "linkedin": {
      const hook = "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.";
      const body = "Teams with a fixed two-day in-office schedule reported 18% [1] fewer scheduling conflicts than teams with fully flexible policies.";
      const callToAction = "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.";
      return {
        headline: "Anchor days cut scheduling friction",
        hook,
        body,
        hashtags: ["HybridWork", "FutureOfWork"],
        callToAction,
        targetAudience: "People leaders evaluating hybrid work policies",
        text: `${hook}\n\n${body}\n\n${callToAction}`,
      };
    }
    case "reddit": {
      const title = "Our team switched to a 4-day week 3 months ago — sharing what actually changed";
      const body =
        "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.\n\n" +
        "Internal tracking showed an 18% [1] drop in reported sick days across the team.\n\n" +
        "Has anyone else run a trial like this?";
      return {
        title,
        body,
        targetSubreddit: "smallbusiness",
        flair: "",
        hook: "We run a small B2B SaaS shop and moved most of engineering to a 4-day week last quarter as a trial.",
        text: `${title}\n\n${body}`,
      };
    }
    case "blog": {
      const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
      const bodyMarkdown =
        "## The problem with our old onboarding\n\nNew engineers took nearly a month before they shipped anything meaningful.\n\n" +
        "## The results after one quarter\n\nMedian time to first merged pull request dropped 47% [1], from 19 days to about 10.";
      return {
        title,
        slug: "structured-four-day-onboarding-rollout",
        excerpt: "A breakdown of the onboarding changes that actually moved the needle for our engineering team.",
        bodyMarkdown,
        headersList: ["The problem with our old onboarding", "The results after one quarter"],
        metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
        estimatedReadMinutes: 3,
        text: `${title}\n\n${bodyMarkdown}`,
      };
    }
    case "newsletter": {
      const intro = "This week we're looking at what's actually working for engineering teams right now.";
      const sections = [
        { heading: "Structured onboarding cuts ramp time", body: "New-hire ramp time dropped 47% [1] after a fixed four-day onboarding rollout." },
      ];
      const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
      const signoff = "— The Acme Weekly Team";
      const text = `${intro}\n\n${sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n")}\n\n${callToAction.text}\n\n${signoff}`;
      return {
        subjectLine: "3 teams cut onboarding time in half",
        previewText: "Plus: async standups are quietly replacing daily syncs.",
        intro,
        sections,
        callToAction,
        signoff,
        text,
      };
    }
  }
}

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

export async function setupTestEnvironment(
  clientSlug: string,
  opts: { withCampaignGoals?: boolean; withBrand?: boolean } = {},
): Promise<TestEnvironment> {
  const withCampaignGoals = opts.withCampaignGoals ?? true;
  const withBrand = opts.withBrand ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "campaign-orchestrator-test-"));
  const store = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(store);

  const seedCtx: AgentContext = { runId: "seed", clientSlug, productId: "campaign-orchestrator", runKind: "recurring", metadata: {} };
  await store.writeJson(clientSlug, ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson(clientSlug, ["client", "voice-rules"], { tone: "confident, no jargon" });
  if (withBrand) {
    await store.writeJson(clientSlug, ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  }

  // One combined config document — every channel's own intake check reads from
  // the same per-tenant client.config, alongside the orchestrator's own fields.
  const config: Record<string, unknown> = {
    xHandle: "@acmecorp",
    targetSubreddits: ["smallbusiness", "startups"],
    targetKeywords: ["engineering onboarding", "developer ramp-up time"],
    contentPillars: ["engineering culture", "team operations"],
    targetAudience: "engineering leaders at mid-size B2B SaaS companies",
    frequency: "weekly",
  };
  if (withCampaignGoals) {
    config["campaignGoals"] = "Launch awareness for the new structured-onboarding product feature across every channel this quarter.";
  }
  await store.writeJson(clientSlug, ["client", "config"], config);

  // Generous enough for the orchestrator's own 5-topic pool reservation plus
  // every channel's own internal reservation (X 1, LinkedIn 1, Reddit 1, Blog 1,
  // Newsletter up to 3) to all succeed without falling back to research.
  await tools["topics.topUp"]!.execute(
    {
      topics: [
        "structured engineering onboarding",
        "async standups",
        "on-call rotations",
        "code review culture",
        "remote hiring",
        "four-day work weeks",
        "hybrid work anchor days",
        "engineering team retention",
        "developer productivity metrics",
        "technical debt triage",
        "incident response culture",
        "manager 1:1 cadence",
      ],
    },
    { ctx: seedCtx },
  );

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

export function makeChannelRouters(): Record<CampaignChannel, ModelRouter> {
  return {
    x: fakeRouterSequence([finalTurn(goodChannelDraft("x"))]),
    linkedin: fakeRouterSequence([finalTurn(goodChannelDraft("linkedin"))]),
    reddit: fakeRouterSequence([finalTurn(goodChannelDraft("reddit"))]),
    blog: fakeRouterSequence([finalTurn(goodChannelDraft("blog"))]),
    newsletter: fakeRouterSequence([finalTurn(goodChannelDraft("newsletter"))]),
  };
}

export function goodCampaignPlan() {
  return {
    campaignName: "Q3 Structured Onboarding Launch",
    theme: "Structured processes deliver measurable team performance gains",
    targetPillars: ["engineering culture", "team operations", "product-led growth"],
    channelSlots: [
      {
        slotId: "launch-x",
        channel: "x",
        targetAudience: "engineering leaders scrolling X for a quick, sharp data point",
        angle: "data-point",
        keyMessage: "Structured 4-day onboarding cut new-hire ramp time by 47%",
      },
      {
        slotId: "launch-linkedin",
        channel: "linkedin",
        targetAudience: "B2B SaaS engineering managers and VPs browsing LinkedIn",
        angle: "thought-leadership",
        keyMessage: "Predictable onboarding structure builds team trust faster than flexibility alone",
      },
      {
        slotId: "launch-reddit",
        channel: "reddit",
        targetAudience: "r/ExperiencedDevs and r/EngineeringManagement readers who distrust marketing posts",
        angle: "value-add-discussion",
        keyMessage: "Here's exactly what we changed about onboarding and what happened afterward",
      },
      {
        slotId: "launch-blog",
        channel: "blog",
        targetAudience: "technical readers researching onboarding practices in depth",
        angle: "conceptual-guide",
        keyMessage: "A full breakdown of the four-day onboarding structure and its measured results",
      },
      {
        slotId: "launch-newsletter",
        channel: "newsletter",
        targetAudience: "newsletter subscribers who want a curated weekly digest, not a sales pitch",
        angle: "curated-digest",
        keyMessage: "This week's roundup leads with our onboarding case study alongside two related team-ops stories",
      },
    ],
  };
}

export type { ChannelRuntimeOptions };
