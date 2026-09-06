#!/usr/bin/env python3
"""Cutaway scheduling gate (Lola 2026-07-10: "perfectly timed with what the
person is saying ... a few milliseconds before they say the word", and "if
there is this overlay there shouldn't be the graphics from the other skill
at the same time").

    cutaway_check.py --job <job.json> --transcript <transcript.json>

Machine-enforces PLAYBOOK 4d on the job file BEFORE build:
  1. COUNT     — 4-5 cutaways per video (override with --allow-count for
                 explicitly approved exceptions, e.g. very short videos).
  2. TIMING    — every cutaway enters 80-150ms BEFORE its target word's
                 start. On or after the word = FAIL. Entering too early
                 (>150ms) = FAIL (reads as unmotivated).
  3. EXIT      — a cutaway never ends inside a spoken word (20ms boundary
                 tolerance).
  4. EXCLUSION — no cutaway window overlaps any motion-graphic overlay
                 window: one visual layer per beat.

Job format: cutaways are declared in the job as
    "cutaways": [{"file": ..., "start": <out s>, "end": <out s>,
                  "word_src_start": <source-time s of the word it leads>,
                  "phrase": "<what it illustrates>"}]
A v2 BURST (Lola 2026-07-30) is ONE cutaway entry with "stills": [3-6 paths]
instead of "file" — it counts as one for COUNT, and rules 2-4 apply to the
whole burst window. Extra rule 5. PACING: each still must hold 0.15-0.45s
(a snap, not a slideshow). Burst stills obey the RELEVANCE law: they copy
the transcript like the motion graphics do (talking about AI models -> the
real lab's logo, its CEO, a computer) — `phrase` records the justification.
`start`/`end` are OUTPUT time (same timebase as overlays); `word_src_start`
is SOURCE time straight from the transcript — this script maps it through
the job's segments. Exit code 1 on any failure; the scheduler must fix and
re-check. Nothing borderline builds.
"""
import argparse
import json
import sys

LEAD_MIN = 0.080   # cutaway must enter at least 80ms before the word...
LEAD_MAX = 0.150   # ...and at most 150ms before (Lola: "a few milliseconds")
COUNT_RANGE = (4, 5)
WORD_EDGE_TOL = 0.020
BURST_STILLS = (3, 6)          # a burst is 3-6 stills...
BURST_HOLD = (0.15, 0.45)      # ...each holding a snap, not a slideshow


def src_to_out(t, segments):
    """Map a source-time instant to output time through the cut list."""
    acc = 0.0
    for s0, s1 in segments:
        if t < s0:
            return None  # falls in removed material before this segment
        if t <= s1:
            return acc + (t - s0)
        acc += s1 - s0
    return None


def load_words(transcript):
    return [(w["start"], w["end"], w["text"].strip())
            for w in transcript["words"] if w.get("text", "").strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--allow-count", action="store_true",
                    help="skip the 4-5 count rule (approved exception only)")
    args = ap.parse_args()

    job = json.load(open(args.job))
    transcript = json.load(open(args.transcript))
    segments = job.get("segments", [])
    words = load_words(transcript)
    cutaways = job.get("cutaways", [])
    overlays = job.get("overlays", [])
    failures = []

    # 1. COUNT
    lo, hi = COUNT_RANGE
    if not args.allow_count and not lo <= len(cutaways) <= hi:
        failures.append(f"COUNT: {len(cutaways)} cutaways declared; "
                        f"rule is {lo}-{hi} per video")

    for i, c in enumerate(cutaways):
        tag = f"cutaway[{i}] ({c.get('phrase', c.get('file', '?'))!r})"

        # 2. TIMING — lead the word
        w_out = src_to_out(c["word_src_start"], segments)
        if w_out is None:
            failures.append(f"{tag} TIMING: target word at source "
                            f"{c['word_src_start']}s was cut out of the edit")
        else:
            lead = w_out - c["start"]
            if lead <= 0:
                failures.append(f"{tag} TIMING: enters {-lead*1000:.0f}ms "
                                f"AFTER the word — must lead it")
            elif lead < LEAD_MIN or lead > LEAD_MAX:
                failures.append(f"{tag} TIMING: lead {lead*1000:.0f}ms is "
                                f"outside {LEAD_MIN*1000:.0f}-"
                                f"{LEAD_MAX*1000:.0f}ms")

        # 3. EXIT — never mid-word
        for ws, we, txt in words:
            o_s, o_e = src_to_out(ws, segments), src_to_out(we, segments)
            if o_s is None or o_e is None:
                continue
            if o_s + WORD_EDGE_TOL < c["end"] < o_e - WORD_EDGE_TOL:
                failures.append(f"{tag} EXIT: ends at {c['end']}s inside "
                                f"the word {txt!r} ({o_s:.2f}-{o_e:.2f}s)")
                break

        # 5. PACING — burst stills hold 0.15-0.45s each (v2, Lola 2026-07-30)
        stills = c.get("stills")
        if stills is not None:
            lo_s, hi_s = BURST_STILLS
            if not lo_s <= len(stills) <= hi_s:
                failures.append(f"{tag} PACING: {len(stills)} stills; "
                                f"a burst is {lo_s}-{hi_s}")
            elif len(stills):
                hold = (c["end"] - c["start"]) / len(stills)
                lo_h, hi_h = BURST_HOLD
                if not lo_h <= hold <= hi_h:
                    failures.append(
                        f"{tag} PACING: {hold*1000:.0f}ms per still is "
                        f"outside {lo_h*1000:.0f}-{hi_h*1000:.0f}ms "
                        f"(a snap, not a slideshow)")

        # 4. EXCLUSION — one visual layer per beat
        for ov in overlays:
            if c["start"] < ov["end"] and ov["start"] < c["end"]:
                failures.append(f"{tag} EXCLUSION: window "
                                f"{c['start']}-{c['end']}s overlaps graphic "
                                f"{ov.get('file', '?')!r} "
                                f"({ov['start']}-{ov['end']}s)")

    if failures:
        print(f"CUTAWAY GATE: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print(f"CUTAWAY GATE: PASS ({len(cutaways)} cutaways, "
          f"{len(overlays)} graphics, no conflicts)")


if __name__ == "__main__":
    main()
