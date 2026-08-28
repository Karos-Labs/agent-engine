import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { competitorSegments, reportSegments, type ClientReport, type PersistedClientCompetitor } from "./types.js";

const TOOL_VERSION = "1.0.0";

export const GetReportInputSchema = z.object({});
export type GetReportInput = z.infer<typeof GetReportInputSchema>;

export interface GetReportResult {
  report: ClientReport;
  competitors: PersistedClientCompetitor[];
}

/** Reads back the persisted report + competitor roster for this client — the portal's read path, and useful for verifying `intel.writeReport`'s effects. */
export function createGetReport(store: WorkspaceStoreLike) {
  return defineTool<GetReportInput, GetReportResult>({
    name: "intel.getReport",
    description:
      "Reads back the persisted report + competitor roster for this client — the portal's read path, and useful for verifying intel.writeReport's effects.",
    version: TOOL_VERSION,
    inputSchema: GetReportInputSchema,
    async execute(_input, { ctx }) {
      const report = await store.readJson<ClientReport>(ctx.clientSlug, reportSegments());
      if (!report) {
        return notAvailable(`no Intel Report has been written yet for client "${ctx.clientSlug}"`);
      }
      const competitors = (await store.readJson<PersistedClientCompetitor[]>(ctx.clientSlug, competitorSegments())) ?? [];
      return success<GetReportResult>({ report, competitors });
    },
  });
}
