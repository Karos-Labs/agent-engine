/**
 * Captions for an original short, built from the SCRIPT and timed by the
 * voiceover's transcript (2026-09-09).
 *
 * The 2026-09-08 renders burned whatever ElevenLabs Scribe heard back off the
 * synthesized voice: "Kairoslabs.com" for karoslabs.com, "a Sixteen Z" for
 * a16z, and four-word cues cut wherever the count landed ("with. In a",
 * "and fewer to"). The words a viewer READS came from a speech recognizer
 * guessing at words we had written ourselves a step earlier.
 *
 * So: the script's own words are the text, the transcript is only the clock.
 * `alignScriptToTimings` walks both word lists together, matching on a
 * normalized form and skipping recognizer insertions/deletions with a small
 * lookahead; a script word the recognizer never produced borrows the time
 * between its aligned neighbours. `buildPhraseCues` then groups the timed
 * words into cues that end where a phrase ends (sentence punctuation, a
 * comma, or a cap), never mid-clause because a counter ran out.
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

/** Words as spoken, in order: the script's beats joined, tokenized on whitespace with punctuation kept on the word. */
export function scriptWords(narrations: readonly string[]): string[] {
  return narrations
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .join(" ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Lower-cased, punctuation- and diacritic-stripped form both sides are compared on. Digits kept: "0.05%" and "0.05" should still meet. */
export function normalizeToken(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** How many recognizer words may be skipped to find the next script word before the script word is declared unheard. */
const LOOKAHEAD = 3;

/**
 * Pairs each script word with a time from the recognizer's word list.
 *
 * Exact-normalized matches anchor; a script word with no match within
 * `LOOKAHEAD` recognizer words is interpolated between the previous anchor's
 * end and the next anchor's start (or given a proportional slice at the
 * edges). A recognizer word with no script counterpart is dropped: it is
 * either a mis-hearing of a word we already placed or a spacing token.
 *
 * Returns the script's words, every one timed, monotonic and non-overlapping.
 * With an empty recognizer list, spreads the words evenly over `fallbackSeconds`.
 */
export function alignScriptToTimings(script: readonly string[], heard: readonly TimedWord[], fallbackSeconds?: number): TimedWord[] {
  if (script.length === 0) return [];
  const spoken = heard.filter((w) => normalizeToken(w.text).length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  if (spoken.length === 0) {
    const total = fallbackSeconds !== undefined && fallbackSeconds > 0 ? fallbackSeconds : script.length * 0.4;
    const per = total / script.length;
    return script.map((text, i) => ({ text, start: i * per, end: Math.max(i * per + 0.05, (i + 1) * per - 0.02) }));
  }

  // Pass 1: anchors.
  const anchored: Array<TimedWord | undefined> = new Array(script.length).fill(undefined);
  let h = 0;
  for (let s = 0; s < script.length; s++) {
    const want = normalizeToken(script[s]!);
    if (want.length === 0) continue;
    let found = -1;
    for (let k = h; k < Math.min(spoken.length, h + LOOKAHEAD + 1); k++) {
      const got = normalizeToken(spoken[k]!.text);
      if (got === want || (want.length >= 4 && (got.startsWith(want) || want.startsWith(got)) && Math.abs(got.length - want.length) <= 2)) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      anchored[s] = { text: script[s]!, start: spoken[found]!.start, end: spoken[found]!.end };
      h = found + 1;
    }
  }

  // Pass 2: interpolate the unheard words between their anchored neighbours.
  const firstStart = spoken[0]!.start;
  const lastEnd = spoken[spoken.length - 1]!.end;
  const out: TimedWord[] = [];
  let i = 0;
  while (i < script.length) {
    if (anchored[i] !== undefined) {
      out.push(anchored[i]!);
      i += 1;
      continue;
    }
    let j = i;
    while (j < script.length && anchored[j] === undefined) j += 1;
    const gapStart = i === 0 ? firstStart : out[out.length - 1]!.end;
    const gapEnd = j < script.length ? anchored[j]!.start : lastEnd;
    const count = j - i;
    const span = Math.max(gapEnd - gapStart, 0.12 * count);
    const per = span / count;
    for (let k = 0; k < count; k++) {
      const start = gapStart + k * per;
      out.push({ text: script[i + k]!, start, end: Math.max(start + 0.05, start + per - 0.02) });
    }
    i = j;
  }

  // Monotonic, non-overlapping.
  for (let k = 1; k < out.length; k++) {
    const prev = out[k - 1]!;
    const cur = out[k]!;
    if (cur.start < prev.end) cur.start = prev.end;
    if (cur.end < cur.start + 0.05) cur.end = cur.start + 0.05;
  }
  return out;
}

export interface PhraseCueOptions {
  /** Hard cap on words per cue. Default 4: two short lines at a phone's caption size. */
  maxWords?: number;
  /** A cue ends at a comma/semicolon/colon once it holds at least this many words. Default 3. */
  breakAtCommaFrom?: number;
  /** Minimum on-screen time per cue, so a two-word cue does not strobe. Default 0.6s. */
  minSeconds?: number;
}

const SENTENCE_END = /[.!?…]["')\]]?$/u;
const CLAUSE_END = /[,;:]["')\]]?$/u;

/**
 * Groups timed words into caption cues that end where speech ends: a
 * sentence boundary always closes a cue, a clause boundary closes one once it
 * has a few words, and `maxWords` closes one regardless. Cue text keeps the
 * script's spelling and punctuation; cue end is stretched to `minSeconds` and
 * never past the next cue's start.
 */
export function buildPhraseCues(words: readonly TimedWord[], options: PhraseCueOptions = {}): CaptionCue[] {
  return buildPhraseGroups(words, options).map((g) => ({ text: g.words.map((w) => w.text).join(" "), start: g.words[0]!.start, end: g.end }));
}

/** A phrase cue that still knows its words — what the word-highlight captions are built from (2026-09-15). */
export interface PhraseGroup {
  words: TimedWord[];
  /** When the phrase leaves the screen: the last word's end, stretched to `minSeconds`, never past the next phrase's start. */
  end: number;
}

/**
 * The grouping behind `buildPhraseCues`, with the words kept: the same
 * boundaries (sentence end, clause end from `breakAtCommaFrom`, `maxWords`)
 * and the same end-stretching, so a karaoke script and an SRT built from
 * the same voice show the same phrases at the same moments.
 */
export function buildPhraseGroups(words: readonly TimedWord[], options: PhraseCueOptions = {}): PhraseGroup[] {
  const maxWords = options.maxWords ?? 4;
  const commaFrom = options.breakAtCommaFrom ?? 3;
  const minSeconds = options.minSeconds ?? 0.6;
  const groups: PhraseGroup[] = [];
  let group: TimedWord[] = [];
  const flush = () => {
    if (group.length === 0) return;
    groups.push({ words: group.map((w) => ({ ...w })), end: group[group.length - 1]!.end });
    group = [];
  };
  for (const word of words) {
    group.push(word);
    if (SENTENCE_END.test(word.text) || group.length >= maxWords || (group.length >= commaFrom && CLAUSE_END.test(word.text))) flush();
  }
  flush();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const next = groups[i + 1];
    const start = g.words[0]!.start;
    const wanted = Math.max(g.end, start + minSeconds);
    g.end = next ? Math.min(wanted, next.words[0]!.start - 0.02) : wanted;
    if (g.end < start + 0.05) g.end = start + 0.05;
  }
  return groups;
}

/**
 * Where each beat's picture should change, read off the voice (2026-09-15).
 *
 * The render used to hold each plate for `(beat's words / all words) x the
 * voice's length`: a guess at where the voice would be, and it was wrong
 * by up to a second on every beat, so the picture cut mid-sentence or hung
 * on after the line had ended. The same alignment that times the captions
 * knows exactly when beat N's last word ends and beat N+1's first word
 * starts; the cut belongs in the silence between them.
 *
 * Returns one hold per beat, in seconds, summing to `totalSeconds` (the
 * voice plus its tail). Each boundary is the midpoint of the gap between the
 * last word of one beat and the first of the next, so a breath is shared
 * rather than glued to either side. Every hold is at least `minHold`; when
 * one would be shorter, the shortfall is taken from its longer neighbours.
 *
 * `wordsPerBeat` says how many of `timed` belong to each beat, in order; the
 * counts must sum to `timed.length`. With no timed words at all (or a count
 * mismatch) the scripted seconds are returned scaled to `totalSeconds`, the
 * old behaviour, so a run without word timings renders exactly as before.
 */
export function beatHoldsFromTimings(
  timed: readonly TimedWord[],
  wordsPerBeat: readonly number[],
  totalSeconds: number,
  fallbackSeconds: readonly number[],
  minHold = 2,
): number[] {
  const n = wordsPerBeat.length;
  const scaled = (): number[] => {
    const sum = fallbackSeconds.reduce((a, b) => a + b, 0);
    return sum > 0 ? fallbackSeconds.map((s) => (s / sum) * totalSeconds) : fallbackSeconds.map(() => totalSeconds / Math.max(1, n));
  };
  if (n === 0) return [];
  if (timed.length === 0 || wordsPerBeat.reduce((a, b) => a + b, 0) !== timed.length || wordsPerBeat.some((c) => c < 1)) return scaled();

  // Boundaries between beats: midpoint of the gap after each beat's last word.
  const boundaries: number[] = [];
  let index = 0;
  for (let b = 0; b < n - 1; b++) {
    index += wordsPerBeat[b]!;
    const lastOfBeat = timed[index - 1]!;
    const firstOfNext = timed[index]!;
    const gapStart = lastOfBeat.end;
    const gapEnd = Math.max(firstOfNext.start, gapStart);
    boundaries.push(gapStart + (gapEnd - gapStart) / 2);
  }
  const edges = [0, ...boundaries, totalSeconds];
  const holds = edges.slice(1).map((e, i) => e - edges[i]!);

  // Floor every hold at `minHold`, paying for it out of the longest holds,
  // so the total (the voice's length) never changes.
  for (let pass = 0; pass < n; pass++) {
    const short = holds.findIndex((h) => h < minHold - 1e-9);
    if (short < 0) break;
    let need = minHold - holds[short]!;
    holds[short] = minHold;
    const donors = holds
      .map((h, i) => ({ h, i }))
      .filter(({ i, h }) => i !== short && h > minHold)
      .sort((a, b) => b.h - a.h);
    for (const d of donors) {
      if (need <= 0) break;
      const give = Math.min(need, holds[d.i]! - minHold);
      holds[d.i] = holds[d.i]! - give;
      need -= give;
    }
    if (need > 1e-9) return scaled(); // the voice is too short for this many beats at this floor; the old rule stands
  }
  return holds.map((h) => Number(h.toFixed(3)));
}

function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Cues → SRT text, the format `video.brandFrame` burns. */
export function cuesToSrt(cues: readonly CaptionCue[]): string {
  const blocks = cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text.trim()}`);
  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

/**
 * The whole path in one call: script narration + the voice's heard words →
 * SRT with the script's spelling, phrase-bounded. `fallbackSeconds` is the
 * voice file's duration, used only when no words were heard.
 */
export function buildScriptCaptions(narrations: readonly string[], heard: readonly TimedWord[], fallbackSeconds?: number, options?: PhraseCueOptions): string {
  return cuesToSrt(buildPhraseCues(alignScriptToTimings(scriptWords(narrations), heard, fallbackSeconds), options));
}
