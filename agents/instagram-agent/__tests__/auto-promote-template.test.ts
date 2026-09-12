import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MemoryTemplateStore } from "@agent-engine/tool-karos-templates";
import { createInstagramAgentWorkflow, customArchetypeTemplateId } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  AUTO_PROMOTE_ACTOR,
  AUTO_PROMOTE_QUALITY_SCORE,
  CUSTOM_ARCHETYPE_BELIEF_KEY,
  readCustomArchetypeHistory,
} from "../src/workflow/custom-archetype-memory.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
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
  pendingStudioRow,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { standardTurns } from "./turns.js";

/**
 * Item O's flywheel, end to end: a run-authored layout that shipped through
 * the human gate twice with no edit is promoted into the client's own template
 * pool, so the third run can pick it the ordinary way.
 *
 * ## Wiring dependency
 *
 * Green once the integrator lands step 6 of the Phase 2 wiring order (WP-C5
 * integration note (f)): the conditional `09f-auto-promote-templates` after
 * the review cycle and before `09b`, calling `cleanShipsFor` ->
 * `recordCleanShip` -> `buildAutoPromotionRequest` -> the EXISTING
 * `promoteTemplate` with that request spread in, and `store.get(templateId)`
 * first so a resumed run cannot re-promote. `promoteTemplate`'s `qualityScore`
 * override arrives with item N (`karos-templates/src/promote.ts`), so the 55
 * asserted below also depends on that package being rebuilt.
 *
 * The counting is `custom-archetype-memory.test.ts`'s job and is proved pure
 * there. What is proved HERE is that the run's own facts (delivered, approved,
 * which slides the reviewer edited, which template verdicts came back) reach
 * that counter correctly, which is the half a pure test cannot see.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const ARCHETYPE_ID = "custom_pull_rail";
// `{{kicker}}`, not `{{headline}}`: `contentFor`'s `custom` case supplies the
// standing furniture plus the model's own `fields`, and never `headline` — so
// `assertSafeMarkup` (slots + `kicker` + `dir`) refuses a custom archetype
// that reads it, and it would render as a literal `{{headline}}` if it did not.
/**
 * The authored design, and it reads ONLY standard field names on purpose.
 *
 * A promotion has to land on one of the routable archetype ids, because
 * `templateForLayout` maps the fixed layout enum and its `custom` entry
 * resolves to markup validated that attempt — a row stored under a `custom_*`
 * id can never be picked again. `routablePromotionTargetFor` therefore only
 * offers a design whose `{{name}}`s a routable archetype's `contentFor` case
 * can actually supply, and `{{body}}`/`{{headline}}` make this one a
 * `headline_focus`. The invented-slot case is its own test below.
 */
const BODY_HTML = `<div class="rail"><p class="note">{{body}}</p><h1>{{headline}}</h1></div>`;
/** The same design with a slot name nothing supplies — recorded, never promoted. */
const UNROUTABLE_BODY_HTML = `<div class="rail"><p class="note">{{note}}</p><h1>{{headline}}</h1></div>`;

/** Every `{{key}}` a fixture's markup reads, in order — `assertSafeMarkup` requires each to be declared. */
function slotsOf(bodyHtml: string): string[] {
  return [...new Set([...bodyHtml.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/gu)].map((m) => m[1]!))];
}
const CSS = `.rail .note { color: var(--accent); font-family: var(--f-mono); } .rail h1 { font-family: var(--f-display); color: var(--fg); }`;

/**
 * Which slide is the carousel's `headline_focus` turn, per consecutive run.
 *
 * Item P is live: `07k-skeleton-variety` refuses a carousel whose layout
 * sequence repeats the previous post's, and it takes at least TWO differing
 * positions of six to clear `MIN_SKELETON_DISTANCE`. From run 2 on, every run
 * of this fixture renders all-typographic (run 1's images enter
 * `ledger.listUsedImages`, so the later runs' slides degrade), which makes
 * two consecutive runs byte-identical skeletons unless something moves.
 *
 * Moving the statement slide moves TWO positions at once — the slide that
 * gains it and the slide that loses it — so one step of this rotation is
 * exactly the smallest change item P asks a fixed weekly lane to make.
 *
 * It used to be the DEVICE that rotated, and that is worth recording because
 * it stopped working for a good reason: a device only enters the signature
 * when it actually painted, and `07k` now reads the rendered
 * `fields.deviceKind` rather than the copy's request. Only three archetypes
 * declare a device slot, `photo` is not one of them, so a rotation of devices
 * over photo slides changed nothing a reader could see — which is the whole
 * point of reading the render. The device rides along on the statement slide
 * here, where `headline-focus.html` genuinely renders it.
 */
const HEADLINE_FOCUS_SLOTS: readonly number[] = [2, 3, 4];

/** `goodCopyOutput()` with slide 2 authored as a custom layout, and fresh prose per run so `07d`'s dedup window never intervenes. */
function copyWithCustomArchetype(seed: string, overrides: { bodyHtml?: string; shape?: number } = {}): InstagramCopyOutput {
  const good = goodCopyOutput();
  const statementSlide = HEADLINE_FOCUS_SLOTS[(overrides.shape ?? 0) % HEADLINE_FOCUS_SLOTS.length]!;
  return {
    ...good,
    // Every run's prose is wholly its own: run 1's delivery enters the
    // shipped-output dedup window, and `07d` redrafts a second run that
    // re-ships recognisable copy. Only `sourceRef` is shared, which is what
    // `checkSlidesData` requires to match a fact's claim verbatim.
    caption: `Where the ${seed} team put its attention this quarter, and which of those choices a reader can copy on Monday morning.`,
    slides: good.slides.map((slide, i) => ({
      ...slide,
      headline: `${seed} note ${i + 1}`,
      body: `Reading ${seed} number ${i + 1}: the ${seed} lane moved because somebody removed a step nobody owned, and the measurement followed a fortnight later.`,
      // The rotation above: one statement slide per run, carrying the one
      // device shape a typographic archetype renders. Its caps (value <= 12,
      // label <= 80, source <= 120) are the schema's own.
      ...(i === statementSlide
        ? {
            layout: "headline_focus" as const,
            kicker: "THE TURN",
            device: { kind: "figure" as const, value: `${40 + i}%`, label: `of the ${seed} cohort`, source: "internal data, 2026" },
          }
        : {}),
      ...(i === 1
        ? {
            layout: "custom" as const,
            customArchetype: {
              archetypeId: ARCHETYPE_ID,
              name: "Pull rail",
              rationale: "the supporting line has to sit inside the headline's own counter, which no archetype stacks",
              bodyHtml: overrides.bodyHtml ?? BODY_HTML,
              css: CSS,
              // Derived from the markup, because `assertSafeMarkup` refuses a
              // `{{key}}` that is not a declared slot: the two fixtures below
              // read different names and both have to be legal.
              slots: slotsOf(overrides.bodyHtml ?? BODY_HTML),
              fields: Object.fromEntries(slotsOf(overrides.bodyHtml ?? BODY_HTML).map((name) => [name, `a supporting ${name} line for the ${seed} run`])),
            },
          }
        : {}),
    })),
  };
}

function roundTurns(copy: InstagramCopyOutput) {
  return standardTurns({
    angle: goodAngleProposal(),
    copy,
    vet: goodImageVettingOutput(),
    relevance: goodRelevanceVerdict(),
    qa: goodVisualQaOutput(),
  });
}

describe("09f-auto-promote-templates (item O): two clean ships promote, a third does not, an edited one never counts", () => {
  let env: TestEnvironment;
  const templateId = customArchetypeTemplateId("acme", ARCHETYPE_ID);

  beforeEach(async () => {
    // Several full runs against one client, so the topic-floor guard never
    // intervenes on the later ones.
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 20 }, (_, i) => `auto promote topic ${i + 1}`) });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  /** One full run to a human gate, then the reviewer's response, then delivery. Returns the step ids. */
  async function shipOnce(
    runId: string,
    store: MemoryTemplateStore,
    copy: InstagramCopyOutput,
    response: {
      decision: "approve" | "revise" | "reject";
      edits?: { slides?: Array<{ n: number; fields: Record<string, string> }> };
      templateFeedback?: Array<{ slide: number; templateId: string; verdict: "approved" | "revise"; note: string; promote: boolean }>;
    },
  ): Promise<string[]> {
    const router = fakeRouterSequence([finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), ...roundTurns(copy)]);
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
    const first = await engine.run(workflowFn, { runId, ...base });
    expect(first.status, JSON.stringify(first)).toBe("awaiting_gate");
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: response.decision,
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
      ...(response.edits !== undefined ? { edits: response.edits } : {}),
      ...(response.templateFeedback !== undefined ? { templateFeedback: response.templateFeedback } : {}),
    });
    const second = await engine.run(workflowFn, { runId, ...base });
    expect(second.status).toBe("completed");
    return (await durableStore.listSteps(runId)).map((s) => s.stepId);
  }

  it("ONE clean ship records but does not promote; the SECOND promotes at 55 with a note naming BOTH run ids", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);

    const firstIds = await shipOnce("promo_run_1", store, copyWithCustomArchetype("first", { shape: 0 }), { decision: "approve" });
    // The counting step runs on every delivered approve; the promotion inside
    // it is what is conditional.
    expect(firstIds).toContain("09f-auto-promote-templates");
    expect(await store.get(templateId)).toBeUndefined();
    const afterOne = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(afterOne.records[0]).toMatchObject({ templateId, cleanShips: 1, runIds: ["promo_run_1"] });

    await shipOnce("promo_run_2", store, copyWithCustomArchetype("second", { shape: 1 }), { decision: "approve" });
    const promoted = await store.get(templateId);
    expect(promoted).toBeDefined();
    expect(promoted?.qualityScore).toBe(AUTO_PROMOTE_QUALITY_SCORE);
    expect(promoted?.qualityScore).toBe(55);
    expect(promoted?.source).toBe("ai_generated");
    expect(promoted?.clientSlug).toBe("acme");
    expect(promoted?.enabled).toBe(true);
    expect(promoted?.htmlTemplate).toContain("{{headline}}");
    // Stored as a ROUTABLE archetype — this client's own `headline_focus` —
    // not under the authored `custom_*` id, which nothing in the layout enum
    // names and `resolveBest` could therefore never hand to a later run.
    expect(promoted?.archetypeId).toBe("headline_focus");
    expect(promoted?.archetypeId).not.toBe(ARCHETYPE_ID);
    expect(promoted?.layoutType).toBe("typographic");
    // `actor` is deliberately queryable: a human can ask the registry which
    // designs nobody explicitly chose.
    const entry = promoted?.feedback.find((f) => f.actor === AUTO_PROMOTE_ACTOR);
    expect(entry).toBeDefined();
    expect(entry?.note).toContain("promo_run_1");
    expect(entry?.note).toContain("promo_run_2");
  }, 180000);

  it("a THIRD clean ship does not re-promote, so the score is never reset back to its opening value", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("promo3_run_1", store, copyWithCustomArchetype("alpha", { shape: 0 }), { decision: "approve" });
    await shipOnce("promo3_run_2", store, copyWithCustomArchetype("beta", { shape: 1 }), { decision: "approve" });
    const afterTwo = await store.get(templateId);
    expect(afterTwo?.qualityScore).toBe(55);

    await shipOnce("promo3_run_3", store, copyWithCustomArchetype("gamma", { shape: 2 }), { decision: "approve" });
    const afterThree = await store.get(templateId);
    // Unchanged by the promotion path. `reviewTemplate` is what moves it from
    // here, exactly as it moves a human-promoted row.
    expect(afterThree?.qualityScore).toBe(55);
    expect(afterThree?.feedback.filter((f) => f.actor === AUTO_PROMOTE_ACTOR)).toHaveLength(1);
    const history = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(history.records[0]?.cleanShips).toBe(3);
    expect(history.records[0]?.promotedFromRunIds).toEqual(["promo3_run_1", "promo3_run_2"]);
  }, 240000);

  it("a design that reads its own invented slot name counts its clean ships but is NOT promoted, and the reason is recorded", async () => {
    // The other half of the routing constraint. Two clean ships earn the
    // promotion; a `{{note}}` no archetype supplies means there is nothing
    // routable to store it as, and storing it anyway would ship a row that
    // either cannot be picked or renders a hole where the rail should be. So
    // the ledger keeps counting and `09f` records why it stopped there.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("unroutable_run_1", store, copyWithCustomArchetype("first", { shape: 0, bodyHtml: UNROUTABLE_BODY_HTML }), { decision: "approve" });
    const ids = await shipOnce("unroutable_run_2", store, copyWithCustomArchetype("second", { shape: 1, bodyHtml: UNROUTABLE_BODY_HTML }), {
      decision: "approve",
    });
    expect(ids).toContain("09f-auto-promote-templates");
    expect(await store.get(templateId)).toBeUndefined();

    // The clean ships are still counted — this is a routing limitation, not a
    // verdict on the design — and the record says so.
    const history = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(history.records[0]).toMatchObject({ templateId, cleanShips: 2 });
    expect(history.records[0]?.promotedAt).toBeDefined();
    const warns = await env.store.listJson<{ level: string; message: string }>("acme", ["ledger", "events", "unroutable_run_2"]);
    const problem = warns.map((w) => w.data.message).find((m) => m.includes("{{note}}"));
    expect(problem, `no 09f warn named the unroutable slot: ${JSON.stringify(warns.map((w) => w.data.message))}`).toBeDefined();
    expect(problem).toContain("cannot be offered to a later run");
  }, 180000);

  it("an approve that EDITED THAT SLIDE does not count, so a design nobody left alone never promotes", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("promo_edit_1", store, copyWithCustomArchetype("delta", { shape: 0 }), { decision: "approve" });
    await shipOnce("promo_edit_2", store, copyWithCustomArchetype("epsilon", { shape: 1 }), {
      decision: "approve",
      edits: { slides: [{ n: 2, fields: { note: "the reviewer rewrote this line" } }] },
    });
    expect(await store.get(templateId)).toBeUndefined();
    const history = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(history.records[0]?.cleanShips).toBe(1);
  }, 180000);

  it("a `revise` template verdict on the design does not count either", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("promo_rev_1", store, copyWithCustomArchetype("zeta", { shape: 0 }), { decision: "approve" });
    await shipOnce("promo_rev_2", store, copyWithCustomArchetype("eta", { shape: 1 }), {
      decision: "approve",
      templateFeedback: [{ slide: 2, templateId, verdict: "revise", note: "the rail is too tight against the frame", promote: false }],
    });
    expect(await store.get(templateId)).toBeUndefined();
    // Asserted on the ledger too, not only on the absent row: "no row" is
    // also what an unwired 09f produces, so the count is what proves the
    // verdict was actually read.
    const history = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(history.records[0]?.cleanShips).toBe(1);
    expect(history.records[0]?.runIds).toEqual(["promo_rev_1"]);
  }, 180000);

  it("a CHANGED design under the same archetypeId resets the count, so two unrelated layouts are never counted as one", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("promo_hash_1", store, copyWithCustomArchetype("theta", { shape: 0 }), { decision: "approve" });
    await shipOnce("promo_hash_2", store, copyWithCustomArchetype("iota", { shape: 1, bodyHtml: `<section class="grid"><h1>{{kicker}}</h1><em>{{note}}</em></section>` }), {
      decision: "approve",
    });
    expect(await store.get(templateId)).toBeUndefined();
    const history = readCustomArchetypeHistory(await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]));
    expect(history.records[0]?.cleanShips).toBe(1);
    expect(history.records[0]?.resetReason).toContain("different markup");
  }, 180000);

  it("the ledger of designs is a SIBLING belief key: the budget history and the skeleton history both survive the same write", async () => {
    // One DISABLED studio row, so `00c-check-template-studio` resolves
    // `awaiting-approval`: this fixture is about item O's flywheel and its
    // router queues no item-N studio turns. A disabled row is invisible to
    // `materializeTemplates`, so nothing about the renders changes.
    const store = new MemoryTemplateStore([pendingStudioRow()]);
    await shipOnce("promo_siblings", store, copyWithCustomArchetype("kappa"), { decision: "approve" });
    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    expect(beliefs?.[CUSTOM_ARCHETYPE_BELIEF_KEY]).toBeDefined();
    expect(beliefs?.["instagramRunBudget"]).toBeDefined();
    expect(beliefs?.["instagramSkeletons"]).toBeDefined();
  }, 120000);
});
