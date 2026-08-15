import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const BrandComplianceInputSchema = z.object({
  text: z.string(),
  /** Terms this client's brand voice forbids — matched case-insensitively as substrings. */
  forbiddenTerms: z.array(z.string()).default([]),
  /** A disclaimer/phrase the draft must contain verbatim (case-insensitive), if the client requires one. */
  requiredDisclaimer: z.string().optional(),
});
export type BrandComplianceInput = z.infer<typeof BrandComplianceInputSchema>;

/** Fails on a forbidden term or a missing required disclaimer — the client's own brand voice rules, passed in explicitly. */
export const brandCompliance = defineTool<BrandComplianceInput, GateVerdict>({
  name: "gate.brandCompliance",
  version: TOOL_VERSION,
  inputSchema: BrandComplianceInputSchema,
  async execute({ text, forbiddenTerms, requiredDisclaimer }) {
    const lower = text.toLowerCase();
    const matchedForbidden = forbiddenTerms.filter((term) => term.length > 0 && lower.includes(term.toLowerCase()));

    if (matchedForbidden.length > 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: matchedForbidden,
        reason: `text contains a forbidden term: ${matchedForbidden.join(", ")}`,
        toolVersion: TOOL_VERSION,
      });
    }

    if (requiredDisclaimer && !lower.includes(requiredDisclaimer.toLowerCase())) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: [requiredDisclaimer],
        reason: "text is missing the required disclaimer",
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({ verdict: "pass", evidence: ["no forbidden terms, disclaimer present if required"], toolVersion: TOOL_VERSION });
  },
});
