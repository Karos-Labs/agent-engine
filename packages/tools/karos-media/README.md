# `@agent-engine/tool-karos-media`

Real image sourcing — search a stock library, download the results, hand back
repo-relative paths an agent can actually render.

## Why it exists

`instagram-agent` step 06 vets candidate images against each slide's
`visualNeed` and **holds the whole post** when nothing qualifies. The candidate
pool was a workflow option (`imageCandidatePool`) that `apps/agent-server`
never passed, so it defaulted to `[]`. An empty pool cannot satisfy any slide,
so every production Instagram run held on "no viable image found."

That failure is hard to spot because it reads like an editorial verdict rather
than a wiring gap. `media.findImages` is the backend that option was always
waiting for.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `UNSPLASH_ACCESS_KEY` | yes | Unsplash API access key (the "Access Key", not the secret key). |

Without it the tool still registers, and every call returns `not_available`
with that reason. It never throws at construction — an unconfigured deployment
must not stop the server booting or make other products undispatchable, which
is the same rule `video.*` and `landing.*` follow.

## Why Unsplash and not a general web image search

Step 06 records a real `license` / `rightsUsable` / `watermarkFree` verdict per
selection and refuses to ship an image it cannot justify. A general web search
(Google Custom Search, Bing) returns images of unknown provenance, so an honest
vetting agent marks almost all of them `rightsUsable: false` — every run would
still hold, just with network calls in front of it. The Unsplash License covers
commercial use with no attribution required and the library is unwatermarked,
which is what lets that gate actually pass.

Attribution is not required but is still carried in each candidate's
description, so a client who wants to credit the photographer can.

Swapping backends means implementing `ImageSearchProvider` (`src/providers.ts`)
and passing it to `createKarosMediaTools({ provider })`. The tool itself has no
provider-specific knowledge.

## What it deliberately does not do

It does not decide which image suits which slide, and it does not judge
usability. `InstagramImageVettingAgent` does both, and its verdict is recorded
per selection. Ranking candidates here would move a gate that is meant to be an
explicit, auditable decision into an opaque sort.

## On-disk footprint

Downloads land in `<repoRoot>/.media-cache/<runId>/`. Paths are bounds-checked
against `repoRoot`, non-image content types are refused rather than saved with
an image extension, and anything over 12 MB is dropped. Nothing prunes the
cache yet — on Cloud Run that directory is the container's own ephemeral disk
and disappears with the instance, but a long-lived host will want a sweep.
