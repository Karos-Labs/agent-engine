import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

const StageSchema = z.enum(["attention", "expertise", "decide"]);

export const StrategyMapRowInputSchema = z.object({
  id: z.string().min(1).describe("Stable row id, e.g. sm-x-007. The subject row names it when a run takes this row."),
  problem: z.string().optional().describe("The buyer problem this row speaks to."),
  stage: StageSchema.describe("The funnel stage the row is written for: attention | expertise | decide."),
  idea: z.string().min(1).describe("The post idea, in one line — what a run would write about."),
  type: z.string().optional().describe("The platform's own post-type vocabulary (X: lane; LinkedIn: archetype)."),
  evidence: z.string().optional().describe("What in the client's material the row rests on."),
  status: z.enum(["open", "used", "retired"]).default("open").describe("open until a run takes it."),
});

export const StrategyMapInputSchema = z.object({
  platform: z.enum(["x", "linkedin", "reddit", "instagram", "tiktok"]).describe("The platform this map is for."),
  source: z.enum(["setup-run", "first-run", "manual"]).describe("Who built it: a setup agent, a drafting run that found none, or a person."),
  audience: z.array(z.object({ role: z.string(), problems: z.array(z.string()).default([]) })).default([]).describe("Who the client sells to and what keeps them up at night — the problems the rows are cut from."),
  rows: z.array(StrategyMapRowInputSchema).min(1).describe("The problem × stage rows. Every row carries a stage."),
  defaultMix: z.object({ attention: z.number().int(), expertise: z.number().int(), decide: z.number().int() }).default({ attention: 3, expertise: 2, decide: 1 }).describe("D32: the stage mix a week of runs should show when no calendar slot names one."),
});
export type StrategyMapInput = z.infer<typeof StrategyMapInputSchema>;

export interface StrategyMapWriteResult {
  path: string;
  rows: number;
  created: boolean;
}

/**
 * `ledger.writeStrategyMap` — C1 / SCRUM-464: the topic pool with goals,
 * written by a setup agent or by a drafting run that found no projected map,
 * at `state/<platform>/strategy-map.json` (C7 §3). The middleware's
 * `collect` stores it and projects it back as
 * `context/learning/<platform>/strategy-map.json`; until then
 * `client.getLearningContext` reads this file directly so the next run does
 * not build a second one. Replaces the file whole: a map is built once and
 * then maintained row by row on the middleware side.
 */
export function createWriteStrategyMap(store: WorkspaceStoreLike) {
  return defineTool<StrategyMapInput, StrategyMapWriteResult>({
    name: "ledger.writeStrategyMap",
    description:
      "Writes the client's strategy map for one platform — problem × stage rows, each with a funnel stage — to state/<platform>/strategy-map.json for the middleware to collect. Built once by a setup or first run; a later run reads it rather than building again.",
    version: TOOL_VERSION,
    inputSchema: StrategyMapInputSchema,
    async execute(map, { ctx }) {
      const segments = ["state", map.platform, "strategy-map"];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        platform: map.platform,
        builtAt: new Date().toISOString(),
        builtBy: ctx.runId,
        source: map.source,
        audience: map.audience,
        rows: map.rows,
        defaultMix: map.defaultMix,
      });
      return success<StrategyMapWriteResult>({ path: segments.join("/"), rows: map.rows.length, created });
    },
  });
}
