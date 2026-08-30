import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEDUPE_SIMILARITY_THRESHOLD, similarity, type AgentContext } from "@agent-engine/core";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * AU20 (SCRUM-304): the acceptance criterion — a planted NEAR-duplicate is
 * caught before the article can pass review.
 *
 * "Near", not byte-identical, on purpose: this agent's only anti-repetition
 * mechanism was the `recentPosts` directive in the drafting prompt, which is
 * advisory. An article that reverses its section order and rewrites its
 * headings is still last month's article, and nothing downstream ever measured
 * whether it was. The planted draft below scores well over `evaluateDedupe`'s
 * calibrated threshold while sharing neither its title nor a single heading
 * verbatim with the piece it recycles.
 *
 * Both fixtures clear `BLOG_MIN_WORD_COUNT` (600), so step 12's render check
 * passes and the run's only content problem is the repetition.
 */

const params = { runId: "blog_dedupe_1", clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

const PUBLISHED_TITLE = "How A Structured First Week Cut Our Onboarding Time In Half";
const PUBLISHED_PARAS = [
  "## Why the old first week failed\n\nNew engineers took nearly a month before they shipped anything meaningful, and that gap had nothing to do with ability. Most of the delay came from not knowing who owned which system, where the current runbook lived, or which service actually held a piece of logic. The code itself was rarely the blocker. What slowed everyone down was the absence of a predictable path through the opening week, so every cohort quietly reinvented onboarding from scratch and asked the same scattered questions in the same channels.",
  "## The informal fix that did not hold\n\nFor a long stretch our answer was to assign a buddy and hope the pairing worked out. Some pairings were excellent. Many were not, and there was no consistent floor under the experience regardless of who happened to be free that week. Managers spotted the pattern in retrospective after retrospective long before anybody treated it as a process problem worth fixing on purpose, which is the part that still bothers us when we look back at it honestly.",
  "## What we actually changed\n\nWe restructured the opening week into four fixed days, each with one narrow goal rather than a loose list of things a new hire should eventually get to. Day one was environment setup end to end, finishing with a real deploy to a sandbox. Day two paired the new hire with an engineer who walked the two or three systems closest to their team. Day three handed over a small scoped ticket chosen in advance. Day four closed with a review in front of the whole team.",
  "## The results after one quarter\n\nAcross the engineers who went through the new process, median time to a first merged pull request dropped by roughly half. Just as importantly the variance between individuals narrowed: under the old approach some new hires needed six weeks and others needed nine days, and that spread alone made it hard to plan work around anybody new. Retention at the ninety day mark held steady across the cohort, which mattered to us as much as the raw speed did.",
  "## What the managers had to give up\n\nThe schedule only worked because managers gave up something real for it. Choosing a day three ticket a week ahead meant reading the backlog with a stranger in mind rather than grabbing whatever sat on top, and several managers said that was the hardest part of the whole change. It also exposed how much of our backlog was written for people who already knew the system, which is a separate problem we are still working through and probably will be for a long while yet.",
  "## What we would do differently\n\nThe biggest gap in our first run was documentation for the paired session on day two. Two different pairs ran that session in noticeably different ways and the new hires compared notes and noticed immediately. Write the walkthrough down before your first cohort goes through it, not after you have already watched it go sideways. We also underestimated how much day three depended on a manager preparing a ticket in advance, and the one week a manager scrambled was the one week the schedule slipped.",
  "## Where to start\n\nIf your team is rethinking onboarding, test a structured first week before you assume the underlying problem is your documentation, your codebase or your new hires. Structure was the fix in our case and it is cheap enough to rule out first. Nothing about the technical content changed at all; only the shape of the week around it did, and that distinction turned out to matter far more than we expected when we started measuring what came out the other side.",
];

const NEAR_DUPLICATE_TITLE = "What A Structured First Week Did For Our Onboarding Time";
const NEAR_DUPLICATE_PARAS = [
  "## Where we would start again\n\nIf your team is rethinking onboarding, test a structured first week before you assume the underlying problem is your documentation, your codebase or your new hires. Structure was the fix in our case and it is cheap enough to rule out first. Nothing about the technical content changed at all; only the shape of the week around it did, and that distinction turned out to matter far more than we expected when we started measuring what came out the other side.",
  "## What we would change next time\n\nThe biggest gap in our first run was documentation for the paired session on day two. Two different pairs ran that session in noticeably different ways and the new hires compared notes and noticed immediately. Write the walkthrough down before your first cohort goes through it, not after you have already watched it go sideways. We also underestimated how much day three depended on a manager preparing a ticket in advance, and the one week a manager scrambled was the one week the schedule slipped.",
  "## What managers had to give up\n\nThe schedule only worked because managers gave up something real for it. Choosing a day three ticket a week ahead meant reading the backlog with a stranger in mind rather than grabbing whatever sat on top, and several managers said that was the hardest part of the whole change. It also exposed how much of our backlog was written for people who already knew the system, which is a separate problem we are still working through and probably will be for a long while yet.",
  "## The numbers after a quarter\n\nAcross the engineers who went through the new process, median time to a first merged pull request dropped by roughly half. Just as importantly the variance between individuals narrowed: under the old approach some new hires needed six weeks and others needed nine days, and that spread alone made it hard to plan work around anybody new. Retention at the ninety day mark held steady across the cohort, which mattered to us as much as the raw speed did.",
  "## The change itself\n\nWe restructured the opening week into four fixed days, each with one narrow goal rather than a loose list of things a new hire should eventually get to. Day one was environment setup end to end, finishing with a real deploy to a sandbox. Day two paired the new hire with an engineer who walked the two or three systems closest to their team. Day three handed over a small scoped ticket chosen in advance. Day four closed with a review in front of the whole team.",
  "## The informal fix that never held\n\nFor a long stretch our answer was to assign a buddy and hope the pairing worked out. Some pairings were excellent. Many were not, and there was no consistent floor under the experience regardless of who happened to be free that week. Managers spotted the pattern in retrospective after retrospective long before anybody treated it as a process problem worth fixing on purpose, which is the part that still bothers us when we look back at it honestly.",
  "## Why our old first week failed\n\nNew engineers took nearly a month before they shipped anything meaningful, and that gap had nothing to do with ability. Most of the delay came from not knowing who owned which system, where the current runbook lived, or which service actually held a piece of logic. The code itself was rarely the blocker. What slowed everyone down was the absence of a predictable path through the opening week, so every cohort quietly reinvented onboarding from scratch and asked the same scattered questions in the same channels.",
];

const FRESH_TITLE = "Why We Deleted Most Of Our Alerts And Slept Better For It";
const FRESH_PARAS = [
  "## The pager was lying to us\n\nOver a single autumn our on call rota woke somebody up more than eighty times, and almost none of those wakeups produced an action anybody would defend in daylight. An alert fired, a tired person acknowledged it, glanced at a dashboard, saw nothing obviously broken and went back to bed. The signal had become noise so gradually that nobody could point to the week it happened. We had built a rota around answering a phone that mostly rang by accident.",
  "## Counting before arguing\n\nBefore changing anything we spent two weeks simply tallying every page: what fired, who answered, what they did next and whether a customer would have noticed had nobody answered at all. That last column is the one that settled every argument we had been having in the abstract for a year. Roughly seven in ten pages had an empty last column. Not ambiguous, not debatable: nothing downstream of the alert would have differed if the pager had stayed silent until morning.",
  "## Deleting is a design decision\n\nWe deleted the empty ones. Not silenced, not routed to a low priority channel where they would rot quietly, deleted outright, because a muted alert is a promise you have stopped keeping while pretending otherwise. Each deletion needed a named owner willing to say out loud that this condition does not warrant waking a human. That sentence turned out to be the whole exercise. Most of our alerting had been written by people who never had to defend it at three in the morning.",
  "## The argument we kept having\n\nEvery few months somebody proposed a follow the sun rota instead, and every few months we talked ourselves out of it for reasons that had nothing to do with time zones. Handing a noisy pager to a second team does not make it quieter; it spreads the damage across more people and adds a translation layer to every incident. Fix the noise first and the rota question mostly answers itself, which is roughly what happened here once the deletions landed and stayed landed.",
  "## What replaced them\n\nWhat survived got stricter. Every remaining page now names the customer facing symptom it stands for, in the alert body, in plain words, plus the first thing to check. If nobody can write that sentence the alert does not exist. A handful of conditions moved to a morning digest, where a person reads them with coffee and full context instead of half awake. Nothing about our monitoring stack changed; only the question we asked of each rule did.",
  "## The handover habit\n\nThe other change cost nothing. Whoever holds the pager writes three lines before handing it on: what fired, what they ignored on purpose, and what they would look at first if it fired again. Three lines, in the same channel, every time. It reads like a lab notebook after a couple of months and it has caught more slow leaks than any dashboard we own, mostly because a pattern across four handovers is invisible inside any single shift.",
  "## Where it landed\n\nSix months later the rota wakes somebody roughly twice a month and both of those are usually real. Nobody has argued about fairness since, which surprised us more than the numbers did, because the fairness argument was never really about the schedule. It was about being woken for nothing. If your own rota feels unfair, count your pages for a fortnight before you redesign anything. The rota is rarely the problem; the pager is.",
];

/** As recorded into the excerpt window by step 18: title, then body. */
const asRecorded = (title: string, paras: readonly string[]) => `${title}\n${title}\n\n${paras.join("\n\n")}`;

function draft(title: string, paras: readonly string[], slug: string) {
  const bodyMarkdown = paras.join("\n\n");
  return finalTurn({
    title,
    slug,
    excerpt: "A breakdown of what actually moved the needle for our engineering team.",
    bodyMarkdown,
    headersList: paras.map((p) => p.slice(3, p.indexOf("\n"))),
    metaDescription: "What we changed, what it cost, and what we would do differently next time.",
    estimatedReadMinutes: 5,
    text: `${title}\n\n${bodyMarkdown}`,
    faqItems: [],
  });
}

describe("blog-agent verified de-duplication (AU20)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("catches a planted near-duplicate before review, redrafts, and ships the fresh article", async () => {
    const published = asRecorded(PUBLISHED_TITLE, PUBLISHED_PARAS);
    const nearDuplicate = asRecorded(NEAR_DUPLICATE_TITLE, NEAR_DUPLICATE_PARAS);
    const fresh = asRecorded(FRESH_TITLE, FRESH_PARAS);
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    expect(nearDuplicate).not.toBe(published);
    expect(NEAR_DUPLICATE_TITLE).not.toBe(PUBLISHED_TITLE);
    expect(similarity(nearDuplicate, published)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(fresh, published)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const seedCtx: AgentContext = { runId: "prior-run", clientSlug: "acme", productId: "blog-agent", runKind: "recurring", metadata: {} };
    await env.tools["ledger.recordOutputExcerpt"]!.execute({ agentId: "blog-agent", runId: "prior-run", excerpt: published }, { ctx: seedCtx });

    const router = fakeRouterSequence([
      draft(NEAR_DUPLICATE_TITLE, NEAR_DUPLICATE_PARAS, "structured-first-week-onboarding-time"),
      draft(FRESH_TITLE, FRESH_PARAS, "deleted-most-of-our-alerts"),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // The headline claim, asserted first so a regression here reads as what it
    // is: without the verified check the near-duplicate is what ships.
    expect(result.output.preview).toContain(FRESH_TITLE);

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
    // offending article, and cleared the same check.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("09-draft-post-attempt-2");
    const cleared = await durableStore.getStep(params.runId, "09a-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    const history = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "blog-agent"]);
    expect(history?.map((e) => e.excerpt)).toContain(fresh);
    expect(history?.map((e) => e.excerpt)).not.toContain(nearDuplicate);
  }, 60000);
});
