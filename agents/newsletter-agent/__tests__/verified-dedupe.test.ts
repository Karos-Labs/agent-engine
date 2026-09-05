import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEDUPE_SIMILARITY_THRESHOLD, similarity, type AgentContext } from "@agent-engine/core";
import { createNewsletterAgentWorkflow } from "../src/workflow/create-newsletter-agent-workflow.js";
import { editionRouter, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * AU20 (SCRUM-304): the acceptance criterion — a planted NEAR-duplicate is
 * caught before the edition can pass review.
 *
 * "Near", not byte-identical, on purpose: this agent's only anti-repetition
 * mechanism was the `recentPosts` directive in the drafting prompt, which is
 * advisory. An edition that swaps its two sections around and reworks the
 * subject line is still last week's edition, and nothing downstream ever
 * measured whether it was. The planted draft below scores well over
 * `evaluateDedupe`'s calibrated threshold while sharing neither its subject
 * line nor its section order with the edition it recycles.
 *
 * Note on what is scored: 09a scores the COMPOSED draft
 * (`${subjectLine}\n${text}`, compliance footer included), because that is
 * exactly what step 19 records back into the excerpt window. This client has
 * no footer fields configured (see `setupTestEnvironment`), so composition is
 * a no-op here and the footer path is covered by `compliance-footer.test.ts`.
 */

const params = { runId: "nl_dedupe_1", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

const PUBLISHED_SUBJECT = "Structured onboarding keeps cutting ramp time";
const PUBLISHED_BODY =
  "This week we are looking at what is actually working for engineering teams right now.\n\n" +
  "## Structured onboarding keeps cutting ramp time\n\n" +
  "New hire ramp time dropped sharply at every team that replaced a loose reading list with a fixed four day plan.\n\n" +
  "## Async standups keep gaining ground\n\n" +
  "Several teams have quietly swapped the daily standup for a written update and have not gone back.\n\n" +
  "Read the full breakdown\n\nThe Acme Weekly Team";
/** As recorded into the excerpt window by step 19: subject line, then body. */
const PUBLISHED = `${PUBLISHED_SUBJECT}\n${PUBLISHED_BODY}`;

const NEAR_DUPLICATE_SUBJECT = "Structured onboarding is still cutting ramp time";
const NEAR_DUPLICATE_BODY =
  "This week we are again looking at what is actually working for engineering teams right now.\n\n" +
  "## Async standups keep gaining ground\n\n" +
  "Several teams have quietly swapped the daily standup for a written update and have not gone back.\n\n" +
  "## Structured onboarding keeps cutting ramp time\n\n" +
  "New hire ramp time dropped sharply at every team that replaced a loose reading list with a fixed four day plan.\n\n" +
  "Read the full breakdown\n\nThe Acme Weekly Team";

const FRESH_SUBJECT = "What your on-call rotation actually costs";
const FRESH_BODY =
  "A short one this week, about the rota nobody wants to own.\n\n" +
  "## Paging is a design problem\n\n" +
  "Most of the alerts that wake somebody up were never worth waking anybody up for, and the fix is upstream of the rota.\n\n" +
  "## Handover notes beat heroics\n\n" +
  "The teams with the calmest weekends are the ones that write three lines before they hand the pager over.\n\n" +
  "Read the full breakdown\n\nThe Acme Weekly Team";

function draft(subjectLine: string, text: string) {
  const [intro, , sectionOneBody, , sectionTwoBody] = text.split("\n\n");
  return finalTurn({
    subjectLine,
    previewText: "Plus: what we would do differently next time.",
    intro,
    sections: [
      { heading: "First section", body: sectionOneBody ?? "" },
      { heading: "Second section", body: sectionTwoBody ?? "" },
    ],
    callToAction: { text: "Read the full breakdown", url: "https://example.com/full" },
    signoff: "The Acme Weekly Team",
    text,
  });
}

describe("newsletter-agent verified de-duplication (AU20)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("catches a planted near-duplicate before review, redrafts, and ships the fresh edition", async () => {
    const nearDuplicate = `${NEAR_DUPLICATE_SUBJECT}\n${NEAR_DUPLICATE_BODY}`;
    const fresh = `${FRESH_SUBJECT}\n${FRESH_BODY}`;
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    expect(nearDuplicate).not.toBe(PUBLISHED);
    expect(similarity(nearDuplicate, PUBLISHED)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(fresh, PUBLISHED)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const seedCtx: AgentContext = { runId: "prior-run", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring", metadata: {} };
    await env.tools["ledger.recordOutputExcerpt"]!.execute({ agentId: "newsletter-agent", runId: "prior-run", excerpt: PUBLISHED }, { ctx: seedCtx });

    const router = editionRouter([
      draft(NEAR_DUPLICATE_SUBJECT, NEAR_DUPLICATE_BODY),
      draft(FRESH_SUBJECT, FRESH_BODY),
    ]);
    const workflowFn = createNewsletterAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // The headline claim, asserted first so a regression here reads as what it
    // is: without the verified check the near-duplicate is what ships.
    expect(result.output.preview).toBe(FRESH_BODY);

    // The advisory half was present and was not enough: the do-not-repeat
    // directive reached the first drafting prompt, and the model returned the
    // near-duplicate anyway. Only the verified check stopped it.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]![0])).toContain("RECENTLY PUBLISHED");

    const flagged = await durableStore.getStep(params.runId, "09a-verify-not-duplicate");
    expect(flagged?.status).toBe("completed");
    const verdict = flagged?.output as { status: string; maxSimilarity: number; comparedCount: number; mostSimilarRunId?: string };
    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("prior-run");
    expect(verdict.comparedCount).toBe(1);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);

    // The hit COST the draft: a second drafting pass ran, steered by the
    // offending edition, and cleared the same check.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("09-draft-post-attempt-2");
    const cleared = await durableStore.getStep(params.runId, "09a-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    const history = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "newsletter-agent"]);
    expect(history?.map((e) => e.excerpt)).toContain(fresh);
    expect(history?.map((e) => e.excerpt)).not.toContain(nearDuplicate);
  }, 60000);
});
