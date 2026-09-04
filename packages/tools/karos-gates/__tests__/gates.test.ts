import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createKarosGatesTools } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

const gates = createKarosGatesTools();

async function verdictOf(toolName: string, args: unknown) {
  const tool = gates[toolName];
  if (!tool) throw new Error(`no such gate: ${toolName}`);
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") throw new Error(`gate call itself failed: ${JSON.stringify(outcome)}`);
  return outcome.result as { verdict: string; [k: string]: unknown };
}

describe("gate.lintPost", () => {
  it("passes clean, in-limit text", async () => {
    expect((await verdictOf("gate.lintPost", { text: "A perfectly reasonable post.", platform: "linkedin" })).verdict).toBe("pass");
  });

  it("fails empty text", async () => {
    expect((await verdictOf("gate.lintPost", { text: "   " })).verdict).toBe("content_fail");
  });

  it("fails text over the platform's length limit", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "x".repeat(300), platform: "twitter" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("uses Reddit's much longer selftext limit (40000), not the generic 5000", async () => {
    const withinReddit = await verdictOf("gate.lintPost", { text: "x".repeat(10000), platform: "reddit" });
    expect(withinReddit.verdict).toBe("pass");
    const overReddit = await verdictOf("gate.lintPost", { text: "x".repeat(40001), platform: "reddit" });
    expect(overReddit.verdict).toBe("content_fail");
  });

  it("uses blog's long-form editorial ceiling (20000), not the generic 5000", async () => {
    const withinBlog = await verdictOf("gate.lintPost", { text: "x".repeat(12000), platform: "blog" });
    expect(withinBlog.verdict).toBe("pass");
    const overBlog = await verdictOf("gate.lintPost", { text: "x".repeat(20001), platform: "blog" });
    expect(overBlog.verdict).toBe("content_fail");
  });

  it("uses newsletter's 10000-char body ceiling, not the generic 5000", async () => {
    const withinNewsletter = await verdictOf("gate.lintPost", { text: "x".repeat(8000), platform: "newsletter" });
    expect(withinNewsletter.verdict).toBe("pass");
    const overNewsletter = await verdictOf("gate.lintPost", { text: "x".repeat(10001), platform: "newsletter" });
    expect(overNewsletter.verdict).toBe("content_fail");
  });

  it("fails text with an unresolved markdown link", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "Check out [our site]() for more.", platform: "generic" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text containing an em dash", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it — faster than expected." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text containing an en dash", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "See pages 4–8 for details." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text with a single exclamation mark (default limit is 0, zero-tolerance)", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it!" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("passes text with a single exclamation mark when maxExclamationMarks explicitly raises the limit", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it!", maxExclamationMarks: 1 });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails text with a literal double ASCII hyphen (the typed em-dash stand-in)", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it -- and it works." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text with more exclamation marks than the limit", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it! It works! Try it!" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("respects a custom maxExclamationMarks", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "Wow! Amazing! Incredible!", maxExclamationMarks: 3 });
    expect(verdict.verdict).toBe("pass");
  });

  it.each(["We're thrilled to announce this.", "So excited to share this.", "Honored to partner with you.", "This is a total game-changer.", "Let's dive in.", "A rich tapestry of ideas."])(
    "fails a default AI-cliche phrase: %s",
    async (text) => {
      const verdict = await verdictOf("gate.lintPost", { text });
      expect(verdict.verdict).toBe("content_fail");
    },
  );

  it("fails a client-specific banned phrase passed via bannedPhrases", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "Unlock your full potential today.", bannedPhrases: ["unlock your full potential"] });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("skips the anti-slop check entirely when checkAntiSlop is false", async () => {
    const verdict = await verdictOf("gate.lintPost", { text: "We shipped it — thrilled to announce!!", checkAntiSlop: false });
    expect(verdict.verdict).toBe("pass");
  });

  it.each(["Here's a walkthrough. Check out my latest project on GitHub.", "Our platform helps teams ship faster."])(
    "fails a legacy pitch-tell phrase restored to the shared bank: %s",
    async (text) => {
      const verdict = await verdictOf("gate.lintPost", { text });
      expect(verdict.verdict).toBe("content_fail");
    },
  );

  describe("false-positive exemptions (Phase 2.5 fix-batch)", () => {
    it("passes a markdown table delimiter row without flagging it as a double hyphen", async () => {
      const verdict = await verdictOf("gate.lintPost", {
        text: "A quick comparison.\n\n| Plan | Price |\n|---|---|\n| Basic | $10 |\n| Pro | $20 |",
      });
      expect(verdict.verdict).toBe("pass");
    });

    it("passes a markdown table delimiter row with alignment colons", async () => {
      const verdict = await verdictOf("gate.lintPost", { text: "| Plan | Price |\n|:---|---:|\n| Basic | $10 |" });
      expect(verdict.verdict).toBe("pass");
    });

    it("passes a CLI-style flag token without flagging it as a double hyphen", async () => {
      const verdict = await verdictOf("gate.lintPost", { text: "Run the command with the --dry-run flag first to preview changes." });
      expect(verdict.verdict).toBe("pass");
    });

    it("still fails a genuine double-hyphen dash used as an em-dash stand-in, even in text that also has a CLI flag", async () => {
      const verdict = await verdictOf("gate.lintPost", {
        text: "Run it with --dry-run first--that way nothing ships by accident.",
      });
      expect(verdict.verdict).toBe("content_fail");
    });

    it("passes embedded CSS containing !important without flagging it as an exclamation mark", async () => {
      const verdict = await verdictOf("gate.lintPost", { text: "Add this rule: .banner { display: none !important; }" });
      expect(verdict.verdict).toBe("pass");
    });

    it("still fails a genuine exclamation mark in text that also contains !important", async () => {
      const verdict = await verdictOf("gate.lintPost", { text: "Add this rule: .banner { display: none !important; } Ship it now!" });
      expect(verdict.verdict).toBe("content_fail");
    });
  });
});

describe("gate.noPlaceholder", () => {
  it("passes text with no placeholder markers", async () => {
    expect((await verdictOf("gate.noPlaceholder", { text: "The launch is scheduled for next week." })).verdict).toBe("pass");
  });

  it.each(["Insert {{company_name}} here", "TODO: add the CTA", "Lorem ipsum dolor sit amet", "<placeholder> for the headline"])(
    "fails text containing a placeholder marker: %s",
    async (text) => {
      expect((await verdictOf("gate.noPlaceholder", { text })).verdict).toBe("content_fail");
    },
  );
});

describe("gate.brandCompliance", () => {
  it("passes text with no forbidden terms and no missing disclaimer", async () => {
    const verdict = await verdictOf("gate.brandCompliance", {
      text: "Our platform helps you grow. Results may vary.",
      forbiddenTerms: ["guaranteed", "cheapest"],
      requiredDisclaimer: "results may vary",
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails text containing a forbidden term", async () => {
    const verdict = await verdictOf("gate.brandCompliance", {
      text: "This is the cheapest option on the market.",
      forbiddenTerms: ["cheapest"],
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text missing a required disclaimer", async () => {
    const verdict = await verdictOf("gate.brandCompliance", {
      text: "Guaranteed results in 30 days.",
      requiredDisclaimer: "results may vary",
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("passes but flags configStatus: unconfigured when no rules are set at all", async () => {
    const verdict = await verdictOf("gate.brandCompliance", { text: "Anything at all." });
    expect(verdict.verdict).toBe("pass");
    expect(verdict["configStatus"]).toBe("unconfigured");
    expect((verdict["evidence"] as string[])[0]).toMatch(/no brand compliance rules configured/i);
  });

  it("reports configStatus: configured when forbiddenTerms is set, even with an empty list result", async () => {
    const verdict = await verdictOf("gate.brandCompliance", { text: "Anything at all.", forbiddenTerms: ["banned-word"] });
    expect(verdict.verdict).toBe("pass");
    expect(verdict["configStatus"]).toBe("configured");
  });

  it("reports configStatus: configured when only requiredDisclaimer is set", async () => {
    const verdict = await verdictOf("gate.brandCompliance", { text: "Results may vary.", requiredDisclaimer: "results may vary" });
    expect(verdict.verdict).toBe("pass");
    expect(verdict["configStatus"]).toBe("configured");
  });

  it.each(["This strategy offers guaranteed returns.", "It's a completely risk-free opportunity.", "Enjoy guaranteed income for life.", "There is zero risk involved.", "Lock in a guaranteed profit today."])(
    "fails a default banned promise/hype phrase even with no forbiddenTerms configured: %s",
    async (text) => {
      const verdict = await verdictOf("gate.brandCompliance", { text });
      expect(verdict.verdict).toBe("content_fail");
      expect(verdict["reason"]).toMatch(/banned promise\/hype phrase/i);
    },
  );

  it("matches a banned promise/hype phrase case-insensitively", async () => {
    const verdict = await verdictOf("gate.brandCompliance", { text: "GUARANTEED RETURNS every single month." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("the banned promise/hype bank is always active, on top of a client's own forbiddenTerms", async () => {
    const verdict = await verdictOf("gate.brandCompliance", {
      text: "This is risk-free and also the cheapest option.",
      forbiddenTerms: ["cheapest"],
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["evidence"]).toEqual(expect.arrayContaining(["risk-free", "cheapest"]));
  });
});

describe("gate.leakCheck", () => {
  it("passes clean text", async () => {
    expect((await verdictOf("gate.leakCheck", { text: "We shipped a new feature this week." })).verdict).toBe("pass");
  });

  it("fails text containing an API-key-shaped secret", async () => {
    const verdict = await verdictOf("gate.leakCheck", { text: "oops, key is sk-abcdefghijklmnopqrstuvwxyz123456" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text containing a local filesystem path", async () => {
    const verdict = await verdictOf("gate.leakCheck", { text: "see /Users/tomer/Documents/internal-notes.md" });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails text containing a client-specific internal term", async () => {
    const verdict = await verdictOf("gate.leakCheck", { text: "Project Falcon launches Monday", extraTerms: ["Project Falcon"] });
    expect(verdict.verdict).toBe("content_fail");
  });
});

describe("gate.numbersSourced", () => {
  it("passes text with no numeric claims", async () => {
    expect((await verdictOf("gate.numbersSourced", { text: "We had a great quarter." })).verdict).toBe("pass");
  });

  it("fails a numeric claim that has a citation marker but no source content backing the actual figure", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% [1] year over year." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails a numeric claim whose source is attached but doesn't actually contain the figure", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% year over year.", sources: ["Q3 earnings report"] });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("passes a numeric claim whose exact figure is verified against the attached source content", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Revenue grew 43% year over year.",
      sources: ["Q3 earnings report: revenue grew 43% year over year, driven by enterprise renewals."],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails a numeric claim with no citation and no attached source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% year over year." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails when the source contains a different figure than the one claimed (legacy's '15-20 does not support 20' rule)", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Revenue grew 43% year over year.",
      sources: ["Q3 earnings report: revenue grew between 15% and 20% year over year."],
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails a dollar-figure claim with no source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "We raised $1.2 million in funding." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("verifies a range the draft quotes faithfully, against the same range in the source", async () => {
    // 2026-09-04: a fully-sourced Karos Labs report was held for five figures
    // that were all present in its sources, every one as a range endpoint
    // ($500-$2,000, $100-$500, $20-$200, $15-$115, 200-400%). Checking the
    // endpoint alone could not tell a faithful quotation from a cherry-pick,
    // and rejected both.
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Competitor pricing runs $500-$2,000/month across the category.",
      sources: ["Market map: average revenue per customer: $500-$2,000/month. Implied ARR..."],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("verifies a range from its LEFT endpoint too, not just its right", async () => {
    // The first cut of this fix widened leftward only, so a draft quoting
    // "$100-$500/month" still failed when `$100` was the extracted claim —
    // the range runs to its right. Two of the seven claims on the real held
    // run were exactly this shape.
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "General platforms serve these use cases at $100-$500/month.",
      sources: ["Most are smaller deployments, $100-$500/month average."],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("does not widen across a neighbouring number into a range that no source contains", async () => {
    // An unbounded walk outward from the claim swallows whatever is nearby:
    // "in 2024, $100-$500" would widen to "2024,$100-$500", which appears in
    // no source, silently un-verifying a figure that IS quoted exactly.
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "In 2024, pricing ran $100-$500/month.",
      sources: ["Most are smaller deployments, $100-$500/month average."],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("verifies a percentage range the same way", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "The category is growing 200-400% YoY.",
      sources: ["...a small ($5b+ category) but growing 200-400% YoY off this base."],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("tolerates an en dash in the draft against a hyphen in the source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Pricing runs $15–$115/mo.",
      sources: ["Frase | SEO content | $15-$115/mo | growth"],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("STILL fails a cherry-picked endpoint asserted as the value, even when the source has the range", async () => {
    // The property the range fix must not cost: quoting "$500-$2,000" is
    // sourced; asserting "customers pay $2,000" from that same source is not.
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Customers pay $2,000 per month.",
      sources: ["Market map: average revenue per customer: $500-$2,000/month."],
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["evidence"]).toEqual(["$2,000"]);
  });

  it("STILL fails a range the sources do not contain at all", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Competitor pricing runs $900-$3,500/month.",
      sources: ["Market map: average revenue per customer: $500-$2,000/month."],
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("Phase 2.5 fix-batch regression: a source saying a range's upper bound ('15-20%') does not verify an isolated claim of that endpoint ('20%')", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Revenue grew 20% year over year.",
      sources: ["The report showed 15-20% growth across the portfolio."],
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["evidence"]).toEqual(["20%"]);
  });

  it("Phase 2.5 fix-batch regression: a source containing a larger number ('145%') does not verify an unrelated claim that happens to be a digit-suffix of it ('45%')", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Churn rose 45% this quarter.",
      sources: ["Internal tracking showed churn rose 145% this quarter."],
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["evidence"]).toEqual(["45%"]);
  });

  it("still passes when the exact claimed figure appears in the source as its own standalone number, not as a fragment of a larger one", async () => {
    const verdict = await verdictOf("gate.numbersSourced", {
      text: "Revenue grew 20% year over year.",
      sources: ["The report showed a clean 20% growth figure across the portfolio."],
    });
    expect(verdict.verdict).toBe("pass");
  });
});

describe("gate.subredditRules", () => {
  it("passes but flags configStatus: unconfigured when nothing is configured", async () => {
    const verdict = await verdictOf("gate.subredditRules", { text: "A fine post.", subreddit: "smallbusiness" });
    expect(verdict.verdict).toBe("pass");
    expect(verdict["configStatus"]).toBe("unconfigured");
  });

  it("fails when the subreddit is off-limits for this client", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      offLimits: true,
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["reason"]).toMatch(/off-limits/i);
  });

  it("fails when the subreddit bans AI-assisted content", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      aiContentBanned: true,
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["reason"]).toMatch(/ai-assisted/i);
  });

  it("fails when disclosure is required and the draft is missing it", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post with no disclosure.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      disclosureRequired: true,
      requiredDisclosure: "I work for Acme",
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("passes when disclosure is required and the draft includes it", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme. Here's what we found.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      disclosureRequired: true,
      requiredDisclosure: "I work for Acme",
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails when the account's karma is below the configured minimum", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      minKarma: 100,
      accountKarma: 10,
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails when the account is younger than the configured minimum age", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      minAccountAgeDays: 30,
      accountAgeDays: 2,
    });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("passes when a karma floor is configured but the account's karma isn't known (cannot check, not assumed to fail)", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      minKarma: 100,
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("passes cleanly when fully configured and nothing is violated", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "A fine post.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      minKarma: 100,
      accountKarma: 500,
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict["configStatus"]).toBe("configured");
  });

  it("fails a mention attempted while the account is still in its warming period", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: true,
      accountWarmingUntil: "2026-09-01T00:00:00.000Z",
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["reason"]).toMatch(/warming/i);
  });

  it("passes a mention attempted once the warming period has elapsed", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: true,
      accountWarmingUntil: "2026-01-01T00:00:00.000Z",
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("does not check warming when no mention was attempted (a value-only reply during warming is fine)", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Here's what actually worked for us, no product mentioned.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: false,
      accountWarmingUntil: "2099-01-01T00:00:00.000Z",
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails a mention attempted before the per-subreddit mention cooldown has elapsed", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: true,
      lastMentionAt: "2026-08-01T00:00:00.000Z",
      mentionCooldownDays: 60,
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict["reason"]).toMatch(/cooldown/i);
  });

  it("passes a mention attempted once the cooldown window has elapsed", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: true,
      lastMentionAt: "2026-01-01T00:00:00.000Z",
      mentionCooldownDays: 60,
      now: "2026-08-15T00:00:00.000Z",
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("cannot check the cooldown without a caller-supplied now (passes rather than assuming failure)", async () => {
    const verdict = await verdictOf("gate.subredditRules", {
      text: "Full disclosure: I work for Acme.",
      subreddit: "smallbusiness",
      configStatus: "configured",
      mentionAttempted: true,
      lastMentionAt: "2026-08-01T00:00:00.000Z",
      mentionCooldownDays: 60,
    });
    expect(verdict.verdict).toBe("pass");
  });
});

describe("every gate registers with the expected toolVersion", () => {
  /**
   * The invariant worth holding is that a verdict reports the SAME version the
   * tool declares — that is what makes a telemetry record traceable to the code
   * that produced it.
   *
   * This used to also assert every gate was literally "1.0.0", which was true
   * only until the first gate was ever bumped and had to break the moment one
   * was. `gate.numbersSourced` reached 1.1.0 when it learned to verify a quoted
   * range as a range; pinning the whole registry to one version would make
   * every future bump look like a regression.
   */
  it("carries a toolVersion in both the AgentTool and the GateVerdict", async () => {
    for (const [name, tool] of Object.entries(gates)) {
      expect(tool.version, `${name} declares no version`).toMatch(/^\d+\.\d+\.\d+$/);
      const verdict = await verdictOf(name, defaultArgsFor(name));
      expect(verdict["toolVersion"], `${name}'s verdict disagrees with its declared version`).toBe(tool.version);
    }
  });

  it("pins gate.numbersSourced at the range-aware version", async () => {
    // Named explicitly so reverting the range fix without reverting the version
    // — or the reverse — is caught here rather than in telemetry months later.
    expect(gates["gate.numbersSourced"]!.version).toBe("1.1.0");
  });
});

function defaultArgsFor(toolName: string): unknown {
  switch (toolName) {
    case "gate.lintPost":
      return { text: "fine" };
    case "gate.noPlaceholder":
      return { text: "fine" };
    case "gate.brandCompliance":
      return { text: "fine" };
    case "gate.leakCheck":
      return { text: "fine" };
    case "gate.numbersSourced":
      return { text: "fine" };
    case "gate.subredditRules":
      return { text: "fine", subreddit: "smallbusiness" };
    default:
      throw new Error(`no default args for ${toolName}`);
  }
}
