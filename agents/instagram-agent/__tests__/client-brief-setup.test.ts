import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry, BaseAgentRuntime } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { BRIEF_TTL_DAYS, ClientBriefSchema, briefSegments, type ClientBrief } from "@agent-engine/tools";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import { InstagramBriefAgent } from "../src/agent/instagram-brief-agent.js";
import {
  BRIEF_AGENT_SKILL_REF,
  InstagramBriefAgentOutputSchema,
  buildBriefAgentInput,
  gatherBriefSourceUrls,
  isThinlyGrounded,
  reconcileBriefSources,
  resolveBriefFreshness,
  stampAgentBrief,
  type InstagramBriefAgentOutput,
} from "../src/workflow/client-brief.js";
import {
  PROMPTS_ROOT,
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodBrandTokens,
  goodClientBrief,
  goodImageCandidatePool,
  goodStyleConfig,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { happyTurns } from "./turns.js";

/**
 * Instagram Phase 1 item H: the PERSISTED Client Brief.
 *
 * Phase 0 shipped a deterministic brief (copied from onboarding data, never
 * judged, `confidence: "low"`) so the grounding gate had something to ground
 * against on a client's first run. This is its replacement: a setup-style
 * Sonnet agent (`instagram-brief@1`) that reads the same data plus the
 * client's own site and recent posts and writes one document
 * (`clients/<slug>/brief/instagram-brief.json`) that a month of runs is
 * grounded on, through the registry's single writer, `client.writeBrief`.
 *
 * What this file covers, and what it deliberately does not:
 *
 * - the lifecycle decision (`resolveBriefFreshness`), the source bundle the
 *   agent is given (`buildBriefAgentInput`), the URL set read off the profile
 *   (`gatherBriefSourceUrls`) and the stamping of the agent's answer
 *   (`stampAgentBrief`) — pure, so tested as such;
 * - the agent's own configuration and prompt pins;
 * - the round trip through the real tools: stamp, `client.writeBrief`,
 *   `client.getBrief`;
 * - the DROP-IN property, through the real workflow: a persisted brief on
 *   disk makes `02i-resolve-client-brief` report `persisted` and puts the
 *   agent-written positioning into the copy prompt, with no workflow change
 *   at all. That is the property Phase 0 designed for and the one thing that
 *   could silently not hold.
 * - the `00b*` steps themselves are wired by the integrator (this work
 *   package owns no workflow file). The suite at the bottom asserts them and
 *   activates itself the moment those step ids appear in the workflow source;
 *   the test above it proves that detection actually works, so the gate
 *   cannot pass by looking at the wrong file.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

const DAY_MS = 86_400_000;

const ACME_PROFILE = {
  name: "Acme Content",
  industry: "content marketing",
  website: "acme.test",
  description: "Acme runs the weekly content pipeline for B2B founders who have no marketing team yet. A human editor approves every post.",
};

/** The brief agent's own output: the brief minus the five fields the engine stamps. */
function briefAgentOutput(overrides: Partial<InstagramBriefAgentOutput> = {}): InstagramBriefAgentOutput {
  const { version: _v, channel: _c, generatedAt: _g, generatedBy: _b, agentSkillRef: _s, ...rest } = goodClientBrief();
  return { ...rest, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. The lifecycle decision
// ─────────────────────────────────────────────────────────────────────────

describe("resolveBriefFreshness — when the brief agent runs", () => {
  const now = new Date("2026-09-10T12:00:00.000Z");
  const agentBriefAt = (daysAgo: number): ClientBrief => goodClientBrief({ generatedAt: new Date(now.getTime() - daysAgo * DAY_MS).toISOString() });

  it("no brief at all is a create", () => {
    const decision = resolveBriefFreshness(undefined, now, false);
    expect(decision.action).toBe("create");
    expect(decision.ageDays).toBeUndefined();
    expect(decision.reason).toMatch(/no persisted instagram brief/);
  });

  it("a fresh agent brief is reused, and the age is reported", () => {
    const decision = resolveBriefFreshness(agentBriefAt(3), now, false);
    expect(decision.action).toBe("reuse");
    expect(decision.ageDays).toBe(3);
    expect(decision.reason).toContain("inside the 30-day TTL");
  });

  it("the TTL boundary: 30 days old is reused, 31 is refreshed", () => {
    expect(BRIEF_TTL_DAYS).toBe(30);
    expect(resolveBriefFreshness(agentBriefAt(30), now, false).action).toBe("reuse");
    const stale = resolveBriefFreshness(agentBriefAt(31), now, false);
    expect(stale.action).toBe("refresh");
    expect(stale.reason).toContain("31 day(s) old");
  });

  it("a deterministic brief is always refreshed: it is Phase 0's stand-in, not a written document", () => {
    const decision = resolveBriefFreshness(goodClientBrief({ generatedBy: "deterministic", generatedAt: now.toISOString(), confidence: "low" }), now, false);
    expect(decision.action).toBe("refresh");
    expect(decision.reason).toMatch(/derived deterministically/);
  });

  it("wf.input.refreshBrief refreshes a brief that is otherwise fresh", () => {
    const decision = resolveBriefFreshness(agentBriefAt(1), now, true);
    expect(decision.action).toBe("refresh");
    expect(decision.reason).toMatch(/refreshBrief/);
  });

  it("a human-authored brief is NEVER refreshed — not by the TTL, and not by an explicit refresh request", () => {
    for (const [ageDays, refreshRequested] of [
      [1, false],
      [400, false],
      [1, true],
      [400, true],
    ] as const) {
      const human = goodClientBrief({ generatedBy: "human", generatedAt: new Date(now.getTime() - ageDays * DAY_MS).toISOString() });
      const decision = resolveBriefFreshness(human, now, refreshRequested);
      expect(decision.action, `age ${ageDays}, refreshRequested ${refreshRequested}`).toBe("reuse");
      expect(decision.reason).toMatch(/authored by a human/);
      expect(decision.reason).toMatch(/portal/);
    }
  });

  it("an undatable generatedAt refreshes rather than being trusted", () => {
    const decision = resolveBriefFreshness(goodClientBrief({ generatedAt: "the day before yesterday" }), now, false);
    expect(decision.action).toBe("refresh");
    expect(Number.isNaN(decision.ageDays)).toBe(true);
    expect(decision.reason).toMatch(/cannot be read as a date/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. What the agent reads
// ─────────────────────────────────────────────────────────────────────────

describe("gatherBriefSourceUrls — the client's own pages", () => {
  it("normalises a bare host and hangs about/pricing off it", () => {
    expect(gatherBriefSourceUrls({ website: "acme.test" })).toEqual(["https://acme.test", "https://acme.test/about", "https://acme.test/pricing"]);
  });

  it("keeps an https URL's own path and drops a trailing slash, so the same site is never fetched twice", () => {
    expect(gatherBriefSourceUrls({ website: "https://acme.test/" })).toEqual(["https://acme.test", "https://acme.test/about", "https://acme.test/pricing"]);
    expect(gatherBriefSourceUrls({ website: "https://host.test/acme/" })).toEqual(["https://host.test/acme", "https://host.test/acme/about", "https://host.test/acme/pricing"]);
  });

  it("is empty for a client with no website, and for one whose website field is not a URL", () => {
    expect(gatherBriefSourceUrls(undefined)).toEqual([]);
    expect(gatherBriefSourceUrls({})).toEqual([]);
    expect(gatherBriefSourceUrls({ website: "   " })).toEqual([]);
    expect(gatherBriefSourceUrls({ website: "not a url at all" })).toEqual([]);
  });

  it("never exceeds research.fetchPages' four-URL cap", () => {
    expect(gatherBriefSourceUrls({ website: "https://acme.test" }).length).toBeLessThanOrEqual(4);
  });
});

describe("buildBriefAgentInput — present sources, named gaps, bounded prompt", () => {
  it("records every present source and names every missing one as a gap", () => {
    const built = buildBriefAgentInput({
      profile: ACME_PROFILE,
      brand: { tagline: "Weekly, not whenever" },
      voiceRules: { tone: "direct", doList: ["say what it costs"], dontList: ["guarantee results"] },
      contextDocs: { "product-information": "# Plans\n\nStarter plan: fixed price for one channel.", "target-audience": undefined, "market-strategy": "" },
      sitePages: [{ url: "https://acme.test/about", title: "About", text: "We run the weekly pipeline." }],
      ownPosts: [{ platform: "instagram", username: "acme", url: "https://instagram.com/p/1", excerpt: "A weekly cadence beats a launch burst." }],
      forbiddenTopics: ["politics"],
      targetLanguage: "English",
    });

    const refs = built.presentSources.map((s) => `${s.kind}:${s.ref}`);
    expect(refs).toContain("profile:client.getProfile");
    expect(refs).toContain("brand:client.getBrand");
    expect(refs).toContain("voice-rules:client.getVoiceRules");
    expect(refs).toContain("context-doc:product-information");
    expect(refs).toContain("site:https://acme.test/about");
    expect(refs).toContain("social-history:instagram/@acme");
    // Absent and empty documents are both gaps, and neither reaches the model
    // as an empty string that reads like a document with nothing in it.
    expect(built.gaps.some((g) => g.includes("target-audience"))).toBe(true);
    expect(built.gaps.some((g) => g.includes("market-strategy"))).toBe(true);
    expect(built.input.contextDocs.map((d) => d.docType)).toEqual(["product-information"]);
    expect(built.input.forbiddenTopics).toEqual(["politics"]);
    expect(built.input.targetLanguage).toBe("English");
    // The model is told what could not be read, so it lists the same
    // shortfalls in its own `gaps` instead of inventing around them.
    expect(built.input.missingSources).toEqual(built.gaps);
  });

  it("names the shortfall when the site and the client's own posts could not be read, and threads the gather step's own problems through", () => {
    const built = buildBriefAgentInput({
      profile: ACME_PROFILE,
      contextDocs: {},
      problems: ["could not read https://acme.test/pricing: 403 from the origin"],
    });
    expect(built.gaps.some((g) => g.includes("own site could not be read"))).toBe(true);
    expect(built.gaps.some((g) => g.includes("no recent posts"))).toBe(true);
    expect(built.gaps).toContain("could not read https://acme.test/pricing: 403 from the origin");
    expect(built.input.sitePages).toEqual([]);
    expect(built.input.ownPosts).toEqual([]);
  });

  it("bounds what reaches the prompt: documents and pages are truncated with a marker, and at most twelve posts travel", () => {
    const built = buildBriefAgentInput({
      profile: { ...ACME_PROFILE, description: "d".repeat(9000) },
      contextDocs: { "product-information": `# Plans\n\n${"p".repeat(9000)}` },
      sitePages: [{ url: "https://acme.test", text: "s".repeat(9000) }],
      ownPosts: Array.from({ length: 20 }, (_, i) => ({ platform: "x", username: "acme", url: `https://x.com/acme/${i}`, excerpt: `post ${i}` })),
    });

    expect(built.input.profile!.description!).toMatch(/\[truncated at 6000 characters\]/);
    const doc = built.input.contextDocs[0]!.markdown;
    expect(doc).toMatch(/\[truncated at 6000 characters\]/);
    // Markdown structure survives the clamp: the model reads headings.
    expect(doc.startsWith("# Plans")).toBe(true);
    expect(built.input.sitePages[0]!.text).toMatch(/\[truncated at 4000 characters\]/);
    expect(built.input.ownPosts).toHaveLength(12);
  });

  it("a client with nothing but a profile still produces an input, with every gap named", () => {
    const built = buildBriefAgentInput({ profile: { industry: "content marketing" }, contextDocs: {} });
    expect(built.gaps.length).toBeGreaterThanOrEqual(3);
    expect(built.input.contextDocs).toEqual([]);
    expect(built.input.knowledgeTitles).toEqual([]);
    expect(built.presentSources).toEqual([{ kind: "profile", ref: "client.getProfile" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Stamping and persisting
// ─────────────────────────────────────────────────────────────────────────

describe("stampAgentBrief + client.writeBrief — the agent's answer becomes the stored document", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment({ seedTopics: [] });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("stamps version, channel, generatedBy and the skillRef, and overrides the model's language.target with the resolved one", () => {
    const { brief: stamped, sourceNotes } = stampAgentBrief(briefAgentOutput({ language: { target: "Spanish", register: "warm" } }), { targetLanguage: "Hebrew" });
    expect(stamped.version).toBe(1);
    expect(stamped.channel).toBe("instagram");
    expect(stamped.generatedBy).toBe("agent");
    expect(stamped.agentSkillRef).toBe(BRIEF_AGENT_SKILL_REF);
    // 02d resolved the target language with a documented precedence; a brief
    // that disagreed would send the writer and the language gate to two
    // different languages. The register is still the model's.
    expect(stamped.language).toEqual({ target: "Hebrew", register: "warm" });
    expect("generatedAt" in stamped).toBe(false);
    // No `presentSources` supplied: nothing to reconcile against, so the
    // model's own list stands and there is nothing to report.
    expect(stamped.sources).toEqual(briefAgentOutput().sources);
    expect(sourceNotes).toEqual([]);
  });

  it("keeps the model's own language.target when the run resolved none", () => {
    const { brief: stamped } = stampAgentBrief(briefAgentOutput({ language: { target: "Hebrew" } }), { targetLanguage: undefined });
    expect(stamped.language.target).toBe("Hebrew");
  });

  it("reconciles the model's `sources` against what the gather step actually read, so the relevance floor is the engine's to set", () => {
    // The lever this closes: `isThinlyGrounded` reads `sources` alone, and
    // `relevanceFloor` drops the passing score from 3/5 to 2/5 for a brief
    // that names no product-information document, no target-audience
    // document and no page of the client's own site. A model that
    // under-reports what it read would therefore lower its own gate.
    const present = buildBriefAgentInput({
      profile: ACME_PROFILE,
      voiceRules: { tone: "direct" },
      contextDocs: { "product-information": "# Plans\n\nStarter plan: fixed price for one channel." },
      sitePages: [{ url: "https://acme.test/about", text: "We run the weekly pipeline." }],
    }).presentSources;

    const underReported = stampAgentBrief(
      briefAgentOutput({
        sources: [
          { kind: "profile", ref: "profile" },
          { kind: "voice-rules", ref: "client.getVoiceRules" },
        ],
      }),
      { presentSources: present },
    );
    const refs = underReported.brief.sources.map((s) => `${s.kind}:${s.ref}`);
    // The two grounding-bearing rows the run really read are stamped in ...
    expect(refs).toContain("context-doc:product-information");
    expect(refs).toContain("site:https://acme.test/about");
    // ... the model's own claims survive, canonicalised to the engine's ref ...
    expect(refs).toContain("profile:client.getProfile");
    expect(refs).toContain("voice-rules:client.getVoiceRules");
    // ... and the floor is the normal one, whatever the brief claimed.
    expect(isThinlyGrounded({ ...goodClientBrief(), sources: underReported.brief.sources })).toBe(false);
    expect(underReported.sourceNotes.join(" ")).toMatch(/added 2 grounding source\(s\)/);

    // The other direction: a row nobody supplied cannot buy grounding. A
    // brief claiming a target-audience document and a site page that this
    // run never read keeps neither, and stays thin.
    const overClaimed = stampAgentBrief(
      briefAgentOutput({
        sources: [
          { kind: "profile", ref: "client.getProfile" },
          { kind: "context-doc", ref: "target-audience" },
          { kind: "site", ref: "https://acme.test/imagined" },
        ],
      }),
      { presentSources: [{ kind: "profile", ref: "client.getProfile" }] },
    );
    expect(overClaimed.brief.sources).toEqual([{ kind: "profile", ref: "client.getProfile" }]);
    expect(isThinlyGrounded({ ...goodClientBrief(), sources: overClaimed.brief.sources })).toBe(true);
    expect(overClaimed.sourceNotes.join(" ")).toMatch(/dropped 2 source\(s\).*target-audience/);
  });

  it("reconcileBriefSources keeps the model's order, never duplicates a row, and reports nothing when the list was right", () => {
    const present = [
      { kind: "profile", ref: "client.getProfile" },
      { kind: "context-doc", ref: "product-information" },
      { kind: "site", ref: "https://acme.test" },
    ] as const;
    const exact = reconcileBriefSources([...present], [...present]);
    expect(exact.sources).toEqual([...present]);
    expect(exact.notes).toEqual([]);

    // The engine's union pass must not re-add a row the model already
    // claimed, even when the model listed it twice or wrote it differently.
    const duplicated = reconcileBriefSources(
      [
        { kind: "site", ref: "https://acme.test/" },
        { kind: "site", ref: "https://acme.test" },
        { kind: "profile", ref: "client.getProfile" },
      ],
      [...present],
    );
    expect(duplicated.sources).toEqual([
      { kind: "site", ref: "https://acme.test" },
      { kind: "profile", ref: "client.getProfile" },
      { kind: "context-doc", ref: "product-information" },
    ]);
    expect(duplicated.notes).toHaveLength(1);
    expect(duplicated.notes[0]).toMatch(/added 1 grounding source/);

    // A non-grounding row the run supplied is NOT unioned in: the engine
    // stamps what the floor turns on, and leaves the rest of the audit trail
    // to the writer.
    const unclaimed = reconcileBriefSources([{ kind: "profile", ref: "client.getProfile" }], [...present, { kind: "brand", ref: "client.getBrand" }]);
    expect(unclaimed.sources.map((s) => s.kind)).toEqual(["profile", "context-doc", "site"]);
  });

  it("a claim written in the model's own words still matches the source it was given", () => {
    const present = buildBriefAgentInput({
      profile: ACME_PROFILE,
      knowledge: { assets: [{ name: "Q3 cohort analysis" }] } as never,
      contextDocs: {},
      ownPosts: [{ platform: "instagram", username: "acme", url: "https://instagram.com/p/1", excerpt: "A weekly cadence beats a launch burst." }],
    }).presentSources;
    const stamped = stampAgentBrief(
      briefAgentOutput({
        sources: [
          { kind: "knowledge", ref: "knowledge base" },
          { kind: "social-history", ref: "@acme" },
        ],
      }),
      { presentSources: present },
    );
    // Neither row is dropped over a spelling: a singleton kind matches by
    // kind, a ref-bearing kind by containment, and both are canonicalised.
    expect(stamped.brief.sources.map((s) => `${s.kind}:${s.ref}`)).toEqual(["knowledge:client.getKnowledge", "social-history:instagram/@acme"]);
    expect(stamped.sourceNotes).toEqual([]);
  });

  it("writes through client.writeBrief and reads back through client.getBrief as a fresh agent brief", async () => {
    const { brief: payload } = stampAgentBrief(briefAgentOutput(), { targetLanguage: "English" });
    const write = await env.tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload }, { ctx });
    expect(write.status).toBe("success");

    const read = await env.tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(read.status).toBe("success");
    const result = (read as { result: { brief: ClientBrief; ageDays: number } }).result;
    expect(result.ageDays).toBe(0);
    expect(result.brief.generatedBy).toBe("agent");
    expect(result.brief.agentSkillRef).toBe(BRIEF_AGENT_SKILL_REF);
    expect(result.brief.positioning.oneLiner).toBe(payload.positioning.oneLiner);
    // And the lifecycle then reuses it, which is the whole point of writing it.
    expect(resolveBriefFreshness(result.brief, new Date(), false).action).toBe("reuse");
  });

  it("research.fetchPages is available to the gather step through the same registry", async () => {
    expect(env.tools["research.fetchPages"]).toBeDefined();
    const outcome = await env.tools["research.fetchPages"]!.execute({ urls: gatherBriefSourceUrls(ACME_PROFILE) }, { ctx });
    expect(outcome.status).toBe("success");
    const pages = (outcome as { result: { pages: Array<{ url: string; text: string }> } }).result.pages;
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.url)).toEqual(["https://acme.test", "https://acme.test/about", "https://acme.test/pricing"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. The agent and its prompt
// ─────────────────────────────────────────────────────────────────────────

describe("InstagramBriefAgent / instagram-brief@1", () => {
  it("is a single-turn, tool-free Sonnet step pinned to instagram-brief@1", () => {
    const agent = new InstagramBriefAgent({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() });
    const config = (agent as unknown as { config: { id: string; skillRef: string; allowedTools: string[]; maxSteps?: number; modelPolicy: { policy: string; model: string; contentLanguageSensitive?: boolean } } }).config;
    expect(config.id).toBe("instagram-brief");
    expect(config.skillRef).toBe(BRIEF_AGENT_SKILL_REF);
    expect(config.allowedTools).toEqual([]);
    expect(config.maxSteps).toBe(1);
    // No Opus anywhere in an Instagram run (owner's binding decision); Sonnet
    // because this one document grounds a month of runs, in the client's own
    // language.
    expect(config.modelPolicy.policy).toBe("pinned");
    expect(config.modelPolicy.model).toBe("claude-sonnet-4-6");
    expect(config.modelPolicy.contentLanguageSensitive).toBe(true);
  });

  it("resolves prompts/instagram-brief/1.md, latest.md is byte-identical, and the H1 says v1", async () => {
    const promptStore = makePromptStore();
    const v1 = await promptStore.getPrompt("instagram-brief", "1");
    expect(await promptStore.getPrompt("instagram-brief")).toBe(v1);
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-brief", "1.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, "instagram-brief", "latest.md"), "utf8"));
    expect(v1.split(/\r?\n/)[0]).toBe("# Instagram Client Brief Craft Guide, v1");
  });

  it("the prompt carries the rules item H requires of it", async () => {
    const v1 = await makePromptStore().getPrompt("instagram-brief", "1");
    // Only from the sources, and cite them.
    expect(v1).toContain("## 2. Never invent");
    expect(v1).toMatch(/Do not invent an offer, a claim, a number/);
    expect(v1).toContain("`sources`");
    // The client's positioning, never the market's.
    expect(v1).toContain("Competitors go NOWHERE in this document");
    // Reference accounts: 3 to 7, four readable platforms, a real `why`, never invented.
    expect(v1).toMatch(/`referenceAccounts`: 3 to 7/);
    expect(v1).toContain("`platform` is one of `x`, `instagram`, `reddit`, `tiktok`");
    expect(v1).toMatch(/A handle must appear in the sources/);
    // Ungrounded is a gap.
    expect(v1).toMatch(/`gaps`: every shortfall/);
    // The resolved target language wins.
    expect(v1).toMatch(/when `targetLanguage` is supplied, it is `language\.target`/);
    // The prompt obeys the punctuation rule it states (the instagram-copy@3
    // lesson: the model imitates the register of its instructions).
    expect(v1).toContain("without em dashes or en dashes");
    expect(v1).not.toMatch(/[—–]/);
  });

  it("passes the resolved prompt as its system prompt and returns a validated brief body", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(briefAgentOutput())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const result = await new InstagramBriefAgent(runtime).run(ctx, buildBriefAgentInput({ profile: ACME_PROFILE, contextDocs: {} }).input);

    expect(result.status).toBe("completed");
    expect(result.finalOutput!.positioning.oneLiner.length).toBeGreaterThan(0);
    const expected = readFileSync(path.join(PROMPTS_ROOT, "instagram-brief", "1.md"), "utf8");
    const opts = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as { system?: string };
    expect(opts.system?.startsWith(`${expected}\n\n`)).toBe(true);
  });

  it("a malformed answer is a content_fail at the agent, never a half-valid brief", async () => {
    const promptStore = makePromptStore();
    // A LinkedIn reference account: a row nothing in this engine could read,
    // which the schema refuses rather than letting it look useful.
    const router = fakeRouterSequence([finalTurn(briefAgentOutput({ referenceAccounts: [{ platform: "linkedin", handle: "acme", why: "peers" }] as never }))]);
    const result = await new InstagramBriefAgent({ router, tools: {}, promptStore }).run(ctx, { channel: "instagram" });
    expect(result.status).toBe("content_fail");
  });

  it("the output schema omits exactly the five fields the engine stamps, and nothing else", () => {
    const output = InstagramBriefAgentOutputSchema.parse(briefAgentOutput());
    for (const stamped of ["version", "channel", "generatedAt", "generatedBy", "agentSkillRef"]) {
      expect(stamped in output).toBe(false);
    }
    // Everything else the schema requires is still the model's to fill.
    for (const own of ["positioning", "icp", "coreTerms", "forbidden", "language", "confidence", "sources", "gaps"]) {
      expect(own in output).toBe(true);
    }
    // A model cannot date its own brief: the field is not in its schema, and a
    // supplied one is stripped.
    const smuggled = InstagramBriefAgentOutputSchema.parse({ ...briefAgentOutput(), generatedAt: new Date(Date.now() + 400 * DAY_MS).toISOString() });
    expect("generatedAt" in smuggled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. The drop-in property, through the real workflow
// ─────────────────────────────────────────────────────────────────────────

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/** Every prompt the fake router saw, parsed back to the `input` object the workflow assembled. */
function turnInputs(router: ReturnType<typeof fakeRouterSequence>): Array<Record<string, unknown>> {
  const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
  const inputs: Array<Record<string, unknown>> = [];
  for (const call of complete.mock.calls) {
    const promptArg = call[0];
    if (typeof promptArg !== "string") continue;
    try {
      const parsed = JSON.parse(promptArg) as { input?: Record<string, unknown> };
      if (parsed.input && typeof parsed.input === "object") inputs.push(parsed.input);
    } catch {
      // not a JSON prompt (never the case for BaseAgent calls, but be safe)
    }
  }
  return inputs;
}

const copyInputs = (router: ReturnType<typeof fakeRouterSequence>): Array<Record<string, unknown>> =>
  turnInputs(router).filter((i) => "facts" in i && "styleConfig" in i);

describe("02i-resolve-client-brief — a persisted brief is a drop-in for the derived one", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment({ seedBrief: goodClientBrief() });
    await env.store.writeJson("acme", ["client", "config"], {
      instagramStyleConfig: goodStyleConfig(),
      instagramBrandTokens: goodBrandTokens(),
    });
    await env.store.writeJson("acme", ["client", "profile"], ACME_PROFILE);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reports source persisted, and the agent-written positioning is what the copy prompt reads", async () => {
    const router = fakeRouterSequence(happyTurns());
    const params = { runId: "instagram_run_brief_persisted", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: testTools(env),
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
      }),
      params,
    );
    expect(result.status).toBe("completed");

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief; source: string; notes: string[] } };
    expect(briefStep.output.source).toBe("persisted");
    expect(briefStep.output.brief.generatedBy).toBe("agent");
    expect(briefStep.output.brief.agentSkillRef).toBe(BRIEF_AGENT_SKILL_REF);
    expect(briefStep.output.notes).toEqual([]);
    // The stored document still parses as what every consumer reads.
    expect(ClientBriefSchema.safeParse(briefStep.output.brief).success).toBe(true);

    const copy = copyInputs(router);
    expect(copy.length).toBeGreaterThan(0);
    const clientBrief = copy[0]!["clientBrief"] as string;
    // Written by the agent, and richer than anything the deterministic
    // derivation could produce from the same profile: a real ICP, a named
    // offer, a register.
    expect(clientBrief).toContain("written by agent");
    expect(clientBrief).toContain("Acme runs the weekly content pipeline for B2B founders");
    expect(clientBrief).toContain("First month audit");
    expect(clientBrief).toContain("Founders and heads of marketing");
    expect(clientBrief).not.toContain("confidence low");
  });

  it("a stale persisted brief is not trusted: the run falls back to the derived one and says why", async () => {
    await env.store.writeJson("acme", briefSegments("instagram"), goodClientBrief({ generatedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() }));

    // A stale brief REFRESHES, so this run spends a brief turn — and this one
    // is refused by the agent's own schema (`coreTerms` may not be empty), which
    // is what leaves `02i` on the derived brief the assertions below are about.
    const router = fakeRouterSequence([finalTurn({ ...briefAgentOutput(), coreTerms: [] }), ...happyTurns()]);
    const params = { runId: "instagram_run_brief_stale", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true }),
      params,
    );
    expect(result.status).toBe("completed");

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief; source: string; notes: string[] } };
    expect(briefStep.output.source).toBe("derived");
    expect(briefStep.output.brief.generatedBy).toBe("deterministic");
    expect(briefStep.output.notes.join(" ")).toMatch(/stale/);
    // 31 days, not 30: the reviewer can see which side of the TTL it fell on.
    expect(briefStep.output.notes.join(" ")).toContain("31 day(s) old");
  });

  it("a human-authored brief is used as-is, and the lifecycle would never overwrite it", async () => {
    const human = goodClientBrief({ generatedBy: "human", agentSkillRef: undefined, positioning: { oneLiner: "The line the client's own marketer wrote.", whatWeSell: "What they say they sell.", differentiators: [] } });
    await env.store.writeJson("acme", briefSegments("instagram"), human);

    const router = fakeRouterSequence(happyTurns());
    const params = { runId: "instagram_run_brief_human", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true }),
      params,
    );
    expect(result.status).toBe("completed");

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { brief: ClientBrief; source: string } };
    expect(briefStep.output.source).toBe("persisted");
    expect(briefStep.output.brief.generatedBy).toBe("human");
    expect(copyInputs(router)[0]!["clientBrief"] as string).toContain("The line the client's own marketer wrote.");

    // And the writer refuses to replace it, which is what makes the portal
    // edit permanent rather than something the 30-day refresh reverts.
    const write = await env.tools["client.writeBrief"]!.execute({ channel: "instagram", brief: stampAgentBrief(briefAgentOutput(), {}).brief }, { ctx });
    expect(write.status).toBe("content_fail");
    expect((await env.store.readJson<ClientBrief>("acme", briefSegments("instagram")))!.positioning.oneLiner).toBe(human.positioning.oneLiner);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. The 00b* lifecycle steps — wired by the integrator (see this work
// package's integration notes). Everything above is independent of that
// wiring; this suite activates itself when the step ids appear.
// ─────────────────────────────────────────────────────────────────────────

const WORKFLOW_SOURCE = readFileSync(path.join(import.meta.dirname, "..", "src", "workflow", "create-instagram-agent-workflow.ts"), "utf8");
const BRIEF_LIFECYCLE_WIRED = WORKFLOW_SOURCE.includes('"00b-check-client-brief"');

describe("the brief lifecycle's wiring", () => {
  /**
   * The premise of the skip below, asserted rather than assumed: this really
   * is the workflow source, and step ids really do appear in it as quoted
   * literals. Without this, a renamed file or a changed step-id style would
   * turn the suite below into one that silently never runs.
   */
  it("the step-id scan reads the real workflow source", () => {
    expect(WORKFLOW_SOURCE.length).toBeGreaterThan(10_000);
    expect(WORKFLOW_SOURCE).toContain('"02i-resolve-client-brief"');
    expect(WORKFLOW_SOURCE).toContain('"01-open-run"');
  });
});

describe.skipIf(!BRIEF_LIFECYCLE_WIRED)("00b* — check, gather, write, persist", () => {
  let env: TestEnvironment;

  async function seedClient(seedBrief: ClientBrief | false): Promise<TestEnvironment> {
    // `seedBrief: false` is passed EXPLICITLY: since the 00b* wiring landed,
    // omitting the option seeds a fresh brief (so the ~30 other fixtures need
    // no brief turn), and this suite's whole subject is the create path.
    const created = await setupTestEnvironment({ seedBrief });
    await created.store.writeJson("acme", ["client", "config"], { instagramStyleConfig: goodStyleConfig(), instagramBrandTokens: goodBrandTokens() });
    await created.store.writeJson("acme", ["client", "profile"], ACME_PROFILE);
    return created;
  }

  afterEach(async () => {
    await env?.cleanup();
  });

  function runWith(router: ReturnType<typeof fakeRouterSequence>, runId: string, input?: Record<string, unknown>) {
    const params = { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const, ...(input ? { input } : {}) };
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    return {
      params,
      durableStore,
      result: engine.run(
        createInstagramAgentWorkflow({ tools: testTools(env), promptStore: makePromptStore(), router, repoRoot: env.repoRoot, imageCandidatePool: goodImageCandidatePool(), autoApprove: true }),
        params,
      ),
    };
  }

  it("with no brief on disk: 00b resolves to create, the brief agent's turn is consumed, the file is written and 02i reports persisted", async () => {
    env = await seedClient(false);
    const router = fakeRouterSequence([finalTurn(briefAgentOutput()), ...happyTurns()]);
    const { params, durableStore, result } = runWith(router, "instagram_run_brief_create");
    expect((await result).status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("00b-check-client-brief");
    expect(stepIds).toContain("00b1-gather-brief-sources");
    expect(stepIds).toContain("00b2-write-client-brief");
    expect(stepIds).toContain("00b3-persist-client-brief");

    const check = (await durableStore.getStep(params.runId, "00b-check-client-brief")) as { output: { action: string; reason: string } };
    expect(check.output.action).toBe("create");
    expect(typeof check.output.reason).toBe("string");

    const stored = await env.store.readJson<unknown>("acme", briefSegments("instagram"));
    expect(ClientBriefSchema.safeParse(stored).success).toBe(true);
    expect((stored as ClientBrief).generatedBy).toBe("agent");
    expect((stored as ClientBrief).agentSkillRef).toBe(BRIEF_AGENT_SKILL_REF);

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { source: string; brief: ClientBrief } };
    expect(briefStep.output.source).toBe("persisted");
    expect(briefStep.output.brief.generatedBy).toBe("agent");
  });

  it("a brief that under-reports its sources is stored with the grounding rows the run actually read, and keeps the normal relevance floor", async () => {
    env = await seedClient(false);
    // The model names only the profile: no product-information document, no
    // page of the client's own site. Persisted verbatim that is a THIN brief,
    // and the relevance gate would accept "a different business in the same
    // field could have posted this" (2/5) for the rest of the month.
    const router = fakeRouterSequence([
      finalTurn(briefAgentOutput({ sources: [{ kind: "profile", ref: "client.getProfile" }] })),
      ...happyTurns(),
    ]);
    const { params, durableStore, result } = runWith(router, "instagram_run_brief_under_reported");
    expect((await result).status).toBe("completed");

    const gathered = (await durableStore.getStep(params.runId, "00b1-gather-brief-sources")) as {
      output: { presentSources: Array<{ kind: string; ref: string }> };
    };
    // The premise: this run really did read the client's own pages.
    expect(gathered.output.presentSources.filter((s) => s.kind === "site").length).toBeGreaterThan(0);

    const stored = (await env.store.readJson<ClientBrief>("acme", briefSegments("instagram")))!;
    expect(stored.sources.some((s) => s.kind === "site")).toBe(true);
    expect(isThinlyGrounded(stored)).toBe(false);

    const persist = (await durableStore.getStep(params.runId, "00b3-persist-client-brief")) as {
      output: { status: string; sourceNotes?: string[] };
    };
    expect(persist.output.status).toBe("written");
    expect((persist.output.sourceNotes ?? []).join(" ")).toMatch(/added \d+ grounding source/);
  });

  it("with a fresh brief on disk: no brief turn is consumed and the gather/write steps never run", async () => {
    env = await seedClient(goodClientBrief());
    const router = fakeRouterSequence(happyTurns());
    const { params, durableStore, result } = runWith(router, "instagram_run_brief_reuse");
    expect((await result).status).toBe("completed");

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("00b-check-client-brief");
    expect(stepIds).not.toContain("00b1-gather-brief-sources");
    expect(stepIds).not.toContain("00b2-write-client-brief");
    const check = (await durableStore.getStep(params.runId, "00b-check-client-brief")) as { output: { action: string } };
    expect(check.output.action).toBe("reuse");
  });

  it("a 31-day-old brief is refreshed; wf.input.refreshBrief refreshes a fresh one; a human brief is refreshed by neither", async () => {
    env = await seedClient(goodClientBrief({ generatedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() }));
    const stale = runWith(fakeRouterSequence([finalTurn(briefAgentOutput()), ...happyTurns()]), "instagram_run_brief_ttl");
    expect((await stale.result).status).toBe("completed");
    expect(((await stale.durableStore.getStep(stale.params.runId, "00b-check-client-brief")) as { output: { action: string } }).output.action).toBe("refresh");
    await env.cleanup();

    env = await seedClient(goodClientBrief());
    const asked = runWith(fakeRouterSequence([finalTurn(briefAgentOutput()), ...happyTurns()]), "instagram_run_brief_asked", { refreshBrief: true });
    expect((await asked.result).status).toBe("completed");
    expect(((await asked.durableStore.getStep(asked.params.runId, "00b-check-client-brief")) as { output: { action: string } }).output.action).toBe("refresh");
    await env.cleanup();

    env = await seedClient(goodClientBrief({ generatedBy: "human", generatedAt: new Date(Date.now() - 400 * DAY_MS).toISOString() }));
    const human = runWith(fakeRouterSequence(happyTurns()), "instagram_run_brief_human_lifecycle", { refreshBrief: true });
    expect((await human.result).status).toBe("completed");
    expect(((await human.durableStore.getStep(human.params.runId, "00b-check-client-brief")) as { output: { action: string } }).output.action).toBe("reuse");
    expect((await env.store.readJson<ClientBrief>("acme", briefSegments("instagram")))!.generatedBy).toBe("human");
  });

  it("a malformed brief turn never blocks the run: it delivers on the derived brief, and the ledger carries the warn", async () => {
    env = await seedClient(false);
    // `coreTerms: []` fails the agent's own output schema.
    const router = fakeRouterSequence([finalTurn({ ...briefAgentOutput(), coreTerms: [] }), ...happyTurns()]);
    const { params, durableStore, result } = runWith(router, "instagram_run_brief_malformed");
    expect((await result).status).toBe("completed");

    const briefStep = (await durableStore.getStep(params.runId, "02i-resolve-client-brief")) as { output: { source: string } };
    expect(briefStep.output.source).toBe("derived");
    expect(await env.store.readJson("acme", briefSegments("instagram"))).toBeUndefined();

    // `ledger.appendEvent` writes to `ledger/events/<runId>/<eventId>.json`,
    // so the run's events are the entries directly under `<runId>` — the `_`
    // placeholder belongs to the DELIVERABLES layout, not this one.
    const events = await env.store.listJson<{ level: string; message: string }>("acme", ["ledger", "events", params.runId]);
    expect(events.some((e) => e.data.level === "warn" && /brief/i.test(e.data.message))).toBe(true);
  });
});
