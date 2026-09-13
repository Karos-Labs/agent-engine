/**
 * RFC-19 (Phase 6) — the degraded contract for a run whose QUALITY GATES refused.
 *
 * The owner's requirement, translated from Hebrew: *"I want to make sure there are no runs that will fail.
 * If the score is not good then it should repeat steps or do something else, but THE CLIENT CANNOT RECEIVE A
 * FAILED RUN unless it is a real fault."* This module is the "or do something else": a gate that refuses on
 * the FINAL drafting attempt records a typed finding here, the attempt walks forward, and the post ships
 * `completed` carrying the reason.
 *
 * ## Why this file exists at all, rather than four inline string builders
 *
 * The marker has FOUR destinations — the `09a` gate payload a reviewer reads, the persisted deliverable a
 * client retrieves, one ledger warn, and the workflow's own typed return — and they must carry the SAME
 * sentence. `interestDegradedReason` (`interest-floor.ts`) is the precedent this follows verbatim: one named
 * function, so the four routes cannot drift.
 *
 * ## The two rules that keep this honest
 *
 * 1. **`detail` is the gate's OWN sentence, verbatim.** Never re-worded here, never summarised. A reviewer
 *    reading "visual QA failed default:two-elements-per-slide on slide 4" is reading the judge's words; a
 *    paraphrase is a second opinion nobody asked for, and it makes a wording change in the gate invisible.
 * 2. **`score` is ABSENT, not zero, when a gate is not scored.** The rule `relevance` and `value.axes`
 *    already follow: a reviewer has to be able to tell *judged and found wanting* from *never judged*, and a
 *    fabricated 0 destroys that distinction permanently.
 *
 * And the asymmetry that matters most: the marker is **absent, never empty**, on a clean run. A marker
 * attached unconditionally is the "silently shipping a bad post" failure in reverse — shouting `degraded` at
 * every clean post until nobody reads it. `zero-held-quality.test.ts`'s assertion 8 pins that as a TEST, not
 * a convention.
 */

/**
 * Which gate refused. One value per gate that can refuse inside the drafting attempt loop (RFC-19 §4).
 *
 * **Every member here is PRODUCED by a `recordSelfCheckFinding` call site, and that is a rule.** `"subject"`
 * and `"research"` were declared here and never produced by anything — RFC-19 §4 items 16 and 17 happen
 * OUTSIDE this loop (`03` topic selection and `04b` research extraction both run long before
 * `selfCheckFindings` exists), so no site could have filled them. A declared-but-unproducible member is how a
 * dead branch gets written later against a case that cannot occur, so they are gone.
 *
 * The two events they were reserved for are still disclosed, just on their own surfaces rather than this one,
 * and a reader looking for them should look there:
 *
 * - **Item 16** (the brand-fit floor refused every scouted story, so the subject came from the catalog
 *   instead): `topicDecision.weighting.belowFloor` and `topicDecision.weighting.rule`, which carry the best
 *   fit measured and the floor it missed.
 * - **Item 17** (the extraction step did not complete, so the post rests on fetched headlines):
 *   `research.status === "headline-fallback"` and `research.reason`, which names the status verbatim.
 *   Note that `status` there reads `"headline-fallback"` and not `"degraded"`, unlike every sibling marker
 *   (`budget`, `visualInterest`, `language`, `selfCheck`, `contextGrounding`) — deliberate, because the
 *   value names WHICH fallback ran, but worth knowing before writing a consumer that greps for `"degraded"`.
 */
export type SelfCheckGate =
  | "draft"
  | "slides"
  | "craft"
  | "script"
  | "conventions"
  | "relevance"
  | "render-rules"
  | "palette"
  | "visual-qa";

/**
 * One check that did not pass on the attempt that SHIPPED.
 *
 * Every field except `gate`, `step`, `kind` and `detail` is optional and every optional one is absent rather
 * than defaulted — see the module comment's rule 2.
 */
export type SelfCheckFinding = {
  gate: SelfCheckGate;
  /** The checkpointed step id that produced the refusal, e.g. `07b-craft-hygiene-attempt-3`. What a reviewer reads the raw output of. */
  step: string;
  /** Machine-readable sub-reason, e.g. `source-ref`. Structural: a wording change in a gate must break a test, never silently reclassify a refusal. */
  kind: string;
  /** The gate's OWN sentence, verbatim. Never re-worded. */
  detail: string;
  slide?: number;
  /** Scored gates only. NEVER faked — absent means "this gate does not score", not "it scored zero". */
  score?: { value: number; floor: number };
  remedy?: "repaired" | "waived" | "discarded" | "none";
  /** Why a discarded repair was discarded. */
  remedyNote?: string;
  /** Regulated compliance only (RFC-19 §5.5). Routes `09a` to `{ duration: "24h", onTimeout: "hold" }` so nothing regulated auto-approves into publication unread. */
  severity?: "blocking";
};

/** The marker itself, as it lands on all four destinations. */
export type SelfCheckDegradeMarker = {
  status: "degraded";
  reason: string;
  /** Which attempt actually shipped — not always the last one, when Mechanism B salvaged an earlier draft. */
  attempt: number;
  attemptsSpent: number;
  checks: SelfCheckFinding[];
};

/** One phrase per finding: the gate's own words, then the score, the slide, the remedy and the step that produced it. */
function phraseFor(check: SelfCheckFinding): string {
  const score = check.score !== undefined ? ` — scored ${check.score.value} against a floor of ${check.score.floor}` : "";
  const slide = check.slide !== undefined ? ` (slide ${check.slide})` : "";
  const remedy = check.remedy === "repaired" || check.remedy === "waived" ? ` [${check.remedy}]` : "";
  const note = check.remedy === "discarded" && check.remedyNote !== undefined ? ` [repair discarded: ${check.remedyNote}]` : "";
  const blocking = check.severity === "blocking" ? "BLOCKING: " : "";
  return `${blocking}${check.detail}${score}${slide}${remedy}${note} (${check.step})`;
}

/**
 * Blocking findings first, everything else in the order the gates produced it.
 *
 * ONE definition, used by both the reason sentence and the `checks` array, because RFC-19 §5.5 item 2 says
 * the regulated finding rides the TOP of `selfCheck.checks` — and a reviewer who reads the sentence's first
 * clause and then the list's first row must be reading the same finding. Two sorts written separately is
 * exactly how those two would drift, and the drift would be invisible on any run with one finding.
 *
 * `Array.prototype.sort` is stable, so within each group the gates keep their execution order.
 */
function blockingFirst(checks: readonly SelfCheckFinding[]): SelfCheckFinding[] {
  return [...checks].sort((a, b) => (a.severity === "blocking" ? -1 : 0) - (b.severity === "blocking" ? -1 : 0));
}

/**
 * The one sentence every destination carries.
 *
 * Ends with the same "a person should look at this" clause Phase 4's language marker uses, because that is
 * the whole content of a degraded delivery: here is the post, and here is exactly what refused it.
 *
 * A BLOCKING finding (regulated compliance) is sorted to the front — a reviewer reading one sentence must
 * read that half of it first.
 */
export function selfCheckDegradedReason(
  checks: readonly SelfCheckFinding[],
  opts: { attempt: number; attemptsSpent: number; pastHardMax?: boolean },
): string {
  const ordered = blockingFirst(checks);
  const count = `${ordered.length} self-check${ordered.length === 1 ? "" : "s"} did not pass`;
  const which =
    opts.attempt === opts.attemptsSpent
      ? `on the final attempt (${opts.attempt} of ${opts.attemptsSpent})`
      : `on the attempt that shipped (${opts.attempt} of ${opts.attemptsSpent} spent)`;
  const budget =
    opts.pastHardMax === true ? " The run was past its hard max and finished on the cheapest complete path." : "";
  return `delivered degraded: ${count} ${which} — ${ordered.map(phraseFor).join("; ")}.${budget} A human should read this post before it publishes.`;
}

/**
 * The idempotent ledger event id, keyed on the revision so a RESUME writes exactly one row and a second
 * revision writes its own — `interest-floor`'s `__interest-floor-a${attempt}` key and the language marker's
 * `-r${revision}` key, combined.
 */
export function selfCheckDegradedEventId(runId: string, revision: number): string {
  return `${runId}__self-check-degraded-r${revision}`;
}

/**
 * RFC-19 §5.5 — does this delivery carry a regulated-compliance finding?
 *
 * The ONE thing that changes `09a`'s timeout. `{ duration: "1h", onTimeout: "auto_approve" }` for a regulated
 * client would make delivery indistinguishable from publication, which is the argument that decided §5.5;
 * `{ duration: "24h", onTimeout: "hold" }` gives a human a whole day AND a rendered post to look at. The bar
 * did not move and the gate still refuses — what changed is what happens after the refusal.
 */
export function hasBlockingFinding(checks: readonly SelfCheckFinding[]): boolean {
  return checks.some((c) => c.severity === "blocking");
}

/**
 * Builds the marker, or `undefined` when nothing refused.
 *
 * The `undefined` is the load-bearing half: see the module comment. Called ONCE per delivery and the result
 * handed to all four destinations.
 */
export function selfCheckDegradeMarker(
  checks: readonly SelfCheckFinding[],
  opts: { attempt: number; attemptsSpent: number; pastHardMax?: boolean },
): SelfCheckDegradeMarker | undefined {
  if (checks.length === 0) return undefined;
  return {
    status: "degraded",
    reason: selfCheckDegradedReason(checks, opts),
    attempt: opts.attempt,
    attemptsSpent: opts.attemptsSpent,
    // RFC-19 §5.5 item 2 — the blocking finding rides the TOP of this array, by the SAME sort the reason
    // sentence uses. Reading `checks[0]` and reading the sentence's first clause must never disagree.
    checks: blockingFirst(checks),
  };
}
