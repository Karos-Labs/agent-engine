# `@agent-engine/tool-karos-media`

Real image sourcing — search a chain of stock, CC and venue libraries,
download the results, hand back repo-relative paths an agent can render.

## Why it exists

`instagram-agent` step 06 vets candidate images against each slide's
`visualNeed` and **holds the whole post** when nothing qualifies. The candidate
pool was a workflow option (`imageCandidatePool`) that `apps/agent-server`
never passed, so it defaulted to `[]`. An empty pool cannot satisfy any slide,
so every Instagram run held on "no viable image found".

That failure is hard to spot because it reads like an editorial verdict rather
than a wiring gap. `media.findImages` is the backend that option was always
waiting for.

## Configuration

**Nothing is required.** Three providers need no credential, so every
deployment has a working chain out of the box. Keys only ever *add* sources.

| Variable | Adds | Notes |
| --- | --- | --- |
| — | `openverse`, `wikimedia`, `ddg_images` | Always on. |
| `UNSPLASH_ACCESS_KEY` | `unsplash` | The "Access Key", not the secret key. |
| `GOOGLE_PLACES_KEY` | `google_places` | Places API enabled on the project. |
| `APIFY_TOKEN` | `apify_google_maps`, `apify_instagram_location`, `apify_instagram`, `apify_pinterest` | One token, all four presets. Override an actor with `APIFY_ACTOR_<PRESET>`. |

### The single-provider era, and why it ended

This package originally shipped Unsplash alone, on the argument that step 06
records a real `license` / `rightsUsable` / `watermarkFree` verdict and a
general web search returns images of unknown provenance — so an honest vetting
agent would refuse nearly all of them and every run would hold anyway, just
with network calls in front of it.

That argument is correct, and it is still why `ddg_images` sits last and
labels itself `licenseConfidence: "unknown"`.

But it was over-applied: it justified *one* provider, when two of the excluded
sources — Openverse and Wikimedia Commons — carry real per-asset licence
metadata and need no key. The legacy `karos-agents` engine ran ten connectors
behind a router with four keyless, and its own docs noted the keyless ones
"are the working default today". Porting only Unsplash turned an optional
"premium stock mood" source into a single point of failure, and prep proved it:
run `pubsub-21528976110173438` held all six slides with
`no image-search backend configured — set UNSPLASH_ACCESS_KEY`, a key that had
been pending approval since June, while the legacy pipeline had been filling
the same slides keylessly all along.

Licence rigour is kept. It is now enforced **per hit** (`licenseConfidence`)
instead of per library.

## Routing

Each need declares what it needs a picture *of*; the route decides provider
order (`ROUTE_CHAINS` in `src/routing.ts`). Unconfigured providers are skipped,
which is what makes a chain degrade instead of break.

| Route | Order | Ranked by |
| --- | --- | --- |
| `named_venue` | apify_google_maps → apify_instagram_location → google_places → ddg_images → openverse → wikimedia | **Verification.** A press photo of the right building beats a beautifully-licensed photo of the wrong one. |
| `mood` | unsplash → openverse → wikimedia → apify_pinterest → ddg_images | **Licence defensibility.** blanket → attributable → unknown. |
| `default` | unsplash → openverse → wikimedia → ddg_images | Same. Used when a caller names no route. |

`route` is optional on every need and defaults to `default`, so existing
callers — including `instagram-agent` step 05b, which passes only
`{n, query}` — keep working untouched.

**Every provider in the chain is asked, and their results are merged.** The
chain is a preference order for *ranking*, not a stop condition.

It did stop at the first provider that returned bytes, on the theory that
merging would let a low-confidence source dilute a high-confidence one. prep
run `pubsub-20632239329452475` disproved that: Unsplash answers any generic
query, so it filled all 18 slots and Openverse/Wikimedia were never consulted
— then the gate rejected 5 of 6 slides for *subject mismatch*. It did not want
a cleaner licence, it wanted a picture of the right thing, and the sources that
might have had one were never asked. Dilution was never the risk either, since
every candidate is vetted individually against its own recorded licence.

Two knobs bound the merged pool, because it is not free — step 06 reads every
candidate description in a single prompt, so its cost and latency scale with
pool size:

| Input | Default | Meaning |
| --- | --- | --- |
| `perNeed` | 3 | Requested from **each** provider |
| `maxPerNeed` | 6 | Hard ceiling on the merged pool per need |

Candidates are interleaved round-robin, so the ceiling buys one pick from every
source before any source's second — breadth rather than one provider's top-N.
Chain order breaks ties within a round, so the highest-confidence provider
keeps precedence without taking everything. Identical image URLs from two
providers are deduplicated (Openverse aggregates Wikimedia, so the overlap is
real).

### Licence confidence

| Value | Meaning | Sources |
| --- | --- | --- |
| `blanket` | One library-wide licence covering commercial use | `unsplash`, `google_places` |
| `attributable` | Real per-asset licence, credit required | `openverse`, `wikimedia` |
| `unknown` | Provenance not established — the gate should be sceptical | `ddg_images`, all `apify_*` |

The `apify_*` and `ddg_images` sources are wired in because the legacy system
had them and because they genuinely find subjects no curated library carries.
They are **not** a licence to publish: UGC copyright stays with the uploader,
and step 06 should and will refuse most of them. They earn their place on a
`named_venue` slide headed for human review, not on an unattended run.

## Failure semantics

The distinction the tool exists to protect:

- **`content_fail`** — every provider answered honestly and had nothing. A real
  editorial outcome. The reason names each provider and what it said, so a hold
  is diagnosable rather than just "no candidate qualified".
- **`tooling_error`** — a provider *broke* and no fallback covered the gap. The
  question was never really asked. Because any unfilled slide holds the whole
  post downstream, this is reported even when other slides were filled.
- **`not_available`** — only when a caller supplies an explicitly empty source.
  Unreachable from env config, by design.

An outage a fallback recovers from is absorbed and correctly forgotten.

## What it deliberately does not do

It does not decide which image suits which slide, and it does not judge
usability. `InstagramImageVettingAgent` does both, and its verdict is recorded
per selection. Ranking candidates here would move a gate that is meant to be
an explicit, auditable decision into an opaque sort.

Step 06 is skipped entirely when the pool is empty — there is only one possible
verdict on nothing, and paying a model to write it out is waste.

## Quality gates

`src/quality.ts` holds two provider-independent filters, ported from the legacy
`sourcing.blocklists`:

- **Watermark domains** — ~60 stock hosts whose previews are watermarked or
  whose terms cannot support commercial use, dropped before download. Includes
  `plus.unsplash.com`: Unsplash+ is the paid tier and *is* watermarked, which
  the original single-provider implementation did not filter.
- **Query broadening** — a slide's `visualNeed` is written for a human ("a
  close-up of an unplugged ethernet or power cable on a desk") and matches
  nothing verbatim on a strict library API. Strict providers walk full text →
  3 salient words → 2, taking the first variant that hits.

## On-disk footprint

Downloads land in `<repoRoot>/.media-cache/<runId>/`. Paths are bounds-checked
against `repoRoot`, non-image content types are refused rather than saved with
an image extension, and anything over 12 MB is dropped.

**`<repoRoot>/.media-cache` has to be writable, and on Cloud Run it is not by
default.** The container filesystem is read-only apart from `/tmp`, so with
`INSTAGRAM_AGENT_REPO_ROOT=/app` this fails with
`EACCES: permission denied, mkdir '/app/.media-cache'` — which no deployment
had ever seen, because the single-provider tool returned `not_available` on a
missing key before it reached the filesystem. `cloudbuild.yaml` mounts an
in-memory volume there (and at `instagram-output`, which `renderCarousel`
writes) for exactly this reason.

It cannot simply move to `/tmp`: `renderCarousel` enforces
`assertInside(repoRoot)` on `templateDir`, `outDir` *and* every image path, and
`templateDir` ships read-only inside the image. Decoupling the writable working
root from the template root — the way `karos-landing` already separates
`LANDING_ENGINE_ROOT` from `LANDING_ENGINE_TEMPLATE_ROOT` — is the better fix
and is not done yet.

An in-memory volume consumes the instance's memory allocation, so the size
limits are real ceilings, not formalities. Nothing prunes the cache; it
disappears with the instance, but a long-lived host will want a sweep.

## Adding a source

Implement `ImageSearchProvider` (`src/providers.ts`), register it in
`buildProviderRegistry`, and name it in the routes it suits. A provider
registered but absent from every built-in chain is still appended to each
chain's tail, so an explicit registration is never silently unreachable.
