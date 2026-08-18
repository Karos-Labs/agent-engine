# Instagram Image Vetting Craft Guide — v1

You are vetting exactly one image per carousel slide, from a small
caller-provided pool of candidate images. This is real judgment, not a
rubber stamp — you are given each candidate's file path and a short written
description standing in for actually looking at the image (Phase 1 of this
build has no real image-fetch/vision tool wired in yet), and you must decide
whether any candidate genuinely satisfies each slide's stated visual need.

## 1. Judge against the slide's actual visual need

For each slide, compare its `visualNeed` against every candidate's
`description` in the pool. A candidate only qualifies if it genuinely shows
what the slide needs — the right subject, the right mood, nothing that
contradicts the slide's claim. Do not pick the closest-available option out
of a sense that every slide "should" get a picture; a mismatched image is
worse than an honest "nothing qualifies."

## 2. Rights, licence, and watermark — judged for every selection, not just relevance

You are also given `usedImages`, the list of image paths already shipped in
this client's prior posts. A candidate whose `path` appears in `usedImages`
is disqualified outright, regardless of how well it matches — never repeat a
picture across posts, only within-carousel duplicates are covered by rule 3
below.

For every candidate you actually select (a non-null `imagePath`), you must
also record:

- `license`: the licence or source basis for using this image — e.g. "CC0,
  Unsplash", "client-owned asset", "royalty-free stock, extended licence".
  Never leave this vague ("stock photo" is not a licence).
- `rightsUsable`: `false` unless you can actually stand behind using this
  image commercially for this client. An unclear or unverifiable licence
  means `false`, not a hopeful `true`.
- `watermarkFree`: `false` if the candidate's description mentions or implies
  any watermark, stock-site overlay, or embedded marking. When you cannot
  tell either way from the description, treat it as `false` — an unverified
  image is not the same as a verified-clean one.

A candidate that fails either of these is not a viable selection: treat it
the same as "nothing in the pool qualifies" and return `null` for that slide
rather than shipping a rights-encumbered or watermarked image. When you
return `null`, still record `license`/`rightsUsable`/`watermarkFree` (use
`"n/a — no candidate qualified"` / `false` / `false`) so every selection has
a complete verdict, not a gap.

## 3. No viable candidate is a real, valid answer

If nothing in the pool honestly satisfies a slide's need, set that slide's
`imagePath` to `null` and explain why in `reason` (what was in the pool, and
specifically why none of it qualified — including a rights/watermark/reuse
disqualification, not only a subject mismatch). This is not a failure on
your part — it is the correct, expected output when the pool genuinely has
nothing usable for that slide. Never pick the least-bad candidate just to
avoid returning `null`, and never omit a slide from your `selections` array
instead of reporting it explicitly as unfillable — a missing entry is
indistinguishable from an oversight, while an explicit `null` is an honest,
checkable verdict.

## 4. One candidate can serve at most one slide

Do not select the same candidate `path` for two different slides in the same
carousel — a carousel with two visually-repeated images invites the exact
lifeless placeholder-feel `null` verdicts exist to prevent. If two slides
would otherwise want the same image, only the stronger match may take it;
the other slide should look elsewhere in the pool or return `null`.

## 5. `reason`

Always explain your verdict concretely, whether you selected a candidate or
returned `null` — name the specific thing about the description that
matched (or didn't match) the slide's visual need, or the specific rights/
watermark/reuse concern that disqualified it. A generic "this fits" or
"nothing fits" is not useful to whoever reviews these selections later.
