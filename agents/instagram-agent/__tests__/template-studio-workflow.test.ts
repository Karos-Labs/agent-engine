import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEFAULT_QUALITY_STUDIO } from "@agent-engine/tool-karos-templates";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { StudioTemplateDraftSchema, studioTemplateId, type StudioTemplateDraft } from "../src/workflow/template-studio.js";
import { readSetupBudgetHistory } from "../src/workflow/run-budget.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * Phase 2, item N — the Template Studio inside a real workflow run: the
 * lifecycle gate at `00c`, one designer call per template, the validation
 * battery, one repair, and the set stored DISABLED for a human to approve.
 *
 * ## Why this file arms itself
 *
 * `create-instagram-agent-workflow.ts` is owned by no work package — one
 * integrator wires it from each package's integration notes (step 1 of the
 * Phase 2 order). Until `00c-check-template-studio` exists in that file there
 * is nothing here to exercise, so the suite reads the workflow's own source
 * for the step id and skips with a printed reason rather than failing over a
 * sibling's ordering. The moment the step lands, these tests run with no edit
 * to this file — the probe is the wiring, not a flag somebody has to
 * remember to flip.
 */
const WORKFLOW_SOURCE = readFileSync(path.resolve(__dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
const STUDIO_WIRED = WORKFLOW_SOURCE.includes("00c-check-template-studio");
if (!STUDIO_WIRED) {
  console.log("[template-studio-workflow] skipped: 00c-check-template-studio is not wired into create-instagram-agent-workflow.ts yet (Phase 2 wiring order, step 1)");
}

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

// ─────────────────────────────────────────────────────────────────────────
// Fixture designer output — four templates that pass all eight gates
// ─────────────────────────────────────────────────────────────────────────

function draft(over: Partial<StudioTemplateDraft> & { archetypeId: string; slots: string[]; bodyHtml: string }): StudioTemplateDraft {
  return StudioTemplateDraftSchema.parse({
    name: `Acme ${over.archetypeId}`,
    role: over.archetypeId === "cover" ? "cover" : over.archetypeId === "closer" ? "closer" : "interior",
    layoutType: over.archetypeId === "cover" ? "photo" : "typographic",
    ground: over.archetypeId === "cover" ? "image" : "colour-block",
    css: `.plate { padding-inline: 64px; } .lede { font-family: var(--f-body); font-size: calc(38px * var(--ts, 1)); color: var(--fg); }`,
    derivedFrom: {
      formatLabel: "stat-led",
      accounts: ["instagram/@marketingexamples"],
      postCount: 6,
      signalsAvailable: ["likes"],
      signalsAbsent: ["views absent for 1 of 1 accounts"],
      exampleUrls: [],
      why: "the strongest posts on the reference account open on one figure and close on a question",
    },
    ...over,
  });
}

const COVER_DRAFT = draft({
  archetypeId: "cover",
  slots: ["eyebrow", "title", "hero", "device"],
  bodyHtml: `<div class="plate"><div class="ground">{{image:hero}}</div><p class="eyebrow">{{eyebrow}}</p><h1 class="lede">{{title}}</h1>{{html:device}}</div>`,
  sample: { eyebrow: "playbook", title: "A cover title that wraps once", hero: "fixtures/hero.png", device: "a figure device" },
});

const STAT_DRAFT = draft({
  archetypeId: "stat_callout",
  slots: ["figure", "subLabel", "body", "sourceLine"],
  bodyHtml: `<div class="plate"><p class="figure">{{figure}}</p><p class="sub">{{subLabel}}</p><p class="lede">{{body}}</p><p class="src">{{sourceLine}}</p></div>`,
  sample: { figure: "63%", subLabel: "onboard by hand", body: "Body copy of a typical length.", sourceLine: "internal data, 2026" },
});

const LIST_DRAFT = draft({
  archetypeId: "list_takeaway",
  slots: ["headline", "itemRows"],
  bodyHtml: `<div class="plate"><h2 class="lede">{{headline}}</h2>{{html:itemRows}}</div>`,
  sample: { headline: "Three things that changed", itemRows: "three rows" },
});

const CLOSER_DRAFT = draft({
  archetypeId: "closer",
  slots: ["takeaway", "cta", "question"],
  bodyHtml: `<div class="plate"><p class="lede">{{takeaway}}</p><p class="cta">{{cta}}</p><p class="q">{{question}}</p></div>`,
  sample: { takeaway: "One line to remember", cta: "Save this", question: "Which would you change?" },
});

const ALL_DRAFTS = [COVER_DRAFT, STAT_DRAFT, LIST_DRAFT, CLOSER_DRAFT];

function designBriefOutput(archetypeIds: readonly string[] = ALL_DRAFTS.map((d) => d.archetypeId)) {
  return {
    thesis: "A quiet photographic cover, two dense interior plates and a calm close — the shape the reference accounts' best posts share.",
    templates: archetypeIds.map((archetypeId) => ({
      archetypeId,
      role: archetypeId === "cover" ? "cover" : archetypeId === "closer" ? "closer" : "interior",
      formatLabel: "stat-led",
      ground: archetypeId === "cover" ? "image" : "colour-block",
      why: "the strongest posts on the reference account open on one figure",
    })),
    setRules: ["one accent moment per slide", "the display face carries the figure and nothing else"],
    signalsAvailable: ["likes"],
    signalsAbsent: ["views absent for every reference account"],
    gaps: [],
  };
}

function setReviewOutput(archetypeIds: readonly string[] = ALL_DRAFTS.map((d) => d.archetypeId)) {
  return {
    perTemplate: archetypeIds.map((archetypeId) => ({ archetypeId, verdict: "keep" as const, reason: "reads as part of the same system" })),
    setNote: "the four read as one system: same type roles, one accent moment each",
  };
}

/** A wholly different post, so a second run for the same client never spends an attempt on `07d`'s shipped-output dedup window. */
function secondPost() {
  const good = goodCopyOutput();
  return {
    ...good,
    caption: "A separate look at how the design department rebuilt its weekly critique, and what changed in the calendar afterwards.",
    slides: good.slides.map((slide, i) => ({
      ...slide,
      headline: `A different angle ${i + 1}`,
      body: `An unrelated sentence ${i + 1} about the critique rebuild, which nobody has written about in this feed before now.`,
    })),
  };
}

/** The run's own model turns, after the studio's. */
const runTurns = {
  scout: goodTrendScoutOutput(),
  research: goodResearchOutput(),
  angle: goodAngleProposal(),
  copy: goodCopyOutput(),
  vet: goodImageVettingOutput(),
  relevance: goodRelevanceVerdict(),
  qa: goodVisualQaOutput(),
};

describe.skipIf(!STUDIO_WIRED)("the Template Studio in a real run", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment({ seedStudio: false, seedTopics: Array.from({ length: 10 }, (_, i) => `topic ${i + 1} for the studio tests`) });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflow(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
      templateStore: env.templateStore,
    });
  }

  it("generates for a client with no rows and stores the set DISABLED at the studio score", async () => {
    const router = fakeRouterSequence(
      standardTurns({ designBrief: designBriefOutput(), templateDesign: ALL_DRAFTS, setReview: setReviewOutput(), ...runTurns }),
    );
    const durable = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durable).run(workflow(router), { runId: "studio_generate", ...base });

    expect(result.status).toBe("completed");
    const stepIds = (await durable.listSteps("studio_generate")).map((s) => s.stepId);
    expect(stepIds).toContain("00c-check-template-studio");
    expect(stepIds).toContain("00c1-plan-setup-budget");
    expect(stepIds).toContain("00c2-gather-format-evidence");
    expect(stepIds).toContain("00c3-write-design-brief");
    expect(stepIds.filter((id) => id.startsWith("00c4-design-template-"))).toHaveLength(4);
    expect(stepIds.filter((id) => id.startsWith("00c5-validate-template-"))).toHaveLength(4);
    expect(stepIds).toContain("00c8-store-template-set");

    // Every survivor is stored, disabled, at 65 — so THIS run still renders
    // on the bundled archetypes and a human sees the set first.
    const rows = await env.templateStore.list({ clientSlug: "acme", includeDisabled: true });
    expect(rows.map((r) => r.archetypeId).sort()).toEqual(["closer", "cover", "list_takeaway", "stat_callout"]);
    for (const row of rows) {
      expect(row.enabled).toBe(false);
      expect(row.qualityScore).toBe(DEFAULT_QUALITY_STUDIO);
      expect(row.source).toBe("ai_generated");
      expect(row.clientSlug).toBe("acme");
      expect(row.derivedFrom?.formatLabel).toBe("stat-led");
      expect(row.derivedFrom?.signalsAbsent.join(" ")).toContain("views absent");
      expect(row.htmlTemplate).toContain("__CAROUSEL_READY__");
    }
    expect((await env.templateStore.list({ clientSlug: "acme" })).length).toBe(0);
  }, 120_000);

  it("reuses a fresh approved set and consumes NO studio turn", async () => {
    // The default seed: a fresh, approved four-template set. Exactly the
    // property the ~30 existing fixtures rely on.
    const reuseEnv = await setupTestEnvironment({ seedTopics: Array.from({ length: 10 }, (_, i) => `reuse topic ${i + 1}`) });
    try {
      const router = fakeRouterSequence(standardTurns({ ...runTurns }));
      const durable = new MemoryDurableStepStore();
      const result = await new WorkflowEngine(durable).run(
        createInstagramAgentWorkflow({
          tools: { ...reuseEnv.tools, "publish.renderCarousel": fakeRenderCarousel(reuseEnv.tools["publish.renderCarousel"]!) },
          promptStore: makePromptStore(),
          router,
          repoRoot: reuseEnv.repoRoot,
          imageCandidatePool: goodImageCandidatePool(),
          autoApprove: true,
          templateStore: reuseEnv.templateStore,
        }),
        { runId: "studio_reuse", ...base },
      );

      expect(result.status).toBe("completed");
      const stepIds = (await durable.listSteps("studio_reuse")).map((s) => s.stepId);
      // The free store read happens; nothing paid does.
      expect(stepIds).toContain("00c-check-template-studio");
      expect(stepIds.filter((id) => id.startsWith("00c3") || id.startsWith("00c4") || id.startsWith("00c6") || id.startsWith("00c7"))).toEqual([]);
      const check = (await durable.listSteps("studio_reuse")).find((s) => s.stepId === "00c-check-template-studio")?.output as { action?: string } | undefined;
      expect(check?.action).toBe("reuse");
    } finally {
      await reuseEnv.cleanup();
    }
  }, 120_000);

  /**
   * THE MISSING CASE: a setup that stored NOTHING.
   *
   * Both zero-store paths are reachable and both are warns that fall through
   * (a design-brief turn that fails its schema; every candidate dropped by the
   * eight gates), and the store rows are the studio's only durable record. So
   * "no rows" used to read as "never tried", and the next weekly run
   * re-resolved `generate` and re-paid the whole per-client setup bill on its
   * own meter, unbounded, against an item documented twice as running at most
   * once per client per 120 days. `00c` now reads the setup history that
   * `09b` already writes.
   */
  it("a setup that stored NOTHING is remembered, so the next run reuses the bundled set instead of re-paying the bill", async () => {
    // Run 1: the design-brief turn comes back as something that is not a
    // design brief, so nothing is generated, nothing is stored, and the run
    // still delivers on the bundled archetypes.
    const first = fakeRouterSequence(standardTurns({ designBrief: { nope: true }, ...runTurns }));
    const durable1 = new MemoryDurableStepStore();
    const firstResult = await new WorkflowEngine(durable1).run(workflow(first), { runId: "studio_stored_nothing_1", ...base });
    expect(firstResult.status).toBe("completed");
    const firstIds = (await durable1.listSteps("studio_stored_nothing_1")).map((s) => s.stepId);
    expect(firstIds).toContain("00c3-write-design-brief");
    expect(firstIds.filter((id) => id.startsWith("00c8"))).toEqual([]);
    expect(await env.templateStore.list({ clientSlug: "acme", includeDisabled: true })).toHaveLength(0);

    // The durable trace of the attempt: `templatesStored: 0` in the beliefs
    // document under the setup-budget key.
    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const setups = readSetupBudgetHistory(beliefs).setups;
    expect(setups).toHaveLength(1);
    expect(setups[0]).toMatchObject({ runId: "studio_stored_nothing_1", templatesStored: 0 });

    // Run 2, same client, still no rows: `00c` resolves REUSE off that trace
    // and the router is queued with NO studio turns at all, so a `generate`
    // here would exhaust it.
    const second = fakeRouterSequence(standardTurns({ ...runTurns, copy: secondPost() }));
    const durable2 = new MemoryDurableStepStore();
    const secondResult = await new WorkflowEngine(durable2).run(workflow(second), { runId: "studio_stored_nothing_2", ...base });
    expect(secondResult.status, JSON.stringify(secondResult)).toBe("completed");
    const steps2 = await durable2.listSteps("studio_stored_nothing_2");
    const check = steps2.find((s) => s.stepId === "00c-check-template-studio")?.output as { action?: string; reason?: string } | undefined;
    expect(check?.action).toBe("reuse");
    expect(check?.reason).toContain("stored no templates");
    expect(check?.reason).toContain("refreshTemplates");
    expect(steps2.map((s) => s.stepId).filter((id) => /^00c[1-8]/.test(id))).toEqual([]);
  }, 180_000);

  /**
   * THE TTL REFRESH HAD TO BE ABLE TO AUTHOR SOMETHING.
   *
   * `00c` resolves `generate` when every row is past the 120-day TTL, but the
   * duplicate guard used to be fed `archetypeIds` — which INCLUDES those stale
   * rows. Every proposal was then refused as "this client already has a studio
   * template for X", the setup authored nothing, stored nothing, left the same
   * stale rows behind, and the next weekly run took the identical branch and
   * re-paid the setup bill. Forever: the zero-store cooldown is gated on
   * `rows.length === 0`, so a client with stale rows could never reach it.
   */
  it("regenerates a fully-stale set over its own rows instead of rejecting every archetype as a duplicate", async () => {
    const staleEnv = await setupTestEnvironment({
      // The same four archetypes the designer fixture authors, aged past the TTL.
      seedStudio: { archetypeIds: ["stat_callout", "list_takeaway"], ageDays: 200 },
      seedTopics: Array.from({ length: 10 }, (_, i) => `stale topic ${i + 1}`),
    });
    try {
      const router = fakeRouterSequence(
        standardTurns({ designBrief: designBriefOutput(), templateDesign: ALL_DRAFTS, setReview: setReviewOutput(), ...runTurns }),
      );
      const durable = new MemoryDurableStepStore();
      const result = await new WorkflowEngine(durable).run(
        createInstagramAgentWorkflow({
          tools: { ...staleEnv.tools, "publish.renderCarousel": fakeRenderCarousel(staleEnv.tools["publish.renderCarousel"]!) },
          promptStore: makePromptStore(),
          router,
          repoRoot: staleEnv.repoRoot,
          imageCandidatePool: goodImageCandidatePool(),
          autoApprove: true,
          templateStore: staleEnv.templateStore,
        }),
        { runId: "studio_stale_refresh", ...base },
      );

      expect(result.status, JSON.stringify(result)).toBe("completed");
      const steps = await durable.listSteps("studio_stale_refresh");
      const check = steps.find((s) => s.stepId === "00c-check-template-studio")?.output as
        | { action?: string; archetypeIds?: string[]; staleArchetypeIds?: string[]; freshArchetypeIds?: string[] }
        | undefined;
      expect(check?.action).toBe("generate");
      expect(check?.staleArchetypeIds).toEqual(["list_takeaway", "stat_callout"]);
      // Nothing is fresh, so nothing is off limits.
      expect(check?.freshArchetypeIds).toEqual([]);

      // All four proposals are authored — including the two the stale rows hold.
      const stepIds = steps.map((s) => s.stepId);
      expect(stepIds.filter((id) => id.startsWith("00c4-design-template-"))).toHaveLength(4);
      expect(stepIds).toContain("00c8-store-template-set");

      const rows = await staleEnv.templateStore.list({ clientSlug: "acme", includeDisabled: true });
      expect(rows.map((r) => r.archetypeId).sort()).toEqual(["closer", "cover", "list_takeaway", "stat_callout"]);
      // The replaced rows are UPSERTS on the deterministic studio id, not duplicates.
      expect(rows.filter((r) => r.archetypeId === "stat_callout")).toHaveLength(1);
      const refreshed = (await staleEnv.templateStore.get(studioTemplateId("acme", "stat_callout")))!;
      expect(refreshed.updatedAt).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
    } finally {
      await staleEnv.cleanup();
    }
  }, 180_000);

  it("refreshTemplates re-authors an APPROVED, fresh set rather than refusing every archetype it already has", async () => {
    const refreshEnv = await setupTestEnvironment({
      seedStudio: { archetypeIds: ["stat_callout", "list_takeaway"], enabled: true },
      seedTopics: Array.from({ length: 10 }, (_, i) => `refresh topic ${i + 1}`),
    });
    try {
      const router = fakeRouterSequence(
        standardTurns({ designBrief: designBriefOutput(), templateDesign: ALL_DRAFTS, setReview: setReviewOutput(), ...runTurns }),
      );
      const durable = new MemoryDurableStepStore();
      const result = await new WorkflowEngine(durable).run(
        createInstagramAgentWorkflow({
          tools: { ...refreshEnv.tools, "publish.renderCarousel": fakeRenderCarousel(refreshEnv.tools["publish.renderCarousel"]!) },
          promptStore: makePromptStore(),
          router,
          repoRoot: refreshEnv.repoRoot,
          imageCandidatePool: goodImageCandidatePool(),
          autoApprove: true,
          templateStore: refreshEnv.templateStore,
        }),
        { runId: "studio_refresh_flag", ...base, input: { refreshTemplates: true } },
      );

      expect(result.status, JSON.stringify(result)).toBe("completed");
      const steps = await durable.listSteps("studio_refresh_flag");
      const check = steps.find((s) => s.stepId === "00c-check-template-studio")?.output as
        | { action?: string; reason?: string; freshArchetypeIds?: string[] }
        | undefined;
      expect(check?.action).toBe("generate");
      expect(check?.reason).toContain("refreshTemplates");
      expect(check?.freshArchetypeIds).toEqual([]);
      expect(steps.map((s) => s.stepId).filter((id) => id.startsWith("00c4-design-template-"))).toHaveLength(4);
      const rows = await refreshEnv.templateStore.list({ clientSlug: "acme", includeDisabled: true });
      expect(rows.map((r) => r.archetypeId).sort()).toEqual(["closer", "cover", "list_takeaway", "stat_callout"]);
    } finally {
      await refreshEnv.cleanup();
    }
  }, 180_000);

  it("drops a template whose designer turn fails its schema, and the run still delivers on the bundled set", async () => {
    const router = fakeRouterSequence(
      standardTurns({
        designBrief: designBriefOutput(),
        // The second call comes back as something that is not a template at all.
        templateDesign: [COVER_DRAFT, { nope: true }, LIST_DRAFT, CLOSER_DRAFT],
        setReview: setReviewOutput(["cover", "list_takeaway", "closer"]),
        ...runTurns,
      }),
    );
    const durable = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durable).run(workflow(router), { runId: "studio_schema_fail", ...base });

    // A malformed setup turn is a warn, never a hold: the whole block falls
    // through and the carousel renders on the bundled archetypes.
    expect(result.status).toBe("completed");
    const rows = await env.templateStore.list({ clientSlug: "acme", includeDisabled: true });
    expect(rows.map((r) => r.archetypeId).sort()).toEqual(["closer", "cover", "list_takeaway"]);
    expect(rows.map((r) => r.archetypeId)).not.toContain("stat_callout");
  }, 120_000);

  it("spends exactly ONE repair turn on a template that fails a gate, and stores the repaired one", async () => {
    // `stat_callout` declares a slot its markup never reads — gate 2. The
    // repair turn is handed the failing gate and its numbers, and returns a
    // template that passes.
    const broken = draft({
      archetypeId: "stat_callout",
      slots: ["figure", "subLabel", "body", "sourceLine", "attribution"],
      bodyHtml: STAT_DRAFT.bodyHtml,
      sample: { ...STAT_DRAFT.sample, attribution: "a name" },
    });
    const router = fakeRouterSequence(
      standardTurns({
        designBrief: designBriefOutput(),
        templateDesign: [COVER_DRAFT, broken, LIST_DRAFT, CLOSER_DRAFT],
        setReview: setReviewOutput(),
        templateRepair: [STAT_DRAFT],
        ...runTurns,
      }),
    );
    const durable = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durable).run(workflow(router), { runId: "studio_repair", ...base });

    expect(result.status).toBe("completed");
    const stepIds = (await durable.listSteps("studio_repair")).map((s) => s.stepId);
    expect(stepIds.filter((id) => id.startsWith("00c7-repair-template-"))).toHaveLength(1);
    const rows = await env.templateStore.list({ clientSlug: "acme", includeDisabled: true });
    expect(rows.map((r) => r.archetypeId).sort()).toEqual(["closer", "cover", "list_takeaway", "stat_callout"]);
    // The repaired markup is what was stored, not the one that failed.
    expect((await env.templateStore.get(studioTemplateId("acme", "stat_callout")))!.supportedFields).not.toContain("attribution");
  }, 120_000);

  it("runs off the brief and the site when the scraper is not configured, names every absent signal, and holds nothing", async () => {
    const offline = await setupTestEnvironment({
      seedStudio: false,
      scraper: null,
      seedTopics: Array.from({ length: 10 }, (_, i) => `offline topic ${i + 1}`),
    });
    try {
      const router = fakeRouterSequence(
        standardTurns({ designBrief: designBriefOutput(), templateDesign: ALL_DRAFTS, setReview: setReviewOutput(), ...runTurns }),
      );
      const durable = new MemoryDurableStepStore();
      const result = await new WorkflowEngine(durable).run(
        createInstagramAgentWorkflow({
          tools: { ...offline.tools, "publish.renderCarousel": fakeRenderCarousel(offline.tools["publish.renderCarousel"]!) },
          promptStore: makePromptStore(),
          router,
          repoRoot: offline.repoRoot,
          imageCandidatePool: goodImageCandidatePool(),
          autoApprove: true,
          templateStore: offline.templateStore,
        }),
        { runId: "studio_no_scraper", ...base },
      );

      expect(result.status).not.toBe("held");
      const evidence = (await durable.listSteps("studio_no_scraper")).find((s) => s.stepId === "00c2-gather-format-evidence")?.output;
      // No posts at all is stated, not papered over: the design brief then
      // works from the brand kit, the client brief and the site.
      expect(JSON.stringify(evidence ?? {})).toContain("no readable reference posts");
      expect((await offline.templateStore.list({ clientSlug: "acme", includeDisabled: true })).length).toBeGreaterThan(0);
    } finally {
      await offline.cleanup();
    }
  }, 120_000);

  it("approving a studio template at the gate flips `enabled`, and the NEXT run materializes it", async () => {
    const router = fakeRouterSequence(
      standardTurns({ designBrief: designBriefOutput(), templateDesign: ALL_DRAFTS, setReview: setReviewOutput(), ...runTurns }),
    );
    const durable = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durable);
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      templateStore: env.templateStore,
    });
    const runId = "studio_approve";
    const templateId = studioTemplateId("acme", "stat_callout");

    expect((await engine.run(workflowFn, { runId, ...base })).status).toBe("awaiting_gate");
    expect((await env.templateStore.get(templateId))!.enabled).toBe(false);

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      templateFeedback: [{ slide: 2, templateId, verdict: "approved", note: "the figure plate is exactly right", promote: true }],
    });
    expect((await engine.run(workflowFn, { runId, ...base })).status).toBe("completed");

    const approved = (await env.templateStore.get(templateId))!;
    expect(approved.enabled).toBe(true);
    // The flag and the reason live on the same row: the generation note, then
    // the approval.
    expect(approved.feedback.at(-1)).toMatchObject({ actor: "jane@karoslabs.com", verdict: "approved" });
    // And now it is visible to `resolveBest`, which is what "the next run
    // materializes it" means.
    expect((await env.templateStore.list({ clientSlug: "acme" })).map((r) => r.id)).toContain(templateId);
  }, 180_000);
});
