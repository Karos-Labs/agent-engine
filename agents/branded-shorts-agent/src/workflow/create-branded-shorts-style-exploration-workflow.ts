import type { AgentContext, AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext } from "@agent-engine/workflow";
import { BrandedShortsStyleExplorationAgent } from "../agent/branded-shorts-style-exploration-agent.js";
import { styleTokenFidelityGate } from "./style-token-fidelity-gate.js";
import type { StyleCandidate, StyleExplorationWorkflowResult } from "./types.js";

export interface CreateBrandedShortsStyleExplorationWorkflowOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the `style_exploration_lock` human gate and records a synthetic
   * `actor: "system"` approval of the FIRST proposed candidate instead — off
   * by default, so a real run genuinely pauses at `awaiting_gate` until a
   * human locks one. Same opt-out convention as every other migrated
   * agent's `autoApprove` (`seo-geo-agent`, `reputation-agent`); intended for
   * tests only.
   */
  autoApprove?: boolean;
}

function toAgentContext(wf: WorkflowContext): AgentContext {
  return {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };
}

/**
 * `createBrandedShortsStyleExplorationWorkflow()` (RFC-06 §1/§2/§7, SKILL.md
 * "per-client onboarding" step 2): the one-time, per-client onboarding
 * workflow — propose three candidate style directions from the client's own
 * brand material, hold for a human to lock exactly one
 * (`style_exploration_lock`), persist the lock. Runs once per client, ever;
 * the per-upload pipeline (`createBrandedShortsAgentWorkflow`) refuses to
 * run for a client with no locked style on file.
 *
 * `GateResponseSchema` (`@agent-engine/core`) is a binary approve/reject
 * contract with no "pick one of N" field — there is no other gate anywhere
 * in this codebase that resolves a multi-candidate choice, so this workflow
 * follows the same free-form-`reason`-field convention every other gate
 * payload already uses for arbitrary text: the human's approval names the
 * locked candidate by its exact `name` in `reason`. An approval whose
 * `reason` does not match one of the three proposed names is a tooling
 * failure, never a silent default to candidate zero.
 */
export function createBrandedShortsStyleExplorationWorkflow(options: CreateBrandedShortsStyleExplorationWorkflowOptions) {
  const tools = options.tools;

  return async function styleExplorationWorkflow(wf: WorkflowContext): Promise<StyleExplorationWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: the client's brand material — Style Exploration cannot run without it ──
    const brand = await wf.step.code("00-load-brand-material", async (): Promise<Record<string, unknown>> => {
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client has not configured a brand kit yet — Style Exploration needs branding guidelines on file first");
      }
      return brandOutcome.result as Record<string, unknown>;
    });

    // ── 01: propose exactly three candidate directions (the bounded judgment step) ──
    // `gate.styleTokenFidelity` is registered here, not in the shared tool bundle: it's
    // scoped to this one agent's selfCritique loop and needs `brand` closed over per run.
    const agentTools: AgentToolRegistry = { ...tools, "gate.styleTokenFidelity": styleTokenFidelityGate };
    const explorationAgent = new BrandedShortsStyleExplorationAgent({ router: options.router, tools: agentTools, promptStore: options.promptStore }, brand);
    const explorationResult = await wf.step.agent("01-propose-candidates", explorationAgent, { brand });
    if (explorationResult.status === "content_fail") {
      throw new WorkflowHeld(`style exploration did not clear its own output validation: ${explorationResult.status}`);
    }
    if (explorationResult.status !== "completed") {
      throw new WorkflowToolingFailure(`style exploration step resolved to "${explorationResult.status}"`);
    }
    const candidates: StyleCandidate[] = explorationResult.finalOutput!.candidates;

    // ── 02: human gate — the one touchpoint per client, ever ──
    const decision = options.autoApprove
      ? await wf.step.code("02-style-lock", () => ({ decision: "approve" as const, actor: "system", reason: candidates[0]!.name, at: new Date().toISOString() }))
      : await wf.step.gate("02-style-lock", {
          kind: "style_exploration_lock",
          payload: { runId: wf.runId, candidates },
          requiredRole: "account_manager",
          timeout: { duration: "7d", onTimeout: "hold" },
        });

    if (decision.decision !== "approve") {
      throw new WorkflowHeld(`style exploration rejected: ${decision.reason ?? "no reason given"}`);
    }

    const lockedName = decision.reason?.trim();
    const locked = candidates.find((c) => c.name === lockedName);
    if (!locked) {
      throw new WorkflowToolingFailure(
        `style_exploration_lock approval's reason ("${decision.reason ?? ""}") does not name one of the three proposed candidates: ${candidates.map((c) => c.name).join(", ")}`,
      );
    }

    // ── 03: persist the lock — every future run for this client reads this, never re-asks ──
    await wf.step.code("03-persist-locked-style", async () => {
      const outcome = await tools["memory.updateBeliefs"]!.execute({ diff: { brandedShortsLockedStyle: locked } }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`memory.updateBeliefs failed: ${outcome.status}`);
      }
    });

    // ── 04: commit + record ──
    await wf.step.code("04-commit-and-record", async () => {
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__style_locked`, summary: `Style Exploration locked "${locked.name}" for this client — every future video uses this treatment.` },
        { ctx },
      );
    });

    return { candidates, lockedCandidateName: locked.name };
  };
}
