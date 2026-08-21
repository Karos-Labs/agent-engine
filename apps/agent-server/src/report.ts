import {
  qualifyGateId,
  serializeToDynamicAgentRunReport,
  type DurableStepStore,
  type DynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
  type StepRecord,
} from "@agent-engine/workflow";
import type { ProductId } from "./wiring/workflows.js";

/**
 * Every channel's own step-id shape (Phase 2.5 Batch 2 restored each
 * channel's distinct domain logic — lanes, archetypes, thread-selection —
 * so the five channels no longer share one fixed step count/shape the way
 * they did before that batch). Each list's "ai" step is the one draft step
 * a human-facing report should badge as a model call; everything else is
 * mechanical `step.code`.
 */
const X_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-select-lane",
  "09-check-engagement-cap",
  "10-draft-post",
  "11-verify-numbers-sourced",
  "12-verify-brand-compliance",
  "13-verify-link-placement",
  "14-render-preview-check",
  "15-batch-review",
  "16-verify-no-placeholder",
  "17-verify-no-leak",
  "18-persist-deliverable",
  "19-persist-manifest",
  "20-commit-and-record",
] as const;

const LINKEDIN_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-determine-archetype",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  "15-batch-review",
  "16-persist-deliverable",
  "17-persist-manifest",
  "18-commit-and-record",
] as const;

/** Reddit's own shape — the longest of the five: a pre-draft thread-selection/eligibility run (steps 08-11) precedes drafting a reply, never an original post (Phase 2.5 Batch 2.1's reply-only restoration). */
const REDDIT_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-select-target-thread",
  "09-check-thread-not-answered",
  "10-verify-subreddit-eligibility",
  "11-determine-angle",
  "12-draft-reply",
  "13-verify-numbers-sourced",
  "14-verify-brand-compliance",
  "15-verify-no-placeholder",
  "16-verify-leak-check",
  "17-render-preview-check",
  "18-batch-review",
  "19-persist-deliverable",
  "20-persist-manifest",
  "21-commit-and-record",
] as const;

const BLOG_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-determine-angle",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  "15-batch-review",
  "16-persist-deliverable",
  "17-persist-manifest",
  "18-commit-and-record",
] as const;

/** Newsletter's own shape — the hype-language scan (10) and the footer-injection structural check (12) are distinct steps so the scan never sees the platform's own injected compliance footer (Phase 2.5 Batch 1.3's self-tripping-bug fix). */
const NEWSLETTER_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topics",
  "07-select-candidates",
  "08-determine-edition-theme",
  "09-draft-post",
  "10-verify-brand-compliance",
  "11-verify-numbers-sourced",
  "12-verify-compliance-footer",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  "15-render-preview-check",
  "16-batch-review",
  "17-persist-deliverable",
  "18-persist-manifest",
  "19-commit-and-record",
] as const;

/** The five original channel agents, still on their own hand-authored fixed step shape below — every product wired in afterward uses `discoveredDescriptors` instead (see its own doc comment for why). */
const ORIGINAL_CHANNEL_PRODUCT_IDS = ["x-agent", "linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent"] as const;
type OriginalChannelProductId = (typeof ORIGINAL_CHANNEL_PRODUCT_IDS)[number];
function isOriginalChannelProduct(productId: string): productId is OriginalChannelProductId {
  return (ORIGINAL_CHANNEL_PRODUCT_IDS as readonly string[]).includes(productId);
}

/** Each channel's own draft step id — the one step a report should badge "ai" rather than "code". */
const DRAFT_STEP_ID_BY_PRODUCT: Record<OriginalChannelProductId, string> = {
  "x-agent": "10-draft-post",
  "linkedin-agent": "09-draft-post",
  "reddit-agent": "12-draft-reply",
  "blog-agent": "09-draft-post",
  "newsletter-agent": "09-draft-post",
};

/** Every channel's own possible draft-step suffix, used to recover which nested step is "the draft" for one fan-out slot without needing to know which channel occupies it (RFC-02 §4's per-slot isolation means slot order isn't fixed). */
const CHANNEL_DRAFT_STEP_SUFFIXES = Array.from(new Set(Object.values(DRAFT_STEP_ID_BY_PRODUCT)));

/**
 * Each channel's own human batch-review gate id (Phase 2.5 fix-batch). Gates
 * are persisted separately from steps/slots (`store.saveGate()`/`getGate()`,
 * never `listSteps()`/`listSlots()`) — a descriptor for one of these ids used
 * to fall straight through `serializeOneStep()`'s "never reached" branch
 * even on a genuinely completed, delivered run, reporting a real review gate
 * as `{status:"failed", error:"step did not run"}`. `buildRunReport` below
 * joins against `store.getGate()` for exactly these ids before serializing,
 * so a resolved gate reports its real status instead.
 */
const GATE_STEP_ID_BY_PRODUCT: Record<OriginalChannelProductId, string> = {
  "x-agent": "15-batch-review",
  "linkedin-agent": "15-batch-review",
  "reddit-agent": "18-batch-review",
  "blog-agent": "15-batch-review",
  "newsletter-agent": "16-batch-review",
};

/**
 * Every gate id each newly-wired product (landing-builder/branded-shorts/
 * reputation/seo-geo/intel-report) might raise — read straight from each
 * workflow's own `wf.step.gate(...)` calls, not guessed. `seo-geo-agent` is
 * the one product with two independent gates (a prompt-set review early,
 * a conditional fix-generation review later) — `resolvedGateStepRecords`
 * already accepts a list, not just one id, for exactly this case.
 */
const GATE_STEP_IDS_BY_NEW_PRODUCT: Record<Exclude<ProductId, OriginalChannelProductId | "campaign-orchestrator">, readonly string[]> = {
  "instagram-agent": ["09a-batch-review"],
  "landing-builder-agent": ["08-human-review"],
  "branded-shorts-agent": ["10-delivery-review"],
  "reputation-agent": ["10-reputation-approve-all"],
  "seo-geo-agent": ["03-prompt-set-review", "12-fix-generation-review"],
  "intel-report-agent": ["04-batch-review"],
};

/** Recovers a step id's intended ordering position from its own "NN-..." prefix — the convention every step id in this codebase already follows (`00-`, `01-`, `10a-`, ...). Ties (e.g. `"10-delivery-review"` vs `"10a-upload-to-gcs"`) fall back to a plain string compare. */
function stepOrderKey(stepId: string): [number, string] {
  const match = /^(\d+)/.exec(stepId);
  return [match ? Number(match[1]) : Number.POSITIVE_INFINITY, stepId];
}

/**
 * Builds a report descriptor list purely from what a run actually produced
 * a record for, for the five newly-wired products — unlike the original
 * five channels, these have retry loops (`branded-shorts-agent`'s
 * `08a-plan-graphics-attempt-${n}`, `reputation-agent`'s
 * `07-client-lock-cycle-${n}`) and mode-dependent branches
 * (`landing-builder-agent`'s setup-vs-rebuild path diverges as early as step
 * 02) with no single fixed step shape a hand-authored `..._STEP_IDS`
 * constant (like the five above) could describe correctly. A descriptor for
 * a step/gate id that never executes on a given run's actual path would
 * otherwise misreport as `{status:"failed", error:"step did not run"}` even
 * on a fully successful run (`serializeOneStep`'s "never reached" branch) —
 * this sidesteps that class of false failure entirely by only ever
 * describing steps and gates this run genuinely has a record for. `kind`
 * (persisted on every real `StepRecord`, RFC-01 §4) drives the "ai"/"code"
 * badge directly, rather than needing a hand-maintained "which id is the
 * draft step" map.
 */
function discoveredDescriptors(records: readonly StepRecord[]): DynamicAgentStepDescriptor[] {
  return [...records]
    .sort((a, b) => {
      const [aOrder, aId] = stepOrderKey(a.stepId);
      const [bOrder, bId] = stepOrderKey(b.stepId);
      return aOrder !== bOrder ? aOrder - bOrder : aId.localeCompare(bId);
    })
    .map((r) => ({ stepId: r.stepId, label: r.stepId, type: r.kind === "agent" ? "ai" : "code" }));
}

/** The orchestrator's own top-level gate id — see `GATE_STEP_ID_BY_PRODUCT`'s doc comment. Nested per-channel gates never apply here: `create-campaign-workflow.ts` fixes every channel slot's `autoApprove: true`, so each channel's own review step runs as an auto-approved `step.code`, not a real `step.gate` — it already appears correctly in `stepRecords`. */
const CAMPAIGN_GATE_STEP_ID = "13-campaign-review";

/**
 * Fetches every gate id relevant to this product/run and, for each one that
 * has actually been resolved (a human approved or rejected it), synthesizes
 * a `StepRecord`-shaped entry so the serializer sees it as a real, completed
 * step rather than "never reached". A gate that's still pending (part of an
 * `awaiting_gate` run) is deliberately left alone — "not yet reached" is the
 * correct read for that case, and it isn't the bug this join exists to fix.
 */
async function resolvedGateStepRecords(durableStore: DurableStepStore, runId: string, gateIds: readonly string[]): Promise<StepRecord[]> {
  const records: StepRecord[] = [];
  for (const gateId of gateIds) {
    const gate = await durableStore.getGate(qualifyGateId(runId, gateId));
    if (!gate?.response) continue;
    records.push({
      stepId: gateId,
      kind: "code",
      status: "completed",
      output: { decision: gate.response.decision, actor: gate.response.actor, ...(gate.response.reason !== undefined ? { reason: gate.response.reason } : {}) },
      costUsd: 0,
      durationMs: 0,
      startedAt: 0,
      completedAt: 0,
    });
  }
  return records;
}

/** The orchestrator's own top-level steps (RFC-02 §4) — the fan-out itself (`channel-fanout`) isn't a `step.code` id, so it isn't listed here; its slots and their nested steps are discovered dynamically below. */
const CAMPAIGN_ORCHESTRATOR_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-past-campaign-performance",
  "04-research-pull",
  "05-extract-strategic-summary",
  "06-reserve-topic-pool",
  "07-generate-strategy-plan",
  "08-validate-strategy-plan",
  "09-prepare-channel-fanout-items",
  "11-aggregate-channel-outcomes",
  "12-verify-campaign-completeness",
  "13-campaign-review",
  "14-persist-campaign-bundle",
  "15-commit-and-record",
] as const;

function channelAgentDescriptors(productId: OriginalChannelProductId): DynamicAgentStepDescriptor[] {
  const stepIds: readonly string[] =
    productId === "reddit-agent"
      ? REDDIT_AGENT_STEP_IDS
      : productId === "linkedin-agent"
        ? LINKEDIN_AGENT_STEP_IDS
        : productId === "blog-agent"
          ? BLOG_AGENT_STEP_IDS
          : productId === "newsletter-agent"
            ? NEWSLETTER_AGENT_STEP_IDS
            : X_AGENT_STEP_IDS;
  const draftStepId = DRAFT_STEP_ID_BY_PRODUCT[productId];
  return stepIds.map((stepId) => ({ stepId, label: stepId, type: stepId === draftStepId ? "ai" : "code" }));
}

/**
 * Builds each fan-out slot's descriptors from what actually ran, not a fixed
 * assumption — since Phase 2.5 Batch 2 gave each channel its own step shape,
 * a slot's draft step id now depends on which channel occupies it (not fixed
 * per slot index), so it's recovered by checking which of the five known
 * draft-step suffixes actually has a recorded step under this slot.
 */
function campaignOrchestratorDescriptors(slotIds: readonly string[], stepRecords: readonly { stepId: string }[]): DynamicAgentStepDescriptor[] {
  const topLevel: DynamicAgentStepDescriptor[] = CAMPAIGN_ORCHESTRATOR_STEP_IDS.map((stepId) => ({
    stepId,
    label: stepId,
    type: stepId === "07-generate-strategy-plan" ? "ai" : "code",
  }));
  const recordedStepIds = new Set(stepRecords.map((r) => r.stepId));
  const perSlot: DynamicAgentStepDescriptor[] = slotIds.flatMap((slotId, index) => {
    const draftStepId = CHANNEL_DRAFT_STEP_SUFFIXES.map((suffix) => `${slotId}::${suffix}`).find((candidateId) => recordedStepIds.has(candidateId));
    const entries: DynamicAgentStepDescriptor[] = [{ stepId: slotId, label: `channel slot ${index}`, type: "code" }];
    if (draftStepId !== undefined) {
      entries.push({ stepId: draftStepId, label: `channel ${index} draft`, type: "ai" });
    }
    return entries;
  });
  return [...topLevel, ...perSlot];
}

/**
 * Builds the `DynamicAgentRunReport` for one run (RFC-01 §7.2), adaptively:
 * each of the five channel agents now follows its own fixed step shape
 * (Phase 2.5 Batch 2 restored distinct domain logic per channel), and the
 * campaign orchestrator's own fan-out schedules a plan-dependent number of
 * channel slots — known only after the run actually reaches that step — so
 * its descriptor list is built from whatever slot/step records actually
 * exist for this run, not a static constant.
 */
export async function buildRunReport(
  durableStore: DurableStepStore,
  runId: string,
  productId: string,
): Promise<DynamicAgentRunReport> {
  const stepRecords = await durableStore.listSteps(runId);
  const runRecord = await durableStore.getRun(runId);

  let descriptors: DynamicAgentStepDescriptor[];
  let slotRecords: Awaited<ReturnType<DurableStepStore["listSlots"]>> = [];
  let gateStepRecords: StepRecord[];

  if (productId === "campaign-orchestrator") {
    slotRecords = await durableStore.listSlots(runId, "channel-fanout");
    gateStepRecords = await resolvedGateStepRecords(durableStore, runId, [CAMPAIGN_GATE_STEP_ID]);
    descriptors = campaignOrchestratorDescriptors(
      slotRecords.map((slot) => slot.slotId),
      stepRecords,
    );
  } else if (isOriginalChannelProduct(productId)) {
    gateStepRecords = await resolvedGateStepRecords(durableStore, runId, [GATE_STEP_ID_BY_PRODUCT[productId]]);
    descriptors = channelAgentDescriptors(productId);
  } else {
    // Any other product id — one of the five newly-wired fixed agents, or (Task 2) a
    // dynamic agent's own agentId, which has no entry here at all: dynamic agents built by
    // `buildDynamicWorkflow` never call `wf.step.gate`, so "no configured gate ids" is the
    // correct answer for one, not a lookup failure.
    const gateIds = (GATE_STEP_IDS_BY_NEW_PRODUCT as Record<string, readonly string[] | undefined>)[productId] ?? [];
    gateStepRecords = await resolvedGateStepRecords(durableStore, runId, gateIds);
    descriptors = discoveredDescriptors([...stepRecords, ...gateStepRecords]);
  }

  return serializeToDynamicAgentRunReport({
    specId: `spec_${productId}`,
    specVersion: 1,
    steps: descriptors,
    stepRecords: [...stepRecords, ...gateStepRecords],
    slotRecords,
    ...(runRecord !== undefined ? { runRecord } : {}),
  });
}
