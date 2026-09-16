import type { XSelectedCandidate } from "./types.js";

/**
 * C7 (SCRUM-458/459/460) — what is X-specific about the learning loop. The
 * shapes shared with LinkedIn and Reddit (`GOAL_LINE`,
 * `platformStateForDrafting`, `preferencesForDrafting`) live in
 * `@agent-engine/workflow`.
 */

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
