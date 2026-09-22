/**
 * HOW LONG A HUMAN GATE WAITS, AND WHAT HAPPENS WHEN NOBODY COMES.
 *
 * ## The three tiers, and the ruling behind them
 *
 * A gate that holds forever throws the work away; a gate that approves in an
 * hour regardless of what the run found is not a gate. The owner's ruling of
 * 2026-09-20 settled it for the Instagram agent — *"after a few hours there
 * should be automatic approval, even though you removed it, because it is
 * important that this does not go in the bin"* — and the shape that came out
 * of it is three tiers:
 *
 * | the run found | wait | then |
 * |---|---|---|
 * | nothing | 1h | ships |
 * | something worth a second look | 6h | ships anyway |
 * | a regulated-compliance finding | 24h | **holds** |
 *
 * The middle tier is the whole point: **a flag buys a reviewer TIME, not a
 * veto.** The top tier is the one exception, because a compliance finding is
 * the one thing where shipping unreviewed is worse than not shipping.
 *
 * ## Why this lives in `workflow` and not in one agent
 *
 * It was written for Instagram and stayed there, so ten other products kept a
 * flat `{ duration: "1h", onTimeout: "auto_approve" }` written out by hand at
 * the gate — x, linkedin, reddit, blog, newsletter, campaign, landing, intel,
 * seo-geo and reputation. A post those runs had already REPAIRED (an unsourced
 * figure redacted, a banned phrase redrafted, a thread part trimmed to fit) got
 * exactly the same hour as a clean one, and a compliance finding got no special
 * treatment at all. The tiers are a product decision about the whole platform,
 * so they are defined once, here, and the Instagram helper reads them from this
 * module rather than keeping a second copy that can drift.
 *
 * ## `reason` and `flags` are not decoration
 *
 * A gate that quietly waits six hours instead of one, with nothing saying why,
 * is the same class of defect as one that quietly approves. Both fields are
 * meant to go ON THE GATE PAYLOAD, read once and used both as the policy and as
 * the sentence the reviewer sees, so the clock and the explanation can never
 * disagree.
 */

/** What a clean deliverable gets: an hour, then it ships. */
export const CLEAN_GATE_TIMEOUT = "1h";
/** What a flagged deliverable gets: six hours for a person, then it ships anyway. */
export const FLAGGED_GATE_TIMEOUT = "6h";
/** What a regulated-compliance finding gets: a full day, and then it HOLDS. */
export const COMPLIANCE_GATE_TIMEOUT = "24h";

export interface GateTimeoutPolicy {
  duration: string;
  onTimeout: "hold" | "auto_approve" | "escalate";
  /** One sentence for the reviewer, naming what made this wait. */
  reason: string;
  /** The individual marks against the deliverable; empty when it is clean. */
  flags: string[];
}

/**
 * The facts a TEXT run already has by the time it registers its gate. Nothing
 * here is a new judgement, a new model call or a new threshold — every field is
 * something the workflow computed for its own reasons and already reports.
 */
export interface TextGateFacts {
  /**
   * Repairs applied to the round being reviewed. A repair means a deterministic
   * check refused the model's copy and the run rewrote or redacted it rather
   * than holding: the deliverable is honest, and it is also not what the writer
   * produced, which is exactly the case worth a longer look.
   */
  repairs?: readonly { check: string }[] | undefined;
  /**
   * Marks the agent computed itself and wants on the clock — "shipped on the
   * third dedupe attempt", "a required disclaimer was appended". Free text,
   * because each product's list is its own.
   */
  flags?: readonly string[] | undefined;
  /**
   * A regulated-compliance finding. The one tier that holds, so pass it only
   * for a real finding a reviewer can act on — not for a configuration fact
   * like a brand kit with no logo, which no decision about THIS deliverable
   * could ever clear.
   */
  regulatedComplianceFinding?: boolean | undefined;
}

/** Distinct check names, in first-seen order, so the reason reads as a list. */
function repairChecks(repairs: readonly { check: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of repairs) {
    if (!r.check || seen.has(r.check)) continue;
    seen.add(r.check);
    out.push(r.check);
  }
  return out;
}

/**
 * The gate policy for a text deliverable.
 *
 * Deliberately total: every input shape returns a policy, and the only way to
 * get `hold` is to ask for it with `regulatedComplianceFinding`. A caller that
 * passes nothing gets the hour every one of these gates had before, so wiring
 * this in is never a behaviour change on a clean run.
 */
export function textGateTimeout(facts: TextGateFacts = {}): GateTimeoutPolicy {
  if (facts.regulatedComplianceFinding) {
    return {
      duration: COMPLIANCE_GATE_TIMEOUT,
      onTimeout: "hold",
      reason:
        "a regulated-compliance finding is on this draft, so it waits a full day for a person and then HOLDS rather than publishing unreviewed",
      flags: ["regulated-compliance finding"],
    };
  }

  const flags: string[] = [];
  const checks = repairChecks(facts.repairs ?? []);
  if (checks.length > 0) {
    flags.push(
      `the draft was repaired before it got here (${checks.join(", ")}), so what ships is not what the writer wrote`,
    );
  }
  for (const f of facts.flags ?? []) {
    if (f) flags.push(f);
  }

  if (flags.length === 0) {
    return {
      duration: CLEAN_GATE_TIMEOUT,
      onTimeout: "auto_approve",
      reason: "nothing is flagged on this draft, so it ships after an hour if nobody objects",
      flags: [],
    };
  }

  return {
    duration: FLAGGED_GATE_TIMEOUT,
    onTimeout: "auto_approve",
    reason:
      `this draft waits for a person because ${flags.join("; ")}. ` +
      `After ${FLAGGED_GATE_TIMEOUT} with no decision it ships anyway: the flag buys a reviewer TIME, not a veto, ` +
      `because a draft nobody came back to is a draft thrown away`,
    flags,
  };
}
