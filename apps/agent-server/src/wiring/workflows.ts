import type { AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "@agent-engine/agent-x";
import { createLinkedInAgentWorkflow } from "@agent-engine/agent-linkedin";
import { createRedditAgentWorkflow } from "@agent-engine/agent-reddit";
import { createBlogAgentWorkflow } from "@agent-engine/agent-blog";
import { createNewsletterAgentWorkflow } from "@agent-engine/agent-newsletter";
import { createCampaignWorkflow, type CampaignChannel } from "@agent-engine/campaign-orchestrator";

/** Every product this server can dispatch a run to (RFC-02) — the five channel agents plus the campaign orchestrator. */
export const KNOWN_PRODUCT_IDS = [
  "x-agent",
  "linkedin-agent",
  "reddit-agent",
  "blog-agent",
  "newsletter-agent",
  "campaign-orchestrator",
] as const;
export type ProductId = (typeof KNOWN_PRODUCT_IDS)[number];

export function isKnownProductId(value: string): value is ProductId {
  return (KNOWN_PRODUCT_IDS as readonly string[]).includes(value);
}

/** The shared runtime every agent workflow factory needs — structurally identical across all six packages. */
export interface AgentRuntimeDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

export type WorkflowFn = (wf: WorkflowContext) => Promise<unknown>;

const ALL_CHANNELS: readonly CampaignChannel[] = ["x", "linkedin", "reddit", "blog", "newsletter"];

/**
 * Builds the workflow function for one run request, dispatching on
 * `productId`. Every channel agent's promptId is globally unique (`x-craft`,
 * `linkedin-craft`, ...), so one shared `PromptStore` instance correctly
 * serves all of them — the campaign orchestrator's own `channelPromptStores`/
 * `channelRouters` maps below all point at the exact same `deps.promptStore`/
 * `deps.router` instances rather than constructing five separate ones (a
 * real `ModelRouter`/`PromptStore` has no per-call state that fan-out
 * concurrency would race on — that concern is specific to scripted test
 * routers, documented on `CreateCampaignWorkflowOptions` itself).
 */
export function buildWorkflowForProduct(productId: ProductId, deps: AgentRuntimeDeps): WorkflowFn {
  switch (productId) {
    case "x-agent":
      return createXAgentWorkflow(deps);
    case "linkedin-agent":
      return createLinkedInAgentWorkflow(deps);
    case "reddit-agent":
      return createRedditAgentWorkflow(deps);
    case "blog-agent":
      return createBlogAgentWorkflow(deps);
    case "newsletter-agent":
      return createNewsletterAgentWorkflow(deps);
    case "campaign-orchestrator": {
      const channelPromptStores = Object.fromEntries(ALL_CHANNELS.map((channel) => [channel, deps.promptStore])) as Record<
        CampaignChannel,
        PromptStore
      >;
      const channelRouters = Object.fromEntries(ALL_CHANNELS.map((channel) => [channel, deps.router])) as Record<CampaignChannel, ModelRouter>;
      return createCampaignWorkflow({ ...deps, channelPromptStores, channelRouters });
    }
  }
}
