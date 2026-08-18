# Branded Shorts — Graphics & Cutaways Plan — v1

This is the one genuinely creative step in an otherwise 100% deterministic
pipeline (SKILL.md). You are handed a finished, cut transcript for ONE
branded short, plus the client's `graphics-language.md` (their approved
visual vocabulary, composition rules, and motion rules) and the list of
archetypes already in their `make_motion_repertoire.py` library. Your job is
to plan — never render — which beats get a motion graphic, which get a
full-frame cutaway, and what each one illustrates.

## The one rule above every other rule: MEANING

A graphic or cutaway exists **only** to illustrate what the speaker is
actually saying at that moment, derived fresh from this transcript. Never
stock, never decorative, never random, and never repeated from a prior video.
If you cannot name the exact phrase a graphic illustrates, do not propose it.

## Graphics (motion overlays)

- Your input includes an `archetypes` list — the client's exact, complete,
  approved repertoire. **Every `archetype` you return must be copied
  verbatim from that list.** Never invent a new visual primitive, never
  rename one, never combine two, and never propose something "close enough"
  even if it would fit the client's style — a genuinely new concept has to be
  built and approved outside this step (PLAYBOOK §4c layer 2). An archetype
  not in the given list will be mechanically rejected regardless of how well
  it would have illustrated the beat.
- One graphic per moment; do not stack two overlays on the same beat.
- Every graphic's window must fall entirely inside a kept segment (never
  spanning a cut).

## Cutaways (full-frame visuals)

- **THE RELEVANCE LAW governs everything** (PLAYBOOK §4d point 1): a cutaway
  copies the transcript exactly the way the graphics do. A named entity gets
  its own real logo/product/person — never a lookalike, never invented. If
  you cannot justify a cutaway against something actually said, do not
  propose it.
- Aim for 4-5 per video, but **some beats take ZERO** — never cut away from a
  fast, funny two-person exchange that lives on the faces (PLAYBOOK §4d
  point 2). A short under 30s may honestly need fewer than 4; say so by
  proposing fewer rather than padding for a number.
- Prefer `kind: "burst"` (3-6 real stills snapping in sequence) unless a
  single strong plate genuinely serves the beat better (`kind: "plate"`).
- `wordSrcStart` must be the `start` time of the actual transcript word this
  cutaway leads — the render gate enforces an 80-150ms lead before it, so
  pick the word first, then time the cutaway relative to it.
- **Mutual exclusion**: a cutaway's window must never overlap a graphic's
  window — one visual layer per beat.

## If you are revising after a failed gate

You may be handed the reason a prior plan failed — a brand/visibility/timing
gate, or an archetype that wasn't in the approved list. Fix exactly that
problem — reposition, retime, swap in an approved archetype, or drop the
offending overlay/cutaway — without discarding everything else that already
passed.

## Your output

`overlays[]` (archetype, start, end, illustrates, optional x/y) and
`cutaways[]` (kind, start, end, wordSrcStart, phrase, optional stillCount).
Both arrays may be empty if the footage genuinely doesn't call for either.
