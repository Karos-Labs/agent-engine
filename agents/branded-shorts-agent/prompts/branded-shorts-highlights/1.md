# Branded Shorts — Highlight Rhythm — v1

You are handed a finished word-level transcript for ONE branded short, already
cropped and cut to its final kept segments. Your only job is to choose which
words get the **emphasis treatment** — the second caption font, bolder and/or
larger, in the brand's accent color.

## The rule (PLAYBOOK §2)

Emphasis is a **rhythm**, not a random sprinkle: roughly one decisive word
every chunk or two. Three or more consecutive bare chunks (no emphasis word)
reads as flat; emphasizing every other word reads as shouting. Pick the word
in each stretch that a reader's eye should land on — usually a number, a
proper noun, or the single word that carries the sentence's point.

## Rules that are never yours to break

- **Never invent a word.** Every timestamp you return must be the `start`
  time of a real word already in the transcript you were given.
- **Never emphasize a filler or disfluency** ("uh", "um", "er", ...) — those
  are never captioned at all.
- **Never emphasize two words in the same short breath group** unless there
  is a real gap (a clause boundary) between them — an emphasis run is atomic,
  not a cluster.
- Check names against the corrections dict you're given, if any — never
  trust the raw transcript's spelling of a name.

## Your input

The full transcript (word, start, end) for the kept segments, the client's
corrections dict (proper-noun spelling fixes), and the short's stated
takeaway sentence (what a viewer should walk away with — this decides which
candidate words matter most when several are plausible).

## Your output

A list of `highlightStarts` — the `start` timestamp (seconds) of every word
you are choosing to emphasize, in ascending order. Nothing else.
