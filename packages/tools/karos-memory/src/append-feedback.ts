import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

// 1.0.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input (both tools below share this constant).
// 1.1.0 (SCRUM-306/AU23): added optional `content` — see its own field doc.
// 1.2.0 (IGSTYLE-4): added optional `style`/`scope`/`slide` — see their own
// field docs below. The task spec calls for bumping to "1.1.0", written
// before SCRUM-306/AU23 already claimed that version on `origin/main` for the
// unrelated `content` field — the same kind of pre-existing-work collision
// IGSTYLE-3 hit with its `02e`/`02f` step ids. Resolved the same way: bump
// past the collision (1.2.0) rather than reuse a version this tool already
// shipped under different content.
const TOOL_VERSION = "1.2.0";

export const StyleIntentSchema = z.object({
  role: z.enum(["ground", "fg", "accent"]),
  direction: z.enum(["darker", "lighter", "more-contrast", "hue"]),
  hue: z.string().optional(),
});

/**
 * IGSTYLE-4, §3 — a durable copy of one revision round's
 * `StyleDirectiveResult` (`agents/instagram-agent/src/workflow/style-directive.ts`),
 * shaped identically but defined locally rather than imported: this package
 * sits below every agent in the dependency graph (agents depend on
 * `karos-memory`, never the reverse), so it cannot import an agent's own
 * type. `refusals` is deliberately NOT carried here — a refused pick is
 * exactly the kind of "what was wrong" signal rule 1 (never learn from a
 * `reject`) already excludes from voting; this schema only stores what a
 * later run's distillation is meant to learn FROM.
 */
export const StylePreferenceSchema = z.object({
  overrides: z.record(z.string(), z.string()),
  source: z.enum(["structured", "parsed", "model"]),
  intents: z.array(StyleIntentSchema).max(8).default([]),
  applied: z.array(z.string()).max(12).default([]),
});
export type StylePreference = z.infer<typeof StylePreferenceSchema>;

export const AppendFeedbackInputSchema = z.object({
  feedbackId: z
    .string()
    .min(1)
    .describe(
      "Caller-minted idempotency key. `${runId}-r${revision}` is the natural choice: a run replayed after a crash must not append a reviewer's note twice, and that key is stable across replays.",
    ),
  productId: z.string().min(1).describe("Which product the feedback was about, so a later run can weight its own agent's history first."),
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  decision: z.enum(["approve", "revise", "reject"]).describe("The reviewer's verdict on the work being judged."),
  actor: z.string().min(1).describe("Who gave this feedback (a human reviewer's name/id)."),
  note: z.string().min(1).describe("The reviewer's words. The whole point of the row."),
  revision: z.number().int().nonnegative().default(0).describe("Which revision round produced the output being judged."),
  runId: z.string().min(1).optional().describe("The run this came from, for tracing a preference back to what prompted it."),
  // SCRUM-306 (AU23): the lost half of the signal. A reject (or any other
  // decision) used to be recorded as `note` alone — why a reviewer said no —
  // with the actual thing they said no TO surviving only in step checkpoints,
  // never reaching this pipeline. `content` is that thing, when the caller
  // has one to attach. No `.min()`/length cap and no trimming anywhere on the
  // write path: this is stored and read back BYTE-IDENTICAL on purpose — a
  // truncated or summarized copy of exactly the text a client rejected would
  // defeat the reason it's captured at all. Optional because not every
  // decision has drafted content worth a second copy (an approval's content
  // already has a durable, full copy via `ledger.writeDeliverable`).
  content: z
    .string()
    .optional()
    .describe(
      "The exact drafted content this decision judged, verbatim — not a summary or excerpt. Stored and read back byte-identical, with no length cap. Typically attached on `reject`, where the content would otherwise survive only in step checkpoints and never reach this pipeline.",
    ),
  // IGSTYLE-4: the structured half of the signal `distillStylePreferences`
  // (`@agent-engine/workflow`) votes over. Optional and additive — a caller
  // (or an agent with no style directive at all) omits it exactly as today.
  style: StylePreferenceSchema.optional().describe(
    "This round's resolved style directive (IGSTYLE-2's StyleDirectiveResult, minus refusals), when this decision carried one — the evidence a later run's distillStylePreferences votes over.",
  ),
  // Defaulted, not optional-with-no-fallback: every NEW row gets an explicit
  // scope so a reader never has to guess, while a MISSING scope on a row
  // written before this field existed still reads back as "post" — see
  // `createReadFeedback`'s own back-compat fill-in below, which is what
  // actually carries that promise for rows already on disk (a schema default
  // only ever applies to a fresh parse of NEW input, never to old JSON read
  // straight off the store).
  scope: z.enum(["post", "slide", "template", "style"]).default("post").describe(
    "What this feedback is about: the whole post (default), one slide, a template choice, or a style-only pick. Distillation and template-critique rows use this to avoid mixing unrelated kinds of feedback together.",
  ),
  slide: z.number().int().positive().optional().describe("Which slide this feedback concerns, when scope is \"slide\"."),
});
export type AppendFeedbackInput = z.input<typeof AppendFeedbackInputSchema>;

/**
 * `memory.appendFeedback` — durable review feedback, per client.
 *
 * ## Why this is not `memory.appendDecision`
 *
 * A decision is something an AGENT concluded and is recording so it stays
 * consistent with itself. This is something a PERSON asked for, and the two
 * want different treatment: feedback is read back as instruction on the next
 * run, is attributed to a human, and carries a verdict. Folding them into one
 * log would mean a later run could not tell "we decided to lead with the
 * metric" from "the client told us to stop leading with the metric".
 *
 * Written for EVERY decision including approvals, deliberately. An approving
 * reviewer who says "the shorter hooks are working" is teaching the system
 * something, and a store that only remembers complaints learns a distorted
 * version of what a client wants.
 *
 * Idempotent on `feedbackId`, so a replayed run appends one row.
 */
export function createAppendFeedback(store: WorkspaceStoreLike) {
  return defineTool<AppendFeedbackInput, IdempotentWriteResult>({
    name: "memory.appendFeedback",
    description:
      "Durable review feedback, per client — a person's verdict (approve/revise/reject) plus their note, written for every decision including approvals so the system learns what's working, not only what's wrong. Optionally carries the exact drafted content the decision judged (byte-identical, uncapped) — the WHAT alongside the note's WHY — and, since IGSTYLE-4, an optional resolved style pick plus a scope (post/slide/template/style) so distillStylePreferences can vote over style history without mixing in unrelated feedback. Idempotent on feedbackId, so a replayed run appends one row.",
    version: TOOL_VERSION,
    inputSchema: AppendFeedbackInputSchema,
    async execute(input, { ctx }) {
      const segments = ["memory", "feedback", input.feedbackId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        feedbackId: input.feedbackId,
        productId: input.productId,
        decision: input.decision,
        actor: input.actor,
        note: input.note,
        revision: input.revision,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        // Verbatim, not re-trimmed/re-capped here or anywhere upstream — see
        // the field's own schema doc for why byte-identical is the point.
        ...(input.content !== undefined ? { content: input.content } : {}),
        // `scope` always has a value by the time execute() runs (zod applies
        // its default during input validation, upstream of this function —
        // same convention `ReadFeedbackInputSchema`'s own `limit` default
        // already relies on), so it is always written explicitly on new rows.
        scope: input.scope,
        ...(input.slide !== undefined ? { slide: input.slide } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: input.feedbackId, created });
    },
  });
}

export const ReadFeedbackInputSchema = z.object({
  productId: z.string().min(1).optional().describe("Restrict to one product's history. Omit for every product's."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(
      "Newest-first cap. Bounded because this lands in a drafting prompt: a client with two years of feedback would otherwise push the actual brief out of the context window.",
    ),
});
export type ReadFeedbackInput = z.input<typeof ReadFeedbackInputSchema>;

export interface FeedbackEntry {
  feedbackId: string;
  productId: string;
  decision: "approve" | "revise" | "reject";
  actor: string;
  note: string;
  revision: number;
  runId?: string;
  /** The exact drafted content this decision judged, when one was attached. Byte-identical to what was written — see `AppendFeedbackInputSchema`'s `content` field. */
  content?: string;
  /**
   * IGSTYLE-4. Always present on read, even for a pre-1.2.0 row that never
   * wrote one — `createReadFeedback`'s execute() below fills in `"post"` for
   * any row missing this key, which is what actually delivers the "a missing
   * scope reads as post" backwards-compatibility promise; a zod `.default()`
   * only applies to a fresh parse of new input, never to old JSON already on
   * disk.
   */
  scope: "post" | "slide" | "template" | "style";
  /** Which slide this feedback concerns, when `scope` is `"slide"`. */
  slide?: number;
  /** This round's resolved style directive, when one was attached. See `AppendFeedbackInputSchema`'s `style` field. */
  style?: StylePreference;
  at: number;
}

export interface ReadFeedbackResult {
  entries: FeedbackEntry[];
}

/**
 * `memory.readFeedback` — what people have asked for before, newest first.
 *
 * This is the read side of the flywheel: without it every run starts from
 * zero and the same correction gets made every week.
 */
export function createReadFeedback(store: WorkspaceStoreLike) {
  return defineTool<ReadFeedbackInput, ReadFeedbackResult>({
    name: "memory.readFeedback",
    description:
      "Read-only: what people have asked for before, newest first — the read side of the feedback flywheel, so a run doesn't repeat a correction a client already gave.",
    version: TOOL_VERSION,
    inputSchema: ReadFeedbackInputSchema,
    async execute(input, { ctx }) {
      // No trailing placeholder segment: `dirPath` joins EVERY segment as a
      // directory, so `["memory","feedback","_"]` would look inside a literal
      // `_` folder and always return nothing. `appendFeedback` writes to
      // `["memory","feedback",<id>]`, so the directory to list is its parent.
      //
      // `listJson` returns `{id, data}` wrappers, so the row itself is `.data`.
      const rows = await store.listJson<FeedbackEntry>(ctx.clientSlug, ["memory", "feedback"]);
      const entries = rows
        // IGSTYLE-4 backwards compatibility: a row written before this field
        // existed has no `scope` key at all — fill in `"post"` here, on read,
        // rather than relying on a write-time default that a legacy row on
        // disk never went through. Everything else about the row passes
        // through unchanged ("readFeedback returns legacy rows unchanged").
        .map((r) => ({ ...r.data, scope: r.data.scope ?? "post" }))
        .filter((r) => input.productId === undefined || r.productId === input.productId)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, input.limit);
      return success<ReadFeedbackResult>({ entries });
    },
  });
}
