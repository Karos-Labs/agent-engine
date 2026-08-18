/**
 * Step 07: the client-lock gate (RFC-08 task spec) — "a deterministic
 * string/lock check (a client's never-say list / regulated-industry required
 * framing) that HARD STOPS a violating draft (not edit-and-continue — a lock
 * violation drops that one draft to FLAG, it does not loop back to step 06)."
 *
 * Deliberately mechanical (no model call, no judgment): a client's locks are
 * a closed, client-authored list, and a lock violation is exactly the kind
 * of bright-line check that should never depend on a model's mood that day.
 */
export interface ClientLocks {
  /** Case-insensitive substrings that must never appear in a published reply (e.g. a regulated client's banned admissions). */
  neverSay: string[];
  /** For a regulated client: at least one of these phrases must appear (e.g. "operates under license" for a fintech). Empty means no required framing is configured — most clients. */
  requiredFramingAnyOf: string[];
}

export type ClientLockVerdict = { ok: true } | { ok: false; reason: string };

export function checkClientLock(draftText: string, locks: ClientLocks): ClientLockVerdict {
  const lower = draftText.toLowerCase();

  for (const phrase of locks.neverSay) {
    if (phrase.length > 0 && lower.includes(phrase.toLowerCase())) {
      return { ok: false, reason: `draft contains a client never-say phrase: "${phrase}"` };
    }
  }

  if (locks.requiredFramingAnyOf.length > 0) {
    const hasRequiredFraming = locks.requiredFramingAnyOf.some((phrase) => lower.includes(phrase.toLowerCase()));
    if (!hasRequiredFraming) {
      return {
        ok: false,
        reason: `draft is missing this client's required regulated-industry framing (needed one of: ${locks.requiredFramingAnyOf.join(", ")})`,
      };
    }
  }

  return { ok: true };
}
