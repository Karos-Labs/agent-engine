import type { AgentContext, AgentToolRegistry, FunnelStage } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * C7 (`docs/contracts/C7-run-context.md`, SCRUM-458/459/460): the learning
 * loop's two seams, shared by every publishing agent.
 *
 * `readLearningContext` is the read side of build-plan item A1 — everything
 * the platform has learned about the client on this platform, projected into
 * the workspace before dispatch. `writeRunState` is the write side of A2 —
 * the one normalised record a run hands back. Both follow the stance every
 * optional drafting input in this package already takes (`readContextDoc`,
 * `readPastFeedback`, `readClientIntelContext`): best-effort, checkpointed,
 * and the only way out is a value the caller can act on — never a thrown
 * error, never a held run. A run on a tree where none of the writers have
 * shipped yet behaves exactly as it did before this file existed.
 *
 * This package sits below every tool in the dependency graph (RFC-01 §4), so
 * the document shapes are duck-typed here rather than imported from
 * `@agent-engine/tool-karos-client` — the same reason `style-preferences.ts`
 * defines `StylePreferenceLike` locally. The contract file is the source of
 * truth for both sides; a test in `karos-client` pins the tool to it.
 */

export type LearningPlatform = "x" | "linkedin" | "reddit" | "instagram" | "tiktok";

export interface LearningSubjectRow {
  id?: string;
  runId?: string;
  subject: string;
  angle?: string;
  type?: string;
  stage?: string;
  goal?: string;
  status?: string;
  draftedAt?: string;
  postedAt?: string;
}

export interface LearningFeedbackRow {
  runId?: string;
  account?: string;
  action: string;
  reason?: string | null;
  originalText?: string | null;
  finalText?: string | null;
  at?: string;
}

export interface LearningPreferences {
  neverTopics?: string[];
  likes?: Array<{ note?: string; postRef?: string }>;
  voiceNotes?: Array<{ lesson?: string; fromRunId?: string }>;
  standingInstructions?: string[];
  derivedAt?: string;
  derivedFromCount?: number;
}

export interface LearningStrategyRow {
  id: string;
  problem?: string;
  stage: string;
  idea: string;
  type?: string;
  evidence?: string;
  status?: string;
}

export interface LearningStrategyMap {
  platform?: string;
  builtAt?: string;
  source?: string;
  audience?: Array<{ role?: string; problems?: string[] }>;
  rows: LearningStrategyRow[];
  defaultMix?: { attention?: number; expertise?: number; decide?: number };
}

export interface LearningCraftRule {
  id: string;
  layer: string;
  kind: string;
  rule: string;
  why?: string;
  metric?: string;
  sampleSize?: number;
}

export interface LearningCraft {
  platform?: string;
  rules: LearningCraftRule[];
  overrides?: Array<{ winner: string; loser: string }>;
}

export interface LearningContextLike {
  platform: LearningPlatform;
  platformState?: Record<string, unknown>;
  subjectWindow?: { windowDays?: number; rows: LearningSubjectRow[] };
  feedback?: { rows: LearningFeedbackRow[] };
  preferences?: LearningPreferences;
  whatWorks?: Record<string, unknown>;
  strategyMap?: LearningStrategyMap;
  craft?: LearningCraft;
  readiness: { present: string[]; absent: string[] };
}

/** The seven C7 §2 file names, in the order the readiness line reports them. */
export const LEARNING_DOC_NAMES = ["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"] as const;

/** What a run reports when the tool is not in its registry: everything absent. The shape is the same, so callers never branch on "was there a tool". */
export function emptyLearningContext(platform: LearningPlatform): LearningContextLike {
  return { platform, readiness: { present: [], absent: [...LEARNING_DOC_NAMES] } };
}

/**
 * Reads the projected learning context for `platform`, checkpointed under
 * `stepId`. Never throws; a registry without the tool, a tool error and an
 * empty workspace all come back as the same "everything absent" value.
 *
 * Checkpointed like `readContextDoc`, because a resumed run must draft from
 * the same context the first attempt saw — a subject window that grew between
 * the two attempts would make the run disagree with its own step record.
 */
export async function readLearningContext(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  platform: LearningPlatform,
  stepId: string,
): Promise<LearningContextLike> {
  return wf.step.code(stepId, async (): Promise<LearningContextLike> => {
    const tool = tools["client.getLearningContext"];
    if (!tool) return emptyLearningContext(platform);
    try {
      const outcome = await tool.execute({ platform }, { ctx });
      if (outcome.status !== "success") return emptyLearningContext(platform);
      const result = outcome.result as Partial<LearningContextLike>;
      const readiness = result.readiness && Array.isArray(result.readiness.present) && Array.isArray(result.readiness.absent) ? result.readiness : emptyLearningContext(platform).readiness;
      // One line per run, the A1 acceptance criterion made greppable: which
      // of the seven files this run actually found.
      console.info(`${stepId}: learning context for ${ctx.clientSlug}/${platform} — present: [${readiness.present.join(", ")}] absent: [${readiness.absent.join(", ")}]`);
      return { ...result, platform, readiness } as LearningContextLike;
    } catch (error) {
      console.error(`${stepId}: could not read the learning context for ${platform}, continuing without it`, error);
      return emptyLearningContext(platform);
    }
  });
}

// ── Pure helpers over the context. All total functions; all tested in isolation. ──

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "be", "by", "at", "as", "it", "its", "this", "that", "from", "how", "why", "what", "your", "our", "you", "we",
]);

/** Content tokens of a subject line: lower-cased words of three letters or more, minus the stop list. Exported for the callers that want the same tokenisation for their own logging. */
export function subjectTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Whether `topic` is the same subject as a row in the window — the
 * anti-repetition rule of 02 §3.2, applied to topics rather than to finished
 * text (the finished-text check is `checkOutputDedupe`). Two subjects are the
 * same when one's content tokens are at least `threshold` covered by the
 * other's, measured against the SHORTER of the two so "AI pricing" against
 * "how AI pricing is changing in 2026" reads as a repeat. Deliberately
 * conservative (0.75): a lint that refuses adjacent ideas gets switched off.
 */
export function subjectWindowConflict(topic: string, window: { rows: LearningSubjectRow[] } | undefined, threshold = 0.75): LearningSubjectRow | undefined {
  if (!window || window.rows.length === 0) return undefined;
  const mine = subjectTokens(topic);
  if (mine.size === 0) return undefined;
  for (const row of window.rows) {
    if (row.status === "skipped") continue;
    const theirs = subjectTokens(row.subject);
    if (theirs.size === 0) continue;
    const shorter = mine.size <= theirs.size ? mine : theirs;
    const longer = shorter === mine ? theirs : mine;
    let shared = 0;
    for (const t of shorter) if (longer.has(t)) shared += 1;
    if (shared / shorter.size >= threshold) return row;
  }
  return undefined;
}

/** Whether `topic` touches one of the client's never-topics (C7 §2.4). A never-topic is matched on its own tokens, all of which must appear in the topic. */
export function touchesNeverTopic(topic: string, preferences: LearningPreferences | undefined): string | undefined {
  const never = preferences?.neverTopics ?? [];
  if (never.length === 0) return undefined;
  const mine = subjectTokens(topic);
  for (const entry of never) {
    const theirs = subjectTokens(entry);
    if (theirs.size === 0) continue;
    let all = true;
    for (const t of theirs) {
      if (!mine.has(t)) {
        all = false;
        break;
      }
    }
    if (all) return entry;
  }
  return undefined;
}

/** D32's default mix, in the order a run walks it when it has no slot stage and no history to weigh. */
export const DEFAULT_STAGE_MIX: readonly FunnelStage[] = ["attention", "attention", "attention", "expertise", "expertise", "decide"];

/**
 * The stage this run should write for: the calendar slot's when it names
 * one, else the next stage in D32's default mix given how many of each stage
 * the subject window already holds. Total, never undefined — a run with no
 * information gets `attention`, which is where every funnel starts.
 */
export function stageForRun(slotStage: FunnelStage | undefined, window: { rows: LearningSubjectRow[] } | undefined): FunnelStage {
  if (slotStage) return slotStage;
  const counts: Record<FunnelStage, number> = { attention: 0, expertise: 0, decide: 0 };
  for (const row of window?.rows ?? []) {
    if (row.status === "skipped") continue;
    if (row.stage === "attention" || row.stage === "expertise" || row.stage === "decide") counts[row.stage] += 1;
  }
  const total = counts.attention + counts.expertise + counts.decide;
  // Walk the mix from where the window's count leaves off: six posts per
  // cycle, three/two/one. The stage most BEHIND its share goes first, so a
  // client whose last six were all attention gets expertise next.
  const target = { attention: 3 / 6, expertise: 2 / 6, decide: 1 / 6 } as const;
  let best: FunnelStage = "attention";
  let worstDeficit = -Infinity;
  for (const stage of ["attention", "expertise", "decide"] as const) {
    const deficit = target[stage] - (total === 0 ? 0 : counts[stage] / total);
    if (deficit > worstDeficit) {
      worstDeficit = deficit;
      best = stage;
    }
  }
  return best;
}

/**
 * The strategy-map row this run should take: the first `open` row at the
 * wanted stage whose idea is not already in the subject window, else the
 * first open row at any stage, else nothing. Returns `undefined` when the
 * map is absent or spent — the caller keeps its existing topic selection.
 */
export function pickStrategyRow(map: LearningStrategyMap | undefined, stage: FunnelStage, window: { rows: LearningSubjectRow[] } | undefined): LearningStrategyRow | undefined {
  if (!map || map.rows.length === 0) return undefined;
  const open = map.rows.filter((r) => (r.status ?? "open") === "open" && subjectWindowConflict(r.idea, window) === undefined);
  return open.find((r) => r.stage === stage) ?? open[0];
}

/**
 * The craft rules as the drafting prompt receives them (D41: instructions,
 * not a checklist). Hard rules first, then defaults, each with its id so the
 * model can report `rulesApplied`. `overrides` are rendered as one line each
 * so the model sees that a client rule deliberately displaced a base default.
 * Bounded so a store with hundreds of rules cannot swamp the prompt.
 */
export function craftRulesForPrompt(craft: LearningCraft | undefined, limit = 40): string | undefined {
  if (!craft || craft.rules.length === 0) return undefined;
  const hard = craft.rules.filter((r) => r.kind === "hard");
  const defaults = craft.rules.filter((r) => r.kind !== "hard");
  const lines: string[] = [];
  if (hard.length > 0) {
    lines.push("HARD RULES — always win, nothing below may override them:");
    for (const r of hard.slice(0, limit)) lines.push(`- [${r.id}] ${r.rule}${r.metric ? ` (moves: ${r.metric})` : ""}`);
  }
  if (defaults.length > 0) {
    lines.push(hard.length > 0 ? "DEFAULTS — the client's learned rules (L3) beat the sector's (L2) beat the platform's (L1):" : "RULES — the client's learned rules (L3) beat the sector's (L2) beat the platform's (L1):");
    for (const r of defaults.slice(0, Math.max(0, limit - hard.length))) {
      const evidence = r.sampleSize !== undefined ? `, n=${r.sampleSize}` : "";
      lines.push(`- [${r.id}] (${r.layer}${evidence}) ${r.rule}${r.metric ? ` (moves: ${r.metric})` : ""}`);
    }
  }
  for (const o of craft.overrides ?? []) lines.push(`- ${o.winner} overrides ${o.loser} for this client.`);
  return lines.join("\n");
}

/** Recent client feedback in the two-line form the prompts already use for `pastFeedback`: the action and what changed. Skips rows with nothing a writer can act on. */
export function feedbackForPrompt(feedback: { rows: LearningFeedbackRow[] } | undefined, limit = 8): string[] {
  if (!feedback) return [];
  const out: string[] = [];
  for (const row of feedback.rows.slice(-limit).reverse()) {
    if (row.action === "posted_with_edits" && row.originalText && row.finalText) {
      out.push(`Edited before posting (${row.at ?? "recently"}): the client changed the draft. Original: "${row.originalText.slice(0, 200)}" → Final: "${row.finalText.slice(0, 200)}"`);
    } else if ((row.action === "skipped" || row.action === "change_requested") && row.reason) {
      out.push(`${row.action === "skipped" ? "Skipped" : "Change requested"} (${row.at ?? "recently"}): ${row.reason}`);
    } else if (row.action === "note" && row.reason) {
      out.push(`Note from the client (${row.at ?? "recently"}): ${row.reason}`);
    }
  }
  return out;
}

// ── The write side ──

export interface RunStateRecord {
  platform: LearningPlatform;
  deliverable: {
    kind: string;
    goal?: FunnelStage;
    audience?: string;
    whyNow?: string;
    type?: string;
    sources?: string[];
  };
  subjectRow?: {
    subject: string;
    angle?: string;
    type?: string;
    stage?: FunnelStage;
    goal?: string;
    status?: "drafted" | "approved" | "posted" | "skipped";
    assetKind?: string;
    strategyRowId?: string | null;
  };
  platformStateDelta?: {
    postsByUs?: number;
    topics?: string[];
    voiceNotes?: string[];
    account?: { handle?: string; url?: string };
  };
  voiceNotes?: Array<{ lesson: string; fromRevision?: number }>;
  rulesApplied?: string[];
  readiness?: { present: string[]; absent: string[] };
}

export interface RunStateWriteOutcome {
  written: boolean;
  recordPath?: string;
  reason?: string;
}

/**
 * Writes the run's state record through `ledger.writeRunState`, checkpointed
 * under `stepId`. Never throws: a run that drafted, passed every gate and was
 * approved has delivered, and a failed state write must not turn that into a
 * failed run. It IS reported — the step record holds `{written: false,
 * reason}` and the log carries an error — because a loop that silently
 * stopped learning is worse than one that loudly did.
 */
export async function writeRunState(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  stepId: string,
  record: RunStateRecord,
): Promise<RunStateWriteOutcome> {
  return wf.step.code(stepId, async (): Promise<RunStateWriteOutcome> => {
    const tool = tools["ledger.writeRunState"];
    if (!tool) return { written: false, reason: "ledger.writeRunState is not in this registry" };
    try {
      const outcome = await tool.execute({ runId: wf.runId, ...record }, { ctx });
      if (outcome.status !== "success") {
        const reason = `ledger.writeRunState resolved to ${outcome.status}`;
        console.error(`${stepId}: ${reason}`);
        return { written: false, reason };
      }
      const result = outcome.result as { recordPath?: string };
      return { written: true, ...(result.recordPath ? { recordPath: result.recordPath } : {}) };
    } catch (error) {
      console.error(`${stepId}: could not write the run state record, the run's deliverable stands`, error);
      return { written: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}
