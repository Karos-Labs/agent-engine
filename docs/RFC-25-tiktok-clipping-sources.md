# RFC-25 — TikTok clipping: where the footage comes from

Status: **owner-approved 2026-09-20**, implementation in progress.

The first RFC for the TikTok family. Everything before it was written down in the
2026-09-18 audit and in commit messages; the decision below needed a document because
it **reverses a rule the code currently states in prose, with a rationale attached** —
and a reader who meets the new behaviour without this file will correctly read it as a
regression and revert it.

---

## 1. The decision

> **The clipping agent may search the open web for podcasts to clip.**
> Owner ruling, 2026-09-20.

Until now `media.harvestVideo` refused to search unless the client's
`tiktokClips.sourcePool` named shows they hold clipping rights to. That refusal was
deliberate and is documented in the tool:

> *"A harvested clip is `licenseConfidence: "unknown"` by the scrape tier's own
> standard — copyright stays with the original poster. What makes a commentary clip
> publishable anyway is that the client holds clipping rights to specific shows … With
> none, a provider refuses rather than searching the open web."*

That paragraph describes a real trade-off and it has not stopped being true. What
changed is who decides: the owner has weighed the exposure and chosen reach.

### What was considered and not chosen

| Option | Why not |
| --- | --- |
| A **Karos-curated pool** — a central list of vetted shows, used when a client has none | Recommended, and declined. It keeps the rights model intact and fixes the `karoslabs` case below, at the cost of somebody maintaining the list. The owner chose not to take on that maintenance. |
| **Open search + one-time human approval per show**, after which the show enters the client's `sourcePool` | Declined as too slow on each show's first use. |

### What the decision does NOT change

- **Every clip still reaches a human before anything is published.** `11-clip-review`
  is untouched, and the gate now carries the source URL, the channel and the licence
  confidence explicitly. That gate is the real protection, and it was always the real
  protection — the allowlist was a second line, not the first.
- **`licenseConfidence` stays `"unknown"`.** Nothing here asserts a right the system
  does not have. The field travels to the reviewer rather than being quietly dropped.
- **The caption still has to credit the source**, checked in code, not asked of the
  model (`07-compliance`, and since 2026-09-18 the credit is appended rather than held
  on).
- **A client who HAS a `sourcePool` still gets the allowlist path.** Open search is the
  behaviour when there is no pool, not a replacement for one.

### One thing this fixes on the way

`karoslabs`' own `sourcePool` names "The Karos Labs Podcast", which has no YouTube
channel, so the harvest tier has correctly refused every run since 2026-09-11 and
looked broken while doing it. With open discovery that client gets a real search
instead of a refusal.

---

## 2. What is built

### Phase 1 — open discovery in the tool

`media.harvestVideo` grows `discovery: "allowlist" | "open"`, defaulting to
`"allowlist"` so no existing caller changes behaviour. The yt-dlp provider grows the
open branch: one `ytsearchN:<query>` with no source prefix, the same duration bounds,
the same title-overlap-and-recency scoring.

`TOOL_VERSION` 1.1.0 → 1.2.0.

### Phase 2 — a query worth searching

Today the harvest is handed `query: claim.topic` — the catalog row and nothing else.
"AI marketing budgets" searched against all of YouTube returns clip farms and
conference B-roll. `01f-build-harvest-query` composes the search string
deterministically from the client's industry and positioning, the claimed topic, and
the angle the scout grounded it in. A separate step so it is inspectable in the trace
and testable without a model.

### Phase 3 — the fit gate (`02a-source-fit`)

A model reads the candidate's title, channel, description and the first words of its
transcript against the client's profile and the run's topic, and returns
`{ relevant, score, reason, concerns[] }`.

**It marks; it never blocks.** A low score becomes a `ContentRepair` and a gate-payload
field, under the standing always-deliver rule (RFC-19, generalised to this family on
2026-09-18). It is also the natural place to notice that a show is a competitor's, or
a clip farm. Roughly $0.01 a run.

### Phase 4 — paste a link

`media.ingestAssets` fetches an `https://` asset as a **direct file**, so a YouTube
watch page fails today. `media.harvestVideo` grows a `resolveUrl` mode — one URL, no
search — and Tier 1 of the cascade tries: direct file → yt-dlp resolve →
`blocked_intake` naming which it was.

### Phase 5 — the caption earns the clip

`tiktok-commentary` v6 requires the caption to state the connection between the clipped
moment and the client's business, and receives the fit gate's `reason` as input.

No deterministic check that the connection "is there": code proves presence, never
absence, and a phrase matcher for "this matters to you because" would be a note
pretending to be a gate.

---

## 3. The risks, in the order they will actually bite

1. **Search quality, not rights.** Searching all of YouTube for a marketing topic
   returns clip farms, re-uploads and conference B-roll. The fit gate is the mitigation
   and the query builder is the lever. **Three to five real prep runs after Phase 2,
   before Phase 3 is built**, because no amount of unit testing will tell us whether the
   query builder is good enough.
2. **yt-dlp against YouTube is an arms race.** Bot checks and rate limiting are a known
   operational failure. It is invisible today because the harvest tier almost never
   runs; under open discovery it runs on every clipping run with no attached footage.
   The cascade already treats a provider throw as a tooling failure and moves on, so
   this degrades rather than breaks — but it will be noisy.
3. **A clip of a competitor's podcast, published under a client's account.** The fit
   gate's `concerns[]` is where this is caught, and the human gate is where it is
   stopped.

---

## 4. What would make this reversible

`discovery` defaults to `"allowlist"`. Setting a client's `sourcePool` restores the old
behaviour for that client with no code change, and flipping the workflow's default
restores it for everyone.
