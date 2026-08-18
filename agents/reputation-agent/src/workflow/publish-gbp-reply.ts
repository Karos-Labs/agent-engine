/**
 * `reputation.publish` (RFC-08 §9): "build it, but it must be permanently
 * gated closed at every autonomy level today... the tool exists, the door
 * stays locked." This is deliberately NOT registered in `karos-reputation`'s
 * tool registry (see that package's `src/index.ts` doc comment) and is
 * deliberately NOT wired into `createReputationPulseWorkflow` anywhere — the
 * workflow's own human gate (`reputation_approve_all`) is the final step for
 * every draft; nothing after it ever calls this function. It lives here,
 * inside the agent package, purely so the documented GBP reply-posting
 * contract exists in code (matching legacy `publish.py`'s shape) without
 * ever being reachable.
 *
 * The lock is enforced at the top of `publishGbpReply` itself, unconditionally,
 * regardless of what's passed in — not by the workflow simply choosing not to
 * call it. A future accidental call site (a copy-paste mistake wiring this
 * into some other agent's workflow, say) still cannot actually publish
 * anything: it always throws. See `__tests__/publish-lock.test.ts` for a test
 * that a maximally "valid-looking" call is refused exactly the same as an
 * invalid one.
 */

export interface PublishGbpReplyInput {
  account: string;
  location: string;
  reviewId: string;
  /** The reply body — `publish.py`'s `guard_text` rule (empty / unfilled `{{template}}` / over the character limit) is enforced below, but is moot: the lock throws before any of it is even inspected for a real publish attempt. */
  text: string;
}

export interface PublishGbpReplyResult {
  status: "published";
  account: string;
  location: string;
  reviewId: string;
}

/** GBP's own reply-body ceiling (Google Business Profile API, `reviews.reply`). */
const GBP_REPLY_MAX_LENGTH = 4096;

/**
 * `publish.py`'s `guard_text`, ported verbatim (also duplicated, deliberately,
 * inside `karos-reputation`'s `doctrine/mechanical-checks.ts` so the doctrine
 * gate catches the same problem before this rail ever would): refuse empty
 * text, refuse an unfilled `{{template}}` token, refuse over the character
 * limit. Exported separately so a test can exercise the guard's own logic in
 * isolation from the unconditional lock below.
 */
export function guardText(text: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "reply text is empty" };
  }
  if (text.includes("{{") || text.includes("}}")) {
    return { ok: false, reason: "reply text contains an unfilled {{template}} token" };
  }
  if (text.length > GBP_REPLY_MAX_LENGTH) {
    return { ok: false, reason: `reply text (${text.length} chars) exceeds the GBP reply limit of ${GBP_REPLY_MAX_LENGTH} characters` };
  }
  return { ok: true };
}

/**
 * The documented contract: `PUT accounts/{account}/locations/{location}/
 * reviews/{review}/reply`, body `{comment: text}`. Never actually reaches an
 * HTTP call in this build — the lock below throws unconditionally, first,
 * before `guardText` or any network client is ever touched. This is
 * intentional: even if a future change deleted the `guardText` call, or
 * injected a fake successful fetch, the lock at the very top still refuses.
 */
export async function publishGbpReply(_input: PublishGbpReplyInput): Promise<PublishGbpReplyResult> {
  // ── THE LOCK — do not remove, relax, or make conditional on any input or
  //    environment flag. See RFC-08 §9: "the tool exists, the door stays
  //    locked" — this is not a feature flag, and no autonomy level today
  //    legally permits an actual publish (RFC-08 §6: no reply-publish
  //    credential exists for any client yet). ──
  throw new Error(
    "reputation.publish is permanently locked — see RFC-08 §9 (\"the tool exists, the door stays locked\"). " +
      "No autonomy level today legally permits publishing a reply (RFC-08 §6); every approved draft stops at " +
      "the reputation_approve_all human gate instead. This function must never be called from the pulse workflow.",
  );
}
