import {
  archetypeTextSlots,
  checkExpectedScript,
  deviceTextSlots,
  languageGateText,
  withArchetypeText,
  withDeviceText,
  type NativeCorrection,
} from "./language-gate.js";
import { ALT_TEXT_MAX_CHARS, FIRST_COMMENT_MAX_CHARS, packageLanguageGateText, type PostPackage } from "./post-package.js";
import type { InstagramCopyOutput, InstagramSlideCopy, SlidesDataSelfCheck } from "./types.js";
import { LAYOUT_FIELD_KEYS } from "./visual-qa-pre-checks.js";

/**
 * Instagram Phase 4 (RFC-15 §6.5): the in-place correction patch.
 *
 * ## Why a patch at all
 *
 * A translationese finding costs **$0.014 to fix in place and $0.240 to
 * redraft**, and the native editor has already written the better sentence. So
 * the first thing the loop does with a `not_native` verdict is not to redraft:
 * it is to apply the judge's own replacements, verbatim, at the exact spans it
 * anchored them to, and ask it again. The redraft is what happens when that
 * fails, not what happens first.
 *
 * ## Why this is a pure function with no step id
 *
 * It is a pure function of two values that are ALREADY checkpointed — the `05`
 * copy output and the round-1 verdict — so it resumes deterministically
 * without one, and the corrected copy is itself checkpointed one step later at
 * `07c-emit-slides-data-attempt-N`. A step id here would buy a trace row and
 * cost a checkpoint round-trip on every attempt of every non-English run.
 *
 * ## The four rules, and why each one is a refusal rather than a best effort
 *
 * 1. **The target must resolve.** `slide:9` on an eight-slide carousel, a
 *    `kicker` correction on a slide that has no kicker, a `custom` correction
 *    naming a key the archetype does not declare: dropped, counted, reported.
 *    A patcher that "does its best" with an unresolvable anchor is a patcher
 *    that edits the wrong sentence.
 * 2. **The span must occur EXACTLY ONCE in that field.** Zero occurrences
 *    means the judge quoted a paraphrase instead of the text; two means there
 *    is no way to know which one it meant. Both are dropped, because an
 *    ambiguous patch is worse than none — it ships a sentence nobody wrote and
 *    nobody reviewed.
 * 3. **The replacement must not push the field past its own schema cap.** A
 *    49-character kicker does not fail here; it fails at the next
 *    `InstagramSlideCopySchema` parse, several steps later, as a whole-output
 *    rejection that costs the attempt. Phase 5 adds two more caps this rule
 *    now guards: alt text's 125 characters and the first comment's 600.
 * 4. **`sourceRef`, `visualNeed`, `stat.figure`, every `source`, every
 *    `LAYOUT_FIELD_KEY` and — Phase 5 — every `firstComment.sources[].url`
 *    are untouchable.** `sourceRef`/`visualNeed` are excluded from the gate's
 *    own corpus (a verbatim source claim and a stock-photo query);
 *    `stat.figure`, a device's or a stat's `source` and the layout keys are
 *    not prose. A language correction may never change a number, a date, a
 *    name or a claim, and the cheapest way to guarantee that is to make those
 *    fields unreachable from the correction schema rather than to ask the
 *    judge nicely. The first comment's source URLs join that set for the same
 *    reason and by the same mechanism: they are built in code from the run's
 *    own fact cards (`post-package.ts`), they are not part of the document
 *    this patcher operates on at all, and `NativeCorrectionSchema.target` has
 *    no spelling that names one. Everything a reader DOES see is reachable:
 *    `headline`/`body`/`kicker`, a custom archetype's declared fields, device
 *    labels, the pull-quote, the stat sub-label, the comparison columns, the
 *    list rows (`archetypeTextSlots`), and now the first comment's prose and
 *    every slide's alt text.
 *
 * ## And then the free checks run again — this is not optional
 *
 * `07b` (craft hygiene) and `07e`/`07e2` (script and conventions) ran BEFORE
 * these corrections existed. Copy that ships must have passed every free check
 * **in the state it ships in**. Otherwise a judge proposal containing an em
 * dash — banned by `gate.lintPost` in every language — smuggles itself past a
 * gate that already said yes to different text.
 *
 * If either re-check fails, **the whole patch is discarded** and the raw draft
 * is returned untouched, with the reason named. Not the offending correction:
 * the whole patch. The re-checks read the assembled copy, not one field, so
 * they cannot say which correction broke it, and a patcher that guesses would
 * be back to rule 2's problem.
 *
 * The package round (Phase 5) is the same shape with its own two re-checks:
 * `08c1`'s free package rules, then the script gate over the package's prose.
 *
 * ## Phase 5 (RFC-18 §6.5): ONE VOCABULARY, TWO CONTEXTS
 *
 * `08c2-package-native-round` runs the SAME native editor over the post
 * package's prose — the first comment and the alt texts — so the correction
 * vocabulary widened rather than forked: `NativeCorrectionSchema.target` now
 * admits `comment` and `alt:N` beside `caption` and `slide:N`.
 *
 * **What keeps the two contexts apart is `resolveField`'s context guard, and
 * it is a refusal in both directions.** A `comment` or `alt:N` target arriving
 * on a CAROUSEL round is dropped; a `caption`, `headline` or `slide:N` target
 * arriving on a PACKAGE round is dropped. Not coerced, not best-effort
 * resolved — dropped, counted and reported, in the same idiom as the existing
 * "a caption correction named the field X" rejections.
 *
 * That guard is load-bearing rather than defensive. The two rounds patch two
 * different documents that are checkpointed at different steps: a package
 * correction that "resolved" against the carousel would rewrite approved,
 * language-corrected, already-gated slide copy AFTER the drafting loop broke
 * and after every gate that reads it has run — an edit nothing downstream
 * would ever re-check. The judge does not need to be wrong for that to happen,
 * only imprecise about which document it was handed.
 */

/** Which document a round of corrections is patching. The two never mix; see the module doc comment. */
export type NativeCorrectionRound = "carousel" | "package";

/** What the patcher needs that it cannot compute itself. */
export interface NativeCorrectionDeps {
  /**
   * The free craft-hygiene gate, re-run on the PATCHED copy.
   *
   * Injected rather than imported because `checkCraftHygiene` needs the tool
   * registry and an `AgentContext`, and this function is otherwise pure — a
   * caller in a test can hand it the real `gate.lintPost` (which is what
   * `__tests__/native-corrections.test.ts` does) without this module reaching
   * for a registry of its own.
   */
  readonly checkHygiene: (copy: InstagramCopyOutput) => Promise<SlidesDataSelfCheck>;
  /** The run's resolved target language, for `checkExpectedScript`. */
  readonly language: string;
}

/** The package round's equivalent. `checkPackage` is `08c1`'s free rules, re-run on the PATCHED package for the same reason. */
export interface PackageNativeCorrectionDeps {
  readonly checkPackage: (pkg: PostPackage) => Promise<SlidesDataSelfCheck>;
  readonly language: string;
}

/** One correction that was not applied, and the reason a reviewer will read in the degrade marker. */
export interface NativeCorrectionDrop {
  readonly correction: NativeCorrection;
  readonly reason: string;
}

export interface NativeCorrectionPatch {
  /** The patched copy, or — when the whole patch was discarded, or nothing applied — the input, byte-identical. */
  readonly copy: InstagramCopyOutput;
  readonly applied: number;
  readonly dropped: number;
  readonly drops: readonly NativeCorrectionDrop[];
  /** Exactly the corrections written into `copy`. Empty when `discardReason` is set. */
  readonly appliedCorrections: readonly NativeCorrection[];
  /** Set when a free re-check refused the patched copy and the whole patch was thrown away. */
  readonly discardReason?: string;
}

/** The package round's result. Same shape, different document. */
export interface PackageNativeCorrectionPatch {
  /** The patched package, or — when the whole patch was discarded, or nothing applied — the input, byte-identical. */
  readonly pkg: PostPackage;
  readonly applied: number;
  readonly dropped: number;
  readonly drops: readonly NativeCorrectionDrop[];
  readonly appliedCorrections: readonly NativeCorrection[];
  readonly discardReason?: string;
}

/**
 * The document a round patches.
 *
 * A discriminated union rather than a generic, so `resolveField` can hold both
 * contexts' branches in one function and therefore hold the guard between them
 * in one place. A guard split across two resolvers is a guard that can be half
 * deleted.
 */
type PatchDoc = { readonly round: "carousel"; readonly copy: InstagramCopyOutput } | { readonly round: "package"; readonly pkg: PostPackage };

/** Where one correction resolves to: the current text, the cap it must respect, and how to write it back. */
interface FieldTarget {
  readonly text: string;
  /** `Number.POSITIVE_INFINITY` where the schema states no maximum (headline, body, caption). */
  readonly max: number;
  /** The whole document with this one field replaced. Immutable — the input is never mutated, so a discarded patch leaves it byte-identical. */
  readonly write: (value: string) => PatchDoc;
}

/** One named free check that the PATCHED document has to clear before the patch is kept. */
interface Recheck {
  /** Named in the discard reason a reviewer reads. */
  readonly name: string;
  readonly run: (doc: PatchDoc) => Promise<SlidesDataSelfCheck>;
}

interface PatchRun {
  readonly doc: PatchDoc;
  readonly applied: number;
  readonly dropped: number;
  readonly drops: readonly NativeCorrectionDrop[];
  readonly appliedCorrections: readonly NativeCorrection[];
  readonly discardReason?: string;
}

export async function applyNativeCorrections(
  copy: InstagramCopyOutput,
  corrections: readonly NativeCorrection[],
  deps: NativeCorrectionDeps,
): Promise<NativeCorrectionPatch> {
  const out = await runPatch({ round: "carousel", copy }, corrections, "copy", [
    { name: "craft-hygiene gate", run: (doc) => deps.checkHygiene(asCopy(doc)) },
    { name: "script gate", run: async (doc) => checkExpectedScript(languageGateText(asCopy(doc)), deps.language) },
  ], deps.language);
  return {
    copy: asCopy(out.doc),
    applied: out.applied,
    dropped: out.dropped,
    drops: out.drops,
    appliedCorrections: out.appliedCorrections,
    ...(out.discardReason !== undefined ? { discardReason: out.discardReason } : {}),
  };
}

/**
 * `08c2-package-native-round`'s patch: the same four rules, the same span
 * anchoring, the same whole-patch discard, applied to the post package.
 *
 * There is no round 2 and no redraft here (RFC-18 §6.5). Corrections apply or
 * are dropped by the four refusal rules, and the package ships — which is why
 * this function, like everything else in Phase 5's whole-post family, cannot
 * produce a hold.
 */
export async function applyPackageNativeCorrections(
  pkg: PostPackage,
  corrections: readonly NativeCorrection[],
  deps: PackageNativeCorrectionDeps,
): Promise<PackageNativeCorrectionPatch> {
  const out = await runPatch({ round: "package", pkg }, corrections, "post package", [
    { name: "free post-package checks", run: (doc) => deps.checkPackage(asPackage(doc)) },
    { name: "script gate", run: async (doc) => checkExpectedScript(packageLanguageGateText(asPackage(doc)), deps.language) },
  ], deps.language);
  return {
    pkg: asPackage(out.doc),
    applied: out.applied,
    dropped: out.dropped,
    drops: out.drops,
    appliedCorrections: out.appliedCorrections,
    ...(out.discardReason !== undefined ? { discardReason: out.discardReason } : {}),
  };
}

/** The loop both rounds share: resolve, count, splice, cap, script, then the whole-patch re-checks. */
async function runPatch(
  start: PatchDoc,
  corrections: readonly NativeCorrection[],
  subject: string,
  rechecks: readonly Recheck[],
  language: string,
): Promise<PatchRun> {
  const drops: NativeCorrectionDrop[] = [];
  const appliedCorrections: NativeCorrection[] = [];
  let working = start;

  for (const correction of corrections) {
    const resolved = resolveField(working, correction);
    if (typeof resolved === "string") {
      drops.push({ correction, reason: resolved });
      continue;
    }

    const occurrences = countOccurrences(resolved.text, correction.span);
    if (occurrences !== 1) {
      drops.push({
        correction,
        reason:
          occurrences === 0
            ? `the quoted span does not appear in ${describe(correction)} — the judge quoted a paraphrase, not the text`
            : `the quoted span appears ${occurrences} times in ${describe(correction)}, so there is no unambiguous place to apply it`,
      });
      continue;
    }

    // Spliced by index, NOT `String.prototype.replace`. With a string search
    // value `replace` still scans the REPLACEMENT for `$$`, `$&`, `` $` ``
    // and `$'` and expands them, so a proposal containing any of those ships
    // text the judge never wrote — and because the corruption is still valid
    // script, the hygiene and script re-checks below wave it through.
    // `countOccurrences` has already proven exactly one occurrence, so the
    // index is unambiguous. (`bidi-isolate.ts` avoids the same trap by using
    // a replacer function.)
    const at = resolved.text.indexOf(correction.span);
    const patched = resolved.text.slice(0, at) + correction.replacement + resolved.text.slice(at + correction.span.length);
    if (patched.length > resolved.max) {
      drops.push({
        correction,
        reason: `the replacement takes ${describe(correction)} to ${patched.length} characters, past its ${resolved.max}-character schema cap`,
      });
      continue;
    }

    // Per-field script coverage, re-measured on the patched text. A Latin
    // product name inside a Hebrew sentence is normal and survives this; a
    // replacement that leaves the FIELD no longer written in the client's
    // script does not. `checkExpectedScript` has no opinion on a language it
    // does not know or a field too short to judge, which is the right
    // asymmetry here as everywhere else it is used.
    const script = checkExpectedScript(patched, language);
    if (!script.ok) {
      drops.push({ correction, reason: `the replacement leaves ${describe(correction)} outside the client's script: ${script.reason ?? "script check failed"}` });
      continue;
    }

    working = resolved.write(patched);
    appliedCorrections.push(correction);
  }

  if (appliedCorrections.length === 0) {
    // Nothing changed, so there is nothing for the free checks to re-approve —
    // and the document they already approved is the document being returned.
    return { doc: start, applied: 0, dropped: drops.length, drops, appliedCorrections: [] };
  }

  for (const recheck of rechecks) {
    const verdict = await recheck.run(working);
    if (!verdict.ok) {
      return discardAll(start, corrections, `the corrected ${subject} no longer passes the ${recheck.name} (${verdict.reason ?? "no reason given"})`);
    }
  }

  return { doc: working, applied: appliedCorrections.length, dropped: drops.length, drops, appliedCorrections };
}

function discardAll(doc: PatchDoc, corrections: readonly NativeCorrection[], reason: string): PatchRun {
  return {
    doc,
    applied: 0,
    dropped: corrections.length,
    drops: corrections.map((correction) => ({ correction, reason })),
    appliedCorrections: [],
    discardReason: reason,
  };
}

/** Narrowing helpers. `runPatch` never changes a document's round, so neither branch is reachable with the wrong shape. */
function asCopy(doc: PatchDoc): InstagramCopyOutput {
  if (doc.round !== "carousel") throw new Error("native-corrections: a carousel round produced a package document");
  return doc.copy;
}
function asPackage(doc: PatchDoc): PostPackage {
  if (doc.round !== "package") throw new Error("native-corrections: a package round produced a carousel document");
  return doc.pkg;
}

/** True for the two targets that name the POST PACKAGE's prose rather than the carousel's. */
function isPackageTarget(target: string): boolean {
  return target === "comment" || target.startsWith("alt:");
}

/**
 * THE CONTEXT GUARD (RFC-18 §6.5).
 *
 * One vocabulary, two contexts, neither able to reach into the other. A target
 * from the wrong context is REFUSED — never coerced, never best-effort
 * resolved — in both directions:
 *
 * - a `comment` / `alt:N` correction on a CAROUSEL round would otherwise have
 *   to be silently dropped by `resolveField`'s `slide:` arithmetic producing
 *   nonsense, or worse, resolved against a slide;
 * - a `caption` / `headline` / `slide:N` correction on a PACKAGE round would
 *   reach approved, already-gated slide copy AFTER the drafting loop broke and
 *   after every gate that reads it has run.
 *
 * Delete this and both leak. That is the whole reason it is one function
 * called from one place rather than two conditions in two resolvers.
 */
function contextMismatch(doc: PatchDoc, correction: NativeCorrection): string | undefined {
  const packageTarget = isPackageTarget(correction.target);
  if (doc.round === "carousel" && packageTarget) {
    return `a "${correction.target}" correction arrived on a carousel round — the first comment and the alt texts are not part of the carousel's copy`;
  }
  if (doc.round === "package" && !packageTarget) {
    return `a "${correction.target}" correction arrived on a post-package round — the caption and the slides were approved and gated before the package was written`;
  }
  return undefined;
}

/** A `FieldTarget`, or the reason this correction cannot be applied. */
function resolveField(doc: PatchDoc, correction: NativeCorrection): FieldTarget | string {
  const mismatch = contextMismatch(doc, correction);
  if (mismatch !== undefined) return mismatch;

  if (doc.round === "package") return resolvePackageField(doc.pkg, correction);
  return resolveCarouselField(doc.copy, correction);
}

/** The post package's two prose fields. `hashtags` is deliberately not among them — a one-word tag has no span to anchor a correction into (RFC-18 §6.3). */
function resolvePackageField(pkg: PostPackage, correction: NativeCorrection): FieldTarget | string {
  if (correction.target === "comment") {
    if (correction.field !== "comment") return `a first-comment correction named the field "${correction.field}"`;
    return {
      text: pkg.firstCommentText,
      max: FIRST_COMMENT_MAX_CHARS,
      write: (value) => ({ round: "package", pkg: { ...pkg, firstCommentText: value } }),
    };
  }

  if (correction.field !== "alt") return `an alt-text correction named the field "${correction.field}"`;
  const n = Number(correction.target.slice("alt:".length));
  const index = pkg.altText.findIndex((entry) => entry.n === n);
  if (index < 0) return `slide ${n} has no alt text in this package`;
  return {
    text: pkg.altText[index]!.alt,
    // 125 — `PostPackageSchema.altText[].alt`'s own `.max()`. Rule 3 guards it
    // here so an over-long replacement is one dropped correction rather than a
    // whole-package schema rejection a step later.
    max: ALT_TEXT_MAX_CHARS,
    write: (value) => ({
      round: "package",
      pkg: { ...pkg, altText: pkg.altText.map((entry, i) => (i === index ? { ...entry, alt: value } : entry)) },
    }),
  };
}

function resolveCarouselField(copy: InstagramCopyOutput, correction: NativeCorrection): FieldTarget | string {
  if (correction.target === "caption") {
    if (correction.field !== "caption") return `a caption correction named the field "${correction.field}"`;
    return {
      text: copy.caption,
      max: Number.POSITIVE_INFINITY,
      write: (value) => ({ round: "carousel", copy: { ...copy, caption: value } }),
    };
  }

  if (correction.field === "caption") return `a slide correction named the field "caption"`;
  if (correction.field === "comment" || correction.field === "alt") return `a slide correction named the field "${correction.field}"`;

  const n = Number(correction.target.slice("slide:".length));
  const index = copy.slides.findIndex((slide) => slide.n === n);
  if (index < 0) return `slide ${n} does not exist in this carousel`;
  const slide = copy.slides[index]!;
  const patchSlide = (patch: Partial<InstagramSlideCopy>): PatchDoc => ({
    round: "carousel",
    copy: { ...copy, slides: copy.slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) },
  });

  switch (correction.field) {
    case "headline":
      return { text: slide.headline, max: Number.POSITIVE_INFINITY, write: (value) => patchSlide({ headline: value }) };
    case "body":
      return { text: slide.body, max: Number.POSITIVE_INFINITY, write: (value) => patchSlide({ body: value }) };
    case "kicker":
      if (!slide.kicker || slide.kicker.length === 0) return `slide ${n} has no kicker`;
      // 48 — `InstagramSlideCopySchema.kicker`'s own `.max(48)`.
      return { text: slide.kicker, max: 48, write: (value) => patchSlide({ kicker: value }) };
    case "custom": {
      const key = correction.customKey;
      if (key === undefined || key.length === 0) return `a custom-field correction on slide ${n} named no customKey`;
      if (LAYOUT_FIELD_KEYS.has(key)) return `"${key}" is layout metadata, not prose, and is never rewritten by a language correction`;
      const archetype = slide.customArchetype;
      const current = archetype?.fields[key];
      if (archetype === undefined || current === undefined || current.length === 0) return `slide ${n} has no custom field "${key}"`;
      // 2000 — `SlideCustomArchetypeSchema.fields`'s own `z.string().max(2000)`.
      return {
        text: current,
        max: 2000,
        write: (value) => patchSlide({ customArchetype: { ...archetype, fields: { ...archetype.fields, [key]: value } } }),
      };
    }
    case "archetype": {
      // The same span-picks-the-slot rule `device` uses below, and for the
      // same reason: `NativeCorrection` carries no slot name for a block of
      // several short strings, and rule 2's ambiguity test has to apply
      // ACROSS the block's slots rather than within one of them.
      const slots = archetypeTextSlots(slide);
      if (slots.length === 0) return `slide ${n} has no archetype copy block (no quote, stat, comparison or list)`;
      const hits = slots.filter((slot) => countOccurrences(slot.text, correction.span) > 0);
      if (hits.length === 0) return `the quoted span does not appear in any of slide ${n}'s archetype copy fields`;
      if (hits.length > 1) return `the quoted span appears in ${hits.length} of slide ${n}'s archetype copy fields, so there is no unambiguous place to apply it`;
      const slot = hits[0]!;
      return {
        text: slot.text,
        max: slot.max,
        write: (value) => {
          const next = withArchetypeText(slide, slot.path, value);
          // Unreachable: `slot.path` came from `archetypeTextSlots(slide)`.
          // A no-op rather than a throw, for the reason the device branch
          // gives below.
          return next === undefined
            ? { round: "carousel", copy }
            : { round: "carousel", copy: { ...copy, slides: copy.slides.map((s, i) => (i === index ? next : s)) } };
        },
      };
    }
    case "device": {
      const device = slide.device;
      if (device === undefined) return `slide ${n} has no device`;
      // A device is several short strings rather than one field, and the
      // correction schema carries no slot name for it. The span itself picks
      // the slot — and rule 2 applies ACROSS slots, not within one: a span
      // that appears in two labels is exactly as ambiguous as one that appears
      // twice in a body.
      const hits = deviceTextSlots(device).filter((slot) => countOccurrences(slot.text, correction.span) > 0);
      if (hits.length === 0) return `the quoted span does not appear in any of slide ${n}'s device labels`;
      if (hits.length > 1) return `the quoted span appears in ${hits.length} of slide ${n}'s device labels, so there is no unambiguous place to apply it`;
      const slot = hits[0]!;
      return {
        text: slot.text,
        max: slot.max,
        write: (value) => {
          const next = withDeviceText(device, slot.path, value);
          // Unreachable: `slot.path` came from `deviceTextSlots(device)`. Kept
          // as a no-op rather than a throw so a future device kind whose two
          // helpers disagree degrades to "the correction did not apply".
          return next === undefined ? { round: "carousel", copy } : patchSlide({ device: next });
        },
      };
    }
  }

  // `field` is a closed enum and every carousel member is handled above; the
  // two package members were refused at the top of this function.
  return `a slide correction named the field "${correction.field}"`;
}

function describe(correction: NativeCorrection): string {
  if (correction.target === "caption") return "the caption";
  if (correction.target === "comment") return "the first comment";
  if (correction.target.startsWith("alt:")) return `slide ${correction.target.slice("alt:".length)}'s alt text`;
  const where = `slide ${correction.target.slice("slide:".length)}'s ${correction.field}`;
  return correction.field === "custom" && correction.customKey ? `${where} "${correction.customKey}"` : where;
}

/** Literal, non-overlapping occurrences. No regex: a span is text the model quoted, and quoted text is full of regex metacharacters. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}
