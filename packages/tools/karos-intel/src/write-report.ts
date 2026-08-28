import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { computeOverallScore } from "./scoring.js";
import { mergeCompetitors } from "./competitor-merge.js";
import { buildClientReport } from "./build-client-report.js";
import type { ClientReportStore } from "./client-report-store.js";
import {
  competitorSegments,
  reportSegments,
  IntelReportOutputSchema,
  WIDE_SCAN_MIN_COMPETITORS,
  type ClientCompetitor,
  type ClientReport,
  type PersistedClientCompetitor,
} from "./types.js";

const TOOL_VERSION = "2.0.0";

export interface WriteReportResult {
  overallScore: number;
  overallGrade: string;
  competitorCount: number;
  /** The `clientReports` document id the portal will read this back by — `ctx.clientSlug`. */
  clientId: string;
  /** Which backend took the portal-facing write. Present so a run's telemetry can distinguish a real Firestore write from a memory store in a demo. */
  clientReportStore: string;
}

/**
 * `intel.writeReport` (RFC-05 §5) — wraps what legacy's `upsertClientReport`
 * + `replaceReportCompetitors` do, behind a typed tool instead of a direct
 * Firestore import from a workflow step (RFC-01 §4's layer invariant).
 * Structured JSON in (`IntelReportOutputSchema`), typed store write out — no
 * markdown round-trip.
 *
 * SCRUM-267 (T-A18) changed what "out" means. Before it, this tool wrote to
 * the engine's workspace store only, in a record shape (`ClientReportRecord`)
 * that was not the portal's `ClientReport` — no `id`, no `clientId`, no
 * `reportDate`, no `rawMarkdown`, no `reportHtml`, no `weight` on the
 * dimension scores, plus one field the portal does not declare. A completed
 * intel run therefore left `getClientReport()` returning exactly what it
 * returned before the run. Tomer's 2026-08-28 decision 5 makes that
 * load-bearing rather than cosmetic — the agent-based onboarding is built FROM
 * this agent, and "the output must be written in EXACTLY the same shape, to
 * EXACTLY the same Firestore location the system already reads from."
 *
 * So the tool now has TWO write targets and they are not interchangeable:
 *  1. `clientReportStore` — the portal's `clientReports/{clientId}` document.
 *     This is the deliverable. Without it wired the tool reports
 *     `not_available` and the workflow fails the run, because a run whose
 *     output never reaches the read path is not a run that succeeded — it is
 *     precisely C5's "a completed run, an 'in review' tag, and nothing to
 *     review", one layer down.
 *  2. `store` (the workspace) — the engine's own mirror, which is what
 *     `intel.getReport` and every downstream drafting agent read through
 *     `buildClientIntelContext`. Kept, unchanged in location, so nothing
 *     downstream in this repo has to change.
 *
 * `overallScore`/`overallGrade` are computed here, deterministically, from
 * `dimensionScores` (never trusted to the model), and `weight` is filled from
 * `DIMENSION_WEIGHTS` for the same reason. Competitors are diffed and
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
 *
 * KNOWN LIMIT, stated rather than hidden: the competitor roster still lands in
 * the workspace only. The portal reads competitors from a SECOND collection
 * (`clientCompetitors`, one document per row, `data.ts` line 106) via a
 * different legacy function with its own batch semantics; bringing that across
 * is its own piece of work and is not what SCRUM-267 names.
 */
export function createWriteReport(store: WorkspaceStoreLike, clientReportStore?: ClientReportStore) {
  return defineTool<import("./types.js").IntelReportOutput, WriteReportResult>({
    name: "intel.writeReport",
    version: TOOL_VERSION,
    inputSchema: IntelReportOutputSchema,
    async execute(input, { ctx }) {
      if (!clientReportStore) {
        // Deliberately fails rather than degrading to a workspace-only write.
        // A workspace-only write is exactly the pre-SCRUM-267 bug, and it is
        // invisible from inside the engine: every step reports success and the
        // portal shows nothing.
        return notAvailable<WriteReportResult>(
          "intel.writeReport has no client-report store wired, so the report cannot reach the portal's " +
            "clientReports collection. Pass one to createKarosIntelTools() (createFirestoreClientReportStore " +
            "in a deployment, createMemoryClientReportStore in a test).",
        );
      }

      const { overallScore, overallGrade } = computeOverallScore(input.dimensionScores);
      // The tenant key the engine was invoked with IS the portal's clientId —
      // the engine has no slug->clientId resolution anywhere (every karos-*
      // tool partitions on `ctx.clientSlug` and nothing maps it), and
      // `step-agent.ts` already passes `clientId: runtime.clientSlug` into the
      // model context. SCRUM-329 is the ticket that turns that shared
      // assumption into something the edge asserts per request.
      const clientId = ctx.clientSlug;

      const existing = await clientReportStore.read(clientId);
      const now = Date.now();
      const record: ClientReport = buildClientReport(input, {
        clientId,
        overallScore,
        overallGrade,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      // Portal first: if this throws, the run fails and nobody is told a report
      // exists. The workspace mirror after it can only ever be MORE stale than
      // the portal, never fresher.
      await clientReportStore.write(record);
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

      return success<WriteReportResult>({
        overallScore,
        overallGrade,
        competitorCount: mergedCompetitors.length,
        clientId,
        clientReportStore: clientReportStore.name,
      });
    },
  });
}
