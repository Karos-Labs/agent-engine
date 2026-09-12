import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolRegistry, ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { RUN_BUDGET_BELIEF_KEY } from "../src/workflow/run-budget.js";
import type { ConceptReport } from "../src/workflow/types.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodImageCandidatePool,
  goodRelevanceVerdict,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  SIX_RESEARCH_FACTS,
  type TestEnvironment,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { standardTurns } from "./turns.js";
import { createGetLikenessConsent } from "@agent-engine/tool-karos-media";

/**
 * RFC-16 Phase 4 — the CONCEPT mode's WORKFLOW WIRING.
 *
 * The selector's arithmetic, the recognition lexicon, the subject palette and
 * the ten legibility clauses are pure and are proved in
 * `concept-direction.test.ts`; the vet's metaphor rubric is proved in
 * `concept-vet-metaphor.test.ts`. What is proved HERE is the spine — the four
 * steps in their real positions, wired into the real rescue-tier loop, with
 * the real budget meter and the real gate payload underneath them.
 *
 * Five properties, each its own `it`, each written by breaking the code first
 * and watching the guard refuse (the note under each one says exactly what was
 * broken and what the test then said):
 *
 *  1. THE STRICTLY-BETTER REPLACEMENT RULE (§6.4.3). The whole spine rests on
 *     it: because `04n` never mutates `slide.visualNeed`, the concept slide
 *     keeps the photograph retrieval already found for it, so a concept image
 *     can only win by out-scoring that photograph on the SAME rubric. The
 *     mode cannot degrade a slide. Every other property in this design is an
 *     improvement; this one is the guarantee.
 *  2. THE RE-VET INPUT (§6.2). The generate tier is the only tier a concept
 *     image can arrive on, and it was building its slides WITHOUT `why` —
 *     which `instagram-image-vet`'s own prompt says falls back to v3
 *     literalism. So the one tier that needs the metaphor-tolerant
 *     discriminator was the one tier that stripped it.
 *  3-4. THE NEVER-A-HOLD LADDER (§7.3). A non-normal meter posture and a
 *     generation `content_fail` are two different rungs of it, and neither may
 *     ever produce anything but a `completed` run with a full deliverable.
 *  5. THE REPORT ON A DECLINED RUN (§1.7). `conceptReport` on the gate payload
 *     on EVERY run, including — especially — the ones where the mode declined,
 *     because "this client never gets concept images" and "this client's
 *     stories never qualify" have to be distinguishable to a reviewer, and
 *     because the measured selection rate §1.6 refuses to guess needs a
 *     denominator.
 *
 * NOTE ON TURN ORDER. `04m-design-concept` sits between `04j-select-angle` and
 * `05-write-copy-attempt-1`, so its router turn goes between the `angle` and
 * `copy` fixtures. `turns.ts`'s `TURN_ORDER` has no `concept` key yet, so the
 * turn is spliced in here by calling `standardTurns` twice around it. When
 * `turns.ts` grows the key, `conceptTurns` below collapses to one call and
 * nothing else in this file changes.
 */

const BASE = {
  clientSlug: "acme",
  productId: "instagram-agent",
  runKind: "recurring" as const,
};

/** Chromium-free `publish.renderCarousel`, exactly as every other workflow-level test in this package does it. */
function testTools(tools: AgentToolRegistry): AgentToolRegistry {
  return { ...tools, "publish.renderCarousel": fakeRenderCarousel(tools["publish.renderCarousel"]!) };
}

function stubTool(name: string, outcome: unknown, onCall?: (args: Record<string, unknown>) => void): AgentTool {
  return {
    name,
    version: "1.0.0",
    async execute(args: unknown) {
      onCall?.(args as Record<string, unknown>);
      return outcome;
    },
    inputSchema: { parse: (v: unknown) => v } as never,
  } as unknown as AgentTool;
}

/**
 * One under-target run's history, so `planRunBudget` leaves the image cap
 * above zero and the generate tier is reachable at all.
 *
 * Not a convenience: at `instagram-copy@15`'s honest price the COLD estimate
 * steps the image cap 8 -> 4 -> 2 -> 0 before a tool is called, and
 * eligibility precondition 7 (`generatedImagesCap > 0`) would then decline
 * every run in this file for a reason that has nothing to do with what is
 * being tested. `image-sourcing.test.ts` seeds the same row for the same
 * reason.
 */
/**
 * Lets the scouted story take the slot instead of the seeded catalog row.
 *
 * Eligibility precondition 3's grounding floor reads `trend.brandFit >= 4`
 * **when a trend took the slot**, and falls back to the chosen angle's own fit
 * when one did not. `setupTestEnvironment` seeds a catalog, so on the default
 * config `resolveTopicClaim` keeps the planned row, `topicClaim.trend` is
 * `undefined`, and the concept selector scores the story with none of its
 * trend-derived terms — a decline that is about topic selection rather than
 * about anything in RFC-16. `trendJacking: "always"` is the client setting
 * that opens branch 2 of `resolveTopicClaim`, which is the real configuration a
 * client running this mode would be on.
 */
async function jackTrends(env: TestEnvironment): Promise<void> {
  const config = (await env.store.readJson<Record<string, unknown>>("acme", ["client", "config"])) ?? {};
  await env.store.writeJson("acme", ["client", "config"], { ...config, trendJacking: "always" });
}

async function allowGeneratedImages(env: TestEnvironment, runId: string): Promise<void> {
  await env.tools["memory.updateBeliefs"]!.execute(
    { diff: { [RUN_BUDGET_BELIEF_KEY]: { version: 1, ewmaRatio: 0.5, overrunStreak: 0, underTargetStreak: 0, runs: [] } } },
    { ctx: { ...BASE, runId, metadata: {} } },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// A story that genuinely earns the concept treatment
//
// RFC-16 §1.4's three 2-point shape terms are a reversal, a figure that
// reframes and a NAMED CONTEST; §1.5 precondition 2 is recognition, drawn
// from fact-card `source` fields and evidence hostnames rather than from a
// capitalisation heuristic (which is silent in Hebrew — §1.3). So the fixture
// below carries a contrast marker in the headline AND organisation names in
// the cards' own `source` fields, which is what a real qualifying story looks
// like. `conceptMode: "on"` is passed on the run input as a BELT, not as the
// mechanism: it bypasses the score, the recognition gate and the cooldown and
// NOTHING else, so every grounding, palette, colour, budget and safety gate
// below is still doing its job in these runs.
// ─────────────────────────────────────────────────────────────────────────

function conceptTrendScout() {
  // One candidate PER CONTENT MODE, all at `brandFit: 5`, because
  // `03d-select-content-mode` rotates the mode from the decision log and an
  // out-of-mode candidate never takes the slot. Precondition 3's grounding
  // floor reads `trend.brandFit >= 4` only WHEN A TREND TOOK THE SLOT; with no
  // in-mode candidate the floor falls back to the angle's own fit, which the
  // fixture angles do not clear — an eligibility decline for a reason that has
  // nothing to do with what these tests are about. All three carry the same
  // contrast marker, so §1.4's `contest` term scores whichever one wins.
  const base = {
    brandFit: 5 as const,
    interest: 5 as const,
    brandFitReason: "the client sells exactly the reporting automation both vendors just shipped, to the same operations leads",
    angle: "a default report is not a designed one, whoever ships it first",
    hook: "Two vendors shipped the same weekly report this week. Neither asked what it was for.",
    whyNow: "Northwind vs Ridgeline: both announcements landed within three days of each other",
    sourceUrls: ["https://northwind.example/newsroom/reporting", "https://ridgeline.example/blog/reporting"],
    publishedAt: "2026-09-10",
    hasNumbers: true,
    mediaHint: "data" as const,
  };
  return goodTrendScoutOutput({
    candidates: [
      { ...base, topic: "two platform vendors are fighting over the same weekly-reporting slot", headline: "Northwind vs Ridgeline: both shipped automated weekly reporting in the same week", mode: "hot-news" },
      { ...base, topic: "what the vendor fight over weekly reporting actually changes for a small operations team", headline: "Northwind vs Ridgeline: what the reporting fight changes for a two person team", mode: "deep-value" },
      { ...base, topic: "who should own the weekly report now that two vendors ship one by default", headline: "Northwind vs Ridgeline shipped the same report — so who owns it now?", mode: "open-discussion" },
    ],
    skipped: [],
  });
}

/**
 * The same six claims the rest of the fixtures use — so `restsOn`,
 * `sourceRef` and the angle fixtures all still line up — with the first two
 * cards' `source` fields naming ORGANISATIONS, which is where §1.3's
 * recognition lexicon actually reads from.
 */
function conceptResearch() {
  return {
    ...goodResearchOutput(),
    facts: SIX_RESEARCH_FACTS.map((fact, i) =>
      i === 0 ? { ...fact, source: "Northwind newsroom" } : i === 1 ? { ...fact, source: "Ridgeline engineering blog" } : fact,
    ),
  };
}

/**
 * `04m-design-concept`'s output, shaped to clear all ten legibility clauses
 * against `goodClientBrief()`:
 *
 *  L1 `restsOn` is `SIX_RESEARCH_FACTS[0]`'s claim VERBATIM.
 *  L2 `anchor` names `icp.roles[0]` ("founder"), a real subject-palette token.
 *  L3 the anchor is a photographable object, not "trust" or "momentum".
 *  L4 `decodesTo` names a recognised entity and the angle's own remember-line term.
 *  L5 one clause in `situation`, no simile marker in `scene`.
 *  L6 `readsAs` is deliberately NOT `decodesTo` — it is what someone who has
 *     not read the headline would say the picture is of.
 *  L7 nothing here is on `forbidden.topics` (`politics`) or the direction's
 *     forbid list (stock handshakes, boardroom tables).
 *  L8 `paletteRole` names the object that carries the accent.
 *  L9 `usesPermittedMarks` is EMPTY, which is the shipped fleet-wide state: no
 *     client has a `generatedLikeness` record, so any entry here would be
 *     discarded by L9 rather than drawn.
 *  L10 `scene` is under 240 characters.
 */
function conceptFixture(overrides: Record<string, unknown> = {}) {
  return {
    pattern: "rivalry",
    // <= 80 characters, per `ConceptSchema.anchor`.
    anchor: "a founder at the head of one long table, two identical chairs closing in",
    situation: "both chairs are reaching for the one seat that is already taken",
    scene:
      "One long table in a dark room, a single founder seated at its head, two identical empty high-backed chairs pushed toward that one seat from either side, low rim light, deep shadow across the lower third.",
    readsAs: "a person at the head of a long table with two empty chairs closing in",
    // L4 wants BOTH halves: a recognised entity (Northwind / Ridgeline, from
    // the fact cards' own `source` fields) AND a term this slide is actually
    // about — here the figure `claimFigures(restsOn)` pulls out of the claim
    // ("4 hours") and the brief's own core term ("founders").
    decodesTo: "Northwind and Ridgeline are both reaching for the 4 hours a week these founders already own",
    restsOn: SIX_RESEARCH_FACTS[0]!.claim,
    paletteRole: "the rim light along the table edge and the chair backs takes its colour from the brand accent",
    productionNote: "push the locked style to its most dramatic end",
    usesPermittedMarks: [],
    typeZone: "the lower third is held in deep shadow and kept clear of objects so the headline can sit on it",
    ...overrides,
  };
}

/**
 * Six slides with STRUCTURED scene briefs, so `vetSubjectFor` has a real `why`
 * to carry. `goodCopyOutput()`'s slides use the LEGACY bare string, for which
 * `normaliseVisualNeed` synthesises no `why` at all — and a fixture with no
 * `why` cannot prove that the re-vet carries one.
 */
function conceptCopy() {
  return {
    format: "carousel" as const,
    caption:
      "Two vendors shipped the same weekly report this week, and neither of them asked what the report was for. Here is what we changed instead.",
    slides: SIX_RESEARCH_FACTS.map((fact, i) => ({
      n: i + 1,
      headline: `Finding #${i + 1}`,
      body: fact.claim,
      visualNeed: {
        scene: `A real workspace scene for finding ${i + 1}: ${fact.claim.slice(0, 90)}`,
        why: `slide ${i + 1} claims ${fact.claim.slice(0, 60)} and the picture has to show that it is about real work, not a stock office`,
        source: "stock" as const,
        searchTerms: ["operations team", "weekly report", "laptop desk"],
      },
      sourceRef: fact.claim,
      layout: "photo" as const,
    })),
  };
}

function selectionsFor(
  copy: ReturnType<typeof conceptCopy>,
  imagePath: string,
  claimMatchByN: Record<number, number> = {},
) {
  return {
    selections: copy.slides.map((s) => ({
      n: s.n,
      imagePath,
      reason: "candidate matches the slide's claim",
      license: "CC0, test fixture",
      rightsUsable: true,
      watermarkFree: true,
      claimMatch: claimMatchByN[s.n] ?? 5,
      claimMatchReason: "shows the claimed subject",
    })),
  };
}

/**
 * The router turns for a run where the concept step fires, in the order the
 * workflow consumes them. See the NOTE ON TURN ORDER in this file's header for
 * why `standardTurns` is called twice.
 */
function conceptTurns(fixtures: {
  scout?: unknown;
  research?: unknown;
  angle?: unknown;
  concept?: unknown;
  copy?: unknown;
  vet?: unknown;
  rescueVet?: unknown;
  relevance?: unknown;
  qa?: unknown;
}) {
  return [
    ...standardTurns({
      ...(fixtures.scout !== undefined ? { scout: fixtures.scout } : {}),
      ...(fixtures.research !== undefined ? { research: fixtures.research } : {}),
      ...(fixtures.angle !== undefined ? { angle: fixtures.angle } : {}),
    }),
    // 04m-design-concept — the one model call the concept mode adds.
    ...(fixtures.concept !== undefined ? [finalTurn(fixtures.concept)] : []),
    ...standardTurns({
      ...(fixtures.copy !== undefined ? { copy: fixtures.copy } : {}),
      ...(fixtures.vet !== undefined ? { vet: fixtures.vet } : {}),
    }),
    // 06e-vet-generate-attempt-N — the rescue tier's own re-vet, which
    // `standardTurns` does not model because it is conditional on a gap (or,
    // now, on a pending concept).
    ...(fixtures.rescueVet !== undefined ? [finalTurn(fixtures.rescueVet)] : []),
    ...standardTurns({
      ...(fixtures.relevance !== undefined ? { relevance: fixtures.relevance } : {}),
      ...(fixtures.qa !== undefined ? { qa: fixtures.qa } : {}),
    }),
  ];
}

/** Every agent-step input the fake router saw, parsed back out of the JSON prompt `BaseAgent` sends. */
function turnInputs(router: ModelRouter): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input !== undefined && parsed.input !== null && typeof parsed.input === "object") inputs.push(parsed.input);
    } catch {
      // not a JSON prompt; BaseAgent always sends one, so this is unreachable in practice
    }
  }
  return inputs;
}

/** The LAST image-vetting input — on a run with a rescue tier that is the generate tier's re-vet, never `06`'s first pass. */
function lastVettingInput(router: ModelRouter): Record<string, unknown> | undefined {
  return turnInputs(router)
    .filter((input) => "candidatePool" in input && "slides" in input)
    .at(-1);
}

async function deliverableFor(env: TestEnvironment, runId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await env.store.listJson<{ deliverable?: Record<string, unknown> }>("acme", ["ledger", "deliverables", runId, "_"]);
  return rows.at(-1)?.data.deliverable;
}

describe("RFC-16 Phase 4 — the concept mode's workflow wiring", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. THE STRICTLY-BETTER REPLACEMENT RULE
  // ───────────────────────────────────────────────────────────────────────

  it("a concept image that scores 4 does NOT replace a photograph that already scores 4", async () => {
    // The property the whole spine rests on (RFC-16 §6.4.3). Slide 1 already
    // has a real photograph the tier-1 vet scored 4/5. The concept fires, the
    // generate tier runs FOR IT even though there is no gap, the concept image
    // is generated and re-vetted — and comes back at the SAME 4. A tie is not
    // a win. The photograph stays.
    //
    // BROKEN AND WATCHED: changing `replacement.claimMatch > sel.claimMatch`
    // to `>=` in the rescue loop makes slide 1's `imagePath` flip to
    // `CONCEPT_IMAGE` and `conceptReport.shipped` flip to `true`, and this
    // test fails on both assertions. Deleting the concept-slide branch
    // entirely (so every fillable replacement wins, which is the pre-Phase-4
    // behaviour) fails it the same way. The premise is asserted too: the
    // concept genuinely WAS generated and re-vetted, so this is a refused
    // replacement rather than a mode that never ran.
    const runId = "ig_concept_tie_keeps_photo";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);

    const copy = conceptCopy();
    const pool = goodImageCandidatePool();
    const retrieved = pool[0]!.path;
    const CONCEPT_IMAGE = pool[1]!.path;

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      "image.generate": stubTool("image.generate", {
        status: "success",
        result: {
          model: "gemini-2.5-flash-image",
          unmet: [],
          candidates: [{ path: CONCEPT_IMAGE, description: "slide 1 candidate — a founder at a long table", provider: "gemini-image", licenseConfidence: "generated" }],
        },
      }),
      "media.inspectImages": stubTool("media.inspectImages", {
        status: "success",
        result: {
          inspections: [
            {
              ref: "concept",
              description: "one long table in a dark room, a seated person at its head, two empty high-backed chairs pushed toward the same seat",
              subjects: ["table", "chairs", "a seated person"],
              textInImage: [],
              hasPeople: true,
              quality: "usable",
              hasWatermark: false,
              looksAiGenerated: true,
            },
          ],
        },
      }),
    });

    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept: conceptFixture(),
        copy,
        // Slide 1 — the cover, and the slide `04n` binds the concept to —
        // already holds a photograph at 4/5. Every other slide is a clean 5,
        // so there is NO GAP anywhere: the generate tier runs only because a
        // concept is pending, which is §6.4.1.
        vet: selectionsFor(copy, retrieved, { 1: 4 }),
        // The concept image comes back at the same 4. Not worse. Not better.
        rescueVet: {
          selections: [
            {
              n: 1,
              imagePath: CONCEPT_IMAGE,
              reason: "the metaphor is legible but the situation is approximately right rather than exactly the declared one",
              license: "Generated image",
              rightsUsable: true,
              watermarkFree: true,
              claimMatch: 4,
              claimMatchReason: "anchor present, the decode takes a beat",
            },
          ],
        },
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );

    expect(result.status).toBe("completed");

    // THE PREMISE. Without these two the assertion below is vacuous: a test
    // that "the concept did not replace the photograph" passes trivially on a
    // run where no concept was ever designed or generated.
    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).toContain("04m-design-concept");
    expect(stepIds).toContain("04n-apply-concept-attempt-1");
    expect(stepIds).toContain("06d-generate-images-attempt-1");

    // THE PROPERTY. A tie is not a win.
    const deliverable = await deliverableFor(env, runId);
    const selections = deliverable?.["selections"] as Array<{ n: number; imagePath: string | null; claimMatch: number }>;
    const slideOne = selections.find((s) => s.n === 1);
    expect(slideOne?.imagePath).toBe(retrieved);
    expect(slideOne?.imagePath).not.toBe(CONCEPT_IMAGE);
    expect(slideOne?.claimMatch).toBe(4);

    const conceptReport = deliverable?.["conceptReport"] as ConceptReport | undefined;
    expect(conceptReport?.fired).toBe(true);
    expect(conceptReport?.shipped).toBe(false);
    expect(conceptReport?.declineReason ?? "").not.toBe("");
  }, 60000);

  // ───────────────────────────────────────────────────────────────────────
  // 2. THE RE-VET INPUT
  // ───────────────────────────────────────────────────────────────────────

  it("the re-vet input carries why and the conceptual field on the generate tier", async () => {
    // RFC-16 §6.2 and §6.1 together. The rescue re-vet used to build its
    // slides as `{ n, headline, body, scene: g.prompt, isClientPhotoSlot }` —
    // no `why`. `instagram-image-vet`'s own prompt says a slide arriving with
    // no `why` falls back to v3 literalism, so the generate tier (the only
    // tier a concept image can arrive on) was precisely the tier where the
    // metaphor-tolerant discriminator was stripped. A declared metaphor judged
    // by a literal rubric scores 2 and dies; §6.1's whole rubric would be
    // theatre.
    //
    // BROKEN AND WATCHED: deleting `...vetSubjectFor(need)` from the re-vet
    // input leaves every slide entry without `why` and the first block of
    // assertions fails. Deleting the `conceptual` spread leaves slide 1 with
    // no declared metaphor and the second block fails. Both are separately
    // fatal, which is why they are separately asserted.
    const runId = "ig_concept_revet_input";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);

    const copy = conceptCopy();
    const pool = goodImageCandidatePool();
    const concept = conceptFixture();

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      "media.scrapeImages": stubTool("media.scrapeImages", { status: "content_fail", reason: "nothing on the open social web for this need" }),
      "image.generate": stubTool("image.generate", {
        status: "success",
        result: {
          model: "gemini-2.5-flash-image",
          unmet: [],
          candidates: [
            { path: pool[1]!.path, description: "slide 1 candidate — a founder at a long table", provider: "gemini-image", licenseConfidence: "generated" },
            { path: pool[2]!.path, description: "slide 3 candidate — a small team reviewing charts", provider: "gemini-image", licenseConfidence: "generated" },
          ],
        },
      }),
      "media.inspectImages": stubTool("media.inspectImages", {
        status: "success",
        result: {
          inspections: [
            {
              ref: "concept",
              description: "one long table in a dark room, a seated person at its head, two empty chairs pushed toward the same seat",
              subjects: ["table", "chairs", "a seated person"],
              textInImage: [],
              hasPeople: true,
              quality: "usable",
              hasWatermark: false,
              looksAiGenerated: true,
            },
          ],
        },
      }),
    });

    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept,
        copy,
        // Slide 3 is a genuine gap, so the generate tier carries BOTH a real
        // gap and the concept — which is the case where a `conceptual` field
        // leaking onto the wrong slide would be invisible without this test.
        vet: {
          selections: copy.slides.map((s) =>
            s.n === 3
              ? {
                  n: 3,
                  imagePath: null,
                  reason: "no candidate matched this visual need",
                  license: "n/a — no candidate qualified",
                  rightsUsable: false,
                  watermarkFree: false,
                  claimMatch: 1,
                  claimMatchReason: "no candidate shows the claim",
                }
              : {
                  n: s.n,
                  imagePath: pool[0]!.path,
                  reason: "matches",
                  license: "CC0, test fixture",
                  rightsUsable: true,
                  watermarkFree: true,
                  claimMatch: 4,
                  claimMatchReason: "shows the claimed subject",
                },
          ),
        },
        rescueVet: {
          selections: [
            { n: 1, imagePath: pool[1]!.path, reason: "the metaphor reads", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "the declared anchor is what is in frame" },
            { n: 3, imagePath: pool[2]!.path, reason: "drawn to the brief", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 4, claimMatchReason: "shows the claimed subject" },
          ],
        },
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );
    expect(result.status).toBe("completed");

    const revet = lastVettingInput(router);
    expect(revet, "the generate tier's re-vet never ran, so there is nothing to assert about its input").toBeDefined();
    const slides = revet!["slides"] as Array<Record<string, unknown>>;
    // The premise: this really is the RESCUE re-vet (only the concept slide
    // and the gap), not step 06's first pass over all six.
    expect(slides.map((s) => s["n"]).sort()).toEqual([1, 3]);

    // (a) §6.2 — every slide carries the writer's own `why`.
    for (const slide of slides) {
      expect(typeof slide["why"], `slide ${String(slide["n"])} reached the re-vet with no \`why\``).toBe("string");
      expect(String(slide["why"]).length).toBeGreaterThan(0);
    }

    // (b) §6.1 — the DECLARED metaphor, on the one slide `04n` gave a concept
    // to and on no other. Metaphor tolerance is declared by the pipeline, never
    // inferred by the vet; a `conceptual` field on slide 3 would loosen the
    // literalism Phase 0 and Phase 3 bought, on a slide nobody asked to loosen.
    const conceptSlide = slides.find((s) => s["n"] === 1)!;
    const gapSlide = slides.find((s) => s["n"] === 3)!;
    expect(gapSlide["conceptual"]).toBeUndefined();
    const conceptual = conceptSlide["conceptual"] as Record<string, unknown> | undefined;
    expect(conceptual, "the concept slide reached the re-vet with no `conceptual` block").toBeDefined();
    expect(conceptual!["pattern"]).toBe(concept.pattern);
    expect(conceptual!["anchor"]).toBe(concept.anchor);
    expect(conceptual!["decodesTo"]).toBe(concept.decodesTo);
    expect(conceptual!["restsOn"]).toBe(concept.restsOn);
  }, 60000);

  // ───────────────────────────────────────────────────────────────────────
  // 3-4. THE NEVER-A-HOLD LADDER
  // ───────────────────────────────────────────────────────────────────────

  it("04l declines and the run completes when the meter posture is not normal", async () => {
    // RFC-16 §1.5 precondition 7 and §7.2's claim that the hard max is
    // UNREACHABLE by this feature: past the $1.00 target the meter is
    // `essential-only` and the $0.029 Sonnet call is never bought, so the mode
    // can only ever be paid for out of the first dollar and cannot push a run
    // from $1.40 to $1.50.
    //
    // The lever is the RESEARCH turn reporting a large output-token count, so
    // the meter crosses the target BEFORE `04l` runs but the angle step — which
    // only stops on `cheapest-path` — still runs. That is deliberate: an
    // eligibility decline caused by a MISSING ANGLE would pass this test for
    // the wrong reason, so the fixture is built so the angle is present and
    // precondition 7 is the only thing left to fail.
    //
    // BROKEN AND WATCHED: dropping `meter.posture` from `04l`'s budget input
    // (so only `generatedImagesCap` is checked) makes `04m` run, exhausts the
    // router — no concept turn is queued here — and the run throws instead of
    // completing. Asserting `router.complete` call-by-call would also catch it;
    // asserting the step id is the more direct statement of the rule.
    const runId = "ig_concept_past_target";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);

    const copy = conceptCopy();
    const pool = goodImageCandidatePool();

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      // Registered and stubbed to throw if it is ever reached: past the target
      // no generated image may be bought either.
      "image.generate": stubTool("image.generate", { status: "content_fail", reason: "this run must never reach the generate tier" }),
    });

    // NO CONCEPT TURN. If `04m` runs, the router is exhausted and the run
    // fails — which is the point.
    const router = fakeRouterSequence([
      ...standardTurns({ scout: conceptTrendScout() }),
      // ~$1.05 of Sonnet output on the research turn: over the $1.00 target,
      // under the $1.50 hard max, so the posture is `essential-only` and the
      // angle step still runs.
      finalTurn(conceptResearch(), { outputTokens: 70_000 }),
      ...standardTurns({ angle: goodAngleProposal() }),
      ...standardTurns({
        copy,
        vet: selectionsFor(copy, pool[0]!.path),
        relevance: goodRelevanceVerdict(),
        // The visual-QA turn IS still queued. `08b` is skipped only past the
        // HARD MAX; at `essential-only` it still runs, and that separation is
        // the point of this test: the concept step is bought out of the first
        // dollar or not at all, while the mandatory gates keep running on the
        // second.
        qa: goodVisualQaOutput(),
      }),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );

    // NEVER held, never failed. A budget is an adaptation.
    expect(result.status).toBe("completed");

    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    // The free verdict still ran and still recorded itself...
    expect(stepIds).toContain("04l-concept-eligibility");
    // ...and the paid step did not.
    expect(stepIds).not.toContain("04m-design-concept");

    const deliverable = await deliverableFor(env, runId);
    const conceptReport = deliverable?.["conceptReport"] as ConceptReport | undefined;
    // Present even here — §1.7's "on every run including the ones where it
    // declined" is what gives the measured selection rate a denominator.
    expect(conceptReport).toBeDefined();
    expect(conceptReport?.eligible).toBe(false);
    expect(conceptReport?.fired).toBe(false);
    expect(conceptReport?.shipped).toBe(false);
    // `"on"` was requested and was still not enough: the budget gate is not a
    // preference (§1.7 override level 2).
    expect(conceptReport?.mode).toBe("on");
    expect(conceptReport?.rule.length).toBeGreaterThan(0);

    // The deliverable is COMPLETE, not a stub: the ladder's promise is a full
    // post, not merely a non-hold.
    expect((deliverable?.["rendered"] as unknown[]).length).toBe(copy.slides.length);
  }, 60000);

  it("a generation content_fail leaves the slide on its original, never-discarded scene brief and completes", async () => {
    // RFC-16 §7.3's fifth rung, and the reason `04n` does not mutate
    // `slide.visualNeed`. The concept is designed, bound to slide 1, and then
    // generation fails outright. The slide must fall back to the photograph
    // retrieval already found for it AND to the writer's own scene brief —
    // both still intact, because nothing was ever overwritten. Status
    // `completed`, not even `degraded`: the ordinary brief is a complete
    // deliverable.
    //
    // BROKEN AND WATCHED: making `04n` rewrite `slide.visualNeed` to
    // `concept.scene` (design B's approach) makes `retrievalQueryFor` read the
    // concept's own search terms and the slide's `selections` row change out
    // from under it; asserting the SHIPPED image is still the retrieved one is
    // what catches that. Throwing on a generate-tier `content_fail` instead of
    // falling through fails the `completed` assertion.
    const runId = "ig_concept_generation_failed";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);

    const copy = conceptCopy();
    const pool = goodImageCandidatePool();
    const retrieved = pool[0]!.path;
    let generateArgs: Record<string, unknown> | undefined;
    let findImagesArgs: Record<string, unknown> | undefined;

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool(
        "media.findImages",
        { status: "success", result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] } },
        (args) => {
          findImagesArgs = args;
        },
      ),
      "image.generate": stubTool("image.generate", { status: "content_fail", reason: "filtered by the model's safety policy" }, (args) => {
        generateArgs = args;
      }),
    });

    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept: conceptFixture(),
        copy,
        vet: selectionsFor(copy, retrieved, { 1: 4 }),
        // No rescueVet turn: generation produced nothing, so there is nothing
        // to re-vet and a queued turn would be left unconsumed.
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // Not even degraded: an ordinary scene brief is a complete deliverable.
    expect(result.output.budget?.status).toBeUndefined();

    // THE PREMISE: generation really was attempted, on the concept's own
    // scene, for slide 1.
    const needs = generateArgs?.["needs"] as Array<{ n: number; prompt: string }> | undefined;
    expect(needs, "the generate tier never ran, so this test proves nothing about its failure").toBeDefined();
    expect(needs![0]!.n).toBe(1);
    expect(needs![0]!.prompt).toBe(conceptFixture().scene);

    // THE PROPERTY (a): the RETRIEVAL query was never poisoned. `04n` leaves
    // `visualNeed` immutable, so slide 1's query is still the WRITER's own
    // `searchTerms` and not one word of the concept's scene.
    const searched = findImagesArgs?.["needs"] as Array<{ n: number; query: string }> | undefined;
    const slideOneQuery = searched?.find((n) => n.n === 1)?.query ?? "";
    expect(slideOneQuery).toBe(copy.slides[0]!.visualNeed.searchTerms.join(" "));
    expect(slideOneQuery).not.toContain("high-backed");

    // THE PROPERTY (b): the slide ships the photograph it already had.
    const deliverable = await deliverableFor(env, runId);
    const selections = deliverable?.["selections"] as Array<{ n: number; imagePath: string | null }>;
    expect(selections.find((s) => s.n === 1)?.imagePath).toBe(retrieved);

    const conceptReport = deliverable?.["conceptReport"] as ConceptReport | undefined;
    expect(conceptReport?.fired).toBe(true);
    expect(conceptReport?.shipped).toBe(false);
    expect(conceptReport?.declineReason ?? "").not.toBe("");
  }, 60000);

  // ───────────────────────────────────────────────────────────────────────
  // 5. THE REPORT ON A DECLINED RUN
  // ───────────────────────────────────────────────────────────────────────

  it("conceptReport appears in the gate payload on a run where the concept declined", async () => {
    // RFC-16 §1.7. The reviewer has to see the decision and its arithmetic
    // BEFORE approving, and has to see it on the runs where nothing happened —
    // otherwise "this client never gets concept images" and "this client's
    // stories never qualify" are the same empty space on the page, and §1.6's
    // promise to report a MEASURED selection rate after ten prep runs has no
    // denominator to measure against.
    //
    // `conceptMode: "off"` is the cleanest decline to assert on because it is
    // the one verdict that does not depend on the selector's arithmetic at
    // all: RFC-16 §1.7 level 2 says `"off"` is an override, and an override
    // that produced no report would be exactly the invisible decision this
    // clause exists to prevent.
    //
    // BROKEN AND WATCHED: making the gate payload spread `conceptReport` only
    // when the mode fired (`...(conceptReport.fired ? { conceptReport } : {})`)
    // — the natural, tidy-looking mistake — leaves `payload.conceptReport`
    // undefined and this test fails on its first assertion.
    const runId = "ig_concept_declined_report";
    await jackTrends(env);

    const copy = conceptCopy();
    const pool = goodImageCandidatePool();

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
    });

    // No concept turn: the mode is off, so `04m` must not run.
    const router = fakeRouterSequence(
      standardTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        copy,
        vet: selectionsFor(copy, pool[0]!.path),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const durableStore = new MemoryDurableStepStore();
    // `autoApprove: false`, so the run parks on the real gate and the real
    // payload can be read back out of the durable store — asserting the
    // deliverable instead would prove the persisted record and say nothing
    // about what the REVIEWER sees, which is the half this clause is about.
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot }),
      { ...BASE, runId, input: { conceptMode: "off" } },
    );
    expect(result.status).toBe("awaiting_gate");

    const gate = await durableStore.getGate(`${runId}__09a-batch-review-r0`);
    const payload = gate?.payload as { conceptReport?: ConceptReport } | undefined;

    expect(payload?.conceptReport, "the gate payload carried no conceptReport on a declined run").toBeDefined();
    const report = payload!.conceptReport!;
    expect(report.mode).toBe("off");
    expect(report.eligible).toBe(false);
    expect(report.fired).toBe(false);
    expect(report.shipped).toBe(false);
    // The arithmetic, not merely the verdict: a report that said `false` and
    // nothing else would not tell a reviewer why.
    expect(report.rule.length).toBeGreaterThan(0);
    expect(report.declineReason ?? "").not.toBe("");

    // And the paid step genuinely never ran.
    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds).toContain("04l-concept-eligibility");
    expect(stepIds).not.toContain("04m-design-concept");
  }, 60000);

  // ───────────────────────────────────────────────────────────────────────
  // 6. THE PERMIT IS A CEILING, THE CONCEPT IS THE INSTRUCTION
  //
  // Added by the integrator, not by the package that wrote the wiring.
  //
  // `image.generate` 1.2.0 takes `art.permittedMarks` and
  // `art.permittedFigures`. The wiring first forwarded the concept's own
  // declared `usesPermittedMarks` for the marks but the WHOLE CONSENT
  // RECORD's `publicFigures` for the figures. That asymmetry is a rights
  // defect, not a tidiness one, and it is invisible today only because no
  // client in the fleet has a `generatedLikeness` record at all — so it is
  // exactly the code that would run the first time the owner granted this
  // permission, i.e. the moment the decision the PR asks them to make takes
  // effect.
  //
  // `generate-image.ts:244` turns a non-empty `permittedFigures` into the
  // sentence "a deliberate, recorded-permission likeness of <names>" inside
  // the DESCRIPTION, and that description is what the image vet reads — the
  // tool's own doc comment says the sentence exists because "the vet has no
  // pixels on the generate tier, so it believes this sentence". Forwarding
  // the ceiling therefore tells the vet that a face it cannot see is in a
  // frame that does not contain it, and does so for EVERY need in the call,
  // not only the concept's slide. `buildConstraintLine` compounds it by
  // licensing the model to draw that person.
  //
  // BROKEN AND WATCHED: restoring the original
  // `...(forConcept !== undefined && likenessPermit.publicFigures.length > 0
  //      ? { permittedFigures: likenessPermit.publicFigures } : {})`
  // makes the first test below fail with
  //   `the generation brief named a figure the concept never asked for:
  //    expected [ 'Tim Cook' ] to be undefined`.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Grants `acme` a public figure and a third-party mark, as an owner would by
   * hand — written straight to `clients/acme/client/consent.json`, which is
   * the only way this permission can ever come into existence. No agent may
   * write this block.
   */
  async function grantLikeness(env: TestEnvironment): Promise<void> {
    await env.store.writeJson("acme", ["client", "consent"], {
      generatedLikeness: {
        status: "granted",
        grantedAt: "2026-09-11",
        grantedBy: "owner",
        allow: { thirdPartyMarks: ["Northwind"], publicFigures: ["Tim Cook"] },
        scopeNote: "commentary about the reporting fight only",
      },
    });
  }

  /**
   * Runs one concept run and hands back the `art` block `image.generate` was
   * actually called with. The tool is stubbed to `content_fail` on purpose:
   * what is under test is the BRIEF that reaches it, and a failing generate
   * tier still degrades to a completed run (§7.3), so the assertion cannot be
   * confounded by the replacement rule.
   */
  async function artBlockFor(env: TestEnvironment, runId: string, concept: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    await jackTrends(env);
    await allowGeneratedImages(env, runId);
    const copy = conceptCopy();
    const pool = goodImageCandidatePool();
    let art: Record<string, unknown> | undefined;
    const tools = testTools({
      ...env.tools,
      // The REAL reader, not a stub, built over the same workspace store
      // `grantLikeness` just wrote to. `setupTestEnvironment` registers no
      // `media.*` tools, so without this line `00e` resolves to
      // `NO_LIKENESS_PERMIT` with the reason "not registered on this
      // deployment" and both tests below would pass for the wrong reason — the
      // permit would be empty because nothing read it, not because the split
      // narrowed it. (The server wiring DOES register it, via
      // `createKarosMediaTools` at `apps/agent-server/src/wiring/tools.ts:138`,
      // so this is the production shape.)
      "media.getLikenessConsent": createGetLikenessConsent(env.store) as unknown as AgentTool,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      "media.scrapeImages": stubTool("media.scrapeImages", { status: "content_fail", reason: "nothing on the open social web for this need" }),
      "image.generate": stubTool("image.generate", { status: "content_fail", reason: "stubbed — this test reads the brief, not the picture" }, (args) => {
        art = (args as { art?: Record<string, unknown> }).art;
      }),
    });
    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept,
        copy,
        vet: selectionsFor(copy, pool[0]!.path, { 1: 4 }),
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );
    // Never a hold, even with the generate tier failing (§7.3).
    expect(result.status).toBe("completed");
    // THE PREMISE: without this the `art` assertions below are vacuous,
    // because an `undefined` art block trivially "names no figure".
    const stepIds = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(stepIds, "the concept step never ran, so this test proves nothing about the brief").toContain("04m-design-concept");
    expect(stepIds).toContain("06d-generate-images-attempt-1");
    expect(art, "image.generate was never called, so there is no brief to assert on").toBeDefined();
    return art;
  }

  it("a granted figure the concept did not ask for never reaches the generation brief", async () => {
    await grantLikeness(env);
    // The permit names Tim Cook and Northwind. This concept declares NEITHER —
    // which is the ordinary case even for a client with a record, since most
    // concepts are generic archetypes.
    const art = await artBlockFor(env, "ig_concept_permit_unused", conceptFixture({ usesPermittedMarks: [] }));

    expect(art?.["permittedFigures"], "the generation brief named a figure the concept never asked for").toBeUndefined();
    expect(art?.["permittedMarks"], "the generation brief named a mark the concept never asked for").toBeUndefined();
    // And the art block is otherwise fully populated, so the two absences
    // above are a narrowed permit rather than a missing art block.
    expect(art?.["styleLock"]).toBeDefined();
    expect(art?.["forbid"]).toBeDefined();
  }, 60000);

  it("a figure the concept DID declare reaches the brief as a figure, and a mark as a mark", async () => {
    await grantLikeness(env);
    // L9 validates `usesPermittedMarks` against the UNION of the record's two
    // lists, so both names are legal here and arrive in the one field. The
    // split back into two is what `conceptPermittedSubjects` does, and getting
    // it wrong the other way would put a person into the marks clause — which
    // confines a name to "clean flat circular badges … never a person's
    // likeness" and would brief the model to draw a human being as a logo.
    const art = await artBlockFor(
      env,
      "ig_concept_permit_used",
      conceptFixture({
        usesPermittedMarks: ["Tim Cook", "Northwind"],
        decodesTo: "Northwind and Tim Cook are both reaching for the 4 hours a week these founders already own",
      }),
    );

    expect(art?.["permittedFigures"]).toEqual(["Tim Cook"]);
    expect(art?.["permittedMarks"]).toEqual(["Northwind"]);
  }, 60000);

  // ───────────────────────────────────────────────────────────────────────
  // 7. A CONCEPT BATCH IS A MIXED BATCH
  //
  // Added by the integrator. `04n` force-adds the concept slide to `gaps`,
  // so one `image.generate` call answers the concept AND every ordinary
  // unfillable slide — and `image.generate` bills per need, so those other
  // pictures are PAID FOR.
  //
  // `06d1` then took `tierPool[0]!` as "the concept candidate" and returned a
  // pool of exactly one. Two things were wrong with that, and neither was
  // visible to the package that wrote it, because the fake router returns its
  // scripted selections whatever pool it is handed — so no existing test ever
  // looked at the pool:
  //
  //  (a) every OTHER slide's generated candidate was discarded after being
  //      billed, and those slides took the text-only downgrade. Money spent,
  //      nothing delivered, which is the one thing the budget doctrine
  //      forbids.
  //  (b) index 0 is only the concept's while the generator fills every need.
  //      `image.generate` reports per-need failures in `unmet` and pushes no
  //      candidate for a need it could not fill, so a partial failure slides
  //      ANOTHER slide's picture into index 0 — where it would be safety-
  //      checked as the concept, given the concept's vision note, and offered
  //      to the concept slide.
  //
  // The fix keys on the `slide <n> candidate — ` stem `describeGenerated`
  // writes, since `ImageCandidate` carries no slide number at all.
  // ───────────────────────────────────────────────────────────────────────

  /** A mixed generate result: a candidate for the concept slide and one for the ordinary gap. `order` lets a test put the concept second. */
  function mixedGenerateResult(conceptPath: string, gapPath: string, order: "concept-first" | "concept-missing") {
    const conceptCandidate = { path: conceptPath, description: "slide 1 candidate — a founder at a long table", provider: "gemini-image", licenseConfidence: "generated" };
    const gapCandidate = { path: gapPath, description: "slide 3 candidate — a small team reviewing charts", provider: "gemini-image", licenseConfidence: "generated" };
    return {
      status: "success",
      result: {
        model: "gemini-2.5-flash-image",
        // `unmet` is what the tool reports for a need it could not fill.
        unmet: order === "concept-missing" ? [{ n: 1, reason: "the model returned no image for this need" }] : [],
        candidates: order === "concept-missing" ? [gapCandidate] : [conceptCandidate, gapCandidate],
      },
    };
  }

  function conceptInspection(subjects: string[] = ["table", "chairs", "a seated person"], textInImage: string[] = []) {
    return {
      status: "success",
      result: {
        inspections: [
          {
            ref: "concept",
            description: "one long table in a dark room, a seated person at its head, two empty high-backed chairs pushed toward the same seat",
            subjects,
            textInImage,
            hasPeople: true,
            quality: "usable",
            hasWatermark: false,
            looksAiGenerated: true,
          },
        ],
      },
    };
  }

  it("the ordinary gap's paid candidate survives the concept inspection, instead of being billed and thrown away", async () => {
    const runId = "ig_concept_mixed_pool";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);
    const copy = conceptCopy();
    const pool = goodImageCandidatePool();

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      "media.scrapeImages": stubTool("media.scrapeImages", { status: "content_fail", reason: "nothing on the open social web for this need" }),
      "image.generate": stubTool("image.generate", mixedGenerateResult(pool[1]!.path, pool[2]!.path, "concept-first")),
      "media.inspectImages": stubTool("media.inspectImages", conceptInspection()),
    });

    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept: conceptFixture(),
        copy,
        // Slide 3 is a genuine gap (nothing usable), slide 1 holds a 4.
        vet: selectionsFor(copy, pool[0]!.path, { 1: 4, 3: 1 }),
        rescueVet: {
          selections: [
            { n: 1, imagePath: pool[1]!.path, reason: "the metaphor reads", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "the declared anchor is what is in frame" },
            { n: 3, imagePath: pool[2]!.path, reason: "drawn to the brief", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 4, claimMatchReason: "shows the claimed subject" },
          ],
        },
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );
    expect(result.status).toBe("completed");

    const revet = lastVettingInput(router);
    expect(revet, "the generate tier's re-vet never ran").toBeDefined();
    // THE PREMISE: this really is the mixed rescue batch.
    expect((revet!["slides"] as Array<Record<string, unknown>>).map((s) => s["n"]).sort()).toEqual([1, 3]);

    // THE PROPERTY. Both paid candidates reach the vet that decides whether to
    // use them. Under the old `pool: [candidate]` the gap's picture was gone
    // and slide 3 could only ever take the text-only downgrade.
    const candidatePool = revet!["candidatePool"] as Array<{ path: string; description: string }>;
    expect(candidatePool.map((c) => c.path).sort()).toEqual([pool[1]!.path, pool[2]!.path].sort());

    // And the concept's candidate — and only it — carries the vision note that
    // replaced `describeGenerated`'s echo of its own brief.
    const conceptCandidate = candidatePool.find((c) => c.path === pool[1]!.path);
    expect(conceptCandidate?.description).toContain("two empty high-backed chairs");
    const gapCandidate = candidatePool.find((c) => c.path === pool[2]!.path);
    expect(gapCandidate?.description).toBe("slide 3 candidate — a small team reviewing charts");
  }, 60000);

  it("a generation that filled the gap but not the concept declines the concept instead of promoting the gap's picture to it", async () => {
    // Property (b). `unmet: [{ n: 1 }]` with a candidate for slide 3 is
    // exactly what a partial generation looks like, and it used to make
    // `tierPool[0]` the SLIDE 3 picture — inspected as the concept, given the
    // concept's vision note, and offered to slide 1 by the strictly-better
    // rule. Slide 1 holds a 4 and the vet is scripted to score the gap's
    // picture a 5 for it, so under the old code it would have taken the slot
    // and been reported as the concept SHIPPING.
    const runId = "ig_concept_partial_generation";
    await jackTrends(env);
    await allowGeneratedImages(env, runId);
    const copy = conceptCopy();
    const pool = goodImageCandidatePool();
    let inspectCalls = 0;

    const tools = testTools({
      ...env.tools,
      "media.findImages": stubTool("media.findImages", {
        status: "success",
        result: { provider: "fake", providersUsed: ["fake"], candidates: pool, unmet: [] },
      }),
      "media.scrapeImages": stubTool("media.scrapeImages", { status: "content_fail", reason: "nothing on the open social web for this need" }),
      "image.generate": stubTool("image.generate", mixedGenerateResult(pool[1]!.path, pool[2]!.path, "concept-missing")),
      // Counts only the CONCEPT inspection (`06d1` is the one caller that
      // uses `ref: "concept"`); `media.inspectImages` serves other steps in
      // this run too, and counting every call would measure those instead.
      "media.inspectImages": stubTool("media.inspectImages", conceptInspection(), (args) => {
        const images = (args as { images?: Array<{ ref?: string }> }).images ?? [];
        if (images.some((i) => i.ref === "concept")) inspectCalls += 1;
      }),
    });

    const router = fakeRouterSequence(
      conceptTurns({
        scout: conceptTrendScout(),
        research: conceptResearch(),
        angle: goodAngleProposal(),
        concept: conceptFixture(),
        copy,
        vet: selectionsFor(copy, pool[0]!.path, { 1: 4, 3: 1 }),
        rescueVet: {
          selections: [
            // The vet would happily give slide 1 the gap's picture at a 5.
            { n: 1, imagePath: pool[2]!.path, reason: "reads well enough", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "shows the claimed subject" },
            { n: 3, imagePath: pool[2]!.path, reason: "drawn to the brief", license: "Generated image", rightsUsable: true, watermarkFree: true, claimMatch: 4, claimMatchReason: "shows the claimed subject" },
          ],
        },
        relevance: goodRelevanceVerdict(),
        qa: goodVisualQaOutput(),
      }),
    );

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(
      createInstagramAgentWorkflow({ tools, promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true }),
      { ...BASE, runId, input: { conceptMode: "on" } },
    );
    expect(result.status).toBe("completed");

    // The concept frame was never generated, so it was never LOOKED AT: no
    // $0.001 vision call on a picture that is not the concept's.
    expect(inspectCalls, "an image that is not the concept's was sent to the vision inspector").toBe(0);

    const report = (await deliverableFor(env, runId))?.["conceptReport"] as ConceptReport | undefined;
    expect(report?.fired).toBe(true);
    expect(report?.shipped, "the gap's picture was reported as the concept shipping").toBe(false);
    expect(report?.declineReason ?? "").toContain("slides other than 1");

    // The gap's candidate still reached the vet — declining the concept must
    // not cost slide 3 the picture that was paid for.
    const candidatePool = lastVettingInput(router)!["candidatePool"] as Array<{ path: string }>;
    expect(candidatePool.map((c) => c.path)).toEqual([pool[2]!.path]);

    // And the re-vet was NOT told slide 1 is conceptual: there is no metaphor
    // in that pool to judge against §6.1's stricter rubric.
    const slideOne = (lastVettingInput(router)!["slides"] as Array<Record<string, unknown>>).find((s) => s["n"] === 1);
    expect(slideOne?.["conceptual"], "the vet was told to expect a metaphor that was never drawn").toBeUndefined();
  }, 60000);
});
