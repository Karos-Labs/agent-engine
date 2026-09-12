import {
  archetypeTextSlots,
  checkExpectedScript,
  deviceTextSlots,
  languageGateText,
  withArchetypeText,
  withDeviceText,
  type NativeCorrection,
} from "./language-gate.js";
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
 *    rejection that costs the attempt.
 * 4. **`sourceRef`, `visualNeed`, `stat.figure`, every `source` and every
 *    `LAYOUT_FIELD_KEY` are untouchable.** `sourceRef`/`visualNeed` are
 *    excluded from the gate's own corpus (a verbatim source claim and a
 *    stock-photo query); `stat.figure`, a device's or a stat's `source` and
 *    the layout keys are not prose. A language correction may never change a
 *    number, a date, a name or a claim, and the cheapest way to guarantee that
 *    is to make those fields unreachable from the correction schema rather
 *    than to ask the judge nicely. Everything a reader DOES see is reachable:
 *    `headline`/`body`/`kicker`, a custom archetype's declared fields, device
 *    labels, and — since the archetype blocks were wired in — the pull-quote,
 *    the stat sub-label, the comparison columns and the list rows
 *    (`archetypeTextSlots`).
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
 */

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

/** Where one correction resolves to: the current text, the cap it must respect, and how to write it back. */
interface FieldTarget {
  readonly text: string;
  /** `Number.POSITIVE_INFINITY` where the schema states no maximum (headline, body, caption). */
  readonly max: number;
  readonly write: (copy: InstagramCopyOutput, value: string) => InstagramCopyOutput;
}

export async function applyNativeCorrections(
  copy: InstagramCopyOutput,
  corrections: readonly NativeCorrection[],
  deps: NativeCorrectionDeps,
): Promise<NativeCorrectionPatch> {
  const drops: NativeCorrectionDrop[] = [];
  const appliedCorrections: NativeCorrection[] = [];
  let working = copy;

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
    const script = checkExpectedScript(patched, deps.language);
    if (!script.ok) {
      drops.push({ correction, reason: `the replacement leaves ${describe(correction)} outside the client's script: ${script.reason ?? "script check failed"}` });
      continue;
    }

    working = resolved.write(working, patched);
    appliedCorrections.push(correction);
  }

  if (appliedCorrections.length === 0) {
    // Nothing changed, so there is nothing for the free checks to re-approve —
    // and the copy they already approved is the copy being returned.
    return { copy, applied: 0, dropped: drops.length, drops, appliedCorrections: [] };
  }

  const hygiene = await deps.checkHygiene(working);
  if (!hygiene.ok) {
    return discardAll(copy, corrections, `the corrected copy no longer passes the craft-hygiene gate (${hygiene.reason ?? "no reason given"})`);
  }

  const script = checkExpectedScript(languageGateText(working), deps.language);
  if (!script.ok) {
    return discardAll(copy, corrections, `the corrected copy no longer passes the script gate (${script.reason ?? "no reason given"})`);
  }

  return { copy: working, applied: appliedCorrections.length, dropped: drops.length, drops, appliedCorrections };
}

function discardAll(copy: InstagramCopyOutput, corrections: readonly NativeCorrection[], reason: string): NativeCorrectionPatch {
  return {
    copy,
    applied: 0,
    dropped: corrections.length,
    drops: corrections.map((correction) => ({ correction, reason })),
    appliedCorrections: [],
    discardReason: reason,
  };
}

/** A `FieldTarget`, or the reason this correction cannot be applied. */
function resolveField(copy: InstagramCopyOutput, correction: NativeCorrection): FieldTarget | string {
  if (correction.target === "caption") {
    if (correction.field !== "caption") return `a caption correction named the field "${correction.field}"`;
    return {
      text: copy.caption,
      max: Number.POSITIVE_INFINITY,
      write: (c, value) => ({ ...c, caption: value }),
    };
  }

  if (correction.field === "caption") return `a slide correction named the field "caption"`;

  const n = Number(correction.target.slice("slide:".length));
  const index = copy.slides.findIndex((slide) => slide.n === n);
  if (index < 0) return `slide ${n} does not exist in this carousel`;
  const slide = copy.slides[index]!;
  const patchSlide = (c: InstagramCopyOutput, patch: Partial<InstagramSlideCopy>): InstagramCopyOutput => ({
    ...c,
    slides: c.slides.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  });

  switch (correction.field) {
    case "headline":
      return { text: slide.headline, max: Number.POSITIVE_INFINITY, write: (c, value) => patchSlide(c, { headline: value }) };
    case "body":
      return { text: slide.body, max: Number.POSITIVE_INFINITY, write: (c, value) => patchSlide(c, { body: value }) };
    case "kicker":
      if (!slide.kicker || slide.kicker.length === 0) return `slide ${n} has no kicker`;
      // 48 — `InstagramSlideCopySchema.kicker`'s own `.max(48)`.
      return { text: slide.kicker, max: 48, write: (c, value) => patchSlide(c, { kicker: value }) };
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
        write: (c, value) => patchSlide(c, { customArchetype: { ...archetype, fields: { ...archetype.fields, [key]: value } } }),
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
        write: (c, value) => {
          const next = withArchetypeText(slide, slot.path, value);
          // Unreachable: `slot.path` came from `archetypeTextSlots(slide)`.
          // A no-op rather than a throw, for the reason the device branch
          // gives below.
          return next === undefined ? c : { ...c, slides: c.slides.map((s, i) => (i === index ? next : s)) };
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
        write: (c, value) => {
          const next = withDeviceText(device, slot.path, value);
          // Unreachable: `slot.path` came from `deviceTextSlots(device)`. Kept
          // as a no-op rather than a throw so a future device kind whose two
          // helpers disagree degrades to "the correction did not apply".
          return next === undefined ? c : patchSlide(c, { device: next });
        },
      };
    }
  }
}

function describe(correction: NativeCorrection): string {
  const where = correction.target === "caption" ? "the caption" : `slide ${correction.target.slice("slide:".length)}'s ${correction.field}`;
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
