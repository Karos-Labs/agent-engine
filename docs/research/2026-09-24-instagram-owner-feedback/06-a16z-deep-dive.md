# @a16z on Instagram: deep dive and playbook for The Pitch by Deel

Prepared 2026-09-24 for Karos Labs. Subject: @a16z, Andreessen Horowitz's main account (not @speedrun). Compared against @deelpitch and against our last Pitch carousel (run `pubsub-21255292697877233`).

**Sources and method**
- Scrape (ScrappyCoco via `sc.py`, 2026-09-24 ~20:54 UTC): @a16z profile plus 72 posts (2026-06-15 to 2026-09-24); @deelpitch profile plus 36 posts.
- I viewed every a16z cover (72) and every carousel slide (237), not only the wrapper's best and worst sheets, and OCR'd all of them for word counts. Type sizes are pixel measurements of text bands on the slide files, converted to an estimated em size as a % of slide height (±10%). Background brightness behind text was measured the same way.
- Engagement = likes + 3 x comments. "x" = the post's multiple of the account median over the scraped posts (the wrapper's definition).
- Template labels are my own, one per post, from visual review (Appendix A).
- Client rules come from the lab brand kit (`karos-agents/clients/thepitchbydeel/brand/kit/brand.yaml`) and profile (`product-information.md`, `winners-roster.md`). Numbers for our run come from its manifest, type audit and graphics audit.
- Data caveats. (1) 5 a16z posts were under 3 days old when scraped. Two were under a day old, and both are on the wrapper's "worst" sheet (W1 at 23 hours, W3 at 36 minutes). (2) 3 a16z posts are collabs owned by other accounts, one of them pinned. (3) The #1 post's reach came from Roblox fans: its likes equal 92% of a16z's follower count. (4) @deelpitch has hidden like counts on every post since Aug 18, so its likes cannot be ranked.

---

## 0. Summary

1. **Carousels do the work.** They are 39 of 72 posts, with a median of 1.14x, and 12 of the 17 posts at 2x or better. Single images (0.80x) and reels (0.90x) sit below the median.
2. **Two families produce almost every breakout.** Archival "then" material about famous companies and founders went 5 for 5 at 2x or better (median 9.5x). One-line typographic manifestos went 3 for 4 (median 4.7x). The #2 post of the period is a manifesto that opens with "The builder who can pitch." (a16z, 2026-07-07), which is The Pitch's own territory.
3. **Recognition beats instruction.** 13 of the 17 outliers are built around a famous founder or company. Term explainers and trend charts (12 posts combined) produced no outliers.
4. **Strict type discipline.** Manifesto slides use one type size. Every other template uses two sizes plus a small meta line, and the largest type on a slide is always the message. 9 of the top 10 carousels carry 10 or fewer a16z-written words on the cover, and story slides carry 0 to 12.
5. **One system everywhere.** About 17 templates share one condensed display serif, one sans, a cream ground and a small muted wordmark.
6. **Photos that carry text are always darkened.** Behind a16z's text, the median background brightness is 7 to 34 out of 255. Behind our last cover's headline it is 71.
7. **Carousels end on the idea.** 0 of the 11 carousels that end on a "follow us" card reached 2x (median 0.73x). Of the 28 without one, 12 did (median 1.79x). Posts with a call to action in the caption: median 0.59x (n=11), against 1.02x for posts without one (n=61).
8. **Plain captions.** 0 of 72 captions use emoji, 2 of 72 use hashtags (both are collabs), and the first line restates the cover. List posts use the caption to carry per-slide detail, which keeps the slides short.
9. **Our last Pitch carousel breaks most of this.** It runs to about 340 words (42 per slide) and uses 14 distinct type sizes (6 on most slides): a 220 px decorative numeral sits over an 84 px headline. It uses three typefaces that are not in the client's kit, and its cover credits The Pitch with "six questions" the program never published.
10. **@deelpitch cannot be ranked on likes.** They are hidden. Plays are the usable signal: recent solo reels have a median of 354 plays, while the three reels co-posted from @getdeel drew 9.9k to 17.8k.

---

## 1. Account facts

### 1.1 @a16z at a glance

| Metric | Value |
|---|---|
| Followers | 209,990 (following 42). Bio link goes to jobs.a16z.com |
| Sample | 72 posts, 2026-06-15 to 2026-09-24 (101 days) |
| Cadence | 4.98 posts a week. 70 of 72 on weekdays. 52 of 72 posted 19:00 to 21:59 UTC (noon to 3 pm Pacific) |
| Format mix | 39 carousels (54%), 17 reels (24%), 16 single images (22%) |
| Carousel length | 2 to 12 slides, median 6 |
| Aspect ratios | Carousels: 30 at 4:5, 8 at 3:4 (all four manifestos use 3:4), 1 at 1:1. Reels: 11 vertical, 6 landscape 16:9 |
| Median engagement | 3,276 (1.56% of followers). Median likes 3,187, median comments 35.5 |
| Reel plays | Median 77,436. Max 1,377,190 (the pinned Flock collab) |
| Outliers | 2x or more: 17 (24%). 3x+: 11 (15%). 5x+: 6 (8%). 10x+: 3 (4%). 0.5x or less: 11 (15%) |
| Without the 5 posts under 3 days old | Median 3,196. 15 of 67 (22%) at 2x or more |
| By format | Carousels: median 1.14x, 12 of 39 (31%) at 2x+. Images: 0.80x, 2 of 16 (12%). Reels: 0.90x, 3 of 17 (18%) |
| Collabs | 3 posts are owned by other accounts with a16z as co-author (@flocksafety, pinned; @theacademy.sf; @atlasberry008). 7 a16z-owned posts carry co-authors |
| Trend | Median multiple by month: Jun 1.21, Jul 0.98, Aug 0.93, Sep 0.65. September includes the 5 very new posts and a run of podcast promos |

### 1.2 The 10 best posts

| # | Post | x | Format | Likes / comments (plays) | What it is |
|---|---|---|---|---|---|
| 1 | [DcwjRiNiiOz](https://www.instagram.com/p/DcwjRiNiiOz/) | 60.46 | Carousel, 10 slides, 1:1 | 192,915 / 1,720 | Roblox's 20th anniversary as an archive: 2000s photos, website and prototype screenshots, the logo's history, ending on the co-founder's own anniversary post. No a16z text or logo on any slide. The caption is a 176-word dated history with current metrics. |
| 2 | [DagNhHVColh](https://www.instagram.com/p/DagNhHVColh/) | 12.45 | Carousel, 7, 3:4 | 40,035 / 251 | Manifesto on oxblood and cream: four hybrid-skill archetypes (builder/pitch, storyteller/code, inventor/sell, operator/lead), then a turn, then a thesis. One centred line per slide. |
| 3 | [DcO918CCrze](https://www.instagram.com/p/DcO918CCrze/) | 10.22 | Carousel, 8 | 32,972 / 167 | Then-and-now meme pairs: Zuckerberg (dorm, then F8), the Collisons (then, Stripe Sessions), the Airbnb founders (office, then keynote), Dylan Field (hallway, then Config). One small serif label per slide. |
| 4 | [Db3xmzlCtd9](https://www.instagram.com/p/Db3xmzlCtd9/) | 9.49 | Carousel, 2 | 30,763 / 110 | Product photos of SpaceX's Raptor 1 and Raptor 3, with the exist-first, good-later maxim split across the two slides. The caption explains the delete-the-part engineering rule. |
| 5 | [DaBUKWiin89](https://www.instagram.com/p/DaBUKWiin89/) | 5.45 | Carousel, 10, 3:4 | 17,664 / 64 | Manifesto on navy and cream: first hires at Anduril, Coinbase, OpenAI and Facebook as fact-then-consequence pairs, closing on agency over credentials. |
| 6 | [DaTW9q_KMCM](https://www.instagram.com/p/DaTW9q_KMCM/) | 5.43 | Reel | 17,367 / 141 (273,349) | Archival footage of a young Elon Musk. The cover mixes italic and roman on one line. |
| 7 | [Dbn0-mlkwa_](https://www.instagram.com/p/Dbn0-mlkwa_/) | 4.52 | Reel, pinned | 10,198 / 1,538 (1,377,190) | Owned by @flocksafety with a16z as co-author: Flock Safety's missing-person calls. |
| 8 | [DbJzEL9Cs--](https://www.instagram.com/p/DbJzEL9Cs--/) | 4.49 | Carousel, 5 | 14,541 / 52 | Screenshots of founders' tweets about failure and persistence (Altman, Chesky, Musk, Luckey). No overlay text, no logo. |
| 9 | [DdUWVrYijmd](https://www.instagram.com/p/DdUWVrYijmd/) | 3.91 | Carousel, 7, 3:4 | 12,254 / 185 | Manifesto on slate and cream: five "old category, new company" reframes (hotels and Airbnb, theaters and Netflix, and so on), a generalization, then an imperative. |
| 10 | [DbO3-Anigry](https://www.instagram.com/p/DbO3-Anigry/) | 3.43 | Carousel, 5 | 10,665 / 186 | Subtitled stills of Ben Horowitz on Elon Musk: two video frames per slide, one subtitle line on each. |

Next in line: Ages of founders at their first company (DZ-tPqQitsv, 3.19x), Elon Musk's career timeline (DaI2rZRKHcj, 2.88x), the Academy launch film (Ddl6c2WK4jY, 2.65x), Elon Musk's commencement advice (DcRkt6pq5UW, 2.16x), famous companies' first versions (Dcy9JNLCvti, 2.07x), the Academy announcement (DdmC--cik7m, 2.05x) and tweets that changed the world (Dan8QUdCsnc, 2.01x).

### 1.3 @deelpitch alongside @a16z

| | @a16z | @deelpitch |
|---|---|---|
| Followers | 209,990 | 23,461 |
| Sample | 72 posts over 101 days | 36 posts: 3 pinned launch reels (Feb 17 to Mar 11, 2026, owned by @getdeel) and 33 posts from Aug 18 to Sep 24. Nothing was posted between those periods (5 months) |
| Cadence | 5.0 a week | 6.2 a week since Aug 18 |
| Mix | 54% carousel, 24% reel, 22% image | 16 carousels and 17 reels (the recent 33) |
| Like counts | Visible | Hidden on all 33 recent posts. Scraped likes read 1 to 3 and comments 0 to 1, so the wrapper's "median 3" and its "outliers" are artifacts |
| Reel plays | Median 77,436 | Recent 17 reels: median 354 (178 to 2,031), about 1.5% of followers. The 3 @getdeel-owned collab reels: 9,882, 11,504 and 17,799 plays (148 to 520 likes) |
| Words per carousel slide | 0 to 12 on top carousels (a16z's own words) | Median 44 by OCR (range 9 to 118) |
| Captions | Median 30 words, 0 emoji, hashtags on 2 of 72 posts | 51 to 146 words, 3 to 5 hashtags on every post |
| Visual systems | 1 (serif, cream, wordmark) across about 17 templates | 5 in 5 weeks: lined-cream "Pitch School"; purple "truth" cards with a globe watermark; purple-scrim event photos; purple quote-card reels with yellow highlights; black with an orange and purple glow (Sep 22 to 24). Our reviewed run is a sixth |
| Video | Its own podcast and films | Clips cut from third-party shows, with their bugs on screen: "From Sourcery", "From Giant Ideas", "From VentureFizz", Stanford GSB, "How I Invest". One Sourcery clip shows a Brex sponsor mark inside a Deel program post |

The recent carousels share our renderer's 2160 x 2880 canvas. Any real performance read on @deelpitch needs the owner's Insights (reach, saves, shares), not scraped likes.

---

## 2. The a16z system

### 2.1 Franchises and templates, ranked by median multiple

| Template (my label) | n | Median x | Posts at 2x+ | All multiples | What it looks like |
|---|---|---|---|---|---|
| Archival, famous company or founder (carousel) | 5 | 9.49 | 5 | 60.46, 10.22, 9.49, 3.19, 2.07 | Real period photos, screenshots or product shots. 0 to 6 a16z-written words per slide. Ends on the last item or on a primary source |
| Typographic manifesto | 4 | 4.68 | 3 | 12.45, 5.45, 3.91, 1.64 | 3:4. Ground alternates one ink colour and cream on every slide. One centred line, wordmark at bottom centre, 6 to 10 slides |
| Tweet screenshots | 3 | 2.01 | 2 | 4.49, 2.01, 0.30 | White tweet cards, nothing added. The 0.30 is a16z reposting its own tweet |
| Subtitled interview stills | 7 | 1.73 | 1 | 3.43, 1.93, 1.85, 1.73, 0.96, 0.63, 0.42 | Two stacked video frames per slide, one subtitle line on each |
| Principles with line diagrams | 1 | 1.50 | 0 | 1.50 | Ben Horowitz's guide: title, a navy line diagram that encodes the idea, one action sentence |
| Career timeline (single image) | 3 | 1.31 | 1 | 2.88 (Musk), 1.31, 0.79 | Round portrait, serif name, vertical list with company logos |
| Archival reel | 5 | 1.30 | 1 | 5.43 (Musk), 1.56, 1.30, 1.06, 0.73 | Old footage of famous founders, a few words on the cover |
| Advice letter, dense single image | 4 | 1.17 | 1 | 2.16 (Musk), 1.48, 0.85, 0.81 | Cream page, 240 to 414 words, handwritten signature |
| Lists (books, mentors) | 3 | 1.11 | 0 | 1.62, 1.11, 0.59 | Typographic book list, cut-out portrait pairs with logos |
| Firm and portfolio news, launches | 10 | 1.03 | 3 | 4.52 (Flock collab), 2.65, 2.05 (Academy), 1.11, 1.08, 0.98, 0.90, 0.83, 0.70, 0.57 | Fund, film and program announcements |
| Illustrated list | 1 | 0.73 | 0 | 0.73 | Duotone illustrations that look generated, with big italic numerals |
| Explainer (terms) | 5 | 0.72 | 0 | 1.03, 1.02, 0.72, 0.58, 0.46 | Diagram panel above, term and definition below, a "1/N" counter. Declines over time |
| Hiring roundup | 2 | 0.70 | 0 | 1.16, 0.24 | Company photo, the name in serif, "is hiring a ... for $...k" in sans |
| Self-nostalgia, magazine covers | 3 | 0.69 | 0 | 0.96, 0.69, 0.54 | The firm's founding day, Netscape, reposted TIME, WIRED and Forbes covers |
| Guest cover plus dense text | 3 | 0.63 | 0 | 1.14, 0.63, 0.25 | Magazine-style guest cover, then a 240 to 357 word summary slide |
| Data chart (single image) | 7 | 0.60 | 0 | 1.60, 0.67, 0.61, 0.60, 0.59, 0.57, 0.42 | Cream ground, bold serif title, source line |
| Talking head, podcast promo or animated reel | 6 | 0.19 | 0 | 0.65, 0.26, 0.22, 0.16*, 0.14, 0.08* | Bold sans on a red banner over a talking head (* under 1 day old) |

Recurring series: the manifestos (4 colourways), the terms explainers (5 editions: startup terms, startup language, AI, vibe coding, VC capital side), career timelines (3), advice letters (3), subtitled stills from the a16z Show and its talks (7), weekly hiring roundups (2), and American Dynamism films (3 posts).

### 2.2 Type system

Measured on the slide files. "em" is the estimated font size as a % of slide height. At a 1080 x 1440 canvas, 1% is 14.4 px.

| Template | Sizes per slide | Largest type | Second size | Meta | a16z-written words per slide |
|---|---|---|---|---|---|
| Manifesto (3:4) | 1 | about 4.2% em (cap height about 3%). One line centred at about 48% height, 47 to 76% of the width, 2 lines at most | none | Wordmark only (9.6% of width, at 91.5% height) | 4 to 12 |
| Photo fact card ("Ages") | 2 + meta | About 7% em ("16 years old", cap height about 5.2%) | Name, about 3.5% em | Year, about 2.6% cap height, bottom right; a company logo image | 3 to 6 |
| Hiring card | 2 | Company name, about 9.5% em (serif) | Sentence, about 5% em (sans) | none | 9 to 16 |
| Explainer interior (4:5) | 2 + meta | Term, about 7.5 to 8% em (cap height about 5.5%) | Definition, about 3.2% em (sans), 4 lines at 64 to 87% of the width | "1/N" counter about 2%, plus a long arrow | 25 to 50, including diagram labels |
| Principles with diagram | 2 + small labels | Title about 6.5% em, 2 to 3 centred lines | Body about 3% em (text serif) | Diagram labels about 1.4%, uppercase | 22 to 52 |
| Subtitled stills | 1 | Subtitle about 3.3% em (sans; the stressed word in serif italic) | none | Show name as the last subtitle | 7 to 25 |
| Covers | 1 to 2 | Title about 8% em | Subtitle about 2.7% plus a long hairline arrow | none | 0 to 10 on 9 of the top 10 carousels |
| Charts (single images) | 3 to 4 | Bold serif title about 6% em | Subtitle about 2.8% | Labels about 2%, source about 1.3% | 16 to 90 |
| **Our carousel (3:4), for comparison** | **6 on slides 2 to 7; 14 distinct sizes across 8 slides** | **Numeral 220 px (15.3%). Headline 84 px (5.8%)** | **Body 46 px (3.2%)** | **Device text 34, 26 and 25 px; source 16 px (1.1%); label 15 px (1.0%)** | **27 to 55 (42 on average)** |

- **Ratios.** On a single a16z slide, the two main sizes sit about 2 to 2.5:1 apart, and about 4:1 counting the meta line. On ours, the ratio runs from 8.8:1 to 14.7:1. Our body size (46 px) matches a16z's (about 3.2%). Our headline (84 px) is smaller than a16z's photo and explainer headlines (about 100 to 137 px equivalent). Our numeral is bigger than any type a16z sets.
- **Families.** A high-contrast condensed display serif carries headlines, terms, numbers used as headlines, manifesto lines and end cards. A neutral sans carries definitions, hiring sentences, subtitles and chart labels. A text serif carries dense letters and book lists. Serif italic marks one stressed word inside a sans line. Monospace appears only in the Academy sub-brand. Our run used Space Grotesk, Inter and IBM Plex Mono. The kit specifies Bagoss Condensed for display (license-blocked, so its sanctioned fallback is Arial or Helvetica) and Inter for body and overlines.
- **Numbers.** When the number is the story, it becomes the headline with its unit spelled out (ages, fund size). Otherwise it sits inline in a sentence (ages, salaries, round sizes) or as small meta (years, bottom right). a16z uses no decorative index numerals. Counters ("1/5") appear only on explainers. Charts print values inside the bars.
- **Sources.** On charts, a small grey line at bottom left gives the provider and date. Covers get a small "from [book] by [author]" footnote. On stills, the show name runs as the last subtitle. 13 of 72 captions carry a "Source:" line. No URLs appear on slides.
- **Line fitting.** Covers break at phrase boundaries, and list covers square off the last line with a long hairline arrow. Manifesto lines are written to fit one line. Definitions run four lines at about 70 to 80% of the width.

### 2.3 Colour and grounds
- **Manifestos.** One ink per carousel, alternating with cream (#F6F6EA) on every slide: oxblood #4E0612 (12.45x), navy #061E42 (5.45x), slate #424E66 (3.91x), forest #1E6642 (1.64x). The text is white on the ink and near-black on the cream. Between 96.7 and 98.6% of each slide's pixels are flat ground.
- **Explainers.** A beige diagram panel (#EADED2) sits over off-white (#F6F6EA). Diagram fills come from a muted set: bottle green, teal, oxblood, ochre, slate, navy.
- **Principles.** Warm cream (#F6EADE) with navy line work and nothing else.
- **Photos.** Real colour, darkened, with a bottom gradient where text sits. Median background brightness behind text measured 7 to 34 out of 255 (95th percentile 55 to 140). Our cover: median 71, 95th percentile 118.
- **End cards and hiring closers.** Navy #061E42 or cobalt #064296.
- **What a16z never does.** No decorative gradients, glows, drop shadows or neon. Boxes appear only as parts of an explainer diagram (the terms of a formula, the stages of a flow).

### 2.4 Pictures: what kind, and what they returned
Primary visual per post, across all 72 posts (outliers at 2x+ in brackets):
- Archival photos, screenshots and footage of famous companies and founders: 10 posts [6]
- Tweet screenshots: 3 [2]
- Pure typography (manifestos, one book list): 5 [3]
- Video stills from its own shows and talks: 7 [1]
- Portrait-led singles and guest covers (timelines, letters, guest covers, mentors): 11 [2, both about Musk]
- Its own films, fund and program news: 10 [3: the Flock collab and the Academy launch twice]
- Concept diagrams (explainers, the Horowitz guide): 6 [0]
- Data charts: 7 [0]
- Hiring photos: 2 [0]
- Its own history and magazine covers: 3 [0]
- Talking-head or animated reels: 6 [0]
- Generated-looking illustration: 1 [0]

**Founder portraits** show up four ways: darkened candid archival photos (Ages, then-and-now), cut-outs on cream (mentor pairs, guide and guest covers), a round avatar on timelines, and video stills. There are no studio headshot grids and no generated portraits.

**Charts** only worked when the reader could find themselves in them: the university ranking with school logos reached 1.6x. Trend lines scored 0.57 to 0.67x.

### 2.5 Logo and handle
- The wordmark is small, muted tan or translucent white, never a badge or pill. It sits top right (about 3% from the top, about 8.3% of the width) on photo, explainer, stills, hiring and mentor slides; bottom centre (91.5% height, 9.6% of the width) on manifestos; bottom right on charts, with the source line at bottom left.
- It is absent from all 10 Roblox slides, both tweet carousels and the magazine-cover carousel. Two of the three biggest carousels carry no a16z mark at all.
- The handle appears only on the follow end cards (11 carousels).

### 2.6 Cover hooks (the 10 best carousels)
- Hook types, one each: an archival photo with no text; an identity archetype line; a meme label over an archival photo; the first half of a maxim over a product photo; a surprising named fact with an age; a famous tweet; a reframe; a quote about a famous founder over a video still; a list promise over young famous faces with an arrow; an origin fact over a first-website screenshot.
- 9 of 10 carry 10 or fewer a16z-written words (the exception is a subtitled still with 24 words). 8 of 10 show a proper noun or a recognizable face. 0 of 10 use a question, "how to" or "N tips". 1 of 10 says "you", and that one is inside a quoted tweet.
- The weakest covers are numbered term-list promises (3), chart titles (3), a guest-magazine pastiche and a podcast banner.

### 2.7 Pacing and the close
- There is never an intro, agenda or summary slide. Slide 1 is already content.
- Each carousel repeats one unit: a single line (manifesto), a pair (fact then consequence, then then now), one person per slide (Ages), one artifact per slide (tweets, first websites), or two stills per slide.
- Rhythm comes from alternating grounds (manifestos) or alternating then and now images.
- Order is chronological (Roblox), ascending (ages 16 to 26), or setup, turn and thesis (manifestos: 4 or 5 parallel lines, one turn, one or two thesis lines).
- The close is one of three things: a one- or two-line generalization in the same template as the rest; simply the last item; or a primary source (the Roblox co-founder's own post, a founder's failure tweet). No top-10 carousel ends on a call to action.
- The top 10 carousels run 2 to 10 slides (median 7). Across all carousels, 4 to 6 slides had a median of 1.75x, 7 to 8 slides 1.16x, and 9 to 12 slides 0.66x (though 2 of the 6 long ones are outliers).

### 2.8 Captions, calls to action, cadence
- **First line.** Declarative, median 10.5 words. 1 of 72 is a question. It restates the cover or gives a date hook.
- **Body.** Median 30 words, ranging from 3 to 252. Top posts include both 5-word captions (manifestos, tweets) and a 176-word dated history (Roblox). Length does not separate the winners from the losers (median 38 words for the outliers, 40 for the bottom group).
- **Per-slide captions.** In the Ages post, each caption line describes one slide's founder, in slide order. The slides carry the fact and the caption carries the context.
- **Emoji, hashtags, disclaimers.** Emoji: 0 of 72. Hashtags: 2 of 72, both on Academy collabs. A compliance disclaimer is appended to the 3 posts featuring portfolio companies.
- **Calls to action.** 11 captions carry one (watch the full episode, link in bio, comment a keyword, apply). Their median is 0.59x, and one reached 2x (the Academy launch). The 61 without have a median of 1.02x, with 16 at 2x or more. This is confounded: calls to action sit on promotional posts.
- **Cadence.** About 5 posts a week, weekdays only, noon to 3 pm Pacific. Formats are interleaved, so there are rarely two carousels in a row.

---

## 3. Outliers against the weakest posts, counted

Outliers are the 17 posts at 2x or better. The weakest are the 16 lowest posts that were at least 3 days old when scraped (0.14 to 0.60x).

| | 17 outliers | 16 weakest |
|---|---|---|
| Format | 12 carousels, 2 images, 3 reels | 8 carousels, 5 images, 3 reels |
| Subject | 13 center an outside famous founder or company. 3 are a16z launches or collabs. 1 is an abstract lesson | 10 promote a16z's own programming, people, portfolio or editorial (including 3 Greg Brockman podcast posts in 4 days). 5 are generic reference (2 term explainers, 3 trend charts). 1 is a magazine-cover repost |
| Musk | Subject of 4, appears inside 3 more (7 of 17) | 0 |
| Template | Archival 6, manifesto 3, tweets 2, stills 1, Musk singles 2, launch or collab 3 | Talking-head reels 3, charts 4, explainers 2, hiring 1, guest cover 1, own tweet 1, stills (Brockman) 1, magazine covers 1, films 1, list 1 |
| a16z-written words per slide (carousels) | 0 to 12 on 10 of 12. Stills 7 to 25. The Academy launch letter is the exception at 300+ | Explainers 25 to 54. Brockman summary 357. Hiring 9 to 16. Books 4 to 35 |
| Follow end card | 0 of 12 carousels | 4 of 8 carousels |
| Caption call to action | 1 of 17 (the Academy "apply") | 5 of 16 (3 full-episode, 2 link-in-bio) |
| Talking-head video | 0 | 3 |
| Date hook | 3 (Roblox's 20th, Musk's birthday, Academy launch day) | 0 |
| Real archival images or primary artifacts | 8 of 17 | 2 of 16 (magazine covers, a16z's own tweet) |

Two readings from this table:
- **Dense text is not fatal in itself.** Musk's 238-word commencement advice reached 2.16x, while Brockman's 357-word podcast summary reached 0.25x. The subject decides.
- **The same famous people fail in the wrong format.** Zuckerberg and Musk archival footage scored 1.06 to 5.43x, while talking-head reels with banners scored 0.08 to 0.65x. Magazine covers of famous founders scored 0.54x.

---

## 4. Applying this to The Pitch by Deel

Hard constraints from the client kit and profile still apply to everything below:
- Founder is the hero; "by Deel" is endorsement only.
- Prizes are stated exactly as "up to $50,000 SAFE" and "up to a $1,000,000 investment".
- The only call to action is the 2027 waitlist.
- Pitch length is two minutes; city count is scoped to its season.
- No dashes, sentence case, no exclamation marks.
- No generated imagery; photos are real founders, judges and stages.
- Never name Everreach Labs or Karos Labs; never name or imply a global champion.
- Display face is Bagoss Condensed (Arial or Helvetica until licensed), body is Inter.
- Colours: deep purple #201547, acai #5938B7, latte #FAF4EE, ink #141414, and one cornbread #FFCF25 accent per composition.

### 4.1 Copy as-is
1. **The type scale: two sizes plus a meta line.** At a 1080 x 1440 design canvas: L (display) 84 to 110 px, M (Inter 500) 44 to 46 px, S (Inter 400, meta and source) 26 to 28 px. Nothing below 26 px. No more than L, M and S on one slide. The largest type is always the message. This matches a16z's measured scale and the owner's "bigger overall".
2. **The manifesto template**, in the kit's colours:
   - Alternate deep purple (latte type) and latte (deep-purple type) on every slide.
   - One statement per slide, centred, in the display face at 80 to 84 px (a16z sets about 61 px; set it bigger per the owner), 2 to 3 lines at most.
   - Nothing on the slide except the app icon.
   - 6 to 10 slides: setup, turn, thesis. No end card.
3. **The photo fact card.**
   - A full-bleed real photo with a deep-purple bottom scrim (the kit's 0 to 70%).
   - One fact at L (96 to 104 px) and a name or city at M.
   - Meta (year, venue) at S, bottom right; optionally a real company logo.
   - Text sits where the measured background brightness is under about 40 out of 255.
4. **Covers of 10 words or fewer**, carrying a proper noun, a face or a specific number. List covers get a long hairline arrow to square off the last line. No sub-paragraph.
5. **Captions.**
   - The first line restates the cover in one declarative sentence.
   - Facts come with names and dates, and list posts get one caption line per slide in slide order.
   - No emoji. The 2027 waitlist is the last line.
   - Hashtags stay at the kit's minimum. a16z uses none on 70 of 72 posts, which is worth proposing to the client as a test.
6. **Close on the last item or a one-line generalization.** No "save this" and no follow card.
7. **Source lines.** Provider and date, grey, bottom left, at S size. Never a URL.
8. **Cadence.** About 5 posts a week on weekdays, rotating franchises. The same guest or format should not appear twice in one week.

### 4.2 Adapt
1. **Archival "then" material.** The Pitch has one season of history, not decades of Silicon Valley archive. Its "then" material is: judges' and famous founders' first companies (publicly documented); the 2026 stage archive (real photos from the seven finals); and, where the founder agrees, a verified winner's path from application to stage to check.
2. **Manifesto themes.** Pitching as a craft and the founder's two minutes. a16z's 12.45x post shows the theme lands with founders. Write The Pitch's own lines; do not reuse a16z's archetype set.
3. **Subtitled stills.** Use only footage the program owns: stage pitches and jury remarks filmed at the finals. The current reels cut third-party shows and carry their bugs, including a Brex sponsor mark. a16z cuts its own shows, so the only mark on its stills is its own.
4. **Italic stress.** The kit has no italic serif. Stress a word with Inter 700, and spend the single cornbread accent per carousel on the one number that matters.
5. **Explainers (Pitch School).**
   - Keep them as a minority series and rebuild them on a16z's explainer skeleton: a diagram panel in the top 45% that encodes the concept (a formula, a funnel, a timeline with real numbers), the term at L, a definition of 35 words or fewer at M, and a "1/N" counter at S.
   - Remove the pills, tags, highlight bars, lined paper and globe watermark behind text.
   - Expect reference content not to spread: 0 of 5 a16z explainers reached 2x, and the series declined from about 1.0x to 0.46x.
6. **Data.** a16z's only chart above 1.5x ranked universities with their logos, so readers could find themselves in it. The Pitch's equivalent is winners by city or by industry from the roster, with real logos and a source line. The roster counts need client sign-off first.
7. **Collabs.** Co-author posts with judges, verified winners, @getdeel and officially presented partners. Evidence: @getdeel co-posts drew 9.9k to 17.8k plays against a solo median of 354; a16z's Flock co-post drew 1.38M against its 77k median.
8. **The mark.** a16z's small muted wordmark maps to the kit's app icon, top left. Never a pill, and never Deel's logo as the post's mark.

### 4.3 Do not copy
1. Follow end cards: 0 of 11 reached 2x.
2. Talking-head and banner reels: 0 of 6 reached 2x, median 0.19x.
3. Guest magazine-cover pastiches and dense summary slides: 0 of 3.
4. Trend charts with no identity hook or logos: 6 of 7 charts scored 0.67x or less.
5. Self-referential history: a16z's founding day and Netscape posts scored 0.69 to 0.96x. The Pitch's equivalent is posts where Deel or the program's mechanics are the subject; the kit already says the founder is the hero.
6. Generated-looking illustration: 0.73x, and the kit bans it.
7. Hiring roundups: not applicable.
8. The a16z look itself (condensed serif, cream, oxblood). The Pitch has its own kit. Copy the discipline, not the skin.
9. Free use of famous people's photos. a16z posts archival images of Musk and Zuckerberg. The Pitch is a Deel property with brand-sign-off and legal sensitivities, so it should use its own archive or licensed images, and never imply endorsement by people who are not officially involved.
10. The Roblox scale. Those 192,915 likes came from outside a16z's audience. Plan on the template's typical 2 to 10x, not 60x.

### 4.4 Three carousels for The Pitch in a16z's manner

All three use the 1080 x 1440 design canvas (rendered at 2160 x 2880), 96 px side margins, the app icon top left at 64 px, and the L/M/S scale above. Every fact below has to be re-verified against two sources before publishing. The facts about judges come from our own earlier @deelpitch captions.

**Concept 1: "They built companies first."** Typographic, fact then consequence. This is the structure of a16z's first-interns post (5.45x).
- **Layout.** 8 slides. Odd slides are deep purple #201547 with latte type; even slides are latte #FAF4EE with deep-purple type. One statement per slide in the display face at 80 to 84 px, centred, the block centred at about 46% of the height, 2 to 3 lines. Nothing else on the slide.
- **Slides.**
  1. Anish Acharya sold his first startup to Google in 2010.
  2. Nine years later, he was a general partner at a16z.
  3. Dan Amiga started out in Israel's Unit 8200.
  4. In 2017, Symantec bought the company he co-founded.
  5. Igor Ryabenkiy lost a company in the dot-com crash.
  6. In 2005, he started his own fund, AltaIR Capital.
  7. In 2026, all three judged The Pitch.
  8. They built companies before they judged them.
- **Caption**, one line per pair:
  - Before they judged The Pitch, they built companies.
  - Anish Acharya co-founded SocialDeck, sold it to Google in 2010, and became a general partner at a16z in 2019.
  - Dan Amiga served in Unit 8200, co-founded Fireglass, which Symantec acquired in 2017, and is co-founder and CTO of Island.
  - Igor Ryabenkiy built companies of his own, lost one in the dot-com crash, and started AltaIR Capital in 2005.
  - Join the waitlist for 2027.
- **Why it fits.** 7 to 10 words per slide, one size, named people with dates, a thesis close and no call-to-action card. a16z is named only as Anish's employer, which is factual; it is also an officially named partner.

**Concept 2: "Seven stages."** One photo and one big number per slide. This is the structure of a16z's Ages post (3.19x) and its then-and-now post (10.22x).
- **Layout.** 8 slides. Full-bleed real photos from the program's own 2026 archive, one per regional final. A deep-purple bottom scrim, 0 to 70%, over the lower 55% (the kit's rule for type on photos); the acai duotone grade is optional. On every slide: L 104 px for the number line and M 46 px for the city, bottom left; S 26 px for venue and date, bottom right. An optional real graphic: one row of up to 5 winner logos under the city line, nameable winners only, never Everreach Labs.
- **Slides.**
  - Slide 1 (cover): the New York stage photo with every winner holding a check. L on two lines: "Seven stages." / "87 regional winners." followed by a 240 px hairline arrow. S reads "The Pitch by Deel, 2026 season".
  - Slides 2 to 8, one city each, in order of final date (verify the order and dates):

    | City | L | S |
    |---|---|---|
    | Paris | 14 winners | Station F |
    | London | 14 winners | J.P. Morgan |
    | Berlin | 12 winners | venue |
    | Tel Aviv | 11 winners | venue |
    | New York | 15 winners | May 5 |
    | Singapore | 10 winners | AWS HQ, May 12 |
    | Dubai | 11 winners | venue |

  - The last city closes the carousel. No end card.
- **Caption.**
  - The 2026 tour ran seven regional finals. Regional winners receive up to $50,000 SAFE on the published terms.
  - Paris: 14 winners at Station F.
  - London: 14 at J.P. Morgan.
  - Continue with one line per city.
  - Join the waitlist for 2027.
- **Gates.** The per-city counts (87 in total) come from the client's own export in `winners-roster.md` and must be cleared for public use first. "Seven" stays scoped to 2026. Venues and dates are verified city by city.

**Concept 3: "Two minutes, five lines."** Subtitled stills of a verified winner's real pitch. This is the structure of a16z's stills post (3.43x; the template's median is 1.73x).
- **Layout.** 5 slides. Each slide stacks two 3:2 frames full-bleed (1080 x 720 each), taken from the program's own footage of Famnest's pitch at the London regional final (Famnest is a verified nameable winner: London regional, J.P. Morgan, PRWeb, May 1, 2026). Each frame gets a local deep-purple scrim over its bottom 35%.
- **Type.** One size: M 44 px Inter 500 subtitles in latte, centred, 2 lines at most per frame. The stressed word is set in Inter 700. The carousel's single cornbread accent goes on the traction number.
- **Slides** (lines are transcribed verbatim from the footage; placeholders are in brackets):
  1. Top: founder at the mic, with [opening sentence]. Bottom: wide shot of the room, with [second sentence].
  2. [The problem] and [who pays for it].
  3. [The traction number].
  4. [The ask] and [what it buys].
  5. Top: the judges' table, with [a judge's first question]. Bottom: the result moment, with a final S-size subtitle: "Famnest, London regional final, The Pitch by Deel 2026".
- **Caption.**
  - Famnest won the London regional final of The Pitch by Deel in 2026. These are five lines from their two minutes on stage.
  - One line per slide.
  - Join the waitlist for 2027.
- **Gates.** Founder consent; footage owned or licensed by the program; verbatim lines only; no outcome claims beyond the verified regional win. If no footage exists, run the same template on a judge's on-stage remarks from any 2026 final the program filmed.

### 4.5 Critique of our last carousel (pubsub-21255292697877233, "how we decide what not to build", 8 slides, $0.98)

| # | What ours does (measured) | What a16z does | Fix |
|---|---|---|---|
| 1 | **Premise.** The cover says "Six questions The Pitch asks. Most founders cannot answer one." The program publishes no such questions: the run's own first comment sources them to "operational engineering studies" and "recent technical analyses". "Most founders cannot answer one" cannot be checked | Covers state a checkable fact (a named intern at 19) or an owned opinion. Nothing is attributed to an institution that did not say it | Never attribute a framework to the client unless it is in the official rules. Attribute it to a named person or own it as our opinion |
| 2 | **Claims about judging.** Slide 5 says The Pitch "does not credit an unrequested refactor", and the caption asserts how the product-strength score behaves | a16z makes no claims about how others evaluate | The profile (§7) requires quoting the official rules on mechanics. Remove these claims |
| 3 | **The series breaks its own pattern.** Only 3 of the 6 "questions" are questions (02, 04, 06). 01 is a statement, 03 an instruction, 05 an aphorism | Parallel lines keep the identical pattern on every slide | One grammatical pattern per carousel |
| 4 | **Word count.** About 340 words: 42 per slide, 28 on the cover (a 10-word headline plus an 18-word subline) | 0 to 12 a16z-written words per slide on story carousels; 10 or fewer on 9 of the top 10 covers | 12 words or fewer per story slide, 35 or fewer on explainers. Move the context into the caption, one line per slide |
| 5 | **Type count.** 14 distinct sizes across the carousel, 6 on each interior slide (220, 84, 46, 34, 26, 25 px; down to 16 px for "imfounder.com" and 15 px for "ILLUSTRATIVE, NOT MEASURED"). The largest-to-smallest ratio is 8.8:1 to 14.7:1 | 1 size on manifestos. Elsewhere 2 sizes plus meta, at most about 4:1 | The L/M/S scale; nothing under 26 px |
| 6 | **Hierarchy upside down.** The biggest thing on slides 2 to 7 is a decorative "01" to "06" (220 px, 15.3% of the height). The message is 84 px (5.8%) | The largest type is always the message ("16 years old", the term, the company name) | Drop the index numerals. If order matters, use a "1/6" counter at S |
| 7 | **Typefaces.** Space Grotesk, Inter and IBM Plex Mono on every slide. None of them is the kit's display face | One display face and one sans across every template | Bagoss Condensed (Arial or Helvetica until licensed) plus Inter, per the kit |
| 8 | **Repetition.** Slide 2 says the same thing three times (the versus box, the headline, the body). "90 days" appears twice on slide 3. The slide 4 table repeats the body. Slide 8 repeats "90 days" and "Day 1" as chips that explain nothing | One sentence per slide. A diagram appears only when it shows something the text does not (a formula, a flow) | Drop any "device" that restates the headline |
| 9 | **Fake data graphics.** The slide 6 timeline is labelled "ILLUSTRATIVE, NOT MEASURED". On slide 3, "90 days" is a rule of thumb styled as a statistic, sourced to a URL | Real data with a provider and date. Concept diagrams are clearly diagrams | No data styling without data |
| 10 | **Boxes.** Versus cards with coloured left rules, a monospace spec table, a timeline strip, a translucent panel on the closer. None of them is the kit's d-box and 1 px border system | No boxes on any top-10 carousel | Pure type or a real image. A box only as the kit's d-box, about one per composition |
| 11 | **Cover image and shade.** A stylized stage silhouette harvested from the client's web page, not a documentary photo of a Pitch founder, judge or stage. Median background brightness behind the headline is 71 out of 255 (95th percentile 118), with a stage light and an orange panel behind the words. There is no scrim, and the 5-line headline plus 3-line subline covers about 60% of the frame height | A real photo; background behind text at 7 to 34 out of 255; 10 words or fewer | A real Pitch photo, the kit's deep-purple bottom scrim, 10 words or fewer |
| 12 | **Line fit.** Cover lines fill 70, 77, 77, 37 and 62% of the width, including a one-word line ("cannot"). Interior headline widths swing from 36 to 78% between slides. Slide 2's six-word headline breaks into three short lines (2, 1 and 3 words) | Phrase-based breaks, with an arrow to square off the last line. Definitions fill 70 to 80% of the width | A fixed measure of about 80% of the width. Rewrite lines to fit |
| 13 | **Mark.** The "deel." logo sits in a white pill, top right, on every slide | A small muted wordmark, no pill. None at all on the Roblox and tweet carousels | The kit's app icon, top left. Deel appears only as the endorsement line |
| 14 | **Close.** A negation-led thesis ("You do not win ... by building more"), two orphan stat chips, and a "Save this" call to action | The last item, or a one-line generalization. No call to action on any top-10 carousel | End on the idea. The waitlist goes in the caption |
| 15 | **Caption.** 110 words opening with a claim about the score, 4 CamelCase hashtags, and a first comment sourced to "recent technical analyses" | A declarative first line that restates the cover, facts, no hashtags | Per 4.1 and the kit (lowercase hashtags from the set) |

**Worth keeping.** The 3:4 canvas (a16z's manifestos use 2160 x 2880 too), the deep-purple ground (close to #201547), the 8-slide length, and the consistent left margin.

**Side finding, to reconcile before the next run.** The run's context, as projected from the product-information and market-strategy context docs, carried three things that conflict with the lab profile's hard gates (§7, §12): a "0.05% selection rate", "50,000+ applicants", and five companies labelled "Grand Finale Winner". The profile says never to publish 0.05%, to attribute the applicant count as about 35,000+, and never to name or imply a global champion. This carousel did not publish any of them; the next run could.

---

## 5. Lessons we are confident about

Evidence tags: **[M-strong]** a clear split measured on this sample; **[M-dir]** measured, but small n or confounded; **[P]** consistent a16z practice with no performance test possible; **[C]** client-account data.

### 5.1 Platform level (all clients)
1. **Lead with carousels for accounts built on text and pictures.** a16z carousels have a median of 1.14x, against 0.80x for images and 0.90x for reels; 12 of the 17 outliers are carousels. [M-strong]
2. **One message per slide.** Story slides carry 12 words or fewer, covers 10 or fewer. 9 of a16z's top 10 carousel covers have 10 or fewer; its explainers (25 to 54 words a slide) went 0 for 5 at 2x. Our run averaged 42 words a slide, @deelpitch 44. [M-strong]
3. **Two sizes plus a meta line, never below about 26 px at 1080 x 1440, and the largest type is the message.** Every a16z template measures 1 or 2 sizes plus meta. The exception is its charts, which are also its weakest singles. [P and M]
4. **Put the detail in the caption, one line per slide, in slide order.** a16z's Ages post does exactly this. [P]
5. **Real pictures.** 0 of a16z's 17 outliers use illustration or generated imagery, and its one illustrated carousel scored 0.73x. [M-dir, n=1] For The Pitch this is also a kit rule.
6. **Darken every photo that carries text.** Background behind a16z's text measures 7 to 34 out of 255 at the median; ours measured 71. [P and M]
7. **End on the idea and put the call to action in the caption.** 11 a16z carousels with follow end cards: median 0.73x, none at 2x. 28 without: median 1.79x, 12 at 2x. 11 captions with a call to action: median 0.59x, against 1.02x. [M-dir, confounded by template]
8. **One visual system per account.** a16z runs one display face, one ground family and one mark treatment across about 17 templates. @deelpitch showed 5 systems in 5 weeks. [P, C]
9. **Rotate franchises; don't stack a guest or a format.** a16z's explainer series fell from about 1.0x to 0.46x over 5 editions, and 3 Brockman posts in 4 days scored 0.14 to 0.42x. [M-dir]
10. **Collabs bring the co-author's audience.** a16z's Flock co-post drew 1.38M plays against a 77k median. @getdeel co-posts drew 9.9k to 17.8k plays against 178 to 2,031 for @deelpitch solo reels. [M-dir, C] (a16z's creator collab was under an hour old when scraped, so it cannot be judged yet.)
11. **Data hygiene for the study.**
    - Drop posts under 3 days old from rankings: 2 of the wrapper's 3 worst a16z posts were under a day old.
    - Treat hidden-like accounts as unrankable by likes; use plays or Insights instead.
    - Flag pinned posts and collabs owned by other accounts. [M-strong]

### 5.2 Industry level (startup, VC and founder brands)
1. **Origin stories of famous companies and founders are the richest vein.** Archival carousels went 5 for 5 at 2x or better (median 9.5x); the archival Musk reel reached 5.43x. [M-strong within a16z]
2. **Pitching and hybrid skills work as identity content.** The 12.45x manifesto is about builders who can pitch, and 3 of 4 manifestos reached 2x. [M-dir]
3. **Primary artifacts beat commentary on them.** Founders' own tweets and first websites: tweet carousels went 2 for 2 at 2x (4.49x, 2.01x). a16z reposting its own tweet about a founder scored 0.30x. [M-dir]
4. **Star power is concentrated.** Musk is the subject of 4 outliers and appears in 3 more (7 of 17). For The Pitch the equivalent pull has to come from judges, partners and famous founders' public stories, within the partner-naming rules. [M-strong]
5. **Reference content is useful but does not spread.** Glossaries, trend charts and VC mechanics went 0 for 12 at 2x. VC-insider topics sit at the bottom (VC terms 0.46x, the venture 2x2 at 0.42x, "top tier" talk at 0.63x). The audience is founders, not investors. [M-strong]
6. **Program and firm news spreads only as a big launch with partner co-posts.** The Academy launch reached 2.65x and 2.05x, and the Flock collab 4.52x. Routine fund, portfolio and hiring news sat at 0.24 to 1.16x. [M-dir]
7. **Talking-head podcast promos underperform.** 0 for 6 at 2x, median 0.19x (two were under a day old). The same founders in archival footage did 1.06 to 5.43x. [M-dir]

---

## Appendix A: every a16z post, classified (by date)

| Date | Post | Format | x | Template |
|---|---|---|---|---|
| 06-15 | [DZnGLIZqWuP](https://www.instagram.com/p/DZnGLIZqWuP/) | reel | 1.56 | Archival reel |
| 06-16 | [DZqZAsdCkZG](https://www.instagram.com/p/DZqZAsdCkZG/) | caro/7 | 1.02 | Explainer (terms) |
| 06-17 | [DZs7nIsNX9p](https://www.instagram.com/p/DZs7nIsNX9p/) | image | 1.31 | Career timeline |
| 06-18 | [DZvfaVSqlrL](https://www.instagram.com/p/DZvfaVSqlrL/) | image | 1.60 | Data chart |
| 06-19 | [DZx2RwhKYDh](https://www.instagram.com/p/DZx2RwhKYDh/) | image | 0.85 | Advice letter / dense |
| 06-22 | [DZ5hpa4iodz](https://www.instagram.com/p/DZ5hpa4iodz/) | caro/2 | 0.63 | Guest cover + dense |
| 06-24 | [DZ-tPqQitsv](https://www.instagram.com/p/DZ-tPqQitsv/) | caro/8 | 3.19 | Archival, famous co. |
| 06-25 | [DaBUKWiin89](https://www.instagram.com/p/DaBUKWiin89/) | caro/10 | 5.45 | Type manifesto |
| 06-26 | [DaEBsdFCsJ8](https://www.instagram.com/p/DaEBsdFCsJ8/) | caro/7 | 0.73 | Illustrated list |
| 06-28 | [DaI2rZRKHcj](https://www.instagram.com/p/DaI2rZRKHcj/) | image | 2.88 | Career timeline |
| 06-29 | [DaLqZIvCkwz](https://www.instagram.com/p/DaLqZIvCkwz/) | caro/12 | 0.59 | List (books/mentors) |
| 06-30 | [DaOXV1WikwY](https://www.instagram.com/p/DaOXV1WikwY/) | caro/6 | 1.11 | List (books/mentors) |
| 07-02 | [DaTW9q_KMCM](https://www.instagram.com/p/DaTW9q_KMCM/) | reel | 5.43 | Archival reel |
| 07-03 | [DaV6Gk7itIV](https://www.instagram.com/p/DaV6Gk7itIV/) | caro/6 | 1.03 | Explainer (terms) |
| 07-06 | [DadvpSjihOe](https://www.instagram.com/p/DadvpSjihOe/) | caro/7 | 0.96 | Self-nostalgia / mag covers |
| 07-07 | [DagNhHVColh](https://www.instagram.com/p/DagNhHVColh/) | caro/7 | 12.45 | Type manifesto |
| 07-09 | [DaldaTMivSP](https://www.instagram.com/p/DaldaTMivSP/) | caro/7 | 0.69 | Self-nostalgia / mag covers |
| 07-10 | [Dan8QUdCsnc](https://www.instagram.com/p/Dan8QUdCsnc/) | caro/5 | 2.01 | Tweet screenshots |
| 07-13 | [Dav1W1kqiSt](https://www.instagram.com/p/Dav1W1kqiSt/) | image | 0.81 | Advice letter / dense |
| 07-14 | [DayXSnPKZYn](https://www.instagram.com/p/DayXSnPKZYn/) | reel | 0.22 | Talking-head/promo reel |
| 07-15 | [Da0yrGHqEVg](https://www.instagram.com/p/Da0yrGHqEVg/) | image | 0.42 | Data chart |
| 07-16 | [Da3cejpCsqF](https://www.instagram.com/p/Da3cejpCsqF/) | caro/6 | 1.85 | Subtitled stills |
| 07-17 | [Da5i7bWKluX](https://www.instagram.com/p/Da5i7bWKluX/) | reel | 0.83 | Firm/portfolio news |
| 07-20 | [DbBsVHzCqX6](https://www.instagram.com/p/DbBsVHzCqX6/) | caro/6 | 1.64 | Type manifesto |
| 07-21 | [DbEbEEHqHlT](https://www.instagram.com/p/DbEbEEHqHlT/) | reel | 1.06 | Archival reel |
| 07-22 | [DbHHAYMKJ-X](https://www.instagram.com/p/DbHHAYMKJ-X/) | image | 0.60 | Data chart |
| 07-23 | [DbJzEL9Cs--](https://www.instagram.com/p/DbJzEL9Cs--/) | caro/5 | 4.49 | Tweet screenshots |
| 07-24 | [DbMCEprqewA](https://www.instagram.com/p/DbMCEprqewA/) | reel | 0.98 | Firm/portfolio news |
| 07-25 | [DbO3-Anigry](https://www.instagram.com/p/DbO3-Anigry/) | caro/5 | 3.43 | Subtitled stills |
| 07-27 | [DbT8cgpiq5z](https://www.instagram.com/p/DbT8cgpiq5z/) | caro/10 | 0.58 | Explainer (terms) |
| 07-28 | [DbWeItlqfZ5](https://www.instagram.com/p/DbWeItlqfZ5/) | image | 0.57 | Data chart |
| 07-29 | [DbY32MOqYvT](https://www.instagram.com/p/DbY32MOqYvT/) | reel | 1.30 | Archival reel |
| 07-31 | [DbeFjXSKc_z](https://www.instagram.com/p/DbeFjXSKc_z/) | image | 0.79 | Career timeline |
| 08-03 | [Dbl-scZCsKJ](https://www.instagram.com/p/Dbl-scZCsKJ/) | caro/4 | 0.63 | Subtitled stills |
| 08-04 | [Dbn0-mlkwa_](https://www.instagram.com/p/Dbn0-mlkwa_/) | reel (pinned, @flocksafety) | 4.52 | Firm/portfolio news |
| 08-05 | [DbrA7uGCpsL](https://www.instagram.com/p/DbrA7uGCpsL/) | caro/3 | 0.57 | Firm/portfolio news |
| 08-06 | [DbtUlTiikQj](https://www.instagram.com/p/DbtUlTiikQj/) | caro/2 | 1.62 | List (books/mentors) |
| 08-07 | [Dbv2PDVCkvS](https://www.instagram.com/p/Dbv2PDVCkvS/) | caro/4 | 0.70 | Firm/portfolio news |
| 08-10 | [Db3xmzlCtd9](https://www.instagram.com/p/Db3xmzlCtd9/) | caro/2 | 9.49 | Archival, famous co. |
| 08-11 | [Db6K3iLqy5_](https://www.instagram.com/p/Db6K3iLqy5_/) | reel | 0.73 | Archival reel |
| 08-12 | [Db88vrpCq6F](https://www.instagram.com/p/Db88vrpCq6F/) | caro/5 | 1.93 | Subtitled stills |
| 08-13 | [Db_khTJCu59](https://www.instagram.com/p/Db_khTJCu59/) | caro/10 | 0.72 | Explainer (terms) |
| 08-14 | [DcCNycSirlI](https://www.instagram.com/p/DcCNycSirlI/) | caro/2 | 1.14 | Guest cover + dense |
| 08-17 | [DcJq0xqinAP](https://www.instagram.com/p/DcJq0xqinAP/) | caro/3 | 1.73 | Subtitled stills |
| 08-18 | [DcMS1Upq0R7](https://www.instagram.com/p/DcMS1Upq0R7/) | image | 0.61 | Data chart |
| 08-19 | [DcO918CCrze](https://www.instagram.com/p/DcO918CCrze/) | caro/8 | 10.22 | Archival, famous co. |
| 08-20 | [DcRkt6pq5UW](https://www.instagram.com/p/DcRkt6pq5UW/) | image | 2.16 | Advice letter / dense |
| 08-24 | [DcbxulGqdo-](https://www.instagram.com/p/DcbxulGqdo-/) | image | 0.30 | Tweet screenshots |
| 08-25 | [Dceindyod4L](https://www.instagram.com/p/Dceindyod4L/) | image | 0.67 | Data chart |
| 08-27 | [Dcjns8_KnDz](https://www.instagram.com/p/Dcjns8_KnDz/) | reel | 0.26 | Talking-head/promo reel |
| 08-28 | [DclbsHDikef](https://www.instagram.com/p/DclbsHDikef/) | caro/3 | 1.11 | Firm/portfolio news |
| 08-28 | [DcleX90qu9M](https://www.instagram.com/p/DcleX90qu9M/) | reel | 0.90 | Firm/portfolio news |
| 08-31 | [Dct1HT_KfAn](https://www.instagram.com/p/Dct1HT_KfAn/) | image | 0.96 | Subtitled stills |
| 09-01 | [DcwjRiNiiOz](https://www.instagram.com/p/DcwjRiNiiOz/) | caro/10 | 60.46 | Archival, famous co. |
| 09-02 | [Dcy9JNLCvti](https://www.instagram.com/p/Dcy9JNLCvti/) | caro/7 | 2.07 | Archival, famous co. |
| 09-03 | [Dc1i4q_iiiH](https://www.instagram.com/p/Dc1i4q_iiiH/) | caro/10 | 0.46 | Explainer (terms) |
| 09-04 | [Dc4V0jrCntL](https://www.instagram.com/p/Dc4V0jrCntL/) | caro/8 | 1.16 | Hiring roundup |
| 09-07 | [Dc_u_wJqtUi](https://www.instagram.com/p/Dc_u_wJqtUi/) | image | 1.48 | Advice letter / dense |
| 09-08 | [DdCfJVDipqA](https://www.instagram.com/p/DdCfJVDipqA/) | caro/7 | 0.54 | Self-nostalgia / mag covers |
| 09-09 | [DdFHzVPCieZ](https://www.instagram.com/p/DdFHzVPCieZ/) | caro/8 | 1.50 | Principles + line diagrams |
| 09-10 | [DdHuQetCoDc](https://www.instagram.com/p/DdHuQetCoDc/) | caro/8 | 0.24 | Hiring roundup |
| 09-14 | [DdR--_iCg08](https://www.instagram.com/p/DdR--_iCg08/) | caro/4 | 0.42 | Subtitled stills |
| 09-14 | [DdSFK8lKgey](https://www.instagram.com/p/DdSFK8lKgey/) | reel | 0.14 | Talking-head/promo reel |
| 09-15 | [DdUWVrYijmd](https://www.instagram.com/p/DdUWVrYijmd/) | caro/7 | 3.91 | Type manifesto |
| 09-17 | [DdZuxXsCh_p](https://www.instagram.com/p/DdZuxXsCh_p/) | caro/2 | 0.25 | Guest cover + dense |
| 09-18 | [DdcD-GJKHRe](https://www.instagram.com/p/DdcD-GJKHRe/) | image | 0.59 | Data chart |
| 09-18 | [DdcLO-eqXwr](https://www.instagram.com/p/DdcLO-eqXwr/) | reel | 0.65 | Talking-head/promo reel |
| 09-22 | [Ddl6c2WK4jY](https://www.instagram.com/p/Ddl6c2WK4jY/) | reel (2 days old) | 2.65 | Firm/portfolio news |
| 09-22 | [DdmC--cik7m](https://www.instagram.com/p/DdmC--cik7m/) | caro/4 (2 days old) | 2.05 | Firm/portfolio news |
| 09-23 | [Ddm9zTgoL0_](https://www.instagram.com/p/Ddm9zTgoL0_/) | reel (@theacademy.sf, 2 days old) | 1.08 | Firm/portfolio news |
| 09-23 | [DdpWzF_tEHO](https://www.instagram.com/p/DdpWzF_tEHO/) | reel (23 h old) | 0.08 | Talking-head/promo reel |
| 09-24 | [DdruMItuwtD](https://www.instagram.com/p/DdruMItuwtD/) | reel (@atlasberry008, 36 min old) | 0.16 | Talking-head/promo reel |

## Appendix B: files

The scratchpad root is `/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad`.
- This playbook: `<root>/research/out/a16z-deep-dive.md`
- a16z scrape: `<root>/research/scrape/a16z/` (posts.json, stats.json, media.json, sheet-best.jpg, sheet-worst.jpg, carousel-B*.jpg)
- a16z full review set: `<root>/research/scrape/a16z/deep/`. It holds covers-1 to covers-3.jpg (all 72 covers by date), strip-rNN-*.jpg (every carousel, named by rank and multiple), media/ (309 images), ocr/ (tesseract text per image), template-map.json (my labels), and ocr-ours-pitch/ (OCR of our 8 slides)
- deelpitch scrape and review set: `<root>/research/scrape/deelpitch/` and `<root>/research/scrape/deelpitch/deep/`
- Measurement scripts: `<root>/inkbands.py` (text-band heights on flat grounds), `<root>/whitebands.py` (white text on photos, plus brightness), `<root>/a16z_deep_media.py` and `<root>/deelpitch_deep_media.py` (downloads and sheets)
- Our run: `<root>/review/pubsub-21255292697877233/` (slides), `<root>/type-audit.json` (the pitch key holds the font sizes per slide), `<root>/graphics-audit/steps/pubsub-21255292697877233.json`
- Client rules: `/Users/albertkattan/Code/karos-agents/clients/thepitchbydeel/brand/kit/brand.yaml`, `.../profile/product-information.md`, `.../profile/winners-roster.md`
