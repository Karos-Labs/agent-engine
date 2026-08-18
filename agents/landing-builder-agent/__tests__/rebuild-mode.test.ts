import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLandingBuilderAgentWorkflow } from "../src/workflow/create-landing-builder-agent-workflow.js";
import { setupTestEnvironment, smartFakeRouter, makePromptStore, goodCopy, goodCompose, goodCraftVerdict, type TestEnvironment } from "./test-helpers.js";

/** Reads back the flat data object out of the generated `.ts` content module (`export const content: LandingContent = {...};`) — mirrors the workflow's own `extractContentDataFromModule`, since the durable content state is a typed module now, not JSON. */
async function readGeneratedContent(siteRoot: string): Promise<Record<string, unknown>> {
  const source = await fs.readFile(path.join(siteRoot, "src", "content", "generated.ts"), "utf8");
  const match = /=\s*(\{[\s\S]*\});/.exec(source);
  return JSON.parse(match![1]!);
}

describe("landing-builder-agent workflow: MODE=rebuild", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("forge");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("applies the in-scope feedback delta deterministically: removes a section, adds a new one, restyles a resolved token, edits a touched section, and leaves an untouched kept section byte-stable", async () => {
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
      autoApprove: true,
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());

    // MODE=build (setup) first — establishes the durable manifest/content state.
    await engine.run(workflowFn, { runId: "run_build", clientSlug: "forge", productId: "s6", runKind: "setup" });

    const siteRoot = path.join(env.landingConfig.engineClientsRoot, "forge", "site");
    const navBefore = (await readGeneratedContent(siteRoot)).nav;

    // The client's one feedback round, dropped into the bundle (FEEDBACK.md §2/§5).
    await fs.mkdir(path.join(env.landingConfig.bundlesRoot, "forge", "feedback"), { recursive: true });
    await fs.writeFile(
      path.join(env.landingConfig.bundlesRoot, "forge", "feedback", "round-1.json"),
      JSON.stringify({
        round: 1,
        client: "forge",
        reviewedBuild: "v1",
        submittedAt: "2026-06-26T14:00:00Z",
        source: "portal",
        changes: [
          { section: "hero", op: "edit", target: "headline", note: "punchier, PR-tracking angle", verbatim: "the headline doesn't grab me", severity: "high" },
          { section: "global", op: "restyle", target: "tokens.colors.ember", note: "push toward #FF5A1A", verbatim: "make the orange more orange", severity: "normal" },
          { section: "global", op: "restyle", target: "fonts.display", note: "switch to a serif", verbatim: "different font", severity: "low" },
        ],
        additions: [{ section: "faq", reason: "refund questions", contentHints: ["refunds"], afterSection: "offering" }],
        removals: [{ section: "offering", reason: "numbers feel thin pre-launch" }],
        keeps: [{ section: "nav", note: "do not change the nav" }],
      }),
    );

    const rebuildRouter = smartFakeRouter([
      {
        lang: "en-US",
        meta: { title: "FORGE · Train like an athlete, not a tourist", description: "An adaptive strength program built around you." },
        sections: { hero: { headline: "Track every PR, punchier than before" }, faq: { questions: ["How do refunds work?"] } },
        assumptions: [],
      },
      goodCraftVerdict(),
    ]);
    const rebuildWorkflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: rebuildRouter, autoApprove: true });
    const rebuildResult = await engine.run(rebuildWorkflowFn, { runId: "run_rebuild", clientSlug: "forge", productId: "s6", runKind: "recurring" });

    expect(rebuildResult.status).toBe("completed");
    if (rebuildResult.status !== "completed") throw new Error("unreachable");
    expect(rebuildResult.output.status).toBe("ok");
    expect(rebuildResult.output.gate).toBe("pass");
    // The font restyle is a brand-identity change — out of scope for a rebuild (FEEDBACK.md §3).
    expect(rebuildResult.output.outOfScope).toHaveLength(1);
    expect(rebuildResult.output.outOfScope[0]!.reason).toMatch(/brand-identity/);

    // brand.json.feedback (FEEDBACK.md §5's audit trail) was actually persisted — round tracking
    // is no longer stuck recomputing "round 1" forever.
    const updatedBrand = JSON.parse(await fs.readFile(path.join(env.landingConfig.bundlesRoot, "forge", "brand.json"), "utf8"));
    expect(updatedBrand.feedback.lastRound).toBe(1);
    expect(updatedBrand.feedback.rounds).toHaveLength(1);

    const manifest = JSON.parse(await fs.readFile(path.join(siteRoot, "src", "content", "generated.manifest.json"), "utf8"));
    expect(manifest).not.toContain("offering");
    expect(manifest).toContain("faq");

    const content = await readGeneratedContent(siteRoot);
    expect((content.hero as { headline: string }).headline).toContain("PR");
    expect(content.offering).toBeUndefined();
    expect((content.faq as { questions: string[] }).questions).toContain("How do refunds work?");
    expect(content.nav).toEqual(navBefore); // the kept section is byte-stable

    // The carry-forward placement (footer) survived the rebuild untouched, and its embedded
    // evidence is still genuinely there — the gate's completeness check would still pass.
    expect((content.footer as { assistant?: { type: string } }).assistant?.type).toBe("chatbot");

    const globalsCss = await fs.readFile(path.join(siteRoot, "src", "app", "globals.css"), "utf8");
    expect(globalsCss).toContain("#FF5A1A");
  });

  it("supports a genuine second rebuild round once round 1 is persisted — round tracking is no longer stuck recomputing round 1 forever", async () => {
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
      autoApprove: true,
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    await engine.run(workflowFn, { runId: "run_build3", clientSlug: "forge", productId: "s6", runKind: "setup" });

    const feedbackDir = path.join(env.landingConfig.bundlesRoot, "forge", "feedback");
    await fs.mkdir(feedbackDir, { recursive: true });
    await fs.writeFile(
      path.join(feedbackDir, "round-1.json"),
      JSON.stringify({ round: 1, client: "forge", reviewedBuild: "v1", submittedAt: "2026-06-26T14:00:00Z", source: "portal", changes: [], additions: [], removals: [], keeps: [] }),
    );
    const round1 = await engine.run(
      createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: smartFakeRouter([goodCraftVerdict()]), autoApprove: true }),
      { runId: "run_rebuild3a", clientSlug: "forge", productId: "s6", runKind: "recurring" },
    );
    expect(round1.status).toBe("completed");

    await fs.writeFile(
      path.join(feedbackDir, "round-2.json"),
      JSON.stringify({ round: 2, client: "forge", reviewedBuild: "v2", submittedAt: "2026-06-27T14:00:00Z", source: "portal", changes: [], additions: [], removals: [], keeps: [] }),
    );
    const round2 = await engine.run(
      createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: smartFakeRouter([goodCraftVerdict()]), autoApprove: true }),
      { runId: "run_rebuild3b", clientSlug: "forge", productId: "s6", runKind: "recurring" },
    );
    expect(round2.status).toBe("completed");

    const updatedBrand = JSON.parse(await fs.readFile(path.join(env.landingConfig.bundlesRoot, "forge", "brand.json"), "utf8"));
    expect(updatedBrand.feedback.lastRound).toBe(2);
    expect(updatedBrand.feedback.rounds).toHaveLength(2);
  });

  it("logs an unresolved restyle (no explicit new value given) as an assumption instead of guessing", async () => {
    const workflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCopy(), goodCompose(), goodCraftVerdict()]),
      autoApprove: true,
    });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    await engine.run(workflowFn, { runId: "run_build2", clientSlug: "forge", productId: "s6", runKind: "setup" });

    await fs.mkdir(path.join(env.landingConfig.bundlesRoot, "forge", "feedback"), { recursive: true });
    await fs.writeFile(
      path.join(env.landingConfig.bundlesRoot, "forge", "feedback", "round-1.json"),
      JSON.stringify({
        round: 1,
        client: "forge",
        reviewedBuild: "v1",
        submittedAt: "2026-06-26T14:00:00Z",
        source: "portal",
        changes: [{ section: "global", op: "restyle", target: "tokens.colors.ember", note: "more orange please", verbatim: "more orange", severity: "normal" }],
        additions: [],
        removals: [],
        keeps: [],
      }),
    );

    const rebuildWorkflowFn = createLandingBuilderAgentWorkflow({
      tools: env.tools,
      promptStore: makePromptStore(),
      router: smartFakeRouter([goodCraftVerdict()]),
      autoApprove: true,
    });
    const result = await engine.run(rebuildWorkflowFn, { runId: "run_rebuild2", clientSlug: "forge", productId: "s6", runKind: "recurring" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.assumptions.some((a) => a.includes("has no explicit new value"))).toBe(true);
  });
});
