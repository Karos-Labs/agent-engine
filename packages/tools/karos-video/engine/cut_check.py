#!/usr/bin/env python3
"""Cut-craft gate (Lola 2026-07-28: "way too choppy ... you weren't supposed to
cut out entire words or sentences or phrases").

    cut_check.py --job <job.json> --transcript <transcript.json>

The rule this enforces, in Lola's words: CROP THE ENDS, then inside the kept
window remove ONLY filler. Never a word, phrase or sentence that carries
meaning. Before this gate existed nothing checked cut density at all, and the
2026-07-27 Deel proof run shipped a second short that dropped 63% of its own
source span and averaged a cut every 1.16s.

Four checks:

  1. DENSITY   — at most MAX_CUTS_PER_10S internal cuts per 10s of output.
  2. SEGMENTS  — every kept segment at least MIN_SEGMENT_S long. Two fillers
                 200ms apart are NOT two cuts: leave the small one in rather
                 than minting a sub-1.5s fragment. An audible "uh" costs less
                 than a visible jump cut.
  3. RETENTION — the kept material is at least MIN_RETAINED of the span from the
                 first kept word to the last. Cropping the ends is free; holes
                 in the middle are what this bounds.
  4. HONESTY   — every removed span inside the window must be filler: a
                 disfluency token, or an immediate repetition of the words
                 around it (a false start). Anything else is a CONTENT cut and
                 must be declared in the job as
                     "content_cuts": [{"span": [s, e], "reason": "..."}]
                 Declaring one is allowed - profanity and self-interruptions are
                 real editorial needs - but it can never be silent, and the
                 reason lands in the build report.

Exit code 1 on any failure. Nothing borderline builds.
"""
from __future__ import annotations

import argparse
import json
import sys

MIN_SEGMENT_S = 1.5        # Lola-approved 2026-07-28
MAX_CUTS_PER_10S = 4.0     # ~a cut every 2.5s at worst
MIN_RETAINED = 0.80        # of the first-to-last kept-word span

# True disfluencies only. Deliberately does NOT include real words that merely
# feel like filler ("like", "you know", "actually", "so"): those carry voice, and
# stripping them is the rewriting this gate exists to prevent.
FILLER = {
    "uh", "uhh", "uhm", "um", "umm", "er", "erm", "ah", "ahh", "eh", "mm",
    "mmm", "hmm", "hm", "mhm", "uh-huh", "euh",
}


def norm(t: str) -> str:
    return t.strip().strip(".,!?;:…\"'").lower()


def spoken_words(transcript):
    return [w for w in transcript["words"]
            if w.get("type") == "word" and w.get("text", "").strip()]


def removed_spans(segments, words):
    """Gaps between consecutive kept segments, with the words that fall in them.
    Material before the first segment and after the last is a CROP, not a cut."""
    out = []
    for (a_s, a_e), (b_s, b_e) in zip(segments, segments[1:]):
        inner = [w for w in words if w["start"] >= a_e - 0.02
                 and w["end"] <= b_s + 0.02]
        out.append({"span": (a_e, b_s), "words": inner})
    return out


def is_false_start(inner, words):
    """Removed words repeat what is spoken immediately after the gap."""
    if not inner:
        return False
    seq = [norm(w["text"]) for w in inner]
    after_start = inner[-1]["end"]
    after = [norm(w["text"]) for w in words if w["start"] >= after_start][:len(seq) + 3]
    if not after:
        return False
    # the removed run is a prefix of what follows (he restarted the phrase)
    for n in range(len(seq), 0, -1):
        if seq[-n:] == after[:n]:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    job = json.load(open(args.job))
    tr = json.load(open(args.transcript))
    segs = [tuple(s) for s in job.get("segments", [])]
    words = spoken_words(tr)
    declared = [(tuple(c["span"]), c.get("reason", "")) for c in
                job.get("content_cuts", [])]
    failures, notes = [], []

    if not segs:
        print("CUT GATE: FAIL (no segments)")
        sys.exit(1)

    kept = sum(e - s for s, e in segs)
    window = segs[-1][1] - segs[0][0]
    n_cuts = len(segs) - 1

    # 1. DENSITY
    per10 = n_cuts / max(kept, 0.001) * 10
    if per10 > MAX_CUTS_PER_10S + 1e-9:
        failures.append(f"DENSITY: {n_cuts} cuts over {kept:.2f}s output = "
                        f"{per10:.2f} per 10s, limit {MAX_CUTS_PER_10S}")
    notes.append(f"density {per10:.2f} cuts/10s (limit {MAX_CUTS_PER_10S})")

    # 2. SEGMENTS
    for i, (s, e) in enumerate(segs):
        if e - s < MIN_SEGMENT_S - 1e-9:
            failures.append(f"SEGMENT {i}: {e - s:.2f}s is under the "
                            f"{MIN_SEGMENT_S}s minimum ({s:.2f}-{e:.2f}). Leave "
                            f"the smaller filler in rather than fragmenting.")
    notes.append(f"shortest segment {min(e - s for s, e in segs):.2f}s "
                 f"(min {MIN_SEGMENT_S})")

    # 3. RETENTION
    retained = kept / window if window > 0 else 0
    if retained < MIN_RETAINED - 1e-9:
        failures.append(f"RETENTION: kept {retained*100:.1f}% of the "
                        f"{window:.2f}s window, minimum {MIN_RETAINED*100:.0f}%. "
                        f"Crop the ends instead of holing the middle.")
    notes.append(f"retained {retained*100:.1f}% of a {window:.2f}s window "
                 f"(min {MIN_RETAINED*100:.0f}%)")

    # 4. HONESTY
    for gap in removed_spans(segs, words):
        gs, ge = gap["span"]
        inner = gap["words"]
        if not inner:
            continue  # silence / breath only
        texts = [norm(w["text"]) for w in inner]
        if all(t in FILLER or t == "" for t in texts):
            notes.append(f"cut {gs:.2f}-{ge:.2f}s filler {texts}")
            continue
        if is_false_start(inner, words):
            notes.append(f"cut {gs:.2f}-{ge:.2f}s false start {texts}")
            continue
        match = [r for (ds, de), r in declared
                 if ds <= gs + 0.05 and ge - 0.05 <= de]
        if match:
            notes.append(f"cut {gs:.2f}-{ge:.2f}s DECLARED content cut: "
                         f"{match[0]} {texts}")
            continue
        failures.append(
            f"HONESTY: cut {gs:.2f}-{ge:.2f}s removes content, not filler: "
            f"{' '.join(w['text'] for w in inner)!r}. Either keep it, or "
            f"declare it in job['content_cuts'] with a reason.")

    if args.verbose or failures:
        for n in notes:
            print(f"  {n}")
    if failures:
        print(f"CUT GATE: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print(f"CUT GATE: PASS ({len(segs)} segments, {n_cuts} cuts, "
          f"{kept:.2f}s from a {window:.2f}s window)")


if __name__ == "__main__":
    main()
