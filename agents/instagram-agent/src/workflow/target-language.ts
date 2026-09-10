import { MIN_LETTERS_TO_JUDGE, scriptTableEntries, type ScriptTableEntry } from "./language-gate.js";

/**
 * Target-language resolution for step `02d-load-target-language` (Instagram
 * upgrade 2026-09, brief item B).
 *
 * ## The gap this closes
 *
 * 02d used to read one field, `client.getBrand().language`, and return
 * `null` when it was unset — which made the whole language gate (07e/07f)
 * conditional on a portal field almost nobody had filled in. The audit of
 * ten prep runs (2026-08-25..09-08) found the gate had run in NONE of them:
 * karoslabs has no `brand.language`; geektime, the Hebrew outlet the gate
 * was written for, states its language in profile prose ("Israel's largest
 * Hebrew-language technology site") and nowhere structured. A gate that is
 * "always on" in name and never on in practice is the geektime defect with
 * a green tick next to it.
 *
 * ## What this does instead
 *
 * Four sources, strictly ordered, first decisive one wins:
 *
 * 1. `brand.language` — the structured field, verbatim. Explicit beats
 *    inferred, always; a portal user who set it is not overruled by prose.
 * 2. An EXPLICIT language mention in the client's own prose (profile
 *    description, voice-rules guidelines/doList, brand-voice document),
 *    matched only in shapes that describe the client's OUTPUT language:
 *    "Hebrew-language site", "publishes in Hebrew", "written in Hebrew",
 *    "content in Hebrew", "Hebrew-speaking audience/market/readers". The
 *    shapes are deliberately narrow — "we work with Hebrew-speaking
 *    founders" describes who the client sells to, not what it publishes,
 *    and must NOT resolve (pinned by test).
 * 3. A SCRIPT SNIFF of that same prose: when at least half of its letters
 *    are in one non-Latin script, a client whose own profile is written in
 *    Hebrew publishes in Hebrew. Scripts that carry exactly one language in
 *    the gate's table (Hebrew, Greek, Thai, Armenian, Georgian; Japanese
 *    when kana is present, Korean when Hangul is present) resolve. Scripts
 *    shared by several languages (Arabic, Cyrillic, Devanagari, Han alone)
 *    cannot be resolved honestly — guessing "Russian" for a Ukrainian
 *    outlet would have the fluency judge fail every correct draft — so they
 *    return `unresolved-non-english` with the table's candidates, and 02d
 *    HOLDS the run asking for `brand.language`. That is intake, not a copy
 *    problem, and it costs zero model calls.
 * 4. Otherwise `english-default`: no evidence of any non-English language
 *    anywhere. This is the only status for which 07e/07f are skipped.
 *
 * ## English is not a target
 *
 * Every source above can name ENGLISH — `brand.language = "en-US"`, a
 * profile that says "for English-speaking markets", voice rules that say
 * "written in English" — and English resolving to a `resolved` status would
 * switch the whole gate on for an English client: 07e on every attempt, and
 * 07f (fail-closed since 2026-09) buying a per-attempt Haiku call whose only
 * possible new outcome is a hold on a judge outage ("refusing to ship
 * unverified English copy"). The brief scopes the gate to "any non-English
 * target" and prices the fluency judge as a non-English cost. So a
 * resolution whose language IS English (`isEnglishTarget`) is reported as
 * `english-default` with the statement recorded in `evidence` — the client
 * did declare a language, and the honest answer is that there is nothing for
 * this gate to verify. Every other Latin-script language (Spanish, French,
 * Portuguese) still resolves and still gets both stages: script alone cannot
 * tell those apart, which is exactly what the judge is for.
 *
 * ## Why the table is shared, not copied
 *
 * Names and script tests come from `language-gate.ts`'s `SCRIPT_TABLE` via
 * its read-only `scriptTableEntries()` view. The inference and the gate must
 * agree on what a language is called: a language this module can infer but
 * `resolveExpectedScript` cannot map would run 07f against a script check
 * that has no opinion, and a name the gate knows but this module does not
 * would never be inferred at all.
 *
 * Pure, synchronous, no I/O; the workflow step reads the tools and passes
 * the values in, so this is unit-testable against plain fixtures.
 */

export type TargetLanguageSource = "brand" | "profile" | "voice-rules" | "brand-voice-doc" | "script-sniff";

export type TargetLanguageResolution =
  | {
      status: "resolved";
      /** The language as the gate will use it: a display name ("Hebrew") or, from `brand.language`, whatever the portal holds ("he-IL"). */
      language: string;
      source: TargetLanguageSource;
      /** Human-readable trail of what was read and what decided; for logs and the hold reason, never checkpointed by itself. */
      evidence: string[];
    }
  | { status: "english-default"; evidence: string[] }
  | {
      status: "unresolved-non-english";
      /** The dominant script's display name ("Cyrillic"). */
      script: string;
      /**
       * Which prose actually triggered this — `"profile.description"`,
       * `"voiceRules.doList"`, `"all client prose"`. The hold reason quotes it
       * rather than saying "the profile", which was wrong (and misleading to
       * whoever has to fix it) whenever the script came from one voice-rules
       * line.
       */
      sourceLabel: string;
      /** Languages the gate's table knows to be written in that script, as display names. */
      candidates: string[];
      evidence: string[];
    };

/**
 * Every field admits an explicit `undefined` (not just absence) because the
 * caller builds this from tool outcomes — `outcome?.status === "success" ?
 * result : undefined` — and `exactOptionalPropertyTypes` would otherwise
 * force a spread-per-field dance at the one call site.
 */
export interface TargetLanguageInput {
  /** `client.getBrand().language`, untyped because the portal field is free text and may be absent or non-string. */
  brandLanguage?: unknown;
  /** `client.getProfile()`'s record; only `description` is read. */
  profile?: Record<string, unknown> | undefined;
  /** `client.getVoiceRules()`'s record; `guidelines` (string or string[]) and `doList` (string[]) are read. */
  voiceRules?: Record<string, unknown> | undefined;
  /** `client.getContextDoc({ docType: "brand-voice" }).markdown`, when the client has one. */
  brandVoiceDoc?: string | undefined;
}

/**
 * Fewer letters than this and the script sniff has no opinion: a two-word
 * Hebrew tagline inside an otherwise-empty profile is not evidence of an
 * outlet's language. Same floor, same reasoning, as stage 1's own.
 */
export const MIN_SNIFF_LETTERS = MIN_LETTERS_TO_JUDGE;

/** Share of `\p{L}` letters one non-Latin script must reach for the sniff to call it. */
export const MIN_SNIFF_SHARE = 0.5;

/**
 * Scripts whose every language in the gate's table is the same language, so
 * a script sniff CAN name the language honestly. Japanese and Korean are
 * decided separately (kana / Hangul presence) because their table tests
 * include Han, which they share with Chinese.
 */
const SINGLE_LANGUAGE_SCRIPTS: ReadonlySet<string> = new Set(["Hebrew", "Greek", "Thai", "Armenian", "Georgian"]);

/** Script rows the sniff scores individually; CJK and Latin are handled by name. */
const CJK_SCRIPT_NAMES: ReadonlySet<string> = new Set(["Japanese", "Korean", "Chinese"]);

/**
 * Names in the table that are not the English display name of the language.
 * Everything else displays as its capitalised table spelling ("hebrew" ->
 * "Hebrew", "farsi" -> "Farsi"), which `resolveExpectedScript` accepts as-is.
 */
const LANGUAGE_NAME_ALIASES: Readonly<Record<string, string>> = { ivrit: "Hebrew", "עברית": "Hebrew" };

/**
 * Is this language English — under any spelling the portal or a profile can
 * produce ("English", "english", "en", "en-GB", "en_US")?
 *
 * The one language for which this gate has no work to do (see the module
 * header's "English is not a target"). Normalised the same way
 * `resolveExpectedScript` normalises: trimmed, lower-cased, region dropped.
 * Deliberately NOT "the language's script is Latin": Spanish and Portuguese
 * are Latin too, and telling them apart from English is the fluency judge's
 * entire job.
 */
export function isEnglishTarget(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const primary = normalized.split(/[-_]/)[0] ?? normalized;
  return normalized === "english" || primary === "en";
}

function displayLanguageName(tableName: string): string {
  const alias = LANGUAGE_NAME_ALIASES[tableName];
  if (alias) return alias;
  return tableName.charAt(0).toUpperCase() + tableName.slice(1);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `\b` is ASCII-only even under the `u` flag — between a space and "ע" there
 * is no word boundary because neither is `\w` — so the boundaries here are
 * letter lookarounds, which work for every script in the table.
 */
const NOT_AFTER_LETTER = "(?<!\\p{L})";
const NOT_BEFORE_LETTER = "(?!\\p{L})";

/**
 * The shapes in which a client's prose states its OUTPUT language. Each is
 * anchored on the language name; none matches a bare name, because "our
 * Hebrew founders" or "the Russian market" says nothing about what the
 * client publishes. The fourth allows one adverb ("publishes exclusively in
 * Spanish", "publishes only in Hebrew") — the real workflow-e2e fixture is
 * written that way.
 */
function explicitMentionPatterns(name: string): RegExp[] {
  const n = escapeRegExp(name);
  return [
    new RegExp(`${NOT_AFTER_LETTER}${n}(?:-|\\s)?(?:language|only)${NOT_BEFORE_LETTER}`, "iu"),
    new RegExp(`${NOT_AFTER_LETTER}${n}(?:-|\\s)?speaking\\s+(?:audiences?|markets?|readers|readership)${NOT_BEFORE_LETTER}`, "iu"),
    new RegExp(`${NOT_AFTER_LETTER}publish(?:es|ed|ing)?\\s+(?:\\p{L}+\\s+)?in\\s+${n}${NOT_BEFORE_LETTER}`, "iu"),
    new RegExp(`${NOT_AFTER_LETTER}written\\s+in\\s+${n}${NOT_BEFORE_LETTER}`, "iu"),
    new RegExp(`${NOT_AFTER_LETTER}content\\s+in\\s+${n}${NOT_BEFORE_LETTER}`, "iu"),
  ];
}

/**
 * A BCP-47 tag WITH a region ("he-IL", "pt-BR") in the "publishes in" /
 * "written in" / "content in" shapes. Bare primary subtags are deliberately
 * not matched in prose: "written in it" and "content in no" are English
 * sentences, not Italian and Norwegian declarations. The region makes the
 * token unmistakably a language tag.
 */
const TAGGED_LANGUAGE_MENTION = new RegExp(
  `${NOT_AFTER_LETTER}(?:publish(?:es|ed|ing)?\\s+(?:\\p{L}+\\s+)?in|written\\s+in|content\\s+in)\\s+([a-z]{2,3})-([A-Z]{2})${NOT_BEFORE_LETTER}`,
  "gu",
);

interface CompiledMention {
  language: string;
  patterns: RegExp[];
}

/** Built once from the shared table; ~50 names x 5 shapes is a trivial regex set. */
const EXPLICIT_MENTIONS: readonly CompiledMention[] = scriptTableEntries().flatMap((entry) =>
  entry.names.map((name) => ({ language: displayLanguageName(name), patterns: explicitMentionPatterns(name) })),
);

const KNOWN_PRIMARY_TAGS: ReadonlySet<string> = new Set(scriptTableEntries().flatMap((entry) => entry.tags));

export interface ExplicitLanguageMention {
  language: string;
  /** The matched text, for evidence. */
  match: string;
  /** Character offset of the match, so the earliest statement in a text wins when several languages are named. */
  index: number;
}

/**
 * Every explicit output-language statement in `text`, earliest first.
 * Exported for tests; `resolveTargetLanguage` takes the first.
 */
export function findExplicitLanguageMentions(text: string): ExplicitLanguageMention[] {
  const found: ExplicitLanguageMention[] = [];
  for (const { language, patterns } of EXPLICIT_MENTIONS) {
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m && m.index !== undefined) found.push({ language, match: m[0], index: m.index });
    }
  }
  for (const m of text.matchAll(TAGGED_LANGUAGE_MENTION)) {
    const primary = m[1]!.toLowerCase();
    if (!KNOWN_PRIMARY_TAGS.has(primary)) continue;
    found.push({ language: `${primary}-${m[2]!}`, match: m[0], index: m.index ?? 0 });
  }
  found.sort((a, b) => a.index - b.index);
  // One entry per language, at its earliest position.
  const seen = new Set<string>();
  return found.filter((f) => (seen.has(f.language) ? false : (seen.add(f.language), true)));
}

export type ScriptSniff =
  | { kind: "resolved"; language: string; script: string; share: number; letters: number }
  | { kind: "ambiguous"; script: string; candidates: string[]; share: number; letters: number }
  | { kind: "latin"; share: number; letters: number }
  | { kind: "insufficient"; letters: number }
  | { kind: "mixed"; letters: number };

function singleScriptEntries(): ScriptTableEntry[] {
  return scriptTableEntries().filter((e) => e.script.name !== "Latin" && !CJK_SCRIPT_NAMES.has(e.script.name));
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Which writing system dominates `text`, and whether that alone names a
 * language. Exported for tests.
 *
 * CJK is scored as one family and then split: Japanese text always carries
 * kana, Korean text always carries Hangul, and text that is Han alone could
 * be Chinese or a Japanese headline written entirely in kanji — so Han alone
 * is `ambiguous` with the Chinese row's names as candidates, never a guess.
 */
export function sniffDominantScript(text: string): ScriptSniff {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_SNIFF_LETTERS) return { kind: "insufficient", letters: letters.length };

  let kana = 0;
  let hangul = 0;
  let han = 0;
  let latin = 0;
  const perScript = new Map<string, number>();
  const entries = singleScriptEntries();
  for (const ch of letters) {
    if (KANA.test(ch)) kana++;
    else if (HANGUL.test(ch)) hangul++;
    else if (HAN.test(ch)) han++;
    else if (LATIN.test(ch)) latin++;
    else {
      for (const entry of entries) {
        if (entry.script.test.test(ch)) {
          perScript.set(entry.script.name, (perScript.get(entry.script.name) ?? 0) + 1);
          break;
        }
      }
    }
  }
  const total = letters.length;

  const cjk = kana + hangul + han;
  if (cjk / total >= MIN_SNIFF_SHARE) {
    const share = cjk / total;
    if (kana > 0) return { kind: "resolved", language: "Japanese", script: "Japanese", share, letters: total };
    if (hangul > 0) return { kind: "resolved", language: "Korean", script: "Korean", share, letters: total };
    const chinese = scriptTableEntries().find((e) => e.script.name === "Chinese");
    return { kind: "ambiguous", script: "Han", candidates: (chinese?.names ?? ["chinese"]).map(displayLanguageName), share, letters: total };
  }

  let best: { name: string; count: number } | undefined;
  for (const [name, count] of perScript) {
    if (!best || count > best.count) best = { name, count };
  }
  if (best && best.count / total >= MIN_SNIFF_SHARE) {
    const share = best.count / total;
    if (SINGLE_LANGUAGE_SCRIPTS.has(best.name)) return { kind: "resolved", language: best.name, script: best.name, share, letters: total };
    const entry = entries.find((e) => e.script.name === best!.name);
    return { kind: "ambiguous", script: best.name, candidates: (entry?.names ?? []).map(displayLanguageName), share, letters: total };
  }

  if (latin / total >= MIN_SNIFF_SHARE) return { kind: "latin", share: latin / total, letters: total };
  return { kind: "mixed", letters: total };
}

interface ProseSource {
  source: Exclude<TargetLanguageSource, "brand" | "script-sniff">;
  label: string;
  text: string;
  /**
   * Is this the client describing ITSELF (the profile description, the
   * brand-voice document) rather than a rule someone wrote about its posts?
   *
   * Only used by the script sniff, and only to break the one tie that
   * matters: when the client's prose AS A WHOLE reads Latin, a self-
   * description written in Hebrew still names the language (a Hebrew outlet
   * whose agency wrote the voice rules in English — pinned by test), but a
   * single non-Latin voice-rule LINE does not get to overrule a plainly
   * English profile. See `resolveTargetLanguage`'s step 3.
   */
  selfDescription: boolean;
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return [];
}

/** The prose the inference reads, in precedence order; a source with nothing to say is omitted. */
function collectProse(input: TargetLanguageInput): ProseSource[] {
  const sources: ProseSource[] = [];
  const description = stringsOf(input.profile?.["description"]);
  if (description.length > 0) sources.push({ source: "profile", label: "profile.description", text: description.join("\n"), selfDescription: true });
  const guidelines = stringsOf(input.voiceRules?.["guidelines"]);
  if (guidelines.length > 0) sources.push({ source: "voice-rules", label: "voiceRules.guidelines", text: guidelines.join("\n"), selfDescription: false });
  const doList = stringsOf(input.voiceRules?.["doList"]);
  if (doList.length > 0) sources.push({ source: "voice-rules", label: "voiceRules.doList", text: doList.join("\n"), selfDescription: false });
  const doc = stringsOf(input.brandVoiceDoc);
  if (doc.length > 0) sources.push({ source: "brand-voice-doc", label: "brand-voice doc", text: doc.join("\n"), selfDescription: true });
  return sources;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Resolve the language the client publishes in. See the module doc comment
 * for the four sources and their order; this function is that order and
 * nothing else.
 */
export function resolveTargetLanguage(input: TargetLanguageInput): TargetLanguageResolution {
  const evidence: string[] = [];

  // 1. The structured field, verbatim. "he-IL" stays "he-IL": the gate's own
  //    `resolveExpectedScript` maps tags, and rewriting a portal value here
  //    would make 02d's checkpoint disagree with what the portal shows.
  if (typeof input.brandLanguage === "string" && input.brandLanguage.trim().length > 0) {
    const language = input.brandLanguage.trim();
    // ...unless it says English, for which this gate has nothing to check
    // (module header, "English is not a target"). Recorded as evidence: the
    // field WAS set, and a reader of the trace should see that.
    if (isEnglishTarget(language)) return { status: "english-default", evidence: [`brand.language = "${language}", which needs no language gate`] };
    return { status: "resolved", language, source: "brand", evidence: [`brand.language = "${language}"`] };
  }
  evidence.push("brand.language unset");

  const sources = collectProse(input);
  if (sources.length === 0) {
    evidence.push("no profile description, voice-rules guidelines/doList or brand-voice document to read");
    return { status: "english-default", evidence };
  }

  // 2. An explicit statement of the output language, in precedence order of
  //    source; within a source, the earliest statement.
  for (const src of sources) {
    const mentions = findExplicitLanguageMentions(src.text);
    if (mentions.length === 0) continue;
    // English mentions are dropped, not resolved: a source that names English
    // AND another language ("published in Hebrew, with a weekly digest in
    // English") is gated on the language that has something to verify, and a
    // source that names ONLY English is an explicit English declaration —
    // english-default, no gate, no per-attempt judge.
    const [first, ...rest] = mentions.filter((m) => !isEnglishTarget(m.language));
    if (first === undefined) {
      evidence.push(`${src.label} states "${mentions[0]!.match}", which needs no language gate`);
      return { status: "english-default", evidence };
    }
    evidence.push(`${src.label} states "${first.match}"`);
    for (const other of rest) evidence.push(`${src.label} also mentions "${other.match}" (later in the text; not used)`);
    return { status: "resolved", language: first.language, source: src.source, evidence };
  }
  evidence.push(`no explicit language statement in ${sources.map((s) => s.label).join(", ")}`);

  // 3. The script the prose itself is written in — the whole of it first
  //    (the spec's "that prose"), then each source alone, so an agency that
  //    wrote a client's voice rules in English cannot dilute a profile the
  //    client wrote in Hebrew below the floor.
  const wholeText = sources.map((s) => s.text).join("\n");
  const wholeSniff = sniffDominantScript(wholeText);
  /**
   * The client's prose, taken together, reads as Latin. Then a NON-Latin
   * verdict from one field alone is a minority signal, and what it is allowed
   * to do depends on which field:
   *
   * - `resolved` (a single-language script: Hebrew, Greek, Thai, ...) from a
   *   SELF-DESCRIPTION still wins — that is the geektime shape, a profile in
   *   Hebrew whose voice rules an agency wrote in English, and naming Hebrew
   *   there is right (pinned by test). From a voice-RULE line it does not:
   *   one Hebrew do-list line on an English profile is not evidence that the
   *   client publishes in Hebrew, and resolving it would fail 07e on every
   *   attempt and hold the run.
   * - `ambiguous` (Cyrillic, Arabic, Devanagari, Han) never wins here at all,
   *   whichever field it came from: escalating it HOLDS THE RUN AT INTAKE
   *   ("set brand.language in the portal") for a client whose profile is
   *   plainly English. One Cyrillic voice-rule line — 24 letters is the whole
   *   floor — used to be enough to make every run for that client
   *   unrunnable. A hold has to be the honest answer to "which language is
   *   this client's?", and when the client's prose as a whole is Latin, it
   *   is not.
   */
  const latinWhole = wholeSniff.kind === "latin";
  const candidatesToSniff: Array<{ label: string; text: string; selfDescription: boolean }> = [
    { label: "all client prose", text: wholeText, selfDescription: true },
    ...sources.map((s) => ({ label: s.label, text: s.text, selfDescription: s.selfDescription })),
  ];
  let ambiguous: { label: string; sniff: Extract<ScriptSniff, { kind: "ambiguous" }> } | undefined;
  for (const { label, text, selfDescription } of candidatesToSniff) {
    const sniff = sniffDominantScript(text);
    if (sniff.kind === "resolved") {
      if (latinWhole && !selfDescription) {
        evidence.push(`${label}: ${sniff.letters} letters, ${pct(sniff.share)} ${sniff.script} script, but the client's prose as a whole is Latin — not used`);
        continue;
      }
      evidence.push(`${label}: ${sniff.letters} letters, ${pct(sniff.share)} ${sniff.script} script`);
      return { status: "resolved", language: sniff.language, source: "script-sniff", evidence };
    }
    if (sniff.kind === "ambiguous" && !ambiguous) ambiguous = { label, sniff };
  }
  if (ambiguous && !latinWhole) {
    const { label, sniff } = ambiguous;
    evidence.push(`${label}: ${sniff.letters} letters, ${pct(sniff.share)} ${sniff.script} script, which ${sniff.candidates.length} languages share`);
    return { status: "unresolved-non-english", script: sniff.script, sourceLabel: label, candidates: sniff.candidates, evidence };
  }
  if (ambiguous) {
    evidence.push(
      `${ambiguous.label}: ${ambiguous.sniff.letters} letters, ${pct(ambiguous.sniff.share)} ${ambiguous.sniff.script} script, ` +
        `but the client's prose as a whole is Latin — treated as English rather than holding the run over one field`,
    );
  }

  // 4. Nothing pointed anywhere but English.
  const whole = wholeSniff;
  evidence.push(
    whole.kind === "latin"
      ? `all client prose: ${whole.letters} letters, ${pct(whole.share)} Latin script`
      : whole.kind === "insufficient"
        ? `all client prose: only ${whole.letters} letters, too few to judge a script`
        : `all client prose: ${whole.letters} letters, no script reaches the ${pct(MIN_SNIFF_SHARE)} floor`,
  );
  return { status: "english-default", evidence };
}
