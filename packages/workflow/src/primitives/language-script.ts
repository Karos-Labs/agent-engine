/**
 * Which writing system a language is written in, and whether a draft is
 * actually written in it.
 *
 * Pure, synchronous, no model call, no tools, no I/O — a deterministic floor
 * under every agent that publishes copy in a language somebody chose.
 *
 * ## Why this lives here and not in an agent
 *
 * It was instagram-agent's, in `language-gate.ts`, and it was correct. When
 * the TikTok family needed the same check (2026-09-18) the choice was to copy
 * ~150 lines of table or to move them, and the table's OWN doc comment already
 * argues the case against a second copy: "two tables drift, and a language the
 * inference knows but the gate does not (or vice versa) is a client whose gate
 * silently never runs". That reasoning does not stop at a package boundary.
 * `language-gate.ts` re-exports every name below, so instagram's call sites
 * and its tests are unchanged.
 *
 * What did NOT move is everything shaped like one agent's content:
 * `languageGateText`, the slide slot walkers, the native-editor axes. This
 * module knows about strings and scripts and nothing else.
 */

/** The result of a deterministic self-check — pass, or fail with a reason a human can read. */
export type ScriptCheck = { ok: true } | { ok: false; reason: string };

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
 * unknown case is handled by skipping the check entirely (see
 * `resolveExpectedScript`). That asymmetry is deliberate: a missing entry
 * must degrade to "this check has no opinion", never to "fail every draft for
 * this client", because a failure here costs a redraft attempt and, at the
 * retry cap, used to cost the whole run.
 *
 * Private on purpose; `scriptTableEntries()` is the read-only view other
 * modules get. instagram's `target-language.ts` infers a client's language
 * from prose using exactly these names and script tests, and it must not
 * carry a second copy of them.
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
 * Read-only view over `SCRIPT_TABLE` for language inference — the one table,
 * shared, never duplicated (see `SCRIPT_TABLE`'s doc comment for why). The
 * array and its rows are frozen at module load so a consumer cannot reach in
 * and change what the check itself tests against.
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
 * rejection here costs a redraft attempt. The failure this check exists to
 * catch is the one that actually happened — an entirely English post for a
 * Hebrew outlet, which scores 0.00 — so a floor that a wholly-wrong-script
 * draft cannot clear and a heavily-loanworded correct draft comfortably
 * clears is the right shape. Everything subtler than that needs a model.
 */
export const MIN_EXPECTED_SCRIPT_RATIO = 0.3;

/**
 * Below this many letters there is not enough signal to judge — a six-word
 * headline of proper nouns is not evidence of anything. Short text passes.
 */
export const MIN_LETTERS_TO_JUDGE = 24;

/**
 * Is this text in the expected writing system at all?
 *
 * Counts Unicode letters (`\p{L}` — never `[A-Za-z]`, which cannot see any of
 * the scripts this is for) and reports the share of them belonging to the
 * expected script.
 *
 * Passes without an opinion when the language is unknown to `SCRIPT_TABLE` or
 * the text is too short to judge. **It proves a draft is in the wrong SCRIPT;
 * it can never prove one is in the right LANGUAGE** — a French draft for a
 * German client is Latin either way, and this returns `ok` for it. Anything
 * finer than a writing system needs a model that reads.
 */
export function checkExpectedScript(text: string, language: string): ScriptCheck {
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
