import { logWarning } from "@agent-engine/telemetry";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { CLIENT_CONSENT_SEGMENTS, type ClientConsentRecord } from "./visual-patterns.js";

/**
 * RFC-16 §5 — whether a client's generated imagery may carry a third-party
 * mark or a real public figure's likeness.
 *
 * ## Why this is a document and not a config key
 *
 * The three reasons `visual-patterns.ts:50-59` gives for the visual-pattern
 * consent record apply here with more force, not less: an absent file is an
 * unambiguous "no", which is the fail-closed default this capability needs; a
 * permission of this kind carries provenance (who granted it, when, over which
 * names) that has no business competing for space in a free-form runtime
 * config every other writer also edits; and revoking it must not mean editing
 * the document that also holds unrelated runtime settings.
 *
 * It lives in the SAME document — `clients/<slug>/client/consent.json`, i.e.
 * `CLIENT_CONSENT_SEGMENTS` — because that file's own doc comment says it is
 * "open-ended so other consented capabilities can add their own block later".
 * This is that block.
 *
 * ## Why an allowlist and not a flag
 *
 * "Apple, Samsung, Duolingo" is a decision an owner can make and a lawyer can
 * review. "Third-party marks: yes" is not a decision, it is an abdication —
 * and it is uncheckable, which means nothing downstream can enforce it. So a
 * `granted` status naming nothing grants nothing, exactly as
 * `readVisualPatternConsent` treats a grant that names no accounts
 * (`visual-patterns.ts:186-195`).
 *
 * ## What no agent may do
 *
 * Write this block. Ever. A permission an agent can grant itself is not a
 * permission. Nothing in this package writes to `CLIENT_CONSENT_SEGMENTS`, and
 * the only function here is a read.
 */

/**
 * The client's decision about third-party likeness in GENERATED imagery.
 *
 * `status` is an explicit word rather than a boolean for the same reason
 * `VisualPatternConsent.status` is (`visual-patterns.ts:86-104`): "never asked"
 * (no record at all), "asked and declined" (`denied`) and "granted then
 * withdrawn" (`revoked`) are three distinguishable states, not one falsy value.
 */
export interface GeneratedLikenessConsent {
  readonly status: "granted" | "denied" | "revoked";
  readonly grantedAt?: string;
  readonly grantedBy?: string;
  /**
   * What the grant covers. Absent — or present with every list empty and
   * `ownMarks` not true — grants NOTHING, because a permission that does not
   * say what it permits cannot be checked against what a model actually drew.
   */
  readonly allow?: {
    /** Named third-party marks. An allowlist, never a blanket yes. */
    readonly thirdPartyMarks?: readonly string[];
    /** Named public figures. A separate list because it is a separate body of law. */
    readonly publicFigures?: readonly string[];
    /** Whether the client's OWN marks may be drawn. False even here by default. */
    readonly ownMarks?: boolean;
  };
  /** What the owner wrote when granting. Surfaced verbatim in the gate payload. */
  readonly scopeNote?: string;
}

/**
 * `ClientConsentRecord` with this phase's block named.
 *
 * The base record already admits it — its index signature is
 * `readonly [key: string]: unknown`, which is precisely the open-endedness its
 * doc comment promises — so this interface adds a NAME and a type rather than a
 * capability. Declared here, next to the only reader of the block, so the
 * shape and the rules that fail it closed sit in one file.
 */
export interface LikenessConsentRecord extends ClientConsentRecord {
  readonly generatedLikeness?: GeneratedLikenessConsent;
}

/**
 * The gate's answer.
 *
 * `granted: false` means the run gets today's enforced behaviour — no
 * third-party marks, no public figures — which is what every client in the
 * fleet gets until an owner writes a record.
 */
export interface GeneratedLikenessDecision {
  readonly granted: boolean;
  /** Why, in the words the refusal will be reported in. Always populated, including on the granted path. */
  readonly reason: string;
  /** The marks the permit actually names. Empty whenever `granted` is false. */
  readonly thirdPartyMarks: readonly string[];
  /** The public figures the permit actually names. Empty whenever `granted` is false. */
  readonly publicFigures: readonly string[];
  /** Whether the client's own marks may be drawn. False whenever `granted` is false. */
  readonly ownMarks: boolean;
  readonly grantedAt?: string;
  readonly grantedBy?: string;
  readonly scopeNote?: string;
}

/** The reason text every fail-closed path shares, so a caller can match on one substring. */
export const LIKENESS_FAIL_CLOSED = "no third-party marks and no public figures";

/**
 * Trims, drops blanks, and de-duplicates case-insensitively while keeping the
 * owner's own casing — these names travel into a generation prompt, where
 * "apple" and "Apple" are not equally useful.
 */
function normaliseNames(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Every refusal returns the same empty permit, so no caller can read a partial one off a denial. */
function refuse(reason: string): GeneratedLikenessDecision {
  return { granted: false, reason, thirdPartyMarks: [], publicFigures: [], ownMarks: false };
}

/**
 * Reads the client's consent record and decides whether generated imagery for
 * this client may carry a third-party mark or a real public figure.
 *
 * Fails closed on every path that is not an explicit yes — including a store
 * read that throws. An unreadable consent record is not "unknown, proceed": a
 * capability that draws another company's mark on a paying client's feed
 * because of a storage hiccup is exactly the failure a consent gate exists to
 * prevent.
 *
 * Takes the STORE rather than an already-read record, deliberately and exactly
 * as `readVisualPatternConsent` does. A `(record, slug)` signature cannot fail
 * closed on an unreadable record at all, because by then the read has already
 * happened somewhere else, under someone else's error handling — which is the
 * one path most likely to be got wrong.
 *
 * Exported (rather than kept private to the tool) so the gate has one
 * definition and a second copy cannot drift into permissiveness.
 */
export async function readGeneratedLikenessConsent(
  store: WorkspaceStoreLike,
  clientSlug: string,
): Promise<GeneratedLikenessDecision> {
  let record: LikenessConsentRecord | undefined;
  try {
    record = await store.readJson<LikenessConsentRecord>(clientSlug, [...CLIENT_CONSENT_SEGMENTS]);
  } catch (error) {
    logWarning("likeness-consent: consent record could not be read; failing closed", {
      clientSlug,
      error: (error as Error).message,
    });
    return refuse(
      `consent record for "${clientSlug}" could not be read (${(error as Error).message}) — failing closed, ` +
        LIKENESS_FAIL_CLOSED,
    );
  }

  if (record === undefined) {
    return refuse(
      `no consent record exists at clients/${clientSlug}/client/consent.json — drawing another party's mark or a real ` +
        "person's likeness requires an explicit, recorded, named permission. Absent consent is not implied consent, so " +
        LIKENESS_FAIL_CLOSED,
    );
  }

  const consent = record.generatedLikeness;
  if (consent === undefined) {
    return refuse(
      `clients/${clientSlug}/client/consent.json carries no "generatedLikeness" block — this client has never been ` +
        `asked, so ${LIKENESS_FAIL_CLOSED}`,
    );
  }

  if (consent.status !== "granted") {
    return refuse(
      `generated-likeness consent for "${clientSlug}" is "${consent.status}", not "granted" — ${LIKENESS_FAIL_CLOSED}`,
    );
  }

  const thirdPartyMarks = normaliseNames(consent.allow?.thirdPartyMarks);
  const publicFigures = normaliseNames(consent.allow?.publicFigures);
  const ownMarks = consent.allow?.ownMarks === true;

  // The direct analogue of visual-patterns.ts:186-195. A grant that names
  // nothing is not a narrow grant, it is an uncheckable one: there is no list
  // for L9 to test `usesPermittedMarks` against and no list for the rendered
  // vision check to compare `subjects` with, so it authorises nothing at all.
  if (thirdPartyMarks.length === 0 && publicFigures.length === 0 && !ownMarks) {
    return refuse(
      `generated-likeness consent for "${clientSlug}" is "granted" but names nothing — a permission to draw "third-party ` +
        'marks" that does not say WHICH marks cannot be checked against what was actually drawn, so it grants nothing: ' +
        LIKENESS_FAIL_CLOSED,
    );
  }

  const covered = [
    thirdPartyMarks.length > 0 ? `${thirdPartyMarks.length} third-party mark(s): ${thirdPartyMarks.join(", ")}` : undefined,
    publicFigures.length > 0 ? `${publicFigures.length} public figure(s): ${publicFigures.join(", ")}` : undefined,
    ownMarks ? "the client's own marks" : undefined,
  ].filter((part): part is string => part !== undefined);

  return {
    granted: true,
    reason: `consent granted for ${covered.join("; ")}`,
    thirdPartyMarks,
    publicFigures,
    ownMarks,
    ...(consent.grantedAt !== undefined ? { grantedAt: consent.grantedAt } : {}),
    ...(consent.grantedBy !== undefined ? { grantedBy: consent.grantedBy } : {}),
    ...(consent.scopeNote !== undefined ? { scopeNote: consent.scopeNote } : {}),
  };
}
