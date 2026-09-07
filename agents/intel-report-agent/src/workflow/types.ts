import type { ClientBrand, ClientProfile, Competitor } from "@agent-engine/tools";
import type { DegradedContextGroundingMarker } from "@agent-engine/workflow";

/**
 * Step 00's output: the tenant context every later step reads from
 * (RFC-05 §3 step 1). `profile` is the only hard requirement — a missing
 * profile blocks the run entirely (same pattern as every other agent's
 * intake check); `brand`/`competitors` degrade gracefully to an empty
 * shape when the client hasn't set them up yet, since neither is required
 * to attempt a report (a client with no tracked competitors still gets
 * scored on their own content/positioning/etc.).
 */
export interface IntelReportClientContext {
  profile: ClientProfile;
  brand: ClientBrand;
  competitors: Competitor[];
}

/**
 * Step 01's output — the competitive research pull's result, carried
 * forward as both the draft agent's evidence base and (stringified) the
 * `sources` array `gate.numbersSourced` checks the generated report's
 * numeric claims against (RFC-05 §5).
 */
export interface IntelReportResearch {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
}

/** One audited page of the client's (or a competitor's) site, compacted for the drafting prompt: what a reader would see, not the raw markup. */
export interface IntelReportAuditedPage {
  url: string;
  title?: string;
  metaDescription?: string;
  h1?: string;
  /** H2/H3 texts in order, capped. */
  headings: string[];
  wordCount: number;
  dateModified?: string;
  authorByline: boolean;
  schemaTypes: string[];
  internalLinkCount: number;
  externalDomains: string[];
  images: { total: number; withAlt: number };
  /** The first few hundred characters of main text — what the page actually says. */
  excerpt: string;
}

/**
 * Step 01f's output: the client's own site, fetched and read. The report's
 * content, conversion, SEO and brand dimensions used to be judged with no
 * page of the client's site in evidence — every "the homepage does X" was a
 * guess. `pages` is what the site says; `site` is what its markup does.
 */
export interface IntelReportSiteAudit {
  seedUrl: string;
  pagesAudited: number;
  pages: IntelReportAuditedPage[];
  site: {
    https: boolean;
    llmsTxtPresent: boolean;
    jsonLdTypes: string[];
    pagesWithDateModified: number;
    pagesWithSingleH1: number;
    pagesWithMetaDescription: number;
    /** From the technical crawl: URLs that answered 200 out of those checked. */
    reachable?: { ok: number; checked: number };
    /** Crawler names the root robots.txt disallows, among the AI/search bots the SEO/GEO config checks. */
    robotsBlocks: string[];
    sitemapEntries?: number;
    sitemapNewestLastmod?: string;
    longestPublishingGapDays?: number;
  };
  /** Plain-language observations, each derived from a field above — quotable as `context-provided:` evidence. */
  facts: string[];
}

/** Step 01g's output: live web research about the CLIENT by name, separate from the category scan. */
export interface IntelReportClientResearch {
  runId: string;
  query: string;
  result: unknown;
  fromCache: boolean;
}

/** Step 01h's output: competitor homepages, fetched and read — so a competitor contrast names what the competitor's own site says. */
export interface IntelReportCompetitorSite {
  name: string;
  page: IntelReportAuditedPage;
}

/**
 * Step 01i's output: the latest SEO & GEO run's compact handoff, read from
 * client memory (`seoGeoLatestSnapshot`, written by seo-geo-agent's step 20).
 * Loose on purpose — the two workflows never import each other (RFC-05 §2),
 * so this is a cross-agent wire shape read defensively.
 */
export type IntelReportSeoGeoSnapshot = Record<string, unknown>;

/**
 * What this workflow hands back to its caller: the deterministically
 * computed score/grade (never trusted to the model, RFC-05 §3 step 4 /
 * `karos-intel`'s `scoring.ts`) plus enough bookkeeping to find the
 * persisted deliverable and report record.
 */
export interface IntelReportAgentWorkflowResult {
  overallScore: number;
  overallGrade: string;
  competitorCount: number;
  deliverableId: string;
  /**
   * SCRUM-242/SCRUM-388 (T-A10) — present when this run's target-audience and
   * market-strategy context docs were both absent. Recurring runs never reach
   * this: intel-report-agent's row is BLOCK, not DEGRADED, so a recurring run
   * with zero grounding throws `WorkflowBlockedIntake` and never returns a
   * result at all. This field is reachable only via SCRUM-388's bootstrap
   * exemption — a `runKind: "setup"` run producing these documents for the
   * first time degrades instead of blocking, and a human/the portal must see
   * that this particular report is the ungrounded bootstrap one, not a
   * silently-degraded recurring report.
   */
  contextGrounding?: DegradedContextGroundingMarker;
}
