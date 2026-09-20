# RFC-25 — TikTok clipping: where the footage comes from

Status: **owner-approved 2026-09-20**. Phases 1-5 implemented; awaiting the prep runs §3 asks for.

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
  is untouched. That gate is the real protection, and it was always the real
  protection — the allowlist was a second line, not the first.
- **`licenseConfidence` stays `"unknown"`** for anything nobody cleared. Nothing here
  asserts a right the system does not have.

  > **Corrected 2026-09-20, same day.** This section originally read "the gate now
  > carries the source URL, the channel and the licence confidence explicitly". It did
  > not. The gate payload carried the source TIER and nothing else, so `web-harvest`
  > read identically whether the show was one the client clears every week or one an
  > open search had turned up ninety seconds earlier — and a gate this document calls
  > "the real protection" cannot protect against a risk it does not display. The
  > provenance did reach the *deliverable*, but only as prose inside a
  > `source-discovery` content repair and only on the `open` path.
  >
  > Now true: `11-clip-review` and the deliverable both carry `sourceUrl`,
  > `sourceChannel`, `sourceTitle` and a `licenseConfidence` computed by
  > `clipLicenseConfidence(tier, discovery)` — `client-provided` for the client's own
  > file or library, `client-cleared` for a show on their `sourcePool`,
  > `stock-licensed` for library footage, and `unknown` for an open search **or a
  > pasted link**. A pasted link is `unknown` because choosing a recording is not the
  > same as holding a right to republish part of it.
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

### Phase 3 — the fit gate (`01g-source-fit`)

A model reads the candidate's title and channel against the client's profile and the
run's topic, and returns `{ score, reason, concerns[] }`.

**It runs on metadata, BEFORE the transcript, and that is the whole placement.** The
plan said "and the first words of its transcript"; building it showed why that is
wrong. Transcribing a two-hour podcast is the most expensive step in the run, so a
check placed after it can only tell a reviewer the source was wrong once the run has
already paid to find out. Title and channel are enough for the failures this exists
for — a clip farm names itself, a competitor's show names itself — and catching them
here costs a cent instead of a transcription.

What it therefore cannot judge is whether the interesting moment is in this episode at
all. That is the moment picker's job and then the watchability floor's, and the prompt
says so rather than inviting a guess.

It runs only for HARVESTED footage. An attached upload and a pasted link are the
client's own choice, and scoring those would be this agent telling a client their own
recording is a poor source.

**It marks; it never blocks.** A low score becomes a `ContentRepair` and a gate-payload
field, under the standing always-deliver rule (RFC-19, generalised to this family on
2026-09-18). It is also the natural place to notice that a show is a competitor's, or
a clip farm. Roughly $0.01 a run.

### Phase 4 — paste a link

`media.ingestAssets` fetches an `https://` asset as a **direct file** — it does a plain
GET and writes the bytes — so a watch page was written to disk as an HTML document with
an `.mp4` name and failed three steps later inside `video.transcribe`.
`media.harvestVideo` grows a `resolveUrl` mode (one URL, no search) and Tier 1 routes
on what the URI says it IS.

**A dead link does not end the run, except when the client said it should.** Under
`mediaSource: "client"` the answer is `blocked_intake`: somebody said "only my media",
and finding a different video for them would be answering the request with something
else. Otherwise the cascade carries on and the deliverable says plainly that the clip
came from somewhere other than the link they pasted — a worse answer than they asked
for, and a better one than nothing.

That also exposed a gap: `sourceNotes` had only ever been set on the stock tier, so a
failed earlier tier vanished the moment a later one answered. Every tier carries them
forward now.

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
   and the query builder is the lever. **Three to five real prep runs**, because no
   amount of unit testing will tell us whether the query builder is good enough — what
   to read off them is the built query, the channel and title that came back, the fit
   score and whether the clip relates to the client at all. (The plan was to run these
   between phases 2 and 3; the owner asked for all five phases first, so they gate the
   tuning rather than the building.)
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
