import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { computeOverallScore } from "./scoring.js";
import { mergeCompetitors } from "./competitor-merge.js";
import {
  competitorSegments,
  reportSegments,
  IntelReportOutputSchema,
  WIDE_SCAN_MIN_COMPETITORS,
  type ClientCompetitor,
  type ClientReportRecord,
  type PersistedClientCompetitor,
} from "./types.js";

const TOOL_VERSION = "1.0.0";

export interface WriteReportResult {
  overallScore: number;
  overallGrade: string;
  competitorCount: number;
}

/**
 * `intel.writeReport` (RFC-05 §5) — wraps what legacy's `upsertClientReport`
 * + `replaceReportCompetitors` do, behind a typed tool instead of a direct
 * Firestore import from a workflow step (RFC-01 §4's layer invariant).
 * Structured JSON in (`IntelReportOutputSchema`), typed store write out — no
 * markdown round-trip.
 *
 * `overallScore`/`overallGrade` are computed here, deterministically, from
 * `dimensionScores` (never trusted to the model). Competitors are diffed and
 * merged by composite identity key exactly like legacy's
 * `replaceReportCompetitors` (`karosCMO/src/lib/data.ts` lines 1575-1660,
 * ported in `competitor-merge.ts`): a `source: "manual"` row that matches an
 * incoming report row by `competitorBrandKeys(company, url)` is ENRICHED in
 * place (never duplicated, never deleted); a `source: "report"` row that
 * matches is replaced by the fresh data (carrying forward its `url` fallback
 * and any measured `llmMentions`); a genuinely new competitor is appended;
 * and an old `source: "report"` row with real measured `llmMentions` that
 * this run's fresh parse simply didn't re-surface survives instead of being
 * silently dropped. See `competitor-merge.ts`'s doc comment for the exact
 * field-by-field precedence.
 */
export function createWriteReport(store: WorkspaceStoreLike) {
  return defineTool<import("./types.js").IntelReportOutput, WriteReportResult>({
    name: "intel.writeReport",
    version: TOOL_VERSION,
    inputSchema: IntelReportOutputSchema,
    async execute(input, { ctx }) {
      const { overallScore, overallGrade } = computeOverallScore(input.dimensionScores);
      const existing = await store.readJson<ClientReportRecord>(ctx.clientSlug, reportSegments());
      const now = Date.now();

      const record: ClientReportRecord = {
        ...input,
        overallScore,
        overallGrade,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.writeJson(ctx.clientSlug, reportSegments(), record);

      // Wide Scan minimum is a soft target (see `WIDE_SCAN_MIN_COMPETITORS`'s doc
      // comment for why this is a warning, not a schema-enforced floor): surface the
      // miss loudly without corrupting or blocking the write.
      if (input.competitors.length < WIDE_SCAN_MIN_COMPETITORS) {
        console.warn(
          `[intel.writeReport] Wide Scan minimum missed for client "${ctx.clientSlug}": ` +
            `${input.competitors.length} competitor(s) generated, target is >= ${WIDE_SCAN_MIN_COMPETITORS}.`,
        );
      }

      const existingCompetitors =
        (await store.readJson<PersistedClientCompetitor[]>(ctx.clientSlug, competitorSegments())) ?? [];
      // Security property (unchanged by this fix): every incoming competitor row is
      // forced to `source: "report"` regardless of what the model's structured output
      // claimed — only `mergeCompetitors`'s own logic ever assigns/preserves "manual".
      const reportRows: ClientCompetitor[] = input.competitors.map((c) => ({ ...c, source: "report" }));
      const mergedCompetitors = mergeCompetitors(existingCompetitors, reportRows);
      await store.writeJson(ctx.clientSlug, competitorSegments(), mergedCompetitors);

      return success<WriteReportResult>({ overallScore, overallGrade, competitorCount: mergedCompetitors.length });
    },
  });
}
