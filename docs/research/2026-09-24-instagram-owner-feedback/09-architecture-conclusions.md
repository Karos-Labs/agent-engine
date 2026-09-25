# What the research concludes: the architecture of the Instagram agent's learning system, and how to improve it

For Tomer. 2026-09-25. Compiled from the 2026-09-24 owner feedback round.

**What this builds on.** PRs #259-#282 already closed the execution defects the owner's letters named: render keys and merges, the readable-copy lint, copy v32, cover caps, the anchored scrim, logo equal-area sizing, the site-identity guard, numerals in the brand face and neutral panels. RFC-26 (#249-#279) built the exemplar harvest, judge and library, and its within-account median scorer in `instagram-exemplars.ts` is the correct scoring model for everything below. Nothing here re-specifies that work. This document is about the layer above it: where knowledge lives, how a run compiles it, what the data can and cannot support, and the loops that make the system improve with every client, scrape, post and remark.

**Sources** (all relative to this folder): [`storm-lead.json`](storm-lead.json) (25 surviving and 10 refuted conclusions), [`scale.md`](scale.md) (183-account within-account study), [`taxonomy.json`](taxonomy.json) (the taxonomy judge), [`robustness.json`](robustness.json) / [`robustness-v2.json`](robustness-v2.json) (grouping re-test on 89 then 173 accounts), [`relevance-kernel.json`](relevance-kernel.json), [`designs.json`](designs.json) (relevance tiers, impact on code, compounding loop, loops everywhere), [`layer-system.json`](layer-system.json) (layer designs and judge), [`auditors.json`](auditors.json) (108 audited rows, 32 transfers), [`dt.json`](dt.json) (Don Techno), [`a16z-deep-dive.md`](a16z-deep-dive.md), [`compile.json`](compile.json), and the corrected guideline set in [`guidelines/`](guidelines/).

---

## 1. The conclusions in plain language

### 1.1 What performs, platform-wide (L1)

Method: for each of 183 benchmark accounts, the 6 best posts against the 6 weakest by likes + 3x comments, one vote per account, sign test. Read a row as "mean within-account difference over n accounts (accounts positive / negative, p)". Every one of these also held in 5-7 of the 7 client syntheses and in the a16z 72-post measurement.

| Finding | Evidence (scale.md, ALL) | Corroboration | Engine consequence |
|---|---|---|---|
| A real photograph of the subject dominating the frame beats muted or neutral designed plates | photo-dominant +0.21, 136 accts, 99+/26-, p<0.001; muted -0.15, 156 accts, 35+/92-; text-only plate -0.09, 15+/35- | Hebrew news 10+/1-; luxury 10+/0-; Karos synthesis lift 2.08 | Cover = full-bleed subject photo by default; only real photos count toward the imagery floor; `MIN_GENERATED_IMAGES_PER_RUN` 3 -> 0 |
| Stock and generic AI-looking imagery sit with the weakest posts; the only AI that wins is an owned character | stock -0.11, 39 accts, 11+/25-, p=0.03; AI-looking +0.11 over 19 accts p=0.48 (noise, not a lift) | Pitch set AI 0 of 78 best vs 4 of 78 weakest; a16z 0 of 17 outliers illustrated; Aerie #NotAI 45,841 likes | Generation only for owned-character or labelled-concept classes; a guard fails any generated frame presented as real |
| A named subject with a reader stake beats abstract advice and house promotion | story hook +0.10, 124 accts, 74+/28-; how-to -0.09, 27+/47-; promo -0.08, 31+/50- | a16z 13 of 17 outliers on a famous founder; Geektime same topic 12.3x with a price vs 0.75x without; Calcalist house promo 0.09x | Cover gate: display headline names a real subject and a checkable stake; promo demoted unless it carries a date, price, free thing or named person |
| Complete spoken sentences with one fact win; fragment stacks, "X is not A. It is B." and teasers read as AI | fragments -0.07, 162 accts, 48+/83-, p=0.003; mixed form +0.09 over 71 accts (89-set) | Antler same-episode A/B: complete quote 2.06-2.26x vs fragment 0.45-0.58x; 32 of 36 DT builders shared one fragment rhythm | Shipped as the readable-copy lint (WS-10). Remaining: LANG-01 as a MUST with a label exemption list (decision 21) |
| Four or more text sizes mark weak posts; winners use two sizes plus meta | 4+ sizes -0.11, 67 accts, 16+/43-, p=0.0006 | a16z 1-2 sizes + meta at 2-2.5:1; our runs 7-14 sizes, ratios 8.8-14.7:1 | TYPE-SIZES gate (WS-06): <=3 computed sizes, neighbours >=1.35x, H:T <=2.5 |
| Text on a photo needs a measured dark shade; medium contrast loses | medium -0.14, 111 accts, 24+/72-; high +0.06, 160 accts, 71+/41-, p=0.006 | a16z 7-34/255 behind text vs 71 on our Pitch cover; Hebrew medium 0+/8- | Shipped as the anchored scrim (WS-08); CONTRAST gate 4.5:1 vs the worst 10% of pixels per line |
| Decorative furniture loses; a graphic wins only when it carries data or the product | boxes/cards -0.09, 97 accts, 24+/54-, p=0.0009; icons -0.09, 69 accts, 18+/38-, p=0.01; none +0.06, 68+/43- | fintech chart/table covers lift 3, icons-with-data 2.67; intimates swatch quiz 10.69x | Bundled archetype devices off by default; <=1 device per interior, 0 on covers; every container from the client's captured design language |
| Hype and flat informational registers lose; emotional/personal wins | hype -0.12, 111 accts, 27+/68-; informational -0.08, 27+/62-; emotional +0.12, 107 accts, 66+/27- | music hype 0+/7- p=0.016; authoritative 7+/0- | Register is a kit value; hype words only beside a concrete detail; no LLM register gate (see 1.3) |
| Link-in-bio closers and follow end cards lose | link-in-bio -0.13, 102 accts, 26+/59-, p=0.0004 | a16z 0 of 11 carousels with a follow card reached 2x vs 12 of 28 without | No link-in-bio or follow closer; one caption ask from the kit set or none |
| Collab posts with the featured person are the largest free reach lever | programs 1.38x vs 0.85x solo (n=47 vs 185); music 1.37 vs 0.98; artist-owned collab reels 4.26x | a16z Flock collab 1.38M plays vs 77k median; @getdeel co-posts 9.9-17.8k vs 354 | `PostPackageSchema` gains `collaborator` and `credit`; source the subject's own media first |
| Interior slides carry far fewer words than ours and each adds one fact; recaps are a defect | a16z story slides 0-12 words; explainers of 25-54 words went 0 of 5 at 2x; ours 39-44 per slide | Startup best median 4 words/interior; intimates 0; B2B 17 | Word lanes on the rendered file (0-12 / 15-25 / 25-35, hard cap 35); fact-level dedupe; no recap slide |
| Slide 2 is a second cover; slide count itself is not a lever | slides median(best-weakest) 0 over 169 accts (63+/37-) | Meta Feed ranking card scores carousel completion with card count as an input; Mosseri: unengaged carousels re-serve from slide 2 | Slide-2 gate; count per kit band, never padded |
| Rendering with fonts that are not the client's was the most consistent defect (7 of 7 runs) | not a performance claim | root causes: Google-only css2 links, site reader on a Yotpo widget / Cloudflare 403 | Shipped (WS-02, WS-03). Remaining: FONT_HOLD for undecided or unlicensed faces (decision 17) |
| Competitor and own-post scoring is wrong today | hidden likes on 22-77% of posts on 9 music pages read as 3 likes; 12-post window spans 11-42 h so score tracks age (r=0.83 on @edmmusic); formats taken from caption text | 20 of 66 Sitti "weakest" are placeholders; 2 of 3 a16z "worst" under a day old | The three scoring fixes are the precondition for every loop (section 3.0) |
| Meta's April 2026 originality rule and June 2026 ranking card make reposted third-party media an account-level risk; completion, sends and saves are the targets | primary sources: transparency.meta.com IG Feed card; Mosseri 30 Apr 2026 | carousels 9x saves of single images (Metricool, 24.4M posts) | Originality guard at package time; the loop optimises saves and sends per reach, never raw likes |

Null results recorded as noise so nobody writes a rule on them: cover word count (median diff 0 over 173 accounts), logo position (top-left -0.06 p=0.46; none +0.06 p=0.13), AI-looking imagery as a lift, brand-colour weight (p=0.73), sans vs serif (p=0.92), carousel vs reel, illustration, posting hour.

### 1.2 What the grouping test found

The question: does knowing an account's group predict its best-minus-weakest pattern vector better than pooling every account? `skill = 1 - SSE_group / SSE_global`, leave-one-account-out, k-shrinkage toward the global mean, permutation p over 199-999 shuffles.

| Grouping | 89 accounts (k=30) | 173 accounts (k=30) | 173, no hidden likes | Carousels only (69 accts) |
|---|---|---|---|---|
| involvement | +0.0114, p=0.01 | **+0.0096**, p=0.01 | +0.0107 | +0.0024, p=0.07 |
| archetype | +0.0128, p=0.01 | +0.0085, p=0.01 | +0.0080 | +0.0009, p=0.21 |
| audience | +0.0032, p=0.04 | +0.0066, p=0.01 | +0.0072 | **+0.0108**, p=0.01 (k=10) |
| industry | +0.0100, p=0.01 | +0.0065, p=0.01 | +0.0042 | +0.0025, p=0.11 |
| size | +0.0027 | +0.0034 | +0.0038 | +0.0004 |
| content_job | +0.0057 | +0.0014, p=0.07 | +0.0007 | +0.0033, p=0.05 |
| visual_style | ~0, p=0.23 | +0.0017, p=0.02 | +0.0019 | +0.0005 |
| format_mix, fmix x style | +0.0026 / +0.0015 | negative | negative | negative |

Reading it plainly:

1. **There is no big middle layer.** The best grouping reduces prediction error by about 1%. The signal is real (p=0.01, survives dropping hidden-likes accounts and young posts) but it is small and it needs strong shrinkage: at best k=30, a group of 30 accounts is weighted 50/50 with the global mean. Under k=3 (the first run) 15 of 16 groupings scored below zero.
2. **Involvement, archetype and audience carry the signal; industry is the weakest of the four and mostly one cluster.** On 89 accounts, industry's +0.0100 fell to +0.0017 when the intimates set was dropped (`designs.json` impact §0); its marginal contribution once archetype and involvement are known is -0.0002 (compounding §1). Archetype and involvement each still add +0.0054 to +0.0056 (p=0.01-0.025) when their labels are shuffled only inside an industry, so they are not just "which client brought this account".
3. **Archetype and involvement largely measure one thing at this size.** Additive archetype + involvement = +0.0195, the best model tested; involvement's increment over archetype alone is +0.0031 (p=0.21).
4. **Audience is the only card with skill on carousels**, the format the engine ships (+0.0108, p=0.01 on 69 accounts; +0.0086 without hidden likes). Every other card fails the carousel slice. So no card may carry engagement deltas for the Instagram agent yet.
5. **A soft additive similarity beats any hard segment.** The evidence-weighted card-match kernel scored +0.0192 (p=0.005) on 89 accounts, +21% over archetype alone and above the hard involvement x archetype intersection (+0.0172). Weights must come from each card's own single-card skill on the leaderboard, never from an optimiser: grid-fitted weights scored +0.0206 in-sample and only +0.0133 held out. Weights v1: archetype 0.35, category 0.26, involvement 0.26, audience 0.09, size 0.04, locale 0.
6. **The confound is not broken yet.** Using only neighbours from other source clients, kernel skill falls to +0.0005. Each industry is one client's competitor set, every Hebrew account is tech news and every pt-BR account is fintech. Breaking this is the main job of benchmark enrichment (loop 5).
7. **Locale is noise for pattern transfer** (p=0.51-0.68) but matters for market overlap. Visual style, format mix and size earn no card.

### 1.3 Refuted claims, so nobody rebuilds them

Ten storm conclusions were killed by two independent skeptics ([`storm-lead.json`](storm-lead.json) `killed`); two more were reduced at compile time; one transfer and one cross-account finding were dropped.

| Id | The claim | Why it died |
|---|---|---|
| L1-03 | A post with no hook is the most reliable loser; hype and informational registers lose; ship a register gate | hook=none (5+/27-) is reels and photo dumps, and our carousels never ship without a hook; a gate against "informational" copy would reject Nath's law explainers (31.5x), music's authoritative register (7+/0-) and Hebrew news hooks. The hype ban alone survives as a regex, no LLM register classifier |
| L1-07 | Big headline type wins only when the line is short (GRID-HOOK gate at 96-140px, 8 words) | huge is p=0.054 overall and reverses in Hebrew news (-0.095) and startup; the interaction was never tested; the numbers were not derived from any measurement. Headline tier is a kit value (DS-04 TRY) |
| L1-11 | Link-in-bio loses; add a rotated comment ask to every post | the metric is likes + 3x comments, so a comment prompt raises the score mechanically; intimates 11+/1- includes comment-to-enter giveaways; comment prompts do not transfer to startup (-0.083). Removing link-in-bio stands; the ask is a kit value |
| L1-12 | Long captions win platform-wide; default 300-1,200 chars | remove the giveaway-inflated intimates 8+/0- and the rest is ~31+/19-, p~0.12; B2B reverses (short +0.17); Hanky Panky's own median is 45 chars. Caption length is a kit value by audience |
| L1-14 | One visual system per account is what makes winners; kill preset rotation for performance | survivorship anecdotes, no statistic; best posts show 2-3 bits of layout entropy; the claim's own winners repeat one module (Me Poupe 15 slides one layout, 28.35x). Pinning the client's kit is brand fidelity (DS-14 MUST), not a performance rule |
| L1-19 | One bold brand accent beats muted or dark palettes | brand-colour heavy 18+/15-, p=0.73; dark reverses by industry (Hebrew 1+/9-, music +0.17). Only the WCAG/APCA pair check stands |
| L2-02 | B2B: every interior slide is a picture of the point with 15-25 words; comparisons win | no B2B within-account test reaches p<0.05 except logo=none; comparison 4+/1- p=0.375; "17 words per slide" is 21 best posts with no weakest comparison. Kept as a kit convention, not a lift |
| L2-03 | Intimates: words on slide 1 only, an explicit ask is the strongest lever | the ask lift is the 3x comment weight plus giveaways; hidden likes contaminate Felina 32/36, Natori 35/36, teamkindly 36/36 weakest sets |
| L2-04 | Fintech: the "rule-change spine" cover format | generalises from 2 Nath posts on one creator account; no fintech within-account test reaches p<0.05. The compliance parts (never present proposals as law) survive as correctness rules |
| L2-06 | Creator apps: restrict topics to named-creator maps and founder stories | 20 of 66 weakest posts are hidden-like placeholders; story 6+/1- p=0.125, huge headline 4+/1- p=0.375 |
| L1-10 (half) | A corner logo marks weak posts | logo_position shows no signal at L1 (top-left -0.06 p=0.46). The owner's logo rule stands as a standard; presence and corner are client values |
| L1-20 (half) | Typeface register reverses across industries so L2 should set it | true as a null, but the engine never sets a register at all: faces come from the kit (DS-15 TRY) |
| X1 | Transfer: luxury's photo-dominant saturated colour to intimates | refuted twice; its substance already lives in L1 IMG-01/H-3 and the Hanky Panky DNA |
| "reels 10x carousels" | cross-account ranking from Don Techno's April read | cross-account, flipped between periods; formats are per-client (tau_account 0.38 vs tau_industry 0.16) |

### 1.4 The caveats that shape everything

- **Hidden likes** are read as 3 by the scraper (22-77% of posts on the music pages, all @deelpitch, all @teamkindly, 32/36 Felina). Every "weakest" bucket in the study is weaker evidence than the "best" bucket.
- **Age**: posts under 3 days were not excluded; on busy pages the 12 newest posts span 11-42 h.
- **Metric**: likes + 3x comments, so comment funnels, giveaways and contests inflate "comment prompt" and "long caption".
- **Confounds**: photo-dominant, emotional register and story hooks co-occur with famous subjects and Collabs; industry = source client; locale nested in industry.
- **Three client accounts cannot rank design**: @karoslabs (22 followers, median 3 likes), @deelpitch (likes hidden, reel views median 354), @xodigital.oficial (385 followers). Their rules are borrowed from larger accounts and owner verdicts.
- **Don Techno's own redesign is unproven** (first weekly analysis 27 Sep; `learning.json` empty). Its numbers enter as defaults with n and date, never as MUSTs.
- **Entries #1-#3 of the leaderboard all use the same 89 accounts.** They count as one discovery pass, not three confirmations. The 173-account run is the first with new accounts.

---

## 2. The architecture

### 2.1 Layers

| Layer | Holds | May state "X lifts engagement"? | Approves |
|---|---|---|---|
| **L1 platform** (`guidelines/L1-platform.md`) | Instagram craft, code gates (the mechanism half of every hard rule), and every pooled performance default, one vote per account across all benchmark accounts. 69 lines, 37 params | Yes (global) | Albert, every line and every MUST |
| **L2 facet cards** (thin middle, standards only) | `facet-archetype` (7: brand, place, person, publisher, platform, business, institution), `facet-involvement` (none, low, high) + audience modifier (B2B, B2C, mixed; two keys only), `facet-locale` (en, he, pt-BR, fr, es, multi; a qualifier, not a layer). Each key has exactly one owner | No, until the facet passes the gate in 2.3 | Albert for the registry (adding a value) |
| **L2 category packs** (`ig-kit-<category>.md`, 8 today, <=25 lines) | Compliance and claims per jurisdiction, 8-15 entry points, calendar, proof conventions, lingo, imagery source and `photoShareMin`, graphics mix and icon band, slide band, word caps within the L1 lanes, `captionChars`, `askSet`, hashtag count, register value, `questionForm`, `headlineTier`, peer set and baselines | No. Industry statistics appear as evidence refs; a line from fewer than ~8 accounts is a convention or a TRY | Anna |
| **L3 client DNA** (`ig-dna-<slug>.md`, 9 today, <=15 lines) | Classification record, brand-kit values (faces, palette, logo variant, position, treatment, presence, design-language tokens), overrides with a reason, kit lines the client skips, the client's own standards, learned weights shrunk toward L1 (never toward a facet), the transfer experiments as TRY lines | Yes (per client, from its own posts) | Anna weekly; an explicit owner or client instruction enters as DEFAULT at once |
| **Run input** | post job, product line (product line may override involvement only) | - | - |

Key ownership is the mechanism that makes the middle thin and conflict-free: archetype owns `voice_person`, `face_on_camera`, `produced_vs_ugc_look`, `audio_source` (hard, read from the IG account type), `cadence_default`, `collab_style`, `news_peg_handling`, `series_affinity`. Involvement owns `default_post_job_mix`, `brand_vs_activation_ratio`, `cta_intensity`, `register_intensity`, `format_lead`; the audience modifier may shift only `brand_vs_activation_ratio` (toward 50:50 for B2B) and `proof_person_style`. Locale owns script direction, register pack, number/date/currency format, proofing and the jurisdiction key. A double-write is a CI error, not a runtime conflict. The full list is in [`guidelines/README.md`](guidelines/README.md) "Key ownership".

### 2.2 `compileDNA(client, run)` at dispatch

Pure, no model call, runs in `01-open-run` (or a checkpointed `01a-read-guidelines` before it). Merge order:

1. L1 defaults for every registry key
2. the three facet cards as a plain union (disjoint keys)
3. the audience modifier on its two keys
4. locale variants: exact locale, then base language, then default
5. L3 DNA overrides (reason required, non-hard keys only), then L3 learned weights shrunk toward L1
6. run input
7. checked against L1 hard gates

Precedence, highest first: **L1 hard gates > run input > L3 DNA > facet cards and pack (no order among them) > L1 defaults.** Between two conflicting prose lines the narrower wins. No line overrides a gate or the brand kit. Hard rules form a floor no later layer may lower: platform constraints (L1), `audio_source` (archetype), compliance and claims (pack + locale jurisdiction, checked by the L1 claims gate), forbidden topics and brand-kit assets (L3), product rules (draft-only, never narrate review).

The output is one resolved parameter set **plus a provenance map per key** `{layer, docVersion, lineId or param}` stored on the run. At `10-write-run-state` the run also writes `recipe` (format, series, visual system, payloadKind, hookPattern, pictureDensity and its source, slideCount, imageSource), `rulesApplied` and `assignment {policy: requested|default|variety|experiment, dim, level, propensity, seed}` as optional fields on the C7 record (`RunStateRecordInputSchema` is a `z.object`, so they must be added; an optional field needs no version bump). The middleware's `collect` stores the record verbatim, so `record->'recipe'` is queryable the day it ships. The deliverable carries the same recipe so the portal copies it to `asset.meta.recipe`. The layer judge's verdict: **if only one item lands, it is this write-back**; every loop and the middleware and portal joins depend on it, and it is purely additive.

Prose lines become `LearningCraft` rules through `mergeCraft()` (L3 before L2, skipped lines dropped, TRY and timing held back, evidence refs stripped) and render into the copy input through the existing `craftRulesForPrompt`, the same field X, LinkedIn and Reddit already document. `npm run guidelines:show -- <slug>` prints the same resolution the engine uses.

### 2.3 Standards vs performance claims, and the facet gate

A **standard** is a convention or constraint that claims no engagement lift; it keeps the scope its author states and is checked only for fit and conflicts. A **performance claim** says a level lifts engagement and gets only the scope its evidence reaches. Only L1 and L3 may hold a performance claim today.

An L1 pooled claim becomes a DEFAULT only when: the sign test / Hartung-Knapp random-effects interval over accounts excludes 0 with lift >= x1.15; it passes Benjamini-Hochberg q=0.10 across every level tested that run; it holds again in a confirmation window with >=30% new posts; the 80% prediction interval for a new account excludes 0.

A facet (or one type inside it) may carry additive deltas on L1 only when all of these hold and are recorded in the leaderboard: honest skill >= +0.01 with BH q < 0.10; the increment beyond the source cluster has restricted p < 0.05; leave-one-source-cluster-out minimum > 0 and median >= 0.6 x full skill; **forward skill > 0 with the 90% CI lower bound > 0** on >= 40 accounts added since the last passing run from >= 3 new source clusters; every type used has >= 20 accounts from >= 3 source clusters; carousel-residual skill >= 0 on >= 60 accounts with >= 6 carousels each; label kappa >= 0.6; at least one engine default would change (P(delta > 0) >= 0.8); not credibly reversed in the L3 data of any Karos client of that type, confirmed in >= 2 clients before TRY -> DEFAULT; Albert signs off the first promotion. A `CARD_DELTAS_ENABLED` flag returns everything to L1-only. Demotion: failing items 1-3 on two runs, or a forward-skill CI entirely below 0 once.

Where the cards stand: involvement and archetype are **candidates** (pass items 1-3); publisher (26 accounts) is the only archetype type eligible on size; place has 0 accounts; category, audience and content job are descriptive. A performance delta, when earned, is `d(type, level) = n_t/(n_t + k*) x (mean_t - global)`, capped at |d| <= 0.15 and 8 keys per type, and L3 then shrinks toward L1 + d.

### 2.4 The auditor rubric

One rubric-driven skill (`.claude/skills/guidelines-auditor/SKILL.md`), not a panel. One Haiku call (~$0.003) parses free text into the closed vocabulary; everything after is deterministic or a query. A refuter runs on L1 and MUST items and on any kit or DNA DEFAULT resting on fewer than ~8 accounts. An Opus alignment review closes each owner batch against the lettered brief.

| Step | Question | Output |
|---|---|---|
| 1. Kind | defect / data fix / constraint / preference / hypothesis / noise | defect -> ticket + regression test, no prose; data fix -> portal profile; constraint -> hard gate, owner-confirmed, no statistics; preference -> L3 DEFAULT for that client; hypothesis -> continues; noise -> recorded |
| 2. Blame by provenance | which layer or parameter produced the criticised element, from the run's DNA map | fix at the source (the Karos gradient boxes blamed the bundled closer template, an L1 mechanism, not a Karos rule) |
| 3. Mechanism / value split | restate as a mechanism (almost always L1) plus a value (kit, pack or client) | clients differ by parameters, not rules; a lesson with no vocabulary key becomes a vocabulary-gap item |
| 4. Source-blind generality | restate for three contrasting clients (Hanky Panky, Geektime, XO) before reading who said it; five written tests | candidate layer |
| 5. Standard or claim | see 2.3 | scope |
| 6. Scale test, widest scope first | query the pool for the mapped keys at platform, every pack, then this client; the L1 bar above; L2 needs >= 5 accounts each with >= 3 effective posts (14 recommended); L3 deviation needs >= 8 own posts per side in two windows | widest layer where credible and consistent, else narrower as TRY with a Watching entry above |
| 7. Strength | MUST names its enforcer (gate, step id or ticket); DEFAULT meets its layer's bar; TRY waits for the experiment slot | |
| 8. Extent per client | predicate gate (locale, pack membership, photo supply, regulated, brand-kit conflict), then applies / adjusted / skip per client with the reason | written into each DNA as an adjusted line or a skip; replaced later by P(effect > 0 for this client) from the pooled model |
| 9. Conflicts and code fit | duplicate merges; conflict names the coupling; a line a gate forbids is rejected; a line needing a knob the engine lacks becomes a ticket and stays TRY | |
| 10. Output | one PR: doc diffs, audit table, tickets | humans approve only constraints, new L1 defaults, L2 lines resting on remarks alone, vocabulary changes, owner-vs-data conflicts, retiring an owner-origin line |

What the first pass produced from the owner's letters and the storm: 108 rows in [`auditors.json`](auditors.json): 16 constraints (all L1), 27 standards (L1), 42 performance claims (29 L1, 11 L2, 2 L3), 12 defects (code only), 5 data fixes (L3), 2 preferences (L3), 4 noise; 45 MUST, 40 DEFAULT, 14 TRY, 9 n/a. 972 per-client extent verdicts: 501 applies, 363 adjusted, 108 skip. 31 of 32 transfers survived. Guardrails: a remark is never evidence (priors steer the experiment queue, never promotion); owner statements are superseded, not aged; owner-vs-data conflicts go back to the owner, never silently overridden.

### 2.5 Classification: five picks, once, at onboarding

One Haiku call inside the existing onboarding research step reads profile, website, IG bio and the last 12 captions and proposes archetype, category, involvement, audience and locale, each with a one-line reason. Locale comes from caption language detection; account type (business / creator) and size band are set in code. Involvement uses the three-question rule on the primary revenue line the feed converts: (a) is the posting itself what the audience comes for, money following attention? -> none; (b) otherwise, does acting need research, money or commitment: regulated category, typical order above ~$100, a B2B contract, or an application costing days? -> high; (c) otherwise low. Staff confirm on client settings. Reclassification is staff-only, logged, and recompiles the DNA. **Performance never reclassifies a client**; it adjusts L3 weights. The same `classifyAccount()` labels every benchmark and competitor account (10 per call, ~$0.003 each), calibrated against the 89 hand labels at kappa >= 0.7 per card before go-live.

---

## 3. The loops that make it compound

### 3.0 Preconditions (every loop reads competitors, and every competitor read is wrong today)

From the Don Techno audit ([`dt.json`](dt.json)), one shared `scoreWithinAccount()` replacing the z-score in `topic-engines.ts scoreReferencePosts` and matching RFC-26's `instagram-exemplars.ts:162-206`:

- keep the shape fields on `SocialHistoryPost` (`mediaKind`, `slideCount`, `videoShare`, `durationS`, `coauthors`, `pinned`, `paidPartnership`, `likesHidden`, `imageUrls`, `ageHoursAtScrape`); `social-history.ts` drops them today, so 00c2 classifies formats from caption text
- read by time, not count: `POSTS_PER_ACCOUNT` 12 -> page until 28 days back and >= 36 eligible posts (100 in the weekly scan, cap 150)
- eligible = >= 96 h old (72 h on small accounts), not pinned (x3.7), not paid (x0.68), not bait (comments > half the likes, "comment to get"); >= 5 eligible or "no evidence"
- score = basis / median of the account-format family over the trailing 90 days; basis is likes + 3x comments, comments only when >= 30% of likes are hidden, plays for reels; **never read `like_and_view_counts_disabled` as a number**; younger posts age-projected with DT's `AGE_CURVE` (0.55 <24 h, 0.72 at 24-48, 0.82 at 48-72, 0.88 at 72-96, 0.95 to 168) for topic ranking only
- drop the views/50 term, the cap and the absolute-scale fallback; compare views only with views; collabs analysed separately
- confirm each peer handle with one profile call before any deep scrape (16 of 34 DT seeds were wrong; @mixmagmagazine is now @mixmag)

Also: Cloud Scheduler for `/api/analytics/sync` and `/api/agent-engine/reconcile` (the #207 what-works projection has no scheduler, so `preferredByPerformance` falls back to rotation), and the D45 policy decision on scraping (decision 11).

### 3.1 The eight loops

| # | Loop | Trigger | Updates | Guardrails | Cadence | Cost |
|---|---|---|---|---|---|---|
| 1 | Onboarding enrichment | client created or lab-imported | classification; register rows for the client, its competitors, up to 6 category peers and up to 3 gap accounts (same cards, different category or locale, aimed at cells < 20 accounts or single-source); 100 posts per account into the pool; the client's own grid sets L3 baselines; stub pack if the category has none; DNA v1 via `compileDNA` | staff confirm the 5 picks; category confirmed before a stub pack opens; every handle verified; competitors are research only, never named in copy, harvested frames `reference-only`; adding a closed-card value needs a registry PR | per event; leaderboard runs if the pool grew >= 25% | ~$2.5-3.5 per client (classify $0.01, verify ~15 handles $0.03, harvest ~$0.21, tag ~1,000 posts ~$2.50 on Haiku Batch, judge $0.04, stub pack $0.20) |
| 2 | Every scrape joins the pool | RFC-26 setup harvests, weekly close-tier scans, monthly benchmark refresh, per-run reads in 00c2/03e | the harvest tool appends every normalised post (keyed by shortcode, stored once whichever client harvested it) with shape fields, flags, capture age, provenance, source client and role, plus the judge's craft score and design DNA; the client's `instagramExemplarLibrary` becomes a **view** of the pool; `INDUSTRY_BENCHMARKS` reads the register | eligibility rules of 3.0; one vote per account; API facts tagged deterministically, visual and copy dimensions once per (shortcode, vocab_version) by Haiku 4.5 vision on Batch (~$0.0025/post), tagger never sees engagement; 5-10% double-tag, kappa < 0.6 not pooled that month; media kept 180 days; no private accounts; needs D45 | continuous; monthly refresh | ~$12-15 per month now, $20-25 at 25 clients |
| 3 | Every post we publish | `afterAssetPosted` schedules captures at 48 h (early read, alerting) and 7 d (decision); the daily sweep appends the capture nearest each age, never overwrites | L3 learned weights per recipe level: `log m = (n_eff x log m_client + k x log m_L1)/(n_eff + k)`, k=6, 90-day half-life, weekly step cap 0.10, range 0.7-1.4, feeding `what-works.json` by recipe level (not templateKey) then 04h, 04i2, 03f; the #215 best-hour slot with the same shrinkage; experiment outcomes to loop 8; `y_own = (saves + shares)/reach` at 7 d drives L3 for high-involvement clients | live rows only; floors of 8 posts per account and 3 per level; paid posts excluded; TRY -> DEFAULT only with >= 8 posts per side in a second window; Craft 11's "3 posts below median retires a rule" dropped (fires ~1 in 8 on a rule that still works) | daily sweep, weekly weights | < $1 per month; a weekly public-grid read (~$0.006 per client) for unconnected clients such as N°3 and XO |
| 4 | Feedback -> auditor | one inbox `lesson_candidates`: owner notes, the 06 Agent Improve sheet, middleware `client_feedback_log`, staff gate notes, ratings, `templateFeedback`, `clientAgentFeedback`, #214 edit pairs, #217 draft conversations | the rubric of 2.4; lesson candidates with kind, layer, extent per client; tickets; DNA and pack lines | a remark is never evidence; a claim gets only the scope its evidence reaches; owner statements superseded, not aged; owner-vs-data conflicts back to the owner | weekly (Monday) plus per owner batch, with an Opus alignment review | ~$10-15 per month |
| 5 | Grouping leaderboard | monthly, first Monday after the refresh; event run when the pool grows >= 15% or a new pack opens | every card, descriptive tag and challenger tested (splits with >= 20 accounts per child, merges, candidate cards: price tier, motive, voice, account type); facet states watch -> candidate -> performance -> demoted; `relevance_weights` (Shapley share of the best additive model, floored at 0, normalised); registry PRs | nested-CV k over {1,3,10,30,100}; 999 shuffles re-tuning k inside each; BH across everything tested; restricted permutation inside source clusters; drop-one-source-cluster; forward skill on new accounts with a bootstrap CI; carousels-only; noise ceiling (split-half); **a size-matched random-label negative control invalidates the run if it passes**; every run writes a heartbeat entry even when nothing changed; append-only `evidence/facet-skill-leaderboard.jsonl` | monthly; ~40 min CI at 250 accounts | < $1 (CPU) |
| 5b | Benchmark growth | same job | 30 accounts a month: 20 fill slots by deficit (targets: each archetype >= 20, each involvement >= 40, each feasible archetype x involvement cell >= 8 from >= 3 source clusters, each category >= 12 across >= 2 archetypes, each non-English locale in >= 3 categories), 5 client-peer slots, 5 random exploration slots; candidates from coauthors, @mentions and credits already scraped | eligibility: public, >= 10k followers (2k for place), >= 6 posts in 60 days, >= 36 scraped, >= 30% carousels or images, handle verified; no source cluster above 20% of the pool; a cell empty after 2 discovery months is marked structurally empty | monthly | ~$10 per month at 250 accounts, ~$15 at 400; one-off catch-up ~$27 (tag the 99 already-scraped accounts and re-tag the 89 with the Haiku tagger) |
| 6 | Competitor watch tiers | weekly score, quarterly re-verify | tier per client and account from `R = 100 x (0.50 S_cards + 0.30 S_market + 0.20 S_signal)` where `S_cards` uses the leaderboard's relevance weights, `S_market = sameCategory x (0.5 sameLocaleMarket + 0.5 overlap)` from the portal's existing overlap field, and `S_signal = activity x measurability x (0.6 outlierRate_shrunk/registryP75 + 0.4 craft/5)`; tiers close (5, weekly delta read, feeds L3 directly: saturation, first-mover, launches, RFC-26 role `competitor`), peer (6, every 2 weeks, the client's market evidence table, role `reference`), aspirational (3, monthly, design DNA and craft only, never performance weights), benchmark (12-20 per category, monthly per category, the L1 pool), dormant | a tier changes only when two consecutive monthly runs agree; staff pins apply at once and are logged; manual and lab competitors have a relevance floor; the SEO/GEO tracked-5 (`llmMentions`) is untouched; every account gets one vote in L1 whatever its tier; each watched account's predictive value (rank correlation of its trait lifts with the client's own, >= 8 measured own posts) demotes after 3 months at or below 0 and promotes after 2 months in the top quartile | weekly | < $1; per client ~$0.20 close + $0.12 peer per month; per category ~$1.35 |
| 7 | Guideline regeneration | after loop 5, monthly; DNA diffs weekly from loops 3 and 4 | one PR: numeric sections (n, medians, baselines, norms where a level is used in >= 70% of posts by >= 70% of a category's accounts) regenerated deterministically and auto-merged when no threshold is crossed; pack inventory drafted by Sonnet from the category's pool tags for Anna; L1 pooled claims that passed for Albert; DNA diffs with evidence ids | CI: standards-only lint (an L2 performance line fails unless its facet is earned), one owner per key, budgets (pack <= 25, DNA <= 15, <= 3 TRY per doc), evidence refs resolve, MUST names its enforcer; review dates TRY 30 d, L3 90, L2 180, L1 365; the client-facing "what we learned" line comes from the DNA diff and never mentions review | monthly | ~$6 per month |
| 8 | Cross-industry transfer | a pattern credible in one cell (>= 8 accounts, sign test) | stage 1 offline: leave-category-out on the rest of the pool and on facet-mates; holds broadly -> L1 candidate; holds in facet-mates -> evidence for loop 5; untestable -> stage 2. Stage 2 live: the **mechanism** transfers, the **value** comes from the target's pack and DNA; every 10th scheduled run per client (1 in 5 while the queue holds > 8 items), deterministic by post number, never manual; one dimension fleet-wide per month chosen where the pooled posterior is widest; propensity in `run-state.assignment`; promote after >= 20 experiment posts from >= 3 clients in >= 2 categories with the 90% lift interval above 1 and point estimate >= 1.10; kill when the 80% upper bound is below 1.05 or after 2 months | never against a hard gate, the brand kit or forbidden topics; same review as any draft; >= 5 posts per arm before a read; clients that cannot measure hold their queue; internal only (D34) | offline monthly; live from week 8 | $0 (uses runs already scheduled) |

The transfer queue today is the 31 surviving rows in `auditors.json` `transfers` (2-6 per client; high-priority examples: X-01 anniversary story-behind and X-02 upstream first-mover to Geektime, X-03 owned-data series to Karos, X-05 object-cover and X-06 rule-change first-mover to XO, X-08 archival "then" to Hanky Panky, X-13 all-video carousel to The Pitch, X-17 official-date first-mover to N°3). It is roster-only; the ~60 enriched non-roster accounts (Glossier, Bon Appetit, Nubank, Canva, Porsche, Aman) have not been mined yet, and P-2's standing trend-watch is what keeps the table from freezing at the 2026-09-24 corpus.

---

## 4. Impact on today's code

### 4.1 Changes by repo

**agent-engine** (main c6be6d16)

| Where | Today | Verdict |
|---|---|---|
| `editorial-series.ts:657-760` `CLIENT_SEGMENTS`, `SEGMENT_TABLE`, `readClientSegment`, `seriesLibraryFor`; called at `create-instagram-agent-workflow.ts:2421` | regex over brief words picks 1 of 5 segments for a +1 series affinity | **REPLACE** with the archetype card's `seriesAffinity` read from `profile.classification` (brand: head_to_head, by_the_numbers; place: field_notes, the_list; person: in_their_words, field_notes; publisher: the_breakdown, by_the_numbers; platform: head_to_head, the_playbook; business: in_their_words, the_breakdown; institution: field_notes, in_their_words). Keep the +1 nudge and the slug hash; `unknown` = no nudge. Gate payload `segment` -> `classification`. Legacy regex fallback marked `source: legacy-regex` for one week, then delete |
| `imagery-floor.ts:219-230` `PHOTO_FIRST_INDUSTRY`, `defaultPictureDensityFor`; resolved at `:1291-1354` (`postTypeSource: "industry-default"`) | regex on free-text industry | **REPLACE** with the category pack's `imagery` key (`photo-first` / `standard`), rung renamed `category-pack`. Misses Kindly Yours today (empty category). Delete after the backfill |
| `exemplar-library.ts:47-60` `INDUSTRY_BENCHMARKS`, `DEFAULT_BENCHMARKS`, `benchmarksForIndustry` (#279) | regex on industry -> 4 handles | **REPLACE** with `peersFor(classification)` from the register: subject peers (same pack, same language first) plus the top 3 shape peers (archetype + involvement + audience) from other categories. Don Techno matches the *news* row today; Kindly Yours gets reputeforge/semrush/buffer. Keep the regex as last fallback for one week |
| `exemplar-library.ts:319-366` `densityFromLibrary`, `photoLedShare`, `nicheHooksForCopy` | share of judged breakout *entries* | **KEEP, two fixes**: one vote per account (count an account's breakouts once, require >= 3 distinct non-client accounts); photo-first only when the breakouts' photo-led share is at least the harvested base share (a convention is not a lift) |
| `instagram-exemplars.ts:162-206` (RFC-26 scorer) | within-account, within-format median lift; hidden likes unranked | **KEEP** as the one scorer. Add: exclude pinned and paid, exclude or age-project < 96 h, rank hidden-like stills on the comments basis instead of parking them |
| `topic-engines.ts:193 scoreReferencePosts`; `social-history.ts:18 POSTS_PER_ACCOUNT` | z-score over 12 newest, hidden likes as 3, formats from caption text | **REPLACE** with the shared `scoreWithinAccount()` (3.0). Two scorers exist today, one right and one wrong |
| Industry as a research seed (IG 03 seed `:1216-1238`, `:4446-4458`, `:4872-4915`; `social-trend-scout.ts:137`; X/LinkedIn/TikTok seeds; `harvest-query.ts:107`; `client-brief.ts:408-463`) | free-text industry fills search queries | **KEEP**. This is correct category use (what the content is about); keeps reading `profile.industry` |
| `learning-context.ts:281` C7 craft L2 slot | renders L1/L2/L3 rules; no rows exist | **KEEP, empty by design**; standards live in card files, not `craft_rules` |
| `post-performance.ts:64 PostPerformanceRecord` | no record of what the client is | **ADD** `classification` snapshot `{archetype, category, involvement, audience, locale, v}` and `peerRefs[]` |
| `packages/core/src/types/recipe.ts` (new), `10-write-run-state`, `RunStateRecordInputSchema`, deliverable | no recipe or provenance recorded | **ADD** the write-back of 2.2 (`recipe`, `guidelines {dna@v, kit@v}`, `provenance`, `rulesApplied`, `assignment`); `readPerformanceStore` keeps it |
| `packages/workflow/src/primitives/guidelines.ts` (new), `01a-read-guidelines`, `facets/{registry,archetype,involvement,locale}.json`, `facets/category/<key>.json`, `ig-kit-*` / `ig-dna-*` in `prompt-registry.ts`, `scripts/check-prompts.ts checkGuidelines()` | no loader, no cards | **ADD** compileDNA v0 (three keys first: series affinity, imagery, peers), then the full card set; CI lint per loop 7 |
| `04h-select-format`, `04i2-select-series` (`chooseLevel`); experiment doc reader | seeded variety pick, `EXPLORATION_RATE 0.2` | **ADD** the experiment draw (loop 8) with propensity logged; the existing seeded picks become `assignment.policy: variety` with propensity 1/eligible for free |
| `packages/tools/karos-research/src/account-cache.ts` (new) + weekly market-scan job | every consumer scrapes on its own | **ADD** a platform-level per-handle cache (`research/instagram/<handle>/posts-<date>.json`) reused by the scan, RFC-26 harvest (< 7 days old), topic signals and the monthly storm; port DT `market.py` to write `context/learning/instagram/market` |
| `classifyAccount()` (new, `karos-research` or `karos-client`) | none | **ADD** the shared Haiku classifier + calibration script against the 89 hand labels |
| `scripts/benchmark/{plan_month.py, discover.py, tag_batch.ts, label.ts, leaderboard.py, promote.py}`; `docs/guidelines/evidence/{benchmark-register.jsonl, facet-skill-leaderboard.jsonl, card-registry.json}`; `.github/workflows/benchmark-monthly.yml` | `scratchpad/{robustness.py, check2/jackknife.py, compounding/check3.py, relevance/kernel_test.py}` | **ADD** as the monthly job (loop 5); the scratch scripts are the prototypes |
| `.claude/skills/guidelines-auditor/SKILL.md` | none | **ADD** intake and regenerate modes (loops 4 and 7) |
| `PostPackageSchema` (`post-package.ts`) | no collaborator or credit | **ADD** `collaborator` (only when a source confirms the account) and `credit`; `08c1` fails a package using third-party media without a credit |

**agent-middleware** (main 7f8bee8)

| Where | Verdict |
|---|---|
| `migrations/0007_learning_loop.sql:51-52 learning_settings.sector`; `learning_store.py:124-163, 725-742` | **KEEP the column; its value becomes the category pack key** (e.g. `fashion-intimates`), written by the portal through the existing `PUT /clients/{slug}/learning/{platform}/settings`, which nothing calls today. No migration now |
| `craft_rules` L2 rows | **KEEP, empty.** Migration 0009 (`facet`, `facet_value`, CHECK) only when a card passes the gate |
| `run_state_records.record` jsonb | carries `recipe`, `classification`, `peerRefs`, `provenance`, `assignment` from `collect`. No migration |
| `app/services/client_context.py _COMPETITOR_FIELDS / build_competitors` | **ADD** `instagramHandle`, `handleVerifiedAt`, `cards`, `watchTier`, `relevance.score` into `client/competitors.json`; project `Client.classification` |
| Phase A: `jobs/learning/` (Python Cloud Run jobs: `pool_tag`, `leaderboard`, `l1_pooled_test`, `l3_weights`, `watch_rescore`, `transfer_eval`) over the GCS pool | **ADD** when the analytics leg runs in production (or run them as engine research jobs; open question) |
| Phase B (~20 clients or month 3): migration 0009 with `benchmark_accounts`, `pool_posts`, `post_tags`, `post_captures`, `leaderboard_runs`, `facet_states`, `competitor_watch`, `experiments`, `lesson_candidates`, `lessons`; `craft_rules` extended (`dimension`, `vocab_key`, `params`, `locale`, `origin`, `evidence`, `weight`, `state`, `review_after`); `POST /learning/captures`; project `what-works`, `market`, `watch`, `experiment`, `post-dna` via C7 | **ADD later**; retires the portal's direct GCS write from #207 |

**karos-portal** (HEAD df0c7a09)

| Where | Verdict |
|---|---|
| `src/lib/types.ts:93-120 Client.category` (free text) / legacy `industry` | **KEEP** both. Category text feeds search, SEO/intel, copilot and `profile.industry` |
| `Client.classification` (new, 4.2) | **ADD**; staff-editable only on client settings beside category; saving logs who and why and calls `writeLearningSettings(slug, platform, {sector})` (new, `learning-feedback.ts`) |
| `context-doc-projection.ts:252-266 toProjectedProfile` | **ADD** `classification` to `client/profile.json` (engine `get-profile.ts` schema is loose, backward compatible) |
| `client/competitors.json` projection (new) | **ADD**. `list-competitors.ts` says "no canonical producer exists yet", so portal-tracked rivals never reach the RFC-26 harvest. Rows `{name, website, instagramHandle?, classification?, watchTier?, relevance?}` |
| `ClientCompetitor` (`types.ts:1921`) | **ADD** `instagramHandle`, `handleVerifiedAt`, `cards`, `watchTier`, `relevance {score, cards, market, signal, weightsVersion, computedAt}`, `signal {...}`, `tierPin {tier, by, reason, at}`, `predictiveValue {rho, n, months}` |
| `competitor-priority.ts:30-36 autoSeedScore` | **KEEP** for the SEO/GEO tracked-5. **ADD** `competitor-relevance.ts` (pure, client-safe, tested): `S_cards`, `S_market`, `S_signal`, `R`, tiers, caps, hysteresis; `computeSocialWatchList` beside `computeTrackedCompetitors` |
| `scripts/import-lab-client.ts:292-422` | **ADD**: read `clients/<slug>/profile/classification.json` from the lab so a re-import never erases it |
| Cloud Scheduler for `/api/analytics/sync`, `/api/agent-engine/reconcile`, plus weekly learning routes | **ADD**. Without it loops 3, 6 and 8 have no input |
| `api/analytics/sync/route.ts`, `analytics-providers.ts`, `performance-signal.ts`, `materialize.ts` | **CHANGE**: append captures with age (48 h, 7 d) instead of overwriting one row; `instagram_business` fetcher keeping reach, saves, shares; weekly public-grid fallback (~$0.006 per client) for unconnected clients; copy `deliverable.recipe` -> `asset.meta.recipe`; what-works by recipe level, not templateKey; #215 best-hour slot with the same shrinkage |
| `learning-feedback.ts`, `agent-engine-actions.ts` (gate notes, ratings, templateFeedback), `client-agent-feedback-actions.ts`, #214 edit pairs, #217 draft conversations | **ROUTE** every channel into the `lesson_candidates` inbox with run and slide ids; keep Reddit's `reasonCode`, `subreddit`, `selectedApproach`; add a skip signal for Instagram |
| Internal control room (D34) | **ADD** leaderboard, register (with source client and tags), watch tiers per client, DNA diffs, experiment of the month; the client-facing "what we learned" line never mentions review or approval |
| Account Center Competitors tab | **ADD** tier chip, R and which cards matched, staff pin/demote with a logged reason, staff confirmation of close-tier cards |

### 4.2 Classification fields

```ts
// src/lib/types.ts (portal); the same shape in profile.json, the lab classification.json and register rows
export type Archetype = "brand"|"place"|"person"|"publisher"|"platform"|"business"|"institution";
export type Involvement = "none"|"low"|"high";
export type Audience = "B2B"|"B2C"|"mixed";
export type Locale = "en"|"he"|"pt-BR"|"es"|"fr"|"multi";
export interface ClientClassification {
  archetype: Archetype;
  category: string;            // pack key, kebab-case, from the open registry; never "other"
  involvement: Involvement;    // of the PRIMARY revenue line the feed converts
  audience: Audience;
  locale: Locale;              // jurisdiction derived: he->IL, pt-BR->BR, fr->FR
  rationale: Partial<Record<"archetype"|"category"|"involvement"|"audience"|"locale", string>>;
  source: "classifier"|"staff"|"research-2026-09-25";
  classifiedAt: number; classifiedBy: string; version: number;
  productLineOverrides?: Array<{ productLine: string; involvement: Involvement }>;
  neighbour?: Partial<{ archetype: Archetype }>;  // declared boundary case, e.g. dontechno publisher~person
  archetypeSub?: string;                          // descriptive from day one (news vs curation, creator vs expert, ...)
}
```

Descriptive tags recorded but selecting no rules: `content_job`, `visual_dependency`, `size`, `industry` (free text), motive lean, `archetype_sub`.

### 4.3 Migration of the 9 clients

`scripts/backfill-client-classification.ts`, dry-run by default, prep then prod (`FIRESTORE_DATABASE_ID`). For lab-owned clients it also writes `karos-agents/clients/<slug>/profile/classification.json`, then re-projects `profile.json` and `competitors.json` and PUTs middleware `sector` per loop platform. Engine fallback while `classification` is absent: derive from the legacy regexes, marked `source: legacy-regex`; remove once all 9 are backfilled. After the backfill delete the `instagramExemplarLibrary` belief for dontechno, kindlyyours and sitti so it rebuilds on the right peers (~$0.13 each).

| slug | archetype · pack · involvement · audience · locale | behaviour change vs today |
|---|---|---|
| karoslabs | business · marketing-advertising · high · B2B · en | segment agency-creator -> business (series in_their_words, the_breakdown); B2B modifier 50:50 |
| geektime | publisher · tech-business-news · none · mixed · he | series the_breakdown / by_the_numbers; subject peers become the Hebrew publishers (calcalist, themarker_online, globesnews, ynetgram, push.il) instead of the English news row |
| thepitchbydeel | institution · startups-venture · high · mixed · en | segment unknown -> institution |
| hankypanky | brand · fashion-intimates · low (AOV rationale logged) · B2C · en | none (photo-first already) |
| kindlyyours | brand · fashion-intimates · low · B2C · en | **photo-first ON** (was off, empty category); intimates peers instead of reputeforge/semrush/buffer; also set `category` and the domain (decision 8) |
| sitti | platform (neighbour publisher) · travel-local-discovery · low · mixed · en | photo-first ON; shape peers platform/low (mapstr, beli_eats, mindtrip.ai) |
| xodigital | platform · personal-finance-investing · high (regulated) · B2C · pt-BR | claims BR list via pack; series head_to_head / the_playbook |
| dontechno | publisher (neighbour person) · music-nightlife · none · B2C · en | **peers music** (boilerroomtv, defected, mixmag, ra_news, cercle) instead of wired/morningbrew/visualcap/evolving.ai; photo-first ON |
| n3 | place · luxury-hospitality-real-estate · high · B2C · fr | first `place` account and first `fr` locale in the benchmark; new pack; measured only by the public-grid read until a scraper key exists |

Register re-coding of the old 8 labels onto the 7 cards: software/app + marketplace -> platform; B2B service -> business; creator + educator -> person; media -> publisher; product brand -> brand; program/event -> institution; place filled by N°3's accounts. First backfill: N°3 (the ~17 Courchevel and luxury-hospitality accounts already scraped, 7 more to verify) and XO (13 scraped pt-BR finance accounts, plus confound breakers: en fintech coinbase, blackrock, franklintempleton, nyse, revolut, monzo; pt-BR outside finance farmrio, melissaoficial, cocobambuoficial). About $4-6.

### 4.4 Build order, in small PRs

Each PR is independently shippable and additive; the numbers are the dependency order, not a sprint plan.

| # | Repo | PR | Depends on | Size |
|---|---|---|---|---|
| 1 | engine | Shared `scoreWithinAccount()`; shape fields on `SocialHistoryPost`; 36-post time window; eligibility filters in `instagram-exemplars.ts`; handle verification | - | ~1 day |
| 2 | engine | Recipe, provenance, `rulesApplied`, `assignment` write-back on run-state and deliverable; `PostPerformanceRecord.classification` + `peerRefs` | - | ~1 day |
| 3 | portal | `Client.classification` + settings editor + `toProjectedProfile` + `writeLearningSettings` | - | ~1.5 days |
| 4 | portal + lab | `backfill-client-classification.ts` for the 9 clients; lab `classification.json`; `import-lab-client` reads it; delete the 3 stale exemplar beliefs | 3 | ~0.5 day |
| 5 | portal | `client/competitors.json` projection; `ClientCompetitor.instagramHandle` and friends | 3 | ~0.5 day |
| 6 | engine | compileDNA v0 reading `profile.classification` for series affinity, imagery and peers; legacy-regex fallback one week; then delete `SEGMENT_TABLE`, `PHOTO_FIRST_INDUSTRY`, `INDUSTRY_BENCHMARKS`; one-vote fixes in the library | 1, 3, 4 | ~2 days |
| 7 | portal | Cloud Scheduler jobs; capture history with age; `instagram_business` fetcher; public-grid fallback; `asset.meta.recipe`; what-works by recipe level | 2 | ~2 days |
| 8 | engine (research) | Benchmark register v1 (89 rows -> ~200 after tagging the ~99-110 scraped accounts); classifier calibration; leaderboard entry #3 with nested-CV k, then #4 (first forward test on the enriched accounts) | 1 | ~1 day, ~$3-10 |
| 9 | engine | Guidelines loader + `01a-read-guidelines` + card files + `checkGuidelines()` CI + the next `instagram-copy` version documenting `craftRules` and precedence | 6 | ~3 days |
| 10 | engine + portal | Peer watch score, tiers, weekly close-tier scan, account cache, market doc; portal `competitor-relevance.ts` + Competitors tab | 5, 7 | ~2 days |
| 11 | engine + portal | Auditor skill; all feedback channels routed to `lesson_candidates` | 2, 9 | ~2 days |
| 12 | engine | `scripts/benchmark/*` + `benchmark-monthly.yml` (loop 5 as a cron PR) | 8 | ~2 days |
| 13 | engine | Experiment slot in 04h/04i2 with propensity; offline transfer stage | 2, 7 | ~1 day |
| 14 | middleware | Phase A jobs, then Phase B migration 0009 at ~20 clients or month 3 | 7, 12 | later |

Two things gate the whole plan and are not code: the D45 scraping carve-out (decision 11) and staff confirmation of the 9 classifications (decision 10).

### 4.5 Cost per month

| Loop | 10 IG clients now | 25 clients |
|---|---|---|
| 1 onboarding (~3 new/month) | $8-10 | $10-12 |
| 2 pool refresh + tagging + close-tier scans | $12-15 | $20-25 |
| 3 own posts | < $1 | ~$1 |
| 4 auditor + parse + Opus review | $10-15 | $15-20 |
| 5 leaderboard + benchmark growth | ~$10 | ~$15 |
| 6 watch tiers | < $1 | ~$1 |
| 7 regeneration | ~$6 | ~$8 |
| 8 transfer | $0 | $0 |
| **Total** | **~$45-55** | **~$70-80** |

Per run: $0 (compileDNA is pure; the guidelines add ~1.2-2K input tokens per copy attempt from two cached Firestore reads). One-off backfill for current clients ~$15-25 plus the ~$27 tagging catch-up. Human time: Anna ~45 min a week, Albert ~30 min a month. For scale: one Instagram run averages $1.67, so the whole learning system costs about 25-45 runs a month.

---

## 5. The guideline set

All files live in [`guidelines/`](guidelines/). `_src/*.py` is the single content source; `render.py` regenerates every document with budget checks and fails on a violation.

| File | What it holds | Consumer |
|---|---|---|
| [`README.md`](guidelines/README.md) | the stack, validation rules, line format, client mapping, key ownership, rows dropped or narrowed, 23 defects mapped to WS-01..13 with their guards, the 24 owner decisions | humans |
| [`L1-platform.md`](guidelines/L1-platform.md) | 37 params with evidence and named overrides (canvas, safe zones, `textSizesPerSlide`, H/T/S floors, `coverWords`, `interiorWordLanes`, `slideCountBand`, `photoShareMin`, `devicesPerSlide`, `graphicsMix`, `iconBand`, `designLanguage`, `scrim`, `contrast`, `logo`, `aiImagery`, `stock`, `screenshotsPerDeck`, `thirdPartyShareMax`, `caption`, `cadence`, `dedupe`, `loop`, `freshness`, `timeliness`, `deadSpaceMax`, `register`, `questionForm`, `headlineTier`, `reels`, `marketRead`, `performanceSurprise`, `layoutRepeat`); 69 lines (MUST gates with their enforcer, DEFAULT mechanisms, TRY experiments, nulls as noise) | `compileDNA` params; MUST -> gates; DEFAULT/TRY -> `LearningCraft` |
| [`facet-archetype.md`](guidelines/facet-archetype.md) (9 lines), [`facet-involvement.md`](guidelines/facet-involvement.md) (6), [`facet-locale.md`](guidelines/facet-locale.md) (5) | the card params and standards of 2.1; the facet gate as a MUST line; locale readable-copy packs (en, he, pt-BR, fr) | `compileDNA` step 2-4; the readable-copy lint reads the locale pack |
| `ig-kit-<category>.md` x 8 (21-23 lines each) | marketing-advertising, tech-business-news, startups-venture, fashion-intimates, travel-local-discovery, personal-finance-investing, music-nightlife, luxury-hospitality-real-estate. Header: cards and locale; Params: the pack's values for the L1 keys it owns; Lines: entry points, compliance, conventions, TRYs with evidence refs | `compileDNA` step 2 (values); lines -> `LearningCraft` L2 |
| `ig-dna-<slug>.md` x 9 (15 lines each) | classification record; Params: fonts, palette, logo (variant, position, treatment, presence; size always "L1 equal-area"), device vocabulary, sizes, word caps, caption, ask set, hashtag pool, emoji budget, cadence, dedupe windows; Lines: the pinned system, type jobs, voice, skips with reasons, transfer TRYs with the twist | `compileDNA` step 5; lines -> `LearningCraft` L3 |
| `guidelines.json` | complete machine copy of everything above (03:05) | the loader, once registered |
| `guidelines.payload.json`, `guidelines.compact.json` | abridged copies, **stale** (02:29-02:30, older than `guidelines.json`); anything consuming them reads v1. Regenerate before use | - |
| `_src/resolved.py` | a hand-kept per-DNA block of resolved sizes, cover kind and logo block that `render.py check_resolved` validates against the L1 MUSTs | the validator (see gaps) |

Line format: `N. [STRENGTH][dimension] one sentence (evidence: row ids, statistics, sources)`. STRENGTH is MUST (a gate enforces it), DEFAULT, TRY or n/a. Statistics read "mean within-account difference over n accounts (positive+/negative-, sign p)" from `scale.md`, one vote per account.

How the engine loads it (layer judge, recommended design): register `ig-kit-*` and `ig-dna-*` in `scripts/prompt-registry.ts` next to the stage prompts; `check:prompts` in `quality.yml` runs `checkGuidelines()` (header parses, line ids unique and minted in the middleware `craft_rules` id space such as `ig-kit-fashion-intimates.07`, strengths and dimensions from the closed lists, every performance line resolves to an evidence id, every MUST names its enforcer, the named kit exists, params are known engine enums, budgets hold); `publish-prompts.ts` publishes them to Firestore `prompts/{id}` on deploy-prep and the manual prod promote; `readGuidelines(promptStore, 'instagram', clientSlug)` returns `{versions, params, craft, provenance}` and fails open with a "guidelines absent" readiness note exactly like the C7 files. The card JSON files (`facets/*.json`) are the machine form of the three facet cards and are what `compileDNA` merges; the `.md` files are their human form and stay the review surface.

Known gaps in v1.1 (from the verification), to fix in the first regeneration:

- `check_resolved` validates `_src/resolved.py`, a hand copy, not the DNA prose. It does not check scrim density (Hanky Panky ~45% black, XO >= 60% navy, Sitti a coral tint all pass against H-1's 86-90%), font-hold state, Geektime's uncapped cover title, and it classes Geektime's full-bleed photo template as a "card" (cap 20, not 16). The validator should read the DNA params directly.
- Several pack DEFAULTs still rest on fewer than 8 accounts as their main evidence (fintech lines 7 and 10, startups 2 and 7, marketing 9, luxury 5 and 7, intimates 5, music 6 and 14), against the header every pack now carries. The refuter pass in loop 7 demotes them to TRY or convention.
- REEL-01 and REEL-02's Mosseri and Trial Reels evidence is general knowledge, not a file in this folder; verify before approval.
- Five icon bands start at 0 (Geektime, Pitch, Hanky Panky, Kindly, travel beyond the pin), so a run can still legally add no icons; only Karos and XO have a floor of 1.
- The `loop` param promotes after "2 own posts above the own median" while an experiment read needs >= 5 per arm; align on 5.

---

## 6. Decisions the owner still has to make

From [`compile.json`](compile.json) and the README. Each with the data-backed recommendation; the ones marked **sign-off** go beyond what the owner literally said.

| # | Decision | Recommendation | Evidence |
|---|---|---|---|
| 1 | Logo corner default | Top-start (top-left LTR, top-right RTL); top-end only by brand rule (Pitch v4, Geektime tab) inset >= 112px below the counter pill; presence stays a client value with a B2B TRY for Karos | logo_position no L1 signal; B2B none 8+/1- p=0.04; the counter sits top-right (DS-13) |
| 2 | Logo precedence: does an upload beat the lab SVG even when the upload is a screenshot? **sign-off** | "Latest deliberate human choice wins, and a matching clean lab file is offered at staff approval"; take the lab file now for karoslabs, sitti, xodigital | each screenshot upload fails the background and tile checks (WS-05 fixtures); point F was about scraped substitutes |
| 3 | Label faces: Karos (Hanken caps / JetBrains Mono / DM Mono), XO (D5 Fraunces/Geist vs Plus Jakarta Sans) | Karos: DM Mono (the July grid and karoslabs.com). XO: Plus Jakarta Sans ExtraBold/Regular plus one mono (the measured house system; the serif cover did 0.78x) | storm-lead L3-02, L3-05 |
| 4 | Commercial font licences (Relais/Fabriga, GT Walsheim, Bagoss) | Ask each client for files and licence text; FONT_HOLD until then (drafts render, nothing publishes) unless a named substitute is signed off and shown on the gate card; confirm v4 Inter-only for The Pitch | A-2; the 24 Sept Pitch run painted Bagoss on #201547 with Deel's parent mark |
| 5 | Covers: capped full-bleed poster with an anchored shade by default, #244's framed card only on contrast failure. **Reverses #244, merged on your own XO feedback; needs explicit confirmation** | Yes; <= 16 words kicker included; XO's case is solved by the 12-word cap and its navy scrim, not by framing; XO keeps its plate default and runs the photo cover as a TRY | photo-dominant +0.21 99+/26-; full-bleed +0.06 79+/58-; text-only plate -0.09; XO's own set flat 5+/4- |
| 6 | Imagery: end RFC-24's three-generated-frames guarantee; `aiImagery: never` for sitti, xodigital (except the capybara), thepitchbydeel, hankypanky, kindlyyours, dontechno, n3 | Yes; `MIN_GENERATED_IMAGES_PER_RUN` 0; concept-labelled frames stay for karoslabs and geektime | 8 runs: 33 frames bought, 6 landed, ~$2.34 of $13.31; stock -0.11 p=0.03; AI-looking p=0.48 |
| 7 | Stat figure size | F = 1.5 x H as a slide's sole display element within 2.5:1 to T; a number that is the story becomes the headline with its unit | our 220px numeral over an 84px headline; 4+ sizes -0.11 p=0.0006 |
| 8 | Kindly Yours: domain, category, which wedding-favour runs to reject vs void | thisiskindly.com only if the client confirms; category intimates; reject one run at its gate, void two; delete the 14 gifting docs after a dry run; no run before `profileSource: lab` and the kit fonts land | the run sold wedding place cards with a "complimentary discovery consultation" |
| 9 | Hebrew copy pack reviewer | A native editor signs it; until then the pack flags but does not block; "at most one 'לא X.' per caption" is a soft limit | the reviewed run shipped five such fragments |
| 10 | Classification boundary picks | Hanky Panky low (AOV logged, re-check at ~$100); Don Techno publisher; Sitti platform (publisher neighbour); Geektime mixed with a per-run high override for events | involvement adds +0.31% over archetype (p=0.21), so boundary picks shift standards, not learned weights |
| 11 | D45 scraping carve-out from D43 (public posts, metadata and thumbnails only, aggregate use, 180-day retention, never shown as a client's numbers) plus RFC-26 consent for competitors' public posts | Approve. Without it the market study, the transfer table and the leaderboard cannot refresh and every L1 line freezes at the 2026-09-24 corpus | ~$10 a month at 250 accounts |
| 12 | Facet skill gate (2.3), and category packs standards-only until they pass the same gate | Yes, but not permanently: involvement is closest and fails carousels-only; a pack line under ~8 accounts is a convention or TRY; the monthly pooled pass may propose pack TRYs meanwhile | robustness-v2; carousels-only every card fails except audience |
| 13 | Hanky Panky long-caption TRY (X8) against the house 148-char maximum | Run it as a 5-post experiment judged on saves per reach, giveaways excluded; no default changes | intimates long 8+/0- is contest-driven |
| 14 | Don Techno caption asks (X12, X-16) against DT's no-CTA rule | Keep no-CTA; X12 only on anniversary posts as a signed-off 5-post experiment on the comment index; park X-16 | no-CTA 14% vs 12%; oeak's repeated ask decayed to 0.5-0.8x |
| 15 | N°3: approve the quiet place question (X13); resolve address, spa and services contradictions | Approve X13 once measurement is live; written client answers before any maison-lane post; prices off every post | `legal.json` claims_to_confirm |
| 16 | CTA style across the roster | Remove link-in-bio and follow closers everywhere; one caption ask from the kit set or none; "none" default for publishers; house pointer lines do not count as the ask | link-in-bio -0.13 p<0.001; a16z end cards 0/11 |
| 17 | Font substitutes per client (a kit-declared substitute no longer counts as the client's face) | Hold Hanky Panky and Kindly until files arrive; approve JetBrains Mono for Don Techno (SF Mono's licence very likely excludes social images); settle #3 for Karos and XO | A-1/A-2; the loophole the alignment review found |
| 18 | Logo sizes: every DNA loses its hand-set size for the equal-area rule (Geektime 24-28% -> <= 240px, Hanky Panky ~30%, DT 160px box -> ~70px; XO drops its second mark; Sitti one bottom-right position) | Accept; record any exception in the `BrandLogoSpec`, never in a DNA, with a side-by-side render first | v1 DNAs broke the 240px cap |
| 19 | Icon bands per kit (marketing 1-3 per 8 slides, fintech 2-4, tech news 0-2, startups 0-2 in pills, intimates 0-1 on cards, travel the pin, music and luxury 0) | Confirm; count the band in set integrity; judge icons on saves and sends per reach | icons -0.09 18+/38- measured unlabelled decoration; data icons 2.67 in fintech |
| 20 | Word caps: hard cap 50 -> 35 per slide; full-bleed photo cover <= 16 words, plate or card <= 20 (Geektime's lane 30-50 -> 25-35; XO interiors ~30 -> 25 plus a graphic) | Yes; a code-built graphic replaces prose first, the rest folds into the caption | a16z explainers 25-54 words 0/5; our runs 39-44 per slide |
| 21 | Complete sentences as a MUST with a label exemption list (names, eyebrows, series labels, kickers, credits, sources, badges, pills, chart and icon labels, step indices, a fixed house pointer, hashtags); removes Sitti's fragment-lint exemption and luxury's "often no sentence" | Confirm; Sitti keeps lowercase, no-period casing (casing is a DNA value); a DNA may not widen the list | fragments -0.07 48+/83- p=0.003 |
| 22 | Experiment throughput: 1 in 5 while a client's queue holds > 8 items; >= 5 posts per arm; hold queues for clients that cannot measure | Yes; at 1 in 10 Karos's ~20-item queue takes over a year and 2-3-post reads are noise; small accounts read on saves and sends per reach and non-follower reach; new reel formats first as Trial Reels | P-1/P-2 |
| 23 | The Pitch and a16z: discipline, not look | Confirm; the a16z families (archival "then", manifesto, subtitled stills) stay TRYs on the v4 kit | O-1/O-2 |
| 24 | Spend: run budget untouched; cost rule "code before model calls, graphics before generation"; no new holds | Confirm; the only new cost items are the weekly own-grid read (~$0.01 per client), the incremental weekly market scan (~$0.07; a full re-read would be $30-90 per client per week) and one classification call at onboarding | R-1; dt.json |

Engineering-level choices the designs leave open and Tomer can propose (Albert decides): gate wording for the drop-one test (LOSO minimum >= 50% of full skill and > 0, as proposed, or the judge's absolute >= +0.01); register home (engine JSON reviewed by PR now, middleware tables later, or straight to middleware); Phase A jobs in middleware Cloud Run or as engine research jobs; switching the tagger from the storm's Sonnet agents to Haiku Batch and re-tagging the 89 (~$10) so the pool has one instrument; benchmark ceiling (~300 accounts, <= 30 tagged posts per account per month); trial clients under $1: auto-accept the classifier's picks with staff confirmation later, or block the first run; whether involvement stays standards-only if forward testing keeps showing it adds little over archetype; whether card deltas apply only to formats where the carousel slice confirms them; whether high-involvement types need a second outcome (sends and saves per reach, link clicks) before their deltas ship.

Contradictions left in v1.1 that the validator does not catch (each needs a one-line ruling; most are "the DNA follows L1" or "record the exception in the spec"):

1. Sitti, Hanky Panky and XO scrims (coral/pink tint; ~45% black; navy >= 60%) vs H-1's 86-90% dark band with no density override.
2. The Pitch logo below the counter "unless the owner confirms an exception" vs DS-13, a MUST safe zone that takes no DNA-level exception.
3. Geektime's cover title cap is only a TRY (5-9 words, "best covers carry three more") and its full-bleed photo template is classed as a card, vs H-2's hard 16.
4. Geektime's navy-plate template carries a 68-76px headline vs C-2, which allows sub-96px only on photo-hook covers.
5. Karos and XO render interim faces (Hanken caps, Plus Jakarta caps) while decision 3 is pending, vs A-2's "an undecided face is also a hold"; XO's lines still specify mono badges and a mono eyebrow.
6. The Pitch's "01" step numerals at headline size vs C-1 (no decorative index numerals) and C-5 (a step index sits in meta at S).
7. Sitti's "JetBrains Mono for stats if the founder confirms" vs C-5 (a declared mono sets numerals only inside meta).
8. Kindly's logo "over a colour field on photos" vs E-1 (never a plate unless the client's own lockup is a badge).
9. Don Techno's STORY preset lists four sizes (32 / 48 / 96-120 / 60) without saying which slide carries which; if kicker and body share a slide, 48 -> 60 is 1.25x, under the 1.35x minimum.

## 7. Known open items in the guideline set (from the final verification)

- **Scrim density.** Three client DNAs set a lighter shade than L1 rule H-1 allows (86–90% of the kit's dark ground): Sitti (coral/pink gradient), Hanky Panky (~45% black) and XO (navy ≥60%). Either H-1 gains a per-client density override backed by a contrast measurement, or these DNAs move to the L1 band.
- **The Pitch logo.** Its DNA allows an owner exception to the counter safe zone (DS-13, a MUST). A MUST can't take a DNA-level exception, so the exception must move to L1 or be dropped.
- **Geektime cover cap.** Its DNA treats the title cap as a TRY. H-2 needs a numeric cap for its photo-plus-card template.
- **Small-n DEFAULTs.** Some pack lines resting on fewer than ~8 accounts still read as DEFAULT (e.g. fintech save/share, marketing question hooks). The S-1 refuter covers them; they should be reworded as conventions or TRYs.
- **Validator drift.** `_src/resolved.py` is a hand-kept numeric copy of each DNA's sizes until compileDNA (WS-01) compiles the checks from structured params.
- **Font publish hold (needs the owner).** A-2 now puts a client on FONT_HOLD (drafts render, nothing publishes) until a licensed face or a signed-off substitute exists. That is stricter than the earlier "no new holds" rule; the owner decides.
