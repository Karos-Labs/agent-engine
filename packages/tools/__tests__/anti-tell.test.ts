import { describe, expect, it } from "vitest";
import { normalizeBannedDashes } from "@agent-engine/tool-common";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import type { AgentContext } from "@agent-engine/core";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring", metadata: {} };

/**
 * The normaliser exists so a workflow can repair the one mechanical tell
 * before `gate.lintPost` sees it; the contract worth pinning is therefore
 * "whatever comes out passes the gate's dash rule", not any one spelling.
 */
async function lintVerdict(text: string): Promise<string> {
  const outcome = await createKarosGatesTools()["gate.lintPost"]!.execute({ text, platform: "generic" }, { ctx });
  if (outcome.status !== "success") throw new Error("gate call itself failed");
  return (outcome.result as { verdict: string }).verdict;
}

describe("normalizeBannedDashes", () => {
  it("returns dash-free text byte for byte", () => {
    const text = "Nobody tells you the first hire is the one you fire.\nHire for who you're becoming.";
    expect(normalizeBannedDashes(text)).toBe(text);
  });

  it("turns a spaced em dash into a comma the way a person would have typed it", () => {
    expect(normalizeBannedDashes("The number holds up, the takeaway does not — here's why.")).toBe(
      "The number holds up, the takeaway does not, here's why.",
    );
  });

  it("treats unspaced em and en dashes the same", () => {
    expect(normalizeBannedDashes("We shipped it—faster than expected–and it held.")).toBe("We shipped it, faster than expected, and it held.");
  });

  it("keeps a numeric range as a plain hyphen", () => {
    expect(normalizeBannedDashes("See pages 4–8 and the 2024—2026 plan.")).toBe("See pages 4-8 and the 2024-2026 plan.");
  });

  it("repairs the typed double hyphen but leaves a CLI flag alone, as the gate does", () => {
    expect(normalizeBannedDashes("We shipped it -- and it works. Run it with --dry-run first.")).toBe(
      "We shipped it, and it works. Run it with --dry-run first.",
    );
  });

  it("never stacks a comma onto punctuation that is already there", () => {
    expect(normalizeBannedDashes("Three things, — none of them new.")).toBe("Three things, none of them new.");
    expect(normalizeBannedDashes("It works —, mostly.")).toBe("It works, mostly.");
  });

  it("closes a sentence a dash left hanging, at the end of the text or of a line", () => {
    expect(normalizeBannedDashes("And then —")).toBe("And then.");
    expect(normalizeBannedDashes("First line —\nSecond line.")).toBe("First line.\nSecond line.");
    expect(normalizeBannedDashes("Done. —")).toBe("Done.");
  });

  it("drops a dash that opens a line rather than starting it with a comma", () => {
    expect(normalizeBannedDashes("— the angle, hook and why-now")).toBe("the angle, hook and why-now");
  });

  it("produces text gate.lintPost's dash rule accepts, for every shape above", async () => {
    const samples = [
      "The number holds up, the takeaway does not — here's why.",
      "We shipped it—faster than expected–and it held.",
      "See pages 4–8 and the 2024—2026 plan.",
      "We shipped it -- and it works. Run it with --dry-run first.",
      "And then —",
      "— the angle, hook and why-now",
    ];
    for (const sample of samples) {
      expect(await lintVerdict(sample), sample).toBe("content_fail");
      expect(await lintVerdict(normalizeBannedDashes(sample)), sample).toBe("pass");
    }
  });
});
