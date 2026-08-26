# `@agent-engine/tool-karos-media`

Real image sourcing — search a chain of stock, CC and venue libraries,
download the results, hand back repo-relative paths an agent can render.

## The four tiers

A visual need is resolved by trying these in order, falling through to the
next only for whatever the current one left unfilled:

| Tier | Tool | Source | Licence |
| --- | --- | --- | --- |
| 0 | `media.ingestAssets` | The client's own attachment on this run | `client-supplied` — strongest possible basis |
| 1 | `media.findImages` | Stock/CC libraries (Unsplash, Openverse, Wikimedia, DDG, …) | `blanket` / `attributable` / `unknown` per hit |
| 2 | `media.scrapeImages` | The open social web (ScrappyCoco), for a photo of the actual subject | `unknown` — UGC, refused by most vetting |
| 3 | `image.generate` | Vertex AI (`gemini-2.5-flash-image`) | `generated` — no third-party rights |

Nothing here decides *which* candidate fits a slide or whether one is
"unmet" — every tool just answers honestly for the needs it's given. The
calling workflow is what re-vets after each tier and only asks the next one
about the needs still open; see `instagram-agent`'s step 05b/06/06b/06c/06d/06e
for the reference implementation and "Adopting this in another agent" below.

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
| `PEXELS_API_KEY` | `pexels` | Free to register; no unauthenticated endpoint exists, so this is a key like Unsplash's, not a scrape. |
| `PIXABAY_API_KEY` | `pixabay` | Same — free key, no public unauthenticated search. |
| `GOOGLE_PLACES_KEY` | `google_places` | Places API enabled on the project. |
| `SCRAPPYCOCO_API_KEY` | `media.scrapeImages` (tier 2) | See "Scraping" below. Shared with `research.pull` via `@agent-engine/tool-karos-scraper` — one key, every scrape-backed capability. |
| `GEMINI_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) | `image.generate` (tier 3) | See "Generation" below. |

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
| `named_venue` | google_places → ddg_images → openverse → wikimedia | **Verification.** A press photo of the right building beats a beautifully-licensed photo of the wrong one. Generic stock (Unsplash/Pexels/Pixabay) is absent here on purpose — none of them can verify a specific real place. |
| `mood` | unsplash → pexels → pixabay → openverse → wikimedia → ddg_images | **Licence defensibility.** blanket → attributable → unknown. |
| `default` | unsplash → pexels → pixabay → openverse → wikimedia → ddg_images | Same. Used when a caller names no route. |

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
| `generated` | Created for this post — owned outright, nothing to credit, nothing watermarked | `media.generateImage` |
| `blanket` | One library-wide licence covering commercial use | `unsplash`, `pexels`, `pixabay`, `google_places` |
| `attributable` | Real per-asset licence, credit required | `openverse`, `wikimedia` |
| `unknown` | Provenance not established — the gate should be sceptical | `ddg_images` |

`ddg_images` is wired in because it genuinely finds subjects no curated library
carries. It is **not** a licence to publish: provenance is unestablished, and
step 06 should and will refuse most of its results. It earns its place on a
slide headed for human review, not on an unattended run.

**AU51 removed the vendor-backed UGC sources** (Google Maps venue photos,
Instagram by place and by hashtag, Pinterest). Scraping is a swappable
capability behind `ScraperProvider` and nothing above that seam names a vendor;
those presets were the last violation of that rule. The seam models
`searchSocial` for x/instagram/reddit/tiktok but has no place-tagged or
Pinterest capability, so `named_venue` now leads with `google_places` — and
falls through to generic image search wherever `GOOGLE_PLACES_KEY` is unset,
which is currently every deployed environment. Restoring venue photography is
tracked as a capability request against the seam, not as a vendor re-add.

## Scraping: `media.scrapeImages`

Tier 1 holds generic scenes, not a photo of the *actual* named thing — that
only lives on the open social web. `media.scrapeImages` searches Instagram
and TikTok (`ScrapyCoco`, behind the same `ScraperProvider` seam
`research.pull` uses) and downloads whatever it finds through the identical
`downloadImage` guarantees as every other tier.

Every candidate here is `licenseConfidence: "unknown"` — a scraped post's
copyright stays with whoever posted it, and the description says so bluntly
on purpose, so a vetting step reads it correctly rather than guessing. This
tier earns its place as reference material and for human-reviewed picks; it
is not what makes an unattended run complete. Tier 3 is.

Unconfigured (no `SCRAPPYCOCO_API_KEY`), it reports `not_available`, exactly
like `image.generate` does with no Vertex project — never a construction-time
throw, so a workflow can check for the tool rather than for the env var.

## Generation: `media.generateImage`

Retrieval has a ceiling more providers cannot raise. prep run
`pubsub-21535110633863323` hit it with four providers and 36 candidates: slide
5 needed *"a timeline or roadmap with a clearly labeled 'research' first phase,
shot from above"*. No stock or CC library holds that picture. Generation is the
only source that answers a brief on demand.

| | |
| --- | --- |
| Model | `gemini-2.5-flash-image` (override with `IMAGE_GEN_MODEL`) |
| Project | `GEMINI_VERTEX_PROJECT_ID` → `GOOGLE_CLOUD_PROJECT` |
| Region | `IMAGE_GEN_LOCATION` → `VERTEX_AI_LOCATION` → `us-central1` |
| Licence | `licenseConfidence: "generated"` — ranks *above* `blanket` |

No new credential: a deployment that already reaches Gemini on Vertex can
generate.

**It is a tool, not an `ImageSearchProvider`, and that is deliberate.** Every
provider in a chain is queried for every need — that is what makes the pool
diverse. Each generated image is billed, so generation belongs to the slides
that actually came up empty, invoked by the workflow after the gate has spoken.
In the chain it would generate six images a run and discard most of them.

### Two things worth knowing

**It is `generateContent`, not `generateImages`.** The SDK deprecates
`generateImages`, and the `imagen-*` publisher models it targets return 404 for
this project — verified by probe, not assumed. `gemini-2.5-flash-image` answers
on both `global` and `us-central1`.

**A refusal has no filter field.** The model declines with `finishReason: STOP`,
no image part, and a *text* part explaining itself. That text is the only
explanation available, so it is surfaced verbatim into `unmet` rather than
flattened to "no image".

The brief forbids text in the pixels. Generated lettering comes out malformed,
and the carousel template renders the real headline and body as live text over
the image — words in the picture would collide with copy already there.

**A `RESOURCE_EXHAUSTED`/`UNAVAILABLE` failure retries with backoff, not once.**
prep runs `pubsub-21533408759483219` and `pubsub-21543794087429035` both held
on the same shape: Vertex's per-minute burst quota trips after a handful of
back-to-back generations in one step, and every following call 429s. Before
this, that single retryable blip was treated exactly like a real refusal —
one `unmet` entry, no second attempt, and the *last-resort* fallback tier gave
up on a condition that clears itself in seconds. It now retries up to 3 times
with exponential backoff (`retry.maxAttempts` / `retry.baseDelayMs` on
`createGenerateImage`) before it counts as genuinely unmet — a real refusal
or malformed request still fails on the first try, with no added latency.

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

## Adopting this in another agent

All four tools are already merged into every deployment's tool registry
(`apps/agent-server/src/wiring/tools.ts`), unconditionally — a `blog-agent` or
`linkedin-agent` workflow can call `media.findImages` today without any wiring
change. What's missing for every agent except `instagram-agent` is the
**workflow-level choreography**: no agent yet calls the tools in tier order
with a vetting step deciding what's still unmet between each one, so today
only `instagram-agent` actually produces a real image.

To add the chain to another agent's workflow, mirror
`create-instagram-agent-workflow.ts`'s steps `05z`/`05b`/`06`/`06b`/`06c`/`06d`/`06e`:

1. Tier 0 — call `media.ingestAssets` once for whatever the client attached,
   keyed to a slot/need index.
2. Tier 1 — call `media.findImages` for every need not filled by tier 0.
3. Vet (agent step, product-specific) — decide which tier-1 candidates
   actually satisfy each need's brief and rights bar. This step is
   deliberately not in this package: what counts as a match and what rights
   bar applies differs by product (a blog hero image's criteria are not a
   carousel slide's), and folding it in here would turn an explicit, auditable
   verdict into an opaque ranking.
4. Tier 2 — call `media.scrapeImages` only for needs the vet step left open.
   Vet again.
5. Tier 3 — call `image.generate` only for needs still open after tier 2. Vet
   again; this is the tier that can answer any brief, so a hold past this
   point is a real editorial outcome, not a sourcing gap.

Each tool already tells you, per need, whether it was filled and why not
(`unmet`) — the new workflow code is the loop that feeds one tier's leftover
needs into the next, plus the product's own vetting prompt. Nothing about the
provider chain, licence handling, retries, or the on-disk cache needs to be
reimplemented per agent.

## Adding a source

Implement `ImageSearchProvider` (`src/providers.ts`), register it in
`buildProviderRegistry`, and name it in the routes it suits. A provider
registered but absent from every built-in chain is still appended to each
chain's tail, so an explicit registration is never silently unreachable.
