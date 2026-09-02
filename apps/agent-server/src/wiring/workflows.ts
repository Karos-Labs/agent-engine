import type { AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import type { WorkspaceStoreLike } from "@agent-engine/tools";
import { createXAgentWorkflow } from "@agent-engine/agent-x";
import type { TemplateStore } from "@agent-engine/tool-karos-templates";
import { createInstagramAgentWorkflow } from "@agent-engine/agent-instagram";
import { createLinkedInAgentWorkflow } from "@agent-engine/agent-linkedin";
import { createRedditAgentWorkflow } from "@agent-engine/agent-reddit";
import { createBlogAgentWorkflow } from "@agent-engine/agent-blog";
import { createNewsletterAgentWorkflow } from "@agent-engine/agent-newsletter";
import { createCampaignWorkflow, type CampaignChannel } from "@agent-engine/campaign-orchestrator";
import { createLandingBuilderAgentWorkflow } from "@agent-engine/agent-landing-builder";
import { createBrandedShortsAgentWorkflow } from "@agent-engine/agent-branded-shorts";
import { createTikTokAgentWorkflow } from "@agent-engine/agent-tiktok";
import { createReputationPulseWorkflow } from "@agent-engine/agent-reputation";
import { createSeoGeoAgentWorkflow } from "@agent-engine/agent-seo-geo";
import { createIntelReportAgentWorkflow } from "@agent-engine/agent-intel-report";

/**
 * Every product this server can dispatch a run to (RFC-02) — the five
 * channel agents, the campaign orchestrator, and the five products wired in
 * afterward: `landing-builder-agent`/`branded-shorts-agent` need
 * `landing.*`/`video.*` tools merged into `AgentRuntimeDeps.tools` beyond
 * `createAllKarosTools()`'s own bundle (see `./tools.js`'s
 * `createServerTools` — the composition root that does that merge);
 * `reputation-agent`/`seo-geo-agent`/`intel-report-agent` need nothing extra,
 * every tool they call is already in `createAllKarosTools()`.
 */
export const KNOWN_PRODUCT_IDS = [
  "x-agent",
  "instagram-agent",
  "linkedin-agent",
  "reddit-agent",
  "blog-agent",
  "newsletter-agent",
  "campaign-orchestrator",
  "landing-builder-agent",
  "branded-shorts-agent",
  "reputation-agent",
  "seo-geo-agent",
  "intel-report-agent",
  // The podcast/commentary clip system, migrated from karos-tiktok-agent. Its
  // own product, not a branded-shorts variant: branded-shorts turns ONE
  // talking-head video into one short, this finds a moment inside someone
  // else's long-form episode and puts the client's commentary on it.
  "tiktok-agent",
] as const;
export type ProductId = (typeof KNOWN_PRODUCT_IDS)[number];

export function isKnownProductId(value: string): value is ProductId {
  return (KNOWN_PRODUCT_IDS as readonly string[]).includes(value);
}

/** The shared runtime every agent workflow factory needs — structurally identical across all six original packages. */
export interface AgentRuntimeDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * `reputation-agent`'s pulse-number/review claims and its response/seen/
   * crisis ledgers (RFC-08) need the same durable, GCS-backed
   * `WorkspaceStoreLike` every other tenant-scoped write in this server
   * uses. `createReputationPulseWorkflow` used to default to a local
   * file-backed store, which is correct for a test/single-process run but
   * would silently reset per Cloud Run instance in production (a stateless
   * deployment can never guarantee the same instance handles a pulse's
   * claim and its later resume). It no longer defaults to anything.
   *
   * REQUIRED (SCRUM-328 / AU45). It was optional, and two call sites papered
   * over the absence with `?? createWorkspaceStore()`. Both fallbacks were
   * dormant only because every real composition root happens to pass a store;
   * an optional field whose absence causes silent, unannounced data loss is
   * exactly the thing being removed. Every caller must supply the same store
   * instance it already built for `createAllKarosTools`, and the compiler now
   * enforces that rather than a convention.
   */
  workspaceStore: WorkspaceStoreLike;
  /**
   * `instagram-agent`'s own required `repoRoot` (`publish.renderCarousel`'s
   * `assertInside` bounds-check root — every `templateDir`/`outDir`/image
   * path in a run's `slides-data.json` is resolved and confined to this
   * directory). No safe default exists for "where this deployment's
   * templates/images actually live on disk" — optional here only because
   * every other product doesn't need it; `buildWorkflowForProduct` throws a
   * clear, specific error if `instagram-agent` is dispatched without it.
   *
   * `tiktok-agent` uses the same root, but only when a run ATTACHES its source
   * video: the attachment is a `gs://` object and has to be downloaded
   * somewhere bounded before `video.transcribe` can read it. A tiktok run that
   * passes `sourcePath` needs nothing from here, which is why that agent takes
   * it as optional and refuses only the attachment case.
   */
  repoRoot?: string;
  /**
   * The slide-template registry (`@agent-engine/tool-karos-templates`).
   *
   * Only `instagram-agent` reads it today. Optional because the registry must
   * never be able to take slide rendering down: without one, that agent reads
   * archetype templates straight off disk exactly as it did before the
   * registry existed.
   */
  templateStore?: TemplateStore;
}

export type WorkflowFn = (wf: WorkflowContext) => Promise<unknown>;

/**
 * `instagram-agent`'s `repoRoot`, env-configured the same way
 * `createLandingEngineConfigFromEnv` resolves its own roots: falls back to
 * a local, deliberately-useless default under the process cwd rather than
 * throwing at startup, matching that function's own "harmless for any
 * composition-root path that never actually dispatches this product"
 * convention (`packages/tools/karos-landing/src/create-landing-engine-
 * config-from-env.ts`).
 */
export function resolveInstagramRepoRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env["INSTAGRAM_AGENT_REPO_ROOT"];
  return configured && configured.length > 0 ? configured : "./.instagram-engine";
}

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
    case "instagram-agent":
      if (!deps.repoRoot) {
        throw new Error(
          'buildWorkflowForProduct: AgentRuntimeDeps.repoRoot is required to dispatch "instagram-agent" (set INSTAGRAM_AGENT_REPO_ROOT at your composition root — see wiring/tools.js)',
        );
      }
      return createInstagramAgentWorkflow({
        ...deps,
        repoRoot: deps.repoRoot,
        ...(deps.templateStore ? { templateStore: deps.templateStore } : {}),
      });
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
    case "landing-builder-agent":
      return createLandingBuilderAgentWorkflow(deps);
    case "branded-shorts-agent":
      return createBrandedShortsAgentWorkflow(deps);
    case "tiktok-agent":
      return createTikTokAgentWorkflow(deps);
    case "reputation-agent":
      return createReputationPulseWorkflow({ ...deps, store: deps.workspaceStore });
    // ── The two research agents run unattended, by product decision ──
    //
    // Neither produces content that goes out under the client's name: they
    // produce INTELLIGENCE the portal reads back (`intel-report-agent`'s
    // deliverable IS the portal's `ClientReport`; `seo-geo-agent`'s is the
    // client's SEO/GEO snapshot). Every other product here drafts something a
    // human publishes, which is what their gates are for.
    //
    // `autoApprove` skips the gate and synthesizes an approval with
    // `actor: "system"` — deliberately NOT a `timeout: { duration: "0s",
    // onTimeout: "auto_approve" }`, which reaches the same decision by the
    // other road and records it under `actor: "system:gate-timeout"`.
    // `step-gate.ts` keeps those two actors distinct precisely so a reviewer
    // can tell "nobody was meant to look at this" from "somebody was supposed
    // to look and didn't in time", and only the first is true here. It also
    // makes the approval instant rather than lazy: the timeout road only fires
    // when something next touches the run, so a run with nothing polling it
    // waits regardless of how short the duration is.
    //
    // What this changes per agent:
    //   seo-geo-agent   — three gates that ALREADY auto-approved after 1h
    //     (SCRUM-273/T-A20). Same outcome, no wait.
    //   intel-report-agent — one gate at `24h`/`hold`, with no auto-approve at
    //     all. This is the real change, and the fix for the gap SCRUM-274's
    //     handoff flagged: the portal awaits this deliverable for 70 minutes
    //     (`ONBOARDING_DELIVERABLE_TIMEOUT_MS` in karosCMO), so an unattended
    //     Regenerate could only ever end in that timeout.
    //
    // That 70-minute ceiling stays where it is. It is no longer sized against
    // a gate wait — it is now a plain "this run is stuck" bound.
    case "seo-geo-agent":
      return createSeoGeoAgentWorkflow({ ...deps, autoApprove: true });
    case "intel-report-agent":
      return createIntelReportAgentWorkflow({ ...deps, autoApprove: true });
  }
}
