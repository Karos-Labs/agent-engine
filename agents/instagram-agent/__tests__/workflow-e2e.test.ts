import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
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
  copyTurnPrompts,
  goodVisualQaOutput,
  isChromiumInstalled,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { syntheticPhotograph } from "./synthetic-photograph.js";
import { SKELETON_BELIEF_KEY, readSkeletonHistory, skeletonSignature } from "../src/workflow/skeleton-memory.js";
import { CUSTOM_ARCHETYPE_BELIEF_KEY } from "../src/workflow/custom-archetype-memory.js";
import { RUN_BUDGET_BELIEF_KEY } from "../src/workflow/run-budget.js";

const params = { runId: "instagram_run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const HAPPY_PATH_STEP_IDS = [
  // Inline onboarding, ahead of the run proper.
  // 2026-09-06: the media-source pre-flight ("only what I upload" with nothing uploaded) refuses before anything is spent.
  "00a-check-media-source",
  "00-auto-setup",
  "01-open-run",
  "02-freeze-style-config",
  // Phase 1 (RFC-13 item H): the persisted Client Brief's freshness check. It
  // runs on every run; `00b1`/`00b2`/`00b3` only when the brief is missing or
  // stale, and `setupTestEnvironment` seeds a fresh one here.
  "00b-check-client-brief",
  // The client's own profile description + voice-rules guidelines,
  // best-effort — this is where a language requirement like Geektime's
  // "Hebrew-language technology site" actually lives.
  "02b-load-client-voice-context",
  // The client's Brand Kit (client/brand.json), best-effort — frozen once so
  // a portal edit mid-run can't change the tokens between attempts.
  "02c-load-brand-kit",
  // The client's declared target language (SCRUM-310/AU32) — the structured
  // `client.getBrand().language` field, frozen once and consulted by the
  // language-compliance gate at 07e/07f. Present on every run; the gate
  // itself only appears when the value is non-empty, which it is not here.
  "02d-load-target-language",
  // The client's projected branding-guidelines context doc (C1/SCRUM-209,
  // T-A9), best-effort — visual-identity rules threaded into the copy
  // prompt alongside clientVoiceContext.
  "02e-load-branding-guidelines",
  // SCRUM-242 (T-A10): the shared BLOCK/DEGRADED policy check — a real step
  // here so its own outcome is checkpointed and visible. instagram-agent's
  // row is DEGRADED; this happy-path fixture has no branding-guidelines
  // projected, so the run still completes, now carrying a visible
  // `contextGrounding` marker on its deliverable (see 02f's own comment).
  "02f-enforce-context-doc-policy",
  // IGSTYLE-3: the raw brand object (re-derivation needs it, 02c only kept
  // the derived output) and the learned style prior (inert until IGSTYLE-5).
  "02g-load-brand-kit-raw",
  "02h-learned-style-preferences",
  // Instagram Phase 0 (RFC-13 §C): the Client Brief — three C1 documents read
  // best-effort as steps of their own, then the brief itself (`derived` here:
  // no persisted brief exists in this fixture).
  "02i1-load-product-information",
  "02i2-load-target-audience",
  "02i3-load-market-strategy",
  "02i-resolve-client-brief",
  // Phase 0 cost controls (owner's rule, 2026-09-09): the run's budget plan,
  // estimated and adapted BEFORE the first paid call — never a hold.
  "02j-plan-run-budget",
  // Phase 2 (item P): the client's shipped-skeleton history, a free
  // `memory.read({ scope: "beliefs" })`. Its own step id rather than a share
  // of 02j's read, so "why did this run avoid a stat cover" is legible in the
  // trace. Inert on a first run, which this fixture is.
  "02k-read-structural-memory",
  // Phase 3 (item Q): the client's standing visual direction, checked on every
  // run against its 90-day TTL. `setupTestEnvironment` seeds a fresh one, so
  // this resolves `reuse` and `00d1`/`00d2`/`00d3` never run — the same shape
  // `00b`/`00c` already have.
  "00d-check-visual-direction",
  // Phase 4 (RFC-16 item C): the likeness/mark permit, read once per run and
  // free. It is UNCONDITIONAL — it runs on the happy path even though this
  // client has no consent record, because the fail-closed permit it resolves
  // to is what every later concept clause is judged against. A run where it
  // silently did not happen could not tell "no permission" from "never asked".
  "00e-check-likeness-consent",
  "03-claim-topic",
  // Phase 0 (RFC-13 §E): the trend scout runs on EVERY run now — also with a
  // planned catalog row, as an "alternatives" signal — then the content mode
  // rotates over the decision log and 03g selects the subject.
  "03a-load-trend-profile",
  "03b-trend-research-pull",
  "03c-trend-scout",
  "03d-select-content-mode",
  // Phase 1 (RFC-13 item I): the four other topic engines, then the
  // five-engine ranking `03g` selects from.
  "03e-topic-signals",
  "03f-rank-topic-candidates",
  "03g-select-topic",
  // Phase 1 (RFC-13 item J): `04a-research-pull` is RETIRED. Three lanes
  // (news 7d, insight 90d, the client's own domains) replace its single
  // 4-result 24-hour question, the two most source-like pages are read in
  // full, and `04b2` is the deduped set everything downstream consumes.
  "04a2-research-pull-deep",
  "04a3-fetch-primary-sources",
  "04b-research-extract-facts",
  "04b2-dedupe-fact-cards",
  // Resolves the run's template directory and which archetype files are in
  // it: materialized from the registry when one is configured, otherwise the
  // client's own templateDir probed for the bundled files. Either way a slide
  // routed to a file that is not there degrades instead of failing the run.
  "04c-resolve-templates",
  // The read side of the feedback flywheel: what this client asked for on
  // previous runs, injected into the drafting prompt.
  "04d-read-past-feedback",
  // The anti-repetition read: what this agent already shipped for this
  // client (the same excerpt window 09b writes back into).
  // 2026-09: the client's own accounts, then every channel's shipped output.
  "04e0-load-social-accounts",
  "04e-read-cross-channel-history",
  // The client's intel report, distilled into drafting context.
  "04f-read-intel-context",
  // 2026-09: the post format — a request, the client's setting, or the auto
  // rotation; `carousel` by default. (Since Phase 0 the trend scout 03a-03c
  // above runs on every run, planned row or not — see RFC-13 §E.)
  "04h-select-format",
  // IGSTYLE-3: this round's style directive (§2.2 Layer 2) — revision 0 with
  // no structured pick and no feedback resolves to `{overrides:{}, source:"none"}`
  // unconditionally, so no refusal-recording step follows it here.
  "04g-style-directive",
  "05a-list-used-images",
  // Tier 0: the client's own uploads, resolved before any sourcing tier.
  "05z-attach-user-media",
  // Phase 3 (item T): tier 0.5 — the client's own media LIBRARY, read once per
  // run after the fresh uploads and before any harvester. Present on every
  // run: an archive that is empty, unreadable or unregistered still reports
  // that it looked, because a run that skipped the read entirely could not
  // tell an empty archive from a broken one.
  "05y-read-media-library",
  // Phase 3 (item S): the run's ONE generation style and image treatment,
  // frozen before the attempt loop so every attempt, every revision and every
  // generated image inherit the identical line.
  "04k-freeze-generation-style",
  // Phase 1 (RFC-13 item K): the angle this carousel argues — one Sonnet
  // proposal per REVISION (never per attempt), then the deterministic pick.
  "04i-propose-angles",
  "04j-select-angle",
  // Phase 4 (RFC-16 item D): the concept SELECTOR — free code, unconditional,
  // immediately after the angle. `04m-design-concept` (the paid Sonnet call),
  // `04n-apply-concept` and `06d1-inspect-concept-image` correctly do NOT
  // appear here: this happy-path story has no rivalry, no reversal and no
  // recognised entity, so the selector declines and nothing downstream fires.
  // That absence is the "sometimes, not always" constraint measured on the
  // default story.
  "04l-concept-eligibility",
  "05-write-copy-attempt-1",
  "06-vet-images-attempt-1",
  // Zero-held guarantee: confirms every selected image is still on disk, so a
  // file lost since vetting degrades that slide instead of failing the render.
  "06f-verify-images-on-disk-attempt-1",
  "07-self-check-attempt-1",
  "07b-craft-hygiene-attempt-1",
  // Phase 0 (RFC-13 §C): the relevance judge — one Flash call per attempt,
  // "would a reader see how this post connects to this business?".
  "07g-relevance-attempt-1",
  // Deterministic similarity check against the shipped-output window —
  // flags and steers a redraft, never holds.
  "07d-dedupe-check-attempt-1",
  "07c-emit-slides-data-attempt-1",
  // Phase 0 (RFC-13 §D): the default render rules, checked in code before any
  // render is spent — present because this fixture's config declares no
  // render rules of its own.
  "07h-default-render-rules-attempt-1",
  // Phase 2 (item P): the cross-run variety check, deliberately PRE-RENDER so
  // a repeated skeleton costs no Chromium launch at all. Passes and consumes
  // nothing here: this fixture seeds no skeleton history.
  "07k-skeleton-variety-attempt-1",
  "08-render-carousel-attempt-1",
  // Phase 2 (item L): the visual-interest floor, measured on the rendered
  // pixels, immediately after the render and STRICTLY BEFORE `08a2` — that
  // ordering is the zero-model-call cost claim. Passes here (the fake
  // renderer reports passing metrics by default), so no `08a1b`/`08a1c`/
  // `08a1d` re-layout steps follow.
  "08a1-interest-floor-attempt-1",
  // Item P.2's within-carousel adjacency clause, re-run against the MEASURED
  // occupancy: `07k` is pre-render and has no shares to read, so without this
  // step `skeletonWarnings` was structurally always empty and never reached
  // `08b`.
  "08a1e-skeleton-occupancy-attempt-1",
  // Deterministic pre-checks (SCRUM-324/AU40) — logo presence/contrast and
  // palette-within-kit — answered in code before the model is ever asked to
  // grade composition/font-hierarchy/brand-asset-integration/colour-harmony.
  "08a2-visual-qa-pre-checks-attempt-1",
  "08b-visual-qa-attempt-1",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "09a-batch-review-r0",
  // NOTE: this list is set-equal to the happy path, so it is the one place
  // every Phase 2 step id is reconciled. `02k`, `07k` and `08a1` are above.
  // `00c*` (item N) must NOT appear: this fixture passes no `templateStore`
  // at all, so there is nowhere to store a generated template and the whole
  // studio block is skipped. `09f-auto-promote-templates` (item O) must NOT
  // appear either: it is conditional on this run having shipped a custom
  // archetype, and this fixture ships none (`auto-promote-template.test.ts`
  // is where it is asserted present).
  "09b-deliver-and-log",
];

function happyRouter() {
  return fakeRouterSequence([
    finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
    finalTurn(goodCopyOutput()),
    finalTurn(goodImageVettingOutput()),
    finalTurn(goodRelevanceVerdict()), finalTurn(goodVisualQaOutput()),
  ]);
}

/**
 * Every test below EXCEPT the Chromium-gated one uses `fakeRenderCarousel`
 * for `publish.renderCarousel` — real path-guard/missing-file validation
 * (via the tool package's own exported `validateRenderInputs`), fake
 * Chromium. This matches `packages/tools/karos-publish`'s own package
 * tests' explicit choice to keep launching a real browser out of unit tests
 * (see `test-helpers.ts`'s own doc comment on `fakeRenderCarousel`).
 */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

describe("end-to-end: the 9-step Instagram agent workflow (RFC-03)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 9 (12 sub-)steps and delivers a carousel with a matching rendered PNG count", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.slideCount).toBe(6);
    expect(result.output.renderedCount).toBe(6);
    expect(result.output.deliverableId).toBeTruthy();
    // scout + research + angle + copy + vet + relevance + QA (Phase 0: the
    // scout runs on every run and the relevance judge on every attempt; Phase
    // 1 adds the angle proposal, once per revision). No brief turn: the
    // fixture seeds a fresh persisted brief, so `00b` resolves to `reuse`.
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...HAPPY_PATH_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);

    // The reserved topic was actually committed at step 09b, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    // Six real PNG files exist at the exact repo-relative output path this
    // workflow's own `assembleSlidesData` computed (no rogue rendering path,
    // RFC-03 §2.2) — not merely claimed by the tool's return value.
    const outDir = path.join(env.repoRoot, "instagram-output", "acme", params.runId);
    for (let n = 1; n <= 6; n++) {
      const stat = await fs.stat(path.join(outDir, `slide-${n}.png`));
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    }
  }, 60000);

  // Regression test for prep job hcf9ymPGJC7mDS5pcEQ4 (client Geektime,
  // "Israel's largest Hebrew-language technology... site"): the workflow
  // never called client.getProfile/getVoiceRules at all, so no language
  // signal from either ever reached the copy-writing prompt and the post
  // shipped in English regardless of what the client's own profile said.
  it("reads the client's profile description and voice-rules guidelines, and forwards them to the copy step", async () => {
    await env.store.writeJson("acme", ["client", "profile"], {
      name: "Acme",
      description: "Acme covers enterprise software for a Spanish-speaking audience and publishes exclusively in Spanish.",
    });
    await env.store.writeJson("acme", ["client", "voice-rules"], {
      guidelines: "Direct, no corporate jargon.",
    });

    const promptStore = makePromptStore();
    // Phase 0 (item B): "publishes exclusively in Spanish" now RESOLVES the
    // target language from the profile prose (02d), so this client gets the
    // language gate — one fluency-judge turn after the relevance judge.
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()),
      finalTurn({ fluent: true, issues: [] }),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");

    const stepRecords = await durableStore.listSteps(params.runId);
    const voiceContextStep = stepRecords.find((s) => s.stepId === "02b-load-client-voice-context");
    expect(voiceContextStep?.output).toContain("publishes exclusively in Spanish");
    expect(voiceContextStep?.output).toContain("Direct, no corporate jargon.");

    // The copy-writing model call actually received it, not just the step
    // that read it — a plumbing gap between the two would look identical
    // from the step record alone.
    // Selected by SHAPE, not by call index: the copy turn moved when the
    // scout, the relevance judge and the angle proposal landed.
    const serializedInput = copyTurnPrompts(router)[0]!;
    expect(serializedInput).toContain("publishes exclusively in Spanish");
  }, 60000);

  it("grounds the drafting prompt in the synced client knowledge base, through the SAME intel-context channel", async () => {
    // The portal's knowledge sync mirrors onboarding docs and meeting
    // summaries into knowledge/*.json (flat by contract — see
    // client.getKnowledge's own doc comment). readClientIntelContext folds
    // them into the clientIntelContext string every wired agent already
    // threads, so this asserts the WHOLE path: bucket doc → tool → distill →
    // the copy model's actual prompt.
    await env.store.writeJson("acme", ["knowledge", "context-docs"], {
      syncedAt: 5,
      docs: [{ docType: "brand-voice", tier: "client", version: 2, content: "Confident, never boastful — the engineer's translator." }],
    });
    await env.store.writeJson("acme", ["knowledge", "transcripts"], {
      syncedAt: 5,
      transcripts: [{ title: "Q4 kickoff", summary: "Lead with the compliance story." }],
    });

    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");

    const stepRecords = await durableStore.listSteps(params.runId);
    const intelStep = stepRecords.find((s) => s.stepId === "04f-read-intel-context");
    expect(intelStep?.output).toContain("Confident, never boastful");
    expect(intelStep?.output).toContain("Q4 kickoff — Lead with the compliance story.");

    // And the copy-writing model call actually received it.
    // Selected by SHAPE, not by call index (see above).
    expect(copyTurnPrompts(router)[0]!).toContain("Confident, never boastful");
  }, 60000);

  it("completes normally when the client has no profile or voice rules set up yet — best-effort, never blocking", async () => {
    // Neither client/profile nor client/voice-rules exists in this env
    // (setupTestEnvironment's withConfig only seeds instagramStyleConfig/
    // instagramBrandTokens) — the step must degrade to no context, not fail.
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");

    const stepRecords = await durableStore.listSteps(params.runId);
    const voiceContextStep = stepRecords.find((s) => s.stepId === "02b-load-client-voice-context");
    expect(voiceContextStep?.status).toBe("completed");
    // `undefined` round-trips through the durable step store as `null` — the
    // step ran and found nothing, which is the correct, non-blocking outcome.
    expect(voiceContextStep?.output ?? undefined).toBeUndefined();
  }, 60000);

  it("pauses at the human batch-review gate by default, then resumes to completed on approval", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId: "instagram_run_gate" });
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("09a-batch-review");

    // Regression test for a real prep run (rWb2EutSDjHzkPnsoeEY) where a
    // reviewer approved a carousel they could not see: the gate payload
    // carried template metadata but never the drafted text or the rendered
    // images. `preview` and `images` are what the review panel actually reads.
    const pendingGate = await durableStore.getGate(first.pendingGateId);
    const payload = pendingGate?.payload as { preview?: string; images?: Array<{ n: number; url?: string }> } | undefined;
    expect(typeof payload?.preview).toBe("string");
    expect(payload?.preview!.length).toBeGreaterThan(0);
    expect(payload?.images).toBeDefined();
    expect(payload!.images!.length).toBeGreaterThan(0);
    expect(payload!.images![0]).toHaveProperty("url");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_gate", "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate("instagram_run_gate", "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });

    const second = await engine.run(workflowFn, { ...params, runId: "instagram_run_gate" });
    expect(second.status).toBe("completed");
    // scout + research + angle + copy + vet + relevance + QA: the resume replays
    // every checkpoint and spends no further model call.
    expect(router.complete).toHaveBeenCalledTimes(7);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_gate", "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["instagram-carousel"]);
  }, 60000);

  it("rejects the batch review with a reason -> held, and no deliverable ships", async () => {
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "instagram_run_gate_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "not on brand this week",
      at: new Date().toISOString(),
    });

    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // `runReviewCycle` is generic across agents, so the wording is
    // "review rejected" rather than anything carousel-specific.
    expect(result.reason).toMatch(/review rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  it("09b writes all THREE belief keys in ONE memory.updateBeliefs diff, and the gate payload carries the skeleton", async () => {
    // Green once the integrator lands WP-C5 notes (g) and (h): one
    // `memory.updateBeliefs({ diff })` carrying RUN_BUDGET_BELIEF_KEY,
    // SKELETON_BELIEF_KEY and CUSTOM_ARCHETYPE_BELIEF_KEY together, plus
    // `skeleton` on the gate payload and the deliverable.
    //
    // ONE call, not three, is the point: `updateBeliefs` shallow-merges a
    // diff, so three separate calls would each read-modify-write the same
    // document and the last writer would win. Counting the calls is the only
    // way to assert that from outside.
    const promptStore = makePromptStore();
    const router = happyRouter();
    const updates: Array<Record<string, unknown>> = [];
    const realUpdate = env.tools["memory.updateBeliefs"]!;
    const tools: AgentToolRegistry = {
      ...testTools(env),
      "memory.updateBeliefs": {
        ...realUpdate,
        async execute(args: unknown, opts: never) {
          updates.push((args as { diff: Record<string, unknown> }).diff);
          return realUpdate.execute(args, opts);
        },
      },
    };
    const workflowFn = createInstagramAgentWorkflow({
      tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "instagram_run_beliefs";
    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");

    // The gate payload answers "are we shipping the same post every week"
    // (item P.3) — the first time that is visible from the portal at all.
    const gate = await durableStore.getGate(first.pendingGateId);
    const payload = gate?.payload as { skeleton?: { signature: string; previous?: string; repeatedPrevious: boolean; recent: string[] } } | undefined;
    expect(payload?.skeleton).toBeDefined();
    expect(payload?.skeleton?.repeatedPrevious).toBe(false);
    expect(payload?.skeleton?.previous).toBeUndefined();
    expect(payload?.skeleton?.recent).toEqual([]);
    expect(payload?.skeleton?.signature).toBe(
      skeletonSignature(goodCopyOutput().slides.map((slide) => ({ n: slide.n, template: "slide.html", hasImage: true }))),
    );

    await engine.resolveGate(runId, "09a-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date().toISOString() });
    expect((await engine.run(workflowFn, { ...params, runId })).status).toBe("completed");

    const beliefUpdates = updates.filter((diff) => RUN_BUDGET_BELIEF_KEY in diff || SKELETON_BELIEF_KEY in diff || CUSTOM_ARCHETYPE_BELIEF_KEY in diff);
    expect(beliefUpdates).toHaveLength(1);
    expect(Object.keys(beliefUpdates[0]!).sort()).toEqual([CUSTOM_ARCHETYPE_BELIEF_KEY, RUN_BUDGET_BELIEF_KEY, SKELETON_BELIEF_KEY].sort());

    const beliefs = await env.store.readJson<Record<string, unknown>>("acme", ["memory", "beliefs"]);
    const history = readSkeletonHistory(beliefs);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.runId).toBe(runId);
    expect(history.entries[0]!.archetypes).toEqual(["photo", "photo", "photo", "photo", "photo", "photo"]);
    expect(history.entries[0]!.roles).toEqual(["cover", "interior", "interior", "interior", "interior", "closer"]);
    expect(history.entries[0]!.edited).toBe(false);
    expect(beliefs?.[RUN_BUDGET_BELIEF_KEY]).toBeDefined();

    // One operator-visible ledger row carries the ordered signature, so the
    // run trace answers the question without a beliefs read.
    const events = await env.store.listJson("acme", ["ledger", "events", runId]);
    // `listJson` returns `{ id, data }` wrappers, so the row itself is `.data`
    // (the same shape every other ledger assertion in this package reads).
    const skeletonEvent = events.find((e) => String((e.data as { message?: string }).message ?? "").includes(history.entries[0]!.signature));
    expect(skeletonEvent).toBeDefined();
  }, 90000);

  // Skips itself when Chromium hasn't actually been downloaded for Playwright
  // in this environment (RFC-03 §5's documented "known gap": "playwright is
  // not installed... the render step will exit 2 until this is fixed") —
  // every test above already proves this workflow's own logic end to end via
  // `fakeRenderCarousel`; this one additionally proves the REAL
  // `publish.renderCarousel` tool (real Chromium, real screenshot) slots in
  // without any change to the workflow at all, whenever a real browser
  // binary happens to be available.
  /**
   * REAL TEMPLATES AND A REAL PHOTOGRAPH, for this test only.
   *
   * Every other test in this file renders through `fakeRenderCarousel`, which
   * never opens the files — so `__tests__/fixtures/` has always held thin
   * stand-ins: a 39-line `slide.html` that is a white page with centred text,
   * and 68-byte 1x1 hero images. That was fine until item L started MEASURING
   * the pixels. Measured through the real renderer
   * (`.local/e2e-fixture-probe.mjs`, 2026-09-11), those fixtures are
   * indistinguishable from the defect the floor exists to catch:
   *
   *   fixture template            flat   occupied  emptyRect  img+dev   verdict
   *   slide.html + fixture hero  98.0%      3.4%      40.6%      1.2%   dead-space, empty, no-device, empty
   *   headline-focus.html        95.6%      6.6%      53.9%      3.0%   dead-space, empty
   *   list-takeaway.html         98.1%      2.9%      44.3%      1.3%   dead-space, empty, no-device, empty
   *
   * So `08a1` fails, `returnToCopyWith` sends the attempt back to `05` for a
   * redraft, `happyRouter()`'s queued turns run out, and the run ends
   * `degraded` — for reasons that are entirely about the fixtures and say
   * nothing about the workflow this test exists to prove. The answer is not
   * to accept `degraded` (that would delete the only end-to-end check that
   * the real renderer produces a shippable carousel) and not to queue extra
   * turns (that would assert the redraft loop rather than the wiring). It is
   * to hand this one test what a real run actually gets: the bundled
   * templates, and a hero with variety in its pixels.
   */
  async function installRealRenderFixtures(repoRoot: string): Promise<void> {
    const bundled = path.resolve(__dirname, "..", "assets", "templates", "default");
    const into = path.join(repoRoot, "fixtures", "templates");
    for (const file of (await fs.readdir(bundled)).filter((f) => f.endsWith(".html"))) {
      await fs.copyFile(path.join(bundled, file), path.join(into, file));
    }
    // The design canvas's own size — see `syntheticPhotograph` for why a
    // small image upscaled cannot stand in for a photograph here.
    const photograph = syntheticPhotograph(1080, 1440);
    const imageDir = path.join(repoRoot, "fixtures", "images");
    for (const file of (await fs.readdir(imageDir)).filter((f) => f.endsWith(".png"))) {
      await fs.writeFile(path.join(imageDir, file), photograph);
    }
  }

  it.skipIf(!isChromiumInstalled())("(real Chromium) renders and delivers using the actual publish.renderCarousel tool, unmodified", async () => {
    await installRealRenderFixtures(env.repoRoot);
    const promptStore = makePromptStore();
    const router = happyRouter();
    const workflowFn = createInstagramAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_real_chromium" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.renderedCount).toBe(6);
    // AND IT SHIPPED CLEAN. `completed` alone does not say the carousel was
    // worth shipping — item L's floor never holds a run, it marks it. This is
    // the assertion that the real renderer, the real templates and a real
    // photograph produce a post with no interest finding on it, which is the
    // whole claim the fixture rework above exists to make honest.
    expect(result.output.visualInterest, "the real-Chromium carousel shipped with an interest finding").toBeUndefined();

    const outDir = path.join(env.repoRoot, "instagram-output", "acme", "instagram_run_real_chromium");
    for (let n = 1; n <= 6; n++) {
      const stat = await fs.stat(path.join(outDir, `slide-${n}.png`));
      expect(stat.size).toBeGreaterThan(1000); // a real PNG screenshot, not the tiny 1x1 test fixture
    }
  }, 60000);
});
