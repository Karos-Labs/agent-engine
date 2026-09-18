import type { GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "./signals.js";

/**
 * "An agent must always produce a deliverable."
 *
 * The owner's rule, 2026-09-17, and the reason this file exists. The end user
 * must never meet an empty failure or a stuck workflow: a failing internal
 * check is a reason to repair that one thing, never a reason to withhold work
 * that has already been drafted and paid for.
 *
 * The case that settled it: prep run `pubsub-21854296073980161` ended at
 * `held` with "numbers not sourced: … $30M" while its own research pull
 * carried "($5M-$30M ARR)" verbatim — a gate misreading, billed to the client
 * as a failed deliverable, discarding $0.46 of research over one figure in one
 * sentence of a seven-section report.
 *
 * Two things this rule does NOT license, and which nothing here will do:
 * fabricating data, and publishing something a client explicitly forbade.
 * Those are `deliver-with-annotation` — the content comes out carrying the
 * refusal in `ContentRepair`, never a pretence that it worked.
 */

/** What a repair did to the content — the verb a reviewer reads in the ledger. */
export type ContentRepairAction =
  /** A model rewrote the offending part. The best outcome: prose stays prose. */
  | "rewritten"
  /** The offending span (and the sentence carrying it) was deleted. */
  | "redacted"
  /** Content was cut to fit a hard limit. */
  | "trimmed"
  /** Something legal-but-misplaced was moved where it belongs (a link, a thread part). */
  | "moved"
  /** A blocked input was replaced with an allowed one (a never-topic, an unavailable thread). */
  | "substituted"
  /**
   * Nothing could fix it and the run delivered anyway, carrying this note.
   * The honest end of the ladder — never silent, and never a reason to hold.
   */
  | "unresolved";

/** One thing a workflow had to repair, or could not, on its way to delivering. */
export interface ContentRepair {
  /** The gate or rule that objected — "gate.numbersSourced", "character-limit", "never-topic". */
  check: string;
  action: ContentRepairAction;
  /** One line a human can read: what changed and why. */
  detail: string;
}

/**
 * Every repair a run made, in the order it made them — attached to the
 * deliverable so the repairs are visible rather than silent, the way
 * `DegradedContextGroundingMarker` already is.
 *
 * An empty ledger is the normal path and should be omitted from a deliverable
 * entirely rather than attached as `{ repairs: [] }`: a clean run must produce
 * the same bytes it always did.
 */
export interface ContentRepairLedger {
  repairs: ContentRepair[];
}

/** True when this run delivered something a human should look at twice. */
export function hasUnresolvedRepair(ledger: ContentRepairLedger | null | undefined): boolean {
  return (ledger?.repairs ?? []).some((repair) => repair.action === "unresolved");
}

/**
 * Sentence boundaries, crudely: a terminator followed by whitespace.
 *
 * Deliberately crude, because the only thing that depends on the split is
 * which span of prose gets dropped, and dropping one clause too many is
 * strictly better than the alternative — surgically excising "$30M" from
 * "$5M–$30M ARR" and shipping "$5M– ARR" to a client.
 */
function splitSentences(prose: string): string[] {
  return prose.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
}

/**
 * The deterministic floor under every span-flagging gate: drop each SENTENCE
 * that carries one of `spans`.
 *
 * One function rather than four because `gate.numbersSourced`,
 * `gate.noPlaceholder`, `gate.leakCheck` and `gate.brandCompliance` all report
 * the same shape of evidence — the offending literal, as it appears in the
 * draft — and the same repair is right for all four. A leaked credential, an
 * unresolved `[TODO]`, a forbidden superlative and an unsourced figure are all
 * things whose sentence is better gone than shipped.
 *
 * Pure, and monotone: each call removes at least one sentence or reports that
 * it located none, which is what lets a caller loop over it without spinning.
 *
 * Over-removal is the deliberate bias. A span like "$30M" also matches inside
 * "$130M", so a sentence may be dropped that did not strictly have to be; that
 * costs a sentence, while under-removal costs the client something the
 * deliverable cannot stand behind.
 *
 * `whenEmptied` is what the field says if every one of its sentences carried a
 * flagged span — honest about the gap rather than silently blank. A caller
 * that would rather have an empty string passes `""`.
 */
export function redactSentencesCarrying(
  text: string,
  spans: readonly string[],
  whenEmptied = "",
): { text: string; droppedSentences: number; redactedSpans: string[] } {
  const wanted = [...new Set(spans.map((span) => span.trim()).filter((span) => span.length > 0))];
  if (wanted.length === 0 || text.length === 0) return { text, droppedSentences: 0, redactedSpans: [] };

  const hit = new Set<string>();
  let droppedSentences = 0;
  const kept = splitSentences(text).filter((sentence) => {
    const carries = wanted.filter((span) => sentence.includes(span));
    if (carries.length === 0) return true;
    for (const span of carries) hit.add(span);
    droppedSentences += 1;
    return false;
  });

  // Nothing matched: hand back the ORIGINAL string, not a re-joined copy.
  // Re-joining would flatten paragraph breaks into single spaces and silently
  // rewrite prose this call was not asked to touch.
  if (droppedSentences === 0) return { text, droppedSentences: 0, redactedSpans: [] };

  const rebuilt = kept.join(" ").trim();
  return {
    text: rebuilt.length > 0 ? rebuilt : whenEmptied,
    droppedSentences,
    redactedSpans: [...hit],
  };
}

/**
 * The offending literals inside a gate's `evidence`, whatever shape that gate
 * reports them in.
 *
 * The gates do NOT agree on this, and assuming they did is how a repair
 * silently does nothing:
 *
 * - `gate.numbersSourced`, `gate.noPlaceholder` and `gate.brandCompliance`
 *   report the bare literal as it appears in the draft — `43%`, `[TODO]`,
 *   `guaranteed`.
 * - `gate.leakCheck` reports a LABELLED, QUOTED form —
 *   `local file path: "/Users/jane/notes.md"`, `internal term: "staging-only"`.
 *
 * Handing the second shape straight to {@link redactSentencesCarrying} finds
 * nothing, drops nothing, and reports every span unresolved — a floor that
 * looks like it ran and did not. This unwraps the quoted payload when the
 * label form is present and passes anything else through untouched.
 */
export function spansFromEvidence(evidence: readonly string[]): string[] {
  const spans = evidence.map((item) => {
    const labelled = /^[^:"]+:\s*"([\s\S]+)"$/.exec(item.trim());
    return (labelled?.[1] ?? item).trim();
  });
  return [...new Set(spans.filter((span) => span.length > 0))];
}

/**
 * Excises each span from a SHORT single-line field — a title, a meta
 * description, a subject line — and tidies the seam it leaves.
 *
 * The companion to {@link redactSentencesCarrying}, for fields where dropping
 * "the sentence" means dropping the whole field. A title is one sentence: a
 * forbidden term in it is a reason to remove the term, not to ship an article
 * with no title (and `min(1)` schemas would reject that anyway).
 *
 * Whitespace either side of the removed span is collapsed and stray leading
 * punctuation is cleaned up, so "The best CRM for teams" minus "The best"
 * reads "CRM for teams" rather than " CRM for teams".
 *
 * A field that would be emptied entirely is left UNCHANGED and reported via
 * `emptied`, because a caller's schema almost always forbids "" — the caller
 * decides whether to substitute or to record it unresolved.
 */
export function stripSpansFrom(
  text: string,
  spans: readonly string[],
): { text: string; strippedSpans: string[]; emptied: boolean } {
  const wanted = [...new Set(spans.map((span) => span.trim()).filter((span) => span.length > 0))];
  if (wanted.length === 0 || text.length === 0) return { text, strippedSpans: [], emptied: false };

  const hit: string[] = [];
  let out = text;
  for (const span of wanted) {
    if (!out.includes(span)) continue;
    hit.push(span);
    out = out.split(span).join(" ");
  }
  if (hit.length === 0) return { text, strippedSpans: [], emptied: false };

  const tidied = out
    .replace(/\s+/g, " ")
    // Removing a span from between two clauses leaves its punctuation on both
    // sides ("Fast, guaranteed, and cheap" -> "Fast, , and cheap"). Drop the
    // orphaned mark rather than shipping a doubled one.
    .replace(/([,;:])\s*(?=[,.;:!?])/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,.;:—–-]+/, "")
    .trim();

  if (tidied.length === 0) return { text, strippedSpans: hit, emptied: true };
  return { text: tidied, strippedSpans: hit, emptied: false };
}

/**
 * One way of trying to fix content a check rejected, tried in order by
 * {@link runCheckWithRepair}.
 *
 * `run` returns a candidate, or `undefined` when this attempt cannot apply to
 * the value it was handed (a model call that errored, a trim with nothing to
 * trim). Returning `undefined` is not a failure — it moves to the next attempt.
 */
export interface RepairAttempt<T> {
  /** The verb for the ledger when this attempt is the one that worked. */
  action: ContentRepairAction;
  /** Produce a repaired candidate from the current value and the verdict against it. */
  run: (value: T, verdict: GateVerdict & { verdict: "content_fail" }) => Promise<T | undefined> | T | undefined;
  /**
   * How many times this attempt may run in a row while it keeps making
   * progress. 1 for a model rewrite (a second identical ask rarely differs);
   * more for a mechanical pass that removes one problem at a time. Default 1.
   */
  maxPasses?: number;
}

export interface CheckWithRepairResult<T> {
  /** The best value reached — delivered whether or not every problem was fixed. */
  value: T;
  /** The verdict against `value`. `content_fail` here means repairs ran out, NOT that the run should stop. */
  verdict: GateVerdict;
  /** What was done, in order. Empty on the normal path. */
  repairs: ContentRepair[];
}

/**
 * Run a content check and, if it objects, repair rather than hold.
 *
 * The contract, which is the whole point:
 *
 * - **It never throws on `content_fail`.** Callers get a value back every
 *   time, and decide what to annotate. Holding is not one of the outcomes.
 * - **It still throws on `tooling_error`.** A check that could not RUN has
 *   made no judgment, and treating that as a pass would ship exactly what the
 *   check exists to catch. That is a broken tool, not bad content.
 * - **A repair is kept only if it is strictly better** — fewer pieces of
 *   evidence against it than the value it replaces. A rewrite that makes
 *   things worse is discarded, so attempting a repair can never cost quality.
 * - **Attempts run in the order given**, cheapest-to-quality-first: a model
 *   rewrite before a mechanical deletion, because prose a model fixed reads
 *   better than prose with a hole in it.
 *
 * `verify` is re-run against every candidate, so an attempt that introduces a
 * NEW violation is caught by the same check that caught the original — a
 * repair can improve the content's chances and can never wave it through.
 */
export async function runCheckWithRepair<T>(params: {
  /** Gate or rule name, for the ledger. */
  check: string;
  value: T;
  /** Judges a value. Must throw `WorkflowToolingFailure` itself, or return `tooling_error` for this to throw. */
  verify: (value: T) => Promise<GateVerdict>;
  attempts: readonly RepairAttempt<T>[];
  /** Ledger line when every attempt is exhausted. Receives the surviving verdict. */
  describeUnresolved?: (verdict: GateVerdict & { verdict: "content_fail" }) => string;
}): Promise<CheckWithRepairResult<T>> {
  const { check, verify, attempts } = params;

  const judge = async (candidate: T): Promise<GateVerdict> => {
    const verdict = await verify(candidate);
    if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${check}: ${verdict.reason}`);
    return verdict;
  };

  let value = params.value;
  let verdict = await judge(value);
  if (verdict.verdict !== "content_fail") return { value, verdict, repairs: [] };

  const repairs: ContentRepair[] = [];

  for (const attempt of attempts) {
    const maxPasses = attempt.maxPasses ?? 1;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (verdict.verdict !== "content_fail") break;
      const failing = verdict;

      const candidate = await attempt.run(value, failing);
      if (candidate === undefined) break;

      const candidateVerdict = await judge(candidate);
      const before = failing.evidence.length;
      const after = candidateVerdict.verdict === "content_fail" ? candidateVerdict.evidence.length : 0;

      // Strictly better, or not kept at all. A repair that trades one
      // violation for another leaves the content exactly where it was.
      if (candidateVerdict.verdict !== "content_fail" || after < before) {
        const fixed = failing.evidence.filter(
          (item) => candidateVerdict.verdict !== "content_fail" || !candidateVerdict.evidence.includes(item),
        );
        repairs.push({
          check,
          action: attempt.action,
          detail:
            fixed.length > 0
              ? `${fixed.join(", ")} — ${attempt.action} to satisfy ${check}`
              : `content ${attempt.action} to satisfy ${check}`,
        });
        value = candidate;
        verdict = candidateVerdict;
      } else {
        break;
      }
    }
    if (verdict.verdict !== "content_fail") break;
  }

  if (verdict.verdict === "content_fail") {
    // Delivered anyway, and said so. This is the branch that used to be
    // `throw new WorkflowHeld(...)`.
    repairs.push({
      check,
      action: "unresolved",
      detail: params.describeUnresolved?.(verdict) ?? `could not be resolved: ${verdict.reason}`,
    });
  }

  return { value, verdict, repairs };
}

/**
 * A `content_fail` verdict built by the workflow itself, for the rules that
 * are not gate tools — a character limit, a link in the wrong place, a thread
 * longer than the account allows.
 *
 * Exists so those rules can go through {@link runCheckWithRepair} on exactly
 * the same path as a real gate, instead of each growing its own bespoke
 * repair-or-hold branch. `toolVersion` names the rule rather than a tool
 * because there is no tool: it is what telemetry will show as the source of
 * the verdict, and "the workflow decided this" is the honest answer.
 */
export function localContentFail(rule: string, reason: string, evidence: readonly string[] = []): GateVerdict {
  return { verdict: "content_fail", evidence: [...evidence], reason, toolVersion: `workflow-rule/${rule}` };
}

/** The matching pass, for a local rule that is satisfied. */
export function localPass(rule: string, evidence: readonly string[] = []): GateVerdict {
  return { verdict: "pass", evidence: [...evidence], toolVersion: `workflow-rule/${rule}` };
}
