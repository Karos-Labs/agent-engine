import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** Numeric-claim shapes that read as a factual assertion needing a source: percentages, currency, multipliers, magnitude words. */
const NUMERIC_CLAIM_PATTERN = /(\d[\d,]*(?:\.\d+)?\s?%)|([$€£]\s?\d[\d,]*(?:\.\d+)?)|(\b\d+(?:\.\d+)?x\b)|(\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b)/gi;

/** Citation-style markers that count as "this number is sourced" for Phase 1's deterministic check. */
const CITATION_MARKER_PATTERN = /\[\d+\]|\(source:|according to/i;

export const NumbersSourcedInputSchema = z.object({
  text: z.string(),
  /** Source citations attached to this draft out-of-band (e.g. from the research step). Non-empty counts as "sourced". */
  sources: z.array(z.string()).default([]),
});
export type NumbersSourcedInput = z.infer<typeof NumbersSourcedInputSchema>;

/** Fails if the draft makes a numeric claim (percentage, currency, "10x", "$1.2 million", ...) with no citation anywhere. */
export const numbersSourced = defineTool<NumbersSourcedInput, GateVerdict>({
  name: "gate.numbersSourced",
  version: TOOL_VERSION,
  inputSchema: NumbersSourcedInputSchema,
  async execute({ text, sources }) {
    const claims = Array.from(text.matchAll(NUMERIC_CLAIM_PATTERN)).map((m) => m[0]);

    if (claims.length === 0) {
      return success<GateVerdict>({ verdict: "pass", evidence: ["no numeric claims found"], toolVersion: TOOL_VERSION });
    }

    const hasCitationMarker = CITATION_MARKER_PATTERN.test(text);
    const isSourced = hasCitationMarker || sources.length > 0;

    if (!isSourced) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: claims,
        reason: `text makes ${claims.length} numeric claim(s) with no citation marker and no attached source`,
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [`${claims.length} numeric claim(s), sourced`],
      toolVersion: TOOL_VERSION,
    });
  },
});
