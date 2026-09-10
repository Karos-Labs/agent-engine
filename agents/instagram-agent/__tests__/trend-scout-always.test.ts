import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine, parseContentModeFromSummary, type ContentMode } from "@agent-engine/workflow";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import type { InstagramTopicClaim } from "../src/workflow/types.js";
import { fakeRenderCarousel, fakeRouterSequence, goodBrandTokens, goodClientBrief, goodImageCandidatePool, goodStyleConfig, goodTrendScoutOutput, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * The trend scout runs on EVERY run (RFC-13 §E, 2026-09) — with a healthy
 * catalog, with a requested subject, with nothing planned — and
 * `03g-select-topic` decides the subject under one precedence order,
 * recording what was not chosen. `03d-select-content-mode` rotates over the
 * decision log `09b` now writes, in place of `ownShippedCount % 3`.
 *
 * Step ids are the spec's; these tests need the integrator's wiring of
 * 03a-03c (unguarded), 03d, 03g and 09b's `memory.appendDecision`.
 */

const params = { runId: "ig_scout_always", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
const ctx: AgentContext = { ...params, metadata: {} };

type SelectedTopic = InstagramTopicClaim & { mode: ContentMode; alternatives: NonNullable<InstagramTopicClaim["alternatives"]>; scoutStatus: string };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

async function runWorkflow(env: TestEnvironment, runId: string, router = fakeRouterSequence(happyTurns())) {
  // The canonical candidate pool: `happyTurns()` queues a vet turn, and the
  // workflow only asks the vet when there is a pool to judge (an empty pool
  // skips 06 entirely — see the workflow's own "empty pool" comment).
  const workflowFn = createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, autoApprove: true, imageCandidatePool: goodImageCandidatePool() });
  const durableStore = new MemoryDurableStepStore();
  const result = await new WorkflowEngine(durableStore).run(workflowFn, { ...params, runId });
  const steps = await durableStore.listSteps(runId);
  const stepIds = steps.map((s) => s.stepId);
  const selected = steps.find((s) => s.stepId === "03g-select-topic")?.output as SelectedTopic | undefined;
  const modeStep = steps.find((s) => s.stepId === "03d-select-content-mode")?.output as { mode: ContentMode; source: string } | undefined;
  return { result, steps, stepIds, selected, modeStep, router };
}

async function writeConfig(env: TestEnvironment, extra: Record<string, unknown>) {
  await env.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens(), ...extra });
}

/**
 * A persisted brief with nothing for engines 2-5 to work with: no reference
 * accounts to read, no own assets, no evergreen angles. Used by the two tests
 * whose subject is "the news pull came back with nothing" — with material in
 * the brief the scout would (correctly) run anyway.
 */
const NO_SIGNAL_BRIEF = goodClientBrief({ referenceAccounts: [], ownAssets: [], evergreenAngles: [] });

describe("03a-03c always run; 03g selects", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  it("healthy catalog: the scout runs, the row keeps the slot, and the scouted stories are recorded as alternatives", async () => {
    env = await setupTestEnvironment();
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS" });
    const { result, stepIds, selected, modeStep } = await runWorkflow(env, "ig_scout_healthy");
    expect(result.status).toBe("completed");
    for (const id of ["03-claim-topic", "03a-load-trend-profile", "03b-trend-research-pull", "03c-trend-scout", "03d-select-content-mode", "03g-select-topic"]) {
      expect(stepIds).toContain(id);
    }
    expect(selected?.source).toBe("reserved");
    expect(selected?.reservationKey).toBe("ig_scout_healthy__topic");
    expect(selected?.scoutStatus).toBe("ran");
    expect(selected?.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(selected?.alternatives.length).toBeLessThanOrEqual(3);
    expect(selected?.alternatives.every((a) => a.reason === "outranked-by-catalog")).toBe(true);
    expect(selected?.mode).toBe(modeStep?.mode);
    // The row was consumed the normal way: committed at 09, never released.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.filter((r) => r.status === "used" || r.status === "committed").length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("trendJacking 'always' + a 5/5 story: the trend takes the slot and the catalog row is released for a later run", async () => {
    env = await setupTestEnvironment();
    await writeConfig(env, { trendJacking: "always" });
    const scout = goodTrendScoutOutput();
    scout.candidates[0]!.interest = 5;
    const { result, selected } = await runWorkflow(env, "ig_scout_jack", fakeRouterSequence(happyTurns({ scout })));
    expect(result.status).toBe("completed");
    expect(selected?.source).toBe("trend");
    expect(selected?.topic).toBe(scout.candidates[0]!.topic);
    expect(selected?.reservationKey).toBeUndefined();
    expect(selected?.alternatives[0]).toMatchObject({ reason: "outranked-by-trend" });
    // `topics.release` was called: the reservation is released and every catalog row is reservable again.
    const reservation = await env.store.readJson<{ status: string }>("acme", ["topics", "reservations", "ig_scout_jack__topic"]);
    expect(reservation?.status).toBe("released");
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.every((r) => r.status === "available")).toBe(true);
  });

  it("requestedSubject with an empty catalog: the request stands, alternatives are outranked-by-request", async () => {
    env = await setupTestEnvironment({ seedTopics: [] });
    await writeConfig(env, { requestedSubject: "our new onboarding flow" });
    const { selected } = await runWorkflow(env, "ig_scout_requested");
    expect(selected?.source).toBe("requested");
    expect(selected?.topic).toBe("our new onboarding flow");
    expect(selected?.alternatives.length).toBeGreaterThan(0);
    expect(selected?.alternatives.every((a) => a.reason === "outranked-by-request")).toBe(true);
  });

  it("a typed DIRECTION is never the web query: 03b asks for the grounded subject and the scout reads the same, not the run request verbatim", async () => {
    // The audited defect (2026-09): "Create content that introduces the new
    // offer to first-time buyers" went out as the first trend query and came
    // back about first-time HOME buyers. 04a already grounds it; 03b must too.
    env = await setupTestEnvironment({ seedTopics: [] });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Karos Labs", industry: "AI marketing", description: "Karos Labs is an AI marketing agency for B2B founders." });
    const direction = "Create content that introduces the new offer to first-time buyers";
    await writeConfig(env, { requestedSubject: direction });
    const { result, steps, selected, router } = await runWorkflow(env, "ig_scout_direction");
    expect(result.status).toBe("completed");
    expect(selected?.source).toBe("requested");
    expect(selected?.topic).toBe(direction);

    const pull = steps.find((s) => s.stepId === "03b-trend-research-pull")?.output as { queries: Array<{ query: string }> } | undefined;
    expect(pull).toBeDefined();
    const queries = pull!.queries.map((q) => q.query);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries).not.toContain(direction);
    for (const q of queries) expect(q).not.toMatch(/^create content/i);
    // The request leads (most specific first), as its SUBJECT anchored in the brief.
    expect(queries[0]).toContain("the new offer to first-time buyers");
    expect(queries[0]).toContain(" in the context of ");
    expect(queries[0]!.length).toBeLessThanOrEqual(200);

    // The scout's `requestedTopic` is the same grounded subject — call 0 is 03c.
    const scoutPrompt = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(typeof scoutPrompt).toBe("string");
    const scoutInput = (JSON.parse(scoutPrompt as string) as { input: Record<string, unknown> }).input;
    expect(scoutInput["requestedTopic"]).toBe(queries[0]);
  });

  it("empty catalog + on-brand candidates: the strongest trend for this run's mode takes the slot", async () => {
    env = await setupTestEnvironment({ seedTopics: [] });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS" });
    const { result, selected, modeStep } = await runWorkflow(env, "ig_scout_trend");
    expect(result.status).toBe("completed");
    expect(selected?.source).toBe("trend");
    expect(goodTrendScoutOutput().candidates.map((c) => c.topic)).toContain(selected?.topic);
    expect(selected?.trend?.mode).toBe(modeStep?.mode);
    expect(selected?.topic).not.toMatch(/trends this week/);
  });

  it("an own-assets subject reaches the writer AS an own-assets subject, and its heading is never the research query", async () => {
    // Two doors the same defect used to walk through (RFC-13 §I): the five
    // topic engines can produce a subject with no date and no publication
    // behind it, and both the copy prompt and the research query used to
    // treat every scouted candidate as this week's news.
    env = await setupTestEnvironment({ seedTopics: [] });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS", description: "Acme sells an operations reporting platform to B2B software teams." });
    const ownAsset = {
      topic: "what our onboarding cohort data says about time to first value",
      headline: "market-strategy#Northwind cut onboarding to 3 days",
      mode: "deep-value" as const,
      engine: "own-assets" as const,
      brandFit: 5,
      interest: 5,
      brandFitReason: "the client owns the data nobody else can publish",
      angle: "the cohort data says the opposite of the sales deck",
      hook: "Three days, not three weeks.",
      whyNow: "the cohort analysis has never been published",
      sourceUrls: [],
      evidenceRefs: ["market-strategy#Northwind"],
      hasNumbers: true,
      mediaHint: "data" as const,
    };
    const { result, steps, selected, router } = await runWorkflow(
      env,
      "ig_scout_own_asset",
      fakeRouterSequence(happyTurns({ scout: { candidates: [ownAsset], skipped: [] } })),
    );
    expect(result.status).toBe("completed");
    expect(selected?.source).toBe("trend");
    expect(selected?.trend?.engine).toBe("own-assets");

    // 1. The writer is told which engine produced the subject, so prompt @13
    //    §14's "only `niche-news` may be written as news" rule can bind.
    const copyInput = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => (typeof call[0] === "string" ? (JSON.parse(call[0] as string) as { input?: Record<string, unknown> }).input : undefined))
      .find((input) => input !== undefined && "facts" in input && "styleConfig" in input)!;
    const trendCandidate = copyInput["trendCandidate"] as Record<string, unknown>;
    expect(trendCandidate["engine"]).toBe("own-assets");
    expect(trendCandidate["evidenceRefs"]).toEqual(["market-strategy#Northwind"]);
    expect(trendCandidate["whyNow"]).toBe(ownAsset.whyNow);

    // 2. And the news lane asks a question a search index can answer: the
    //    subject grounded in the client's business, not the document heading.
    const deep = steps.find((s) => s.stepId === "04a2-research-pull-deep")?.output as { lanes: Array<{ lane: string; queries: Array<{ query: string }> }> };
    const news = deep.lanes.find((l) => l.lane === "news")!;
    expect(news.queries[0]!.query).toContain(" in the context of ");
    expect(news.queries.every((q) => !q.query.includes("market-strategy#"))).toBe(true);
  });

  it("empty catalog + a scout that found nothing on-brand: a REAL fetched headline leads, never the query", async () => {
    env = await setupTestEnvironment({ seedTopics: [] });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS" });
    const { result, selected } = await runWorkflow(env, "ig_scout_research", fakeRouterSequence(happyTurns({ scout: { candidates: [], skipped: [{ headline: "x", reason: "off-brand" }] } })));
    expect(result.status).toBe("completed");
    expect(selected?.source).toBe("research");
    // The offline scraper's own document title — a headline a reader could open.
    expect(selected?.topic).toMatch(/^Offline search_web result \d+ for "/);
    expect(selected?.topic).not.toMatch(/trends this week/);
  });

  it("empty catalog + a search that returned no documents: holds honestly, and spends no model turn", async () => {
    // A brief with NO signal material (Phase 1 item I): no reference
    // accounts, no own assets, no evergreen angles. Since the five engines
    // landed, the scout runs whenever there is ANY material — a quiet news
    // week can still be named from the brief — so "nothing at all to scout"
    // now means the news pull AND the other four engines came back empty.
    // That is what this test is about, and this is how it is arranged.
    env = await setupTestEnvironment({ seedTopics: [], scraper: createOfflineScraper({ documentsPerQuery: 0 }), seedBrief: NO_SIGNAL_BRIEF });
    await env.store.writeJson("acme", ["client", "profile"], { name: "Acme", industry: "B2B SaaS" });
    const { result, router, stepIds } = await runWorkflow(env, "ig_scout_nothing");
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/^no on-brand subject this week: catalog empty, nothing requested, scout considered 0 stories/);
    expect(result.reason).toMatch(/add a catalog row or a requestedSubject/);
    expect(router.complete).not.toHaveBeenCalled();
    expect(stepIds).not.toContain("04b-research-extract-facts");
  });

  it("no scraper configured on a planned run: the scout is recorded unavailable and the row still leads — never a hold for an outage", async () => {
    // A brief with NO signal material (Phase 1 item I): no reference
    // accounts, no own assets, no evergreen angles. Since the five engines
    // landed, the scout runs whenever there is ANY material — a quiet news
    // week can still be named from the brief — so "nothing at all to scout"
    // now means the news pull AND the other four engines came back empty.
    // That is what this test is about, and this is how it is arranged.
    env = await setupTestEnvironment({ scraper: null, seedBrief: NO_SIGNAL_BRIEF });
    const { result, selected, stepIds } = await runWorkflow(env, "ig_scout_unavailable");
    expect(result.status).not.toBe("held");
    expect(selected?.source).toBe("reserved");
    expect(selected?.scoutStatus).toBe("unavailable");
    expect(selected?.alternatives).toEqual([]);
    // Topic selection completed and the run moved on to research (which, with no scraper, is a tooling failure of its own — not this gate's).
    expect(stepIds).toContain("04a2-research-pull-deep");
  });
});

describe("03d-select-content-mode rotates over the decision log 09b writes", () => {
  let env: TestEnvironment;
  afterEach(async () => {
    await env.cleanup();
  });

  it("09b appends a decision whose summary parses back to the selected mode and names the archetypes", async () => {
    env = await setupTestEnvironment();
    const { result, modeStep } = await runWorkflow(env, "ig_scout_decision");
    expect(result.status).toBe("completed");
    const read = await env.tools["memory.read"]!.execute({ scope: "decisions", limit: 10 }, { ctx: { ...ctx, runId: "ig_scout_decision" } });
    expect(read.status).toBe("success");
    const items = (read as { result: { items: Array<{ decisionId: string; summary: string }> } }).result.items;
    const decision = items.find((d) => d.decisionId === "ig_scout_decision__topic");
    expect(decision).toBeDefined();
    expect(parseContentModeFromSummary(decision!.summary)).toBe(modeStep?.mode);
    expect(decision!.summary).toMatch(/^instagram post: ".+" \(mode: [a-z-]+; source: reserved; archetypes: .+\)$/);
  });

  it("seeded (mode: deep-value) then (mode: hot-news) → open-discussion; a requestedMode wins", async () => {
    // Two full runs against the same client: the topic-floor guard would hold
    // the second at 03 with the default 6-row seed (one row used leaves 5,
    // reserving another would leave 4), so seed enough rows for both.
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `topic ${i + 1} for the mode rotation tests`) });
    const append = env.tools["memory.appendDecision"]!;
    await append.execute({ decisionId: "seed-1", summary: 'instagram post: "a" (mode: deep-value; source: reserved; archetypes: photo)' }, { ctx: { ...ctx, runId: "seed" } });
    await new Promise((r) => setTimeout(r, 5));
    await append.execute({ decisionId: "seed-2", summary: 'instagram post: "b" (mode: hot-news; source: trend; archetypes: photo)' }, { ctx: { ...ctx, runId: "seed" } });

    const rotated = await runWorkflow(env, "ig_scout_rotation");
    expect(rotated.modeStep).toMatchObject({ mode: "open-discussion", source: "rotation" });

    await writeConfig(env, { requestedMode: "hot-news" });
    const requested = await runWorkflow(env, "ig_scout_requested_mode");
    expect(requested.modeStep).toMatchObject({ mode: "hot-news", source: "requested" });
  });
});

describe("source pinning", () => {
  it("the literal `trends this week` fallback is gone from the workflow — a query is never a subject", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
    expect(source).not.toContain("trends this week");
    expect(source).not.toMatch(/ownShippedCount % CONTENT_MODES/);
  });

  it("the scout's requestedTopic is built by buildGroundedQuery, never the claimed topic verbatim", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
    expect(source).toMatch(/const requestedTopic = [^\r\n]*buildGroundedQuery\(claimedTopic, brief\)\.query/);
    expect(source).not.toMatch(/const requestedTopic = [^\r\n]*\? claimedTopic\.topic :/);
  });
});
