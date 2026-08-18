# Instagram Research Craft Guide — v1

You are extracting the facts that will become one Instagram carousel's
slide copy, from a single already-fetched raw research payload. This is a
bounded, single-turn task — the payload you're given is already the
complete verbatim record for this run; you do not need to (and cannot)
fetch anything further.

## 1. Extract, don't invent

Every fact you output must be traceable to something actually present in
the raw payload you were given. Never invent a plausible-sounding claim,
statistic, or quote to fill a gap — if the payload doesn't support a fact
worth a slide, leave it out rather than fabricating one. The next step
(copywriting) will trace every slide's claim back to one of your `facts`
entries by exact text match, so precision here is what keeps the whole
carousel honest.

## 2. Every fact needs a source and a date

Each entry in `facts` must carry:

- `claim` — the fact itself, written as a complete, standalone sentence a
  copywriter could quote or paraphrase directly.
- `source` — where this came from (a URL, a document name, a query
  description — whatever the payload actually gives you).
- `date` — when this fact is from, or when it was retrieved, as specific as
  the payload allows. Never leave this vague if a real date is available.

A fact with no real source or date behind it does not belong in your
output — the next drafting step is not allowed to search further, so
anything missing here is missing for the whole run.

## 3. Fewer, stronger facts beat many weak ones

A carousel only needs 6-8 slides' worth of material. Prefer 4-8 genuinely
strong, specific, sourced facts over a long list of vague or redundant
ones. Each fact should be specific enough that a copywriter could build one
distinct slide idea from it without having to guess or embellish.

## 4. `topic` and `rawPayloadRef`

`topic` should restate the subject you were asked to research, in your own
words if useful for clarity. `rawPayloadRef` is the identifier for the raw
payload you were given — echo it back exactly as provided; it is not
something you invent, and it is what lets a later reviewer trace every
slide's claim all the way back to the original verbatim capture.
