import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, success } from "@agent-engine/tool-common";
import { CaptureLegRequestSchema } from "../capture/types.js";

const TOOL_VERSION = "1.0.0";

/** Same address `client.getConfig` reads (`packages/tools/karos-client/src/get-config.ts`): the tenant's free-form runtime config. */
const CONFIG_SEGMENTS = ["client", "config"] as const;

/**
 * The client-config keys this tool may write, and NO others. The config record
 * is shared with every other product (`xHandle`, `instagramStyleConfig`,
 * `tiktokClips`, ...), and a setup step that could rewrite any of it would
 * turn one agent's onboarding into a tenancy hole for the rest. The parser on
 * the reading side (`agents/reputation-agent/src/workflow/intake.ts`) owns the
 * meaning of each key; this tool only owns the fact that they get written.
 */
export const REPUTATION_CONFIG_KEYS = ["reputationRoster", "reputationLocks", "reputationSetup"] as const;

export const ReputationLocksSchema = z.object({
  neverSay: z.array(z.string()).default([]).describe("Phrases a public reply may never contain — the client's own never-say list."),
  requiredFramingAnyOf: z
    .array(z.string())
    .default([])
    .describe("Regulated-industry framing, at least one of which every reply must carry. Empty for an unregulated client."),
});
export type ReputationLocks = z.infer<typeof ReputationLocksSchema>;

export const SaveRosterInputSchema = z.object({
  roster: z
    .array(CaptureLegRequestSchema)
    .min(1)
    .describe("The resolved capture legs — the client's REAL listings per surface. Becomes `reputationRoster` in client config, the list every pulse reads."),
  locks: ReputationLocksSchema.optional().describe(
    "Written as `reputationLocks` ONLY when the client has none on file yet. A lock list already on file is a decision someone made; setup does not overwrite it.",
  ),
  setup: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Provenance for `reputationSetup`: which seeds were named, which resolved and how, the run that did it. Read by people, not by the pulse."),
});
export type SaveRosterInput = z.infer<typeof SaveRosterInputSchema>;

export interface SaveRosterResult {
  /** The store path written — always `client/config`. */
  id: string;
  /** True when no config record existed for this client before this write. */
  created: boolean;
  legCount: number;
  /** Which of the allow-listed keys this write actually set. */
  wrote: Array<(typeof REPUTATION_CONFIG_KEYS)[number]>;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * `reputation.saveRoster` — records the roster the pulse's `00-roster-setup`
 * pre-flight resolved, by MERGING three allow-listed keys into the client's
 * config record and leaving every other key exactly as it was.
 *
 * Refuses to replace a roster already on file. The pre-flight only calls this
 * when the client has none, so hitting the refusal means two runs raced or a
 * caller skipped the check; either way the standing roster wins, because a
 * listing someone confirmed is worth more than one this run resolved. Editing
 * a roster is a deliberate act on the config record, not a side effect of a
 * pulse.
 */
export function createSaveRoster(store: WorkspaceStoreLike) {
  return defineTool<SaveRosterInput, SaveRosterResult>({
    name: "reputation.saveRoster",
    description:
      "Records the client's resolved review-listing roster (and, if none is on file, their never-say locks) into client config for every later pulse to read. Merges only the reputation keys; refuses to overwrite a roster already on file.",
    version: TOOL_VERSION,
    inputSchema: SaveRosterInputSchema,
    async execute({ roster, locks, setup }, { ctx }) {
      const existing = (await store.readJson<Record<string, unknown>>(ctx.clientSlug, [...CONFIG_SEGMENTS])) ?? {};

      const standing = existing["reputationRoster"];
      if (isNonEmptyArray(standing)) {
        return contentFail<SaveRosterResult>(
          `reputation.saveRoster: "${ctx.clientSlug}" already has a reputationRoster on file (${standing.length} legs) — refusing to replace it from a setup pass`,
        );
      }

      const wrote: SaveRosterResult["wrote"] = ["reputationRoster"];
      const next: Record<string, unknown> = { ...existing, reputationRoster: roster };

      if (locks && existing["reputationLocks"] === undefined) {
        next["reputationLocks"] = locks;
        wrote.push("reputationLocks");
      }

      next["reputationSetup"] = {
        ...(setup ?? {}),
        recordedBy: "reputation.saveRoster",
        recordedAt: new Date().toISOString(),
        runId: ctx.runId,
      };
      wrote.push("reputationSetup");

      const { created } = await store.writeJson(ctx.clientSlug, [...CONFIG_SEGMENTS], next);
      return success<SaveRosterResult>({ id: CONFIG_SEGMENTS.join("/"), created, legCount: roster.length, wrote });
    },
  });
}
