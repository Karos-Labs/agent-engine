import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import {
  WorkflowToolingFailure,
  mergeResearchPulls,
  type ResearchCandidateDocument,
  type ResearchPullResult,
  type WorkflowContext,
} from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";

/**
 * Deep research — three lanes over one `research.pull`, in one code step
 * (RFC-13 §J, Phase 1).
 *
 * ## What was wrong
 *
 * `04a-research-pull` asked ONE question with `maxResults: 4`, a 24-hour
 * window and 4000 characters per document. Four same-day articles about one
 * subject is not a research base; it is a headline plus three restatements of
 * it. The audit's own numbers: every sampled prep run drafted from 4
 * documents, the extraction step returned 4-6 facts, and the copy agent
 * (which has no tools and cannot search) had to build 6-8 slides out of them,
 * so slides repeated the same figure and cited the article rather than the
 * study behind it.
 *
 * ## The three lanes, and why they are lanes rather than more queries
 *
 * Breadth alone would not have fixed it, because the three things a carousel
 * needs are on different clocks and at different depths:
 *
 * - **news** (7d, 6 results, 4000 chars): what happened. Short window on
 *   purpose — a "this week" claim from a 90-day window is a false present
 *   tense.
 * - **insight** (90d, 5 results, 6000 chars): reports, studies, surveys. The
 *   window is wide because a study published in June is still the best
 *   evidence in September, and the documents are read deeper because the
 *   figure a card needs is in the body, not the headline.
 * - **primary-domains** (90d, 4 results, 6000 chars): the same subject
 *   restricted to the publications the brief names (`referenceAccounts[]
 *   .domain`, the only field on that row that is a hostname) plus the
 *   client's own domain, so the field's real sources get a pass of their own
 *   instead of competing with news SEO. Skipped entirely when no reference
 *   publication resolved: the client's own domain alone is not a lane, it is
 *   one billed query asking a small site about this week's news.
 *
 * `pullResearchLanes` is deliberately its own function rather than a change to
 * `pullTrendResearch`: that primitive is shared with x/linkedin and its
 * one-window/one-size contract is exactly right for a scout. Two callers with
 * different needs is not a reason to make one of them configurable enough to
 * break the other.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Lane construction
// ─────────────────────────────────────────────────────────────────────────────

export type ResearchLaneName = "news" | "insight" | "primary-domains";

export interface ResearchLane {
  lane: ResearchLaneName;
  /** In priority order. Every one is a billed scrape (cached per (job, query, size) by `research.pull`). */
  queries: string[];
  /** Freshness window for this lane's pulls. */
  window: string;
  maxResults: number;
  contentChars: number;
  /** Present only on `primary-domains`. Reaches `SearchOptions.includeDomains`. */
  includeDomains?: string[];
}

export interface BuildResearchLanesInput {
  /** The grounded query from `buildGroundedQuery` (RFC-13 §C) — the news lane's first and best question. */
  groundedQuery: string;
  /** The subject the grounded query is about, without the client context clause. */
  subject: string;
  brief: ClientBrief;
  /** The client's own name, when known — `"<name>" <subject>` finds what was written about THEM. */
  companyName?: string | undefined;
  /** The year the insight lane asks for. Passed in rather than read from the clock so a resumed step is deterministic. */
  year: number;
  /** The client's own domain (hostname of `profile.website`). Joins the primary lane, but never carries it alone. */
  clientDomain?: string | undefined;
  /**
   * Hostnames of the publications the brief's reference accounts point at —
   * `referenceAccounts[].domain`, NOT `handle`. A handle is a social
   * identifier and never a host, so anything that is not a resolvable
   * hostname is dropped here rather than sent to the vendor as a filter that
   * matches nothing.
   */
  referenceDomains?: readonly string[] | undefined;
}

/** `research.pull`'s own `includeDomains` ceiling — asking for more would fail the tool's schema, not just be ignored. */
export const MAX_LANE_DOMAINS = 8;

const LANE_SIZES: Record<ResearchLaneName, { window: string; maxResults: number; contentChars: number }> = {
  news: { window: "7d", maxResults: 6, contentChars: 4000 },
  insight: { window: "90d", maxResults: 5, contentChars: 6000 },
  "primary-domains": { window: "90d", maxResults: 4, contentChars: 6000 },
};

function tidy(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** First clause, word-clamped — a search index degrades on a whole paragraph. */
function clause(text: string | undefined, maxWords: number): string | undefined {
  const normalised = tidy(text);
  if (normalised === undefined) return undefined;
  const first = normalised.split(/(?<=[.;])\s+/u)[0] ?? normalised;
  const words = first.split(" ");
  return words.length <= maxWords ? first : words.slice(0, maxWords).join(" ");
}

/** De-duplicated, case-insensitively, keeping order. */
function uniqueQueries(queries: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const query of queries) {
    const trimmed = tidy(query);
    if (trimmed === undefined) continue;
    if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) continue;
    out.push(trimmed);
  }
  return out;
}

/** A hostname, stripped of `www.` and any scheme/path the caller passed by mistake. Lowercased. */
export function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  const host = withoutScheme.split("/")[0]!.replace(/^www\./u, "");
  return host.includes(".") ? host : undefined;
}

/**
 * The three lanes for this run's subject. Pure — every input is already
 * resolved by the time the step runs, so the same run resumes to the same
 * questions.
 *
 * A query is omitted rather than emitted half-empty: a client with no core
 * terms does not get `"<subject> undefined"`, it gets one fewer question.
 * `primary-domains` disappears entirely when there is no domain to ask about,
 * which is the honest shape — a lane with no filter would just be a fourth
 * open-web query.
 */
export function buildResearchLanes(input: BuildResearchLanesInput): ResearchLane[] {
  const { brief, year } = input;
  const subject = tidy(input.subject) ?? tidy(input.groundedQuery) ?? "";
  const terms = brief.coreTerms.map((t) => tidy(t)).filter((t): t is string => t !== undefined);
  const company = tidy(input.companyName);

  const lanes: ResearchLane[] = [];

  // The core term the news lane pairs with the subject is the first one the
  // subject does NOT already contain — `fallbackQuery` in `client-brief.ts`
  // does the same, for the same reason: "widgets widgets" is a billed query
  // that asks the first question again.
  const pairingTerm = terms.find((term) => !subject.toLowerCase().includes(term.toLowerCase()));

  const news = uniqueQueries([
    input.groundedQuery,
    pairingTerm !== undefined && subject.length > 0 ? `${subject} ${pairingTerm}` : undefined,
    company !== undefined && subject.length > 0 ? `"${company}" ${subject}` : undefined,
  ]);
  if (news.length > 0) lanes.push({ lane: "news", queries: news, ...LANE_SIZES.news });

  const insight = uniqueQueries([
    terms.length > 0 ? `${terms.slice(0, 2).join(" ")} report OR study OR survey ${year}` : undefined,
    terms[0] !== undefined ? `${clause(brief.icp.summary, 8) ?? ""} ${terms[0]} data`.trim() : undefined,
  ]);
  if (insight.length > 0) lanes.push({ lane: "insight", queries: insight, ...LANE_SIZES.insight });

  const clientDomain = input.clientDomain === undefined ? undefined : normalizeDomain(input.clientDomain);
  // The client's own domain, when there is one, is first in and therefore
  // never the row squeezed out by the tool's eight-domain ceiling.
  const referenceRoom = MAX_LANE_DOMAINS - (clientDomain === undefined ? 0 : 1);
  const referenceDomains: string[] = [];
  for (const candidate of input.referenceDomains ?? []) {
    const domain = normalizeDomain(candidate);
    if (domain === undefined || domain === clientDomain || referenceDomains.includes(domain)) continue;
    referenceDomains.push(domain);
    if (referenceDomains.length === referenceRoom) break;
  }
  // The lane runs only when at least one REFERENCE publication resolved. The
  // client's own domain rides along when it does, but on its own it is not a
  // lane: a keyword search restricted to one small site, asking about this
  // week's subject, is a billed query that cannot answer — and the client's
  // own material already reaches the research base by two cheaper routes
  // (`04a3`'s client-domain preference among the merged documents, and
  // `clientDocuments`, which cost nothing at all).
  if (referenceDomains.length > 0 && subject.length > 0) {
    const domains = clientDomain !== undefined ? [clientDomain, ...referenceDomains] : referenceDomains;
    lanes.push({ lane: "primary-domains", queries: [subject], ...LANE_SIZES["primary-domains"], includeDomains: domains.slice(0, MAX_LANE_DOMAINS) });
  }

  return lanes;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pull
// ─────────────────────────────────────────────────────────────────────────────

export interface ResearchLaneQueryOutcome {
  query: string;
  /** The tool outcome status, or `"success"`. */
  status: string;
  documents: number;
  fromCache: boolean;
}

export interface ResearchLaneOutcome {
  lane: ResearchLaneName;
  queries: ResearchLaneQueryOutcome[];
}

/** How many unique documents a carousel's research base should reach. Below it the step still succeeds — with a note. */
export const DEEP_RESEARCH_DOCUMENT_FLOOR = 12;

export interface DeepResearchResult {
  lanes: ResearchLaneOutcome[];
  /** Every lane's documents merged and de-duplicated by URL — what the extraction step reads. */
  merged: ResearchPullResult;
  documentCount: number;
  /** How many queries actually reached the vendor (a cache hit is free) — what the run's spend meter bills. */
  billedPulls: number;
  /** Set when the base came in thin or a query failed. Never a hold: thin research is a quality note, an outage is a `WorkflowToolingFailure`. */
  note?: string;
}

/**
 * Runs every lane's every query through `research.pull` and merges the
 * answers, in ONE code step.
 *
 * One step, three reasons: the trace shows one research step as it always
 * did, a resumed run replays the whole merged result rather than re-billing
 * some of it, and the per-query record below is what makes a thin base
 * diagnosable ("the insight lane's two queries both returned nothing")
 * instead of just small.
 *
 * A single failing query is recorded and skipped. The step fails as a whole
 * only when EVERY query failed — `pullTrendResearch`'s rule, for the same
 * reason: an outage is tooling, never "the subject had nothing to say".
 */
export async function pullResearchLanes(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: {
    stepId: string;
    lanes: readonly ResearchLane[];
    job: string;
    historyAgentId: string;
  },
): Promise<DeepResearchResult> {
  return wf.step.code(options.stepId, async (): Promise<DeepResearchResult> => {
    const pull = tools["research.pull"];
    if (!pull) throw new Error(`${options.stepId}: research.pull is not registered`);
    if (options.lanes.length === 0) {
      throw new WorkflowToolingFailure(`${options.stepId}: no research lanes were built — there was no subject and no client brief to ground one in`);
    }

    const laneOutcomes: ResearchLaneOutcome[] = [];
    const pulls: ResearchPullResult[] = [];
    const failures: string[] = [];
    let billedPulls = 0;

    for (const lane of options.lanes) {
      const queries: ResearchLaneQueryOutcome[] = [];
      for (const query of lane.queries) {
        const outcome = await pull.execute(
          {
            job: options.job,
            query,
            window: lane.window,
            maxResults: lane.maxResults,
            contentChars: lane.contentChars,
            historyAgentId: options.historyAgentId,
            ...(lane.includeDomains && lane.includeDomains.length > 0 ? { includeDomains: lane.includeDomains } : {}),
          },
          { ctx },
        );
        if (outcome.status !== "success") {
          failures.push(`${lane.lane}: "${query}" -> ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`);
          queries.push({ query, status: outcome.status, documents: 0, fromCache: false });
          continue;
        }
        const result = outcome.result as ResearchPullResult;
        pulls.push(result);
        if (!result.fromCache) billedPulls++;
        queries.push({ query, status: "success", documents: result.result?.documents?.length ?? 0, fromCache: result.fromCache });
      }
      laneOutcomes.push({ lane: lane.lane, queries });
    }

    if (pulls.length === 0) {
      throw new WorkflowToolingFailure(`research.pull failed for every deep-research query (${failures.join("; ") || "no queries"})`);
    }

    const merged = mergeResearchPulls(pulls);
    const documentCount = merged.result?.documents?.length ?? 0;
    const notes: string[] = [];
    if (documentCount < DEEP_RESEARCH_DOCUMENT_FLOOR) {
      notes.push(`deep research merged ${documentCount} unique documents, below the ${DEEP_RESEARCH_DOCUMENT_FLOOR} this step aims for`);
    }
    if (failures.length > 0) notes.push(`queries that did not answer — ${failures.join("; ")}`);

    return {
      lanes: laneOutcomes,
      merged,
      documentCount,
      billedPulls,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A URL that looks like the SOURCE rather than coverage of it: a PDF, a
 * report/research/study path, a whitepaper, a government/academic domain.
 *
 * Deliberately a URL-shape heuristic and not a judgment call: it decides
 * which two pages get fetched in full, and a wrong guess costs one scrape and
 * a page nobody cites, while a model call to decide it would cost more than
 * the fetch.
 */
export const PRIMARY_SOURCE_URL = /\.pdf$|\/report|\/research|\/study|whitepaper|\.gov\b|\.edu\b|\.ac\./i;

/** True when this document is the source itself: a primary-looking URL, or the client's own domain. */
export function looksPrimary(document: Pick<ResearchCandidateDocument, "url">, clientDomain?: string): boolean {
  const url = document.url;
  if (typeof url !== "string" || url.length === 0) return false;
  if (PRIMARY_SOURCE_URL.test(url)) return true;
  const domain = clientDomain === undefined ? undefined : normalizeDomain(clientDomain);
  if (domain === undefined) return false;
  const host = normalizeDomain(url);
  return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
}

/**
 * The (at most `max`) URLs worth spending a full-page fetch on.
 *
 * Two, because `research.fetchPages` costs a scrape each and 8000 characters
 * of a report is already more evidence than a carousel can carry — and
 * because the extraction step reads every merged document's excerpt anyway;
 * this is about getting the paragraph the figure is in, not about reading
 * more sources.
 */
export function pickPrimarySourceUrls(merged: ResearchPullResult, clientDomain?: string, max = 2): string[] {
  const urls: string[] = [];
  for (const document of merged.result?.documents ?? []) {
    if (!looksPrimary(document, clientDomain)) continue;
    const url = document.url!;
    if (urls.includes(url)) continue;
    urls.push(url);
    if (urls.length === max) break;
  }
  return urls;
}

/** A document with the extraction step's `primary` marker on it — client material and fetched primary pages arrive already marked. */
export type OrderableDocument = ResearchCandidateDocument & { readonly primary?: boolean };

/**
 * Primary sources first, everything else in the order it was merged.
 *
 * The extraction prompt asks the model to prefer and mark primary sources,
 * and a prompt instruction competes with reading order: what it sees first is
 * what it cites. Ordering here means the instruction and the input agree.
 * Stable within each group, so a lane's own ranking survives.
 */
export function orderDocumentsPrimaryFirst<T extends OrderableDocument>(documents: readonly T[], clientDomain?: string): T[] {
  return [...documents.entries()]
    .sort((a, b) => {
      const rank = (entry: [number, T]): number => (entry[1].primary === true || looksPrimary(entry[1], clientDomain) ? 0 : 1);
      return rank(a) - rank(b) || a[0] - b[0];
    })
    .map(([, document]) => document);
}
