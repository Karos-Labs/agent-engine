import { z } from "zod";
import { defineTool, success, toolingError, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { BrandJsonSchema, type BrandJson } from "../types.js";
import { PageBlueprintSchema, PagePartsSchema, type PageBlueprint, type PageParts } from "../page/types.js";

const TOOL_VERSION = "2.0.0";

/**
 * The client's OPTIONAL hand-curated landing inputs, under `clients/<slug>/landing/`:
 *
 * - `brand.json`   — the v1 brand contract (brandLaw[], typography bans,
 *                    carryForward[], tokens). Still honoured when present:
 *                    an account manager's hand-written rules outrank anything
 *                    inferred from the portal's brand kit.
 * - `intake.json`  — `{ markdown }`, a one-time onboarding note.
 * - `state.json`   — the last PUBLISHED build (blueprint + parts + URLs),
 *                    written by `landing.writeState` after approval. A
 *                    `recurring` run reads it to revise instead of restart.
 *
 * v1 treated the first two as REQUIRED and stopped at `blocked_intake` without
 * them, which is why no client the portal onboarded could run this agent
 * without someone hand-seeding files into the bucket. v2's required inputs
 * are the ones the portal already writes for every client (`client/brand`,
 * `client/profile`, the context docs); these are extras.
 */
export interface LandingIntakeResult {
  brand?: BrandJson;
  intakeMarkdown?: string;
  priorState?: LandingBuildState;
}

export const LandingBuildStateSchema = z.object({
  runId: z.string().min(1),
  publishedAt: z.string().min(1),
  blueprint: PageBlueprintSchema,
  parts: PagePartsSchema,
  liveUrl: z.string().optional(),
  versionName: z.string().optional(),
});
export type LandingBuildState = z.infer<typeof LandingBuildStateSchema>;

export const ReadLandingIntakeInputSchema = z.object({});
export type ReadLandingIntakeInput = z.infer<typeof ReadLandingIntakeInputSchema>;

export function createReadLandingIntake(store: WorkspaceStoreLike) {
  return defineTool<ReadLandingIntakeInput, LandingIntakeResult>({
    name: "landing.readIntake",
    description:
      "Reads this client's optional hand-curated landing inputs from the workspace: landing/brand.json (brandLaw, typography bans, carryForward), landing/intake.json ({ markdown }), and landing/state.json (the last published build, for a revision run). All optional; tenant comes from context.",
    version: TOOL_VERSION,
    inputSchema: ReadLandingIntakeInputSchema,
    async execute(_input, { ctx }) {
      const result: LandingIntakeResult = {};
      const brandRaw = await store.readJson<unknown>(ctx.clientSlug, ["landing", "brand"]);
      if (brandRaw !== undefined) {
        const parsed = BrandJsonSchema.safeParse(brandRaw);
        if (!parsed.success) return toolingError(`landing/brand.json for "${ctx.clientSlug}" does not match the brand contract: ${parsed.error.message}`);
        result.brand = parsed.data;
      }
      const intake = await store.readJson<{ markdown?: unknown }>(ctx.clientSlug, ["landing", "intake"]);
      if (intake && typeof intake.markdown === "string" && intake.markdown.trim().length > 0) result.intakeMarkdown = intake.markdown;
      const stateRaw = await store.readJson<unknown>(ctx.clientSlug, ["landing", "state"]);
      if (stateRaw !== undefined) {
        const parsed = LandingBuildStateSchema.safeParse(stateRaw);
        // A state file from an older build shape is not an error: the run simply builds fresh.
        if (parsed.success) result.priorState = parsed.data;
        else console.error(`landing.readIntake: landing/state.json for "${ctx.clientSlug}" is not a v2 build state; building fresh (${parsed.error.issues[0]?.message ?? "schema mismatch"})`);
      }
      return success(result);
    },
  });
}

export const WriteLandingStateInputSchema = z.object({
  runId: z.string().min(1).describe("The run whose approved build this is."),
  blueprint: PageBlueprintSchema.describe("The approved PageBlueprint."),
  parts: PagePartsSchema.describe("The approved PageParts."),
  liveUrl: z.string().optional().describe("The live .web.app URL, when Hosting released it."),
  versionName: z.string().optional().describe("The Firebase Hosting version that is live."),
});
export type WriteLandingStateInput = z.infer<typeof WriteLandingStateInputSchema>;

export function createWriteLandingState(store: WorkspaceStoreLike) {
  return defineTool<WriteLandingStateInput, { path: string }>({
    name: "landing.writeState",
    description: "Persists the approved build (blueprint + parts + URLs) as landing/state.json so a later revision run starts from what is live. Tenant comes from context.",
    version: TOOL_VERSION,
    inputSchema: WriteLandingStateInputSchema,
    async execute(input, { ctx }) {
      const state: LandingBuildState = {
        runId: input.runId,
        publishedAt: new Date().toISOString(),
        blueprint: input.blueprint as PageBlueprint,
        parts: input.parts as PageParts,
        ...(input.liveUrl ? { liveUrl: input.liveUrl } : {}),
        ...(input.versionName ? { versionName: input.versionName } : {}),
      };
      const written = await store.writeJson(ctx.clientSlug, ["landing", "state"], state);
      return success({ path: written.filePath });
    },
  });
}
