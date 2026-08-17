import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createBlogAgentWorkflow } from "../src/workflow/create-blog-agent-workflow.js";
import { BLOG_MAX_WORD_COUNT } from "../src/tools/render-preview.js";
import type { BlogJsonLd } from "../src/tools/json-ld.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

/** A genuinely long-form (700+ word) article body — real, on-topic paragraphs, no filler repetition. */
function longBodyMarkdown(): string {
  return (
    "## The problem with our old onboarding\n\n" +
    "New engineers took nearly a month before they shipped anything meaningful, and that gap was never caused by a shortage of " +
    "ability. Most new hires spent the bulk of their first three weeks trying to figure out who owned a given service, which " +
    "document was current and which had been abandoned two reorganizations ago, and where the actual source of truth lived for a " +
    "system that touched their work. The technical material itself was rarely the real blocker. A capable engineer could read the " +
    "codebase just fine; what slowed everyone down was the absence of a predictable path through that first week, so every cohort " +
    "effectively reinvented onboarding from scratch and asked the same scattered questions that had already been answered for " +
    "someone else three months earlier.\n\n" +
    "## What we actually changed\n\n" +
    "We restructured the first week into four fixed days, each with one specific and narrow goal instead of a loose list of things " +
    "a new hire should eventually get around to. Day one was environment setup end to end: local build, full test suite, and a " +
    "single deploy to a sandbox environment, so that by the end of day one every new engineer had concrete proof their machine " +
    "actually worked. Day two paired the new hire with an engineer who walked through the two or three systems most relevant to " +
    "their team, focused on how the pieces connect to each other rather than reading every file line by line. Day three handed the " +
    "new hire a small, genuinely scoped ticket chosen in advance by their manager, so nobody spent the morning hunting for something " +
    "appropriate to work on. Day four closed the week with a short review session involving the whole team, where the new hire " +
    "walked through what they built and asked the questions that had piled up over the previous three days.\n\n" +
    "## The results after one quarter\n\n" +
    "Across the twelve engineers who went through the new process, median time to first merged pull request dropped sharply [1], " +
    "falling from nineteen days down to about ten. Just as important, the variance between individual engineers narrowed sharply: " +
    "under the old approach some new hires needed six weeks before their first real contribution while others needed nine days, " +
    "and that spread alone made it hard to plan work around new team members with any real confidence. Retention at the ninety-day " +
    "mark also held steady across the cohort, which mattered to us as much as raw speed did, since a faster ramp that came at the " +
    "cost of early attrition would not have counted as a genuine win.\n\n" +
    "## What we'd do differently\n\n" +
    "The biggest gap in our first run was documentation for the paired-engineer session on day two: two different pairs ran that " +
    "session in noticeably different ways, and new hires noticed the inconsistency immediately once they compared notes with each " +
    "other. If your team decides to try something similar, write the walkthrough script down before your first cohort goes through " +
    "it, not after you have already seen where it went sideways. We also underestimated how much day three depended on managers " +
    "actually preparing a ticket in advance; the one week where a manager scrambled to find a ticket the morning of day three was " +
    "the one week where the whole schedule slipped. If your team is rethinking its own onboarding, a structured first week is worth " +
    "testing before you assume the underlying problem is your documentation, your codebase, or your new hires themselves.\n\n" +
    "## One more thing worth naming\n\n" +
    "It is tempting to treat a rollout like this as finished once the first cohort clears it successfully, but the real test comes " +
    "with the second and third cohorts, run by people who were not in the room when the plan was designed. Write the reasoning down " +
    "alongside the schedule itself, not just the steps: explain why day one is environment setup and not a lecture on architecture, " +
    "why the ticket on day three has to be scoped small enough to finish in a single day, and why the whole plan tops out at four " +
    "days instead of stretching to a full two weeks. A team that only inherits the checklist tends to drift from it the first time " +
    "a deadline gets tight, while a team that inherits the reasoning behind the checklist is far more likely to adapt it sensibly " +
    "instead of quietly abandoning it."
  );
}

function goodDraft(overrides: Record<string, unknown> = {}) {
  const title = "How We Cut Onboarding Time in Half With a Structured 4-Day Rollout";
  const bodyMarkdown = longBodyMarkdown();
  return {
    title,
    slug: "structured-four-day-onboarding-rollout",
    excerpt: "A breakdown of the onboarding changes that actually moved the needle.",
    bodyMarkdown,
    headersList: ["The problem with our old onboarding", "What we actually changed", "The results after one quarter", "What we'd do differently"],
    metaDescription: "How a structured 4-day onboarding rollout cut new-hire ramp time in half.",
    estimatedReadMinutes: 5,
    text: `${title}\n\n${bodyMarkdown}`,
    faqItems: [],
    ...overrides,
  };
}

describe("Blog agent length floor + FAQ + canonical URL (RFC-02 §5 migration audit)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("holds a draft under the 600-word minimum at step 12, distinct from the upper-ceiling reasons", async () => {
    const promptStore = makePromptStore();
    const shortBody = "## A header\n\nThis article is much too short to count as a real long-form piece for this client.";
    const router = fakeRouterSequence([
      finalTurn(
        goodDraft({
          bodyMarkdown: shortBody,
          text: `A reasonable title\n\n${shortBody}`,
        }),
      ),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_under_floor" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/words.*below.*minimum/i);
  });

  it("holds a draft over the word-count ceiling at step 12, distinct from the under-floor reason", async () => {
    const promptStore = makePromptStore();
    // Deliberately generic, repetitive filler — this fixture exists purely to push
    // the mechanical word count past BLOG_MAX_WORD_COUNT (3,000) while staying
    // comfortably under gate.lintPost's/render.preview's 20,000-character body
    // limit, so the ceiling case is exercised in isolation from the character
    // ceiling, the self-critique length gate, and any dash/exclamation/banned-phrase check.
    const overCeilingWords = Array.from({ length: BLOG_MAX_WORD_COUNT + 100 }, (_, i) => ["week", "team", "plan", "work"][i % 4]);
    const overCeilingBody = `## The results\n\n${overCeilingWords.join(" ")}.`;
    const router = fakeRouterSequence([
      finalTurn(
        goodDraft({
          bodyMarkdown: overCeilingBody,
          text: `A reasonable title\n\n${overCeilingBody}`,
        }),
      ),
    ]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_over_ceiling" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(new RegExp(`over the ${BLOG_MAX_WORD_COUNT}-word target ceiling`, "i"));
    expect(result.reason).not.toMatch(/below.*minimum/i);
  });

  it("persists a populated faqItems block into the deliverable, and a matching FAQPage JSON-LD block", async () => {
    const promptStore = makePromptStore();
    const faqItems = [
      { question: "How long did the rollout take to see results?", answer: "About one quarter before the ramp-time drop was clearly measurable." },
      { question: "Did retention suffer from the faster ramp?", answer: "No, retention at the 90-day mark held steady across the cohort." },
    ];
    const router = fakeRouterSequence([finalTurn(goodDraft({ faqItems }))]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_faq" });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { faqItems?: unknown; jsonLd?: BlogJsonLd } }>("acme", [
      "ledger",
      "deliverables",
      "blog_run_faq",
      "_",
    ]);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.faqItems).toEqual(faqItems);

    const jsonLd = deliverables[0]!.data.deliverable.jsonLd!;
    expect(jsonLd.blogPosting["@type"]).toBe("BlogPosting");
    expect(jsonLd.faqPage).toBeDefined();
    expect(jsonLd.faqPage!["@type"]).toBe("FAQPage");
    expect(jsonLd.faqPage!.mainEntity).toHaveLength(2);
    expect(jsonLd.faqPage!.mainEntity[0]).toEqual({
      "@type": "Question",
      name: faqItems[0]!.question,
      acceptedAnswer: { "@type": "Answer", text: faqItems[0]!.answer },
    });
  });

  it("persists a BlogPosting JSON-LD block with no faqPage when faqItems is empty", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft({ faqItems: [] }))]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_no_faq" });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { jsonLd?: BlogJsonLd } }>("acme", ["ledger", "deliverables", "blog_run_no_faq", "_"]);
    expect(deliverables).toHaveLength(1);
    const jsonLd = deliverables[0]!.data.deliverable.jsonLd!;
    expect(jsonLd.blogPosting).toBeDefined();
    expect(jsonLd.faqPage).toBeUndefined();
  });

  it("derives canonicalUrl from the client's configured website + the draft's own slug, and carries it into the JSON-LD block", async () => {
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS", website: "acme.com" });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_canonical" });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { canonicalUrl?: string; slug: string; jsonLd?: BlogJsonLd } }>("acme", [
      "ledger",
      "deliverables",
      "blog_run_canonical",
      "_",
    ]);
    expect(deliverables).toHaveLength(1);
    const deliverable = deliverables[0]!.data.deliverable;
    expect(deliverable.canonicalUrl).toBe(`https://acme.com/blog/${deliverable.slug}`);

    const blogPosting = deliverable.jsonLd!.blogPosting;
    expect(blogPosting.headline).toBe("How We Cut Onboarding Time in Half With a Structured 4-Day Rollout");
    expect(blogPosting.description).toBe("How a structured 4-day onboarding rollout cut new-hire ramp time in half.");
    expect(blogPosting.url).toBe(deliverable.canonicalUrl);
    expect(blogPosting.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": deliverable.canonicalUrl });
    expect(blogPosting.author).toEqual({ "@type": "Organization", name: "Acme Corp" });
  });

  it("leaves canonicalUrl unset when the client has no website configured, and omits mainEntityOfPage/url from the JSON-LD block", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createBlogAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "blog_run_no_website" });
    expect(result.status).toBe("completed");

    const deliverables = await env.store.listJson<{ deliverable: { canonicalUrl?: string; jsonLd?: BlogJsonLd } }>("acme", [
      "ledger",
      "deliverables",
      "blog_run_no_website",
      "_",
    ]);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.canonicalUrl).toBeUndefined();

    const blogPosting = deliverables[0]!.data.deliverable.jsonLd!.blogPosting;
    expect(blogPosting.mainEntityOfPage).toBeUndefined();
    expect(blogPosting.url).toBeUndefined();
  });
});
