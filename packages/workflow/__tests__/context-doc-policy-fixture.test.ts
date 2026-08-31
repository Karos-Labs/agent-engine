import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Bare specifier, not a relative "../src/index.js" import, and deliberately
// so: every agent workflow file imported below (via a genuine cross-package
// relative import, since none of the four agents is this package's own
// dependency) reaches `WorkflowBlockedIntake`/`step.code` etc. through its
// OWN bare `@agent-engine/workflow` import. `WorkflowEngine`'s internal
// `err instanceof WorkflowBlockedIntake` check (workflow-engine.ts) only
// agrees with what a caller sees when both sides resolve to the SAME module
// instance — this file's own `WorkflowEngine`/`MemoryDurableStepStore` must
// come from that identical resolution path, or an `instanceof` check born
// from one copy of the class can silently fail against an instance thrown
// from another (AU54/SCRUM-351's own class of bug, see
// `source-resolution.test.ts`).
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";

import { createInstagramAgentWorkflow } from "../../../agents/instagram-agent/src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence as instagramFakeRouterSequence,
  finalTurn as instagramFinalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore as makeInstagramPromptStore,
  setupTestEnvironment as setupInstagramEnv,
} from "../../../agents/instagram-agent/__tests__/test-helpers.js";

import { createBrandedShortsAgentWorkflow } from "../../../agents/branded-shorts-agent/src/workflow/create-branded-shorts-agent-workflow.js";
import {
  fakeRouterSequence as brandedShortsFakeRouterSequence,
  finalTurn as brandedShortsFinalTurn,
  goodGraphicsPlan,
  goodHighlights,
  makePromptStore as makeBrandedShortsPromptStore,
  setupTestEnvironment as setupBrandedShortsEnv,
} from "../../../agents/branded-shorts-agent/__tests__/test-helpers.js";

import { createIntelReportAgentWorkflow } from "../../../agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.js";
import {
  fakeRouterSequence as intelFakeRouterSequence,
  makePromptStore as makeIntelPromptStore,
  setupTestEnvironment as setupIntelEnv,
} from "../../../agents/intel-report-agent/__tests__/test-helpers.js";

import { createLandingBuilderAgentWorkflow } from "../../../agents/landing-builder-agent/src/workflow/create-landing-builder-agent-workflow.js";
import { smartFakeRouter as landingSmartFakeRouter, makePromptStore as makeLandingPromptStore, setupTestEnvironment as setupLandingEnv } from "../../../agents/landing-builder-agent/__tests__/test-helpers.js";

/**
 * SCRUM-242 (T-A10) — the ticket's own required test: "A fixture run with
 * every context doc absent, run against all four agents in ONE test,
 * asserting the two BLOCKs (each with a stated reason) and the two visible
 * degraded markers." (Batch 5 doc §5, T-A10's own line.)
 *
 * Every one of the four `setupTestEnvironment` calls below deliberately
 * leaves every context doc unprojected for its client — instagram-agent and
 * branded-shorts-agent's helpers never write one unless a test asks; intel-
 * report-agent's and landing-builder-agent's helpers now default to WRITING
 * one (SCRUM-242 made their absence a real BLOCK, and most of their OTHER
 * tests don't care about grounding — see those helpers' own doc comments),
 * so this test explicitly passes `withContextDocs: false` to get genuine,
 * total absence for those two.
 */
describe("SCRUM-242 (T-A10) — one fixture, all four grounded agents, every context doc absent", () => {
  it("BLOCKs intel-report-agent and landing-builder-agent (blocked_intake, each with a stated reason) and DEGRADEs instagram-agent and branded-shorts-agent (completed, with a visible marker on the persisted deliverable)", async () => {
    // ── intel-report-agent: BLOCK ──
    const intelEnv = await setupIntelEnv({ withContextDocs: false });
    try {
      const intelParams = { runId: "fixture_intel", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring" as const };
      const intelRouter = intelFakeRouterSequence([]); // never called — see the assertion below
      const intelWorkflowFn = createIntelReportAgentWorkflow({ tools: intelEnv.tools, promptStore: makeIntelPromptStore(), router: intelRouter, autoApprove: true });
      const intelResult = await new WorkflowEngine(new MemoryDurableStepStore()).run(intelWorkflowFn, intelParams);

      expect(intelResult.status).toBe("blocked_intake");
      if (intelResult.status !== "blocked_intake") throw new Error("unreachable");
      expect(intelResult.reason).toContain("intel-report-agent: missing required context doc(s) [target-audience, market-strategy]");
      expect(intelResult.reason).toContain("client-facing deliverable");
      expect(intelRouter.complete).not.toHaveBeenCalled();
    } finally {
      await intelEnv.cleanup();
    }

    // ── landing-builder-agent: BLOCK ──
    const landingEnv = await setupLandingEnv("forge", { withContextDocs: false });
    try {
      const landingParams = { runId: "fixture_landing", clientSlug: "forge", productId: "s6", runKind: "setup" as const };
      const landingRouter = landingSmartFakeRouter([]); // never called — see the assertion below
      const landingWorkflowFn = createLandingBuilderAgentWorkflow({ tools: landingEnv.tools, promptStore: makeLandingPromptStore(), router: landingRouter, autoApprove: true });
      const landingResult = await new WorkflowEngine(new MemoryDurableStepStore()).run(landingWorkflowFn, landingParams);

      expect(landingResult.status).toBe("blocked_intake");
      if (landingResult.status !== "blocked_intake") throw new Error("unreachable");
      expect(landingResult.reason).toContain("landing-builder-agent: missing required context doc(s) [product-information]");
      expect(landingResult.reason).toContain("published artefact");
    } finally {
      await landingEnv.cleanup();
    }

    // ── instagram-agent: DEGRADED + visible marker ──
    const instagramEnv = await setupInstagramEnv();
    try {
      const instagramParams = { runId: "fixture_instagram", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
      const instagramRouter = instagramFakeRouterSequence([
        instagramFinalTurn(goodResearchOutput()),
        instagramFinalTurn(goodCopyOutput()),
        instagramFinalTurn(goodImageVettingOutput()),
        instagramFinalTurn(goodVisualQaOutput()),
      ]);
      const instagramWorkflowFn = createInstagramAgentWorkflow({
        tools: { ...instagramEnv.tools, "publish.renderCarousel": fakeRenderCarousel(instagramEnv.tools["publish.renderCarousel"]!) },
        promptStore: makeInstagramPromptStore(),
        router: instagramRouter,
        repoRoot: instagramEnv.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      });
      const instagramDurableStore = new MemoryDurableStepStore();
      const instagramResult = await new WorkflowEngine(instagramDurableStore).run(instagramWorkflowFn, instagramParams);

      expect(instagramResult.status).toBe("completed");
      if (instagramResult.status !== "completed") throw new Error("unreachable");
      // Visible on the workflow's own typed return value...
      expect(instagramResult.output.contextGrounding).toEqual({
        contextGroundingStatus: "degraded",
        agentId: "instagram-agent",
        missingDocTypes: ["branding-guidelines"],
        reason: expect.stringContaining("instagram-agent: missing required context doc(s) [branding-guidelines]"),
      });
      // ...AND on the actual PERSISTED deliverable a reviewer looks at, not
      // merely an internal field nobody reads — the ticket's own bar.
      const instagramDeliverables = await instagramEnv.store.listJson<{ deliverable?: { contextGrounding?: unknown } }>("acme", [
        "ledger",
        "deliverables",
        instagramParams.runId,
        "_",
      ]);
      expect(instagramDeliverables).toHaveLength(1);
      expect(instagramDeliverables[0]?.data.deliverable?.contextGrounding).toEqual(
        expect.objectContaining({ contextGroundingStatus: "degraded", agentId: "instagram-agent" }),
      );
    } finally {
      await instagramEnv.cleanup();
    }

    // ── branded-shorts-agent: DEGRADED + visible marker ──
    const brandedShortsEnv = await setupBrandedShortsEnv();
    try {
      const brandedShortsParams = { runId: "fixture_branded_shorts", clientSlug: "acme", productId: "branded-shorts-agent", runKind: "setup" as const };
      const brandedShortsRouter = brandedShortsFakeRouterSequence([brandedShortsFinalTurn(goodHighlights()), brandedShortsFinalTurn(goodGraphicsPlan())]);
      const brandedShortsWorkflowFn = createBrandedShortsAgentWorkflow({
        tools: brandedShortsEnv.tools,
        promptStore: makeBrandedShortsPromptStore(),
        router: brandedShortsRouter,
        autoApprove: true,
      });
      const brandedShortsDurableStore = new MemoryDurableStepStore();
      const brandedShortsResult = await new WorkflowEngine(brandedShortsDurableStore).run(brandedShortsWorkflowFn, brandedShortsParams);

      expect(brandedShortsResult.status).toBe("completed");
      if (brandedShortsResult.status !== "completed") throw new Error("unreachable");
      expect(brandedShortsResult.output.contextGrounding).toEqual({
        contextGroundingStatus: "degraded",
        agentId: "branded-shorts-agent",
        missingDocTypes: ["branding-guidelines"],
        reason: expect.stringContaining("branded-shorts-agent: missing required context doc(s) [branding-guidelines]"),
      });
      const brandedShortsDeliverables = await brandedShortsEnv.store.listJson<{ deliverable?: { contextGrounding?: unknown } }>("acme", [
        "ledger",
        "deliverables",
        brandedShortsParams.runId,
        "_",
      ]);
      expect(brandedShortsDeliverables).toHaveLength(1);
      expect(brandedShortsDeliverables[0]?.data.deliverable?.contextGrounding).toEqual(
        expect.objectContaining({ contextGroundingStatus: "degraded", agentId: "branded-shorts-agent" }),
      );
    } finally {
      await brandedShortsEnv.cleanup();
    }
  }, 60000);
});

/**
 * "The policy table is one file. No agent has a bespoke inline branch."
 * (SCRUM-242's own acceptance criterion.) Asserted structurally, not by
 * convention, against the four workflow files' actual source text — a test
 * that would fail the moment someone adds a second `if (agentId === ...)`
 * decision anywhere, or a second table, rather than flipping a row in
 * `CONTEXT_DOC_POLICY`.
 */
describe("SCRUM-242 (T-A10) — structural: one policy table, one enforcement point, zero bespoke branches", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

  const WORKFLOW_FILES = [
    "agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts",
    "agents/landing-builder-agent/src/workflow/create-landing-builder-agent-workflow.ts",
    "agents/branded-shorts-agent/src/workflow/create-branded-shorts-agent-workflow.ts",
    "agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.ts",
  ];

  it("each of the four grounded agents' workflow files calls enforceContextDocPolicy exactly once, and does not reference the raw policy table directly", () => {
    for (const relPath of WORKFLOW_FILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const callCount = (text.match(/enforceContextDocPolicy\(/g) ?? []).length;
      expect(callCount, `${relPath} should call enforceContextDocPolicy exactly once`).toBe(1);
      // A workflow file IMPORTING or INDEXING the raw CONTEXT_DOC_POLICY table
      // would mean it is making its own BLOCK/DEGRADED decision instead of
      // asking the shared helper — exactly the per-agent branching this
      // ticket exists to remove. Checked as actual code usage (an import
      // binding, or `CONTEXT_DOC_POLICY[`/`CONTEXT_DOC_POLICY.`), not a bare
      // text search — every workflow file's own comments legitimately NAME
      // the table in prose to explain why a step exists.
      const importsRawTable = /import\s*\{[^}]*\bCONTEXT_DOC_POLICY\b[^}]*\}\s*from\s*["']@agent-engine\/workflow["']/.test(text);
      const indexesRawTable = /\bCONTEXT_DOC_POLICY\s*[[.]/.test(text);
      expect(importsRawTable || indexesRawTable, `${relPath} should not import or index the raw CONTEXT_DOC_POLICY table directly`).toBe(false);
    }
  });

  it("each of the four grounded agents' workflow files does not hand-construct the shared helper's own BLOCK/DEGRADED reason text — a duplicated inline copy of that string is exactly the bespoke branch this ticket forbids", () => {
    for (const relPath of WORKFLOW_FILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      expect(text.includes("missing required context doc(s)"), `${relPath} should not hand-construct the policy module's own reason text`).toBe(false);
    }
  });

  it("CONTEXT_DOC_POLICY is defined in exactly one source file in the whole repo", () => {
    const matches: string[] = [];
    const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__"]);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const text = fs.readFileSync(full, "utf8");
          if (/\bexport const CONTEXT_DOC_POLICY\b/.test(text)) {
            matches.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    for (const scopeDir of ["agents", "packages"]) {
      walk(path.join(REPO_ROOT, scopeDir));
    }
    expect(matches).toEqual(["packages/workflow/src/primitives/context-doc-policy.ts"]);
  });
});
