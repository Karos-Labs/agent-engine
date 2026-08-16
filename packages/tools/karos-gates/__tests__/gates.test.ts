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

  it("passes a numeric claim with a citation marker", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% [1] year over year." });
    expect(verdict.verdict).toBe("pass");
  });

  it("passes a numeric claim backed by an attached source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% year over year.", sources: ["Q3 earnings report"] });
    expect(verdict.verdict).toBe("pass");
  });

  it("fails a numeric claim with no citation and no attached source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "Revenue grew 43% year over year." });
    expect(verdict.verdict).toBe("content_fail");
  });

  it("fails a dollar-figure claim with no source", async () => {
    const verdict = await verdictOf("gate.numbersSourced", { text: "We raised $1.2 million in funding." });
    expect(verdict.verdict).toBe("content_fail");
  });
});

describe("every gate registers with the expected toolVersion", () => {
  it("carries a toolVersion in both the AgentTool and the GateVerdict", async () => {
    for (const [name, tool] of Object.entries(gates)) {
      expect(tool.version).toBe("1.0.0");
      const verdict = await verdictOf(name, defaultArgsFor(name));
      expect(verdict["toolVersion"]).toBe(tool.version);
    }
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
    default:
      throw new Error(`no default args for ${toolName}`);
  }
}
