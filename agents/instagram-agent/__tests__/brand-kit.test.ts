import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

/** A 1x1 PNG's bytes, enough for a fake logo download. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fakeLogoFetch(behavior: "ok" | "fail"): typeof fetch {
  return (async () => {
    if (behavior === "fail") throw new Error("logo host unreachable");
    return {
      ok: true,
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
    };
  }) as unknown as typeof fetch;
}

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** The brand.json shape agent-middleware's seed script writes for a real client. */
const GEEKTIME_BRAND = {
  name: "Geektime",
  accent: "#A5E82B",
  colors: { primaryAccent: "#A5E82B", neutralDark: "#272A35", neutralLight: "#F4F2EC" },
  dominantColors: [{ hex: "#272A35", dominanceRank: 1 }],
  fonts: { heading: "Space Grotesk" },
  visualStyle: "Dark Mode",
  handle: "geektimecoil",
};

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodResearchOutput()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodVisualQaOutput()),
  ]);
}

describe("brand kit: the client's brand reaches the rendered templates", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof happyRouter>) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
      // Deliberately NO templateStore: this is the no-store path, which used
      // to point the renderer straight at the client's (read-only in prod)
      // templateDir with no way to inject anything.
    });
  }

  it("brands the no-store path: templates are copied into the run dir with the client's tokens spliced in", async () => {
    await env.store.writeJson("acme", ["client", "brand"], GEEKTIME_BRAND);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(happyRouter()), { runId: "branded_run", ...base });
    expect(result.status).toBe("completed");

    const steps = await durableStore.listSteps("branded_run");
    const resolved = steps.find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; files: string[]; brandTokenDrift?: { present: string[]; missing: string[] } }
      | undefined;
    // The renderer was pointed at the branded run dir, not the client's own.
    expect(resolved?.templateDir).toBe(".template-cache/branded_run");
    // `files` keeps its "archetype files present" meaning.
    expect(resolved?.files).toContain("stat-callout.html");

    const base_ = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "branded_run", "slide.html"), "utf8");
    expect(base_).toContain("--bg: #272A35;");
    expect(base_).toContain("--fg: #F4F2EC;");
    expect(base_).toContain("family=Space+Grotesk");

    // The drift note names every token as present — the trace can answer
    // "did the client's colors reach the pixels" without re-derivation.
    expect(resolved?.brandTokenDrift?.missing).toEqual([]);
    expect(resolved?.brandTokenDrift?.present.join(",")).toContain("--bg=#272A35");
  }, 30000);

  it("a client with no brand.json renders exactly as before brand kits existed", async () => {
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(happyRouter()), { runId: "brandless_run", ...base });
    expect(result.status).toBe("completed");

    const resolved = (await durableStore.listSteps("brandless_run")).find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; brandTokenDrift?: unknown }
      | undefined;
    // Untouched original path: the client's own templateDir, no run-dir copy.
    expect(resolved?.templateDir).toBe("fixtures/templates");
    expect(resolved?.brandTokenDrift).toBeUndefined();
  }, 30000);

  it("re-writes the branded run dir before a revision render after the instance's disk was wiped", async () => {
    // The 9qkTWlg7e9ZLiVIZUok4 bug class on the NEW path: 04c is
    // checkpointed, the branded dir is per-instance disk, and a resume on a
    // recycled instance must re-create it or the render is a tooling
    // failure.
    await env.store.writeJson("acme", ["client", "brand"], GEEKTIME_BRAND);

    const first = goodCopyOutput();
    const draftTurns = () => [finalTurn(first), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(), ...draftTurns()]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "branded_recycle";

    const r0 = await engine.run(workflowFn, { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    // Simulates the resume landing on a fresh Cloud Run instance.
    await fsp.rm(pathMod.join(env.repoRoot, ".template-cache", runId), { recursive: true, force: true });

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Tighten the hooks.",
      at: new Date().toISOString(),
    });
    const r1 = await engine.run(workflowFn, { runId, ...base });
    expect(r1.status).toBe("awaiting_gate");

    const rewritten = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runId, "slide.html"), "utf8");
    expect(rewritten).toContain("--bg: #272A35;");
  }, 60000);

  it("embeds the logo as a data URI and threads the handle onto every slide", async () => {
    await env.store.writeJson("acme", ["client", "brand"], { ...GEEKTIME_BRAND, logoUrl: "https://logos.example/geektime.png" });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router: happyRouter(),
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        fetchImpl: fakeLogoFetch("ok"),
      }),
      { runId: "branded_logo", ...base },
    );
    expect(result.status).toBe("completed");

    const composed = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "branded_logo", "slide.html"), "utf8");
    // The logo is EMBEDDED, never a slide.images path — a path whose file
    // vanished on a recycled instance is a run-holding content_fail, and
    // brand furniture must never be able to hold a run.
    expect(composed).toContain('class="brand-logo" src="data:image/png;base64,');
    expect(composed).toContain(".brand-logo {");

    const slidesData = (await durableStore.listSteps("branded_logo")).find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; fields: Record<string, string>; images: Record<string, string> }> }
      | undefined;
    for (const slide of slidesData?.slides ?? []) {
      expect(slide.fields["brandHandle"]).toBe("@geektimecoil");
      // No images.logo entry, on any slide, ever.
      expect(slide.images["logo"]).toBeUndefined();
    }
  }, 30000);

  it("a failed logo download degrades to no logo — never a hold, and the rest of the brand still applies", async () => {
    await env.store.writeJson("acme", ["client", "brand"], { ...GEEKTIME_BRAND, logoUrl: "https://logos.example/geektime.png" });

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router: happyRouter(),
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        fetchImpl: fakeLogoFetch("fail"),
      }),
      { runId: "branded_logo_down", ...base },
    );
    expect(result.status).toBe("completed");

    const composed = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "branded_logo_down", "slide.html"), "utf8");
    expect(composed).not.toContain("brand-logo");
    expect(composed).toContain("--bg: #272A35;");
  }, 30000);

  it("a standing seriesBadge from brandTokens lands on every slide's fields", async () => {
    await env.cleanup();
    env = await setupTestEnvironment({ brandTokens: goodBrandTokens({ seriesBadge: "PITCH SCHOOL | LESSON 15" }) });
    await env.store.writeJson("acme", ["client", "brand"], GEEKTIME_BRAND);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(happyRouter()), { runId: "badged_run", ...base });
    expect(result.status).toBe("completed");

    const slidesData = (await durableStore.listSteps("badged_run")).find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ fields: Record<string, string> }> }
      | undefined;
    for (const slide of slidesData?.slides ?? []) {
      expect(slide.fields["seriesBadge"]).toBe("PITCH SCHOOL | LESSON 15");
    }
    // And the template has a styled home for it.
    const composed = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "badged_run", "slide.html"), "utf8");
    expect(composed).toContain('class="brand-badge"');
    expect(composed).toContain(".brand-badge {");
  }, 30000);
});
