import { inputKeyFor, type InputMeasurement, type InputMeasurementData, type ScoringBucketConfig } from "@agent-engine/tool-karos-seo-geo";
import { isPathDisallowed } from "@agent-engine/tool-karos-scraper";
import type { CoreWebVitalsSnapshot, EntitySnapshot, OnPageAuditSnapshot, PageSignals, TechnicalSeoSnapshot } from "@agent-engine/tools";
import { daysSince, isEntityPageUrl, median, p75 } from "@agent-engine/tools";

/** A schema-valid placeholder `InputMeasurementData`, matched to the input's own normalization kind. Never read: `evaluateScoreFamily` only calls `evaluateNorm` when `coverage === "measured"` (see `karos-seo-geo/src/evaluate-scores.ts`), and every measurement this function produces is `coverage: "unavailable"`. */
function placeholderDataFor(normalization: string): InputMeasurementData {
  switch (normalization) {
    case "boolean":
      return { kind: "boolean", measured: false };
    case "count_with_target":
      return { kind: "count", actual: 0 };
    case "ratio_clamp":
      return { kind: "ratio", value: 0 };
    case "percentage":
      return { kind: "percentage", valuePct: 0 };
    case "lower_is_better_stepped":
      return { kind: "stepped", value: 0 };
    case "multi_bool":
      return { kind: "multiBool", subBools: [] };
    case "combine":
      return { kind: "combine", fields: {} };
    default:
      return { kind: "boolean", measured: false };
  }
}

/**
 * Phase 2 (RFC-04 §2): honest, unmeasured placeholder for every input this
 * bucket set declares — `coverage: "unavailable"`, never a fabricated
 * boolean/count. `buildTechnicalMeasurements` starts from this and overrides
 * only what a real snapshot supports; a caller with no snapshots at all gets
 * exactly this back.
 */
export function buildUnavailableMeasurements(buckets: readonly ScoringBucketConfig[]): Record<string, InputMeasurement> {
  const measurements: Record<string, InputMeasurement> = {};
  for (const bucket of buckets) {
    bucket.inputs.forEach((input, index) => {
      const inputKey = inputKeyFor(bucket.name, index);
      measurements[inputKey] = { data: placeholderDataFor(input.params.normalization), coverage: "unavailable" };
    });
  }
  return measurements;
}

/** The 5 crawler user-agents `crawler_snippet_access[2]`'s GEO-01 multi_bool checks — verbatim from `scoring-config.data.ts`'s own measure text. */
const GEO01_ROBOTS_LEGS = ["OAI-SearchBot", "PerplexityBot", "ClaudeBot", "Googlebot", "Bingbot"] as const;
/** GEO-10's four entity-page legs. */
const GEO10_ROBOTS_LEGS = ["OAI-SearchBot", "PerplexityBot", "ClaudeBot", "Googlebot"] as const;

/** A page this snapshot crawled whose `noindex` is a known fact (never `undefined`) — the subset every noindex-dependent ratio below is honestly computed over. */
function pagesWithKnownNoindex(snapshot: TechnicalSeoSnapshot): Array<{ url: string; status: number; noindex: boolean }> {
  return snapshot.pages.filter((p): p is { url: string; status: number; noindex: boolean } => p.noindex !== undefined);
}

function ratioMeasurement(numerator: number, denominator: number): InputMeasurement {
  return { data: { kind: "ratio", value: denominator > 0 ? numerator / denominator : 0 }, coverage: "measured" };
}

function booleanMeasurement(value: boolean): InputMeasurement {
  return { data: { kind: "boolean", measured: value }, coverage: "measured" };
}

function multiBoolMeasurement(subBools: boolean[]): InputMeasurement {
  return { data: { kind: "multiBool", subBools }, coverage: "measured" };
}

function steppedMeasurement(value: number): InputMeasurement {
  return { data: { kind: "stepped", value }, coverage: "measured" };
}

function countMeasurement(actual: number): InputMeasurement {
  return { data: { kind: "count", actual }, coverage: "measured" };
}

function combineMeasurement(fields: Record<string, number | boolean>): InputMeasurement {
  return { data: { kind: "combine", fields }, coverage: "measured" };
}

const share = (pages: readonly PageSignals[], predicate: (p: PageSignals) => boolean): number => (pages.length > 0 ? pages.filter(predicate).length / pages.length : 0);
/** "Most pages" — the threshold a page-level boolean has to clear across the audited set before the site-level leg is called a pass. */
const MOST = 0.5;
/** "Nearly every page" — for legs the config words as absolutes (a single H1, zero heading skips), where one odd template page should not fail the site. */
const NEARLY_ALL = 0.9;

/** Robots meta legs of BOTH-01's full-snippet eligibility, when the on-page audit saw the page. */
function snippetBlockedByMeta(page: PageSignals | undefined): boolean {
  return page !== undefined && (page.metaRobots.noindex || page.metaRobots.nosnippet || page.metaRobots.maxSnippetZero);
}

function normaliseUrl(u: string): string {
  return u.replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
}

/** Where a page's `<h1>` opening or each `<h2>` has a 40-60 word first paragraph — GEO-02's "self-contained capsule". */
function capsuleShare(page: PageSignals): { passed: number; targets: number } {
  let targets = 0;
  let passed = 0;
  if (page.openingCapsule) {
    targets += 1;
    if (page.openingCapsule.wordCount >= 40 && page.openingCapsule.wordCount <= 60 && page.openingCapsule.bodyOffsetRatio <= 0.3) passed += 1;
  }
  for (const heading of page.headings) {
    if (heading.level !== 2) continue;
    targets += 1;
    if (heading.firstParagraphWordCount >= 40 && heading.firstParagraphWordCount <= 60) passed += 1;
  }
  return { passed, targets };
}

/** Section word counts a reader would call "sections": the heading-delimited blocks with any text. */
function sections(page: PageSignals): number[] {
  return page.sectionWordCounts.filter((w) => w > 0);
}

/** Question-form H2/H3s answered in at most 80 words before the next heading — GEO-22. */
function answeredQuestionHeadings(page: PageSignals): number {
  return page.headings.filter((h) => (h.level === 2 || h.level === 3) && h.isQuestion && h.sectionWordCount > 0 && h.sectionWordCount <= 80).length;
}

/**
 * The days since a page's `dateModified`, with the sitemap `<lastmod>` as the
 * consistency check the config asks for ("consistent w/ sitemap lastmod").
 * A page with no `dateModified` markup at all is a real observation — the
 * signal engines read is absent — so it counts as very old, not as unknown.
 */
function modifiedAgeDays(page: PageSignals, lastmodByUrl: Record<string, string> | undefined, now: number): { ageDays: number; consistent: boolean; hasDate: boolean } {
  const age = daysSince(page.dateModified, now);
  if (age === undefined) return { ageDays: 3650, consistent: false, hasDate: false };
  const lastmod = lastmodByUrl ? (lastmodByUrl[page.finalUrl] ?? lastmodByUrl[page.url] ?? Object.entries(lastmodByUrl).find(([u]) => normaliseUrl(u) === normaliseUrl(page.finalUrl))?.[1]) : undefined;
  const lastmodAge = daysSince(lastmod, now);
  // No sitemap date to compare against: the on-page date stands on its own.
  const consistent = lastmodAge === undefined ? true : Math.abs(lastmodAge - age) <= 3;
  return { ageDays: age, consistent, hasDate: true };
}

export interface MeasurementSources {
  technical?: TechnicalSeoSnapshot | undefined;
  onPage?: OnPageAuditSnapshot | undefined;
  coreWebVitals?: CoreWebVitalsSnapshot | undefined;
  entity?: EntitySnapshot | undefined;
  /** Injected for deterministic tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Builds the SEO or GEO-Readiness measurement set from whatever real
 * snapshots this run has — the technical crawl (`research.crawlTechnicalSeo`),
 * the on-page audit (`research.auditOnPage`), Core Web Vitals
 * (`research.fetchCoreWebVitals`) and the brand's Wikidata/Wikipedia standing
 * (`research.lookupEntity`). Every override is a directly observed fact from
 * one of those fetches; every input none of them can honestly answer stays
 * `coverage: "unavailable"` exactly as before, which today means: anything
 * needing a Search Console / Bing / Brave connector, a NER or sentiment
 * classifier, a backlink export, a review feed, or the frozen top-10 SERP
 * snapshot the shingle-differentiation checks compare against.
 *
 * Keyed by `(bucket.name, index)` via `inputKeyFor` rather than `recId` —
 * several `rec_id`s repeat across distinct legs within one bucket (`BOTH-01`
 * appears twice in `eligibility` alone), and the index is what
 * `evaluateScoreFamily` itself keys on.
 *
 * Where a config leg is a site-level absolute measured per page ("h1 == 1"),
 * the site passes when nearly every audited page does (`NEARLY_ALL`); where
 * it is a property most pages should have (a byline, a stat), most pages
 * (`MOST`). Both thresholds are named constants so the choice is visible.
 */
export function buildTechnicalMeasurements(
  buckets: readonly ScoringBucketConfig[],
  snapshotOrSources: TechnicalSeoSnapshot | MeasurementSources | undefined,
): Record<string, InputMeasurement> {
  const sources: MeasurementSources =
    snapshotOrSources === undefined ? {} : "pages" in snapshotOrSources && "seedUrl" in snapshotOrSources ? { technical: snapshotOrSources as TechnicalSeoSnapshot } : (snapshotOrSources as MeasurementSources);
  const measurements = buildUnavailableMeasurements(buckets);
  const snapshot = sources.technical;
  const onPage = sources.onPage;
  const pages = onPage?.pages.filter((p) => p.status === 200) ?? [];
  const cwv = sources.coreWebVitals;
  const entity = sources.entity;
  const now = sources.now ?? Date.now();
  if (!snapshot && pages.length === 0 && !cwv && !entity) return measurements;

  const onPageByUrl = new Map<string, PageSignals>();
  for (const page of pages) {
    onPageByUrl.set(normaliseUrl(page.url), page);
    onPageByUrl.set(normaliseUrl(page.finalUrl), page);
  }

  const knownPages = snapshot ? pagesWithKnownNoindex(snapshot) : [];
  const reachableCount = knownPages.filter((p) => p.status === 200 && !p.noindex && !snippetBlockedByMeta(onPageByUrl.get(normaliseUrl(p.url)))).length;
  const noNoindexCount = knownPages.filter((p) => !p.noindex && !onPageByUrl.get(normaliseUrl(p.url))?.metaRobots.noindex).length;
  const notAuthWalledCount = snapshot ? snapshot.pages.filter((p) => p.status !== 401 && p.status !== 403 && p.status > 0).length : 0;
  const sitemapPresentAndValid = (snapshot?.sitemap?.entries.length ?? 0) > 0;
  const sitemapLineInRobots = (snapshot?.robots?.sitemaps.length ?? 0) > 0;
  const sitemapClean = sitemapPresentAndValid && sitemapLineInRobots && (knownPages.length === 0 || noNoindexCount === knownPages.length);

  const entityPages = pages.filter((p) => isEntityPageUrl(p.finalUrl) || isEntityPageUrl(p.url));
  const entityPaths = (entityPages.length > 0 ? entityPages : pages.slice(0, 1)).map((p) => {
    try {
      return new URL(p.finalUrl).pathname || "/";
    } catch {
      return "/";
    }
  });
  const capsules = pages.map(capsuleShare).reduce((acc, c) => ({ passed: acc.passed + c.passed, targets: acc.targets + c.targets }), { passed: 0, targets: 0 });
  const allSections = pages.flatMap(sections);
  const ages = pages.map((p) => modifiedAgeDays(p, onPage?.sitemap?.lastmodByUrl, now));
  const latinPages = pages.filter((p) => p.fleschReadingEase !== null);

  for (const bucket of buckets) {
    // ── SEO family ───────────────────────────────────────────────────────
    if (bucket.name === "eligibility" && snapshot) {
      // BOTH-01 full-snippet eligibility leg: HTTP 200, no noindex, and (when the page was audited) no nosnippet / max-snippet:0.
      if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(reachableCount, knownPages.length);
      // BOTH-02: reachable, anonymous, crawlable HTML (no auth/paywall status).
      if (snapshot.pages.length > 0) measurements[inputKeyFor(bucket.name, 1)] = ratioMeasurement(notAuthWalledCount, snapshot.pages.length);
      // BOTH-01 isolated noindex-only leg (header or robots meta).
      if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 2)] = ratioMeasurement(noNoindexCount, knownPages.length);
      // BOTH-09: sitemap 200 + valid XML AND Sitemap: line in robots.txt AND 0 noindex among the crawled set.
      measurements[inputKeyFor(bucket.name, 3)] = booleanMeasurement(sitemapClean);
      // index 4 (GEO-01) needs `gsc_ai_optout` from a GSC connector this environment does not have — left unavailable.
    }

    if (bucket.name === "technical_cwv") {
      // SEO-04 x3: CrUX p75 field data only — a Lighthouse lab number is a single synthetic load, not a p75.
      if (cwv?.field?.lcpP75Ms !== undefined) measurements[inputKeyFor(bucket.name, 0)] = steppedMeasurement(cwv.field.lcpP75Ms / 1000);
      if (cwv?.field?.inpP75Ms !== undefined) measurements[inputKeyFor(bucket.name, 1)] = steppedMeasurement(cwv.field.inpP75Ms);
      if (cwv?.field?.clsP75 !== undefined) measurements[inputKeyFor(bucket.name, 2)] = steppedMeasurement(cwv.field.clsP75);
      // BOTH-19: viewport meta present (on every audited page) AND Lighthouse's mobile viewport audit passes. The
      // 360px text-diff and horizontal-scroll legs need a rendered layout this environment has no browser for, so
      // this input is measured on its viewport legs only — stated here rather than silently widened.
      const viewportAudit = cwv?.lab?.audits["viewport"];
      if (pages.length > 0 && viewportAudit !== undefined) {
        measurements[inputKeyFor(bucket.name, 3)] = booleanMeasurement(share(pages, (p) => p.viewportMeta) >= NEARLY_ALL && viewportAudit);
      }
    }

    if (bucket.name === "on_page" && pages.length > 0) {
      // index 0 (BOTH-03) needs the frozen top-10 SERP snapshot for the shingle comparison — unavailable.
      // SEO-02: title length, taken at the 75th percentile across audited pages so one long title shows.
      measurements[inputKeyFor(bucket.name, 1)] = steppedMeasurement(p75(pages.map((p) => p.titleLength)));
      // GEO-17: single H1 on nearly every audited page.
      measurements[inputKeyFor(bucket.name, 2)] = booleanMeasurement(share(pages, (p) => p.h1Count === 1) >= NEARLY_ALL);
      // SEO-06: description present, 120-158 chars, and unique across the audited set.
      const descriptions = pages.map((p) => p.metaDescription?.trim().toLowerCase()).filter((d): d is string => Boolean(d));
      const duplicates = new Set(descriptions.filter((d, i) => descriptions.indexOf(d) !== i));
      measurements[inputKeyFor(bucket.name, 3)] = ratioMeasurement(
        pages.filter((p) => p.metaDescription && p.metaDescriptionLength >= 120 && p.metaDescriptionLength <= 158 && !duplicates.has(p.metaDescription.trim().toLowerCase())).length,
        pages.length,
      );
      // BOTH-05: in-content internal links per page (median), target 3.
      measurements[inputKeyFor(bucket.name, 4)] = countMeasurement(median(pages.map((p) => p.internalLinkCount)));
      // GEO-20 (on-page leg): days since a sitemap-consistent dateModified, median across pages. A page with no
      // date is counted as very old — the freshness signal engines read is absent, which is the finding.
      measurements[inputKeyFor(bucket.name, 5)] = steppedMeasurement(median(ages.map((a) => (a.consistent ? a.ageDays : 3650))));
    }

    if (bucket.name === "structure" && pages.length > 0) {
      // GEO-02: share of H1 openings + H2s with a 40-60 word first paragraph.
      if (capsules.targets > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(capsules.passed, capsules.targets);
      // BOTH-16: share of sections 120-180 words, zeroed when any section runs past 300.
      if (allSections.length > 0) {
        const inRange = allSections.filter((w) => w >= 120 && w <= 180).length;
        measurements[inputKeyFor(bucket.name, 1)] = ratioMeasurement(allSections.some((w) => w > 300) ? 0 : inRange, allSections.length);
      }
    }

    if (bucket.name === "hygiene_and_reserve" && pages.length > 0) {
      // GEO-39: JSON-LD present and every block parses.
      measurements[inputKeyFor(bucket.name, 0)] = booleanMeasurement(pages.every((p) => p.jsonLd.parseErrors === 0) && pages.some((p) => p.jsonLd.blocks > 0));
      // GEO-40: /llms.txt answers 200 with text.
      if (onPage) measurements[inputKeyFor(bucket.name, 1)] = booleanMeasurement(onPage.llmsTxt.present);
      // BOTH-20: HTTPS everywhere, no http:// resources.
      measurements[inputKeyFor(bucket.name, 2)] = booleanMeasurement(pages.every((p) => p.https && p.mixedContentCount === 0));
      // index 3 (SEO-05, soft-404s/redirect chains) needs a status-chain crawl — unavailable.
      // BOTH-07: every declared canonical is absolute and on-site (pages with none are not counted against it).
      const withCanonical = pages.filter((p) => p.canonicalValid !== undefined);
      if (withCanonical.length > 0) measurements[inputKeyFor(bucket.name, 4)] = booleanMeasurement(withCanonical.every((p) => p.canonicalValid === true));
      // index 5 (BOTH-08, raw vs rendered word count) needs a rendered DOM — unavailable.
      // SEO-08: alt-text coverage across every image seen.
      const totals = pages.reduce((acc, p) => ({ total: acc.total + p.images.total, withAlt: acc.withAlt + p.images.withAlt }), { total: 0, withAlt: 0 });
      if (totals.total > 0) measurements[inputKeyFor(bucket.name, 6)] = ratioMeasurement(totals.withAlt, totals.total);
    }

    // ── GEO-Readiness family ─────────────────────────────────────────────
    if (bucket.name === "crawler_snippet_access") {
      if (snapshot) {
        if (knownPages.length > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(reachableCount, knownPages.length);
        if (snapshot.robots && snapshot.pages.length > 0) {
          const notDisallowedForGooglebot = snapshot.pages.filter((p) => p.status === 200 && !isPathDisallowed(snapshot.robots!, new URL(p.url).pathname, "Googlebot")).length;
          measurements[inputKeyFor(bucket.name, 1)] = ratioMeasurement(notDisallowedForGooglebot, snapshot.pages.length);
        }
        if (snapshot.robots) {
          measurements[inputKeyFor(bucket.name, 2)] = multiBoolMeasurement(GEO01_ROBOTS_LEGS.map((bot) => !isPathDisallowed(snapshot.robots!, "/", bot)));
          // index 3 (GEO-08) pairs OAI-SearchBot access with a Bing site: count this environment cannot read — unavailable.
          // GEO-10: the four AI crawlers may reach the entity/about pages (the homepage when the crawl found none).
          const robots = snapshot.robots;
          measurements[inputKeyFor(bucket.name, 4)] = multiBoolMeasurement(GEO10_ROBOTS_LEGS.map((bot) => entityPaths.every((path) => !isPathDisallowed(robots, path, bot))));
        }
      }
    }

    if (bucket.name === "extractability_capsule" && pages.length > 0) {
      if (capsules.targets > 0) measurements[inputKeyFor(bucket.name, 0)] = ratioMeasurement(capsules.passed, capsules.targets);
      // index 1 (GEO-18, entities per 1000 words) needs the pinned NER model — unavailable.
      // GEO-17: single H1, no heading skips, at least half of H2/H3s phrased as questions.
      const subheadings = pages.flatMap((p) => p.headings.filter((h) => h.level === 2 || h.level === 3));
      measurements[inputKeyFor(bucket.name, 2)] = multiBoolMeasurement([
        share(pages, (p) => p.h1Count === 1) >= NEARLY_ALL,
        share(pages, (p) => p.headingSkips === 0) >= NEARLY_ALL,
        subheadings.length > 0 && subheadings.filter((h) => h.isQuestion).length / subheadings.length >= 0.5,
      ]);
      // BOTH-16: median section 120-180 words, none over 300, a definitional "X is" sentence on most pages, Flesch >= 50
      // (the Flesch leg is dropped, not failed, for scripts the formula does not describe).
      if (allSections.length > 0) {
        const med = median(allSections);
        const legs = [med >= 120 && med <= 180, !allSections.some((w) => w > 300), share(pages, (p) => p.definitionalSentence) >= MOST];
        if (latinPages.length > 0) legs.push(median(latinPages.map((p) => p.fleschReadingEase ?? 0)) >= 50);
        measurements[inputKeyFor(bucket.name, 3)] = multiBoolMeasurement(legs);
      }
      // BOTH-21: keyword density <= 2.5% and no exact phrase repeated more than 5 times. The "one primary intent per
      // URL" leg needs an intent classifier — dropped from the denominator rather than guessed.
      measurements[inputKeyFor(bucket.name, 4)] = multiBoolMeasurement([p75(pages.map((p) => p.keyword.topTokenShare)) <= 0.025, Math.max(...pages.map((p) => p.keyword.maxExactPhraseRepeats)) <= 5]);
      // GEO-22: question-form H2/H3s each answered in <= 80 words, median per page, target 3.
      measurements[inputKeyFor(bucket.name, 5)] = countMeasurement(median(pages.map(answeredQuestionHeadings)));
      // index 6 (BOTH-03) needs the frozen top-10 SERP snapshot — unavailable.
    }

    if (bucket.name === "evidence_density" && pages.length > 0) {
      // GEO-03: per-section stat and citation, page-level attributed quote and >= 3 outbound citations.
      const headed = pages.flatMap((p) => p.headings.filter((h) => h.sectionWordCount > 0));
      measurements[inputKeyFor(bucket.name, 0)] = multiBoolMeasurement([
        headed.length > 0 && headed.filter((h) => h.numericStatCount > 0).length / headed.length >= MOST,
        headed.length > 0 && headed.filter((h) => h.externalLinkCount > 0).length / headed.length >= MOST,
        share(pages, (p) => p.attributedQuoteCount > 0) >= MOST,
        share(pages, (p) => p.externalDomains.length >= 3) >= MOST,
      ]);
      // GEO-09: inline citations per 100 words (median), a named byline, a statistic on the page. "Original" cannot
      // be told from "sourced" without a search index, so the third leg is "carries a numeric statistic at all".
      measurements[inputKeyFor(bucket.name, 1)] = combineMeasurement({
        inline_cite_per_100w: median(pages.map((p) => (p.wordCount > 0 ? (p.externalLinkCount / p.wordCount) * 100 : 0))),
        has_named_author_byline: share(pages, (p) => p.authorByline) >= MOST,
        has_original_statistic: share(pages, (p) => p.numericStatCount > 0) >= MOST,
      });
      // BOTH-11: first-person experience marker and an original data point (same statistic proxy as GEO-09).
      measurements[inputKeyFor(bucket.name, 2)] = multiBoolMeasurement([share(pages, (p) => p.firstPersonMarkerCount > 0) >= MOST, share(pages, (p) => p.numericStatCount > 0) >= MOST]);
    }

    if (bucket.name === "freshness" && pages.length > 0) {
      // GEO-20: dateModified age gated by sitemap consistency and by the body actually having changed since the last
      // audit. The change leg needs a previous audit to compare against, so a first run leaves this input unavailable.
      if (onPage?.changedSince) {
        measurements[inputKeyFor(bucket.name, 0)] = combineMeasurement({
          datemodified_age_days: median(ages.map((a) => a.ageDays)),
          date_consistent: ages.filter((a) => a.consistent).length / ages.length >= MOST,
          body_changed: onPage.changedSince.pagesChanged > 0,
        });
      }
      // GEO-37: entity/about pages (the homepage when none was found) modified within 90 days.
      const entityAges = (entityPages.length > 0 ? entityPages : pages.slice(0, 1)).map((p) => modifiedAgeDays(p, onPage?.sitemap?.lastmodByUrl, now));
      measurements[inputKeyFor(bucket.name, 1)] = booleanMeasurement(entityAges.every((a) => a.hasDate && a.ageDays <= 90));
      // BOTH-13: cluster volume and cadence from the sitemap's own lastmod dates. `entryCount` is a floor when the
      // read was capped, which only ever under-counts.
      if (onPage?.sitemap && onPage.sitemap.entriesWithLastmod > 0) {
        measurements[inputKeyFor(bucket.name, 2)] = combineMeasurement({
          indexed_original_articles_in_cluster: onPage.sitemap.entryCount,
          publishing_gap_never_over_30d_trailing_6mo: onPage.sitemap.maxGapDaysTrailing6mo !== undefined && onPage.sitemap.maxGapDaysTrailing6mo <= 30,
        });
      }
    }

    if (bucket.name === "multimodal" && pages.length > 0) {
      // GEO-19: share of audited pages carrying media in the main content, gated by alt-text completeness.
      const totals = pages.reduce((acc, p) => ({ total: acc.total + p.images.total, withAlt: acc.withAlt + p.images.withAlt }), { total: 0, withAlt: 0 });
      measurements[inputKeyFor(bucket.name, 0)] = combineMeasurement({
        share_priority_pages_with_original_media: share(pages, (p) => p.images.total > 0 || p.hasVideo),
        alt_complete: totals.total > 0 && totals.withAlt === totals.total,
      });
    }

    if (bucket.name === "per_engine_index_reach" && snapshot) {
      // indices 0-2 (GEO-24/23/41) need Bing/Brave/Google indexation reads this environment does not have — unavailable.
      // BOTH-09: sitemap valid, Sitemap: line in robots.txt, zero noindex among the crawled set.
      measurements[inputKeyFor(bucket.name, 3)] = multiBoolMeasurement([sitemapPresentAndValid, sitemapLineInRobots, knownPages.length === 0 || noNoindexCount === knownPages.length]);
    }

    if (bucket.name === "offsite_entity_capped" && entity) {
      // GEO-25: a live non-stub Wikipedia article AND a Wikidata item with >= 5 referenced statements. A brand with no
      // matching item fails both legs — that is the measured state, not an unknown.
      const wikidata = entity.match === "official-website" ? entity.wikidata : undefined;
      measurements[inputKeyFor(bucket.name, 0)] = multiBoolMeasurement([entity.wikipedia?.nonStub === true, (wikidata?.referencedStatementCount ?? 0) >= 5]);
      // index 1 (GEO-04, DR>=40 mentioning domains) needs a backlink export — unavailable.
      // GEO-07: the Wikidata item's official website (P856) resolves to the client's root domain.
      measurements[inputKeyFor(bucket.name, 2)] = booleanMeasurement(wikidata?.officialWebsiteMatchesClient === true);
      // index 3 (GEO-14, review ratings) needs a review feed — unavailable.
    }

    if (bucket.name === "hygiene" && pages.length > 0) {
      measurements[inputKeyFor(bucket.name, 0)] = booleanMeasurement(pages.every((p) => p.jsonLd.parseErrors === 0) && pages.some((p) => p.jsonLd.blocks > 0));
      if (onPage) measurements[inputKeyFor(bucket.name, 1)] = booleanMeasurement(onPage.llmsTxt.present);
      // BOTH-12: Organization JSON-LD with >= 4 sameAs links and an @id.
      const org = pages.map((p) => p.jsonLd.organization).find((o) => o !== undefined);
      measurements[inputKeyFor(bucket.name, 2)] = booleanMeasurement(org !== undefined && org.sameAsCount >= 4 && org.hasId);
    }
  }

  return measurements;
}

/**
 * The plain-language facts behind the numbers — what a reader (and the
 * narrative step) can quote about what was actually observed. Every line is
 * derived from a snapshot field, never from a score, so a fact and the input
 * it feeds can be checked against each other.
 */
export function describeMeasuredFacts(sources: MeasurementSources): string[] {
  const facts: string[] = [];
  const { technical, onPage, coreWebVitals: cwv, entity } = sources;
  if (technical) {
    const ok = technical.pages.filter((p) => p.status === 200).length;
    facts.push(`Technical crawl: ${ok} of ${technical.pages.length} checked URLs answered HTTP 200${technical.robots ? "; robots.txt present" : "; no robots.txt"}${technical.sitemap ? `; sitemap with ${technical.sitemap.entries.length} entries read` : "; no sitemap found"}.`);
    if (technical.robots) {
      const blocked = GEO01_ROBOTS_LEGS.filter((bot) => isPathDisallowed(technical.robots!, "/", bot));
      facts.push(blocked.length === 0 ? "robots.txt allows OAI-SearchBot, PerplexityBot, ClaudeBot, Googlebot and Bingbot at the root." : `robots.txt disallows ${blocked.join(", ")} at the root.`);
    }
  }
  const pages = onPage?.pages.filter((p) => p.status === 200) ?? [];
  if (onPage && pages.length > 0) {
    facts.push(`On-page audit: ${pages.length} pages fetched${onPage.skipped.length > 0 ? ` (${onPage.skipped.length} skipped)` : ""}; ${pages.filter((p) => p.h1Count === 1).length} have exactly one H1; ${pages.filter((p) => p.metaDescription).length} carry a meta description; median ${median(pages.map((p) => p.wordCount))} words per page.`);
    const titles = pages.map((p) => p.titleLength);
    facts.push(`Title lengths run ${Math.min(...titles)}-${Math.max(...titles)} characters (75th percentile ${p75(titles)}).`);
    const types = [...new Set(pages.flatMap((p) => p.jsonLd.types))];
    facts.push(types.length > 0 ? `Structured data types seen: ${types.slice(0, 8).join(", ")}${pages.some((p) => p.jsonLd.parseErrors > 0) ? " (some JSON-LD blocks fail to parse)" : ""}.` : "No JSON-LD structured data on the audited pages.");
    const dated = pages.filter((p) => p.dateModified).length;
    facts.push(`${dated} of ${pages.length} audited pages declare a dateModified; ${pages.filter((p) => p.authorByline).length} carry an author byline.`);
    const capsules = pages.map(capsuleShare).reduce((acc, c) => ({ passed: acc.passed + c.passed, targets: acc.targets + c.targets }), { passed: 0, targets: 0 });
    if (capsules.targets > 0) facts.push(`${capsules.passed} of ${capsules.targets} section openings are a 40-60 word quotable capsule.`);
    facts.push(onPage.llmsTxt.present ? "/llms.txt is published." : "No /llms.txt is published.");
    if (onPage.sitemap) {
      facts.push(`Sitemap lists ${onPage.sitemap.truncated ? "at least " : ""}${onPage.sitemap.entryCount} URLs, ${onPage.sitemap.entriesTrailing6mo} modified in the last six months${onPage.sitemap.maxGapDaysTrailing6mo !== undefined ? `, longest publishing gap ${onPage.sitemap.maxGapDaysTrailing6mo} days` : ""}.`);
    }
    if (onPage.changedSince) facts.push(`${onPage.changedSince.pagesChanged} of ${onPage.changedSince.pagesCompared} pages changed since the previous audit on ${onPage.changedSince.previousAt.slice(0, 10)}.`);
  }
  if (cwv?.field) {
    const f = cwv.field;
    const parts = [f.lcpP75Ms !== undefined ? `LCP ${(f.lcpP75Ms / 1000).toFixed(1)}s` : undefined, f.inpP75Ms !== undefined ? `INP ${f.inpP75Ms}ms` : undefined, f.clsP75 !== undefined ? `CLS ${f.clsP75.toFixed(2)}` : undefined].filter(Boolean);
    facts.push(`Core Web Vitals (real users, ${cwv.strategy}, p75, ${f.source === "url" ? "this page" : "site-wide"}): ${parts.join(", ")}${f.overallCategory ? ` — ${f.overallCategory.toLowerCase().replace(/_/g, " ")}` : ""}.`);
  } else if (cwv?.lab) {
    facts.push(`No real-user Core Web Vitals data for this URL; Lighthouse lab performance score ${cwv.lab.performanceScore ?? "n/a"} (${cwv.strategy}).`);
  }
  if (entity) {
    if (entity.match === "official-website" && entity.wikidata) {
      facts.push(`Wikidata item ${entity.wikidata.qid} lists the client's own website; ${entity.wikidata.referencedStatementCount} of ${entity.wikidata.statementCount} statements are referenced; Wikipedia editions: ${entity.wikidata.wikipediaLanguages.join(", ") || "none"}.`);
      if (entity.wikipedia) facts.push(`${entity.wikipedia.language}.wikipedia article "${entity.wikipedia.title}" — intro ${entity.wikipedia.extractLength} characters (${entity.wikipedia.nonStub ? "not a stub" : "stub-length"}).`);
    } else {
      facts.push("No Wikidata item whose official website is the client's domain was found.");
    }
  }
  return facts;
}
