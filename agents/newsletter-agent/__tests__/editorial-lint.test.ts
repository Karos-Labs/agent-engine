import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { editorialLint, type EditorialLintInput, type EditorialLintResult } from "../src/tools/editorial-lint.js";

const ctx: AgentContext = { runId: "lint_1", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring", metadata: {} };

const RESEARCH_URL = "https://futureweek.com/week-in-review-wpp-to-cut-1000-jobs/";

function clean(): EditorialLintInput {
  return {
    subjectLine: "ChatGPT ads pass a $1 billion run rate",
    previewText: "Plus: what WPP's cuts say about agency pricing.",
    intro: "Three stories this week, and one thread running through them: the agencies that moved to AI execution early are the ones winning the accounts.",
    sections: [
      {
        heading: "OpenAI says ChatGPT ads reached a $1 billion run rate",
        body:
          "OpenAI announced the figure less than 200 days after introducing ads, and is now selling them across India, Europe, the Middle East and North Africa. Our read: AI answers are now a paid placement, and media plans that ignore them are leaving budget on the table. [Read the report](" +
          RESEARCH_URL +
          ")",
        linkUrl: RESEARCH_URL,
      },
      {
        heading: "Also worth your time",
        body: "**WPP cuts up to 1,000 more jobs** under its new CEO, on top of the cuts already made this year.\n\n**Publicis wins PepsiCo** on an AI operating model rather than a creative reel.",
      },
      { heading: "One thing to do this week", body: "Ask your media partner where AI-answer placements sit in next quarter's plan. If the answer is nowhere, that is your first meeting." },
    ],
    callToAction: { text: "Book a call with the team", url: "https://karoslabs.com/call" },
    signoff: "See you next week, the Karos Labs team",
    allowedUrls: [RESEARCH_URL],
  };
}

async function lint(input: EditorialLintInput): Promise<EditorialLintResult> {
  const outcome = await editorialLint.execute(input, { ctx });
  if (outcome.status !== "success") throw new Error(`lint did not succeed: ${outcome.status}`);
  return outcome.result;
}

describe("newsletter.editorialLint", () => {
  it("passes a clean, specific edition whose links are all research URLs", async () => {
    const result = await lint(clean());
    expect(result.verdict).toBe("pass");
    expect(result.evidence).toEqual([]);
    expect(result.stats.sectionCount).toBe(3);
    expect(result.stats.linkCount).toBe(2);
  });

  it("fails a section link the run never gave it (the prep run's homepage links)", async () => {
    const input = clean();
    input.sections[0]!.linkUrl = "https://futureweek.com";
    const result = await lint(input);
    expect(result.verdict).toBe("content_fail");
    expect(result.evidence.join("\n")).toContain("sections[0].linkUrl links to https://futureweek.com");
  });

  it("fails an inline markdown link and a bare URL outside the allowlist, but not the CTA's own URL", async () => {
    const input = clean();
    input.sections[1]!.body += " More at [the source](https://example.org/story) and https://example.org/other";
    const result = await lint(input);
    expect(result.verdict).toBe("content_fail");
    expect(result.evidence.filter((e) => e.includes("example.org"))).toHaveLength(2);
    expect(result.evidence.some((e) => e.includes("karoslabs.com"))).toBe(false);
  });

  it("treats tracking parameters, a trailing slash and case as the same URL", async () => {
    const input = clean();
    input.sections[0]!.linkUrl = "HTTPS://futureweek.com/week-in-review-wpp-to-cut-1000-jobs?utm_source=newsletter&utm_medium=email";
    expect((await lint(input)).verdict).toBe("pass");
  });

  it("fails the verdict sentences the sonnet drafts kept producing, quoting the line", async () => {
    const input = clean();
    input.sections[0]!.body = "Publicis won the PepsiCo account with an AI model. That is the tell. The window is narrowing.";
    const result = await lint(input);
    expect(result.verdict).toBe("content_fail");
    expect(result.evidence.some((e) => e.includes('"that is the tell"'))).toBe(true);
    expect(result.evidence.some((e) => e.includes('"the window is narrowing"'))).toBe(true);
  });

  it("fails a generic section heading and a throat-clearing intro", async () => {
    const input = clean();
    input.sections[2]!.heading = "What This Means For You";
    input.intro = "Welcome to this week's edition. Let's dive in.";
    const result = await lint(input);
    expect(result.verdict).toBe("content_fail");
    expect(result.evidence.some((e) => e.includes("could head any edition"))).toBe(true);
    expect(result.evidence.some((e) => e.includes("welcome to this week"))).toBe(true);
    expect(result.evidence.some((e) => e.includes("let's dive"))).toBe(true);
  });

  it("fails an exclamation mark or a dash in the inbox fields, which no other gate ever sees", async () => {
    const input = clean();
    input.subjectLine = "Big week for AI ads!";
    input.previewText = "WPP cuts jobs — again";
    const result = await lint(input);
    expect(result.verdict).toBe("content_fail");
    expect(result.evidence.some((e) => e.startsWith("subjectLine contains an exclamation mark"))).toBe(true);
    expect(result.evidence.some((e) => e.startsWith("previewText contains a banned dash"))).toBe(true);
  });

  it("only WARNS on patterns with legitimate uses: the reframe, Title Case, vocabulary, a question opener", async () => {
    const input = clean();
    input.sections[0]!.body = "The fee is not about cost. It is about structure. We leverage the landscape to unlock value.";
    input.sections[0]!.heading = "Publicis Wins PepsiCo Account On An Operating Model";
    input.intro = "Ever wondered why the agencies are cutting staff? Here is the week.";
    const result = await lint(input);
    expect(result.verdict).toBe("pass");
    expect(result.warnings.some((w) => w.includes("not X. It is Y."))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Title Case"))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"leverage"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes("rhetorical question"))).toBe(true);
  });

  it("warns on uniform sentence rhythm and symmetrical sections, and on a body outside the length band", async () => {
    const same = "This sentence has exactly seven words here.";
    const body = Array.from({ length: 4 }, () => same).join(" ");
    const input = clean();
    // Every prose field marches at the same length, the way a templated
    // edition does, so the rhythm check has nothing but uniformity to measure.
    input.intro = `${same} ${same}`;
    input.callToAction.text = "Book the call and bring your plan.";
    input.signoff = "See you next week from the team.";
    input.sections = [
      { heading: "First specific heading", body },
      { heading: "Second specific heading", body },
      { heading: "Third specific heading", body },
    ];
    const result = await lint(input);
    expect(result.verdict).toBe("pass");
    expect(result.warnings.some((w) => w.includes("sentence rhythm is uniform"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("within 15% of the same length"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("floor is 350"))).toBe(true);
    expect(result.stats.sentenceLengthVariation).not.toBeNull();
  });

  it("does not count a markdown heading or a bullet marker as a sentence", async () => {
    const input = clean();
    input.sections[1]!.body = "- **WPP** cuts jobs.\n- **Publicis** wins PepsiCo.\n- **Reddit** opens AI Max to everyone.";
    const result = await lint(input);
    expect(result.verdict).toBe("pass");
    expect(result.stats.sentenceCount).toBeGreaterThan(3);
  });
});
