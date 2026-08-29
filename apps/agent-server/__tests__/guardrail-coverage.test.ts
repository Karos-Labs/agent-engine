import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which workflows run the terminal topic guardrail, and which deliberately do
 * not.
 *
 * A source sweep rather than a runtime assertion, because the property is
 * "every publishing agent calls it" — a fact about the code, not about one
 * run. A new agent that publishes and forgets the call is exactly what this
 * catches, and it is the kind of omission nothing else would surface: the
 * agent works, its tests pass, and it simply never checks.
 *
 * ## Why three agents are excluded
 *
 * The guardrail asks "does this text engage a subject the client's PUBLIC
 * voice avoids". That question only makes sense for something published.
 *
 * `intel-report-agent` and `seo-geo-agent` produce internal deliverables — a
 * competitive intelligence report, an SEO audit — read by the client's own
 * team. A client who does not POST about a subject may very well need to be
 * briefed on it, and running the guardrail there would block legitimate
 * research for saying the quiet part in a document nobody publishes. That is
 * a worse failure than the one being prevented.
 *
 * `campaign-orchestrator` fans out to the channel agents, each of which
 * checks its own drafted output — but the campaign PLAN itself
 * (`campaignName`/`theme`/`targetPillars` and each slot's
 * `targetAudience`/`angle`/`keyMessage`) is generated once, up front, and is
 * shown directly in `13-campaign-review`'s own gate payload. SCRUM-302/AU18
 * found that gap — a plan already visible to a human reviewer with no
 * guardrail ever run over it — so `campaign-orchestrator` now calls
 * `runTopicGuardrail` over the plan and moved from `INTERNAL` to `PUBLISHES`
 * below.
 *
 * If one of the two remaining `INTERNAL` agents ever starts publishing, move
 * it too and this test fails until someone does.
 */

// Anchored on this file, not process.cwd(): vitest's cwd depends on how the
// suite was invoked (repo root vs package root) and the two disagree.
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agents");

/** Agents whose deliverable reaches the client's audience. */
const PUBLISHES = [
  "blog-agent",
  "branded-shorts-agent",
  "campaign-orchestrator",
  "instagram-agent",
  "landing-builder-agent",
  "linkedin-agent",
  "newsletter-agent",
  "reddit-agent",
  "reputation-agent",
  "tiktok-agent",
  "x-agent",
];

/** Agents whose deliverable is internal, with the reason recorded above. */
const INTERNAL = ["intel-report-agent", "seo-geo-agent"];

function workflowSource(agent: string): string {
  const dir = join(AGENTS_DIR, agent, "src", "workflow");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("terminal topic guardrail coverage", () => {
  it.each(PUBLISHES)("%s runs the terminal topic guardrail", (agent) => {
    expect(workflowSource(agent)).toContain("runTopicGuardrail(");
  });

  it.each(INTERNAL)("%s deliberately does not — its deliverable is not published", (agent) => {
    expect(workflowSource(agent)).not.toContain("runTopicGuardrail(");
  });

  it("accounts for every agent package, so a new one cannot be forgotten", () => {
    // The check that makes the two lists above meaningful. Without it, adding
    // an agent and adding it to neither list would pass silently.
    const packages = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // setup-agents records a filled form; it drafts nothing and publishes
      // nothing, so it is neither a publisher nor an internal deliverable.
      .filter((name) => name !== "setup-agents");

    expect([...PUBLISHES, ...INTERNAL].sort()).toEqual(packages.sort());
  });

  it("uses the shared helper rather than a local copy", () => {
    // It was implemented twice before it was implemented once. A third copy
    // that quietly differs is the failure mode worth preventing.
    for (const agent of PUBLISHES) {
      const src = workflowSource(agent);
      expect(src, `${agent} builds its own guardrail verifier`).not.toContain("buildGuardrailSystemPrompt(");
    }
  });
});
