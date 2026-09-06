import { afterEach, describe, expect, it } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { RunKind } from "@agent-engine/core";
import type { PageBlueprint, PageParts } from "@agent-engine/tool-karos-landing";
import { createLandingBuilderAgentWorkflow } from "../src/workflow/create-landing-builder-agent-workflow.js";
import type { LandingBuilderWorkflowResult } from "../src/workflow/types.js";
import { landingFakeRouter, makePromptStore, passingRender, sampleBlueprint, sampleParts, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params: { runId: string; clientSlug: string; productId: string; runKind: RunKind } = { runId: "landing_run_1", clientSlug: "northwind", productId: "landing-builder-agent", runKind: "setup" };

async function runToCompletion(env: TestEnvironment, router: ReturnType<typeof landingFakeRouter>["router"], overrides: Partial<typeof params> & { input?: Record<string, unknown> } = {}) {
  const workflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const result = await engine.run(workflowFn, { ...params, ...overrides });
  return { result, durableStore };
}

describe("landing-builder-agent v2: fresh build, end to end", () => {
  let env: TestEnvironment;
  afterEach(() => env.cleanup());

  it("grounds the blueprint in the brand kit, the context docs and the captured current site, then builds, checks, renders, deploys a preview, and promotes it live on approval", async () => {
    env = await setupTestEnvironment();
    const fake = landingFakeRouter();
    const { result, durableStore } = await runToCompletion(env, fake.router);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(`unexpected ${result.status}: ${"reason" in result ? result.reason : ""}`);
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("ok");
    expect(out.gate).toBe("pass");
    expect(out.craftVerdict).toBe("pass");
    expect(out.fixed).toBe(false);
    expect(out.oldSite).toBe("fetch");
    expect(out.previewUrl).toMatch(/^https:\/\/karos-northwind--run-[0-9a-f]{10}\.web\.app$/);
    expect(out.liveUrl).toBe("https://karos-northwind.web.app");
    expect(out.gcsPrefix).toBe("gs://test-bucket/landing/northwind/landing_run_1/");
    expect(out.screenshots.map((s) => s.label)).toEqual(["mobile", "desktop"]);
    expect(out.deliverableId).toBeTruthy();

    // What the blueprint step actually saw: brand kit, product-information, the old site's copy and CTA, the brief.
    const blueprintPrompt = fake.prompts.find((p) => p.stepId === "landing-blueprint")!.prompt;
    expect(blueprintPrompt).toContain('"display":"Space Grotesk"'.replace('"display"', '"heading"'));
    expect(blueprintPrompt).toContain("Northwind deploys a system of always-on AI agents");
    expect(blueprintPrompt).toContain("The AI CMO that moves 1st.");
    expect(blueprintPrompt).toContain("Book a call");
    expect(blueprintPrompt).not.toContain("screenshots"); // links the model cannot open are stripped

    // The archived page is the assembled document, not a source tree.
    const html = env.artifactStore.objects.get("landing/northwind/landing_run_1/index.html")!.toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<html lang="en-US" dir="ltr">');
    expect(html).toContain("<title>Northwind: AI marketing agents that draft on your brand rules</title>");
    expect(env.artifactStore.objects.has("landing/northwind/landing_run_1/blueprint.json")).toBe(true);

    // Hosting: one version deployed for the preview, the SAME version released live.
    const releases = env.hostingCalls.filter((c) => /\/releases\?versionName=/.test(c.url)).map((c) => c.url);
    expect(releases).toHaveLength(2);
    expect(releases[1]).toContain("/channels/live/releases?versionName=sites%2Fkaros-northwind%2Fversions%2Fv1");
    expect(env.hostingCalls.filter((c) => /\/versions$/.test(c.url))).toHaveLength(1);

    // The published state is what a revision starts from.
    const state = await env.store.readJson<{ runId: string; liveUrl: string }>("northwind", ["landing", "state"]);
    expect(state?.runId).toBe("landing_run_1");
    expect(state?.liveUrl).toBe("https://karos-northwind.web.app");

    const steps = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(steps).toEqual(expect.arrayContaining(["00-intake", "02-capture-site", "02b-grounding-policy", "03-blueprint", "04-build", "05-assemble", "06-check", "07-render", "08-craft-verdict", "10-upload", "11-deploy-preview", "12-human-review", "13-deploy-live", "14-write-state", "15-persist-deliverable"]));
    expect(steps).not.toContain("09-fix");
  });

  it("runs exactly one fix pass when the floor fails, re-checks, and holds the page for a human when it still fails", async () => {
    env = await setupTestEnvironment();
    const broken: PageParts = sampleParts();
    broken.sections[1]!.html = broken.sections[1]!.html.replace("Twelve agents run in production today.", "Trusted by 400+ teams.");
    // The fix returns the same broken parts: the second gate must fail too, and there is no third attempt.
    const fake = landingFakeRouter({ parts: broken, fixedParts: broken });
    const { result, durableStore } = await runToCompletion(env, fake.router);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("needs_human");
    expect(out.gate).toBe("fail");
    expect(out.fixed).toBe(true);
    expect(out.craftVerdict).toBe("skipped"); // the judgment pass never runs on a page that failed the floor

    const fixPrompt = fake.prompts.find((p) => p.stepId === "landing-fix")!.prompt;
    expect(fixPrompt).toContain("400+");
    expect(fixPrompt).toContain("numbers-sourced");

    const steps = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(steps).toContain("09-fix");
    expect(steps).toContain("06-check-after-fix");
    expect(steps.filter((s) => s.startsWith("09-fix"))).toHaveLength(1);
    // Still delivered: a held page is a deliverable the reviewer decides on, not a lost run.
    expect(out.deliverableId).toBeTruthy();
    expect(out.previewUrl).toBeTruthy();
  });

  it("a failing craft verdict triggers the fix pass and a second verdict; a pass on re-check ships as ok", async () => {
    env = await setupTestEnvironment();
    const fake = landingFakeRouter({
      verdicts: [
        { verdict: "content_fail", evidence: [], reason: "how-it-works: the numbered sequence is three equal cards", toolVersion: "test" },
        { verdict: "pass", evidence: ["signature moment implemented"], toolVersion: "test" },
      ],
    });
    const { result, durableStore } = await runToCompletion(env, fake.router);
    if (result.status !== "completed") throw new Error("unreachable");
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("ok");
    expect(out.fixed).toBe(true);
    expect(out.craftVerdict).toBe("pass");
    const steps = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(steps).toEqual(expect.arrayContaining(["08-craft-verdict", "09-fix", "08-craft-verdict-after-fix"]));
    expect(fake.prompts.find((p) => p.stepId === "landing-fix")!.prompt).toContain("three equal cards");
  });

  it("a render failure (overflow, low contrast) is a floor failure with the same one-fix rule", async () => {
    let calls = 0;
    env = await setupTestEnvironment({
      renderReport: () => {
        calls++;
        if (calls === 1) {
          const bad = passingRender();
          bad.pass = false;
          bad.violations = ["@mobile: horizontal overflow", '@mobile: low text contrast: p "Low contrast" 3.10:1'];
          return bad;
        }
        return passingRender();
      },
    });
    const fake = landingFakeRouter();
    const { result } = await runToCompletion(env, fake.router);
    if (result.status !== "completed") throw new Error("unreachable");
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("ok");
    expect(out.fixed).toBe(true);
    expect(fake.prompts.find((p) => p.stepId === "landing-fix")!.prompt).toContain("horizontal overflow");
  });

  it("without Hosting configured the run still completes with the archived page, and says so", async () => {
    env = await setupTestEnvironment({ withHosting: false });
    const { result } = await runToCompletion(env, landingFakeRouter().router);
    if (result.status !== "completed") throw new Error("unreachable");
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("ok");
    expect(out.previewUrl).toBeUndefined();
    expect(out.liveUrl).toBeUndefined();
    expect(out.gcsPrefix).toBeTruthy();
    expect(out.assumptions.some((a) => /Firebase Hosting is not configured/.test(a))).toBe(true);
  });

  it("pauses at the landing_craft_review gate with the preview URL and screenshots in the payload when autoApprove is off", async () => {
    env = await setupTestEnvironment();
    const workflowFn = createLandingBuilderAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: landingFakeRouter().router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const paused = await engine.run(workflowFn, params);
    expect(paused.status).toBe("awaiting_gate");
    if (paused.status !== "awaiting_gate") throw new Error("unreachable");
    const gate = await durableStore.getGate(paused.pendingGateId);
    expect(gate?.kind).toBe("landing_craft_review");
    const payload = gate?.payload as Record<string, unknown>;
    expect(payload["previewUrl"]).toMatch(/\.web\.app$/);
    expect(payload["images"]).toEqual([
      { n: 1, url: "https://signed.example/render-mobile.png", label: "mobile" },
      { n: 2, url: "https://signed.example/render-desktop.png", label: "desktop" },
    ]);
    expect(payload["status"]).toBe("ok");
    expect(payload["title"]).toBe("Northwind: AI marketing agents that draft on your brand rules");
    // Nothing went live before the person said yes.
    expect(env.hostingCalls.some((c) => /\/channels\/live\/releases/.test(c.url))).toBe(false);
  });
});

describe("landing-builder-agent v2: grounding and revision", () => {
  let env: TestEnvironment;
  afterEach(() => env.cleanup());

  it("blocks (blocked_intake) only when there is neither a product-information document nor a current site to ground in", async () => {
    env = await setupTestEnvironment({ withProductInformation: false, withWebsite: false });
    const fake = landingFakeRouter();
    const { result, durableStore } = await runToCompletion(env, fake.router);
    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/product-information/);
    expect(fake.prompts).toHaveLength(0);
    expect((await durableStore.listSteps(params.runId)).map((s) => s.stepId)).toContain("02b-grounding-policy");
  });

  it("proceeds without a product-information document when the current site was captured, and records the degraded grounding", async () => {
    env = await setupTestEnvironment({ withProductInformation: false });
    const { result } = await runToCompletion(env, landingFakeRouter().router);
    if (result.status !== "completed") throw new Error(`unexpected ${result.status}`);
    const out = result.output as LandingBuilderWorkflowResult;
    expect(out.status).toBe("ok");
    expect(out.assumptions.some((a) => /no product-information document/.test(a))).toBe(true);
  });

  it("a recurring run revises the published build: the prior blueprint and parts reach the model with the feedback, and a run with no prior state builds fresh", async () => {
    const prior: PageBlueprint = sampleBlueprint({ pov: "PRIOR POV MARKER" });
    env = await setupTestEnvironment({ priorState: { blueprint: prior, parts: sampleParts() } });
    const fake = landingFakeRouter();
    const { result } = await runToCompletion(env, fake.router, { runKind: "recurring", input: { customPrompt: "Make the hero headline shorter" } });
    if (result.status !== "completed") throw new Error(`unexpected ${result.status}`);
    expect((result.output as LandingBuilderWorkflowResult).revision).toBe(true);
    const blueprintPrompt = fake.prompts.find((p) => p.stepId === "landing-blueprint")!.prompt;
    expect(blueprintPrompt).toContain("PRIOR POV MARKER");
    expect(blueprintPrompt).toContain("Make the hero headline shorter");
    expect(fake.prompts.find((p) => p.stepId === "landing-build")!.prompt).toContain("priorParts");

    await env.cleanup();
    env = await setupTestEnvironment();
    const fresh = landingFakeRouter();
    const { result: freshResult } = await runToCompletion(env, fresh.router, { runKind: "recurring" });
    if (freshResult.status !== "completed") throw new Error("unreachable");
    const out = freshResult.output as LandingBuilderWorkflowResult;
    expect(out.revision).toBe(false);
    expect(out.assumptions.some((a) => /no published build state/.test(a))).toBe(true);
  });
});
