import { describe, expect, it, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosTopicsTools } from "@agent-engine/tool-karos-topics";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";
import { CLIP_LANE } from "../src/workflow/types.js";

/**
 * Step 01c — discovery: what the run does when nobody said what to make.
 *
 * REAL `karos-topics` over a temp `WorkspaceStore`, like `catalog-seeding.test.ts`,
 * so a passing test proves discovered topics actually reach the catalog file,
 * actually clear `LANE_FLOOR`, and are actually reserved and committed by the
 * run — not merely that a stubbed `topics.topUp` was called. `research.pull`
 * and the scout are stubbed: the research payload is canned, and the scout's
 * candidates come from the fake router, so the tests can plant a repeat and a
 * candidate with an invented evidence URL and watch the code, not the model,
 * refuse them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

const RESEARCH_DOCS = [
  { title: "Seed rounds shrank 30% this quarter", url: "https://news.example/seed-rounds", description: "Data on early-stage round sizes.", content: "Seed rounds are smaller and slower…" },
  { title: "Why founders are hiring later", url: "https://news.example/hiring-later", description: "A survey of 200 founders.", content: "The first hire is happening at month nine…" },
];

const PUBLISHED_TEXT = "The first hire is a bet on a company that will not exist in six months. Hire for the one you're becoming.\n\nAn original short arguing founders should write early roles for the company they are turning into.";

/**
 * Seven candidates. The floor is 5 and a reservation must LEAVE 5, so a lane
 * needs 6 rows for one reservation to clear; with the planted repeat dropped,
 * six survive. One is a planted REPEAT of `PUBLISHED_TEXT` — the same sentences
 * with the punctuation shuffled, the kind of reissue a model produces when it
 * ignores `recentPosts` — and one cites a URL the research never returned.
 * (A loose paraphrase is the prompt's job to avoid, not the code's; the code
 * backstop is calibrated for the near-copy.)
 */
const SCOUT_OUTPUT = {
  candidates: [
    { topic: "Seed rounds are shrinking and that is good for you", angle: "Smaller rounds force focus.", hook: "Your round got smaller. Good.", format: "original-short", whyNow: "Seed rounds shrank 30% this quarter (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: true },
    { topic: "Hire at month nine, not month one", angle: "Late hiring is a signal of discipline.", hook: "Stop hiring in month one.", format: "original-short", whyNow: "Founders are hiring later (news.example/hiring-later).", evidenceUrls: ["https://news.example/hiring-later"], voiceoverRecommended: false },
    { topic: "The first hire is a bet on a company that will not exist in six months", angle: "Hire for the one you're becoming — write early roles for the company they are turning into.", hook: "The first hire is a bet on a company that will not exist in six months.", format: "original-short", whyNow: "Founders are hiring later.", evidenceUrls: ["https://news.example/hiring-later"], voiceoverRecommended: false },
    { topic: "Runway math nobody teaches", angle: "Count months, not dollars.", hook: "You have less runway than you think.", format: "original-short", whyNow: "Smaller rounds mean shorter runways (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds", "https://invented.example/not-in-research"], voiceoverRecommended: true },
    { topic: "Why your second customer matters more than your first", angle: "Repeatability over a hero deal.", hook: "Your first customer lied to you.", format: "original-short", whyNow: "From the client's own positioning on repeatable sales.", evidenceUrls: [], voiceoverRecommended: false },
    { topic: "Pitch decks are getting shorter", angle: "Ten slides was already too many.", hook: "Cut your deck in half.", format: "original-short", whyNow: "Smaller rounds, faster decisions (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: false },
    { topic: "The advisor you pay in equity should have said no", angle: "Cheap advice is the expensive kind.", hook: "Your advisor should have said no.", format: "original-short", whyNow: "Later hiring pushes founders onto advisors (news.example/hiring-later).", evidenceUrls: ["https://news.example/hiring-later"], voiceoverRecommended: false },
  ],
  rationale: "Both research documents point at smaller, later, more disciplined early-stage company building.",
};

/** What a scout proposes the FOLLOWING week — fresh topics, so the lane can grow past the floor again. */
const SCOUT_OUTPUT_WEEK_2 = {
  candidates: [
    { topic: "Demo day is the wrong finish line", angle: "The real test is the Monday after.", hook: "Demo day is not the finish line.", format: "original-short", whyNow: "Smaller rounds mean demo day buys less (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: true },
    { topic: "Your cofounder agreement is a hiring document", angle: "Roles drift; write them down.", hook: "Your cofounder is your first hire.", format: "original-short", whyNow: "Founders are hiring later, so cofounders do more (news.example/hiring-later).", evidenceUrls: ["https://news.example/hiring-later"], voiceoverRecommended: false },
    { topic: "Bridge rounds are the new seed", angle: "Plan for two raises, not one.", hook: "Your seed round is a bridge now.", format: "original-short", whyNow: "Seed rounds shrank 30% (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: false },
    { topic: "Stop optimising the deck, fix the funnel", angle: "Investors read numbers, not slides.", hook: "Nobody funds a deck.", format: "original-short", whyNow: "Faster decisions on smaller rounds.", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: true },
    { topic: "The intern you should not hire yet", angle: "Interns cost management you do not have.", hook: "Do not hire the intern.", format: "original-short", whyNow: "Late hiring survey (news.example/hiring-later).", evidenceUrls: ["https://news.example/hiring-later"], voiceoverRecommended: false },
    { topic: "Why the accelerator wants you smaller", angle: "Programs are selecting for focus.", hook: "Small is the new signal.", format: "original-short", whyNow: "Program selection follows round size (news.example/seed-rounds).", evidenceUrls: ["https://news.example/seed-rounds"], voiceoverRecommended: false },
  ],
  rationale: "Same two documents, read a week later against what the client already covered.",
};

const GOOD_SCRIPT = {
  hook: "Your round got smaller. Good.",
  beats: [
    { narration: "Your round got smaller. Good.", onScreenText: "Smaller round, sharper company", visualBrief: "A single desk in a large empty loft, morning light, slow dolly forward.", seconds: 4 as const },
    { narration: "A small round forces you to pick one thing and prove it.", onScreenText: "Pick one thing", visualBrief: "Close-up of a hand circling one line on a printed page, shallow focus.", seconds: 6 as const },
    { narration: "That proof is what the next round is actually buying.", onScreenText: "Proof is the pitch", visualBrief: "Rain on a window over a quiet street at dusk, static wide frame.", seconds: 6 as const },
  ],
  caption: "Smaller seed rounds are a feature. They force the one proof the next round is buying.",
  about: "An original short reframing shrinking seed rounds as a forcing function for focus.",
  voiceover: false,
  voiceoverRationale: "Short, declarative beats; text carries them.",
  language: "en-US",
};

function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          } as CompletionResult<unknown>;
        }
      }
      throw new Error("smartFakeRouter: no candidate matches the requested schema");
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as ModelRouter;
}

interface Env {
  store: WorkspaceStore;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiktok-agent-discovery-"));
  return { store: new WorkspaceStore(rootDir), cleanup: () => fs.rm(rootDir, { recursive: true, force: true }) };
}

interface Harness {
  tools: AgentToolRegistry;
  calls: string[];
  researchArgs: Array<Record<string, unknown>>;
}

function buildTools(store: WorkspaceStore, opts: { research?: "serves" | "not_available" | "unregistered"; profile?: Record<string, unknown> | null; published?: string[] } = {}): Harness {
  const calls: string[] = [];
  const researchArgs: Array<Record<string, unknown>> = [];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = { verdict: "pass" as const, evidence: [], toolVersion: "1.0.0" };
  const tool = (name: string, run: (args: never) => unknown) => ({
    name,
    version: "1.0.0",
    inputSchema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      calls.push(name);
      return run(args);
    },
  });
  const published = (opts.published ?? []).map((excerpt, i) => ({ runId: `prior-${i}`, excerpt }));

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok({ tiktokClips: { sourcePool: [], guestWatchlist: [], narrowing: [] }, contentPillars: ["fundraising", "hiring"] })),
    "client.getProfile": tool("client.getProfile", () => (opts.profile === null ? { status: "not_available" as const, reason: "no profile" } : ok(opts.profile ?? { name: "Acme", industry: "startup competitions and founder programs" }))),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" } })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    ...createKarosTopicsTools(store),
    "ledger.listOutputExcerpts": tool("ledger.listOutputExcerpts", () => ok({ entries: published })),
    "ledger.recordOutputExcerpt": tool("ledger.recordOutputExcerpt", () => ok({ recorded: true, total: 1 })),
    "video.findStockClip": tool("video.findStockClip", (args) => {
      const input = args as { outputName: string; query: string };
      return ok({ path: `.media-cache/run/${input.outputName}.mp4`, pexelsId: 1, durationSeconds: 9, width: 1080, height: 1920, sourceUrl: "https://www.pexels.com/video/1/", photographer: "Someone", license: "Pexels", query: input.query });
    }),
    "video.composeSequence": tool("video.composeSequence", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 16, clipsUsed: 3, hasVoiceover: false })),
    "video.brandFrame": tool("video.brandFrame", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 16, applied: ["bars", "captions"] })),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass)),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass)),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass)),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass)),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass)),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", () => ok({ id: "deliv-1", created: true })),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
  };
  if ((opts.research ?? "serves") !== "unregistered") {
    tools["research.pull"] = tool("research.pull", (args) => {
      researchArgs.push(args as Record<string, unknown>);
      return opts.research === "not_available"
        ? { status: "not_available" as const, reason: "no scraper configured" }
        : ok({ runId: "r1", query: (args as { query: string }).query, fromCache: false, ageMs: 0, result: { provider: "test", query: "", fetchedAt: "", documents: RESEARCH_DOCS } });
    });
  }
  return { tools: tools as unknown as AgentToolRegistry, calls, researchArgs };
}

async function runWorkflow(h: Harness, runId: string, candidates: unknown[] = [SCOUT_OUTPUT, GOOD_SCRIPT]) {
  const workflow = createTikTokAgentWorkflow({
    tools: h.tools,
    promptStore: new FilePromptStore(PROMPTS_ROOT),
    router: smartFakeRouter(candidates),
    autoApprove: true,
    repoRoot: os.tmpdir(),
  });
  return new WorkflowEngine(new MemoryDurableStepStore()).run(workflow, { ...PARAMS, runId, input: {} });
}

describe("01c-discover-topics: an empty lane with no footage and no direction is filled from research, not held (and not invented)", () => {
  let env: Env;
  afterEach(async () => {
    await env.cleanup();
  });

  it("researches the client's field, seeds the lane with the scout's grounded candidates, reserves one, and ships an original short on it", async () => {
    env = await setupEnv();
    const h = buildTools(env.store, { published: [PUBLISHED_TEXT] });

    const result = await runWorkflow(h, "run-tt-discover-1");

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { topic: string; topicSource: string; format: string };
    expect(output.topicSource).toBe("discovered");
    expect(output.format).toBe("original-short");

    // The research query was built from the client's own profile and pillars.
    expect(h.researchArgs).toHaveLength(1);
    expect(String(h.researchArgs[0]!["query"])).toContain("startup competitions and founder programs");
    expect(String(h.researchArgs[0]!["query"])).toContain("fundraising");
    expect(h.researchArgs[0]!["historyAgentId"]).toBe("tiktok-agent");

    // On disk: the lane holds the candidates that SURVIVED — the planted
    // repeat of what the client recently published was dropped by code, so
    // six rows, one of them committed by this run and five still available.
    const catalog = await env.store.readJson<Array<{ topic: string; lane: string; status: string }>>("acme", ["topics", "catalog"]);
    const rows = catalog!.filter((r) => r.lane === CLIP_LANE);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.topic)).not.toContain("The first hire is a bet on a company that will not exist in six months");
    expect(rows.filter((r) => r.status === "committed").map((r) => r.topic)).toEqual([output.topic]);
    expect(rows.filter((r) => r.status === "available")).toHaveLength(5);
    expect(SCOUT_OUTPUT.candidates.map((c) => c.topic)).toContain(output.topic);
  }, 20_000);

  it("later runs draw on the seeded lane without researching, and rediscover only once the lane sinks to the floor — with that week's fresh candidates", async () => {
    env = await setupEnv();
    const h = buildTools(env.store);

    // Run a: nothing published, all seven candidates land; one is committed (6 left).
    const first = await runWorkflow(h, "run-tt-discover-a");
    // Run b: 6 -> 5 still clears the floor, so the lane serves it with NO new research.
    const second = await runWorkflow(h, "run-tt-discover-b", [GOOD_SCRIPT]);
    // Run c: a reservation that would leave 4 breaches the floor, so the run
    // discovers AGAIN — and the idempotent top-up adds only the week's new names.
    const third = await runWorkflow(h, "run-tt-discover-c", [SCOUT_OUTPUT_WEEK_2, GOOD_SCRIPT]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(third.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed" || third.status !== "completed") throw new Error("unreachable");
    const topics = [first, second, third].map((r) => (r.output as { topic: string }).topic);
    expect(new Set(topics).size).toBe(3);
    expect((second.output as { topicSource: string }).topicSource).toBe("reserved");
    expect((third.output as { topicSource: string }).topicSource).toBe("discovered");
    // Research ran for run a and run c only.
    expect(h.researchArgs).toHaveLength(2);
    const catalog = await env.store.readJson<Array<{ topic: string; lane: string; status: string }>>("acme", ["topics", "catalog"]);
    const rows = catalog!.filter((r) => r.lane === CLIP_LANE);
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.status === "committed")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "available")).toHaveLength(10);
  }, 30_000);

  it("holds honestly when rediscovery brings nothing new and the lane cannot clear its floor", async () => {
    env = await setupEnv();
    const h = buildTools(env.store);

    const first = await runWorkflow(h, "run-tt-discover-same-a");
    const second = await runWorkflow(h, "run-tt-discover-same-b", [GOOD_SCRIPT]);
    // The same seven candidates again: every one is already a row, so the
    // top-up adds nothing and the 5 remaining rows sit exactly at the floor.
    const third = await runWorkflow(h, "run-tt-discover-same-c");

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(third.status).toBe("held");
    if (third.status !== "held") throw new Error("unreachable");
    expect(third.reason).toContain("discovery could not seed it");
  }, 30_000);

  it("holds honestly when research is unavailable and the client has no intel to fall back on — nothing is invented", async () => {
    env = await setupEnv();
    const h = buildTools(env.store, { research: "not_available" });

    const result = await runWorkflow(h, "run-tt-discover-dry");

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("discovery could not seed it");
    expect(result.reason).toContain("research for discovery was unusable");
    // The scout never ran, and the lane is still empty.
    expect(h.calls).not.toContain("video.findStockClip");
    const catalog = await env.store.readJson<unknown[]>("acme", ["topics", "catalog"]);
    expect(catalog ?? []).toHaveLength(0);
  });

  it("holds when the profile declares no industry — there is no honest research query to run", async () => {
    env = await setupEnv();
    const h = buildTools(env.store, { profile: null });

    const result = await runWorkflow(h, "run-tt-discover-noindustry");

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("no industry");
    expect(h.researchArgs).toHaveLength(0);
  });
});
