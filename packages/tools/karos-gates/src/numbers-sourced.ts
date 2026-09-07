import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success } from "@agent-engine/tool-common";

// 1.1.0 — range-aware verification. A claim that is an endpoint of a range the
// draft QUOTES is now checked as that whole range, so a report reproducing a
// source's "$500-$2,000/month" verifies where it used to fail. Same verdicts on
// every other input, and a bare endpoint asserted on its own still fails. A
// minor bump rather than a patch because the verdict for a real class of drafts
// genuinely changes, and telemetry has to be able to tell the two eras apart.
//
// 1.2.0 — a currency amount carries its magnitude word. "$1 billion" used to
// be extracted as the claim "$1": the currency alternative stopped at the
// space, and the magnitude alternative never got a turn because the match had
// already consumed the digit. The verdict then named a figure ("$1") that
// appeared nowhere in the draft, and a fully-sourced Karos Labs newsletter was
// held on it (prep job sp8ICAFLjKkYWb2DAh8R, 2026-09-05). Magnitudes are also
// folded to one spelling on both sides ("$1 billion" / "$1B" / "$1bn" all
// compare as "$1b"), so a draft quoting a source's figure in words is not
// failed because the source abbreviated it. Minor bump, same reasoning as 1.1.0.
//
// 1.3.0 — two more ways a faithful draft was failed. A multiplier written with
// the multiplication sign ("3.2×", how aidiscovery.club and many trade sources
// print it) was neither extracted as a claim nor matched against a draft's
// "3.2x": the sign is folded to "x" on both sides now. And a draft that states
// a source range's endpoint AS A BOUND ("up to 3.4x", "as much as 34%", "at
// least $500") is quoting the range honestly, not cherry-picking it, and now
// verifies when the source carries the range with that endpoint; a bare
// endpoint asserted as the value ("CPA rose 34%") still fails as before. Prep
// run pubsub-21753432816018912 spent two editorial rounds ($3.50) on exactly
// these two shapes.
const TOOL_VERSION = "1.3.0";

/** A magnitude suffix that belongs to the figure in front of it: written out, or the common abbreviations. */
const MAGNITUDE_SUFFIX = "(?:trillion|billion|million|thousand|tn|bn|mn|[kmbt])";

/**
 * Numeric-claim shapes that read as a factual assertion needing a source:
 * percentages, currency (with any magnitude word attached, so "$1 billion" is
 * one claim, not "$1"), multipliers, magnitude words.
 */
const NUMERIC_CLAIM_PATTERN = new RegExp(
  [
    String.raw`(\d[\d,]*(?:\.\d+)?\s?%)`,
    String.raw`([$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?${MAGNITUDE_SUFFIX}\b)?)`,
    String.raw`(\b\d+(?:\.\d+)?\s?(?:x\b|×))`,
    String.raw`(\b\d+(?:\.\d+)?\s?(?:trillion|billion|million|thousand)\b)`,
  ].join("|"),
  "gi",
);

/**
 * Collapses whitespace and case so "47 %" / "47%" / "47  %" all compare equal
 * against source content. Dash variants are folded to "-" so a draft quoting
 * "$500–$2,000" matches a source writing "$500-$2,000". Magnitude words are
 * folded to their one-letter abbreviation BEFORE whitespace is removed (the
 * `\b` after the word still means something at that point), so "$1 billion",
 * "$1 bn" and "$1B" all normalize to "$1b".
 */
function normalizeClaim(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/(\d)\s?(?:trillion|tn)\b/g, "$1t")
    .replace(/(\d)\s?(?:billion|bn)\b/g, "$1b")
    .replace(/(\d)\s?(?:million|mn)\b/g, "$1m")
    .replace(/(\d)\s?thousand\b/g, "$1k")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, "");
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
 * match immediately preceded by a digit, comma, period, or hyphen.
 *
 * A draft that QUOTES a range is handled before this is reached — see
 * `rangeAroundClaim` — so the lookbehind's rejection of a leading hyphen now
 * only bites the claim it was written for: an endpoint asserted on its own.
 */
function exactClaimPattern(normalizedClaim: string): RegExp {
  return new RegExp(`(?<![\\d.,-])${escapeForRegex(normalizedClaim)}`);
}

/**
 * The same containment check for a whole RANGE token, with a narrower guard.
 *
 * `exactClaimPattern` rejects a match preceded by a digit, comma, period or
 * hyphen. Comma and hyphen are there to stop a bare endpoint being verified by
 * a range ("15-20%" must not support "20%"), but they misfire on a range token
 * because `normalizeClaim` strips whitespace and pulls ORDINARY PROSE
 * PUNCTUATION flush against it: a source reading "smaller deployments,
 * $100-$500/month" normalizes to "...deployments,$100-$500..." and the comma
 * alone was enough to reject a range the source states verbatim.
 *
 * A range carries its own internal dash and both of its endpoints, so it
 * cannot be the fragment of a larger number that guard exists to catch. Only a
 * directly preceding digit could make it one, and that is what remains.
 */
function exactRangePattern(normalizedRange: string): RegExp {
  return new RegExp(`(?<!\\d)${escapeForRegex(normalizedRange)}`);
}

/**
 * A numeric range as it is written: two figures joined by a dash, either side
 * optionally carrying a currency symbol or a percent sign. Bounded on purpose
 * — an unbounded walk outward from the claim swallows neighbouring numbers
 * ("in 2024, $100-$500" would widen to "2024,$100-$500", which appears in no
 * source and would silently un-verify a claim that is in fact quoted exactly).
 */
const NUMERIC_RANGE_PATTERN = /[$€£]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×)?\s*[-‐-―]\s*[$€£]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×)?/g;

/**
 * The words that make a figure a BOUND rather than a value: "up to 34%",
 * "as much as 3.4x", "at least $500", "as low as 12%". A draft writing one of
 * these against a source range ("2.6-3.4x", "$500-$2,000") is reporting the
 * range's edge as an edge, which is exactly what the range says; it is the
 * bare "CPA rose 34%" against "up to 34%" that misstates a ceiling as a
 * result. Checked on the text immediately before the claim.
 */
const BOUND_PHRASE_BEFORE_CLAIM = /(?:up\s+to|as\s+(?:much|many|high|low|little)\s+as|at\s+(?:least|most)|no\s+(?:more|less)\s+than|a\s+maximum\s+of|a\s+minimum\s+of|from|to|between|and|or)\s*$/i;

/**
 * Whether `sourceBlob` carries a range whose upper or lower endpoint is the
 * normalized claim: the claim, preceded or followed by a dash and another
 * figure, with no digit running into it on the far side.
 */
function sourceHasRangeEndpoint(normalizedClaim: string, sourceBlob: string): boolean {
  // A range states its unit once, on the far end: "2.6-3.4x" means 2.6x to
  // 3.4x, "$500-$2,000" repeats the currency, "12-34%" does not repeat the
  // percent. So the claim's unit may be absent from the endpoint it matches
  // when the other endpoint carries it.
  const parts = /^([$€£]?)(\d[\d,]*(?:\.\d+)?)(%|x|[kmbt])?$/.exec(normalizedClaim);
  if (!parts) return false;
  const [, currency, number, unit] = parts;
  const cur = escapeForRegex(currency ?? "");
  const num = escapeForRegex(number!);
  const unitPattern = unit ? escapeForRegex(unit) : "";
  const anyFigure = String.raw`[$€£]?\d[\d,]*(?:\.\d+)?(?:%|x|[kmbt])?`;
  const upper = new RegExp(`(?<![\\d.,])${anyFigure}-${cur}${num}${unitPattern}(?![\\d.,])`);
  const lower = new RegExp(`(?<![\\d.,-])${cur}${num}(?:${unitPattern})?-[$€£]?\\d[\\d,]*(?:\\.\\d+)?${unitPattern || "(?:%|x|[kmbt])?"}`);
  return upper.test(sourceBlob) || lower.test(sourceBlob);
}

/**
 * The claim as the DRAFT presents it: a bare figure, or the whole range it is
 * an endpoint of — either end.
 *
 * This is the difference between quoting a source and cherry-picking one, and
 * only the draft can tell them apart. A draft writing "pricing runs
 * $500-$2,000/month" against a source saying "average revenue per customer:
 * $500-$2,000/month" is quoting it exactly; a draft writing "engagements at
 * $2,000+/month" against that same source has taken the top of a range and
 * asserted it as a threshold. Checking `$2,000` alone cannot tell those apart,
 * and used to reject both — which held a fully-sourced Karos Labs report on
 * 2026-09-04 over five figures that were every one of them present in its
 * sources as range endpoints.
 *
 * BOTH ENDS MATTER. Widening only leftward still fails a draft quoting
 * "$100-$500" when `$100` is the extracted claim, because the range runs to
 * its right — which is exactly what the first version of this fix did.
 *
 * The isolated case is untouched: "revenue grew 20%" sits inside no range, so
 * it is still checked as the bare "20%" that a source saying "15-20%" does not
 * support.
 */
function rangeAroundClaim(text: string, claimStart: number, claimLength: number): string | undefined {
  const claimEnd = claimStart + claimLength;
  // A window wide enough for the longest realistic range, and no wider.
  const windowStart = Math.max(0, claimStart - 40);
  const window = text.slice(windowStart, claimEnd + 40);
  for (const match of window.matchAll(NUMERIC_RANGE_PATTERN)) {
    const absoluteStart = windowStart + match.index;
    const absoluteEnd = absoluteStart + match[0].length;
    if (absoluteStart <= claimStart && absoluteEnd >= claimEnd) return match[0];
  }
  return undefined;
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
    const matches = Array.from(text.matchAll(NUMERIC_CLAIM_PATTERN));
    const claims = matches.map((m) => m[0]);

    if (claims.length === 0) {
      return success<GateVerdict>({ verdict: "pass", evidence: ["no numeric claims found"], toolVersion: TOOL_VERSION });
    }

    const sourceBlob = normalizeClaim(sources.join(" "));
    const unverifiedClaims = matches
      .filter((match) => {
        const claim = normalizeClaim(match[0]);
        if (exactClaimPattern(claim).test(sourceBlob)) return false;
        // Not present as a standalone figure — but the draft may be quoting a
        // range, in which case the range is the claim. See `rangeAroundClaim`.
        const range = rangeAroundClaim(text, match.index, match[0].length);
        if (range !== undefined) return !exactRangePattern(normalizeClaim(range)).test(sourceBlob);
        // Not a range in the draft either. One more honest shape: the draft
        // states the figure as a bound ("up to 3.4x") and the source has it as
        // an endpoint of a range ("2.6-3.4x").
        const before = text.slice(Math.max(0, match.index - 24), match.index);
        if (BOUND_PHRASE_BEFORE_CLAIM.test(before)) return !sourceHasRangeEndpoint(claim, sourceBlob);
        return true;
      })
      .map((match) => match[0]);

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
