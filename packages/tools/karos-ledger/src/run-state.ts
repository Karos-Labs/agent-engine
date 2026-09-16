import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** C7 §3.1 — the run state record's schema version. Bump when a field changes meaning, never for an added optional field. */
export const RUN_STATE_SCHEMA_VERSION = 1;

/** The same three words as `FunnelStageSchema` in `@agent-engine/core`; repeated here so this Layer 3 package does not import the workflow layer's vocabulary. */
const StageSchema = z.enum(["attention", "expertise", "decide"]);

export const RunStateDeliverableSchema = z.object({
  kind: z.string().min(1).describe("C5 deliverable kind, e.g. \"x-post\"."),
  goal: StageSchema.optional().describe("D11: the point of the post — earn attention, show expertise, help them decide."),
  audience: z.string().optional().describe("Who it is for: the problem it speaks to, in one line."),
  whyNow: z.string().optional().describe("News, trend, the client's request, or a post of this kind that performed — in one line."),
  type: z.string().optional().describe("The platform's own type vocabulary: an X lane, a LinkedIn post type, a Reddit reply."),
  sources: z.array(z.string()).default([]),
});

export const RunStateSubjectRowSchema = z.object({
  subject: z.string().min(1),
  angle: z.string().optional(),
  type: z.string().optional(),
  stage: StageSchema.optional(),
  goal: z.string().optional(),
  status: z.enum(["drafted", "approved", "posted", "skipped"]).default("drafted"),
  assetKind: z.string().optional(),
  strategyRowId: z.string().nullable().optional(),
});

export const RunStateRecordInputSchema = z.object({
  runId: z.string().min(1).describe("The run this record belongs to — the idempotency key of the whole write."),
  platform: z.string().min(1).describe("The engine's platform key: x, linkedin, reddit, instagram, tiktok."),
  deliverable: RunStateDeliverableSchema.describe("D11: the deliverable's kind and the goal / audience / why-now line the card shows."),
  subjectRow: RunStateSubjectRowSchema.optional().describe("The row the middleware inserts into the subject table (C7 §3.1) — subject, angle, type, stage, goal, status."),
  platformStateDelta: z
    .object({
      postsByUs: z.number().int().nonnegative().optional().describe("How many posts THIS run added — usually 1. Added to the stored count, never assigned."),
      topics: z.array(z.string()).default([]),
      voiceNotes: z.array(z.string()).default([]),
      account: z.object({ handle: z.string().optional(), url: z.string().optional() }).optional(),
    })
    .optional()
    .describe("What this run adds to the platform's introduction doc: posts by us, topics, voice notes, the account. Merged into the stored doc, never assigned over it."),
  voiceNotes: z.array(z.object({ lesson: z.string().min(1), fromRevision: z.number().int().optional() })).default([]).describe("Voice lessons from this run's review rounds — a reviewer's revision note is the one signal Craft 11 §3 admits for voice."),
  rulesApplied: z.array(z.string()).default([]).describe("The craft rule ids the draft followed, so the loop can measure each rule."),
  readiness: z.object({ present: z.array(z.string()).default([]), absent: z.array(z.string()).default([]) }).optional().describe("Which of the seven projected learning files this run found — the A1 acceptance line."),
});
export type RunStateRecordInput = z.infer<typeof RunStateRecordInputSchema>;

export interface RunStateWriteResult {
  recordPath: string;
  platformStatePath: string;
  created: boolean;
}

interface StoredPlatformState {
  account?: { handle?: string | undefined; url?: string | undefined } | undefined;
  postsByUs?: number | undefined;
  topics?: string[] | undefined;
  voiceNotes?: string[] | undefined;
  lastUpdated?: string | undefined;
  [key: string]: unknown;
}

/** Idempotency across a resumed run: the same run must not count its post twice or repeat its topic. */
interface PlatformStateLedger extends StoredPlatformState {
  contributingRuns?: string[] | undefined;
}

/**
 * `ledger.writeRunState` — the write half of the learning loop (build-plan
 * item A2, C7 §3). One normalised record per run at
 * `state/runs/<runId>.json`, and an upsert of the platform's introduction doc
 * at `state/<platform>/platform-state.json`, both in the workspace the
 * middleware's `collect` reads after the run.
 *
 * Two properties matter more than the field list:
 *
 * - **Idempotent on `runId`.** A resumed run rewrites the same record. The
 *   platform-state upsert remembers which runs already contributed
 *   (`contributingRuns`), so replaying step 20 after a crash does not count
 *   the post twice — C7 invariant 2.
 * - **Merges, never replaces.** The projector may have written a richer
 *   `platform-state` from Postgres than this run knows about. The upsert
 *   changes only what this run learned (`postsByUs`, `topics`, `voiceNotes`,
 *   `lastUpdated`, and the account when the stored doc has none) and leaves
 *   every other field as it found it.
 *
 * Throws on a store failure like every other ledger writer; the workflow
 * primitive around it (`writeRunState`) decides that a failed state write is
 * logged and reported, not a failed run.
 */
export function createWriteRunState(store: WorkspaceStoreLike) {
  return defineTool<RunStateRecordInput, RunStateWriteResult>({
    name: "ledger.writeRunState",
    description:
      "Writes the run's learning-loop record (goal, subject row, platform-state delta, voice notes, craft rules applied, readiness) to state/runs/<runId>.json and upserts state/<platform>/platform-state.json. Idempotent on runId; the platform-state merge never counts one run twice.",
    version: TOOL_VERSION,
    inputSchema: RunStateRecordInputSchema,
    async execute(record, { ctx }) {
      const writtenAt = new Date().toISOString();
      const recordSegments = ["state", "runs", record.runId];
      const { created } = await store.writeJson(ctx.clientSlug, recordSegments, {
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        runId: record.runId,
        clientSlug: ctx.clientSlug,
        productId: ctx.productId,
        platform: record.platform,
        writtenAt,
        deliverable: record.deliverable,
        ...(record.subjectRow ? { subjectRow: record.subjectRow } : {}),
        ...(record.platformStateDelta ? { platformStateDelta: { ...record.platformStateDelta, lastUpdated: writtenAt } } : {}),
        voiceNotes: record.voiceNotes,
        rulesApplied: record.rulesApplied,
        ...(record.readiness ? { readiness: record.readiness } : {}),
      });

      const stateSegments = ["state", record.platform, "platform-state"];
      const existing = (await store.readJson<PlatformStateLedger>(ctx.clientSlug, stateSegments)) ?? {};
      const contributing = Array.isArray(existing.contributingRuns) ? existing.contributingRuns : [];
      const delta = record.platformStateDelta;
      if (delta && !contributing.includes(record.runId)) {
        const topics = Array.isArray(existing.topics) ? existing.topics : [];
        const voiceNotes = Array.isArray(existing.voiceNotes) ? existing.voiceNotes : [];
        const account = existing.account ?? delta.account;
        const next: PlatformStateLedger = {
          ...existing,
          ...(account !== undefined ? { account } : {}),
          postsByUs: (typeof existing.postsByUs === "number" ? existing.postsByUs : 0) + (delta.postsByUs ?? 0),
          topics: [...topics, ...delta.topics.filter((t) => !topics.includes(t))].slice(-200),
          voiceNotes: [...voiceNotes, ...delta.voiceNotes.filter((n) => !voiceNotes.includes(n))].slice(-50),
          lastUpdated: writtenAt,
          contributingRuns: [...contributing, record.runId].slice(-500),
        };
        await store.writeJson(ctx.clientSlug, stateSegments, next);
      } else if (!delta && Object.keys(existing).length === 0) {
        // A first run with nothing to add still leaves the doc in place, so
        // the collector finds a file and not a 404 it has to reason about.
        await store.writeJson(ctx.clientSlug, stateSegments, { postsByUs: 0, topics: [], voiceNotes: [], lastUpdated: writtenAt, contributingRuns: [] });
      }

      return success<RunStateWriteResult>({
        recordPath: recordSegments.join("/"),
        platformStatePath: stateSegments.join("/"),
        created,
      });
    },
  });
}
