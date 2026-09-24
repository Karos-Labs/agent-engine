import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * FLEET-SCOPED memory (2026-09-24).
 *
 * Every other `memory.*` tool is client-scoped by construction (`ctx.clientSlug`),
 * which is right for everything a client owns. It left one rule unable to
 * work: the Instagram agent's cross-client variety pressure ("which formats
 * and layouts has ANY client shipped recently, so the fleet stops producing
 * one post in several palettes"). Written into each client's own beliefs, the
 * history only ever held that client's rows, and the readers, which exclude
 * the calling client, abstained on every run. The owner's verdict on the
 * result, the same day: posts from different clients read as one template.
 *
 * Deliberately narrow:
 *   - only keys on `FLEET_MEMORY_KEYS` exist, so no agent can open a general
 *     cross-client channel;
 *   - a row can only be APPENDED, and the tool stamps `clientSlug` from the
 *     run's own context, so one client can never write a row as another;
 *   - rows carry format ids and layout signatures, never client content.
 *
 * Stored under the reserved workspace slug `_fleet` (a leading underscore is
 * never a client slug).
 */
export const FLEET_WORKSPACE_SLUG = "_fleet";
export const FLEET_MEMORY_KEYS = ["instagramCrossClientFormats"] as const;
export type FleetMemoryKey = (typeof FLEET_MEMORY_KEYS)[number];
/** Rows kept per key; the oldest fall off. */
export const FLEET_ROWS_MAX = 60;

const FleetKeySchema = z.enum(FLEET_MEMORY_KEYS).describe("Which fleet-wide document. Only the listed keys exist.");

export interface FleetDocument {
  version: 1;
  entries: Array<Record<string, unknown>>;
}

async function readDocument(store: WorkspaceStoreLike, key: FleetMemoryKey): Promise<FleetDocument> {
  const raw = await store.readJson<unknown>(FLEET_WORKSPACE_SLUG, ["memory", key]);
  const rows = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["entries"] : undefined;
  return { version: 1, entries: Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [] };
}

export const ReadFleetInputSchema = z.object({ key: FleetKeySchema });
export type ReadFleetInput = z.infer<typeof ReadFleetInputSchema>;

export function createReadFleet(store: WorkspaceStoreLike) {
  return defineTool<ReadFleetInput, { key: FleetMemoryKey; document: FleetDocument }>({
    name: "memory.readFleet",
    description:
      "Reads one fleet-wide memory document (rows every client's runs appended: format ids and layout signatures, never client content). An empty document is the normal starting state.",
    version: TOOL_VERSION,
    inputSchema: ReadFleetInputSchema,
    async execute({ key }) {
      return success({ key, document: await readDocument(store, key) });
    },
  });
}

export const AppendFleetRowInputSchema = z.object({
  key: FleetKeySchema,
  row: z
    .record(z.string(), z.union([z.string().max(400), z.number(), z.boolean()]))
    .describe("One flat row. `clientSlug` is stamped by the tool from the run's context and any value supplied here is replaced."),
  dedupeOn: z.array(z.string().min(1)).max(4).default(["clientSlug", "at"]).describe("Fields that identify a row; an existing row with the same values is replaced, so a replayed step cannot double-count."),
});
export type AppendFleetRowInput = z.input<typeof AppendFleetRowInputSchema>;

export function createAppendFleetRow(store: WorkspaceStoreLike) {
  return defineTool<AppendFleetRowInput, { key: FleetMemoryKey; rows: number }>({
    name: "memory.appendFleetRow",
    description: "Appends one row to a fleet-wide memory document, stamped with the calling client's slug, deduplicated and capped. Only the listed keys exist.",
    version: TOOL_VERSION,
    inputSchema: AppendFleetRowInputSchema,
    async execute(input, { ctx }) {
      const { key, row, dedupeOn } = AppendFleetRowInputSchema.parse(input);
      const stamped: Record<string, unknown> = { ...row, clientSlug: ctx.clientSlug };
      const document = await readDocument(store, key);
      const same = (r: Record<string, unknown>): boolean => dedupeOn.every((field) => r[field] === stamped[field]);
      const entries = [...document.entries.filter((r) => !same(r)), stamped].slice(-FLEET_ROWS_MAX);
      await store.writeJson(FLEET_WORKSPACE_SLUG, ["memory", key], { version: 1, entries });
      return success({ key, rows: entries.length });
    },
  });
}
