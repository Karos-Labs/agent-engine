import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/**
 * Banned promise/hype phrases named directly in the migration audit — the
 * legacy Newsletter `compliance-gate.mjs` hard-coded a bank of these (e.g.
 * "guaranteed returns", "risk-free") and always ran it, regardless of
 * whether the client had configured anything of their own. Unlike
 * `forbiddenTerms` below (which is opt-in, per-client), this bank is always
 * active — a legal-risk floor every client gets for free, not something a
 * client can accidentally leave unconfigured. Matched case-insensitively as
 * substrings, on top of whatever `forbiddenTerms` the client configured.
 */
const DEFAULT_BANNED_PROMISE_PHRASES = ["guaranteed returns", "risk-free", "guaranteed income", "zero risk", "guaranteed profit"];

export const BrandComplianceInputSchema = z.object({
  text: z.string(),
  /** Terms this client's brand voice forbids — matched case-insensitively as substrings, on top of the always-on `DEFAULT_BANNED_PROMISE_PHRASES` bank. */
  forbiddenTerms: z.array(z.string()).default([]),
  /** A disclaimer/phrase the draft must contain verbatim (case-insensitive), if the client requires one. */
  requiredDisclaimer: z.string().optional(),
});
export type BrandComplianceInput = z.infer<typeof BrandComplianceInputSchema>;

/**
 * `gate.brandCompliance`'s own result type — a strict superset of the shared
 * `GateVerdict` (every variant here is still a valid `GateVerdict`, so
 * `runGate()`/`GateVerdictSchema.safeParse()` callers keep working unchanged).
 * `configStatus` is the fix for the migration-audit finding that an
 * unconfigured client (no `forbiddenTerms`, no `requiredDisclaimer`) produced
 * the exact same "pass" evidence as a client whose real rules were checked
 * and found clean — making "nothing was actually verified" indistinguishable
 * from "verified and compliant." Kept as a `"pass"` (not a new verdict kind
 * or a forced `content_fail`) so this stays 100% backward compatible with
 * every client that legitimately has no brand rules configured — the goal is
 * visibility, not punishing an unconfigured client with a gate it cannot
 * satisfy by revising its text.
 */
export type BrandComplianceVerdict =
  | { verdict: "pass"; evidence: string[]; toolVersion: string; configStatus: "configured" | "unconfigured" }
  | { verdict: "content_fail"; evidence: string[]; reason: string; toolVersion: string; configStatus: "configured" }
  | { verdict: "tooling_error"; reason: string; toolVersion: string };

/**
 * Fails on a forbidden term, a banned promise/hype phrase, or a missing
 * required disclaimer. `forbiddenTerms`/`requiredDisclaimer` are the
 * client's own brand voice rules, passed in explicitly; the promise/hype
 * bank is always active regardless of what the client configured.
 */
export const brandCompliance = defineTool<BrandComplianceInput, BrandComplianceVerdict>({
  name: "gate.brandCompliance",
  version: TOOL_VERSION,
  inputSchema: BrandComplianceInputSchema,
  async execute({ text, forbiddenTerms, requiredDisclaimer }) {
    const lower = text.toLowerCase();
    // Both unset — this client has no compliance rules of their own configured.
    // Distinct from "configured and clean," which is the only case the old code
    // recognized. Deliberately independent of DEFAULT_BANNED_PROMISE_PHRASES —
    // that bank is a platform-owned floor, not something the client configures,
    // so its presence/absence never flips configStatus either way.
    const configStatus: "configured" | "unconfigured" = forbiddenTerms.length === 0 && !requiredDisclaimer ? "unconfigured" : "configured";
    // The always-on hype/promise-language floor is checked alongside whatever
    // this client's own forbiddenTerms configured — one substring scan, one
    // evidence list, so a match reads the same regardless of which bank it
    // came from.
    const allForbiddenTerms = [...DEFAULT_BANNED_PROMISE_PHRASES, ...forbiddenTerms];
    const matchedForbidden = allForbiddenTerms.filter((term) => term.length > 0 && lower.includes(term.toLowerCase()));

    if (matchedForbidden.length > 0) {
      return success<BrandComplianceVerdict>({
        verdict: "content_fail",
        evidence: matchedForbidden,
        reason: `text contains a forbidden term or banned promise/hype phrase: ${matchedForbidden.join(", ")}`,
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (requiredDisclaimer && !lower.includes(requiredDisclaimer.toLowerCase())) {
      return success<BrandComplianceVerdict>({
        verdict: "content_fail",
        evidence: [requiredDisclaimer],
        reason: "text is missing the required disclaimer",
        toolVersion: TOOL_VERSION,
        configStatus: "configured",
      });
    }

    if (configStatus === "unconfigured") {
      return success<BrandComplianceVerdict>({
        verdict: "pass",
        evidence: [
          "WARNING: no brand compliance rules configured for this client — forbiddenTerms and requiredDisclaimer are both unset; only the always-on banned promise/hype-language floor was actually checked",
        ],
        toolVersion: TOOL_VERSION,
        configStatus: "unconfigured",
      });
    }

    return success<BrandComplianceVerdict>({
      verdict: "pass",
      evidence: ["no forbidden terms, disclaimer present if required"],
      toolVersion: TOOL_VERSION,
      configStatus: "configured",
    });
  },
});
