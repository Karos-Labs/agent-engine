/**
 * THE POST BEING REPLIED TO, AND WHY NOBODY HAS SEEN IT.
 *
 * The `engagement` lane writes a reply or a quote aimed at a specific post.
 * `targetPostHandle` and `targetPostUrl` carry which one — and until now the
 * workflow never read either field. They came out of the drafting model,
 * passed a `z.string().url()` that accepts `https://example.com`, and went
 * straight onto the deliverable, where `render-drafts-markdown.ts` printed:
 *
 *     **In reply to:** <that URL>
 *
 * No tool in this agent fetches a post. Nothing had looked at that URL. A
 * reviewer read a sentence stating, as fact, which post the client was about
 * to reply to — invented by a model, formatted like a citation.
 *
 * That is the same defect class `gate.numbersSourced` exists for, one field
 * over: a claim the run cannot stand behind, presented as one it can.
 *
 * ## What this can and cannot establish
 *
 * It CANNOT establish that the post exists, that it says what the draft
 * assumes, or that the account posted it. Fetching X costs an API tier this
 * agent does not have, and pretending otherwise would be the same mistake in
 * a longer form.
 *
 * It CAN establish that the URL is shaped like a real X post rather than
 * anything at all, that the handle in it agrees with the handle the draft
 * named, and — the part that matters most — that a reviewer is told the
 * target is a PROPOSAL they have to open, never a fact the run checked.
 *
 * An unusable target is dropped rather than shown. A missing line is a gap a
 * reviewer notices; a fabricated one is a gap they cannot.
 */

/** `x.com/<handle>/status/<id>` and the `twitter.com` and `mobile.` spellings of it. `/i/web/status/<id>` is X's own id-only form and carries no handle. */
const STATUS_URL = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/i;
const ID_ONLY_URL = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/i\/web\/status\/(\d{5,25})(?:[/?#].*)?$/i;

export interface EngagementTarget {
  /** The handle the URL itself names, without `@`. Absent for X's id-only `/i/web/status/` form. */
  handle?: string;
  url: string;
}

export type EngagementTargetVerdict =
  | { kind: "usable"; target: EngagementTarget }
  /** The draft named no target at all. Normal on every lane but `engagement`. */
  | { kind: "absent" }
  /** Something was named and cannot be shown to anybody. `reason` is written for the repair ledger. */
  | { kind: "unusable"; reason: string };

function normalizeHandle(raw: string | undefined): string | undefined {
  const handle = raw?.trim().replace(/^@/, "");
  return handle !== undefined && handle.length > 0 ? handle : undefined;
}

/**
 * Whether the target a draft named can be put in front of a person.
 *
 * `lane` is taken rather than inferred: a `targetPostUrl` on a knowledge post
 * is a field the model filled in for a lane where it means nothing (the
 * schema's own comment records sonnet doing exactly that), and dropping it
 * there is housekeeping, not a repair worth a ledger row.
 */
export function readEngagementTarget(draft: { lane: string; targetPostHandle?: string | undefined; targetPostUrl?: string | undefined }): EngagementTargetVerdict {
  const url = draft.targetPostUrl?.trim();
  const named = normalizeHandle(draft.targetPostHandle);

  if (draft.lane !== "engagement") return { kind: "absent" };
  if ((url === undefined || url.length === 0) && named === undefined) return { kind: "absent" };
  if (url === undefined || url.length === 0) {
    return { kind: "unusable", reason: `the draft named @${named} as the account to reply to but gave no post to reply to` };
  }

  const idOnly = ID_ONLY_URL.exec(url);
  if (idOnly) {
    // X's own canonical id-only permalink. It names no handle, so there is
    // nothing to disagree with — and a handle the draft supplied alongside it
    // is kept as the draft's own claim about whose post it is.
    return { kind: "usable", target: { url, ...(named !== undefined ? { handle: named } : {}) } };
  }

  const match = STATUS_URL.exec(url);
  if (!match) {
    return { kind: "unusable", reason: `"${url}" is not an X post URL, so there is no post to reply to` };
  }
  const inUrl = match[1]!;
  if (named !== undefined && named.toLowerCase() !== inUrl.toLowerCase()) {
    // The draft contradicted itself. Neither half is checkable, so neither is
    // shown: picking one would be choosing which invention to believe.
    return { kind: "unusable", reason: `the draft named @${named} but its post URL belongs to @${inUrl}` };
  }
  return { kind: "usable", target: { handle: inUrl, url } };
}

/**
 * The line a reviewer reads above the target.
 *
 * Load-bearing, and the whole reason this module is not just a regex: the
 * previous wording — `**In reply to:** <url>` — is how a citation is written,
 * and a citation asserts that somebody checked. Nobody did.
 */
export const UNVERIFIED_TARGET_NOTE = "nobody fetched this post — open it before approving";
