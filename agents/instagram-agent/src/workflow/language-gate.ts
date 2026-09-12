import { z } from "zod";
import type { AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import { InstagramNativeEditorAgent } from "../agent/instagram-native-editor-agent.js";
import type { SlideDevice } from "./slide-devices.js";
import type { InstagramCopyOutput, InstagramSlideCopy, SlidesDataSelfCheck } from "./types.js";

/**
 * SCRUM-310 (AU32): the language-compliance gate, in two stages, both run
 * inside step 07's existing self-check retry loop and both BEFORE step 08's
 * render.
 *
 * ## The gap this closes
 *
 * `instagram-image-vet@2` and `instagram-visual-qa@1` are the only quality
 * judges this workflow had before render, and neither of them reads the copy
 * as LANGUAGE: the first judges candidate photographs, the second judges a
 * rendered attempt's structured slide data against `check: "render"` layout
 * rules. Nothing anywhere asked whether the words that are about to be baked
 * into a 1080x1440 PNG are fluent, grammatical text in the language this
 * client publishes in. That is exactly how the geektime carousel (prep job
 * hcf9ymPGJC7mDS5pcEQ4) shipped in fluent English for a Hebrew-only outlet
 * and passed every check that existed.
 *
 * SCRUM-309 (AU31) gave the drafting prompt a structured language
 * REQUIREMENT (`client.getBrand`'s `language`, threaded through
 * `buildClientVoiceContext`). This is the other half: a requirement nothing
 * verifies is a request. Text baked into an image is also the one output a
 * human reviewer at gate 09a cannot fix in place — they can edit a caption,
 * they cannot re-typeset a PNG — so the check has to run before the render,
 * not after it.
 *
 * ## Why two stages and not one
 *
 * Stage 1 (`checkExpectedScript`) is pure code and costs nothing: is this
 * text in the expected writing system AT ALL? It catches the whole-post
 * failure mode that actually happened — an entirely English carousel for a
 * Hebrew client — with no model call, no latency and no way to be talked out
 * of its answer. Running it first also means the common catastrophic case
 * never pays for stage 2.
 *
 * Stage 2 (`runNativeEditor`) is the judgment stage 1 cannot make:
 * Hebrew characters in Hebrew-shaped nonsense are still Hebrew characters. A
 * model transliterating, emitting machine-translated word salad, writing
 * grammatically broken Hebrew, or — the commonest of the four, and the only
 * one that also survives a proofreader — writing GRAMMATICAL Hebrew that is
 * an English draft rendered clause by clause, all score 100% on the script
 * check. Only a reader of the language can call that.
 *
 * ## Phase 4 (RFC-15 §6): stage 2 is now a NATIVE EDITOR, not a fluency judge
 *
 * Phase 0 asked "is this Hebrew?" of a `commodity`-tier `DynamicAgent`
 * (`claude-haiku-4-5`, catalogued `languageStrength: "basic"`,
 * `rtlSupport: "basic"`) and got back a boolean plus a list of complaints. Two
 * things were wrong with that, and Phase 4 changes both:
 *
 * 1. **The model.** A `basic` row was being asked to rule on idiom. The judge
 *    is now `gemini-2.5-pro` — the CHEAPEST non-premium row in the catalog
 *    rated `multilingual-strong` + `rtlSupport: "strong"`
 *    (`gemini-3.1-pro-preview` also qualifies, at $2/$12; the two Opus rows
 *    qualify and are banned by the owner's no-Opus rule). See
 *    `InstagramNativeEditorAgent` for the arithmetic.
 * 2. **The output.** A complaint is not a remedy. Every finding now arrives as
 *    an ANCHORED CORRECTION — the exact span, the field it is in, and the
 *    sentence a native writer would have written instead — so the commonest
 *    outcome is a free in-place patch (`native-corrections.ts`) rather than a
 *    $0.24 redraft. An axis flagged WITHOUT a correction is discarded by
 *    `normaliseNativeEditorVerdict`: "report without correcting" is
 *    structurally unrepresentable, which is the plan's "returns to writing"
 *    enforced by the schema rather than requested by the prose.
 *
 * That contract — an anchor, a replacement, an axis and a severity — is not
 * expressible in the flat field DSL Phase 0 used (`AgentDefinitionFieldSchema`
 * is `string | number | boolean | string[]`), which is why stage 2 is a real
 * `BaseAgent` subclass with a zod `outputSchema` and a versioned prompt on
 * disk.
 *
 * ## When it runs at all
 *
 * Whenever step 02d resolved a target language for the client. Since the
 * 2026-09 Instagram upgrade (brief item B) that resolution is no longer
 * `client.getBrand().language` alone: `resolveTargetLanguage`
 * (`./target-language.ts`) also reads the profile, the voice rules and the
 * brand-voice document, because the audit found the gate had run in NONE of
 * ten sampled prep runs — geektime's Hebrew lives in its profile prose, and
 * karoslabs has no `brand.language` at all. The only client for whom both
 * stages are skipped is one with no evidence of any non-English language
 * anywhere (`status: "english-default"`), and that skip still costs no model
 * call and adds no step to the trace, like `runTopicGuardrail` with an
 * empty forbidden-topics list.
 *
 * ## Failure handling
 *
 * An incomplete stage-2 execution returns `status: "error"` (same shape as
 * Phase 0 — the checkpointed step records that the check did not run), after
 * ONE in-step retry under `LANGUAGE_FLUENCY_RETRY_SUFFIX`. The retry is what
 * keeps a transient 429 or a one-off malformed reply from costing a redraft:
 * the second judge call is $0.014, the redraft it prevents $0.240.
 *
 * **Phase 4 changes what the caller does with that error, and with a real
 * `not_native` verdict at the attempt cap.** Phase 0 failed closed into the
 * loop's `WorkflowHeld`. Under the owner's never-hold rule (RFC-15 §6.5) the
 * run instead DELIVERS: two judge rounds inside one attempt, then the best
 * version that exists — the corrected copy if the patch applied cleanly, else
 * the raw draft — flagged `degraded` or `unverified`, with a ledger warn and
 * the flag on the gate payload.
 *
 * "Fails closed" is preserved in the sense that still matters: unverified
 * Hebrew never ships SILENTLY. It ships FLAGGED, to a run that still has a
 * human gate at `09a`. A hold delivers nothing and a person cannot reject what
 * they never received; a flagged delivery is a decision a person can make. The
 * original geektime failure shipped because nothing told anyone.
 */

// ─────────────────────────────────────────────────────────────────────────
// Stage 1 — the deterministic script/charset check. No model call.
// ─────────────────────────────────────────────────────────────────────────

/** One writing system, as a single-code-point test plus a name for the failure message. */
export interface ExpectedScript {
  /** Canonical display name, e.g. `"Hebrew"`. */
  readonly name: string;
  /** Matches exactly one character belonging to this script. */
  readonly test: RegExp;
}

/** One row of `SCRIPT_TABLE`: a writing system plus every language name and BCP-47 primary subtag this gate knows to be written in it. */
export interface ScriptTableEntry {
  readonly script: ExpectedScript;
  /** Lower-cased language names, as a portal user would type them ("hebrew", "ivrit", "עברית"). */
  readonly names: readonly string[];
  /** Lower-cased BCP-47 primary subtags ("he", "iw"). */
  readonly tags: readonly string[];
}

/**
 * Language name / BCP-47 primary subtag -> writing system.
 *
 * `client.getBrand().language` is free text on purpose (see that field's own
 * doc comment) — "Hebrew", "he", "he-IL" are all shapes the portal can
 * legitimately produce — so this maps both spellings for every entry it
 * knows.
 *
 * The table is a KNOWN-LANGUAGES table, never a complete one, and the
 * unknown case is handled by skipping stage 1 entirely (see
 * `resolveExpectedScript`). That asymmetry is deliberate: a missing entry
 * must degrade to "this gate has no opinion", never to "fail every draft for
 * this client", because a failure here costs a redraft attempt and, at the
 * retry cap, the whole run.
 *
 * Private on purpose; `scriptTableEntries()` is the read-only view other
 * modules get. `target-language.ts` infers a client's language from prose
 * using exactly these names and script tests, and it must not carry a second
 * copy of them — two tables drift, and a language the inference knows but
 * the gate does not (or vice versa) is a client whose gate silently never
 * runs.
 */
const SCRIPT_TABLE: ReadonlyArray<ScriptTableEntry> = [
  { script: { name: "Hebrew", test: /\p{Script=Hebrew}/u }, names: ["hebrew", "ivrit", "עברית"], tags: ["he", "iw"] },
  { script: { name: "Arabic", test: /\p{Script=Arabic}/u }, names: ["arabic", "farsi", "persian", "urdu"], tags: ["ar", "fa", "ur"] },
  { script: { name: "Greek", test: /\p{Script=Greek}/u }, names: ["greek"], tags: ["el"] },
  {
    script: { name: "Cyrillic", test: /\p{Script=Cyrillic}/u },
    names: ["russian", "ukrainian", "bulgarian", "serbian", "belarusian", "macedonian"],
    tags: ["ru", "uk", "bg", "sr", "be", "mk"],
  },
  { script: { name: "Devanagari", test: /\p{Script=Devanagari}/u }, names: ["hindi", "marathi", "nepali", "sanskrit"], tags: ["hi", "mr", "ne", "sa"] },
  { script: { name: "Thai", test: /\p{Script=Thai}/u }, names: ["thai"], tags: ["th"] },
  { script: { name: "Armenian", test: /\p{Script=Armenian}/u }, names: ["armenian"], tags: ["hy"] },
  { script: { name: "Georgian", test: /\p{Script=Georgian}/u }, names: ["georgian"], tags: ["ka"] },
  // Japanese is written in three scripts at once; Korean mixes Hangul with
  // Han. Treating either as a single script would fail perfectly ordinary
  // text, so each one's test is the union it actually uses.
  {
    script: { name: "Japanese", test: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
    names: ["japanese"],
    tags: ["ja"],
  },
  { script: { name: "Korean", test: /[\p{Script=Hangul}\p{Script=Han}]/u }, names: ["korean"], tags: ["ko"] },
  { script: { name: "Chinese", test: /\p{Script=Han}/u }, names: ["chinese", "mandarin", "cantonese"], tags: ["zh"] },
  {
    script: { name: "Latin", test: /\p{Script=Latin}/u },
    names: [
      "english", "spanish", "french", "german", "italian", "portuguese", "dutch", "danish",
      "swedish", "norwegian", "finnish", "polish", "czech", "romanian", "hungarian", "turkish",
      "indonesian", "malay", "vietnamese", "catalan", "croatian", "slovak", "slovenian", "estonian",
      "latvian", "lithuanian", "filipino", "tagalog", "swahili", "afrikaans",
    ],
    tags: [
      "en", "es", "fr", "de", "it", "pt", "nl", "da", "sv", "no", "nb", "fi", "pl", "cs", "ro",
      "hu", "tr", "id", "ms", "vi", "ca", "hr", "sk", "sl", "et", "lv", "lt", "fil", "tl", "sw", "af",
    ],
  },
];

/**
 * Read-only view over `SCRIPT_TABLE` for `target-language.ts`'s inference —
 * the one table, shared, never duplicated (see `SCRIPT_TABLE`'s doc comment
 * for why). The array and its rows are frozen at module load so a consumer
 * cannot reach in and change what the gate itself checks against.
 */
const SCRIPT_TABLE_VIEW: ReadonlyArray<ScriptTableEntry> = Object.freeze(
  SCRIPT_TABLE.map((row) => Object.freeze({ script: Object.freeze({ ...row.script }), names: Object.freeze([...row.names]), tags: Object.freeze([...row.tags]) })),
);
export function scriptTableEntries(): ReadonlyArray<ScriptTableEntry> {
  return SCRIPT_TABLE_VIEW;
}

/**
 * The writing system a declared language is written in, or `undefined` when
 * this table has never heard of it.
 *
 * `undefined` means "no opinion", and every caller treats it as a pass — see
 * `SCRIPT_TABLE`'s note on why a missing entry must not fail a run.
 */
export function resolveExpectedScript(language: string): ExpectedScript | undefined {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  // "he-IL" / "he_IL" / "pt-BR" all decide on their primary subtag; the
  // region says nothing about the writing system.
  const primary = normalized.split(/[-_]/)[0] ?? normalized;
  for (const row of SCRIPT_TABLE) {
    if (row.names.includes(normalized) || row.tags.includes(primary)) return row.script;
  }
  return undefined;
}

/**
 * How much of the text's alphabetic content must be in the expected script.
 *
 * Not near-1.0 on purpose. Real Hebrew tech copy is full of Latin-script
 * product names, and real copy in any language carries brand names, model
 * numbers and URLs; a strict threshold would reject correct drafts, and a
 * rejection here costs a redraft attempt and eventually the run. The failure
 * this stage exists to catch is the one that actually happened — an entirely
 * English post for a Hebrew outlet, which scores 0.00 — so a floor that a
 * wholly-wrong-script draft cannot clear and a heavily-loanworded correct
 * draft comfortably clears is the right shape. Everything subtler than that
 * is stage 2's job.
 */
export const MIN_EXPECTED_SCRIPT_RATIO = 0.3;

/**
 * Below this many letters there is not enough signal to judge — a six-word
 * headline of proper nouns is not evidence of anything. Short text passes;
 * it is checked as part of the whole post anyway.
 */
export const MIN_LETTERS_TO_JUDGE = 24;

/**
 * Stage 1: is this text in the expected writing system at all?
 *
 * Pure, synchronous, no model call, no tools, no I/O. Counts Unicode letters
 * (`\p{L}` — never `[A-Za-z]`, which cannot see any of the scripts this is
 * for) and reports the share of them belonging to the expected script.
 *
 * Passes without an opinion when the language is unknown to
 * `SCRIPT_TABLE` or the text is too short to judge.
 */
export function checkExpectedScript(text: string, language: string): SlidesDataSelfCheck {
  const expected = resolveExpectedScript(language);
  if (!expected) return { ok: true };

  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_LETTERS_TO_JUDGE) return { ok: true };

  const inScript = letters.filter((ch) => expected.test.test(ch)).length;
  const ratio = inScript / letters.length;
  if (ratio >= MIN_EXPECTED_SCRIPT_RATIO) return { ok: true };

  return {
    ok: false,
    reason:
      `text is not written in the ${expected.name} script this client requires (language: "${language.trim()}") — ` +
      `only ${inScript}/${letters.length} letters (${(ratio * 100).toFixed(0)}%) are ${expected.name}, ` +
      `below the ${(MIN_EXPECTED_SCRIPT_RATIO * 100).toFixed(0)}% floor`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The text both stages judge
// ─────────────────────────────────────────────────────────────────────────

/**
 * Everything a human will actually READ: the caption plus every slide's
 * on-image prose, including a custom archetype's own slot values (the same
 * "every archetype, not just the six whose text lives in headline/body"
 * reasoning `checkCraftHygiene` uses).
 *
 * `sourceRef` and `visualNeed` are deliberately excluded. Neither is ever
 * rendered or published: `sourceRef` must match a step-04 research fact's
 * claim VERBATIM (see `checkSlidesData`) and research runs in whatever
 * language the sources are in, and `visualNeed` is a stock-photo search
 * query. Gating on either would fail every correct Hebrew draft whose
 * sources happen to be English.
 */
export function languageGateText(copy: InstagramCopyOutput): string {
  const slideText = copy.slides.map((slide) =>
    [
      slide.headline,
      slide.body,
      slide.kicker ?? "",
      // The archetype copy blocks, for the same reason `languageGateFields`
      // emits them: on a `quote_card` the pull-quote is the ONLY prose the
      // reader sees, and the aggregate ratio used to be computed without it.
      ...archetypeTextSlots(slide).map((slot) => slot.text),
      ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : []),
    ]
      .filter((s) => s.length > 0)
      .join(" "),
  );
  return [copy.caption, ...slideText].join("\n\n");
}

/**
 * Every judged field, individually, with the id the native editor anchors its
 * corrections to.
 *
 * The same corpus `languageGateText` concatenates, plus DEVICE LABELS — and
 * that addition is the point of this function existing beside it. A device's
 * labels are rendered copy: they are baked into the PNG like any headline,
 * they are already in `collectSlideText` (`slides-data.ts`) so they decide
 * which direction the carousel is written in, and until Phase 4 no gate had
 * ever read them as language. A Hebrew carousel whose only English string is
 * a bar chart's row labels is exactly the kind of near-miss the aggregate
 * ratio waves through.
 *
 * Ids are `caption`, `slide-3.headline`, `slide-3.fields.leftLabel`,
 * `slide-3.device.rows.1.label` — the shape `applyNativeCorrections` resolves
 * back to a field, so the judge's anchor and the patcher's target are one
 * vocabulary rather than two.
 *
 * `sourceRef` and `visualNeed` stay excluded for the unchanged reason
 * (`languageGateText`'s own doc comment): `sourceRef` must match a step-04
 * research fact's claim VERBATIM and research runs in whatever language the
 * sources are in, and `visualNeed` is a stock-photo search query. Gating on
 * either fails every correct Hebrew draft whose sources happen to be English.
 * A device's `source` is excluded for the first of those two reasons, and a
 * device's numerals (`value`, `display`, `at`) for the second — neither is
 * prose, and neither is something a native editor can rewrite without
 * changing a claim.
 */
export function languageGateFields(copy: InstagramCopyOutput): Array<{ id: string; text: string }> {
  const fields: Array<{ id: string; text: string }> = [];
  const push = (id: string, text: string | undefined): void => {
    if (typeof text === "string" && text.trim().length > 0) fields.push({ id, text });
  };

  push("caption", copy.caption);
  for (const slide of copy.slides) {
    const prefix = `slide-${slide.n}`;
    push(`${prefix}.headline`, slide.headline);
    push(`${prefix}.body`, slide.body);
    push(`${prefix}.kicker`, slide.kicker);
    // The archetype copy blocks — the prose `quote_card`, `stat_callout`,
    // `comparison_card` and `list_takeaway` actually paint. See
    // `archetypeTextSlots` for why judging headline/body alone left four of
    // the eight archetypes entirely unread.
    for (const slot of archetypeTextSlots(slide)) {
      push(`${prefix}.${slot.path}`, slot.text);
    }
    for (const [key, value] of Object.entries(slide.customArchetype?.fields ?? {})) {
      push(`${prefix}.fields.${key}`, value);
    }
    for (const slot of slide.device ? deviceTextSlots(slide.device) : []) {
      push(`${prefix}.device.${slot.path}`, slot.text);
    }
  }
  return fields;
}

// ─────────────────────────────────────────────────────────────────────────
// Device label slots — the one enumeration of a device's PROSE
// ─────────────────────────────────────────────────────────────────────────

/** One rewritable string somewhere in a slide: where it is, what it says, and the cap its own schema puts on it. */
export interface SlideTextSlot {
  /** Dotted path within its owner, e.g. `"label"`, `"rows.1.label"`, `"quote.text"`, `"items.1.note"`. */
  readonly path: string;
  readonly text: string;
  /** The owning schema's own `max` for this string, or `Infinity` where it states none. A replacement past it would fail the output schema on the next parse. */
  readonly max: number;
}

/** One rewritable string inside a `SlideDevice`. The same shape as every other slide slot — one interface so the two enumerations cannot drift. */
export type DeviceTextSlot = SlideTextSlot;

/**
 * Every prose string a device renders, with its schema cap.
 *
 * Numerals (`figure.value`, `figure_pair.*.value`, `bars.rows[].display`,
 * `timeline.points[].at`, `unit_grid.filled`) and every `source` are
 * deliberately absent: a numeral is not language, and a source is a citation
 * the copy step is required to carry verbatim. Rewriting either would let a
 * language correction change a claim, which is the one thing the native
 * editor is told never to do.
 */
export function deviceTextSlots(device: SlideDevice): DeviceTextSlot[] {
  switch (device.kind) {
    case "figure":
      return [{ path: "label", text: device.label, max: 80 }];
    case "figure_pair":
      return [
        { path: "before.label", text: device.before.label, max: 40 },
        { path: "after.label", text: device.after.label, max: 40 },
      ];
    case "bars":
      return device.rows.map((row, i) => ({ path: `rows.${i}.label`, text: row.label, max: 40 }));
    case "timeline":
      return device.points.map((point, i) => ({ path: `points.${i}.what`, text: point.what, max: 60 }));
    case "versus":
      return [
        { path: "left.label", text: device.left.label, max: 40 },
        { path: "left.body", text: device.left.body, max: 120 },
        { path: "right.label", text: device.right.label, max: 40 },
        { path: "right.body", text: device.right.body, max: 120 },
      ];
    case "unit_grid":
      return [{ path: "label", text: device.label, max: 80 }];
  }
}

/**
 * The same device with ONE slot's text replaced, or `undefined` when the path
 * does not name a slot on this device kind.
 *
 * Immutable — returns a new device rather than mutating the checkpointed one,
 * so a patch that is later discarded wholesale leaves the original copy
 * byte-identical.
 */
export function withDeviceText(device: SlideDevice, path: string, value: string): SlideDevice | undefined {
  switch (device.kind) {
    case "figure":
      return path === "label" ? { ...device, label: value } : undefined;
    case "unit_grid":
      return path === "label" ? { ...device, label: value } : undefined;
    case "figure_pair":
      if (path === "before.label") return { ...device, before: { ...device.before, label: value } };
      if (path === "after.label") return { ...device, after: { ...device.after, label: value } };
      return undefined;
    case "versus":
      if (path === "left.label") return { ...device, left: { ...device.left, label: value } };
      if (path === "left.body") return { ...device, left: { ...device.left, body: value } };
      if (path === "right.label") return { ...device, right: { ...device.right, label: value } };
      if (path === "right.body") return { ...device, right: { ...device.right, body: value } };
      return undefined;
    case "bars": {
      const index = matchIndexedPath(path, "rows", "label");
      if (index === undefined || index >= device.rows.length) return undefined;
      return { ...device, rows: device.rows.map((row, i) => (i === index ? { ...row, label: value } : row)) };
    }
    case "timeline": {
      const index = matchIndexedPath(path, "points", "what");
      if (index === undefined || index >= device.points.length) return undefined;
      return { ...device, points: device.points.map((point, i) => (i === index ? { ...point, what: value } : point)) };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Archetype copy blocks — the prose four archetypes ACTUALLY render
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every prose string a slide's ARCHETYPE BLOCK renders, with its schema cap.
 *
 * ## Why this exists
 *
 * `headline`, `body` and `kicker` are not what four of the eight archetypes
 * paint. `contentFor` (`slides-data.ts`) is the authority on what reaches a
 * template, and it routes:
 *
 *   - `quote_card`      -> `quote.text`, `quote.attribution`  (and NOT headline/body)
 *   - `stat_callout`    -> `stat.subLabel`, `stat.source`, body
 *   - `comparison_card` -> `comparison.{left,right}{Label,Body}`, headline, body
 *   - `list_takeaway`   -> `items[].title`, `items[].note`, headline
 *
 * `grep -o "{{[a-zA-Z:]*}}" assets/templates/default/quote-card.html` returns
 * no `headline` and no `body`. So until this function existed, a Hebrew
 * carousel whose PULL-QUOTE was written in English passed `07e`'s aggregate
 * script check, `gate.nativeLanguage`'s per-field rule 1 and the native
 * editor — all three judged two strings the reader never sees and none of
 * them read the ones the reader does. Phase 4 itself proves these strings
 * render: `contentFor` puts every one of them through `iso()`.
 *
 * ## What is deliberately absent
 *
 * `stat.figure` and every `source` — the SAME rule `deviceTextSlots` and
 * `languageGateText` already apply, for the same two reasons. A figure is a
 * numeral, not language. A source is a citation the copy step carries
 * verbatim from step-04 research, which runs in whatever language the sources
 * are in; gating on it fails every correct Hebrew draft whose sources happen
 * to be English, and rewriting it would let a language correction change a
 * claim. `stat.source` renders (as `sourceLine`) and is still excluded on
 * those grounds, exactly as a device's `source` is.
 */
export function archetypeTextSlots(slide: InstagramSlideCopy): SlideTextSlot[] {
  const slots: SlideTextSlot[] = [];
  // No `max` on any of these in `types.ts` — `SlideQuoteSchema`,
  // `SlideStatSchema.subLabel`, `SlideComparisonSchema` and `SlideListSchema`
  // are all `.min(1)` with no upper bound, so rule 3 in the patcher can never
  // fire on them. Stated as `Infinity` rather than omitted so the slot shape
  // stays one shape.
  const free = Number.POSITIVE_INFINITY;
  if (slide.quote) {
    slots.push({ path: "quote.text", text: slide.quote.text, max: free });
    slots.push({ path: "quote.attribution", text: slide.quote.attribution, max: free });
  }
  if (slide.stat) {
    slots.push({ path: "stat.subLabel", text: slide.stat.subLabel, max: free });
  }
  if (slide.comparison) {
    slots.push({ path: "comparison.leftLabel", text: slide.comparison.leftLabel, max: free });
    slots.push({ path: "comparison.leftBody", text: slide.comparison.leftBody, max: free });
    slots.push({ path: "comparison.rightLabel", text: slide.comparison.rightLabel, max: free });
    slots.push({ path: "comparison.rightBody", text: slide.comparison.rightBody, max: free });
  }
  for (const [i, item] of (slide.items ?? []).entries()) {
    slots.push({ path: `items.${i}.title`, text: item.title, max: free });
    if (item.note !== undefined) slots.push({ path: `items.${i}.note`, text: item.note, max: free });
  }
  return slots;
}

/** Write one `archetypeTextSlots` path back, or `undefined` when the path does not name a slot this slide has. */
export function withArchetypeText(slide: InstagramSlideCopy, path: string, value: string): InstagramSlideCopy | undefined {
  if (slide.quote && path === "quote.text") return { ...slide, quote: { ...slide.quote, text: value } };
  if (slide.quote && path === "quote.attribution") return { ...slide, quote: { ...slide.quote, attribution: value } };
  if (slide.stat && path === "stat.subLabel") return { ...slide, stat: { ...slide.stat, subLabel: value } };
  if (slide.comparison) {
    for (const key of ["leftLabel", "leftBody", "rightLabel", "rightBody"] as const) {
      if (path === `comparison.${key}`) return { ...slide, comparison: { ...slide.comparison, [key]: value } };
    }
  }
  if (slide.items) {
    for (const leaf of ["title", "note"] as const) {
      const index = matchIndexedPath(path, "items", leaf);
      if (index === undefined || index >= slide.items.length) continue;
      return { ...slide, items: slide.items.map((item, i) => (i === index ? { ...item, [leaf]: value } : item)) };
    }
  }
  return undefined;
}

function matchIndexedPath(path: string, collection: string, leaf: string): number | undefined {
  const parts = path.split(".");
  if (parts.length !== 3 || parts[0] !== collection || parts[2] !== leaf) return undefined;
  const index = Number(parts[1]);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2 — the native editor (RFC-15 §6). One `gemini-2.5-pro` call.
// ─────────────────────────────────────────────────────────────────────────

/** Bounded so a long post cannot push the rubric out of the judge's attention — same bound and reason as `GUARDRAIL_MAX_OUTPUT_CHARS`. */
export const LANGUAGE_JUDGE_MAX_CHARS = 24_000;

/** The step id this gate's judge checkpoints under, before the `-attempt-N` suffix the retry loop adds. Unchanged from Phase 0: ~30 fixtures pin it, and it still names what the step is. */
export const LANGUAGE_FLUENCY_STEP_ID = "07f-language-fluency";

/** The step id stage 1 checkpoints under, before the `-attempt-N` suffix. */
export const LANGUAGE_SCRIPT_STEP_ID = "07e-language-script";

/**
 * Appended to the caller's step id for the one in-step retry of the judge
 * (`07f-language-fluency-attempt-2-retry`). Its own checkpoint rather than a
 * re-call under the same id: `step.agent` replays any checkpointed status —
 * `content_fail` and `tooling_error` included — so a second call with the
 * first call's id would return the first call's failure without ever touching
 * the model. A distinct id is also what makes the retry visible in the trace
 * and idempotent across a resume.
 */
export const LANGUAGE_FLUENCY_RETRY_SUFFIX = "-retry";

/**
 * Appended for the SECOND judge round of one attempt, after
 * `applyNativeCorrections` has patched the draft in place
 * (`07f-language-fluency-attempt-2-round-2`).
 *
 * Same mechanism and the same reason as the retry suffix — a distinct
 * checkpoint, so the second round is a real second call and not a replay of
 * the first round's verdict on text that has since changed. The two rounds are
 * the plan's "two rounds", reconciled with the owner's never-hold rule: two
 * rounds, then DELIVER the best version, degraded with a reason (RFC-15 §6.5).
 */
export const LANGUAGE_FLUENCY_ROUND2_SUFFIX = "-round-2";

export interface LanguageGateDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

// ─────────────────────────────────────────────────────────────────────────
// The rubric's six axes, and the output contract
// ─────────────────────────────────────────────────────────────────────────

/**
 * The six things a native reader clocks (RFC-15 §1), each a named axis the
 * judge scores independently.
 *
 * Exported because three things must agree on them and none of them may own a
 * private copy: this module's parser, the prompt on disk (pinned by
 * `__tests__/native-editor-rubric.test.ts`), and whatever reads
 * `DraftResult.language.axes` downstream.
 */
export const NATIVE_EDITOR_AXES = ["translationese", "grammar", "register", "terminology", "convention", "idiom"] as const;
export type NativeAxis = (typeof NATIVE_EDITOR_AXES)[number];

/** One axis's verdict. `minor` is "a native reader would notice"; `major` is "a native reader would stop reading". */
export const NativeAxisVerdictSchema = z.enum(["ok", "minor", "major"]);
export type NativeAxisVerdict = z.infer<typeof NativeAxisVerdictSchema>;

/**
 * Stamped on every verdict so telemetry can tell rubric eras apart: a shift in
 * the per-axis failure mix means nothing unless you know which rubric produced
 * it. Bumped whenever `prompts/instagram-native-editor/N.md` changes what an
 * axis MEANS, not when it gains an example.
 */
export const NATIVE_EDITOR_RUBRIC_VERSION = "1";

/**
 * How many `minor` axes make a draft not-native. Any `major` fails on its own.
 *
 * A real threshold with a real other side: two minors pass, three do not. Two
 * noticed-but-forgivable things in a carousel is a human editor's ordinary
 * output; three is a pattern, and a pattern is what a native reader calls
 * "translated". Its test asserts both sides — flip this to 4 and the
 * three-minor case goes green, which is how that test is known to be able to
 * fail.
 */
export const NATIVE_EDITOR_MINOR_FAIL_COUNT = 3;

/**
 * One anchored correction: WHERE, WHAT IS WRONG, and — the load-bearing part —
 * WHAT TO WRITE INSTEAD.
 *
 * `span` is an EXACT substring of the named field, never a paraphrase of it:
 * `applyNativeCorrections` patches by literal substring match and drops
 * anything that does not resolve to exactly one occurrence. That is what turns
 * "the judge thinks slide 3 sounds translated" into a $0 in-place fix instead
 * of a $0.24 redraft.
 */
export const NativeCorrectionSchema = z.object({
  /** `"caption"`, or `"slide:3"` for the slide whose `n` is 3. */
  target: z.string().regex(/^(caption|slide:[1-8])$/),
  /**
   * `"archetype"` covers the copy blocks four archetypes render instead of
   * `headline`/`body` — the pull-quote, the stat sub-label, the two
   * comparison columns, the list rows. Like `"device"`, it carries no slot
   * name: the SPAN picks the slot, and a span appearing in two slots is as
   * ambiguous as one appearing twice in a body. See `archetypeTextSlots`.
   */
  field: z.enum(["headline", "body", "kicker", "caption", "device", "custom", "archetype"]),
  /** Which `customArchetype.fields` key, when `field` is `"custom"`. */
  customKey: z.string().max(64).optional(),
  span: z.string().min(1).max(240),
  replacement: z.string().min(1).max(240),
  axis: z.enum(NATIVE_EDITOR_AXES),
  severity: z.enum(["minor", "major"]),
  why: z.string().max(160),
});
export type NativeCorrection = z.infer<typeof NativeCorrectionSchema>;

/**
 * The judge's whole output.
 *
 * `corrections` is capped at 12: past a dozen anchored spans the right remedy
 * is a redraft, not a patch, and an uncapped array is an invitation to return
 * a proofreading essay instead of a verdict.
 */
export const NativeEditorVerdictSchema = z.object({
  native: z.boolean(),
  axes: z.object({
    translationese: NativeAxisVerdictSchema,
    grammar: NativeAxisVerdictSchema,
    register: NativeAxisVerdictSchema,
    terminology: NativeAxisVerdictSchema,
    convention: NativeAxisVerdictSchema,
    idiom: NativeAxisVerdictSchema,
  }),
  corrections: z.array(NativeCorrectionSchema).max(12),
  rubricVersion: z.string(),
});
export type NativeEditorVerdict = z.infer<typeof NativeEditorVerdictSchema>;

/** Every axis `ok` — the shape a clean draft, and an outage, both report. */
export function okAxes(): Record<NativeAxis, NativeAxisVerdict> {
  return { translationese: "ok", grammar: "ok", register: "ok", terminology: "ok", convention: "ok", idiom: "ok" };
}

/**
 * The verdict rule, in code: not native when ANY axis is `major`, or when
 * `NATIVE_EDITOR_MINOR_FAIL_COUNT` or more axes are `minor`.
 *
 * Computed here rather than trusted from the model's own `native` boolean. The
 * prompt states the same rule, but a rule stated to a model is a request; the
 * threshold that decides whether a run pays for a second round has to be the
 * one in the repository.
 */
export function decideNative(axes: Record<NativeAxis, NativeAxisVerdict>): boolean {
  const values = NATIVE_EDITOR_AXES.map((axis) => axes[axis]);
  if (values.includes("major")) return false;
  return values.filter((v) => v === "minor").length < NATIVE_EDITOR_MINOR_FAIL_COUNT;
}

/**
 * The parser that makes "report without correcting" structurally
 * unrepresentable.
 *
 * A non-`ok` axis carrying NO correction is discarded — set back to `ok` —
 * rather than counted. That is the plan's "returns to writing", enforced by
 * the schema and this function rather than requested by the prose: a judge
 * that flags an axis and proposes nothing has produced a hold generator, which
 * is precisely the defect Phase 0's own comment records. It costs a redraft
 * and tells the writer nothing it can act on.
 *
 * The `native` boolean is then recomputed from the surviving axes by
 * `decideNative`, so a model that flags six axes with no corrections and
 * declares `native: false` is read as what it actually delivered: nothing.
 */
export function normaliseNativeEditorVerdict(raw: NativeEditorVerdict): {
  axes: Record<NativeAxis, NativeAxisVerdict>;
  corrections: NativeCorrection[];
  native: boolean;
} {
  const corrections = raw.corrections.filter((c) => c.span.trim().length > 0 && c.replacement.trim().length > 0);
  const axes = okAxes();
  for (const axis of NATIVE_EDITOR_AXES) {
    const claimed = raw.axes[axis];
    if (claimed === "ok") continue;
    if (corrections.some((c) => c.axis === axis)) axes[axis] = claimed;
  }
  return { axes, corrections, native: decideNative(axes) };
}

// ─────────────────────────────────────────────────────────────────────────
// Running the judge
// ─────────────────────────────────────────────────────────────────────────

/**
 * How many of the client's own posts the judge is shown.
 *
 * Four, against the writer's six, and they are THE SAME POSTS (RFC-15 §6.2).
 * Load-bearing fairness rather than a token saving: a judge holding the writer
 * to a register the writer was never shown generates corrections the next
 * draft cannot converge on, and two rounds of that is $0.028 spent to arrive
 * back where it started.
 */
export const NATIVE_EDITOR_FEW_SHOT_CAP = 4;

/** Each exemplar is trimmed to this — enough to hear a register, not enough to teach a topic. */
export const NATIVE_EDITOR_FEW_SHOT_CHARS = 400;

/** Everything the native editor reads. Assembled by the caller from `04l`'s language brief and the drafted copy. */
export interface NativeEditorInput {
  /** The resolved target language, verbatim as `resolveTargetLanguage` produced it ("Hebrew", "he-IL"). */
  language: string;
  /** The writing system, from `resolveExpectedScript` — never a second table. */
  script?: string;
  /** `04l`'s rendered register card: the measured statistics, the pack rows, the client's stated tone. */
  registerCard?: string;
  /** The client's real published posts in this language — the SAME corpus the writer received. */
  fewShot?: readonly string[];
  /** `gate.nativeLanguage`'s soft tells, to be confirmed or rejected one by one with a corrected string. */
  softTells?: readonly string[];
  /** Every judged field, from `languageGateFields`. The ids are what corrections anchor to. */
  fields: ReadonlyArray<{ id: string; text: string }>;
}

/** What `runNativeEditor` hands back. `error` means the judge could not run, twice; it is not a verdict on the draft. */
export interface NativeEditorResult {
  status: "native" | "not_native" | "error";
  axes: Record<NativeAxis, NativeAxisVerdict>;
  /** Only the corrections that survived the parser. Empty when `native` or `error`. */
  corrections: NativeCorrection[];
  rubricVersion: string;
  /** Why the check could not run, when `status` is `"error"`. */
  error?: string;
  /**
   * Vendor calls this actually made: 2 whenever the in-step retry ran, 1
   * otherwise.
   *
   * Returned because the CALLER meters, and it used to infer this from
   * `status === "error"` — which books a first call that failed plus a retry
   * that SUCCEEDED as one call. That path is real and the suite exercises it
   * (`language-compliance-gate.test.ts`'s retry case). Up to six judge calls
   * across a three-attempt Hebrew run, so up to $0.084 the meter never saw.
   */
  calls: 1 | 2;
  /**
   * What the vendor said these calls cost, summed across the retry — the
   * MEASURED figure, not the estimate.
   *
   * `undefined` when no call reported one. Every other agent step in this
   * workflow passes `<x>Exec.totalCostUsd` to `spend`; this one passed
   * nothing, so `RunSpendMeter.add`'s `max(measured, estimate)` always
   * recorded the estimate and `ewmaRatio` — which is supposed to teach the
   * next run what this client's Hebrew actually costs — learned the estimate
   * back.
   */
  costUsd?: number;
}

/** Sum the vendor's readings across the calls that reported one. `undefined` when none did, which `RunSpendMeter.add` reads as "the vendor told us nothing". */
function sumCosts(...costs: ReadonlyArray<number | undefined>): number | undefined {
  const known = costs.filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/** The payload actually sent, after the few-shot cap and the character bound. */
export function buildNativeEditorPayload(input: NativeEditorInput): Record<string, unknown> {
  const fewShot = (input.fewShot ?? [])
    .filter((post) => post.trim().length > 0)
    .slice(0, NATIVE_EDITOR_FEW_SHOT_CAP)
    .map((post) => post.slice(0, NATIVE_EDITOR_FEW_SHOT_CHARS));

  // Bound the DRAFT, not the rubric: the fields are the only part of this
  // payload whose size the model controls, and the instruction has to survive
  // a carousel that arrived long.
  const fields: Array<{ id: string; text: string }> = [];
  let budget = LANGUAGE_JUDGE_MAX_CHARS;
  for (const field of input.fields) {
    if (budget <= 0) break;
    fields.push({ id: field.id, text: field.text.slice(0, budget) });
    budget -= field.text.length;
  }

  return {
    language: input.language,
    ...(input.script ? { script: input.script } : {}),
    ...(input.registerCard ? { registerCard: input.registerCard } : {}),
    ...(fewShot.length > 0 ? { clientPublishedVoice: fewShot } : {}),
    ...(input.softTells && input.softTells.length > 0 ? { softTells: input.softTells } : {}),
    fields,
    rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
  };
}

/**
 * Stage 2: one `gemini-2.5-pro` call asking whether a native reader would
 * clock this draft as translated — and, wherever the answer is yes, what to
 * write instead.
 *
 * Never throws. A judge call that does not complete is retried ONCE, under
 * `${stepId}${LANGUAGE_FLUENCY_RETRY_SUFFIX}`, before this returns
 * `status: "error"`. The retry is what keeps a transient 429 or a one-off
 * malformed reply from costing a Sonnet redraft: the second judge call is
 * $0.014, the redraft it prevents $0.240.
 *
 * What the CALLER does with `error` is no longer "fail closed into a hold"
 * (Phase 0's posture) — RFC-15 §6.5: two rounds, then DELIVER, flagged. A hold
 * delivers nothing and a person cannot reject what they never received; a
 * flagged delivery is a decision a person at gate `09a` can actually make. The
 * original geektime failure shipped because nothing told anyone, not because
 * something shipped.
 */
export async function runNativeEditor(
  wf: WorkflowContext,
  deps: LanguageGateDeps,
  input: NativeEditorInput,
  stepId: string,
): Promise<NativeEditorResult> {
  const judge = new InstagramNativeEditorAgent({ tools: deps.tools, router: deps.router, promptStore: deps.promptStore });
  const payload = buildNativeEditorPayload(input);

  let exec = await wf.step.agent(stepId, judge, payload);
  // Both readings are kept whatever happens next: a first call that failed
  // still billed tokens, and the caller must book both.
  const firstCostUsd = exec.totalCostUsd;
  let calls: 1 | 2 = 1;
  if (exec.status !== "completed" || !exec.finalOutput) {
    const firstStatus = exec.status;
    calls = 2;
    // Any non-completed status is retried, not just `tooling_error`: with
    // `maxSteps: 1` a `content_fail` here is the model returning something its
    // own output schema rejects, which on a fresh sample is as transient as a
    // rate limit.
    exec = await wf.step.agent(`${stepId}${LANGUAGE_FLUENCY_RETRY_SUFFIX}`, judge, payload);
    if (exec.status !== "completed" || !exec.finalOutput) {
      const failedCost = sumCosts(firstCostUsd, exec.totalCostUsd);
      return {
        status: "error",
        axes: okAxes(),
        corrections: [],
        rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION,
        error: `native ${input.language} editor did not complete (${firstStatus}), nor on its in-step retry (${exec.status})`,
        calls,
        ...(failedCost !== undefined ? { costUsd: failedCost } : {}),
      };
    }
  }

  const raw = exec.finalOutput as unknown as NativeEditorVerdict;
  const { axes, corrections, native } = normaliseNativeEditorVerdict(raw);
  const costUsd = sumCosts(calls === 2 ? firstCostUsd : undefined, exec.totalCostUsd);
  return {
    status: native ? "native" : "not_native",
    axes,
    corrections: native ? [] : corrections,
    calls,
    ...(costUsd !== undefined ? { costUsd } : {}),
    // The judge's own stamp is kept when it sent one — an old checkpoint
    // replayed after a rubric bump must report the era it was judged in, not
    // today's.
    rubricVersion: raw.rubricVersion.trim().length > 0 ? raw.rubricVersion : NATIVE_EDITOR_RUBRIC_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Back to the writer
// ─────────────────────────────────────────────────────────────────────────

/**
 * The corrections as a redraft steer: one line per correction, quoted span to
 * proposed replacement.
 *
 * The fourth typed steer beside `dedupeRetrySteer`, `relevanceSteer` and
 * `selfCheckSteer`, and kept separate from all three for the reason the
 * existing comment already gives — a language correction and a failed render
 * rule are different remedies and must not overwrite each other.
 *
 * The writer's prompt (§16) says a correction is APPLIED, not argued with, and
 * that nothing about a number, a date, a name or a claim may change while
 * applying it. This function's job is only to say where and what, unambiguously
 * enough that "apply it" is a mechanical instruction.
 */
export function nativeSteerFor(corrections: readonly NativeCorrection[]): string {
  return corrections
    .map((c) => {
      const where = c.target === "caption" ? "caption" : `slide ${c.target.slice("slide:".length)} · ${fieldLabel(c)}`;
      return `${where} · "${c.span}" → "${c.replacement}" (${c.why})`;
    })
    .join("\n");
}

function fieldLabel(correction: NativeCorrection): string {
  if (correction.field === "custom" && correction.customKey) return `fields.${correction.customKey}`;
  return correction.field;
}
