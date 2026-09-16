import type { FunnelStage } from "@agent-engine/core";
import type { LearningPreferences } from "@agent-engine/workflow";
import type { XSelectedCandidate } from "./types.js";

/**
 * C7 (SCRUM-458/459/460) — the shapes x-agent hands the drafting prompt and
 * the run-state record. Pure functions over step 01b's checkpointed output;
 * every one is total and returns something the prompt can be omitted
 * without.
 */

/** D11's goal line, in the client-facing words 02 §3.5 uses for each stage. */
export const GOAL_LINE: Record<FunnelStage, string> = {
  attention: "earn attention",
  expertise: "show expertise",
  decide: "help them decide",
};

/**
 * The introduction doc, trimmed to what steers copy. Followers and totals
 * are reporting; what works, the top posts' "why" and the voice notes are
 * craft. Bounded so a long-lived account cannot swamp the prompt.
 */
export function platformStateForDrafting(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const whatWorks = state.whatWorks;
  if (Array.isArray(whatWorks) && whatWorks.length > 0) out.whatWorks = whatWorks.filter((w) => typeof w === "string").slice(0, 8);
  const voiceNotes = state.voiceNotes;
  if (Array.isArray(voiceNotes) && voiceNotes.length > 0) out.voiceNotes = voiceNotes.filter((w) => typeof w === "string").slice(-8);
  const topPosts = state.topPosts;
  if (Array.isArray(topPosts) && topPosts.length > 0) {
    out.topPosts = topPosts
      .filter((p): p is { why?: string; metric?: string; url?: string } => Boolean(p) && typeof p === "object")
      .slice(0, 5)
      .map((p) => ({ ...(p.why ? { why: p.why } : {}), ...(p.metric ? { metric: p.metric } : {}), ...(p.url ? { url: p.url } : {}) }));
  }
  if (typeof state.postsByUs === "number") out.postsByUs = state.postsByUs;
  return out;
}

/**
 * The derived preferences as standing instructions: never-topics (the vet
 * already refused the topic; this is so the copy does not wander into one),
 * standing instructions, and the voice lessons learned from the client's
 * edits. Undefined when there is nothing to say.
 */
export function preferencesForDrafting(preferences: LearningPreferences | undefined): Record<string, unknown> | undefined {
  if (!preferences) return undefined;
  const out: Record<string, unknown> = {};
  if (preferences.neverTopics && preferences.neverTopics.length > 0) out.neverTopics = preferences.neverTopics.slice(0, 20);
  if (preferences.standingInstructions && preferences.standingInstructions.length > 0) out.standingInstructions = preferences.standingInstructions.slice(0, 10);
  const lessons = (preferences.voiceNotes ?? []).map((n) => n.lesson).filter((l): l is string => typeof l === "string" && l.trim().length > 0);
  if (lessons.length > 0) out.voiceLessons = lessons.slice(-8);
  const likes = (preferences.likes ?? []).map((l) => l.note).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  if (likes.length > 0) out.likes = likes.slice(-5);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * "Why now", derived from how the topic was chosen when the model did not
 * state one (02 §3.5: news, trend, the client's request, or a planned row).
 */
export function whyNowFor(selected: XSelectedCandidate): string {
  switch (selected.source) {
    case "requested":
      return "the client asked for this topic on this run";
    case "trend":
      return selected.trend?.whyNow ?? "a story in the client's market is live this week";
    case "reserved":
      return "the next planned topic in the client's catalog";
    case "strategy":
      return "the next open row of the client's strategy map for this stage";
    case "research":
      return "the strongest candidate in this week's research";
  }
}
