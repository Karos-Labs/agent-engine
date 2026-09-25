/**
 * READABLE COPY — the owner feedback round of 2026-09-24 (item C, WS-10).
 *
 * The owner: "complete human sentences", and the audit behind #253 found the
 * copy prompts rewarding one habit above all: "X is not Y. It is Z." and
 * verbless fragments. Shipped examples, each a fixture in the test file:
 * "Not sentiment. A specific act of memory." / "No scope. No autonomy level.
 * No named supervisor." / "Wrapped is not Spotify's best campaign. It is
 * Spotify's best data decision." / "O teto nao era de capacidade. Era de regra."
 *
 * $0 and deterministic, like `07b`'s craft lint: the rules read the words a
 * slide carries and name what to rewrite. A finding sends the draft back on
 * attempts 1..n-1 and is recorded on the final attempt (agents always
 * deliver). It never edits prose itself.
 */

export type ReadableCopyRule = "fragment-opener" | "not-x-it-is-y" | "not-tails" | "staccato" | "closer-length" | "repeated-sentence" | "figure-repeated";

export interface ReadableCopyFinding {
  rule: ReadableCopyRule;
  slide: number;
  text: string;
  fix: string;
}

interface SlideLike {
  n: number;
  headline: string;
  body: string;
  layout?: string | undefined;
  stat?: { figure?: string | undefined } | undefined;
}

/** DISPLAY figures a reader would notice repeated (the headline and the stat, not the body): numbers with a unit or of 3+ digits, never a bare year. */
function figuresOf(slide: SlideLike): Set<string> {
  const text = `${slide.headline} ${slide.stat?.figure ?? ""}`;
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\d])(\d[\d,.]*)\s?(%|x|k|m|bn|million|billion)?(?![\p{L}\d])/giu)) {
    const digits = m[1]!.replace(/[,.]$/u, "");
    const unit = (m[2] ?? "").toLowerCase();
    if (/^(?:19|20)\d\d$/u.test(digits) && unit === "") continue;
    if (unit === "" && digits.replace(/\D/gu, "").length < 3) continue;
    out.add(`${digits.replace(/,/gu, "")}${unit}`);
  }
  return out;
}

/** Sentences, split on terminal punctuation. Keeps the punctuation off; drops empties. */
export function sentencesIn(text: string): string[] {
  return text
    .replace(/\s+/gu, " ")
    .split(/(?<=[.!?؟。])\s+/u)
    .map((s) => s.trim().replace(/[.!?؟。]+$/u, "").trim())
    .filter((s) => s.length > 0);
}

const words = (s: string): string[] => s.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** A negation that opens a sentence: English, Portuguese (with and without the tilde), Spanish, Hebrew. */
const NEGATION_OPENER = /^(?:not|no|never|não|nao|nunca|ni|לא|אין)(?=[\s,]|$)/iu;
/** "is not / isn't / was not / aren't / não é / não era / לא היה" inside a sentence. */
const NEGATED_COPULA = /\b(?:is not|isn't|are not|aren't|was not|wasn't|were not|weren't)\b|\bn[aã]o (?:é|era|são|foi|eram)\b|לא (?:היה|היתה|הייתה|היו|הוא|היא)/iu;
/** The reveal that follows it: "It is / That's / This was / They are / É / Era / זה". */
const REVEAL_OPENER = /^(?:(?:it|that|this|they)(?:'s|'re| is| are| was| were)\b|(?:é|era|são|foi)\b|זה\b|זו\b)/iu;

/**
 * Findings for one post. `closerN` is the closer slide's number, when there is
 * one; the closer's own length rule reads only that slide.
 */
export function lintReadableCopy(slides: readonly SlideLike[], closerN?: number): ReadableCopyFinding[] {
  const findings: ReadableCopyFinding[] = [];
  const seen = new Map<string, number>();
  let notTails = 0;
  let firstTail: { slide: number; text: string } | undefined;

  for (const slide of slides) {
    for (const field of [slide.headline, slide.body]) {
      const sentences = sentencesIn(field);
      sentences.forEach((sentence, i) => {
        const w = words(sentence);
        // L1: a verbless negation fragment ("Not sentiment." / "No scope.").
        if (NEGATION_OPENER.test(sentence) && w.length <= 7) {
          findings.push({ rule: "fragment-opener", slide: slide.n, text: sentence, fix: "say what IS true, as a full sentence with a subject and a verb" });
        }
        // L2: "X is not Y. It is Z."
        const next = sentences[i + 1];
        if (next !== undefined && NEGATED_COPULA.test(sentence) && REVEAL_OPENER.test(next)) {
          findings.push({ rule: "not-x-it-is-y", slide: slide.n, text: `${sentence}. ${next}.`, fix: "state the claim directly in one positive sentence; drop the denial" });
        }
        // L3: ", not X" tails, counted across the post.
        if (/,\s*(?:not|não|nao|לא)\s+\p{L}/iu.test(sentence)) {
          notTails += 1;
          firstTail ??= { slide: slide.n, text: sentence };
        }
        // L6: the same sentence on two slides.
        const key = w.map((x) => x.toLowerCase()).join(" ");
        if (w.length >= 4) {
          const other = seen.get(key);
          if (other !== undefined && other !== slide.n) {
            findings.push({ rule: "repeated-sentence", slide: slide.n, text: sentence, fix: `slide ${other} already says this; give this slide its own point` });
          } else {
            seen.set(key, slide.n);
          }
        }
      });
      // L4: three short sentences in a row read as a list of fragments.
      for (let i = 0; i + 2 < sentences.length; i++) {
        const run = sentences.slice(i, i + 3);
        if (run.every((s) => words(s).length <= 4)) {
          findings.push({ rule: "staccato", slide: slide.n, text: run.join(". "), fix: "join them into one or two complete sentences" });
          break;
        }
      }
    }
    // L5: the closer asks one question and stays short.
    if (closerN !== undefined && slide.n === closerN) {
      const total = words(`${slide.headline} ${slide.body}`).length;
      const questions = sentencesIn(`${slide.headline} ${slide.body}`).length;
      if (total > 30 || (/[?؟]/u.test(slide.body) && sentencesIn(slide.body).length > 1)) {
        findings.push({ rule: "closer-length", slide: slide.n, text: `${slide.headline} ${slide.body}`.slice(0, 160), fix: `end on ONE short question or line (it has ${total} words in ${questions} sentences)` });
      }
    }
  }
  // L7: one figure on three or more slides. Hanky Panky's "233" was the
  // headline of slides 1, 3 and 4 and the closer's recap (prep 2026-09-25):
  // a number a reader sees three times stops being news. (#253 WS-09: a figure
  // on at most two plates.)
  const figureSlides = new Map<string, number[]>();
  for (const slide of slides) for (const f of figuresOf(slide)) figureSlides.set(f, [...(figureSlides.get(f) ?? []), slide.n]);
  for (const [figure, ns] of figureSlides) {
    const interior = ns.filter((n) => n !== closerN);
    if (interior.length >= 3) findings.push({ rule: "figure-repeated", slide: interior[2]!, text: figure, fix: `${figure} is on slides ${interior.join(", ")}; keep it on at most two and give the others their own point` });
  }
  if (notTails >= 2 && firstTail !== undefined) {
    findings.push({ rule: "not-tails", slide: firstTail.slide, text: firstTail.text, fix: `${notTails} sentences end on ", not X"; keep at most one` });
  }
  return findings;
}

/** The redraft instruction: every finding at once, so the reviser fixes them in one pass. */
export function readableCopySteer(findings: readonly ReadableCopyFinding[]): string {
  return (
    "READABLE COPY: write complete sentences a person would say, and say what is true rather than what it is not. Rewrite each of these: " +
    findings
      .slice(0, 8)
      .map((f) => `slide ${f.slide} "${f.text.slice(0, 120)}" (${f.fix})`)
      .join("; ")
  );
}
