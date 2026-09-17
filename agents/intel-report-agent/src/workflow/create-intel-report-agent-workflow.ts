import type {
  AgentContext,
  AgentToolRegistry,
  GateResponse,
  ModelRouter,
  PromptStore,
  GateVerdict,
} from "@agent-engine/core";
import { routeContextDocumentModel, type ContextDocumentRoutingOptions } from "@agent-engine/core";
import {
  readLatestBrandVoice,
  readContextDoc,
  enforceContextDocPolicy,
  readRunDirection,
  runDirectionField,
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowToolingFailure,
  toAgentContext,
  runGate,
  finalizeDeliverable,
  type RevisionNote,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
} from "@agent-engine/workflow";
import type { ClientBrand, ClientProfile, Competitor, OnPageAuditSnapshot, PageSignals, TechnicalSeoSnapshot } from "@agent-engine/tools";
import { isPathDisallowed } from "@agent-engine/tool-karos-scraper";
import type { IntelReportOutput } from "@agent-engine/tool-karos-intel";
import {
  IntelReportDraftAgent,
  INTEL_REPORT_DRAFT_MAX_TOKENS,
  INTEL_REPORT_DRAFT_MODEL_POLICY,
} from "../agent/intel-report-draft-agent.js";
import { IntelReportGroundingAgent } from "../agent/intel-report-grounding-agent.js";
import type {
  IntelReportAgentWorkflowResult,
  IntelReportAuditedPage,
  IntelReportClientContext,
  IntelReportClientResearch,
  IntelReportCompetitorSite,
  IntelReportResearch,
  IntelReportSeoGeoSnapshot,
  IntelReportSiteAudit,
} from "./types.js";

/** The AI/search crawlers whose root access the SEO/GEO config checks (GEO-01) — repeated here rather than imported: RFC-05 §2 keeps this workflow free of `@agent-engine/tool-karos-seo-geo`. */
const AI_CRAWLERS = ["OAI-SearchBot", "PerplexityBot", "ClaudeBot", "Googlebot", "Bingbot"] as const;

/** A `PageSignals` page compacted to what a drafting prompt should read: the words on the page and the facts about its markup, not the markup. */
function compactPage(page: PageSignals): IntelReportAuditedPage {
  const h1 = page.headings.find((h) => h.level === 1)?.text;
  return {
    url: page.finalUrl,
    ...(page.title ? { title: page.title } : {}),
    ...(page.metaDescription ? { metaDescription: page.metaDescription } : {}),
    ...(h1 ? { h1 } : {}),
    headings: page.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text).slice(0, 12),
    wordCount: page.wordCount,
    ...(page.dateModified ? { dateModified: page.dateModified } : {}),
    authorByline: page.authorByline,
    schemaTypes: page.jsonLd.types.slice(0, 8),
    internalLinkCount: page.internalLinkCount,
    externalDomains: page.externalDomains.slice(0, 8),
    images: page.images,
    excerpt: page.excerpt.slice(0, 600),
  };
}

/** Builds step 01f's compact site audit from the two real reads. Pure, so the shape is testable without a network. */
export function summariseSiteAudit(seedUrl: string, onPage: OnPageAuditSnapshot | undefined, technical: TechnicalSeoSnapshot | undefined): IntelReportSiteAudit | null {
  const pages = (onPage?.pages ?? []).filter((p) => p.status === 200);
  if (pages.length === 0 && !technical) return null;
  const jsonLdTypes = [...new Set(pages.flatMap((p) => p.jsonLd.types))].slice(0, 12);
  const robotsBlocks = technical?.robots ? AI_CRAWLERS.filter((bot) => isPathDisallowed(technical.robots!, "/", bot)) : [];
  const reachable = technical ? { ok: technical.pages.filter((p) => p.status === 200).length, checked: technical.pages.length } : undefined;
  const site: IntelReportSiteAudit["site"] = {
    https: pages.length > 0 ? pages.every((p) => p.https) : /^https:/i.test(seedUrl),
    llmsTxtPresent: onPage?.llmsTxt.present ?? false,
    jsonLdTypes,
    pagesWithDateModified: pages.filter((p) => p.dateModified).length,
    pagesWithSingleH1: pages.filter((p) => p.h1Count === 1).length,
    pagesWithMetaDescription: pages.filter((p) => p.metaDescription).length,
    ...(reachable ? { reachable } : {}),
    robotsBlocks,
    ...(onPage?.sitemap ? { sitemapEntries: onPage.sitemap.entryCount } : {}),
    ...(onPage?.sitemap?.newestLastmod ? { sitemapNewestLastmod: onPage.sitemap.newestLastmod } : {}),
    ...(onPage?.sitemap?.maxGapDaysTrailing6mo !== undefined ? { longestPublishingGapDays: onPage.sitemap.maxGapDaysTrailing6mo } : {}),
  };
  const facts: string[] = [];
  if (reachable) facts.push(`${reachable.ok} of ${reachable.checked} crawled URLs answered HTTP 200.`);
  if (technical?.robots) facts.push(robotsBlocks.length === 0 ? "robots.txt allows every major AI and search crawler at the root." : `robots.txt disallows ${robotsBlocks.join(", ")} at the root.`);
  if (pages.length > 0) {
    facts.push(`${pages.length} pages audited: ${site.pagesWithSingleH1} with a single H1, ${site.pagesWithMetaDescription} with a meta description, ${site.pagesWithDateModified} declaring a modified date.`);
    facts.push(jsonLdTypes.length > 0 ? `Structured data present: ${jsonLdTypes.join(", ")}.` : "No JSON-LD structured data on the audited pages.");
    facts.push(site.llmsTxtPresent ? "An /llms.txt file is published." : "No /llms.txt file is published.");
    const withBylines = pages.filter((p) => p.authorByline).length;
    facts.push(`${withBylines} of ${pages.length} audited pages carry an author byline.`);
  }
  if (onPage?.sitemap) {
    facts.push(`The sitemap lists ${onPage.sitemap.truncated ? "at least " : ""}${onPage.sitemap.entryCount} URLs${onPage.sitemap.entriesTrailing6mo > 0 ? `, ${onPage.sitemap.entriesTrailing6mo} modified in the last six months` : ""}${site.longestPublishingGapDays !== undefined ? `; the longest publishing gap in that window is ${site.longestPublishingGapDays} days` : ""}.`);
  }
  return { seedUrl, pagesAudited: pages.length, pages: pages.map(compactPage), site, facts };
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

export interface CreateIntelReportAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/intel/gates/ledger) — this workflow adds nothing of its own on top. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a run built
   * without it genuinely pauses at `awaiting_gate` until a human reviews it
   * (RFC-01 §8.3), exactly like every other agent in this repo.
   *
   * THIS AGENT'S PRODUCTION WIRING NOW PASSES IT, reversing what this comment
   * used to say ("never for production wiring"). Two reasons, both specific to
   * this agent: its deliverable is not published under a client's name — it IS
   * the portal's `ClientReport` — and its gate was the one gate in this repo
   * with no auto-approve at all (`24h`/`hold`), so an unattended run could
   * only ever end at the portal's own 70-minute deliverable timeout. See
   * `buildWorkflowForProduct` (`apps/agent-server/src/wiring/workflows.ts`)
   * for the decision; the flag stays off by default so every test keeps the
   * gated behaviour.
   */
  autoApprove?: boolean;
  /**
   * SCRUM-380 (D1-v2). Per-instance model routing for the context-document
   * generation step (`02-generate-report`) — see
   * `routeContextDocumentModel` (`@agent-engine/core`) for what "document
   * complexity" is measured from and why.
   *
   * Optional, and its own default is conservative: with nothing passed, a
   * hard instance still escalates within the `anthropic` vendor (which the
   * router always has), and the cross-vendor large-context escalation stays
   * off. A deployment that has Gemini wired should pass
   * `{ allowVendorEscalation: true }`.
   */
  contextDocumentRouting?: ContextDocumentRoutingOptions;
}


/**
 * The 7 analysis prose fields `IntelReportOutput` carries — concatenated
 * (step 03) into the single `text` blob `gate.numbersSourced` checks every
 * numeric claim in the whole report against, in one call, rather than 7
 * separate gate calls per section.
 */
const ANALYSIS_FIELDS = [
  "contentAnalysis",
  "conversionAnalysis",
  "seoAnalysis",
  "geoAnalysis",
  "positioningAnalysis",
  "brandAnalysis",
  "growthAnalysis",
] as const satisfies readonly (keyof IntelReportOutput)[];

function concatenateAnalysisProse(report: IntelReportOutput): string {
  return ANALYSIS_FIELDS.map((field) => report[field]).join("\n\n");
}

/**
 * What step 03 had to do to a report before it could go forward — attached to
 * the deliverable and to this workflow's return value, exactly like
 * `contextGrounding`'s DEGRADED marker, so the repair is visible rather than
 * silent.
 *
 * Absent entirely on the normal path: a report whose figures all traced to a
 * source carries no marker at all.
 */
export interface IntelReportNumericGroundingMarker {
  /** Figures that could not be traced to a source and whose sentences were therefore dropped. */
  redactedFigures: string[];
  /**
   * Figures still unverifiable after every repair. Reported rather than
   * hidden — and normally empty, because redaction removes the sentence that
   * carries the figure.
   */
  unsourcedFigures: string[];
}

/**
 * Sentence boundaries, crudely: a terminator followed by whitespace.
 *
 * Deliberately crude. The only thing that depends on this split is which span
 * of prose gets dropped when a figure cannot be sourced, and dropping one
 * clause too many is strictly better than the alternative — surgically
 * excising "$30M" from "$5M–$30M ARR" and shipping "$5M– ARR" to a client.
 */
function splitSentences(prose: string): string[] {
  return prose.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
}

/**
 * What a section says when every sentence in it rested on an unverifiable
 * figure. Honest about the gap rather than silently short: a reviewer reading
 * the report has to be able to tell "we found nothing to say here" from "the
 * numbers did not hold up".
 */
const ANALYSIS_WITHHELD =
  "This section is not reported: the figures it rested on could not be traced to any source gathered for this run, and unsourced numbers are withheld rather than published.";

/**
 * The deterministic floor under step 03: drops every sentence still carrying a
 * figure `gate.numbersSourced` could not trace to a source.
 *
 * Exported for its own test. Pure, and monotone — each call removes at least
 * one sentence or reports that it located none, which is what lets step 03
 * loop over it without spinning.
 *
 * Over-removal is the deliberate bias. A claim like "$30M" also matches inside
 * "$130M", so a sentence may be dropped that did not strictly have to be; that
 * costs a sentence of analysis, while under-removal costs the client a figure
 * the report cannot stand behind.
 */
export function redactUnsourcedClaims(
  report: IntelReportOutput,
  claims: readonly string[],
): { report: IntelReportOutput; redactedFigures: string[]; droppedSentences: number } {
  const wanted = [...new Set(claims.map((claim) => claim.trim()).filter((claim) => claim.length > 0))];
  if (wanted.length === 0) return { report, redactedFigures: [], droppedSentences: 0 };

  const hit = new Set<string>();
  let droppedSentences = 0;
  const repaired: Partial<Record<(typeof ANALYSIS_FIELDS)[number], string>> = {};

  for (const field of ANALYSIS_FIELDS) {
    const prose = report[field];
    if (typeof prose !== "string" || prose.length === 0) continue;
    let dropped = 0;
    const kept = splitSentences(prose).filter((sentence) => {
      const carries = wanted.filter((claim) => sentence.includes(claim));
      if (carries.length === 0) return true;
      for (const claim of carries) hit.add(claim);
      dropped += 1;
      return false;
    });
    // A section that lost nothing is left byte-identical. Rebuilding it would
    // flatten its paragraph breaks into single spaces for no reason.
    if (dropped === 0) continue;
    droppedSentences += dropped;
    const rebuilt = kept.join(" ").trim();
    repaired[field] = rebuilt.length > 0 ? rebuilt : ANALYSIS_WITHHELD;
  }

  return { report: { ...report, ...repaired }, redactedFigures: [...hit], droppedSentences };
}

/**
 * `createIntelReportAgentWorkflow()` (RFC-05 §3): the one workflow used both
 * for a client's first-ever Intel Report and every later recurring "weekly
 * radar" refresh — cadence/scheduling is out of scope here, this is just
 * "run the pipeline end to end" either way.
 *
 * Deliberately, completely independent of the SEO/GEO workflow (RFC-05 §2's
 * resolved decision): this file never imports `@agent-engine/agent-seo-geo`
 * or `@agent-engine/tool-karos-seo-geo`, and never calls a `seoGeo.*` tool.
 * The legacy pipeline's hidden "regenerating the Intel Report silently
 * re-runs SEO/GEO too" coupling does not exist here in any form — an
 * onboarding orchestrator that wants both baselines can invoke this
 * workflow and the SEO/GEO workflow as two separate, explicit steps, but
 * that composition lives outside this package entirely.
 */
export function createIntelReportAgentWorkflow(options: CreateIntelReportAgentWorkflowOptions) {
  const tools = options.tools;

  return async function intelReportAgentWorkflow(wf: WorkflowContext): Promise<IntelReportAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // Same contract as every other agent: a typed sentence outranks the
    // agent's own subject selection, and style-only notes are deliberately not
    // promoted to subjects (see readRunDirection).
    const runDirection = readRunDirection(wf.input);

    // ── 00: load client context — blocked_intake if the profile itself was never set up ──
    const clientContext = await wf.step.code("00-load-client-context", async (): Promise<IntelReportClientContext> => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      if (profileOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client profile has not been set up yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      const competitorsOutcome = await tools["client.listCompetitors"]!.execute({}, { ctx });
      return {
        profile: profileOutcome.result as ClientProfile,
        brand: brandOutcome.status === "success" ? (brandOutcome.result as ClientBrand) : {},
        competitors: competitorsOutcome.status === "success" ? (competitorsOutcome.result as Competitor[]) : [],
      };
    });

    // ── 01: competitive research pull ──
    //
    // `research.pull` is backed by a real scraper now, not the cached
    // deterministic stand-in this comment used to describe, so the evidence
    // base is as good as what the query asks for. That is why a typed direction
    // is folded into the QUERY and not only into the drafting step: someone who
    // wrote "focus on their pricing page changes" has named what to go and look
    // at, and a direction that only reached the writer would have it reason
    // about evidence nobody fetched. ──
    const research = await wf.step.code("01-research-pull", async (): Promise<IntelReportResearch> => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const competitorNames = clientContext.competitors.map((c) => c.name).join(", ");
      const base = competitorNames
        ? `${industry} competitive landscape vs. ${competitorNames}`
        : `${industry} competitive landscape`;
      // Appended, never substituted: the competitor names are what makes this a
      // competitive scan at all, and a direction that replaced them would
      // quietly turn the report into something else.
      const query = runDirection.direction ? `${base} — focus: ${runDirection.direction}` : base;
      // Six sources, not the tool's default four. Every numeric claim in the
      // report has to trace back to something in here — `gate.numbersSourced`
      // holds the whole run otherwise — so the evidence base is the binding
      // constraint on how much of the report can say anything concrete. Six
      // rather than the cap of ten because the payload is injected WHOLE into
      // the drafting prompt (see `PullInputSchema.maxResults`): this is a token
      // bill as much as a breadth setting, and this agent already carries the
      // fleet's largest output ceiling.
      const outcome = await tools["research.pull"]!.execute({ job: "intel-competitive-scan", query, window: "30d", maxResults: 6 }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      const result = outcome.result as { runId: string; query: string; result: unknown; fromCache: boolean };
      return { runId: result.runId, query: result.query, result: result.result, fromCache: result.fromCache };
    });

    // The read side of the feedback flywheel: what this client asked for on
    // previous runs, injected into the drafting prompt. Bounded and
    // best-effort — a memory read failing must not stop a run that can draft
    // perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "01b-read-past-feedback");

    // ── 01c/01d: the client's projected target-audience and market-strategy context docs (C1/SCRUM-209, T-A9) ──
    //
    // Two separate doc types, not one combined read, and each threaded into
    // the draft prompt as its own named field: `targetAudience` steers WHO
    // the report's positioning/growth analysis should be written for, and
    // `marketStrategy` steers WHAT competitive lane the client says it is
    // playing in — a report that only knew the competitor list (already read
    // at 00-load-client-context) but not the client's own stated audience or
    // strategy could rank a competitor's move as a threat or an opportunity
    // in either direction depending on who is actually meant to read this
    // report. Unlike `readLatestBrandVoice`, these ARE checkpointed
    // (`wf.step.code` inside `readContextDoc`): a target-audience/
    // market-strategy document is client-authored reference material, not
    // something a reviewer edits mid-review the way a Brand Voice tweak
    // prompts a revision — the "always latest" freshness concern that
    // function's own doc comment describes does not apply here.
    //
    // Best-effort and non-blocking, same as every other optional context
    // read in this workflow: a client with neither doc yet projected drafts
    // exactly as this workflow did before this ticket.
    const targetAudience = await readContextDoc(wf, tools, ctx, "target-audience", "01c-load-target-audience");
    const marketStrategy = await readContextDoc(wf, tools, ctx, "market-strategy", "01d-load-market-strategy");

    // ── 01e: SCRUM-242 (T-A10) — stop failing open. intel-report-agent's row in the
    // one shared policy table (CONTEXT_DOC_POLICY) is BLOCK: this is a client-facing
    // deliverable that names external parties (competitors), so drafting it with zero
    // real grounding — generic analysis that reads exactly like a grounded report —
    // is worse than not drafting it at all. `enforceContextDocPolicy` throws
    // `WorkflowBlockedIntake` itself when EVERY context doc this agent reads is
    // absent (not merely one of the two — see that function's own doc comment),
    // UNLESS this is a `runKind: "setup"` run on this row's `bootstrapExempt`
    // exemption (SCRUM-388): onboarding dispatches this exact agent to PRODUCE
    // target-audience/market-strategy, so BLOCKing a run on documents it exists
    // to create would deadlock a fresh client's very first report forever. Every
    // recurring run still BLOCKs exactly as before — only `runKind` decides that,
    // never anything specific to this call site. The outcome is captured (not
    // discarded) because a bootstrap-exempted run must surface its DEGRADED
    // marker wherever this report actually surfaces — see 06's deliverable spread
    // and this function's own return value below.
    const contextGrounding = await wf.step.code("01e-enforce-context-doc-policy", () =>
      enforceContextDocPolicy({
        agentId: "intel-report-agent",
        docs: { "target-audience": targetAudience, "market-strategy": marketStrategy },
        runKind: wf.runKind,
      }),
    );

    // ── 01f-01i: the evidence this report used to be written without ──
    //
    // Until these four steps existed the drafting prompt saw the profile, the
    // brand kit, the competitor list and six web-search results about the
    // CATEGORY — and not one page of the client's own site, nothing about the
    // client by name, nothing a competitor's site actually says, and none of
    // the SEO/GEO measurements the sibling agent takes. Every "the homepage
    // does X" was training-knowledge guesswork, and the craft guide's
    // "score 50-65 when uncertain" rule made every report land in the same
    // mid-60s band regardless of the company. Each read below is best-effort
    // and checkpointed on its own: a site that cannot be fetched costs the
    // report that evidence, never the run.
    const website = typeof clientContext.profile["website"] === "string" ? (clientContext.profile["website"] as string).trim() : undefined;
    const seedUrl = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : undefined;

    const siteAudit = await wf.step.code("01f-audit-client-site", async (): Promise<IntelReportSiteAudit | null> => {
      if (!seedUrl) return null;
      const audit = tools["research.auditOnPage"];
      const crawl = tools["research.crawlTechnicalSeo"];
      try {
        const [auditOutcome, crawlOutcome] = await Promise.all([
          audit ? audit.execute({ seedUrl, limit: 8, window: "3d" }, { ctx }) : Promise.resolve(undefined),
          crawl ? crawl.execute({ seedUrl, limit: 12 }, { ctx }) : Promise.resolve(undefined),
        ]);
        const onPage = auditOutcome?.status === "success" ? (auditOutcome.result as { snapshot: OnPageAuditSnapshot }).snapshot : undefined;
        const technical = crawlOutcome?.status === "success" ? (crawlOutcome.result as { snapshot: TechnicalSeoSnapshot }).snapshot : undefined;
        return summariseSiteAudit(seedUrl, onPage, technical);
      } catch (error) {
        console.error("01f-audit-client-site: could not audit the client's site, drafting without it", error);
        return null;
      }
    });

    const clientResearch = await wf.step.code("01g-research-client", async (): Promise<IntelReportClientResearch | null> => {
      const name = typeof clientContext.profile["name"] === "string" ? (clientContext.profile["name"] as string).trim() : "";
      if (!name) return null;
      const industry = typeof clientContext.profile["industry"] === "string" ? (clientContext.profile["industry"] as string) : "";
      const domain = hostOf(seedUrl);
      // The client by NAME, not the category: news, reviews, rankings and
      // mentions of this company are what the brand, growth and positioning
      // sections need and what the category scan structurally never returns.
      const query = [`"${name}"`, industry, domain].filter(Boolean).join(" ");
      try {
        const outcome = await tools["research.pull"]!.execute({ job: "intel-client-scan", query, window: "30d", maxResults: 5 }, { ctx });
        if (outcome.status !== "success") return null;
        const result = outcome.result as { runId: string; query: string; result: unknown; fromCache: boolean };
        return { runId: result.runId, query: result.query, result: result.result, fromCache: result.fromCache };
      } catch (error) {
        console.error("01g-research-client: client-scan research failed, drafting without it", error);
        return null;
      }
    });

    const competitorSites = await wf.step.code("01h-audit-competitor-sites", async (): Promise<IntelReportCompetitorSite[] | null> => {
      const audit = tools["research.auditOnPage"];
      if (!audit) return null;
      // Curated competitors first, then the roster the last report discovered
      // (a Regenerate knows what the previous run found), five sites at most.
      const candidates = new Map<string, string>();
      for (const c of clientContext.competitors) if (typeof c.website === "string" && c.website) candidates.set(c.name, c.website);
      const getReport = tools["intel.getReport"];
      if (getReport && candidates.size < 5) {
        const reportOutcome = await getReport.execute({}, { ctx });
        const discovered = reportOutcome.status === "success" ? ((reportOutcome.result as { competitors?: Array<{ company?: string; url?: string }> }).competitors ?? []) : [];
        for (const row of discovered) if (typeof row.company === "string" && typeof row.url === "string" && row.url && !candidates.has(row.company)) candidates.set(row.company, row.url);
      }
      const targets = [...candidates.entries()].slice(0, 5);
      const sites: IntelReportCompetitorSite[] = [];
      for (const [name, url] of targets) {
        const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try {
          const outcome = await audit.execute({ seedUrl: target, limit: 1, window: "7d" }, { ctx });
          if (outcome.status !== "success") continue;
          const page = (outcome.result as { snapshot: OnPageAuditSnapshot }).snapshot.pages.find((p) => p.status === 200);
          if (page) sites.push({ name, page: compactPage(page) });
        } catch (error) {
          console.error(`01h-audit-competitor-sites: could not fetch ${name} (${target}), skipping`, error);
        }
      }
      return sites.length > 0 ? sites : null;
    });

    const seoGeoSnapshot = await wf.step.code("01i-load-seo-geo-snapshot", async (): Promise<IntelReportSeoGeoSnapshot | null> => {
      // Written by seo-geo-agent's final step into client memory — the one
      // place the two agents meet without importing each other (RFC-05 §2).
      // Absent on a client's very first onboarding (the two run in parallel),
      // present on every Regenerate after.
      try {
        const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
        if (outcome.status !== "success") return null;
        const beliefs = (outcome.result as { beliefs?: Record<string, unknown> }).beliefs ?? {};
        const snapshot = beliefs["seoGeoLatestSnapshot"];
        return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as IntelReportSeoGeoSnapshot) : null;
      } catch (error) {
        console.error("01i-load-seo-geo-snapshot: could not read client memory, drafting without it", error);
        return null;
      }
    });

    /**
     * What step 03 had to repair, per revision round. Written outside the step
     * body so it survives a checkpoint replay (see step 03's own comment), and
     * read back for the round the reviewer actually approved.
     */
    const numericGroundingByRevision = new Map<number, IntelReportNumericGroundingMarker | null>();

    // ── 02-03: generate the report, then verify its numeric claims — one full drafting pass ──
    /**
     * One full drafting pass: generate the report, then verify its numbers
     * are sourced.
     *
     * No terminal topic guardrail here, deliberately — this report is an
     * internal deliverable read by the client's own team, never published,
     * and `guardrail-coverage.test.ts` (apps/agent-server) enforces exactly
     * that split across every agent in this repo.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-generates instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (client
     * context, research) keeps its id and is reused. That reuse is why the
     * revision is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<IntelReportOutput> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── SCRUM-380 (D1-v2), part 2: Brand Voice, always-latest ──
      //
      // Deliberately NOT wrapped in `wf.step.code`, and deliberately read
      // HERE rather than reused from `00-load-client-context`'s checkpoint.
      // A checkpoint IS a cache: a completed step is replayed verbatim on
      // every later pass without its body running again (`step-code.ts`).
      // This run pauses at a 24-hour human gate in the middle, and the whole
      // reason a reviewer clicks "revise" is often that the voice is wrong —
      // so the realistic sequence is edit-the-Brand-Voice-then-revise, and a
      // re-draft served from yesterday's checkpoint would be blind to the
      // very edit it was asked to act on. See `readLatestBrandVoice`'s own
      // doc comment. Best-effort: a failed read falls back to the brand kit
      // step 00 already loaded, so freshness can never cost a run.
      //
      // No new checkpointed step id appears anywhere as a result — which is
      // both the mechanism and the reason `workflow-e2e.test.ts`'s exact
      // `ALL_STEP_IDS` equality still holds.
      const brandVoice = await readLatestBrandVoice(tools, ctx, clientContext.brand);

      // ── SCRUM-380 (D1-v2), part 1: complexity-driven routing for THIS instance ──
      //
      // Pure and deterministic — every signal is already in hand, so this
      // adds no tool call, no probe turn, and nothing that could fail and
      // take the run with it. Re-derived per attempt because the inputs
      // genuinely change per attempt: a revision round carries the
      // reviewer's directive and a higher round number, both of which the
      // scorer counts.
      const route = routeContextDocumentModel(
        INTEL_REPORT_DRAFT_MODEL_POLICY,
        {
          competitorCount: Math.max(clientContext.competitors.length, competitorSites?.length ?? 0),
          // Every evidence block the draft reads counts toward the fit decision, not just the category scan.
          evidenceChars: JSON.stringify([research.result ?? null, siteAudit, clientResearch?.result ?? null, competitorSites, seoGeoSnapshot]).length,
          clientContextChars: JSON.stringify({ profile: clientContext.profile, brand: brandVoice.brand }).length,
          steerCount:
            (runDirection.direction ? 1 : 0) + (directive !== undefined ? 1 : 0) + pastFeedback.length,
          revision,
        },
        { maxOutputTokens: INTEL_REPORT_DRAFT_MAX_TOKENS, ...options.contextDocumentRouting },
      );
      const draftAgent = new IntelReportDraftAgent(
        { router: options.router, tools, promptStore: options.promptStore },
        { modelPolicy: route.policy },
      );

      // Hoisted out of the call so the retry below sends byte-identical input.
      const draftInput = {
        ...runDirectionField(runDirection),
        profile: clientContext.profile,
        // The freshly-read kit, not step 00's checkpointed copy.
        brand: brandVoice.brand,
        // First-class, alongside the client context rather than buried inside
        // the brand-kit blob: the model reads a named `brandVoice` field
        // instead of having to go looking for `brand.voice`. Omitted entirely
        // when the client has no Brand Voice set, so a client without one
        // sends a byte-identical prompt to what it sent before.
        ...(brandVoice.voice !== undefined ? { brandVoice: brandVoice.voice } : {}),
        // The client's projected target-audience and market-strategy
        // context docs (T-A9), best-effort. See 01c/01d's own comment.
        ...(targetAudience !== undefined ? { targetAudience } : {}),
        ...(marketStrategy !== undefined ? { marketStrategy } : {}),
        competitors: clientContext.competitors,
        research: { query: research.query, result: research.result },
        // The evidence steps 01f-01i gathered, each under its own name so the
        // craft guide can say which dimension each one grounds. Omitted when
        // absent, so a run that could fetch nothing sends the prompt it always did.
        ...(siteAudit ? { siteAudit } : {}),
        ...(clientResearch ? { clientResearch: { query: clientResearch.query, result: clientResearch.result } } : {}),
        ...(competitorSites ? { competitorSites } : {}),
        ...(seoGeoSnapshot ? { seoGeoSnapshot } : {}),
        // Two distinct steers, kept apart on purpose: `pastFeedback` is what
        // this client has said across previous RUNS, `revisionRequest` is what
        // a reviewer asked about THIS report minutes ago.
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      };

      const draftResult = await wf.step.agent(rev("02-generate-report"), draftAgent, draftInput);

      // ── a draft that came back unusable gets ANOTHER draft, not a held run ──
      //
      // `content_fail` here does not mean the model judged the report
      // impossible — it means the turn came back without a parseable
      // structured output, the known long-no-tool-step shape where the type
      // discriminator is dropped. That is a coin flip, not a verdict, and
      // re-flipping it costs one drafting turn against a run that otherwise
      // ends with the client holding nothing. Its own step id, so the retry
      // checkpoints separately and a resumed run does not redo it.
      const usableDraft =
        draftResult.status === "content_fail"
          ? await wf.step.agent(rev("02a-regenerate-report"), draftAgent, draftInput)
          : draftResult;

      if (usableDraft.status === "content_fail") {
        // Twice is no longer a coin flip. Nothing was drafted, so there is no
        // content to repair and nothing this workflow can hand the client —
        // the honest outcome, and the one the engine retries.
        throw new WorkflowToolingFailure("report draft did not produce a valid structured output on two consecutive attempts");
      }
      if (usableDraft.status !== "completed") {
        throw new WorkflowToolingFailure(`report generation step resolved to "${usableDraft.status}"`);
      }
      const report = usableDraft.finalOutput!;

      // ── verify — every numeric claim across the 7 analysis sections must trace back
      // to the research pull's own content (RFC-05 §5 / §3 step 4's "reconcile the
      // score/grade discrepancy" note resolved: the model's dimension scores are real
      // judgment calls, never invented numbers to be caught here — this gate is about the
      // report's *prose* claims, e.g. "conversion rate improved 30%", not about the
      // dimension scores themselves). ──
      // Every evidence block is a source: a figure the site audit measured or
      // the SEO/GEO snapshot scored is as citable as one a web page stated.
      //
      // THE PROMPT'S EVIDENCE AND THE GATE'S SOURCES ARE THE SAME SET, and
      // keeping them in step is what makes the gate honest. Every block below
      // is one the drafting prompt above reads as fact, and a figure the draft
      // takes from one of them is quoted, not invented — so the client's own
      // profile and the two projected context documents belong here exactly as
      // much as the research pull does. They were missing, and the gap has a
      // shape: a report that correctly wrote "(context-provided: ...)" against
      // a figure stated in its market-strategy document had that figure
      // reported as unsourced, because the only place the gate was allowed to
      // look was the web research. Anything added to `draftInput` as evidence
      // has to be added here too.
      const sources = [
        research.query,
        JSON.stringify(research.result),
        JSON.stringify(clientContext.profile),
        ...(targetAudience !== undefined ? [JSON.stringify(targetAudience)] : []),
        ...(marketStrategy !== undefined ? [JSON.stringify(marketStrategy)] : []),
        ...(siteAudit ? [JSON.stringify(siteAudit)] : []),
        ...(clientResearch ? [clientResearch.query, JSON.stringify(clientResearch.result)] : []),
        ...(competitorSites ? [JSON.stringify(competitorSites)] : []),
        ...(seoGeoSnapshot ? [JSON.stringify(seoGeoSnapshot)] : []),
      ];

      // ── 02b: self-correction, BEFORE the gate rather than instead of it ──
      //
      // A held run is a report nobody gets, and the usual cause is one sentence
      // out of seven sections. This asks the gate what it would reject, and if
      // anything comes back, hands those exact claims to a bounded correction
      // pass: restate a range the source really states, or drop the figure and
      // make the point qualitatively.
      //
      // It runs only when the gate would fail, so a clean report costs nothing.
      // Its output goes through the real gate below unchanged, so it can improve
      // a report's chances and can never wave one through — a correction that
      // strips a figure badly, or introduces a new one, is held exactly as the
      // original would have been.
      const groundedReport = await wf.step.code(rev("02b-ground-numeric-claims"), async (): Promise<IntelReportOutput> => {
        const preVerdict = await runGate(tools, "gate.numbersSourced", { text: concatenateAnalysisProse(report), sources }, ctx);
        if (preVerdict.verdict !== "content_fail") return report;

        const flaggedClaims = preVerdict.evidence ?? [];
        const groundingAgent = new IntelReportGroundingAgent({ router: options.router, tools, promptStore: options.promptStore });
        const corrected = await groundingAgent.run(ctx, {
          flaggedClaims,
          sections: Object.fromEntries(ANALYSIS_FIELDS.map((field) => [field, report[field]])),
          sources,
        });
        // A correction pass that itself fails is not a reason to fail the run:
        // the original report still goes to the gate and is held there with the
        // same message it would have had. Losing the draft over a failed repair
        // would be strictly worse than not attempting one.
        if (corrected.status !== "completed" || !corrected.finalOutput) return report;

        const output = corrected.finalOutput;
        return { ...report, ...Object.fromEntries(ANALYSIS_FIELDS.map((field) => [field, output[field]])) };
      });

      // ── verify — every numeric claim across the 7 analysis sections must trace back
      // to the research pull's own content (RFC-05 §5 / §3 step 4's "reconcile the
      // score/grade discrepancy" note resolved: the model's dimension scores are real
      // judgment calls, never invented numbers to be caught here — this gate is about the
      // report's *prose* claims, e.g. "conversion rate improved 30%", not about the
      // dimension scores themselves). ──
      //
      // THIS STEP NO LONGER HOLDS THE RUN. It used to: a `content_fail` threw
      // `WorkflowHeld`, the run ended at `held`, and the client got an error
      // message where a report should have been — over, typically, one figure
      // in one sentence out of seven sections. Prep run
      // pubsub-21854296073980161 (2026-09-17) is the case that settled it:
      // $0.46 of research and drafting was discarded because the draft wrote
      // its source's "$5M-$30M ARR" range with an en dash, and the gate's
      // range pattern could not read a magnitude endpoint (fixed separately,
      // `numbers-sourced.ts` 1.6.0). A gate misreading is an INTERNAL fault;
      // billing it to the client as a failed deliverable is the wrong trade
      // even when the gate is right, because an unsourced figure is a reason
      // to drop that figure, never a reason to withhold six sound sections.
      //
      // So the gate keeps its full authority over what may be PUBLISHED — no
      // unsourced figure survives this step — and loses its authority to end
      // the run. Two repairs, in ascending order of bluntness:
      //
      //   1. the correction pass again, told exactly which figures survived
      //      its first attempt (02b gave it the gate's opening verdict; this
      //      gives it the residue). Kept only if it is strictly closer, so a
      //      bad rewrite can never make the report worse than what it got.
      //   2. the deterministic floor: drop the sentences that still carry an
      //      unsourced figure, and re-gate. No model, no judgment, no way for
      //      it to fail to converge.
      //
      // `tooling_error` still throws: a gate that could not run has made no
      // judgment at all, and pretending it passed would ship exactly the
      // unsourced figures this step exists to catch.
      const verified = await wf.step.code(
        rev("03-verify-numbers-sourced"),
        async (): Promise<{ report: IntelReportOutput; marker: IntelReportNumericGroundingMarker | null }> => {
          const gate = async (candidate: IntelReportOutput): Promise<GateVerdict> => {
            const verdict = await runGate(tools, "gate.numbersSourced", { text: concatenateAnalysisProse(candidate), sources }, ctx);
            if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
            return verdict;
          };

          let report = groundedReport;
          let verdict = await gate(report);
          if (verdict.verdict !== "content_fail") return { report, marker: null };

          // ── repair 1: the correction pass, handed the residue ──
          const retryAgent = new IntelReportGroundingAgent({ router: options.router, tools, promptStore: options.promptStore });
          const retry = await retryAgent.run(ctx, {
            flaggedClaims: verdict.evidence ?? [],
            sections: Object.fromEntries(ANALYSIS_FIELDS.map((field) => [field, report[field]])),
            sources,
          });
          if (retry.status === "completed" && retry.finalOutput) {
            const output = retry.finalOutput;
            const candidate: IntelReportOutput = {
              ...report,
              ...Object.fromEntries(ANALYSIS_FIELDS.map((field) => [field, output[field]])),
            };
            const retryVerdict = await gate(candidate);
            if (retryVerdict.verdict !== "content_fail") return { report: candidate, marker: null };
            if ((retryVerdict.evidence ?? []).length < (verdict.evidence ?? []).length) {
              report = candidate;
              verdict = retryVerdict;
            }
          }

          // ── repair 2: the floor ──
          //
          // Bounded, and each pass either removes at least one sentence or
          // reports that it located none and stops — so this terminates
          // whatever the gate keeps saying.
          const redactedFigures = new Set<string>();
          let residual = verdict.evidence ?? [];
          for (let pass = 0; pass < 3 && residual.length > 0; pass += 1) {
            const floor = redactUnsourcedClaims(report, residual);
            if (floor.droppedSentences === 0) break;
            for (const figure of floor.redactedFigures) redactedFigures.add(figure);
            report = floor.report;
            const after = await gate(report);
            residual = after.verdict === "content_fail" ? (after.evidence ?? []) : [];
          }

          return {
            report,
            marker: { redactedFigures: [...redactedFigures], unsourcedFigures: [...residual] },
          };
        },
      );

      // Outside the step body on purpose: a checkpointed step is REPLAYED
      // from its stored value on a resumed run and its body never runs again,
      // so a marker recorded inside it would vanish the moment this run came
      // back from its 24-hour review gate. Keyed by revision because only the
      // approved round's repairs describe the report that ships.
      numericGroundingByRevision.set(revision, verified.marker);

      return verified.report;
    };

    // ── The universal approve / revise / reject cycle ──
    //
    // `revise` re-generates with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and
    // forcing somebody to dispatch a fresh one that knows nothing about the
    // feedback. Every decision, approvals included, reaches client memory.
    const review = await runReviewCycle(wf, {
      gateId: "04-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (report, revision) => ({
        kind: "batch_review",
        payload: { runId: wf.runId, dimensionScores: report.dimensionScores, swot: report.swot, revision },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "auto_approve" },
      }),
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
      },
    });
    const report = review.output;
    /**
     * The repairs step 03 made to the round that was approved — not to the
     * last round attempted, which on an approve-after-revise run is the same
     * thing only by luck.
     */
    const numericGrounding = numericGroundingByRevision.get(review.revision) ?? null;
    /**
     * A reviewer who ran the cycle out of rounds, or who rejected outright,
     * recorded ON the report rather than ending the run.
     *
     * intel-report shares `runReviewCycle` with the six agents converted
     * alongside it, so it inherits the same behaviour; this is what makes the
     * reviewer's decision visible on the artefact they keep. Nothing here
     * publishes anything — an intel report is an internal document a human
     * reads — so what changes is that the report survives the rejection with
     * the reason attached, instead of the run ending and the drafted analysis
     * existing nowhere.
     */
    const reviewOutcome =
      review.outcome !== undefined && review.outcome !== "approved"
        ? { outcome: review.outcome, detail: review.outcomeDetail ?? review.outcome }
        : null;

    // ── 05: persist — intel.writeReport computes overallScore/overallGrade deterministically ──
    const writeOutcome = await wf.step.code("05-persist-report", async () => {
      const outcome = await tools["intel.writeReport"]!.execute(report, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`intel.writeReport failed: ${outcome.status}`);
      return outcome.result as { overallScore: number; overallGrade: string; competitorCount: number };
    });

    // ── 06-07: deliverable & manifest persistence — normal portal visibility for this run ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "06-persist-deliverable",
      persistManifestStepId: "07-persist-manifest",
      kind: "intel-report",
      deliverable: {
        ...report,
        ...writeOutcome,
        // SCRUM-242/SCRUM-388 (T-A10): the DEGRADED marker, on the actual
        // persisted deliverable a reviewer looks at — see 01e's own comment.
        ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
        // Same principle as the DEGRADED marker above: a report that reached
        // the client only because step 03 removed something says so on the
        // deliverable a reviewer opens, not only in a log line.
        ...(numericGrounding ? { numericGrounding } : {}),
        ...(reviewOutcome ? { reviewOutcome } : {}),
      },
      snapshot: (deliverableId) => ({ ...writeOutcome, deliverableId }),
    });

    // ── 08: record the review decision into durable client memory (AU22 + AU19) ──
    //
    // AU22: this step used to call `ledger.feedbackAppend`, which wrote to
    // `["ledger","feedback",runId,feedbackId]` — a path nothing in this repo
    // ever read back (no `ledger.readFeedback`/`ledger.listFeedback` tool was
    // ever registered), so every review decision here was a write into the
    // void. That tool is deleted as of AU22; the one real feedback pipeline is
    // `persistReviewFeedbackToMemory` (packages/workflow/src/primitives/
    // review-cycle.ts), which writes via `memory.appendFeedback` — the store
    // `memory.readFeedback`, and so `01b-read-past-feedback` above, actually
    // reads.
    //
    // AU19 (merged first) additionally wired `runReviewCycle`'s `onDecision`
    // to persist EVERY round's response, approvals included. This final-
    // decision write therefore lands on the same `review-feedback-r${revision}`
    // step id that `onDecision` already checkpointed for the approving round,
    // making it an idempotent backstop rather than a second record. It is kept
    // (rather than dropped) so this agent still carries the same explicit
    // 08-record-feedback step as the five other agents AU22 converted.
    //
    // `review.revision` — not a hardcoded 0 — is the round that was actually
    // approved: unlike the five agents in AU22's diff, this workflow HAS a
    // revision loop, so a report approved on round 2 must be recorded against
    // round 2.
    await persistReviewFeedbackToMemory(wf, tools, ctx, review.revision, review.response);

    return {
      overallScore: writeOutcome.overallScore,
      overallGrade: writeOutcome.overallGrade,
      competitorCount: writeOutcome.competitorCount,
      deliverableId,
      // SCRUM-242/SCRUM-388 (T-A10): same DEGRADED marker, on the workflow's
      // own typed return value — see 01e's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      ...(numericGrounding ? { numericGrounding } : {}),
      ...(reviewOutcome ? { reviewOutcome } : {}),
    };
  };
}
