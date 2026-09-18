import { checkExpectedScript, resolveExpectedScript, scriptTableEntries, type ScriptCheck } from "@agent-engine/workflow";

/**
 * What language this short is in, decided once, by code.
 *
 * ## The defect this replaces
 *
 * Until 2026-09-18 the answer was a `??` chain repeated at four call sites —
 * `config.voiceLanguage ?? videoBrand.language ?? script.language` — and the
 * last term is the MODEL'S OWN declaration of what it happened to write in.
 * So for a client who had configured neither field, the writer picked the
 * language, nobody checked whether the words that came back were in the
 * language it picked, and the caption font, the voice and the QA model's
 * expectations were each resolved separately from the same ambiguous chain.
 *
 * Karos Labs' client base is largely Hebrew-speaking. For those clients the
 * difference between a native short and a translated-sounding one is the
 * whole product, and the difference between Hebrew and English is not a
 * nuance — it is a deliverable nobody can post.
 *
 * ## What this does, and what it deliberately does not
 *
 * It RESOLVES (one tag, one recorded reason, one source of truth) and it
 * CHECKS THE WRITING SYSTEM (`checkExpectedScript`, shared with
 * instagram-agent). It does not judge fluency, register or translationese —
 * instagram has a model-graded native editor for that, and inventing a
 * heuristic one here would be a phrase matcher pretending to be a judge.
 *
 * The limit is stated rather than hidden: a French draft for a German client
 * is Latin either way and passes. What cannot pass is the failure that
 * actually happens — an entirely English short for a Hebrew client.
 */

/** Where the run's language came from. Carried to the reviewer, because "we defaulted" and "the client said so" are different facts. */
export type TargetLanguageSource = "client-config" | "brand-kit" | "client-prose" | "default";

export interface ResolvedTargetLanguage {
  /** The tag everything downstream uses: the voice, the captions, the fonts, the QA model's expectations. */
  tag: string;
  source: TargetLanguageSource;
  /** One line a reviewer reads. */
  reason: string;
  /** True when nothing in the client's configuration named a language and this is an assumption. */
  assumed: boolean;
}

/** What a run falls back to when nothing anywhere names a language. */
export const DEFAULT_TARGET_LANGUAGE = "en-US";

/**
 * Scripts that name exactly ONE language, so seeing them in a client's own
 * prose is evidence rather than a guess.
 *
 * Latin is not here for the obvious reason, and neither are Arabic (Arabic /
 * Farsi / Urdu), Cyrillic (six languages) or the CJK family (Han alone could
 * be Chinese or a Japanese headline). Reading Hebrew letters and concluding
 * "Hebrew" is sound; reading Cyrillic and concluding "Russian" is a coin
 * toss with a Ukrainian client's name on it.
 *
 * Narrower than instagram-agent's `sniffDominantScript`, on purpose: that one
 * resolves ambiguous scripts through persisted beliefs, explicit mentions and
 * the client's own published posts, and it earned every one of those from a
 * specific incident. This agent has none of that machinery, so it claims only
 * what a single unambiguous script proves.
 */
const SINGLE_LANGUAGE_SCRIPTS: ReadonlySet<string> = new Set(["Hebrew", "Greek", "Thai", "Armenian", "Georgian"]);

/** Enough letters of the client's own prose to be evidence of anything. */
export const MIN_PROSE_LETTERS = 40;

/** The share of prose letters that must sit in one script before it names the language. */
export const MIN_PROSE_SHARE = 0.5;

/** The BCP-47 primary subtag for one of `SINGLE_LANGUAGE_SCRIPTS`, read off the shared table so the two can never disagree. */
function tagForScript(scriptName: string): string | undefined {
  return scriptTableEntries().find((row) => row.script.name === scriptName)?.tags[0];
}

/**
 * The language the client's OWN prose is written in, when one unambiguous
 * script dominates it. `undefined` is the normal answer and means "no
 * opinion", never "English".
 *
 * Exported for the test.
 */
export function languageFromClientProse(prose: string): { tag: string; script: string; share: number } | undefined {
  const letters = prose.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_PROSE_LETTERS) return undefined;

  for (const scriptName of SINGLE_LANGUAGE_SCRIPTS) {
    const entry = scriptTableEntries().find((row) => row.script.name === scriptName);
    if (entry === undefined) continue;
    const hits = letters.filter((ch) => entry.script.test.test(ch)).length;
    const share = hits / letters.length;
    if (share >= MIN_PROSE_SHARE) {
      const tag = tagForScript(scriptName);
      if (tag !== undefined) return { tag, script: scriptName, share };
    }
  }
  return undefined;
}

export interface TargetLanguageInput {
  /** `tiktokClips.voiceLanguage` — someone configured this product's language by hand. */
  configuredLanguage?: string | undefined;
  /** The brand kit's declared content language. */
  brandLanguage?: string | undefined;
  /** The client's own words about themselves: the profile description, their distilled intel context. */
  clientProse?: string | undefined;
}

/**
 * The run's language, in precedence order, with the reason recorded.
 *
 * 1. **The client's `voiceLanguage`.** Somebody set this field on this product
 *    deliberately; nothing outranks a stated decision.
 * 2. **The brand kit's `language`.** The client's declared content language,
 *    the same field the six copy channels read.
 * 3. **The client's own prose**, when one unambiguous script dominates it.
 *    A Hebrew client whose config nobody filled in still gets a Hebrew short.
 * 4. **`DEFAULT_TARGET_LANGUAGE`**, marked `assumed` so the reviewer sees an
 *    assumption rather than a decision.
 *
 * The model's own `script.language` is deliberately NOT in this list. It is
 * the writer telling us what it chose to write, which is the thing being
 * checked — reading it back as the target is how a draft in the wrong
 * language marks its own homework.
 */
export function resolveTargetLanguage(input: TargetLanguageInput): ResolvedTargetLanguage {
  const configured = input.configuredLanguage?.trim();
  if (configured !== undefined && configured.length > 0) {
    return { tag: configured, source: "client-config", reason: `the client's tiktokClips.voiceLanguage is "${configured}"`, assumed: false };
  }

  const brand = input.brandLanguage?.trim();
  if (brand !== undefined && brand.length > 0) {
    return { tag: brand, source: "brand-kit", reason: `the brand kit's content language is "${brand}"`, assumed: false };
  }

  const sniffed = input.clientProse !== undefined ? languageFromClientProse(input.clientProse) : undefined;
  if (sniffed !== undefined) {
    return {
      tag: sniffed.tag,
      source: "client-prose",
      reason:
        `nothing configured a language, but ${Math.round(sniffed.share * 100)}% of the client's own prose is written in ` +
        `${sniffed.script}, which names exactly one language`,
      assumed: false,
    };
  }

  return {
    tag: DEFAULT_TARGET_LANGUAGE,
    source: "default",
    reason:
      `no language is configured on this client (tiktokClips.voiceLanguage, the brand kit's language) and their own prose ` +
      `does not settle it, so this short assumes ${DEFAULT_TARGET_LANGUAGE}`,
    assumed: true,
  };
}

/**
 * Whether a draft is written in the script the resolved language requires.
 *
 * A thin wrapper over the shared check, named for what it is used for here, so
 * a caller reads the intent without having to know that "script" means
 * writing system rather than the thing the writer wrote.
 */
export function checkDraftLanguage(text: string, resolved: ResolvedTargetLanguage): ScriptCheck {
  return checkExpectedScript(text, resolved.tag);
}

/** Whether this language's writing system is one the check can actually judge — false means every draft passes, whatever it says. */
export function isJudgeableLanguage(tag: string): boolean {
  return resolveExpectedScript(tag) !== undefined;
}

/**
 * What the writer is told, when a first draft came back in the wrong script.
 *
 * Names the language and the evidence rather than saying "write in Hebrew"
 * alone: a model that has just produced 300 English words has demonstrably
 * not understood the instruction it already had, and repeating that
 * instruction verbatim is the least informative thing to send back.
 */
export function languageRedraftDirective(resolved: ResolvedTargetLanguage, failure: string): string {
  return (
    `Your last draft was not in this client's language. ${failure} ` +
    `Every word a viewer hears or reads — the hook, each beat's narration, each beat's on-screen text, and the caption — ` +
    `must be written in ${resolved.tag} (${resolved.reason}). ` +
    `Keep the idea and the structure; write them again in ${resolved.tag}. ` +
    `Product names, and only product names, may stay in their own alphabet.`
  );
}
