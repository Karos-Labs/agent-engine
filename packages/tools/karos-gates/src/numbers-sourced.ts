import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

/** Numeric-claim shapes that read as a factual assertion needing a source: percentages, currency, multipliers, magnitude words. */
const NUMERIC_CLAIM_PATTERN = /(\d[\d,]*(?:\.\d+)?\s?%)|([$€£]\s?\d[\d,]*(?:\.\d+)?)|(\b\d+(?:\.\d+)?x\b)|(\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b)/gi;

/** Collapses whitespace and case so "47 %" / "47%" / "47  %" all compare equal against source content. */
function normalizeClaim(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

/** Escapes a normalized claim for literal use inside a `RegExp`. */
function escapeForRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a pattern that matches `normalizedClaim` only when it is NOT itself
 * a fragment of a larger number in the source — the "a source saying '15-20'
 * does not support '20'" case this gate exists to catch. Plain
 * `String.includes` treats "20%" as present inside "15-20%" (it is, as a
 * literal substring) and inside "145%" (ditto) — both false verifications a
 * careless or adversarial draft can exploit. A negative lookbehind rejects a
 * match immediately preceded by a digit, comma, period, or hyphen: that
 * covers both a range's upper bound ("15-20%") and simple digit-adjacency
 * ("145%" containing "45%"). It does NOT catch a written-out range using a
 * word instead of a hyphen (e.g. "grew from 15% to 20%") — normalizeClaim's
 * whitespace-stripping collapses "to 20%" to "to20%", so the character
 * immediately before "20%" is a letter, not a digit/hyphen; closing that gap
 * would need real tokenization, not a regex boundary, and is out of scope
 * for this fix.
 */
function exactClaimPattern(normalizedClaim: string): RegExp {
  return new RegExp(`(?<![\\d.,-])${escapeForRegex(normalizedClaim)}`);
}

export const NumbersSourcedInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  text: z.string().describe("The draft text to check for numeric claims (percentages, currency, multipliers, magnitude words)."),
  sources: z
    .array(z.string())
    .default([])
    .describe(
      "Real source content (research snippets, dossier excerpts, ...) the draft's numeric claims must actually appear in. A citation marker in `text` with no matching figure here is NOT sourced.",
    ),
});
export type NumbersSourcedInput = z.infer<typeof NumbersSourcedInputSchema>;

/**
 * Fails if the draft makes a numeric claim (percentage, currency, "10x",
 * "$1.2 million", ...) whose exact figure doesn't actually appear anywhere
 * in `sources`. Deliberately stricter than checking for a citation-shaped
 * substring (`[1]`, "according to") — legacy's own claim gate specifically
 * called out that "a source saying '15-20' does not support '20'": a citation
 * marker proves nothing about whether the number itself is real, so this
 * gate cross-checks the actual value against the actual source text instead.
 */
export const numbersSourced = defineTool<NumbersSourcedInput, GateVerdict>({
  name: "gate.numbersSourced",
  description:
    "Fails if the draft makes a numeric claim (percentage, currency, \"10x\", \"$1.2 million\", ...) whose exact figure doesn't actually appear anywhere in sources. Deliberately stricter than checking for a citation-shaped substring: a source saying '15-20' does not support '20'.",
  version: TOOL_VERSION,
  inputSchema: NumbersSourcedInputSchema,
  async execute({ text, sources }) {
    const claims = Array.from(text.matchAll(NUMERIC_CLAIM_PATTERN)).map((m) => m[0]);

    if (claims.length === 0) {
      return success<GateVerdict>({ verdict: "pass", evidence: ["no numeric claims found"], toolVersion: TOOL_VERSION });
    }

    const sourceBlob = normalizeClaim(sources.join(" "));
    const unverifiedClaims = claims.filter((claim) => !exactClaimPattern(normalizeClaim(claim)).test(sourceBlob));

    if (unverifiedClaims.length > 0) {
      return success<GateVerdict>({
        verdict: "content_fail",
        evidence: unverifiedClaims,
        reason: `text makes ${unverifiedClaims.length} numeric claim(s) whose figure does not appear in any attached source: ${unverifiedClaims.join(", ")}`,
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [`${claims.length} numeric claim(s), each verified against attached source content`],
      toolVersion: TOOL_VERSION,
    });
  },
});
