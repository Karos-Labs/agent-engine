# RFC-25 — TikTok clipping: where the footage comes from

Status: **owner-approved 2026-09-20**. Phases 1-5 implemented. The first prep run
(`pubsub-21912059758236775`) found two defects, both fixed: §1's allowlist ladder and §5's
hold. §3's remaining prep runs are still outstanding.

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
- **A client who HAS a `sourcePool` gets the allowlist path FIRST.** Their list is a
  statement about rights and it is where the search starts. It is not a veto on ever
  searching further: see the correction below.

### One thing this fixes on the way

`karoslabs`' own `sourcePool` names "The Karos Labs Podcast", which has no YouTube
channel, so the harvest tier has correctly refused every run since 2026-09-11 and
looked broken while doing it. With open discovery that client gets a real search
instead of a refusal.

> **Corrected 2026-09-20, after the first real prep run.** The paragraph above was
> written as a promise and shipped as a lie. `discovery` was chosen **once** —
> `allowedSources.length > 0 ? "allowlist" : "open"` — so a client *with* a pool never
> reached the open branch at all, and `karoslabs`, the one client this section names as
> the case it fixes, was the one case still broken. Prep run
> `pubsub-21912059758236775` held with *"web-harvest (allowlist, …): content_fail (The
> Karos Labs Podcast: 0 result(s))"*.
>
> Tier 2b now runs a **ladder**: the pool first, and an open search after it comes back
> empty. A pool that answers still ends the tier on one call, so nothing costs more than
> it did. What changed is the reading of an exhausted pool — treating it as "this client
> would rather have nothing" turns a configuration convenience into a veto nobody cast.
> A client who does want the narrow posture enforced has `mediaSource: "client"`, which
> `01a` refuses outright with nothing attached.

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

   > **Happened on the first open run, 2026-09-21.** `pubsub-21908845348121079`: the search
   > worked, returned a real podcast, and the DOWNLOAD came back *"Sign in to confirm you're
   > not a bot"*. The tier reported "nothing to clip" and threw away the other eleven usable
   > results, because a find carried one candidate and its failure was the search's failure.
   >
   > `media.harvestVideo` 1.4.0 takes ALTERNATES: up to four attempts down the same ranking,
   > covering private, removed, geo-blocked and members-only as well. A bot check is IP-wide,
   > so when it is *that*, all four fail and the cascade's next tier is still the real answer —
   > the refusals are all named in the reason so an operator can tell one blocked worker from
   > four unlucky videos. `YT_DLP_COOKIES_FILE` is the provider's existing hook and is not set
   > in prep; setting it is the actual fix for a blocked worker.
3. **A clip of a competitor's podcast, published under a client's account.** The fit
   gate's `concerns[]` is where this is caught, and the human gate is where it is
   stopped.

---

## 4. What would make this reversible

`discovery` defaults to `"allowlist"` in the tool, so every other caller is unchanged.
Inside the clipping workflow the ladder is the behaviour: a client's `sourcePool` decides
what is tried FIRST, not whether an open search may happen at all. The switch that turns
open discovery off for a client is `mediaSource: "client"` (refused at `01a` with nothing
attached); the switch that turns it off for everyone is the `postures` array in Tier 2b.

---

## 5. A clipping run never ends with nothing (2026-09-20)

The same prep run exposed a second, older defect, unrelated to discovery.

`mode: "commentary"` forbids the stock tier — a commentary clip is a clip of somebody's
words, and an original short over stock footage is a different product. With every
clippable tier dry the workflow threw `WorkflowHeld`, and the comment above the throw
called that hold *"honest"*.

It was honest and it was still wrong. The owner's standing ruling (2026-09-17) is that no agent ends a run with no deliverable — *"fall back,
redact, warn, or annotate on the output, but always deliver a result"* — and it names this
shape directly: a domain-level dead end is widen-and-annotate, not one of the three
carve-outs (nobody to write for, a human rejected it, a genuine tooling failure). A held
clipping run bills a client an error message in place of the work.

So the mode yields, **loudly**. The run makes an original short and says so in
`contentRepairs` (`check: "clip-mode"`, `action: "unresolved"` — nothing was repaired, a
different product was delivered) and on the gate payload as `modeSubstitution`. The
reviewer decides whether that was the right call for this topic; what they are never shown
is an `original-short` deliverable with no sign that a clip was what was asked for.


### What widening the cascade broke, and the lesson

Making the cascade able to return `sourceTier: "stock"` for a CLIPPING run invalidated an
invariant nothing had written down: before it, `mode: "commentary"` plus the hold guaranteed
a clipping run never saw a stock intake. So `format` was pinned straight from the pressed
product —

```ts
formatForVariant(variant) ?? (intake.sourceTier === "stock" ? "original-short" : "commentary-clip")
```

— and for `variant: "clipping"` the left side always won. Prep run
`pubsub-21908845348121079` reached `08-render` and failed with
`video.brandFrame: videoPath: undefined`: a stock intake has no source video at all.

`format` now reads the source first. The variant pin still decides everything it should —
a clipping card answers with a clip whenever there is anything to clip — but a `stock`
intake is a physical fact, not a preference.

Two things this should have been caught by and was not: every test in
`agents/tiktok-agent/__tests__/workflow.test.ts` ran `productId: "tiktok-agent"`, so
`variant` was always `"auto"` and the named variants' pin was never executed by any test;
and the same reasoning that justified the dry-cascade hold also justified a second hold on
footage with no speech in it (`variant === "clipping"`, `02-transcribe`), which PR #170 left
in place. Both are fixed: `run()` takes a variant, and silent footage delivers an original
short announced the same way.

One hold remains at the end of the cascade, and it is the carve-out: a deployment with no
`video.findStockClip` or no repoRoot cannot make anything at all, which is a fact about
the deployment rather than about this client's topic.

### The third hold, and the last one (2026-09-21)

`01-claim-topic` threw `WorkflowHeld` when the catalog lane was empty, no footage was
attached and discovery could not seed it — quoting the legacy loop's rule verbatim: *"a run
with no candidate logs that fact and exits cleanly. It never lowers the bar to ship
something."* That rule was superseded on 2026-09-17, and the ruling that replaced it names
**this exact case**: *no candidate topic → widen and deliver annotated*. Third time in this
file in two days that prose outlived the rule which made it true.

A ladder now, weakest excuse first, each rung announced as a `topic-source` repair:

1. **Discovery produced clean candidates and only the CATALOG could not reserve one.** The
   subject is exactly as good as the one that would have been reserved; what is missing is
   bookkeeping, and bookkeeping is not worth a client's run.
2. **Everything proposed was too close to something the client recently published.** A poor
   answer — repetition across runs is the tell the dedupe exists to remove — and still a
   better one than nothing, *because it is named*: the reviewer is told what it repeats and
   refuses it at the gate on the facts.
3. **Discovery proposed nothing at all.** A content pillar is the client's own declared
   answer to "what should we be talking about", so it is a real subject rather than an
   invented one. It rotates on the lane's row count, so two runs in a row do not land on the
   same pillar.

One hold remains, and it is the carve-out: no catalog, no footage, no research, no intel and
no content pillars means the run knows nothing about this client to be about — "nobody to
write for". Its reason names what to add.

A scout **outage** also stopped being fatal on the way. It threw `WorkflowToolingFailure`,
which killed a run that could still have reached rung 3; the tooling carve-out is for when
nothing can be produced, and there something can.

---

## 6. The podcast, on screen (2026-09-21)

Owner's priority, after the first two prep runs both produced a generic stock short:
**a clip of a podcast where you can see the podcast.**

`media.harvestVideo` can give that and is refused — YouTube answers the download with
*"Sign in to confirm you're not a bot"*. A show's own RSS feed cannot refuse, because
serving the episode to whoever asks is what a feed is for, and a large share of shows
publish a **video enclosure** beside the audio one.

`media.harvestPodcast` (Apple's keyless directory → the show's feed → a direct HTTP
download) is registered ON by default, because unlike every other backend here it needs
no key, no binary and no provisioning. Tier 2c runs it BEFORE the YouTube harvest unless
`YT_DLP_COOKIES_FILE` is set, decided at wiring time: trying YouTube first on a worker
with no cookies costs four player clients × four candidates to learn what the deployment
already knows.

### Video first, and the guard on it

A video episode leads **when it is on topic at all**. Preferring video unconditionally
would ship an off-topic video episode over an audio one that is exactly right, and a clip
about the wrong thing is not improved by being able to see who said it.

`media` is read from the RESPONSE, never from the feed's declared type: a feed that says
`video/mp4` and serves an MP3 has served an MP3, and the clip pipeline routes on this.

### What needed no new machinery

A video episode is an ordinary video source. The commentary path transcribes it, picks
the moment, cuts it and frames it with `blur-fill` — which was already there, described
as *"the way every podcast clip on the platform is cut. A crop would take the faces."*

### What is deferred, and why the tier asks for `requireVideo`

An AUDIO episode needs a composition that does not exist yet: the real audio under sourced
plates, with the speakers' own words as captions. Two of its three pieces are built —
`video.cutAudio`, and `splitTranscriptIntoBeats`, which cuts the words **in code** from the
transcript's timings so a model can never paraphrase a speaker or desynchronise a caption.
What is missing is the model turn that dresses each beat with a picture.

Until that lands the tier passes `requireVideo: true`, so an audio-only show is reported
and the cascade carries on rather than downloading an episode the run cannot use. The
tool reads the feed's declared enclosure type, so that costs no download at all.
