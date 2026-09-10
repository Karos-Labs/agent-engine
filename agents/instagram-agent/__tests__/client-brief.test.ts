import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import { ClientBriefSchema, type ClientBrief } from "@agent-engine/tools";
import {
  MAX_GROUNDED_QUERY_CHARS,
  briefForPrompt,
  buildGroundedQuery,
  deriveClientBrief,
  extractSubject,
  fallbackQuery,
  isBriefStale,
  isThinlyGrounded,
  looksLikeDirection,
} from "../src/workflow/client-brief.js";
import {
  MIN_RELEVANCE_SCORE,
  THIN_GROUNDING_MIN_RELEVANCE_SCORE,
  buildRelevanceSystemPrompt,
  relevanceFailureReason,
  relevanceFloor,
  relevanceSlidesFor,
  relevanceSteerFor,
  relevanceThinGroundingEvent,
  relevanceUnavailableEvent,
  runRelevanceJudge,
  type RelevanceJudgeInput,
} from "../src/workflow/relevance-gate.js";
import { fakeRouterSequence, finalTurn, goodClientBrief, goodCopyOutput, goodRelevanceVerdict, makePromptStore } from "./test-helpers.js";

/**
 * Instagram Phase 0 grounding gate — the pure half, standalone.
 *
 * `deriveClientBrief`, `buildGroundedQuery`, `fallbackQuery`, `briefForPrompt`
 * and `isBriefStale` are code over onboarding data; `runRelevanceJudge` is one
 * Flash call, driven here through a minimal `WorkflowContext` stand-in so the
 * verdict mapping (score -> relevant / off-brief / error) is pinned without
 * the whole workflow. `grounding-gate.test.ts` covers the wired steps.
 */

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-09T12:00:00.000Z");

/** Karos Labs as its portal profile describes it — the client the audit's real-estate carousel shipped for. */
const KAROSLABS_PROFILE = {
  name: "Karos Labs",
  industry: "AI marketing",
  website: "https://karoslabs.com",
  description:
    "Karos Labs is an AI marketing agency for B2B founders. We run research, drafting and publishing across every channel with agents a human editor reviews, so a founder gets an agency's output at a fraction of the agency's cost.",
};

const KAROSLABS_VOICE = {
  tone: "direct, practitioner, no hype",
  doList: ["show the process data behind a claim", "name the audience in the first line", "one idea per slide"],
  dontList: ["guaranteed results", "10x your revenue", "replace your marketing team"],
};

const PRODUCT_INFORMATION = [
  "# Product information",
  "",
  "Karos Labs sells a managed AI content engine: weekly Instagram, X and LinkedIn posts, a monthly newsletter and landing pages, drafted by agents and approved by the client's editor.",
  "",
  "## Plans",
  "- Starter plan: one channel, four posts a month, $490.",
  "- Growth plan: three channels, twelve posts a month, $1,490.",
  "- New offer for first-time buyers: the first month of Starter at half price, valid until the end of Q4.",
  "- מבצע השקה: חודש ראשון בחצי מחיר ללקוחות חדשים.",
].join("\n");

const TARGET_AUDIENCE = ["# Target audience", "", "Founders and heads of marketing at seed to series B B2B software companies, usually a team of one to three doing marketing part time.", "", "They buy when a launch is coming and nobody has time to write."].join("\n");

function karoslabsBrief(overrides: Partial<Parameters<typeof deriveClientBrief>[0]> = {}): ClientBrief {
  return deriveClientBrief({
    profile: KAROSLABS_PROFILE,
    voiceRules: KAROSLABS_VOICE,
    brand: { tagline: "Marketing that ships itself", language: "English" },
    contextDocs: { productInformation: PRODUCT_INFORMATION, targetAudience: TARGET_AUDIENCE },
    knowledge: {
      contextDocs: [],
      transcripts: [{ title: "Kickoff call with Acme", summary: "agreed on a weekly Instagram cadence" }],
      assets: [{ name: "Q2 pipeline report.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "gs://bucket/q2.xlsx", note: "pipeline numbers by channel" }],
    },
    forbiddenTopics: ["politics"],
    targetLanguage: "English",
    now: NOW,
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// deriveClientBrief
// ─────────────────────────────────────────────────────────────────────────

describe("deriveClientBrief — deterministic, never throws, always schema-valid", () => {
  it("builds a valid brief from a karoslabs-shaped profile: positioning from the description, 'marketing' among the core terms", () => {
    const brief = karoslabsBrief();
    expect(ClientBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.generatedBy).toBe("deterministic");
    expect(brief.confidence).toBe("low");
    expect(brief.channel).toBe("instagram");
    expect(brief.generatedAt).toBe(NOW.toISOString());

    expect(brief.positioning.oneLiner).toBe("Karos Labs is an AI marketing agency for B2B founders.");
    // First paragraph of product-information, headings skipped.
    expect(brief.positioning.whatWeSell).toMatch(/^Karos Labs sells a managed AI content engine/);
    expect(brief.icp.summary).toMatch(/^Founders and heads of marketing/);

    expect(brief.coreTerms).toContain("marketing");
    // The industry comes first, lowercased, as one term.
    expect(brief.coreTerms[0]).toBe("ai marketing");
    expect(brief.coreTerms.length).toBeLessThanOrEqual(12);
    // Stopwords and short tokens never make it in.
    expect(brief.coreTerms).not.toContain("with");
    expect(brief.coreTerms).not.toContain("b2b");
  });

  it("reads offers from product-information lines that mention a plan, a launch, pricing or an offer — in English or Hebrew", () => {
    const brief = karoslabsBrief();
    const names = brief.offers.map((o) => o.name);
    expect(names).toContain("Starter plan");
    expect(names).toContain("Growth plan");
    expect(names.some((n) => n.startsWith("New offer for first-time buyers"))).toBe(true);
    expect(names.some((n) => n.startsWith("מבצע השקה"))).toBe(true);
    expect(brief.offers.length).toBeLessThanOrEqual(5);
    for (const offer of brief.offers) expect(offer.summary.length).toBeGreaterThan(0);
  });

  it("maps voice rules and the frozen config into forbidden / evergreen / language, and knowledge into ownAssets", () => {
    const brief = karoslabsBrief();
    expect(brief.forbidden.topics).toEqual(["politics"]);
    expect(brief.forbidden.claims).toEqual(KAROSLABS_VOICE.dontList);
    expect(brief.evergreenAngles).toEqual(KAROSLABS_VOICE.doList);
    expect(brief.language).toEqual({ target: "English", register: KAROSLABS_VOICE.tone });
    expect(brief.ownAssets).toEqual([
      { title: "Q2 pipeline report.xlsx", kind: "data", summary: "pipeline numbers by channel", sourceRef: "gs://bucket/q2.xlsx" },
      { title: "Kickoff call with Acme", kind: "doc", summary: "agreed on a weekly Instagram cadence", sourceRef: "client.getKnowledge/transcripts" },
    ]);
    expect(brief.sources.map((s) => s.ref)).toEqual(
      expect.arrayContaining(["client.getProfile", "client.getBrand", "client.getVoiceRules", "product-information", "target-audience", "client.getKnowledge"]),
    );
    // market-strategy was not supplied: named as a gap, not silently absent.
    expect(brief.gaps.some((g) => g.includes("market-strategy"))).toBe(true);
  });

  it("an empty profile (industry only) still yields a valid brief with coreTerms [industry] and a gap for every missing source", () => {
    const brief = deriveClientBrief({ profile: { industry: "Widgets" }, contextDocs: {}, forbiddenTopics: [], now: NOW });
    expect(ClientBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.coreTerms).toEqual(["widgets"]);
    expect(brief.positioning.oneLiner).toBe("Widgets");
    expect(brief.positioning.whatWeSell).toBe("Widgets");
    expect(brief.icp.summary).toBe("practitioners in Widgets");
    expect(brief.offers).toEqual([]);
    expect(brief.gaps.length).toBeGreaterThanOrEqual(5);
    expect(brief.gaps.join("\n")).toMatch(/voice rules/);
    expect(brief.gaps.join("\n")).toMatch(/product-information/);
    expect(brief.gaps.join("\n")).toMatch(/target-audience/);
    expect(brief.gaps.join("\n")).toMatch(/knowledge/);
  });

  it("nothing at all (no profile, no docs) is still a valid brief that says so in every field it had to invent", () => {
    const brief = deriveClientBrief({ contextDocs: {}, forbiddenTopics: [], now: NOW });
    expect(ClientBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.coreTerms).toHaveLength(1);
    expect(brief.positioning.oneLiner).toMatch(/no profile description/);
    expect(brief.gaps.some((g) => g.includes("core terms could not be derived"))).toBe(true);
    expect(brief.sources).toEqual([]);
  });

  it("falls back to the brand tagline, then to '<name>, <industry>', for the one-liner", () => {
    const fromTagline = deriveClientBrief({ profile: { name: "Acme", industry: "Widgets" }, brand: { tagline: "Widgets that last" }, contextDocs: {}, forbiddenTopics: [], now: NOW });
    expect(fromTagline.positioning.oneLiner).toBe("Widgets that last");
    const fromName = deriveClientBrief({ profile: { name: "Acme", industry: "Widgets" }, contextDocs: {}, forbiddenTopics: [], now: NOW });
    expect(fromName.positioning.oneLiner).toBe("Acme, Widgets");
  });

  it("clamps overlong prose to the schema's field ceilings at a word boundary instead of failing validation", () => {
    const longDescription = `${"Karos Labs helps founders ship marketing faster ".repeat(20)}. Second sentence.`;
    const longDoc = "Paragraph one ".repeat(60);
    const brief = deriveClientBrief({
      profile: { industry: "AI marketing", description: longDescription },
      contextDocs: { productInformation: longDoc, targetAudience: longDoc },
      forbiddenTopics: [],
      now: NOW,
    });
    expect(ClientBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.positioning.oneLiner.length).toBeLessThanOrEqual(240);
    expect(brief.positioning.whatWeSell.length).toBeLessThanOrEqual(400);
    expect(brief.icp.summary.length).toBeLessThanOrEqual(240);
    expect(brief.positioning.oneLiner).not.toMatch(/\s$/);
  });

  it("treats Hebrew onboarding prose as content: Hebrew tokens become core terms, Hebrew function words do not", () => {
    const brief = deriveClientBrief({
      profile: { industry: "טכנולוגיה", description: "גיקטיים הוא אתר הטכנולוגיה הגדול בישראל, המסקר סטארטאפים, השקעות והון סיכון עבור יזמים ומשקיעים." },
      contextDocs: {},
      forbiddenTopics: [],
      targetLanguage: "Hebrew",
      now: NOW,
    });
    expect(ClientBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.coreTerms[0]).toBe("טכנולוגיה");
    expect(brief.coreTerms).toContain("סטארטאפים");
    expect(brief.coreTerms).not.toContain("עבור");
    expect(brief.language.target).toBe("Hebrew");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isBriefStale
// ─────────────────────────────────────────────────────────────────────────

describe("isBriefStale", () => {
  const agentBrief = (ageDays: number): Pick<ClientBrief, "generatedBy" | "generatedAt"> => ({
    generatedBy: "agent",
    generatedAt: new Date(NOW.getTime() - ageDays * DAY_MS).toISOString(),
  });

  it("is stale for a 31-day-old agent brief and fresh for a 30-day-old one", () => {
    expect(isBriefStale(agentBrief(31), NOW)).toBe(true);
    expect(isBriefStale(agentBrief(30), NOW)).toBe(false);
    expect(isBriefStale(agentBrief(0), NOW)).toBe(false);
  });

  it("is ALWAYS stale for a deterministic brief, however fresh — it exists only until an agent-written one is persisted", () => {
    expect(isBriefStale(karoslabsBrief(), NOW)).toBe(true);
    expect(isBriefStale({ generatedBy: "deterministic", generatedAt: NOW.toISOString() }, NOW)).toBe(true);
  });

  it("is fresh for a human brief inside the TTL and stale for an unparseable timestamp", () => {
    expect(isBriefStale({ generatedBy: "human", generatedAt: agentBrief(2).generatedAt }, NOW)).toBe(false);
    expect(isBriefStale({ generatedBy: "human", generatedAt: "last spring" }, NOW)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildGroundedQuery / fallbackQuery
// ─────────────────────────────────────────────────────────────────────────

describe("buildGroundedQuery — the request, grounded in what the client sells and to whom", () => {
  it("rewrites a DIRECTION into '<subject> in the context of <whatWeSell> for <icp>' and keeps it at or under 200 chars", () => {
    const brief = karoslabsBrief();
    const g = buildGroundedQuery({ topic: "Create content that introduces the new offer to first-time buyers", source: "requested" }, brief);
    expect(g.rewritten).toBe(true);
    expect(g.rewrittenFrom).toBe("Create content that introduces the new offer to first-time buyers");
    expect(g.subject).toBe("the new offer to first-time buyers");
    expect(g.query).toContain(" in the context of ");
    expect(g.query).toMatch(/^the new offer to first-time buyers in the context of Karos Labs sells a managed AI content engine/);
    expect(g.query).toContain(" for Founders and heads of marketing");
    expect(g.query.length).toBeLessThanOrEqual(MAX_GROUNDED_QUERY_CHARS);
    // The verbatim request never reaches the search index on its own.
    expect(g.query).not.toContain("Create content that");
  });

  it("a plain topic line (a requestedSubject) is the subject as-is, still grounded", () => {
    const g = buildGroundedQuery({ topic: "our new onboarding flow", source: "requested" }, karoslabsBrief());
    expect(g.subject).toBe("our new onboarding flow");
    expect(g.query.startsWith("our new onboarding flow in the context of ")).toBe(true);
  });

  it("a reserved catalog row is grounded the same way", () => {
    const g = buildGroundedQuery({ topic: "5 automation wins from this quarter", source: "reserved" }, karoslabsBrief());
    expect(g.query).toContain("5 automation wins from this quarter in the context of ");
  });

  it("passes a scouted trend's headline through unchanged — the scout already judged its brand fit", () => {
    const brief = karoslabsBrief();
    const trend = {
      topic: "automated weekly reporting is replacing the Monday status meeting",
      headline: "Survey: teams that automated reporting reclaimed four hours a week",
      mode: "deep-value" as const,
      brandFit: 5,
      interest: 4,
      brandFitReason: "the client sells this",
      angle: "the hours come back only when the report writes itself",
      hook: "Your Monday status meeting is a report nobody wrote down.",
      whyNow: "published this week",
      sourceUrls: ["https://offline.test/reporting/0"],
      hasNumbers: true,
    };
    const g = buildGroundedQuery({ topic: trend.topic, source: "trend", trend: trend as never }, brief);
    expect(g.query).toBe(trend.headline);
    expect(g.rewritten).toBe(false);
    expect(g.subject).toBe(trend.topic);

    // An untagged candidate is `niche-news` by definition (`candidateEngine`),
    // which is the pre-RFC-13 shape this pass-through was written for.
    expect(buildGroundedQuery({ topic: trend.topic, source: "trend", trend: { ...trend, engine: "niche-news" } as never }, brief).rewritten).toBe(false);
  });

  it("grounds a scouted candidate that is NOT news: an own-asset heading is not a query any index can answer", () => {
    const brief = karoslabsBrief();
    // `own-assets` and `evergreen` candidates carry a document heading or a
    // phrase the scout wrote, never something a publication published. Sent
    // verbatim to a keyword index they return the client's own page or
    // nothing, so the news lane's primary question was a heading.
    const ownAsset = {
      topic: "what the onboarding cohort data says about time to first value",
      headline: "market-strategy#Northwind cut onboarding to 3 days",
      mode: "deep-value" as const,
      engine: "own-assets" as const,
      brandFit: 5,
      interest: 4,
      brandFitReason: "the client owns this data",
      angle: "the cohort data says the opposite of the sales deck",
      hook: "Three days, not three weeks.",
      whyNow: "the cohort analysis has never been published",
      sourceUrls: [],
      evidenceRefs: ["market-strategy#Northwind"],
      hasNumbers: true,
    };
    const g = buildGroundedQuery({ topic: ownAsset.topic, source: "trend", trend: ownAsset as never }, brief);
    expect(g.rewritten).toBe(true);
    expect(g.query).toContain(" in the context of ");
    expect(g.query).not.toContain("market-strategy#");
    expect(g.query.length).toBeLessThanOrEqual(MAX_GROUNDED_QUERY_CHARS);
    expect(g.subject).toBe(ownAsset.topic);

    for (const engine of ["evergreen", "audience-questions", "reference-accounts"] as const) {
      expect(buildGroundedQuery({ topic: ownAsset.topic, source: "trend", trend: { ...ownAsset, engine } as never }, brief).rewritten).toBe(true);
    }
  });

  it("shrinks the ICP first, then what-we-sell, then the subject when the parts overrun the ceiling — and never exceeds it", () => {
    const brief = karoslabsBrief({
      contextDocs: {
        productInformation: "A very long description of an enormously complicated managed service that goes on and on about channels and cadences and editors and agents and reviews and pipelines and dashboards without a full stop for quite some time before it finally ends",
        targetAudience: "Founders, heads of marketing, heads of growth, demand generation leads, product marketers and the occasional chief executive at seed to series B software companies in North America and Western Europe",
      },
    });
    const longRequest = `Write a carousel about ${"the many ways a small team can keep publishing during a launch week ".repeat(3)}`;
    const g = buildGroundedQuery({ topic: longRequest, source: "requested" }, brief);
    expect(g.query.length).toBeLessThanOrEqual(MAX_GROUNDED_QUERY_CHARS);
    expect(g.query).toContain(" in the context of ");
    expect(g.query.startsWith("the many ways a small team")).toBe(true);
  });

  it("recognises Hebrew directions and the Hebrew 'about' marker", () => {
    expect(looksLikeDirection("כתבו פוסט על המבצע החדש ללקוחות ראשונים")).toBe(true);
    expect(extractSubject("כתבו פוסט על המבצע החדש ללקוחות ראשונים")).toBe("המבצע החדש ללקוחות ראשונים");
    expect(looksLikeDirection("המבצע החדש ללקוחות ראשונים")).toBe(false);
  });

  it("extractSubject: a direction with no marker word keeps the whole request; a topic line is untouched; trailing punctuation goes", () => {
    expect(extractSubject("Write something punchy for launch week.")).toBe("Write something punchy for launch week");
    expect(extractSubject("Post about our pricing change")).toBe("our pricing change");
    expect(extractSubject("customer story: scaling from 10 to 100 clients")).toBe("customer story: scaling from 10 to 100 clients");
    // "content" contains "on" — the marker must match a whole word only.
    expect(extractSubject("Create content introducing the new plan")).toBe("the new plan");
    // "about" outranks "on": the channel is not the subject.
    expect(extractSubject("Post on Instagram about our pricing change")).toBe("our pricing change");
    expect(extractSubject("Write a post on customer onboarding")).toBe("customer onboarding");
  });

  it("fallbackQuery is the subject plus the first two core terms the subject does not already contain", () => {
    const brief = karoslabsBrief();
    const fb = fallbackQuery("the new offer to first-time buyers", brief);
    expect(fb).toBe(`the new offer to first-time buyers ${brief.coreTerms[0]} ${brief.coreTerms[1]}`);
    expect(fallbackQuery("ai marketing wins", brief)).not.toMatch(/ai marketing ai marketing/);
    expect(fallbackQuery("ai marketing wins", brief).split(" ").length).toBeGreaterThan(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// briefForPrompt
// ─────────────────────────────────────────────────────────────────────────

describe("briefForPrompt", () => {
  it("renders positioning, ICP, offers, core terms, forbidden, language and confidence in well under 1000 words", () => {
    const text = briefForPrompt(karoslabsBrief());
    expect(text.split(/\s+/).length).toBeLessThan(1000);
    expect(text).toContain("Client brief (confidence low; written by deterministic, 2026-09-09).");
    expect(text).toContain("Positioning: Karos Labs is an AI marketing agency for B2B founders.");
    expect(text).toContain("What we sell: Karos Labs sells a managed AI content engine");
    expect(text).toContain("Audience (ICP): Founders and heads of marketing");
    expect(text).toContain("Current offers:");
    expect(text).toContain("- Starter plan:");
    expect(text).toContain("Core terms (use them where the audience would): ai marketing, ");
    expect(text).toContain("Never claim: guaranteed results; 10x your revenue; replace your marketing team");
    expect(text).toContain("Off-limits topics: politics");
    expect(text).toContain("Language: target English; register: direct, practitioner, no hype");
    expect(text).toContain("Known gaps in this brief:");
  });

  it("omits empty sections rather than printing empty labels", () => {
    const text = briefForPrompt(deriveClientBrief({ profile: { industry: "Widgets" }, contextDocs: {}, forbiddenTopics: [], now: NOW }));
    expect(text).not.toContain("Current offers:");
    expect(text).not.toContain("Never claim:");
    expect(text).not.toContain("Off-limits topics:");
    expect(text).not.toContain("Language:");
    expect(text).toContain("Core terms (use them where the audience would): widgets");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runRelevanceJudge — the verdict mapping, through a minimal WorkflowContext.
// ─────────────────────────────────────────────────────────────────────────

const CTX: AgentContext = { runId: "run_rel", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

/** A `WorkflowContext` whose `step.agent` runs the agent directly — enough to exercise the verdict mapping. */
function fakeWorkflowContext(): WorkflowContext {
  return {
    runId: CTX.runId,
    clientSlug: CTX.clientSlug,
    productId: CTX.productId,
    runKind: CTX.runKind,
    input: {},
    step: {
      code: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
      agent: async (_id: string, agent: { run: (ctx: AgentContext, input: unknown) => Promise<unknown> }, input: unknown) => agent.run(CTX, input),
    },
  } as unknown as WorkflowContext;
}

function judgeInput(): RelevanceJudgeInput {
  const copy = goodCopyOutput();
  return { brief: briefForPrompt(karoslabsBrief()), topic: "process changes that moved the needle", caption: copy.caption, slides: relevanceSlidesFor(copy) };
}

describe("isThinlyGrounded / relevanceFloor — the gate floor the grounding earns", () => {
  it("a profile-only brief is thinly grounded: whatWeSell is the industry and the ICP is generic", () => {
    const brief = deriveClientBrief({ profile: KAROSLABS_PROFILE, voiceRules: KAROSLABS_VOICE, contextDocs: {}, forbiddenTopics: [], now: NOW });
    expect(brief.positioning.whatWeSell).toBe("AI marketing");
    expect(brief.icp.summary).toBe("practitioners in AI marketing");
    expect(isThinlyGrounded(brief)).toBe(true);
    // No industry either: thinner still.
    expect(isThinlyGrounded(deriveClientBrief({ contextDocs: {}, forbiddenTopics: [], now: NOW }))).toBe(true);
  });

  it("an AGENT-written thin brief earns the relaxed floor too: the decision is the brief's own audit trail, not the derivation's prose", () => {
    // The mechanism this pins. `resolveBriefFreshness` replaces every
    // deterministic brief on a client's first Phase 1 run, so from then on
    // `icp.summary` is model prose and no fallback literal appears anywhere.
    // Fingerprinting those literals made the relaxed floor unreachable for
    // the writer that actually produces briefs — and re-opened the
    // unwinnable three-attempt hold it exists to prevent, for exactly the
    // thin-onboarding client the audit was about.
    const thinAgentBrief = goodClientBrief({
      generatedBy: "agent",
      sources: [
        { kind: "profile", ref: "client.getProfile" },
        { kind: "voice-rules", ref: "client.getVoiceRules" },
        { kind: "context-doc", ref: "brand-voice" },
      ],
      icp: {
        summary: "Marketing leads at mid-sized agencies who own their own content calendar",
        roles: ["marketing lead"],
        pains: ["no time to write"],
        industries: [],
        geos: [],
      },
      gaps: ["no product-information document: the offer is inferred from the profile description", "no target-audience document: the ICP is inferred"],
    });
    expect(thinAgentBrief.icp.summary.startsWith("practitioners in ")).toBe(false);
    expect(isThinlyGrounded(thinAgentBrief)).toBe(true);
    expect(relevanceFloor(isThinlyGrounded(thinAgentBrief)).minScore).toBe(THIN_GROUNDING_MIN_RELEVANCE_SCORE);

    // The same writer with the client's own site read is NOT thin: `00b1`
    // fetches home/about/pricing, and their own words about themselves are
    // grounding a post can be legible against.
    const siteGrounded = goodClientBrief({
      generatedBy: "agent",
      sources: [
        { kind: "profile", ref: "client.getProfile" },
        { kind: "site", ref: "https://acme.test/about" },
      ],
    });
    expect(isThinlyGrounded(siteGrounded)).toBe(false);
    expect(relevanceFloor(isThinlyGrounded(siteGrounded)).minScore).toBe(MIN_RELEVANCE_SCORE);

    // And a human-authored brief is read by the same rule.
    expect(isThinlyGrounded(goodClientBrief({ generatedBy: "human", sources: [{ kind: "context-doc", ref: "target-audience" }] }))).toBe(false);
    expect(isThinlyGrounded(goodClientBrief({ generatedBy: "human", sources: [] }))).toBe(true);
  });

  it("EITHER onboarding document is enough to earn the normal floor", () => {
    const withProduct = deriveClientBrief({ profile: KAROSLABS_PROFILE, contextDocs: { productInformation: PRODUCT_INFORMATION }, forbiddenTopics: [], now: NOW });
    expect(isThinlyGrounded(withProduct)).toBe(false);
    const withAudience = deriveClientBrief({ profile: KAROSLABS_PROFILE, contextDocs: { targetAudience: TARGET_AUDIENCE }, forbiddenTopics: [], now: NOW });
    expect(isThinlyGrounded(withAudience)).toBe(false);
    expect(isThinlyGrounded(karoslabsBrief())).toBe(false);
  });

  it("the floor is 3 normally and 2 for a thin brief, and only the relaxed one carries a reason", () => {
    expect(relevanceFloor(false)).toEqual({ minScore: MIN_RELEVANCE_SCORE });
    const relaxed = relevanceFloor(true);
    expect(relaxed.minScore).toBe(THIN_GROUNDING_MIN_RELEVANCE_SCORE);
    expect(relaxed.minScore).toBeLessThan(MIN_RELEVANCE_SCORE);
    expect(relaxed.relaxedReason).toMatch(/no product-information document, no target-audience document and no page of the client's own site/);
    expect(relaxed.relaxedReason).toMatch(/floor returns to 3\/5/);
  });

  it("a 2 passes on the relaxed floor and says why; a 1 is still off-brief", async () => {
    const floor = relevanceFloor(true);
    const two = await runRelevanceJudge(
      fakeWorkflowContext(),
      { tools: {}, router: fakeRouterSequence([finalTurn({ score: 2, reason: "this field, not this business" })]), promptStore: makePromptStore() },
      "07g-relevance-attempt-1",
      judgeInput(),
      floor,
    );
    expect(two.status).toBe("relevant");
    if (two.status !== "relevant") throw new Error("unreachable");
    expect(two.score).toBe(2);
    expect(two.note).toBe(floor.relaxedReason);
    // The ledger row a reviewer reads.
    const event = relevanceThinGroundingEvent("run_x", 1, two);
    expect(event.eventId).toBe("run_x__relevance-thin-grounding-a1");
    expect(event.level).toBe("warn");
    expect(event.message).toMatch(/scored this post 2\/5 and it was accepted/);

    const one = await runRelevanceJudge(
      fakeWorkflowContext(),
      { tools: {}, router: fakeRouterSequence([finalTurn({ score: 1, reason: "a different industry entirely", missingBridge: "say what this business sells" })]), promptStore: makePromptStore() },
      "07g-relevance-attempt-1",
      judgeInput(),
      floor,
    );
    expect(one.status).toBe("off-brief");
  });

  it("a 3 on the relaxed floor carries NO note: the floor did not decide it", async () => {
    const three = await runRelevanceJudge(
      fakeWorkflowContext(),
      { tools: {}, router: fakeRouterSequence([finalTurn({ score: 3, reason: "the bridge takes a sentence" })]), promptStore: makePromptStore() },
      "07g-relevance-attempt-1",
      judgeInput(),
      relevanceFloor(true),
    );
    expect(three).toEqual({ status: "relevant", score: 3, reason: "the bridge takes a sentence" });
  });
});

describe("runRelevanceJudge", () => {
  it("maps a score at or above the threshold to 'relevant'", async () => {
    const router = fakeRouterSequence([finalTurn(goodRelevanceVerdict())]);
    const verdict = await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07g-relevance-attempt-1", judgeInput());
    expect(verdict).toEqual({ status: "relevant", score: 5, reason: "every slide names the client's own process data and speaks to operations leads" });
    expect(MIN_RELEVANCE_SCORE).toBe(3);
    expect((await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router: fakeRouterSequence([finalTurn(goodRelevanceVerdict({ score: 3 }))]), promptStore: makePromptStore() }, "s", judgeInput())).status).toBe("relevant");
  });

  it("maps a score below the threshold to 'off-brief', carrying the missing bridge for the redraft steer", async () => {
    const router = fakeRouterSequence([finalTurn({ score: 2, reason: "any real-estate lender could have posted this", missingBridge: "say in slide 1 that this is about first-time buyers of the client's own onboarding offer" })]);
    const verdict = await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07g-relevance-attempt-1", judgeInput());
    expect(verdict.status).toBe("off-brief");
    if (verdict.status !== "off-brief") throw new Error("unreachable");
    expect(verdict.score).toBe(2);
    expect(relevanceFailureReason(verdict)).toBe("post does not read as this client's (relevance 2/5): any real-estate lender could have posted this");
    expect(relevanceSteerFor(verdict)).toBe("say in slide 1 that this is about first-time buyers of the client's own onboarding offer");
    // Without a bridge, the reason is the steer.
    expect(relevanceSteerFor({ status: "off-brief", score: 1, reason: "wrong industry" })).toBe("wrong industry");
  });

  it("rounds a fractional score and refuses one outside 1-5 as an error rather than clamping it into a verdict", async () => {
    const fractional = await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router: fakeRouterSequence([finalTurn({ score: 2.6, reason: "r" })]), promptStore: makePromptStore() }, "s", judgeInput());
    expect(fractional).toMatchObject({ status: "relevant", score: 3 });
    const outOfRange = await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router: fakeRouterSequence([finalTurn({ score: 7, reason: "r" })]), promptStore: makePromptStore() }, "s", judgeInput());
    expect(outOfRange).toMatchObject({ status: "error" });
    expect((outOfRange as { reason: string }).reason).toMatch(/outside 1-5/);
  });

  it("returns 'error' (never throws) when the judge's output fails its own schema — the caller fails open with a ledger warn", async () => {
    // `score` as a word fails `buildOutputSchema`'s number field inside BaseAgent -> content_fail.
    const router = fakeRouterSequence([finalTurn({ score: "high", reason: "r" })]);
    const verdict = await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07g-relevance-attempt-2", judgeInput());
    expect(verdict.status).toBe("error");
    if (verdict.status !== "error") throw new Error("unreachable");
    expect(verdict.reason).toMatch(/did not complete/);

    const event = relevanceUnavailableEvent("run_x", 2, verdict);
    expect(event.eventId).toBe("run_x__relevance-judge-unavailable-a2");
    expect(event.level).toBe("warn");
    expect(event.message).toMatch(/attempt 2/);
    expect(event.message).toMatch(/could not run/);
  });

  it("hands the judge the brief and the post (topic, caption, slides' headline+body only), never visualNeed or sourceRef", async () => {
    const router = fakeRouterSequence([finalTurn(goodRelevanceVerdict())]);
    await runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "s", judgeInput());
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const prompt = call[0] as string;
    const opts = call[3] as { system?: string };
    expect(prompt).toContain("Client brief (confidence low");
    expect(prompt).toContain(goodCopyOutput().slides[0]!.headline);
    expect(prompt).not.toContain(goodCopyOutput().slides[0]!.visualNeed);
    // The fixture's slide bodies restate their fact claims, so the claim TEXT
    // legitimately appears; the `sourceRef` and `visualNeed` FIELDS must not.
    expect(prompt).not.toMatch(/"sourceRef"|"visualNeed"|"layout"/);
    expect(opts.system?.startsWith(buildRelevanceSystemPrompt())).toBe(true);
    expect(buildRelevanceSystemPrompt()).toContain("Judge ONLY the connection to the business");
  });
});
