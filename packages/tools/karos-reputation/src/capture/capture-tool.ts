import { defineTool, success } from "@agent-engine/tool-common";
import { captureGbp } from "./gbp.js";
import { captureYelp } from "./yelp.js";
import { captureAppstore } from "./appstore.js";
import { captureManualExport } from "./manual-export.js";
import { CaptureToolInputSchema, type CaptureLegOutcome, type CaptureToolInput, type CaptureToolResult, type ReputationFetchImpl } from "./types.js";

const TOOL_VERSION = "1.0.0";

export interface CreateReputationCaptureOptions {
  /** Defaults to `process.env` — injectable so a workflow (or a test) can supply credentials without mutating the real process environment. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch` — injectable so tests supply canned responses instead of hitting real endpoints (RFC-08 task spec: "App Store should be genuinely testable; mock GBP OAuth / Yelp Fusion key contracts"). */
  fetchImpl?: ReputationFetchImpl;
}

/**
 * `reputation.capture` (RFC-08 §9): wraps `capture.py`'s per-platform legs
 * behind the three-outcome-per-leg contract (`ok` / `UNAVAILABLE` /
 * `not_in_roster`) every downstream consumer (triage, drafting, crisis,
 * reporting) relies on. ADAPTERS.md rule 3, "no leg invention": a leg not
 * in the client's roster is skipped cleanly, never guessed at, and never
 * touches the network.
 */
export function createReputationCapture(options: CreateReputationCaptureOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<CaptureToolInput, CaptureToolResult>({
    name: "reputation.capture",
    version: TOOL_VERSION,
    inputSchema: CaptureToolInputSchema,
    async execute({ legs }) {
      const outcomes: CaptureLegOutcome[] = [];
      for (const leg of legs) {
        if (!leg.inRoster) {
          outcomes.push({ leg: leg.leg, status: "not_in_roster", reviews: [] });
          continue;
        }
        switch (leg.leg) {
          case "gbp":
            outcomes.push(await captureGbp(leg, env, fetchImpl));
            break;
          case "yelp":
            outcomes.push(await captureYelp(leg, env, fetchImpl));
            break;
          case "appstore":
            outcomes.push(await captureAppstore(leg, fetchImpl));
            break;
          case "manual_export":
            outcomes.push(captureManualExport(leg));
            break;
        }
      }
      return success<CaptureToolResult>({ legs: outcomes });
    },
  });
}
