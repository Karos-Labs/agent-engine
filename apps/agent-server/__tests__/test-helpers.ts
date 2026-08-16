import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, ModelRouter } from "@agent-engine/core";
import { InMemoryPromptStore } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { MemoryDurableStepStore } from "@agent-engine/workflow";
import type { AgentRuntimeDeps } from "../src/wiring/workflows.js";

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  runtimeDeps: AgentRuntimeDeps;
  durableStore: MemoryDurableStepStore;
  cleanup: () => Promise<void>;
}

/**
 * A `ModelRouter` that serves every agent in the fan-out from one shared
 * instance (matching `buildWorkflowForProduct`'s real production wiring,
 * where every channel and the campaign strategy step share `deps.router`)
 * by matching the requested `schema` against a pool of candidate outputs,
 * rather than a strict call-order queue — the campaign orchestrator's
 * 5-channel fan-out runs concurrently, so which channel's `router.complete()`
 * actually lands first is not deterministic; matching by schema is.
 */
export function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        // BaseAgent's turnSchema is a discriminated union of {type:"tool_call",...}
        // | {type:"final", output: <the agent's own outputSchema>} — never the raw
        // draft directly (see packages/core/src/agent/base-agent.ts's runOneTurn) —
        // so the candidate has to be validated wrapped, exactly like every other
        // fakeRouterSequence/finalTurn helper across this codebase already does.
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }
      }
      throw new Error("smartFakeRouter: no candidate output matches the requested schema");
    },
    async completeAlias() {
      throw new Error("smartFakeRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

export function goodXDraft() {
  return {
    text: "More teams are testing 4-day weeks this quarter. Early internal data [1] shows steady output with fewer sick days.",
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "data-point",
    targetHandle: "@acmecorp",
    mediaRefs: [],
  };
}

export function goodLinkedInDraft() {
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

export function goodRedditDraft() {
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

export function goodBlogDraft() {
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

export function goodNewsletterDraft() {
  const intro = "This week we're looking at what's actually working for engineering teams right now.";
  const sections = [
    { heading: "Structured onboarding cuts ramp time", body: "New-hire ramp time dropped 47% [1] after a fixed four-day onboarding rollout." },
  ];
  const callToAction = { text: "Read the full breakdown", url: "https://example.com/full" };
  const signoff = "— The Acme Weekly Team";
  const text = `${intro}\n\n${sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n")}\n\n${callToAction.text}\n\n${signoff}`;
  return { subjectLine: "3 teams cut onboarding time in half", previewText: "Plus: async standups are quietly replacing daily syncs.", intro, sections, callToAction, signoff, text };
}

export function goodCampaignPlan() {
  return {
    campaignName: "Q3 Structured Onboarding Launch",
    theme: "Structured processes deliver measurable team performance gains",
    targetPillars: ["engineering culture", "team operations", "product-led growth"],
    channelSlots: [
      { slotId: "launch-x", channel: "x", targetAudience: "engineering leaders scrolling X for a quick, sharp data point", angle: "data-point", keyMessage: "Structured 4-day onboarding cut new-hire ramp time by 47%" },
      { slotId: "launch-linkedin", channel: "linkedin", targetAudience: "B2B SaaS engineering managers and VPs browsing LinkedIn", angle: "thought-leadership", keyMessage: "Predictable onboarding structure builds team trust faster than flexibility alone" },
      { slotId: "launch-reddit", channel: "reddit", targetAudience: "r/ExperiencedDevs and r/EngineeringManagement readers who distrust marketing posts", angle: "value-add-discussion", keyMessage: "Here's exactly what we changed about onboarding and what happened afterward" },
      { slotId: "launch-blog", channel: "blog", targetAudience: "technical readers researching onboarding practices in depth", angle: "conceptual-guide", keyMessage: "A full breakdown of the four-day onboarding structure and its measured results" },
      { slotId: "launch-newsletter", channel: "newsletter", targetAudience: "newsletter subscribers who want a curated weekly digest, not a sales pitch", angle: "curated-digest", keyMessage: "This week's roundup leads with our onboarding case study alongside two related team-ops stories" },
    ],
  };
}

/** All six agents' craft prompts, seeded with short placeholder content — this is a server-wiring test, not a prompt-resolution test, so the real markdown files' exact text doesn't matter, only that every promptId the six workflows resolve is registered. */
export function makeSharedPromptStore(): InMemoryPromptStore {
  const store = new InMemoryPromptStore();
  store.setPrompt("x-craft", "1", "X craft guidance.");
  store.setPrompt("linkedin-craft", "1", "LinkedIn craft guidance.");
  store.setPrompt("reddit-craft", "1", "Reddit craft guidance.");
  store.setPrompt("blog-craft", "1", "Blog craft guidance.");
  store.setPrompt("newsletter-craft", "1", "Newsletter craft guidance.");
  store.setPrompt("campaign-craft", "1", "Campaign strategy guidance.");
  return store;
}

const BASE_CTX_FIELDS = { productId: "agent-server-test", runKind: "recurring" as const };

/** Seeds one tenant with everything every one of the six workflows' own intake checks needs, under a shared WorkspaceStore. */
export async function setupTestEnvironment(clientSlug = "acme"): Promise<TestEnvironment> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-server-test-"));
  const store = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(store);

  const seedCtx: AgentContext = { runId: "seed", clientSlug, ...BASE_CTX_FIELDS, metadata: {} };
  await store.writeJson(clientSlug, ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson(clientSlug, ["client", "voice-rules"], { tone: "confident, no jargon" });
  await store.writeJson(clientSlug, ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  await store.writeJson(clientSlug, ["client", "config"], {
    xHandle: "@acmecorp",
    targetSubreddits: ["smallbusiness", "startups"],
    targetKeywords: ["engineering onboarding", "developer ramp-up time"],
    contentPillars: ["engineering culture", "team operations"],
    targetAudience: "engineering leaders at mid-size B2B SaaS companies",
    frequency: "weekly",
    campaignGoals: "Launch awareness for the new structured-onboarding product feature across every channel this quarter.",
  });
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

  const durableStore = new MemoryDurableStepStore();
  const promptStore = makeSharedPromptStore();
  const router = smartFakeRouter([
    goodCampaignPlan(),
    goodXDraft(),
    goodLinkedInDraft(),
    goodRedditDraft(),
    goodBlogDraft(),
    goodNewsletterDraft(),
  ]);

  return {
    rootDir,
    store,
    durableStore,
    runtimeDeps: { tools, promptStore, router },
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
