import { MIN_LETTERS_TO_JUDGE, resolveExpectedScript, scriptTableEntries, type ScriptTableEntry } from "./language-gate.js";

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
 * Five sources, strictly ordered, first decisive one wins (source 3 is
 * Phase 4 / RFC-15 §2; the rest are unchanged):
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
 * 3. A PERSISTED BELIEF (`instagramLanguage`, written at `09b`): a previous
 *    run's DECISIVE resolution for this client. It ranks above the sniff
 *    because it is a record of a run MEASURING WHAT THE CLIENT PUBLISHED,
 *    which outranks an inference from a self-description blurb; and below
 *    both explicit statements so a human who later sets `brand.language`
 *    always wins and the belief can never become unfixable.
 *
 *    The decisiveness filter is the whole point: a belief recorded from a
 *    `sniff` is persisted for observability and NEVER re-read (see
 *    `readLanguageBelief`). A once-guessed answer must not calcify into
 *    permanent truth for a client.
 *
 * 4. A SCRIPT SNIFF of that same prose: when at least half of its letters
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
 * 5. Otherwise `english-default`: no evidence of any non-English language
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

export type TargetLanguageSource = "brand" | "profile" | "voice-rules" | "brand-voice-doc" | "belief" | "script-sniff";

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
  /**
   * `memory.read({ scope: "beliefs" })`'s document, for source 3. Absent —
   * which is every caller that has not been taught to read it, and every
   * existing test — makes this function behave EXACTLY as it did before
   * Phase 4: `readLanguageBelief(undefined)` is `undefined`, and no evidence
   * line about beliefs is pushed.
   */
  beliefs?: Record<string, unknown> | undefined;
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
export const SINGLE_LANGUAGE_SCRIPTS: ReadonlySet<string> = new Set(["Hebrew", "Greek", "Thai", "Armenian", "Georgian"]);

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

// ─────────────────────────────────────────────────────────────────────────────
// Source 3 — the persisted belief (Phase 4, RFC-15 §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The key under which `memory.updateBeliefs` / `memory.read({scope:"beliefs"})`
 * carry this client's settled language, beside `RUN_BUDGET_BELIEF_KEY` and the
 * skeleton/visual-direction histories. `updateBeliefs` shallow-merges a diff,
 * so a sibling key needs no schema and no migration.
 */
export const LANGUAGE_BELIEF_KEY = "instagramLanguage";

/**
 * How a run came to believe a client's language. Ordered by how much the next
 * run should trust it, and NOT interchangeable: `own-posts` is a measurement
 * of what the client published, `sniff` is a guess about what a self-
 * description blurb is written in, and only the first four are decisive
 * enough to be re-read (`DECISIVE_BELIEF_SOURCES`).
 */
export const LANGUAGE_BELIEF_SOURCES = ["own-posts", "brand-language", "explicit-mention", "brief", "sniff"] as const;
export type LanguageBeliefSource = (typeof LANGUAGE_BELIEF_SOURCES)[number];

/**
 * What `09b-deliver-and-log` writes and `02d-load-target-language` reads.
 *
 * Free-form under the beliefs document — no zod schema, no `ClientBriefSchema`
 * bump, no migration. `parseLanguageBelief` is therefore the only reader and
 * tolerates anything a past version or a hand edit left behind.
 */
export interface InstagramLanguageBelief {
  /** The run's adopted target language, verbatim — `"Hebrew"` or `"he-IL"`, whichever the run actually used. */
  language: string;
  /** `"Hebrew"` — from `resolveExpectedScript`, never a second table. Empty when the shared table has no opinion. */
  script: string;
  source: LanguageBeliefSource;
  /** The sentence or the corpus count that decided it, for a trace reader. */
  evidence: string;
  /** How many in-script posts of the client's own were measured. */
  corpusPosts: number;
  /** Which `LANGUAGE_REGISTER_PACKS` row was applied (`language-register.ts`). */
  registerKey: string;
  resolvedAt: string;
}

/**
 * The sources a LATER run may act on.
 *
 * `sniff` is deliberately absent, and that absence is load-bearing. A sniff
 * is an inference from the client's self-description prose; re-reading it as
 * source 3 would make it outrank the very sniff it came from, so a single
 * guess on a thin profile would become this client's permanent language and
 * no amount of new evidence below source 2 could move it. Persisted for
 * observability, never re-read. `__tests__/target-language.test.ts` pins it
 * by deleting the filter and watching the case go green.
 */
export const DECISIVE_BELIEF_SOURCES: ReadonlySet<LanguageBeliefSource> = new Set<LanguageBeliefSource>([
  "own-posts",
  "brand-language",
  "explicit-mention",
  "brief",
]);

/**
 * The belief as it was written, WHATEVER its source — for evidence lines and
 * for `09b` to compare against before it rewrites the key.
 *
 * NEVER call this to decide a run's language: that is `readLanguageBelief`,
 * which applies the decisiveness filter. This one exists so the trace can say
 * "there was a remembered Hebrew and it was not used, because it was a guess".
 */
export function parseLanguageBelief(beliefs: Record<string, unknown> | undefined): InstagramLanguageBelief | undefined {
  const raw = beliefs?.[LANGUAGE_BELIEF_KEY];
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const language = typeof r["language"] === "string" ? r["language"].trim() : "";
  if (language.length === 0) return undefined;
  // An unrecognised source is not "probably fine": it is a record this build
  // cannot reason about, and the safe reading of a language nobody can date
  // is to fall through to the live evidence.
  const source = LANGUAGE_BELIEF_SOURCES.find((s) => s === r["source"]);
  if (source === undefined) return undefined;
  const str = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback);
  const rawCorpus = r["corpusPosts"];
  return {
    language,
    script: str(r["script"], resolveExpectedScript(language)?.name ?? ""),
    source,
    evidence: str(r["evidence"], ""),
    corpusPosts: typeof rawCorpus === "number" && Number.isFinite(rawCorpus) ? Math.max(0, Math.floor(rawCorpus)) : 0,
    registerKey: str(r["registerKey"], ""),
    resolvedAt: str(r["resolvedAt"], ""),
  };
}

/**
 * The belief `resolveTargetLanguage` is allowed to act on: a parsed record
 * whose `source` is in `DECISIVE_BELIEF_SOURCES`. `undefined` for a
 * sniff-sourced entry, for an unparseable one, and for no beliefs at all.
 */
export function readLanguageBelief(beliefs: Record<string, unknown> | undefined): InstagramLanguageBelief | undefined {
  const belief = parseLanguageBelief(beliefs);
  if (belief === undefined) return undefined;
  return DECISIVE_BELIEF_SOURCES.has(belief.source) ? belief : undefined;
}

export interface BuildLanguageBeliefInput {
  /** The run's adopted target language. `undefined`, empty or English returns `undefined`: there is nothing to remember. */
  language: string | undefined;
  source: LanguageBeliefSource;
  evidence: string;
  /** In-script posts of the client's own that were measured; `0` when the corpus was empty. */
  corpusPosts?: number;
  /** `LanguageBrief.conventions.key`, so a trace can say which pack this run's copy was judged against. */
  registerKey?: string;
  /** Injectable clock, for a deterministic `resolvedAt` in tests. */
  now?: Date;
}

/**
 * The record `09b` writes — or `undefined` when there is nothing worth
 * remembering, which the caller must treat as "make no `memory.updateBeliefs`
 * call for this key".
 *
 * Two refusals, both of them the RFC's rules made mechanical rather than
 * hoped for:
 *
 * - **English is never persisted.** `english-default` is a decision with
 *   recorded evidence, not a language; writing it would switch a future run's
 *   source 3 on for a client the gate has nothing to check for.
 * - **`own-posts` with an empty corpus is refused.** `research.socialHistory`
 *   drops textless posts silently and caches the empty result, so "zero posts
 *   came back" is a fact about the scrape, not about the client. A belief
 *   that claims to have measured a corpus of none is exactly the guess this
 *   whole mechanism exists to keep out.
 */
export function buildLanguageBelief(input: BuildLanguageBeliefInput): InstagramLanguageBelief | undefined {
  const language = typeof input.language === "string" ? input.language.trim() : "";
  if (language.length === 0 || isEnglishTarget(language)) return undefined;
  const corpusPosts = Math.max(0, Math.floor(input.corpusPosts ?? 0));
  if (input.source === "own-posts" && corpusPosts < 1) return undefined;
  return {
    language,
    script: resolveExpectedScript(language)?.name ?? "",
    source: input.source,
    evidence: input.evidence.trim(),
    corpusPosts,
    registerKey: (input.registerKey ?? "").trim(),
    resolvedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * The BCP-47 primary subtag for a target language — `"he"` for `"Hebrew"`,
 * `"he-IL"` and `"he"` alike — or `undefined` when the shared table cannot
 * name one honestly.
 *
 * Resolved THROUGH `resolveExpectedScript` and the row it came from, so there
 * is no second table to drift (the discipline `script-fonts.ts` follows for
 * its typography rows). Two cases, and the second is the careful one:
 *
 * 1. The value already IS a tag (`"he-IL"`, `"pt-BR"`, `"es"`): its own
 *    primary subtag is the answer, whatever else the row carries.
 * 2. The value is a NAME. `tags[0]` is only the language's tag when every
 *    name in the row denotes the SAME language — the single-language scripts
 *    and the CJK rows. For a row several languages share, `tags[0]` is
 *    whichever one happens to be listed first: the Latin row's is `"en"`, and
 *    returning it for `"Spanish"` would mark Spanish copy as English in the
 *    `lang` attribute, picking the wrong fallback face and the wrong
 *    hyphenation. `undefined` — no opinion — is the honest answer, and the
 *    caller omits the attribute rather than lying in it. A client who needs
 *    one sets `brand.language` to a tag, which is case 1.
 */
export function bcp47For(targetLanguage: string | undefined): string | undefined {
  if (targetLanguage === undefined) return undefined;
  const normalized = targetLanguage.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const expected = resolveExpectedScript(targetLanguage);
  if (expected === undefined) return undefined;
  const row = scriptTableEntries().find((e) => e.script.name === expected.name);
  if (row === undefined) return undefined;
  const primary = normalized.split(/[-_]/)[0] ?? normalized;
  if (row.tags.includes(primary)) return primary;
  if (SINGLE_LANGUAGE_SCRIPTS.has(row.script.name) || CJK_SCRIPT_NAMES.has(row.script.name)) return row.tags[0];
  return undefined;
}

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
  if (sources.length > 0) evidence.push(`no explicit language statement in ${sources.map((s) => s.label).join(", ")}`);

  // 3. What a previous run settled for this client, if it settled it
  //    DECISIVELY. Above the sniff because it is a measurement rather than an
  //    inference; below both explicit statements so a human editing the
  //    portal always wins.
  const remembered = readLanguageBelief(input.beliefs);
  if (remembered !== undefined) {
    const trail = remembered.evidence.length > 0 ? `: ${remembered.evidence}` : "";
    if (isEnglishTarget(remembered.language)) {
      // `buildLanguageBelief` refuses to write one, so this is a hand edit or
      // an older shape. Same posture as sources 1 and 2: recorded, not gated.
      evidence.push(`a remembered language "${remembered.language}" (${LANGUAGE_BELIEF_KEY}, from ${remembered.source}${trail}), which needs no language gate`);
      return { status: "english-default", evidence };
    }
    evidence.push(`a remembered language "${remembered.language}" (${LANGUAGE_BELIEF_KEY}, from ${remembered.source}${trail})`);
    return { status: "resolved", language: remembered.language, source: "belief", evidence };
  }
  const guessed = parseLanguageBelief(input.beliefs);
  if (guessed !== undefined) {
    evidence.push(
      `a remembered language "${guessed.language}" was NOT re-used: it was recorded from a script sniff, and a once-guessed answer is kept for observability only`,
    );
  }

  if (sources.length === 0) {
    evidence.push("no profile description, voice-rules guidelines/doList or brand-voice document to read");
    return { status: "english-default", evidence };
  }

  // 4. The script the prose itself is written in — the whole of it first
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

  // 5. Nothing pointed anywhere but English.
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

// ─────────────────────────────────────────────────────────────────────────────
// One authoritative language per run
// ─────────────────────────────────────────────────────────────────────────────

/** What the run writes, checks and renders in, after the Client Brief has had its say. */
export interface TargetLanguageAdoption {
  /** The run's target language: `undefined` means English, and no script check, fluency judge or script font stack. */
  language: string | undefined;
  /**
   * How it was decided — `"resolved"` is 02d's answer, `"own-posts"` is the
   * script of the client's own captions, `"brief"` is a brief-declared
   * language 02d could not see, `"english-default"` is none of them.
   */
  source: "resolved" | "own-posts" | "brief" | "english-default";
  /** Present only for `"brief"`: the line the gate payload and the ledger carry, so a reviewer knows why this run is being judged in a language nothing in the brand record mentions. */
  note?: string;
}

/**
 * The run's ONE target language, resolved after the Client Brief is known.
 *
 * `02d-load-target-language` reads the brand record, the profile, the voice
 * rules and the brand-voice document. It does NOT read the client's own site
 * — `00b1` does, and the brief agent is then told to "set the language the
 * sources clearly show they publish in" when the run supplied none
 * (`prompts/instagram-brief/1.md` §9). So a client whose Hebrew is visible
 * only on their own pages used to end up with a brief declaring Hebrew, a
 * copy prompt binding the writer to it (@13 §15: "`language.target`, when
 * present, is the language of every word you write"), and every guard reading
 * the OTHER value: no script check, no fluency judge, and Latin fonts around
 * Hebrew glyphs — the 2026-09-08 audit's defect 5, back through a new door.
 *
 * Precedence, and why:
 * 1. **02d's answer wins.** It is the documented precedence, it is what
 *    `stampAgentBrief` writes into the brief, and a brief cannot outrank the
 *    brand record a human set in the portal.
 * 1b. **Then the client's OWN POSTS** (Phase 4, RFC-15 §2): the script of the
 *    captions `00b1-gather-brief-sources` already fetched, sniffed for free
 *    with `sniffDominantScript`. It sits above the brief because it is a
 *    measurement of what this client actually published, where the brief's
 *    `language.target` is a model's reading of the same sources plus others.
 *    The 2026-09-08 audit's finding is that those posts were fetched on every
 *    run and never once read as a language source.
 * 2. **Otherwise a brief-declared non-English language is adopted** — by the
 *    whole run, not just the writer: the script check, the fluency judge and
 *    the script font stack all see it, because a language worth writing in is
 *    a language worth verifying. Recorded as a note, never silently.
 * 3. **English stays English.** A brief that declares "English" (or "en-US")
 *    resolves to `undefined` exactly as 02d does for English clients: there
 *    is nothing for a script check to verify, and switching the fail-closed
 *    fluency gate on for English copy would add a per-attempt Haiku call and
 *    an outage hold path the brief scoped to non-English targets.
 */
export interface LateTargetLanguageSources {
  /**
   * The language `sniffDominantScript` names over the client's own post
   * captions (`00b1`'s `ownPosts`, or `crossChannel.entries` with
   * `origin: "social"`), as a display name — `"Hebrew"`. `undefined` when the
   * corpus was empty, too short, or in a script that names no single language.
   *
   * Deliberately a value the CALLER computes: this module stays pure and the
   * caller already holds the captions.
   */
  ownPostsLanguage?: unknown;
  /** `brief.language.target`. */
  briefLanguage?: unknown;
}

/**
 * The run's ONE target language, resolved after the Client Brief is known.
 * See `TargetLanguageAdoption`'s doc comment for the precedence and the why.
 */
export function adoptLateTargetLanguage(resolved: string | undefined, sources: LateTargetLanguageSources): TargetLanguageAdoption {
  if (resolved !== undefined) return { language: resolved, source: "resolved" };

  const own = typeof sources.ownPostsLanguage === "string" ? sources.ownPostsLanguage.trim() : "";
  if (own.length > 0 && !isEnglishTarget(own)) {
    return {
      language: own,
      source: "own-posts",
      note:
        `target language ${own} comes from the client's OWN recent posts, not from the brand record: 02d resolved none, and their captions are written in ${own}. ` +
        `The copy is written, script-checked, natively judged and rendered in ${own} — set brand.language in the portal to make it explicit.`,
    };
  }

  const declared = typeof sources.briefLanguage === "string" ? sources.briefLanguage.trim() : "";
  if (declared.length === 0 || isEnglishTarget(declared)) return { language: undefined, source: "english-default" };
  return {
    language: declared,
    source: "brief",
    note:
      `target language ${declared} comes from the client brief, not from the brand record: 02d resolved none, and the brief was written from sources 02d does not read ` +
      `(the client's own site and recent posts). The copy is written, script-checked, fluency-judged and rendered in ${declared} — set brand.language in the portal to make it explicit.`,
  };
}

/**
 * The pre-Phase-4 two-argument form, kept exported so no existing caller
 * breaks. A thin wrapper: identical behaviour, because a caller that supplies
 * no own-posts language falls straight through to the brief branch.
 */
export function adoptBriefTargetLanguage(resolved: string | undefined, briefTarget: unknown): TargetLanguageAdoption {
  return adoptLateTargetLanguage(resolved, { briefLanguage: briefTarget });
}
