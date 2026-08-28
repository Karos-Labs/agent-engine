import {
  CLIENT_REPORT_OPTIONAL_KEYS,
  CLIENT_REPORT_REQUIRED_KEYS,
  DIMENSION_WEIGHTS,
  type ClientReport,
  type DimensionKey,
  type IntelReportOutput,
  type PersistedDimensionScore,
} from "./types.js";

export interface BuildClientReportOptions {
  /**
   * The portal's document id for this tenant. The engine knows the tenant as
   * `ctx.clientSlug`; the portal knows it as `Client.id` and uses it as the
   * `clientReports` document id (`karosCMO/src/lib/data.ts` line 1375). They
   * are the same string only because the engine is invoked with the portal's
   * client id as its slug — see `write-report.ts`'s note, and SCRUM-329, which
   * is the ticket that makes that binding something the edge asserts rather
   * than something both sides assume.
   */
  clientId: string;
  overallScore: number;
  overallGrade: string;
  /** Preserved across regenerations, exactly like legacy's upsert did. */
  createdAt: number;
  updatedAt: number;
  pdfUrl?: string;
}

export class ClientReportShapeError extends Error {}

/**
 * Fills `weight` from the fixed scoring methodology rather than from the
 * model. Throws on a dimension the methodology does not define, instead of
 * writing `weight: undefined` into Firestore — a report carrying a dimension
 * with no weight would render a row the portal cannot size, and would mean the
 * deterministic `computeOverallScore` and the stored table disagree about what
 * the report even contains.
 */
export function withDimensionWeights(scores: IntelReportOutput["dimensionScores"]): PersistedDimensionScore[] {
  return scores.map((s) => {
    const weight = DIMENSION_WEIGHTS[s.dimension as DimensionKey];
    if (typeof weight !== "number") {
      throw new ClientReportShapeError(`dimension "${s.dimension}" has no weight in DIMENSION_WEIGHTS`);
    }
    return { dimension: s.dimension, weight, score: s.score };
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ANALYSIS_SECTIONS: Array<[keyof IntelReportOutput, string]> = [
  ["contentAnalysis", "Content & Messaging"],
  ["conversionAnalysis", "Conversion"],
  ["seoAnalysis", "SEO"],
  ["geoAnalysis", "GEO"],
  ["positioningAnalysis", "Positioning"],
  ["brandAnalysis", "Brand"],
  ["growthAnalysis", "Growth"],
];

/**
 * Renders the structured report back into the markdown blob the portal stores
 * as `ClientReport.rawMarkdown` (a REQUIRED field on its interface, line 1609).
 *
 * The direction of travel matters and is the opposite of legacy's: legacy
 * generated markdown from the model and regex-parsed structure OUT of it
 * (`report-parser.ts`'s `parseMarkdownReport`), so a parse miss silently
 * dropped a whole section. Here the structure is authoritative and the markdown
 * is derived from it, so the two can never disagree. T-B17 (SCRUM-270) is what
 * lets the portal stop reading this field at all; until it lands, a report
 * written without it is a report the portal shows blank.
 *
 * This is also the only home for `brandSynchronizationUpdate`: the portal's
 * `ClientReport` declares no field for it, and decision 5 forbids inventing
 * one, so it is rendered as a section like every other piece of prose legacy
 * only ever had in markdown.
 */
export function renderReportMarkdown(input: IntelReportOutput, opts: { overallScore: number; overallGrade: string; reportDate: string }): string {
  const lines: string[] = [];
  lines.push(`# Digital Intelligence & Competitive Report`);
  lines.push("");
  lines.push(`Report date: ${opts.reportDate}`);
  lines.push(`Overall score: ${opts.overallScore} (${opts.overallGrade})`);
  lines.push("");
  lines.push("## Dimension Scores");
  lines.push("");
  lines.push("| Dimension | Weight | Score |");
  lines.push("| --- | --- | --- |");
  for (const d of withDimensionWeights(input.dimensionScores)) {
    lines.push(`| ${d.dimension} | ${d.weight} | ${d.score} |`);
  }
  for (const [key, heading] of ANALYSIS_SECTIONS) {
    lines.push("", `## ${heading}`, "", String(input[key] ?? ""));
  }
  lines.push("", "## SWOT", "");
  for (const [heading, items] of [
    ["Strengths", input.swot.strengths],
    ["Weaknesses", input.swot.weaknesses],
    ["Opportunities", input.swot.opportunities],
    ["Threats", input.swot.threats],
  ] as Array<[string, string[]]>) {
    lines.push(`### ${heading}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  if (input.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    for (const r of input.recommendations) {
      lines.push(`${r.number}. **${r.title}** (${r.priorityLabel}, ${r.tag})${r.description ? ` — ${r.description}` : ""}`);
    }
    lines.push("");
  }
  if (input.competitorRankings.length > 0) {
    lines.push("## Competitor Rankings", "", "| Rank | Company | Score | Grade | Best | Weakest |", "| --- | --- | --- | --- | --- | --- |");
    for (const c of input.competitorRankings) {
      lines.push(`| ${c.rank} | ${c.company} | ${c.score} | ${c.grade} | ${c.bestDimension} | ${c.weakestDimension} |`);
    }
    lines.push("");
  }
  // Required by Directive 2 in every report — and with nowhere on the portal's
  // ClientReport interface to live, this section IS where it lives.
  lines.push("## Brand Synchronization Update", "", input.brandSynchronizationUpdate, "");
  return lines.join("\n");
}

/**
 * Renders the inline HTML the portal stores as `ClientReport.reportHtml` and
 * serves to clients (`karosCMO/src/lib/intel/report.ts` line 420-421 writes it;
 * `client-api-access-guard` serves it). SCRUM-267 names its absence as one of
 * the two defects in this package.
 *
 * Every interpolated value is HTML-escaped. The model authors all of this prose
 * and it is served into a client-facing page, so an unescaped render here would
 * be a stored-XSS sink with a model on the writing end of it.
 */
export function renderReportHtml(report: ClientReport): string {
  const rows = report.dimensionScores
    .map((d) => `<tr><td>${escapeHtml(d.dimension)}</td><td>${d.weight}%</td><td>${d.score}</td></tr>`)
    .join("");
  const sections = ANALYSIS_SECTIONS.map(
    ([key, heading]) => `<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(String(report[key as keyof ClientReport] ?? ""))}</p></section>`,
  ).join("");
  const swot = (["strengths", "weaknesses", "opportunities", "threats"] as const)
    .map(
      (k) =>
        `<div class="swot-${k}"><h3>${escapeHtml(k)}</h3><ul>${report.swot[k].map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`,
    )
    .join("");
  const recs = report.recommendations
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.title)}</strong> <span class="tag">${escapeHtml(r.tag)}</span> <span class="priority">${escapeHtml(r.priorityLabel)}</span><p>${escapeHtml(r.description)}</p></li>`,
    )
    .join("");
  return [
    `<article class="karos-intel-report" data-client-id="${escapeHtml(report.clientId)}">`,
    `<header><h1>Digital Intelligence &amp; Competitive Report</h1>`,
    `<p class="report-date">${escapeHtml(report.reportDate)}</p>`,
    `<p class="overall">${report.overallScore} <span class="grade">${escapeHtml(report.overallGrade)}</span></p></header>`,
    `<table class="dimension-scores"><thead><tr><th>Dimension</th><th>Weight</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`,
    sections,
    `<section class="swot"><h2>SWOT</h2>${swot}</section>`,
    recs ? `<section class="recommendations"><h2>Recommendations</h2><ol>${recs}</ol></section>` : "",
    `</article>`,
  ].join("");
}

/**
 * THE SHAPE GUARD, and the thing that makes decision 5's constraint checkable
 * instead of aspirational.
 *
 * It fails in both directions, which is the point — a guard that can only
 * detect one kind of drift is half a guard:
 *   - a REQUIRED portal key that is missing or `undefined` fails the write
 *     (the portal renders a hole, or `getClientReport` returns a document its
 *     own `as ClientReport` cast is lying about);
 *   - a key that is NOT on the portal's interface at all fails the write (this
 *     package inventing a field is exactly how `ClientReportRecord` drifted
 *     into not being a `ClientReport` in the first place — `brandSynchronizationUpdate`
 *     rode along for the whole of its life and no test ever noticed).
 *
 * Firestore rejects `undefined` values outright, so an explicit-`undefined`
 * optional key is treated as drift too rather than being quietly dropped.
 */
export function assertPortalClientReportShape(doc: Record<string, unknown>): void {
  const allowed = new Set<string>([...CLIENT_REPORT_REQUIRED_KEYS, ...CLIENT_REPORT_OPTIONAL_KEYS]);
  const missing = CLIENT_REPORT_REQUIRED_KEYS.filter((k) => doc[k] === undefined);
  const extra = Object.keys(doc).filter((k) => !allowed.has(k));
  const undefinedOptional = Object.keys(doc).filter((k) => allowed.has(k) && doc[k] === undefined && !missing.includes(k as never));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing required portal field(s): ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`field(s) the portal's ClientReport does not declare: ${extra.join(", ")}`);
  if (undefinedOptional.length > 0) problems.push(`explicit undefined (Firestore rejects it): ${undefinedOptional.join(", ")}`);
  if (problems.length > 0) {
    throw new ClientReportShapeError(`built document is not a portal ClientReport — ${problems.join("; ")}`);
  }
}

/** `YYYY-MM-DD`, the format legacy's parsed `reportDate` carries into the portal. */
export function defaultReportDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Builds the document `intel.writeReport` persists — the portal's
 * `ClientReport`, nothing more and nothing less.
 *
 * Optional fields are OMITTED rather than set to `undefined`: Firestore's
 * `set()` throws on an undefined value, so `{ founded: undefined }` is not a
 * harmless no-op here, it is a failed write at the end of a paid agent run.
 */
export function buildClientReport(input: IntelReportOutput, opts: BuildClientReportOptions): ClientReport {
  const reportDate = input.reportDate ?? defaultReportDate(opts.updatedAt);
  const optional: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) optional[key] = value;
  };
  put("url", input.url);
  put("businessType", input.businessType);
  put("founded", input.founded);
  put("authorization", input.authorization);
  put("cnpj", input.cnpj);
  put("minInvestment", input.minInvestment);
  put("techStack", input.techStack);
  put("reportStatus", input.reportStatus);
  put("brandVoiceRows", input.brandVoiceRows);
  put("brandVoiceArchetypes", input.brandVoiceArchetypes);
  put("brandVoiceTerritory", input.brandVoiceTerritory);
  put("customerSentiment", input.customerSentiment);
  put("whitespaceOpportunities", input.whitespaceOpportunities);
  put("pdfUrl", opts.pdfUrl);

  const base = {
    id: opts.clientId,
    clientId: opts.clientId,
    reportDate,
    overallScore: opts.overallScore,
    overallGrade: opts.overallGrade,
    dimensionScores: withDimensionWeights(input.dimensionScores),
    competitorRankings: input.competitorRankings,
    contentAnalysis: input.contentAnalysis,
    conversionAnalysis: input.conversionAnalysis,
    seoAnalysis: input.seoAnalysis,
    geoAnalysis: input.geoAnalysis,
    positioningAnalysis: input.positioningAnalysis,
    brandAnalysis: input.brandAnalysis,
    growthAnalysis: input.growthAnalysis,
    swot: input.swot,
    recommendations: input.recommendations,
    rawMarkdown: renderReportMarkdown(input, { overallScore: opts.overallScore, overallGrade: opts.overallGrade, reportDate }),
    createdAt: opts.createdAt,
    updatedAt: opts.updatedAt,
    ...optional,
  } as ClientReport;

  const withHtml: ClientReport = { ...base, reportHtml: renderReportHtml(base) };
  assertPortalClientReportShape(withHtml as unknown as Record<string, unknown>);
  return withHtml;
}
