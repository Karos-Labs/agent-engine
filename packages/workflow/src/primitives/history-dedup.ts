import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { evaluateDedupe, type DedupeHistoryEntry, type DedupeVerdict } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * The read/format/score half of output de-duplication for the FIXED channel
 * agents, built on machinery that already existed end to end but was only
 * ever wired for dynamic agents: `ledger.recordOutputExcerpt` /
 * `listOutputExcerpts` (the rolling 25-entry per-(client, agent) window) and
 * `evaluateDedupe` (the calibrated trigram-Jaccard scorer). Five of six
 * channel agents already ASKED for this history via `research.pull`'s
 * `historyAgentId` — but nothing ever wrote the store, so `priorPosts` was
 * `[]` for every client, forever. The write half lives with each agent's
 * own deliver step; these helpers are the shared read half.
 *
 * Everything here follows `evaluateDedupe`'s own policy: de-duplication
 * FLAGS and steers, it never throws and never holds a run.
 */

/** How many recent excerpts reach the drafting prompt. Bounded like `pastFeedback` — history must not push the actual brief out of the context window. */
const DEDUPE_DIRECTIVE_LIMIT = 8;
/** Per-post cap inside the directive, mirroring research.pull's own HISTORY_EXCERPT_CHARS. */
const DEDUPE_DIRECTIVE_EXCERPT_CHARS = 600;

/**
 * Reads this agent's recent shipped output for the current client —
 * best-effort, bounded, checkpointed under `stepId` (same pattern as
 * `readPastFeedback` above it in this directory). `excludeRunId` should be
 * the current run's id, so a resumed run is never compared against its own
 * earlier delivery.
 */
export async function readOutputHistoryForDedup(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  agentId: string,
  stepId = "read-output-history",
): Promise<DedupeHistoryEntry[]> {
  return wf.step.code(stepId, async () => {
    const list = tools["ledger.listOutputExcerpts"];
    if (!list) return [] as DedupeHistoryEntry[];
    try {
      const outcome = await list.execute({ agentId, excludeRunId: wf.runId }, { ctx });
      if (outcome.status !== "success") return [] as DedupeHistoryEntry[];
      const entries = (outcome.result as { entries: Array<{ runId: string; excerpt: string }> }).entries;
      return entries.map((e) => ({ runId: e.runId, excerpt: e.excerpt }));
    } catch (error) {
      console.error(`${stepId}: could not read output history, drafting without it`, error);
      return [] as DedupeHistoryEntry[];
    }
  });
}

/**
 * Formats the history as a hard do-not-repeat directive for a drafting
 * agent's input. Returns undefined for an empty history so a caller can
 * spread it conditionally and a first run's prompt stays byte-identical to
 * what it was before de-duplication existed — the same contract
 * `revisionDirective` keeps.
 */
export function dedupeDirective(history: readonly DedupeHistoryEntry[]): string | undefined {
  if (history.length === 0) return undefined;
  const recent = history.slice(-DEDUPE_DIRECTIVE_LIMIT);
  const lines = recent.map((h, i) => `${i + 1}. ${h.excerpt.slice(0, DEDUPE_DIRECTIVE_EXCERPT_CHARS)}`);
  return [
    "This client RECENTLY PUBLISHED the posts below. Do not repeat them: not the topic, not the hook, not the angle, not the case study. Writing the same idea in different words is still a repeat.",
    ...lines,
  ].join("\n");
}

/**
 * Scores a finished draft against the same history, recorded as its own
 * checkpointed step so the verdict is in the trace either way. The caller
 * decides what a `"similar"` verdict does — route into its own existing
 * retry loop with `retryDirective(verdict, history)` injected, or ship
 * flagged on the final attempt. Never throw on it: two posts a fortnight
 * apart about the same launch may be exactly right, and a fixed threshold
 * is not entitled to overrule the human gate downstream.
 */
export async function checkOutputDedupe(
  wf: WorkflowContext,
  stepId: string,
  draftText: string,
  history: readonly DedupeHistoryEntry[],
): Promise<DedupeVerdict> {
  return wf.step.code(stepId, () => evaluateDedupe(draftText, history));
}

/** The redraft steer when a draft scored too close to a recent post — quotes the offender so the model knows exactly what to move away from. */
export function dedupeRetryDirective(verdict: DedupeVerdict, history: readonly DedupeHistoryEntry[]): string {
  const offender = history.find((h) => h.runId === verdict.mostSimilarRunId);
  return [
    `Your draft is too similar (${Math.round(verdict.maxSimilarity * 100)}% overlap) to a post this client already published. Take a genuinely different angle: a different hook, a different structure, different examples.`,
    ...(offender ? [`The already-published post:\n${offender.excerpt.slice(0, DEDUPE_DIRECTIVE_EXCERPT_CHARS)}`] : []),
  ].join("\n");
}

/**
 * Distills a client's intel report into a bounded drafting-context string —
 * the sibling of `buildClientVoiceContext`, for `intel.getReport`'s output.
 * Only the fields that steer COPY are taken (voice rows/archetypes/
 * territory, positioning, whitespace opportunities); scores, SWOT and
 * competitor tables are the portal's concern, not a caption writer's.
 * Returns undefined when nothing usable exists, so callers spread it
 * conditionally and clients without a report see zero change.
 */
export function buildClientIntelContext(report: unknown): string | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const r = report as Record<string, unknown>;
  const parts: string[] = [];

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

  const voiceRows = strList(r["brandVoiceRows"]);
  if (voiceRows.length > 0) parts.push(`Brand voice:\n- ${voiceRows.slice(0, 8).join("\n- ")}`);
  const archetypes = strList(r["brandVoiceArchetypes"]);
  if (archetypes.length > 0) parts.push(`Voice archetypes: ${archetypes.slice(0, 4).join(", ")}`);
  const territory = str(r["brandVoiceTerritory"]);
  if (territory !== undefined) parts.push(`Voice territory: ${territory}`);
  const positioning = str(r["positioningAnalysis"]);
  if (positioning !== undefined) parts.push(`Positioning:\n${positioning.slice(0, 1200)}`);
  const whitespace = strList(r["whitespaceOpportunities"]);
  if (whitespace.length > 0) parts.push(`Whitespace opportunities the client wants to own:\n- ${whitespace.slice(0, 6).join("\n- ")}`);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** How much of each synced context doc reaches the drafting prompt. The sync already caps a doc at 6k; this is the tighter per-prompt slice. */
const KNOWLEDGE_DOC_SLICE_CHARS = 1200;
/** How many docs, at most — the knowledge layer augments the brief, it must never displace it. */
const KNOWLEDGE_DOC_LIMIT = 6;
const KNOWLEDGE_MEETING_LIMIT = 5;
const KNOWLEDGE_MEETING_SUMMARY_CHARS = 300;

/**
 * Distills the synced client knowledge base (`client.getKnowledge` — the
 * portal's onboarding docs, recent meeting summaries) into a bounded
 * drafting-context string, the sibling of `buildClientIntelContext` above.
 * The asset index is deliberately NOT distilled here: a caption writer needs
 * facts and tone, not a file listing. Returns undefined when nothing usable
 * exists, so clients whose sync has never run see zero prompt change.
 */
export function buildClientKnowledgeContext(knowledge: unknown): string | undefined {
  if (typeof knowledge !== "object" || knowledge === null) return undefined;
  const k = knowledge as Record<string, unknown>;
  const parts: string[] = [];

  const docs = Array.isArray(k["contextDocs"]) ? (k["contextDocs"] as Array<Record<string, unknown>>) : [];
  const docBlocks = docs
    .filter((d) => typeof d["docType"] === "string" && typeof d["content"] === "string" && (d["content"] as string).trim().length > 0)
    .slice(0, KNOWLEDGE_DOC_LIMIT)
    .map((d) => `### ${d["docType"] as string}\n${(d["content"] as string).trim().slice(0, KNOWLEDGE_DOC_SLICE_CHARS)}`);
  if (docBlocks.length > 0) {
    parts.push(`Client knowledge base (authoritative — ground claims, tone and terminology in this before any external source):\n\n${docBlocks.join("\n\n")}`);
  }

  const meetings = Array.isArray(k["transcripts"]) ? (k["transcripts"] as Array<Record<string, unknown>>) : [];
  const meetingLines = meetings
    .filter((m) => typeof m["title"] === "string")
    .slice(0, KNOWLEDGE_MEETING_LIMIT)
    .map((m) => {
      const summary = typeof m["summary"] === "string" && m["summary"].trim().length > 0 ? ` — ${m["summary"].trim().slice(0, KNOWLEDGE_MEETING_SUMMARY_CHARS)}` : "";
      return `- ${(m["title"] as string).trim()}${summary}`;
    });
  if (meetingLines.length > 0) parts.push(`Recent client meetings:\n${meetingLines.join("\n")}`);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Reads the client's intel report AND synced knowledge base (each
 * best-effort), distilled into one bounded string, checkpointed under the
 * SAME step id and `string|null` shape this helper always had — which is the
 * point: every agent already threading `clientIntelContext` into its
 * drafting input picks the knowledge layer up with zero further changes.
 * `intel.getReport`/`client.getKnowledge` are registered in every agent's
 * registry and return `not_available` cleanly when nothing exists.
 */
export async function readClientIntelContext(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  stepId = "read-intel-context",
): Promise<string | undefined> {
  return (
    (await wf.step.code(stepId, async () => {
      const parts: string[] = [];
      try {
        const get = tools["intel.getReport"];
        const outcome = get ? await get.execute({}, { ctx }) : undefined;
        if (outcome?.status === "success") {
          const distilled = buildClientIntelContext((outcome.result as { report?: unknown }).report);
          if (distilled !== undefined) parts.push(distilled);
        }
      } catch (error) {
        console.error(`${stepId}: could not read the intel report, drafting without it`, error);
      }
      try {
        const get = tools["client.getKnowledge"];
        const outcome = get ? await get.execute({}, { ctx }) : undefined;
        if (outcome?.status === "success") {
          const distilled = buildClientKnowledgeContext(outcome.result);
          if (distilled !== undefined) parts.push(distilled);
        }
      } catch (error) {
        console.error(`${stepId}: could not read the client knowledge base, drafting without it`, error);
      }
      // JSON round-trip note: `null`, never `undefined`, crosses the
      // checkpoint — same rule 02c-load-brand-kit documents.
      return parts.length > 0 ? parts.join("\n\n") : null;
    })) ?? undefined
  );
}
