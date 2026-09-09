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
  const maxWords = options.maxWords ?? 4;
  const commaFrom = options.breakAtCommaFrom ?? 3;
  const minSeconds = options.minSeconds ?? 0.6;
  const cues: CaptionCue[] = [];
  let group: TimedWord[] = [];
  const flush = () => {
    if (group.length === 0) return;
    cues.push({ text: group.map((w) => w.text).join(" "), start: group[0]!.start, end: group[group.length - 1]!.end });
    group = [];
  };
  for (const word of words) {
    group.push(word);
    if (SENTENCE_END.test(word.text) || group.length >= maxWords || (group.length >= commaFrom && CLAUSE_END.test(word.text))) flush();
  }
  flush();
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    const wanted = Math.max(cue.end, cue.start + minSeconds);
    cue.end = next ? Math.min(wanted, next.start - 0.02) : wanted;
    if (cue.end < cue.start + 0.05) cue.end = cue.start + 0.05;
  }
  return cues;
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
