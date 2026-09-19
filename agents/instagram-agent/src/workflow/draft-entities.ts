/**
 * The recognisable names the DRAFT says, which nothing was reading.
 *
 * ## The gap
 *
 * `04b3-extract-entities` runs BEFORE the copy step and reads the topic, the
 * angle and the research fact cards. It is a good extractor and it is looking
 * in the wrong place for this: a name the WRITER introduced is invisible to
 * it, because the writer had not written yet.
 *
 * The Karos carousel of 2026-09-19 is the case. Slide 4's first item read *"A
 * buyer hears your name from ChatGPT. No click is logged."* ChatGPT is on the
 * plate, in the post's own words, and no step ever asked for a picture of it.
 * The owner: *"the example of the post that says CHATGPT is a classic one to
 * put Sam Altman, who is identified with them, or their logo."*
 *
 * The same post's Geektime sibling proves the machinery works when the chain
 * lines up: its cover carries a real LinkedIn logo, sourced from a press tier,
 * because LinkedIn was the whole topic and therefore reached `04b3`. What was
 * missing is the case where the name arrives later and smaller.
 *
 * ## Why a Latin proper-noun scan, in a Hebrew post
 *
 * That is exactly where it is strongest. Hebrew prose that says `ChatGPT`
 * writes it in Latin script, mid-sentence, in mixed case, inside a
 * right-to-left paragraph. There is no more unambiguous signal of a foreign
 * proper noun anywhere in this codebase, and it needs no lexicon to catch a
 * brand nobody has listed yet.
 *
 * `concept-direction.ts` already has the reader (`latinProperNouns`, private)
 * and the grounding discipline. This is the same idea pointed at the draft,
 * with the draft itself as the grounding source: the name is on the plate,
 * verbatim, which is a stronger warrant than a fact card gives.
 *
 * ## What it does NOT do
 *
 * It does not decide that a name is a company rather than a person, and it
 * does not guess a domain. Both are jobs for the sourcing tier, which already
 * refuses to guess (`officialDomain` is never invented). This answers one
 * question: **which recognisable things does this post say, and on which
 * slide.**
 */

import type { InstagramCopyOutput, InstagramSlideCopy } from "./types.js";

/**
 * Words that are capitalised mid-sentence and are not a thing a picture can
 * be of.
 *
 * Deliberately short. A long list is a list that rots; the cost of a false
 * positive here is one sourcing query that finds nothing, and the cost of a
 * false negative is the defect this module exists for.
 */
const NOT_AN_ENTITY = new Set([
  "ai", "api", "b2b", "b2c", "ceo", "cfo", "cmo", "coo", "cto", "eu", "faq", "gdpr", "hr", "it", "kpi", "mta", "okr", "pr", "qa", "roi",
  "saas", "seo", "geo", "ui", "ux", "us", "usa", "uk", "vp", "crm", "cms", "sdk", "llm", "gpu", "cpu", "url", "pdf", "csv", "html", "css",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "q1", "q2", "q3", "q4", "h1", "h2",
]);

export interface DraftEntity {
  /** As the draft writes it, so a sourcing query can use the post's own spelling. */
  readonly name: string;
  /** Which slides say it, in carousel order. */
  readonly slides: number[];
  /** How many times the draft says it. A name said once in a note is weaker than one in a headline. */
  readonly mentions: number;
  /** True when it appears in a HEADLINE, which is the strongest placement a name gets. */
  readonly inHeadline: boolean;
}

/** Every string on a slide that a reader sees. */
function slideText(slide: InstagramSlideCopy): Array<{ text: string; isHeadline: boolean }> {
  const out: Array<{ text: string; isHeadline: boolean }> = [
    { text: slide.headline ?? "", isHeadline: true },
    { text: slide.body ?? "", isHeadline: false },
  ];
  for (const item of slide.items ?? []) {
    out.push({ text: item.title ?? "", isHeadline: false });
    if (item.note !== undefined) out.push({ text: item.note, isHeadline: false });
  }
  if (slide.stat !== undefined) out.push({ text: slide.stat.subLabel, isHeadline: false });
  if (slide.quote !== undefined) out.push({ text: slide.quote.text, isHeadline: false });
  return out.filter((part) => part.text.trim().length > 0);
}

/**
 * Latin proper nouns in one string, skipping the first word of each sentence.
 *
 * The first-word skip is the whole reason this is not a capitalisation
 * counter: "Buyers open their window" would otherwise contribute "Buyers".
 * A run of up to three capitalised words is kept together so `Sam Altman` and
 * `Google Cloud Platform` survive as one name.
 */
function latinNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?;:\n]+/u)) {
    const words = sentence.trim().split(/\s+/u).filter((w) => w.length > 0);
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        const phrase = run.slice(0, 3).join(" ").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim();
        if (phrase.length >= 3 && !NOT_AN_ENTITY.has(phrase.toLowerCase())) out.push(phrase);
        run = [];
      }
    };
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const letters = word.replace(/[^\p{L}\p{N}]/gu, "");
      const first = [...letters][0];
      // Latin script only, and a cased first letter. In a Hebrew paragraph
      // that IS the signal: Hebrew has no case, so a capitalised Latin token
      // mid-sentence is a foreign proper noun and nothing else.
      const cased = first !== undefined && first.toLowerCase() !== first.toUpperCase();
      const capitalised = letters.length >= 2 && cased && first === first.toUpperCase();
      // `i > 0` skips the sentence's first word. A name that ONLY ever opens a
      // sentence is not lost: it is almost always said again elsewhere, and a
      // name said once at the start of one sentence is the weakest case there
      // is.
      if (i > 0 && capitalised && !NOT_AN_ENTITY.has(letters.toLowerCase())) run.push(word);
      else flush();
    }
    flush();
  }
  return out;
}

/**
 * The recognisable things this draft names, strongest first.
 *
 * `exclude` is the client's own names. A post about Karos Labs saying "Karos"
 * is not naming a third party a reader recognises from elsewhere, and putting
 * the client's own logo on their own post is a different feature.
 */
export function entitiesInDraft(copy: InstagramCopyOutput, exclude: readonly string[] = []): DraftEntity[] {
  const skip = new Set(exclude.flatMap((name) => name.toLowerCase().split(/\s+/u)).filter((w) => w.length > 1));
  const byKey = new Map<string, { name: string; slides: Set<number>; mentions: number; inHeadline: boolean }>();

  for (const slide of copy.slides) {
    for (const part of slideText(slide)) {
      for (const name of latinNamesIn(part.text)) {
        const key = name.toLowerCase();
        if (skip.has(key) || key.split(/\s+/u).every((w) => skip.has(w))) continue;
        const row = byKey.get(key) ?? { name, slides: new Set<number>(), mentions: 0, inHeadline: false };
        row.slides.add(slide.n);
        row.mentions += 1;
        row.inHeadline = row.inHeadline || part.isHeadline;
        byKey.set(key, row);
      }
    }
  }

  return [...byKey.values()]
    .map((row) => ({ name: row.name, slides: [...row.slides].sort((a, b) => a - b), mentions: row.mentions, inHeadline: row.inHeadline }))
    .sort((a, b) => Number(b.inHeadline) - Number(a.inHeadline) || b.mentions - a.mentions || a.slides[0]! - b.slides[0]!);
}

/**
 * The picture brief for a slide that names a recognisable thing.
 *
 * Three shapes, and the choice is not stylistic. A LOGO is what a reader
 * recognises at a glance and what a press kit actually publishes; a PRODUCT
 * SURFACE is what a post about using the thing is about; a PUBLIC FIGURE is
 * what a post about a company's decisions is about, and is the owner's own
 * example (*"a classic one to put Sam Altman, who is identified with them"*).
 *
 * The brief names the entity and lets the sourcing tiers decide which of the
 * three they can actually find, which is the same division of labour the
 * press-kit tier already uses: this says WHAT, the tier says WHETHER.
 */
export function entityPictureBrief(entity: DraftEntity): string {
  return (
    `${entity.name}: the brand's own mark, a real product surface, or a press photograph of the person most identified with it. ` +
    `A recognisable picture of ${entity.name} itself, not a generic scene about the category it is in.`
  );
}
