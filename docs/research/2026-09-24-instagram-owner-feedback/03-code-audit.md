# Code audit: why our posts look the way they do

Seven read-only auditors traced each owner complaint to its root cause in agent-engine (origin/main a65cdb8, 2026-09-24) and karos-portal, using the prep run records of the eight reviewed posts. File:line references are as of that commit.

## I: duplicate slides and slide-to-slide harmony. Covers the render and re-layout paths, the interest-floor merge rung, visual QA, closer rules #196/#228, the word budget, skeleton variety and series grammar.

**How it works today**

Short answer: the delivered posts did not contain two closers. The review sheets showed them because every render of a post writes to the same object names, and the review read the first render's step record. The missing slide is real, though. The merge re-layout deleted its words, and the same pattern hit 17 of 29 merges in prep since 2026-09-18 (27 of 29 on current main).

Render path (agent-engine at a65cdb8). packages/tools/karos-publish/src/render-carousel.ts:1440-1442 writes every slide to the fixed name `instagram/<client>/<postId>/slide-<n>.png` (the same `outDir/slide-<n>.png` locally). `persistRenderedSlide` (1236-1249) uploads and never deletes. So the first render (08-render-carousel, workflow create-instagram-agent-workflow.ts:12815-12820), the typographic fallback (12849-12854) and the re-layout render (08a1c, 13245-13256, same postId) all overwrite the same objects. A shorter re-render leaves the old tail in place. The superseded step record keeps signed URLs that now point at different pixels.

Floor and re-layout. 08a1 (12967-13004) weighs each plate. When it fails, `planInterestRelayout` runs with `mergeSupported: true` (13066-13087). Rung 1 of the ladder is `mergeRemedy` (interest-relayout.ts:1035-1040, 783-805). It folds a thin interior slide into the slide before it, whatever that slide's archetype. The apply case appends the carry to `into.body` (workflow 13130-13133). It then renumbers, renders 08a1c, commits (13257-13265) and re-checks only the interest floor (13266-13280). Word budget and render rules are not re-run.

Where the carried words go. `contentFor` never paints `body` on `quote_card` (slides-data.ts:2145-2150) or `list_takeaway` (2167-2190). Since #243, `withBodyBudget` (1126-1158, applied at 2995 via `textBudgets: true` at workflow 12406) trims appended sentences on stat_callout (18 words), photo and headline_focus (24).

Pre-render gates. 07h (12584-12664) and 07h2 (12689-12709) return attempts 1 and 2 before any render. On the final attempt they are waived (12645-12663, 12700-12708), so every render, floor and re-layout in these runs happened on attempt 3.

Checks that exist, and what they miss:
- 07d dedupe is cross-post only (packages/workflow/src/primitives/history-dedup.ts:80-87).
- 07k compares only against the previous post; the pre-render call passes no occupancy, so adjacency is never checked there (workflow 12755; skeleton-memory.ts:567-611).
- `adjacentRepeatWarnings` (skeleton-memory.ts:533-547) is warn-only. It needs identical tokens including the device suffix (258-292) and the same occupancy tenth. `withMeasuredOccupancy` never fails (631-643).
- `resolveLayout` keeps a closer on the last slide only (#196, slides-data.ts:1674-1687). Since #238 it lets `headline_focus` repeat (1645-1646, 1694-1699), while the copy prompt still says once per carousel (prompts/instagram-copy/latest.md:470-480).
- The 08b judge gets the already-lossy document (`slides: slidesDataForQa…fields`, 13793), per-slide vision OCR (08a4, 13629-13657) and a one-sentence contact-sheet description (13694-13737). It never sees the copy.
- A failed judge verdict on the final attempt ships with findings (13878-13904).
- The packager writes alt text from the copy's headline and body (13990), not from what rendered.
- 09b only asserts `rendered.length === slides.length` (15298-15307). It persists `slides: slidesData.slides` and `rendered: rendered.rendered` (15414-15415). The portal materializes exactly that list (karos-portal src/lib/agent-engine/materialize.ts:562-614).

Run records:
- Kindly Yours pubsub-21255254988332367. 07c had 8 slides and one closer. 07h failed slide 6 (`no-image-means-device`); 07h2 flagged slides 5, 6 and 8 at 32, 31 and 55 words; both were waived on attempt 3. 08 rendered 8. 08a1 failed slide 6 (`one-element`, weight 2.00 < 3.00). 08a1b merged 6 into 5 (a quote_card) with carry "Most wedding designs are built around aesthetics." 08a1c rendered 7; its slide 5 fields hold only quoteText and attribution. 08a1d and 08a1e passed. 08b passed (publishable). 08c wrote 7 alt texts, and slide 5's alt ("Memory is the point…") describes words not on the plate. 09a was auto-approved by `system:gate-timeout`.
- Sitti pubsub-21255328593979584. Same chain: merge 5 into 4 (list_takeaway), carry "The test has a standard length." dropped; relayout slide 4 fields hold only the headline. 08b FAILED (pass false, publishable false: slide 6 has no device, the closer recap is cut off with an ellipsis). It shipped anyway via the final-attempt rule. Slide 4's alt text describes the lost four-week sentence.
- The review harvest (scratchpad harvest.cjs:18,21) reads `08-render-carousel` and `07c`. The review therefore showed the 7 re-laid PNGs plus the stale first-render slide-8.png:
  - Kindly Yours: slide-7 and slide-8 md5 4013a6e9… (identical)
  - karoslabs B pubsub-21254987466423505: md5 7ac5d7f4… twice
  - Sitti: near-identical closers (the 7-slide system adds an accent rule)
- The portal assets of merge runs carry 7 slides (5 checked: slideCount 7, artifacts 1..7).

Read-only scripts in the scratchpad (/private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/): merge-census.cjs, merge-budget-sim.cjs, h07-vs-merge.cjs, incident196.cjs, job-slides.cjs, relayout-survey.cjs. They cover 67 prep Instagram runs since 2026-09-15:
- 50 ran a re-layout and 29 merged (first merge 2026-09-18, all on the final attempt).
- All 29 shortened 8 slides to 7 and left the first render's slide-8.png at a live address.
- 17 of 29 lost the carried words at render: every merge into list-takeaway (10) and quote-card (7).
- Replaying today's body budget on the other 12, 10 would also lose them.
- 24 of 29 merged slides had already been failed by 07h pre-render on the same attempt.
- Bucket listing was not possible: the portal service account gets 403 on karoscmo-prep-media-assets. The orphans are shown by the harvest's HTTP 200 fetch of the first render's slide-8 URL and by the identical md5s.

**Root causes**

- **The review showed two identical closers at slides 7 and 8 (Kindly Yours, Sitti, karoslabs B). The shipped posts had 7 distinct slides.**
  - Cause: Renders share object names: `instagram/<client>/<postId>/slide-<n>.png` (render-carousel.ts:1440-1442), with no per-render key and no cleanup (persistRenderedSlide 1236-1249). A merge re-layout renders N-1 slides into the same names (workflow 13245-13256). That overwrites 1..N-1 and leaves the first render's slide-N.png (the old closer) live. The superseded 08-render-carousel record still lists all N signed URLs, so its metrics no longer describe the pixels at those URLs. The review harvest reads that record plus 07c (scratchpad harvest.cjs:18,21). It paired pre-merge text with post-merge pixels plus the stale closer.
  - Evidence: Kindly Yours: slide-7.png and slide-8.png md5 4013a6e988d14c331b70dbef35c7b292; karoslabs B: 7ac5d7f483adc88e8af1de6070ebccbc twice. The harvested Kindly Yours slide-6.png shows the relayout's 'The conversation is where the design starts' photo (08 had measured slide 6 as a 10.5%-ink headline-focus plate). All three runs have 08 = 8 PNGs and 08a1c = 7 PNGs at the same gcsUri names. The deliverable path is 7: 08c altText has 7 rows, 08b1 says 'seven sequentially numbered slides', 09b's count assert passed, and portal assets of merge runs show slideCount 7. merge-census.cjs: all 29 merges since 2026-09-18 shortened 8 to 7 and left an orphaned slide-8.png.
- **The Kindly Yours headline-focus slide ('Most wedding designs are built around aesthetics') and Sitti's 'The test has a standard length' are missing from the delivered posts. Their words are nowhere on the plates.**
  - Cause: `mergeRemedy` (interest-relayout.ts:783-805) always picks the previous slide as `into`. It never checks that the archetype paints `body` or that the words fit. The apply case appends headline+body to `into.body` (workflow 13132-13133). `quote_card` renders only quoteText and attribution (slides-data.ts:2145-2150), and `list_takeaway` renders only headline and itemRows (2167-2190). Since #243, `withBodyBudget` (1126-1158, applied at 2995) keeps only the leading sentences within 18 or 24 words, so the appended carry is cut on stat_callout, photo and headline_focus too. Nothing verifies the carry reached the document before the commit (13257-13265).
  - Evidence: 08a1b Kindly Yours: merge 6 into 5 (quote-card), carry headline 'Most wedding designs are built around aesthetics.'; 08a1c slide 5 fields = {quoteText, attribution} only. 08a1b Sitti: merge 5 into 4 (list-takeaway), carry 'The test has a standard length.'; 08a1c slide 4 fields = {headline:'How the matrix scores a platform'} only. Census: 17/29 merges dropped the carry (all 10 into list-takeaway, all 7 into quote-card). merge-budget-sim.cjs: 10 of the remaining 12 would lose it under today's BODY_WORD_BUDGET, so 27/29 on current main. Of the two survivors, one lands on a cover as a 44-word subtitle (sitti pubsub-21255337214301247). An approved post lost a slide this way: karoslabs pubsub-21899590279354945, 'Delta Air Lines proved it at scale' merged into a list-takeaway.
- **The final attempt ships the thin plate 07h already flagged. Then the free re-layout deletes it instead of fixing it.**
  - Cause: 07h and 07h2 return attempts 1..n-1 before render (workflow 12602-12605, 12692-12699) and are waived on the final attempt (12645-12663, 12700-12708). So render, floor and re-layout only ever run on attempt 3, where no redraft is left. Rung 1 of the ladder is the merge (interest-relayout.ts:1035-1040). The default series `the_breakdown` (editorial-series.ts:124-130; it is chosen when no format has a signal) puts `headline_focus` directly after `quote_card`. `the_playbook` (135) and `in_their_words` (157) put it after `list_takeaway` and `quote_card`. The thinnest plate therefore sits behind a plate that cannot show its words.
  - Evidence: h07-vs-merge.cjs: 24/29 merged slides failed `default:no-image-means-device` at 07h on the same attempt. All 29 merges are on attempt 3 or its revise round, and those runs show no attempt-1 or attempt-2 renders. Kindly Yours 07h: slide 6 flagged; Sitti 07h: slide 5 flagged; both were merged away. 07h2 had already flagged 12 of the 29 `into` slides as over budget before the merge added more words (karoslabs B slide 5: 31 words, then shipped with a 38-word body plus a 15-word sub-label). 04i2: Kindly Yours, Sitti, Hanky Panky and XO Digital all ran `the_breakdown`.
- **Visual QA did not catch the lost slide, and nothing checks the rendered set as a set.**
  - Cause: The 08b judge compares OCR (`textInImage`) against the rendered document's own fields (prompts/instagram-visual-qa/latest.md:105-108; input at workflow 13793). That document had already lost the words, and the judge never gets the copy or the carry. The contact sheet comes back as one generic sentence (13694-13737). There is no assertion of one cover and one closer on the rendered output, no unique-object check and no perceptual or byte dedupe; 09b checks only the count (15298-15307). A judge fail on the final attempt ships with findings (13878-13904), and the human gate can auto-approve on timeout.
  - Evidence: Kindly Yours 08b: pass true, publishable true (it saw 7 plates). Sitti 08b: pass false, publishable false (slide 6 no device, closer recap cut with an ellipsis), shipped anyway. Kindly Yours 09a: actor 'system:gate-timeout', decision approve. Contact sheets: 'A contact sheet displaying seven sequentially numbered slides…'. 08a4 textInImage for both runs has no trace of the carried sentences.
- **Alt text and the gate trace describe words that are not on the plates.**
  - Cause: The packager input takes `finalCopy.slides` headline and body (workflow 13990). Those are fallback-only fields on quote_card, stat_callout and list_takeaway, and after a merge they include the carry. The re-layout note ('folding it into slide 5') is recorded as a successful fold (interest-relayout.ts:801-803).
  - Evidence: Kindly Yours 08c: slide 5 alt 'Memory is the point. Favors and place cards…' but the plate shows the Mintel quote; slide 3 alt 'The reason behind the keepsake…' is a headline stat_callout never paints. Sitti 08c: slide 4 alt 'detailing the four-week evaluation standard…' but the plate shows only the matrix list.
- **#196 ('one closer per carousel') fixed a cause that was not the one in its incident, so the defect came back.**
  - Cause: #196 blamed the writer for putting a closer on slide 7 and added a `resolveLayout` position guard (slides-data.ts:1674-1687). Its incident run actually had one closer in every document and a merge that left the first render's closer orphaned at slide-8.png. #228 (closer forms, `closerFormFor` 1111-1114) only styles the single closer and is not implicated.
  - Evidence: incident196.cjs on pubsub-21701979152019948: copy attempt-1 layouts `…7:list_takeaway 8:closer`; 07c `7:list-takeaway 8:closer`; 08a1b merge 6 into 5; 08a1c `6:list-takeaway 7:closer`; 08c 7 alt rows.
- **The delivered sets repeat themselves: the cover is restated on the closer, one sentence appears on two slides, the same figure appears four times, same-composition plates run back to back, and four clients shipped the same skeleton.**
  - Cause: No intra-set text measure exists (07d is cross-post). The copy prompt asks for rememberLine 'on the cover or on the closer' (latest.md:933-937), and writers restate it on both. `the_breakdown`'s 'do not restate the cover' line (editorial-series.ts:129) is never checked. Adjacency is warn-only and blind to device suffixes (skeleton-memory.ts:533-547), and the `headline_focus` repeat is now allowed (slides-data.ts:1694-1699). The recap strip adds more repeats (buildRecapFragment 1321-1337). The fixed series `middle` plus concurrent batch runs give identical skeletons across clients.
  - Evidence: Sitti copy: cover subtitle 'The rest of the criteria don't care how many followers you have.' repeated verbatim as the closer CTA (trigram Jaccard 0.48). Cover title vs slide 5 headline 'Your follower count is the wrong question.' scores 0.57. 25% is painted on the cover device, a list row, the closer takeaway and the recap. Slides 5 and 7 both say 'four weeks is the standard'. The delivered Sitti 08a1e signature has `headline_focus+versus>headline_focus` adjacent with warnings []. Kindly Yours cover 'A personal touch is not the finishing detail.' vs closer 'A personal touch is not what you add at the end.' is a paraphrase (Jaccard 0.10, invisible to trigrams). The Pitch: 6 headline_focus in a row (the_list), warnings []. Hanky Panky, Kindly Yours and XO Digital 07c share `cover slide stat-callout list-takeaway quote-card headline-focus slide closer`.

**Proposed changes**

- [S] (I, N; agent-engine) Give every render its own object prefix so no render can leave an orphan at a live address. Add a `renderKey` input to publish.renderCarousel and write `instagram/<client>/<postId>/<renderKey>/slide-<n>.png` (and `<outDir>/<renderKey>/` locally). The key defaults to a 12-hex sha256 of the slides data; the workflow passes the step id (resume-safe) at 08, 08-typographic, 08a1c and any #247 round-2 render. Bump TOOL_VERSION 1.11.0 to 1.12.0 (render-carousel.ts:171) and update the path-pinning tests (render-carousel.test.ts:137-161). Every step record then describes its own pixels. The deliverable (15414-15415) and the portal rehost (materialize.ts:573) already use explicit URLs and need no change.
- [M] (I, C, H; agent-engine) A merge happens only where its words will be seen. In `mergeRemedy` (interest-relayout.ts:783-805), `into` must be photo, headline_focus or text_only (never cover, quote_card, list_takeaway, stat_callout, comparison_card or closer), and words(into.body)+words(carry) must fit BODY_WORD_BUDGET[into.layout] (slides-data.ts:1126-1134). Try the previous interior neighbour, then the next; otherwise no merge and the ladder continues. Add a recorded `fold-into-caption` change (final attempt only, respecting slides_min): drop the plate and append its headline+body to the caption, modelled on move-sentence-to-caption (workflow 13215-13222). In the apply case (13130-13151), assemble the candidate and verify every carried sentence is in its fields; if not, discard it through the existing rollback (13295-13314). At 08a1d (13266-13280), also run checkSlideWordBudget and checkDefaultRenderRules; a candidate that adds a failure is discarded.
- [M] (I, M; agent-engine) On the final attempt, fix a plate 07h fails for `default:no-image-means-device` before rendering instead of waiving it (workflow 12645-12663). Run the same free ladder pre-render with a synthesized one-element finding: promote an unused vetted picture, then switch to a content-shaped archetype, then a verbatim device, then fold-into-caption. Then render once. This removes the flag, waive, render, merge and delete chain behind 24 of 29 merges.
- [M] (I; agent-engine) Add a set-integrity gate on the rendered carousel. In measureSlidePng (slide-metrics.ts:635+), accumulate a 9x8 luminance grid in the existing decodePngRows pass to compute a 64-bit dHash, and hash the buffer with sha256; both land in `metrics` for free. New pure module set-integrity.ts checks:
- exactly one cover.html at index 0 and one closer.html at the last index;
- slide numbers run contiguously 1..N;
- every rendered path and gcsUri is unique;
- no two slides share a sha256;
- no pair has dHash Hamming distance ≤6 AND text similarity ≥0.6 (core similarity.ts:88);
- text coverage: every primary field of the copy per archetype, and every merge carry, is in the rendered document or recorded in the caption;
- warn-only: OCR (08a4 textInImage) against the document fields.
Run it as `08a1f-set-integrity` after 08a1d, feeding the relayout ladder, and again in 09b before ledger.writeDeliverable (15298-15307). There, byte-identical plates, a second closer or a lost carry throw WorkflowToolingFailure.
- [S] (I, C; agent-engine) Alt text and the judge read what actually rendered, and the judge is told what should be there. Build the packager's slides from finalSlidesData fields instead of finalCopy headline/body (workflow 13990): title/subtitle, headline/body, figure/subLabel/body/sourceLine, quoteText/attribution, list items. Give 08b an `intendedText` per slide (the copy's primary fields) plus the relayout plan (13784-13814, instagram-visual-qa-agent.ts). Visual-QA prompt @6: §5 compares textInImage against intendedText; §6.2 must name any two slides that make the same point. The contact-sheet brief (13731) asks which slides look alike.
- [M] (I, C; agent-engine) Enforce harmony rules in code, pre-render first.
(a) Composition adjacency: token = archetype + figurePlacement, with the device suffix dropped for this comparison (skeleton-memory.ts:258-292, 533-547). Adjacent interior plates with the same token return on attempts 1..n-1 at 07k (workflow 12736-12756) and are remedied by the free ladder on the final attempt, not just warned (631-643). The only exception is a series whose middle repeats by design (the_list, editorial-series.ts:169-176), and only while device kinds alternate.
(b) New slide-text-distinctness.ts at 07:
- no sentence verbatim on two slides;
- no headline pair ≥0.4 trigram Jaccard;
- closer takeaway vs cover title ≥0.4 returns the draft;
- a figure appears on at most 2 plates, recap excluded;
- the closer takeaway never repeats a figure its recap shows;
- paraphrase ('which two slides make the same point') becomes one more 07j value-judge question.
(c) Copy prompt @32: rememberLine on exactly one of cover or closer (latest.md:933-937), and 'no slide restates another'. Reconcile latest.md:470-480 with the headline_focus exemption (slides-data.ts:1694-1699), or revert the exemption and fix #238's empty photo plate another way. Bump skillRef (instagram-copy-agent.ts:489).
- [S] (I; agent-engine) Fix the series grammar so the thin plate is never parked behind a plate that cannot show its words. Reorder the middles of the_breakdown (editorial-series.ts:127), the_playbook (135) and in_their_words (157) so headline_focus never directly follows quote_card or list_takeaway. For example, the_breakdown becomes [photo, stat_callout, headline_focus, list_takeaway, photo, quote_card]. Add a test for it. the_breakdown is the fallback that gave 4 of 8 clients the same middle on 2026-09-24.
- [S] (I; data-fix) Re-harvest the owner's review sheets from the deliverable's `rendered` list, or the last committed `08a1c-render-relayout*` step with its slidesData, instead of `08-render-carousel` and `07c` (scratchpad harvest.cjs:18,21). The Kindly Yours, Sitti and karoslabs B reviews would then show the 7 slides that shipped. Separately, and only with the owner's approval plus an account that has storage access (the portal service account gets 403), delete the 29 orphaned `slide-8.png` objects that merge-census.cjs lists under karoscmo-prep-media-assets. The PR summary should also correct #196's diagnosis.

**Guards**

- render-carousel.test.ts: render 8 slides, then 7, for the same postId against a fake media store that records every upload. Assert the two renders use disjoint prefixes, no objectPath is ever uploaded twice, and the 7-slide result has no slide-8.
- interest-floor-step.test.ts (runToGate), fixture shaped like the Kindly Yours run: a quote_card at slide 5 and a thin headline_focus at slide 6 on the final attempt. Assert the delivered slidesData fields or caption contain 'Most wedding designs are built around aesthetics'; rendered.length === slides.length; every rendered gcsUri is distinct; exactly one closer.html, at the last index. Same test shaped like the Sitti run (list_takeaway at slide 4).
- interest-relayout-ladder.test.ts, a property test over every archetype as `into`: no merge-into-neighbour is ever planned into cover, quote_card, list_takeaway, stat_callout, comparison_card or closer, or when words(into.body)+words(carry) > BODY_WORD_BUDGET. The existing test (line 53) asserts the plan shape only; add one asserting the carry appears in assembleSlidesData(nextCopy) for every series and every failing position.
- text-coverage unit test: for each archetype, copy primary fields versus the assembled document. The relayout documents of Kindly Yours pubsub-21255254988332367 (slide 5) and Sitti pubsub-21255328593979584 (slide 4), used as fixtures, must fail.
- set-integrity.test.ts: byte-identical PNGs (the Kindly Yours slide-7/slide-8 fixtures) are refused. The Sitti near-identical closers (small dHash distance plus high text similarity) are refused. The Pitch's 8 plates, which share one system but differ in text and device, pass. At 09b, a set with a second closer.html, non-contiguous n or a duplicate sha256 throws WorkflowToolingFailure.
- slide-text-distinctness test, Sitti final copy: flags the cover subtitle repeated verbatim as the closer CTA, and the cover title vs slide 5 headline (0.57). Plumbing test: the Kindly Yours paraphrase (0.10) reaches the value judge's 'same point' question with both slides' text.
- skeleton-memory.test.ts: `headline_focus+versus` next to `headline_focus` is an adjacency finding. the_list with alternating device kinds passes. A non-series back-to-back composition returns on attempts 1..n-1 and is remedied, not warned, on the final attempt.
- editorial-series test: no BUNDLED_SERIES middle places headline_focus directly after quote_card or list_takeaway.
- Prompt/code sync test: the once-per-carousel archetypes named in prompts/instagram-copy/latest.md equal the non-repeatable set enforced by resolveLayout.
- Packager input test: a quote_card slide's alt-text input is its quoteText and attribution, and a stat_callout's is its figure, subLabel and body. Neither is the fallback headline or body.
- Ledger invariant, counted in 09b: re-layout merges whose carry is absent from both the rendered document and the caption must be 0. Recorded as an error event and surfaced on the gate payload.

**Risks**

- Folding a plate into the caption shortens the post. At slides_min (6) the fold must be refused, and the thin plate then ships intact and flagged. Words are never deleted to meet a count.
- Per-render prefixes keep every render: up to 3-4 renders × 7-8 PNGs at 1-3 MB each per run. Add a bucket lifecycle rule that expires superseded render prefixes after about 30 days and keeps the final render.
- dHash distances between different plates of one consistent visual system can be small (same grid, same ground). Require both perceptual AND textual similarity before calling two plates duplicates, and calibrate on the 67-run prep corpus before arming.
- New pre-render text gates return more drafts on attempts 1-2 (about $0.18-0.31 per copy return). Today 07h/07h2 already push every render to attempt 3, so arm only verbatim-sentence reuse and cover-vs-closer at first, and keep pair similarity warn-only until calibrated.
- Trigram Jaccard misses paraphrase (Kindly Yours cover vs closer scores 0.10), so the 'same point' judgement stays with an LLM question. That can be inconsistent: the same ellipsis failed Sitti's judge and passed Kindly Yours'.
- Runs resumed across the deploy will mix flat and keyed object paths. That is safe because the deliverable carries explicit URLs, provided renderKey derives from the step id so a replay writes the same path.
- Reordering series middles changes skeleton signatures once; cross-post variety sees a 'new' skeleton on the next run. Harmless.
- If #247 merges before the guards, the next prep sweep can drop two slides per post and leave two orphans.
- The human gate is not a backstop for this class: Kindly Yours 09a was approved by system:gate-timeout. #232's longer wait helps only if someone reviews.

## Logos (E, F, G): which logo a post carries, how the file is treated, and where and how big it sits

**How it works today**

1. WHERE THE LOGO COMES FROM TODAY (precedence).
Portal: engineBrandLogoUrl takes Client.logoUrl first, then brandingGuidelines.logoUrl, https only (karos-portal src/lib/brand-logo-file.ts:70-90).
- Client.logoUrl has three writers and no field saying which one wrote it:
  - the upload route (src/app/api/clients/[id]/logo/route.ts:62-68)
  - the lab importer (scripts/import-lab-client.ts:381-398, 413, 428)
  - one-off scripts, for example commit eb6d3fa3 (apply-pbd-rebrand-decisions) on the unmerged branch pbd-rebrand-portal-2026-09-17.
- The lab importer keeps any existing Client.logoUrl (:381-383). Otherwise it uploads ONE file from a list that starts with a Geektime-only filename and then prefers logo-light.*, which is the lab's dark-ground variant, whatever the client's ground (:368-379).
- The type holds only logoUrl and logoStoragePath (src/lib/types.ts:131-133, 1865-1867). There is nowhere to record a source, variants, a treatment, a corner or a size.
- Projection writes logoUrl into clients/<slug>/client/brand.json (src/lib/agent-engine/context-doc-projection.ts:219, 232, 312-322). It runs only on logo save (route.ts:68) and on portal dispatch (src/lib/agent-engine/dispatch.ts:113-133, 181). Before portal #208 (landed 2026-09-24 10:32 -0300) only brandingGuidelines.logoUrl was projected.
- Onboarding branding uses an existing logo only as a source of colours (src/lib/branding.ts:1080, 1106). It finds the site's logo SVGs (src/lib/branding-site-palette.ts:262, 278-288) and fetches the Instagram avatar ('on Instagram, this is the brand mark', src/lib/branding-scrappycoco.ts:64, 198), reads their colours, then throws them away. Neither is ever stored as a logo candidate.

Engine:
- deriveBrandRenderTokens keeps brand.logoUrl if it is https (agent-engine agents/instagram-agent/src/workflow/brand-render-tokens.ts:872-886).
- ensureBrandLogoDataUri downloads it. When it is absent OR fails to download, discoverSiteLogo fetches the homepage (8 s timeout) and uses the first of up to 4 candidates that downloads (create-instagram-agent-workflow.ts:2600-2660).
- Candidate order: JSON-LD logo, then a header/nav img named 'logo', then an img naming the brand, then apple-touch-icon, then an icon of 128px or more, or any vector icon (logo-discovery.ts:15-29, 111-146; PRs #221 and #229).
- homepageUrlFor keeps only the origin and drops the path (logo-discovery.ts:148-161). A test pins that behaviour (__tests__/logo-discovery.test.ts:62).
- The discovered URL is never saved. The gate only suggests that a human 'pin it' (create-instagram-agent-workflow.ts:14495-14507).
- Nothing in agent-engine reads the lab's brand/logos folders or brand.yaml logo blocks.

2. HOW IT IS DISPLAYED TODAY.
- No background removal and no trim: the raw bytes are embedded as a data URI (packages/tools/karos-media/src/brand-logo.ts:206-208; brand-render-tokens.ts:1451-1453).
- Size: the planner asks for 150px wide (brand-logo.ts:598). Every logo shape is then clamped to 65px WIDTH (visual-system.ts:542; brand-render-tokens.ts:1365). Height follows the aspect ratio. Inset is 44px (brand-logo.ts:596). The reserved zone is a fixed 132px square (visual-system.ts:520). Opacity drops to 0.9 when the logo out-contrasts the headline (brand-render-tokens.ts:1400-1402).
- Corner: chooseCorner returns top-end when hasSeriesBadge is true, else top-start (brand-logo.ts:612-615).
  - The workflow sets hasSeriesBadge = standing badge OR 'this run's planned eyebrow is topical' (create-instagram-agent-workflow.ts:2721-2723).
  - eyebrowFor returns topical for every client outside the illustration/none imagery register (visual-system.ts:927-932).
  - That logo rule dates from 2026-09-17 02:41 (acdf5ee4). At 14:03 the same day the eyebrow moved to the END of the brand band (assets/templates/default/_design-system.css:790-793, ef81e54d6).
  - The design system also records that Instagram's 'n/N' counter pill covers 38-107px from the top and 38-130px from the side at the top reading-end corner (:795-805, 2026-09-23). So the logo now goes to the same end as both the eyebrow and the counter.
- The Template Studio calls brandFragments at 00c (create-instagram-agent-workflow.ts:3106). That is before logoSite is set at 03a (4369-4372) and before runVisualSystem is set at 04p (7171). So studio renders get top-start, and no logo at all when the logo would have come from discovery (2601).
- Contrast:
  - Ink is read from PNG pixels or from SVG paints (brand-logo.ts:369-409, 473-508).
  - An opaque background counts as ink, and the best-contrasting mass wins (brand-logo.ts:514-529). An existing test explicitly allows this (karos-media __tests__/brand-logo-contrast.test.ts:229).
  - currentColor SVGs are placed without any measurement (brand-logo.ts:480, 671-673).
  - Contrast is measured only against --bg (brand-render-tokens.ts:1435), never against the photograph on cover/photo slides. The top third of those slides has no scrim by design (_design-system.css:807-811).
  - A mark that fails gets a plate added behind it: fg, then white, then black (brand-logo.ts:628-640; brand-render-tokens.ts:1371-1378).

3. ENTITY MARKS ARE A SEPARATE PATH.
- #207 (the renderer places a .mark-badge where the picture is quiet; packages/tools/karos-publish/src/mark-placement.ts:1-193, called at render-carousel.ts:1366) has been dead since #227: badgePath is always undefined (slides-data.ts:3166).
- #212/#213: looksLikeMark (entity-imagery.ts:395-402).
- #230 lifts an entity mark off its backdrop with media.cutout (create-instagram-agent-workflow.ts:10826-10874; karos-media src/cutout.ts:14-60, 181-240) and sets it 'mark-clear', white on dark (_design-system.css:223-273). #233 does the same for product photos (10876-10900).
- None of this is applied to the client's own logo. branded-shorts already derives a keyed client mark once per client with video.deriveMark (agents/branded-shorts-agent/src/workflow/derive-brand-setup.ts:27-28, 433-465).

4. GATE.
- 08a2 reports only present, corner, scrimmed and groundContrast (visual-qa-pre-checks.ts:159-200; create-instagram-agent-workflow.ts:13445-13450).
- The judge is told presence and legibility were already verified and not to re-judge them (visual-qa-pre-checks.ts:296-300).

5. WHAT EACH RUN USED (from 02g brand.json, 08a2 and the 09a gate payload; css px on the 1080 canvas).
- karoslabs A pubsub-21254982994413907 and B pubsub-21254987466423505:
  - brand.json (projectedAt 2026-09-24T06:26Z, before #208) had no logoUrl, even though prep Client.logoUrl holds an upload (Screenshot_2026-07-10_124752.png).
  - Discovery found https://karoslabs.com/icon.svg, a 290x290 favicon whose first element is a #1A1A1A rounded rect (rx 64.9).
  - Placed top-end at 58x60, contrast 15.39:1. On cover photos the rounded rect shows as a dark box.
  - The lab has logo-light.svg and the head disc. Karos's old IG engine locked the lockup top-left on every slide (karos-agents clients/karoslabs/skills/instagram-agent/engine/config.yaml:30-44; templates/karos-core.css:67-86).
- geektime pubsub-21255132410207986:
  - Kit logo from the lab import: geektime-profile-disc.png, a 320x320 avatar disc.
  - Top-end, which is the physical left in RTL. The visible ring is about 33px on white. Contrast 14.30:1.
  - The lab README names logo-dark.svg (light grounds) and logo-light.svg (dark grounds) as the canonical marks.
- thepitchbydeel pubsub-21255292697877233:
  - Prep has no logo. Prod Client.logoUrl is the-pitch-logo-dark-v4.png, set 2026-09-17T18:46Z by eb6d3fa3. That was after prep's last sync: all seven prep client docs show updatedAt 2026-09-17T14:29:28Z.
  - Discovery read https://www.deel.com/ (the path was dropped) and took Deel's parent wordmark (logo_revamp_164ddaed0c.svg).
  - Contrast 1.03:1 on #201547, so it was scrimmed: a 65x22 'deel.' on an 88x46 white chip, top-end.
  - The lab brand.yaml says: top-left, the official app icon, 'NOT a gradient chip', stacked lockup minimum 120px (thepitchbydeel/brand/kit/brand.yaml:53-60).
- hankypanky pubsub-20296546809871980:
  - No logo in the portal at all.
  - Discovery found hankypanky.com/cdn/shop/files/logo.svg. Its fill is currentColor, so the ink was unreadable and it was placed without measurement.
  - A 5.48:1 wordmark rendered at 64x12, top-end, over photographs with no check.
- kindlyyours pubsub-21255254988332367:
  - No logo on any slide.
  - The website on record, kindlyyours.com, is a 114-byte JavaScript redirect to /lander. The lab profile gives thisiskindly.com (profile/product-information.md).
  - The lab has logo-dark.svg and logo-light.svg.
- sitti pubsub-21255328593979584:
  - Kit logo is the portal upload Screenshot_2026-07-19_121949.png: an opaque cream rectangle, then an app-icon rounded square with a shadow, then the grapefruit.
  - Contrast 3.01:1 on #fff8d6, top-end. The tile is 58x50 and the grapefruit about 37px.
  - On photo slides 1-2 the cream rectangle shows: pixel row y=46 on slide 1 is #FFF8D6 from x 974 to 1034, over the photo.
  - The lab's logo-dark.png is exactly the keyed grapefruit (677x663 RGBA, 69% transparent). Its brand.yaml says top-left, minimum 40px, never on a busy photo without a plate (sitti/brand/kit/brand.yaml:13-21).
- xodigital pubsub-21255292697884248:
  - brand.json (projectedAt 2026-09-20T18:10Z) had no logoUrl, even though prep Client.logoUrl holds an upload (images.jpg).
  - Discovery found https://xodigital.com.br/newxo.png: 1024x1024 RGB, 0% transparent, #F7F7F7 border.
  - The 18.69:1 contrast is measured on its own background. It shows as a white 64x64 box on #050520, top-end.
  - The lab's logo-light.svg is the transparent cream mark for dark grounds.

Across all eight runs:
- 04p had eyebrow.kind 'topical' and 08a2 put the logo top-end.
- No slide in any 07c output carries a kicker, so no eyebrow ever rendered.
- The judge passed brand-asset-integration on every run, and called the Sitti and Hanky Panky logos 'the brand handle'.

**Root causes**

- **E: every client's logo lands in the top-right corner (top-end), under Instagram's n/N counter pill, and the corner is never decided per client.**
  - Cause: chooseCorner flips to top-end whenever hasSeriesBadge is true (brand-logo.ts:612-615), and the workflow feeds it the run's PLANNED eyebrow (create-instagram-agent-workflow.ts:2721-2723). eyebrowFor makes that eyebrow topical for every client outside the illustration/none register (visual-system.ts:927-932). The rule was written 2026-09-17 02:41 (acdf5ee4), when the eyebrow sat in the start corner. The same day at 14:03 the eyebrow moved to the END of the band (_design-system.css:790-793), and on 2026-09-23 the end corner was measured to be under Instagram's counter (:795-805). The logo rule was never revisited, so the logo now goes toward the eyebrow and under the counter.
  - Evidence: All 8 runs: 04p eyebrow.kind topical, 08a2 corner top-end, and zero kicker fields in any 07c output, so no eyebrow rendered. Measured logo boxes: Karos 58x60 at x 978-1036, y 48-108; XO 64x64 at x 971-1036, y 44-108. The pill covers x 950-1042, y 38-107 on the 1080 canvas, which is 97-98% of the logo box. Karos's older IG engine locked the logo top-left with the eyebrow top-right (karos-agents clients/karoslabs/skills/instagram-agent/engine/config.yaml:43; templates/karos-core.css:67-86). The Sitti and The Pitch kits both say top-left (sitti/brand/kit/brand.yaml:18; thepitchbydeel/brand/kit/brand.yaml:57).
- **E: the same client's logo differs between its studio templates and its posts, and can change from run to run.**
  - Cause: Placement is re-planned on every call from per-run state. The Template Studio calls brandFragments at 00c (create-instagram-agent-workflow.ts:3106), before logoSite is set at 03a (4369-4372) and before runVisualSystem at 04p (7171). So discovery returns early (2601) and the corner resolves to top-start, while posts resolve to top-end. A discovered logo is re-scraped every run and never saved (2591-2619), so a site change or a failed fetch can change or drop the mark between posts.
  - Evidence: Code order as cited. The gate carries the discovered URL only as advice to pin it (14495-14507). karoslabs.com/icon.svg is served with a cache-busting query (icon.2s5d3mfk5m0bp), so the asset can change on any site deploy.
- **E: every logo shape gets the same fixed width, so wordmarks and marks inside tiles come out unreadably small, below the brands' own minimum sizes.**
  - Cause: planBrandLogoPlacement asks for 150px wide (brand-logo.ts:598), and the emitter clamps every logo to 65px WIDTH (visual-system.ts:542; brand-render-tokens.ts:1365). Height follows the aspect ratio. Nothing trims padding or tiles first. The reserved zone is a fixed 132px square (visual-system.ts:520).
  - Evidence: Measured on the renders (css px): Hanky Panky wordmark 64x12 (a 5.48:1 SVG); Geektime disc shows about a 33px ring; Sitti grapefruit about 37px inside a 58x50 tile; The Pitch 65x22 wordmark on an 88x46 chip. The brands' own minimums: The Pitch stacked lockup 120px (thepitchbydeel/brand/kit/brand.yaml:59), Kindly Yours wordmark height 32px (kindlyyours/brand/logos/README.md), Sitti 40px on an asset (sitti/brand/kit/brand.yaml:19).
- **F: an uploaded logo does not reliably reach the post; a scraped logo is used instead.**
  - Cause: (a) Client.logoUrl is one field with three writers and no provenance (route.ts:67, import-lab-client.ts:428, eb6d3fa3), so 'uploaded' cannot be ranked above anything. (b) brand.json is refreshed only on logo save and on portal dispatch (route.ts:68; dispatch.ts:113-133, 181), and before portal #208 only brandingGuidelines.logoUrl was projected (brand-logo-file.ts:70-90). A run started any other way reads a stale brand.json, and the engine cannot tell its age. (c) Prep and prod are separate databases synced by hand. (d) When the configured logo fails to download, the engine silently substitutes a scraped one (create-instagram-agent-workflow.ts:2643-2649). (e) Logo URLs are Firebase token URLs in a bucket prep and prod share, and a re-import revokes the token (import-lab-client.ts:47-54).
  - Evidence: karoslabs and xodigital have uploads in prep (Screenshot_2026-07-10_124752.png, images.jpg). Their runs read brand.json projected at 2026-09-24T06:26Z and 2026-09-20T18:10Z with no logoUrl, and both gates say 'found on the client's own site ... (the brand kit carries no logoUrl)'. The Pitch's logo exists only in prod (the-pitch-logo-dark-v4.png, set 2026-09-17T18:46Z by eb6d3fa3), after prep's last sync (all seven prep client docs show updatedAt 2026-09-17T14:29:28Z). The prep run shipped Deel's parent logo.
- **F/G: site discovery picks the parent company's logo when a client's site is a sub-path of that parent's domain.**
  - Cause: homepageUrlFor keeps only the origin (logo-discovery.ts:148-161, pinned by logo-discovery.test.ts:62), so https://www.deel.com/the-pitch-by-deel/ is read as https://www.deel.com/. The portal already fixed the same mistake for the palette with brandPageUrl (branding-site-palette.ts:335-359; branding.ts:1060-1067); the engine's logo path never got the fix. Discovery also accepts the first candidate that downloads, with no check that it is this brand's mark.
  - Evidence: Gate payload for pubsub-21255292697877233: 'found on the client's own site: https://www.deel.com/_next/image/?url=...logo_revamp_164ddaed0c.svg'. It rendered as 'deel.' on a white chip on all 8 slides. The lab README says not to present the parent Deel mark as the program's own (thepitchbydeel/brand/logos/README.md).
- **G: logos that carry a background render as boxes and tiles (Sitti's rounded square, XO's white square, Karos's dark rounded square on the cover photo).**
  - Cause: The client logo has no treatment step: its bytes are embedded raw (brand-logo.ts:206-208; brand-render-tokens.ts:1451-1453). The ink reader counts an opaque background as a colour and takes the best-contrasting one (brand-logo.ts:369-409, 514-529), so the background alone passes the contrast check; an existing test allows this (brand-logo-contrast.test.ts:229). Background removal exists only for entity marks and product photos (media.cutout at 06h25 and 06h26, create-instagram-agent-workflow.ts:10826-10900) and for branded-shorts (video.deriveMark, derive-brand-setup.ts:433-465).
  - Evidence: xodigital.com.br/newxo.png is 1024x1024 RGB, 0% transparent, with a #F7F7F7 border; the 08a2 groundContrast of 18.69 on #050520 is the background's, not the mark's. Sitti's upload renders as an opaque cream rectangle (pixel row y=46 on slide 1 is #FFF8D6 from x 974 to 1034, over the photo), then a rounded tile, then the grapefruit. The lab already has the keyed grapefruit (sitti/brand/logos/logo-dark.png, 677x663 RGBA). karoslabs.com/icon.svg starts with a rect rx 64.9 fill #1A1A1A, which shows as a dark box on the cover photo.
- **G: legibility is measured against the kit's ground colour only, never against the photograph the logo actually sits on.**
  - Cause: planBrandLogo passes --bg as the ground (brand-render-tokens.ts:1428-1441), and the top third of photo slides has no scrim by design (_design-system.css:807-811). SVGs that use currentColor have no readable ink and are placed without measurement (brand-logo.ts:480, 671-673).
  - Evidence: Hanky Panky's 64x12 black currentColor wordmark sits on a wood-texture photo on slide 1, and 08a2 has no groundContrast for it. Sitti's kit forbids the mark on a busy photo without a plate (sitti/brand/kit/brand.yaml:21), yet slides 1-2 put it directly on photographs.
- **F/G: the lab's curated light/dark logo pairs and logo rules never reach the engine.**
  - Cause: import-lab-client uploads ONE file (import-lab-client.ts:368-398). Its list starts with a Geektime-only filename and prefers logo-light.* (the lab's dark-ground variant) whatever the client's ground. It keeps any existing Client.logoUrl and ignores brand.yaml logo blocks. The portal type has no place for variants, rules, corner or size (types.ts:131-133, 1865-1867), and agent-engine never reads the lab.
  - Evidence: The lab has logo-dark/logo-light pairs for 6 of the 7 clients, brand.yaml logo blocks for Sitti and The Pitch, and a logo block in Karos's old engine config. Geektime got its 320x320 avatar disc instead of the wordmark. The Pitch's prod upload is the BLACK lockup, chosen 'because the portal renders client logos on white tiles' (eb6d3fa3), and it would be illegible on the dark post ground.
- **G: Kindly Yours shipped with no logo at all.**
  - Cause: Its only automatic source is discovery on the website in its client record, and that website is a parked domain. The lab logos were never imported.
  - Evidence: kindlyyours.com returns 114 bytes: a JavaScript redirect to /lander (fetched 2026-09-24). The lab's profile/product-information.md gives thisiskindly.com. branding.ts:1130-1131 already notes the blank white screenshot of that domain. Gate: 'this client's brand kit carries no logoUrl, and none was found on its site'.
- **E/F/G: neither the gate nor the judge can catch any of these problems.**
  - Cause: assessBrandAssetPresence reports only present, corner, scrimmed and groundContrast (visual-qa-pre-checks.ts:159-200). It has no source, no background check, no rendered size and no photo check. The judge is told presence and legibility were already verified and not to re-judge them (visual-qa-pre-checks.ts:296-300).
  - Evidence: 08b passed brand-asset-integration on every run. It said XO's white box 'sits cleanly' and the Deel parent logo 'cleanly integrates', and it called the Sitti and Hanky Panky logos 'the brand handle'.

**Proposed changes**

- [M] (E, F, G; karos-portal) Add a per-client BrandLogoSpec to the brand kit, plus a pure decision module.

Spec fields:
- sources[]: kind (upload, lab, site or instagram-avatar), url, storagePath, sha256, mime, width, height, hasAlpha, background {hex, coverage}, capturedAt, capturedBy.
- The chosen source and why it was chosen.
- variants {onLight, onDark, mark}: processed, trimmed, transparent files with a hash and a box.
- treatment: background (none, removed, removed-tile or kept); recolor (never, white-on-dark or black-on-light, taken from the brand's rules); onPhoto (switch variant, plate or omit).
- placement: corner, the rule that picked it, widthPx, heightPx, insetPx.
- status (auto or approved), decidedAt, decidedBy.

Precedence for which logo it is: upload, then lab kit, then site, then Instagram avatar. A site logo never beats an upload or a lab asset. For which FILE of that logo is used: a lab asset that matches the processed upload after trimming is used as the clean file.

Corner rule: use the brand's own rule when there is one (lab brand.yaml placement or corner_mark, or the brand book). Otherwise use top-start (top-left for left-to-right posts, top-right for right-to-left). Use top-end only when a brand rule demands it, and then set the logo below Instagram's counter pill. The corner is never an input of a run.

Size rule: trim to the mark itself, then give every logo the same visual area, about 4,900 css px2 on the 1080x1440 canvas. Height floor is 32px or the brand's minimum, whichever is larger; width cap 240px; height cap 96px; inset 44px.

Approximate result for the seven clients: Karos 73x67; Geektime wordmark 164x32 (or the G icon at 70x70); The Pitch stacked lockup 120x54 (or the app icon at 70x70); Hanky Panky 175x32; Kindly Yours 93x52; Sitti 70x70; XO 87x56.
- [L] (E, F, G; karos-portal) Onboarding decides the logo, as a step in applyBrandingForClient and in lab mode.

1. Collect candidates:
   - the client's upload
   - the lab variants
   - the site's logo SVGs that branding-site-palette already finds and throws away, read from brandPageUrl so the path is kept
   - the Instagram avatar that branding-scrappycoco already fetches
2. Process each candidate once:
   - strip a full-canvas background rect from an SVG
   - resolve currentColor separately for each variant
   - for a raster without transparency: remove a uniform background at the border, then a nested uniform tile, then trim, reusing removeUniformBackground or derive_mark
   - refuse and flag rather than cut badly
3. Derive onLight and onDark variants by contrast against the kit's ground and ink colours, within the brand's recolor rule.
4. Store the files content-addressed under clients/<id>/brand-logo/<sha>-<variant>.<ext> and write the spec as status auto. Staff approve it.

Outcomes:
- Sitti: the upload is the logo, and the lab's logo-dark.png is the clean file (grapefruit only). No recolor, a plate on photos, top-left.
- The Pitch: the prod upload is the logo, with the lab's logo-dark/logo-light pair picked by ground. Top-left, no chip.
- [M] (F, G; karos-portal) Uploads become first-class:
- The route records source=upload with uploadedAt and uploadedBy, runs the decision straight away, and re-projects.
- The Logo block shows the processed result on the client's ground and on a sample photo, with three choices: approve, keep the original background, or use the lab asset.
- The portal's UI tile logo is kept separate from the post logo, so a black lockup chosen for the portal's white tiles is never what posts carry.
- [S] (E, F, G; karos-portal) Project the spec into brand.json:
- Write a logo object: variant URLs, box, corner, treatment, specHash, decidedAt.
- Keep logoUrl as the default variant so older engines still work.
- engineBrandLogoUrl reads the spec first.
- Variant URLs must be durable, content-addressed objects, never a token URL that a re-import can revoke.
- [M] (E, F, G; karos-portal) import-lab-client imports the whole logo set as lab candidates:
- logo-dark.* becomes onLight, logo-light.* becomes onDark, and mark-only files are kept.
- The brand.yaml logo block (placement, minimum size, recolor, on-photo, do-nots) goes into the spec.
- Delete the Geektime filename from the generic list.
- Never replace an upload's identity, and stop treating Client.logoUrl as the post logo.
- [S] (F; karos-portal) Every engine run start projects first, not only dispatchAgentEngineRun. The run input carries specHash and contextProjectedAt, so the engine can detect a brand.json older than the approved spec.
- [M] (E, G; agent-engine) The engine reads and renders the spec:
- ClientBrand gains a logo field, and deriveBrandRenderTokens carries it.
- brandLogoCss sizes the logo from the spec box instead of the 65px width clamp, and picks the variant by the slide's ground.
- The reserved zone becomes the spec box plus 16px instead of the fixed 132px square.
- planBrandLogo stays, as a contrast check on the chosen variant.
- A client without a spec keeps today's path, but see the discovery change.
- [S] (E; agent-engine) The corner comes from the spec, never from the run:
- chooseCorner takes the spec's corner, defaulting to top-start.
- Delete the eyebrow and series-badge flip at create-instagram-agent-workflow.ts:2721-2723; the eyebrow already sits at the band's end (_design-system.css:790-793).
- The studio (00c) and every post use the same resolved corner.
- A top-end spec is set below the counter pill (block inset of 112px or more).
- [M] (E, F, G; agent-engine) Demote site discovery:
- Never run it when brand.json has a spec or any configured logo.
- If a configured logo fails to download, render no logo and put a named finding on the gate. Never substitute a scraped logo.
- homepageUrlFor keeps the client's path, so a sub-path site is read as itself and never as the parent's root.
- A discovered candidate must pass the same background and tile analysis. It is reported as site-unapproved and saved as a candidate for the portal to approve.
- Until a spec exists, the engine derives one provisional spec per client, once, and caches it in the workspace (like branded-shorts derive-brand-setup), so every run uses the same file, corner and size.
- [M] (G; agent-engine) Make the ink reader see backgrounds:
- readBrandLogoInk reports an opaque colour connected to the border as a background {hex, coverage}, not as ink.
- Contrast is computed on the ink alone.
- planBrandLogoPlacement returns 'needs treatment' instead of 'place' for a logo with a background, unless the spec says the background is kept.
- currentColor SVGs are resolved for each variant instead of being placed without measurement.
- [M] (E, G; agent-engine) Photo slides: at the fixed corner, measure the rendered pixels under the logo box before the final screenshot. Reuse the in-page measuring in mark-placement.ts, which #227 left unused. Then apply the spec's onPhoto rule: switch to a variant that reaches 3:1 on those pixels, or draw the brand's plate, or omit the logo. Record the variant and ratio for each slide.
- [S] (E, F, G; agent-engine) Gate changes:
- brandAsset carries the source (upload, lab, site-unapproved or none), specHash, variant, rendered box, background and the per-slide photo ratio.
- verdictLine gets a degraded marker when the logo is site-unapproved, carries a background, is below its minimum size, or is missing. This is a visible marker, never a hold.
- The judge criterion stops claiming legibility was verified in those cases.
- [S] (E, F, G; lab) Give every client a brand/kit logo block with light_ground, dark_ground, mark_only, placement, min_px, recolor, on_photo and do_nots.
- Sitti and The Pitch already have one.
- Write karoslabs's from skills/instagram-agent/engine/config.yaml:30-44.
- Write geektime, hankypanky, kindlyyours and xodigital from their brand/logos READMEs.
- Fix the stale 'intentionally empty' README in thepitchbydeel/brand/logos; that folder has held six SVGs since 18 Aug.
- [S] (F, G; data-fix) Prep data:
1. Bring The Pitch's prod logo into prep.
2. Correct Kindly Yours' website: kindlyyours.com is parked and the lab says thisiskindly.com; confirm with the client.
3. Run the new decision for all seven clients and get staff approval:
   - karoslabs: the lab figure or disc. The 2026-07-10 screenshot upload needs a keep-or-replace call.
   - geektime: logo-dark.svg on white, with logo-light.svg for dark grounds and photos.
   - thepitchbydeel: the prod upload as the logo, with the lab pair picked by ground.
   - hankypanky: logo-dark / logo-light.
   - kindlyyours: logo-dark / logo-light.
   - sitti: the grapefruit only (lab logo-dark.png).
   - xodigital: lab logo-light.svg on navy. The images.jpg upload needs a keep-or-replace call.
4. Re-project brand.json for all seven.

**Guards**

- agent-engine brand-logo-spec test: the resolved corner and box are a pure function of the client's spec. They are identical for the studio render (00c), for eyebrow topical and none, with and without a series badge, and for 1-slide and 8-slide posts.
- Real-Chromium render test: the .brand-logo box never touches Instagram's counter-pill rectangle (38-107 x 38-130 css px at the top reading-end corner), in both LTR and RTL fixtures.
- Size test on real assets: the Hanky Panky 864x157.61 SVG renders at least 32px tall, a square mark renders 64-76px, and every rendered logo meets the spec's minimum. It fails on today's 64x12.
- brand-logo-contrast test: an XO-like 1024x1024 opaque PNG with a #F7F7F7 border is reported as having a background, and the plan never returns 'place' for it. The test at brand-logo-contrast.test.ts:229, which allows an opaque background as ink, is inverted.
- Nested-tile fixture (like Sitti: a rectangle, a rounded tile, then the mark): the treatment returns only the inner mark's box. A busy-background fixture is refused, never cut.
- logo-discovery test: https://www.deel.com/the-pitch-by-deel/ is read as itself, and the deel.com root logo is never a candidate; this replaces the path-dropping assertion at logo-discovery.test.ts:62. A JavaScript-redirect lander shows as 'site unreadable' on the gate.
- Workflow test with a fetch spy: when brand.json has a spec or a configured logo, zero homepage fetches happen, even when the configured logo's download fails. In that case the gate reports 'upload unreachable' and no logo renders.
- Portal precedence test: for which logo it is, upload beats lab beats site beats avatar. A matching lab file is used as the clean file. A site logo never overrides an upload or a lab asset.
- Portal projection test: brand.json carries a logo object with specHash, logoUrl equals the chosen default variant, and the engine-facing URL is a content-addressed object, not a revocable token URL.
- Importer tripwire: scripts/import-lab-client.ts contains no client slug or client-specific filename, and an import never replaces an upload's identity.
- Upload route test: an upload writes source=upload and a new spec, and triggers re-projection.
- Freshness guard: 02c records brand.json's projectedAt and specHash, and the gate flags a brand.json older than the spec's decidedAt passed in the run input.
- Gate test: verdictLine shows a degraded marker for a site-unapproved, background-carrying, below-minimum or missing logo, and the judge is no longer told legibility was verified in those cases.
- Fleet check before promote (agent-engine scripts/report-brand-logos.ts, alongside report-brand-contrast.ts): every active client has an approved spec, reachable variants, a corner and a box, and the script prints the source per client.

**Risks**

- A strict 'upload always wins' makes old screenshot uploads outrank curated lab kits: Karos's 2026-07-10 screenshot, Sitti's 2026-07-19 app-icon screenshot and XO's images.jpg. This needs the matching-file rule plus staff approval, or an owner decision that the latest deliberate human choice wins.
- The owner said 'top right or sometimes top left', but the repo's own measurement puts Instagram's counter pill over top-right. Defaulting to top-left needs his sign-off; if he wants top-right, the logo must sit below the pill.
- Right-to-left posts: the counter's side follows the viewer's UI language, so no top corner is clear for every Geektime viewer. A vertical offset may be needed.
- Uniform-background removal can eat parts of a mark that touch the edge or share the background colour, and nested-tile removal is a heuristic. Human approval, and refusing rather than cutting badly, are required.
- Recolor rules differ by brand: Sitti, Kindly Yours and Geektime forbid recoloring, while Hanky Panky's SVG is built to take any colour. A blanket white knockout, like the rule for entity marks, would break brand rules.
- Moving the logo to the start side and letting wordmarks grow to 240px changes the top band on every template. The start-side margins and the reserved zone need a calibration render sweep in both scripts.
- Two repos share one contract: an old brand.json without a logo object must keep working (fall back to logoUrl), and prep and prod share one Storage bucket.
- Turning off silent discovery can leave a client with no logo until onboarding runs; the gate must say so plainly.

## Graphics and imagery (owner letters M and H) in the agent-engine Instagram agent. Scope: the imagery tiers, the graphic devices, where AI generation gets chosen, and a proposed graphics layer driven by parameters.

**How it works today**

Paths are in agent-engine (agents/instagram-agent unless a path says otherwise). Run evidence comes from the final 07c-emit-slides-data and 08-render-carousel steps of the 8 prep runs, pulled read-only.

IMAGERY TIERS. A slide gets sourced only if its layout is in HERO_IMAGE_LAYOUTS (src/workflow/slides-data.ts:133-140) and its brief is not source:'none' (scene-brief.ts:69, 622-624; create-instagram-agent-workflow.ts:9085). The tiers run in this order:
- Tier 0: files the client uploaded for this run (workflow:5025-5046).
- Tier 0.5: the client's media library. Step 05y0 fills it once from the client's own website (workflow:5308-5458; packages/tools/karos-media/src/harvest-site-images.ts).
- Entity route 05b1 (workflow:9132-9240; entity-imagery.ts:457). Order: library, then the official press page, then the cited article (a news photo with credit), then Wikimedia/Openverse/Google Places, then stock.
- Stock 05b (workflow:9275; find-images.ts, routing.ts).
- Scrape 06b.
- Generate 06d (image.generate, $0.039 a frame; run-budget.ts:1027).
- The imagery floor 06h/06d2 (workflow:10555-10780).
- After vetting: mark lift 06h25 and product cutout 06h26 (workflow:10839, 10891; karos-media/src/cutout.ts).
- Product-campaign mode, opt-in only, generates every slide (product-campaign.ts:1-45).

WHERE AI GENERATION IS CHOSEN.
1. The 06d rescue tier, for any photo slide that retrieval left empty. MIN_GENERATED_IMAGES_PER_RUN=3 (run-budget.ts:184) is enforced outside every budget gate (image-gap-partition.ts:124-189; workflow:9866-9930). It counts GENERATED frames only (image-gap-partition.ts:103-110).
2. The 06h floor. When fewer than MIN_PICTURE_SLIDES=3 full-bleed pictures landed (imagery-floor.ts:119, 320-322), it backfills slides the writer marked source:'none' through planImageBackfill (image-density.ts:335-391). The prompt is either the writer's scene verbatim or an illustration in one of seven house styles (152-173). It generates 'REGARDLESS OF THE PLAN' (workflow:10731-10737), up to 8+4 frames (run-budget.ts:96,105; workflow:10608-10611, added in #246).
3. The 04m/04n concept frame.
4. Product campaign.
The copy prompt tells the writer 'Photo-driven is the default' and that code generates a frame for each picture-free slide (prompts/instagram-copy/latest.md:1230, 1235-1240). image.generate always asks for 'a photographic image' (karos-media/src/generate-image.ts:751) and forbids numbers and words (862-864). Since #246, a diagram brief under a photographic style is rewritten into 'An editorial photograph of the real-world setting…' (workflow:9469-9470; scene-brief.ts:561-573; visual-direction.ts:623-646).

GRAPHIC DEVICES.
- Eight code-built devices: figure, figure_pair, bars, timeline, versus, unit_grid, position_map, spec_table (slide-devices.ts:106-176, CSS 760-1042). Only cover, headline_focus and text_only render them (slides-data.ts:213).
- Archetype objects: stat_callout, comparison_card, quote_card, list rows and the closer recap. List rows use mono numerals, and the diamond marker is hidden (assets/templates/default/list-takeaway.html:1313-1325).
- Highlight marks (emphasis-marks.ts).
- Missing: icons, pictograms, any chart beyond bars, arrows or flow diagrams, and any path for a client's own SVG. The site harvester rejects .svg files and icon/logo/arrow/badge paths (harvest-site-images.ts:152-156, 177-181) and reads only og:image and img tags (239-289). Model-authored markup may not contain svg (packages/tools/karos-templates/src/safety.ts:35).
- A statement plate is limited to 'three subjects… no fourth' (bounded-object.ts:42-60).
- The renderer and floor already score a drawn graphic (packages/tools/karos-publish/src/render-carousel.ts:928-932; interest-floor.ts:1947-1951). Nothing produces one.
- imageryRegister (visual-system.ts:138,168) is read only by the eyebrow rule (928).
- The portal's BrandingGuidelines has no field for iconography, motifs or imagery policy (karos-portal src/lib/types.ts:1836-1873).

WHAT THE 8 RUNS SHIPPED (57 slides).
- 18 slides carry a picture:

| Source | Pictures |
|---|---|
| AI-generated | 6 (33%) |
| Stock (Unsplash 3, Pexels 2, Pixabay 1) | 6 |
| Entity route (Google Places 3, Wikimedia logo 1) | 4 |
| Client library or site | 2 |
| Uploads, scraped, news photos, product cutouts | 0 each |

- Generation: 33 frames bought (21 in 06d, 12 in 06d2), 6 landed (18%). The floor's 12 landed 0. That is about $2.34 of the $13.31 the 8 runs cost.
- Devices: figure 7, versus 5, timeline 2, spec_table 2, bars/figure_pair/unit_grid/position_map 0. Also stat_callout 6, list 6, comparison 4, quote 3, recap 7.
- Highlight marks painted: 0, although 54 copy slides declared emphasis.
- Drawn SVG graphics: 0 of 57.
- Picture-free: 37 of 57 slides were briefed source:'none', and 39 shipped with no picture.
- Text: 37.7 words per slide on average.
- Covers (H): title and subtitle are about 2.7:1 (139/52 px, for example). BODY_WORD_BUDGET has no cover entry (slides-data.ts:1126-1134). The scrim uses fixed stops (cover.html:337-352) plus a uniform veil (style-lock.ts:623-627, 811-824).

**Root causes**

- **Posts are heavy on AI pictures because generation is a guarantee, not a last resort.**
  - Cause: MIN_GENERATED_IMAGES_PER_RUN=3 (run-budget.ts:184) is enforced outside every budget gate by partitionGaps (image-gap-partition.ts:124-189; workflow:9866-9930). It is counted in GENERATED frames only, so a client photo or stock picture never discharges it (image-gap-partition.ts:103-110). It re-arms each time the vet refuses a frame. #246 (HEAD a65cdb8) raised the ceiling to 8 frames plus a 4-frame FLOOR_RESERVE_FRAMES (run-budget.ts:96,105; workflow:10608-10611). The 06d2 floor tier buys frames REGARDLESS OF THE PLAN (workflow:10731-10737).
  - Evidence: Across the 8 runs, 33 frames were bought and 6 landed (18%). The floor tier 06d2 bought 12 and shipped 0. By run: sitti pubsub-21255328593979584 bought 8, landed 1; xodigital pubsub-21255292697884248 bought 8, landed 0 (6 of them were portraits of CVM president Otto Lobo, refused each time); karoslabs A pubsub-21254982994413907 7/2; karoslabs B pubsub-21254987466423505 6/1. Cost: $1.29 for generation, $0.89 for vetting generated frames and $0.16 for a Geektime concept discarded at 04o. That is about $2.34 of the $13.31 the runs cost. 6 of the 18 shipped pictures are AI.
- **The picture floor can only be met by photographs, so every shortfall turns into an AI request. That includes slides the writer made picture-free on purpose.**
  - Cause: carriesPicture counts FULL_BLEED_IMAGE_LAYOUTS only (imagery-floor.ts:320-322; slides-data.ts:181) against MIN_PICTURE_SLIDES=3 (imagery-floor.ts:119). Step 06h fills source:'none' slides through planImageBackfill (image-density.ts:335-391) and sends every gap to image.generate. ImageryRemedy has no graphic rung (imagery-floor.ts:645). The floor cites the restraint reference, which says professional accounts carry 'a real photograph or a real diagram' (docs/instagram-restraint-reference.md:41; imagery-floor.ts:110-113). Only the photograph half was built. The copy prompt tells the writer this is how it works (prompts/instagram-copy/latest.md:1230, 1235-1240).
  - Evidence: 37 of 57 slides were briefed source:'none'. Sitti slide 4 is a list of weights (25/20/15/10%), and the writer's own reason was 'a list archetype renders them faster than a photograph could'. The floor still sent it to the generator as 'Four weighted criteria on a clean warm card, each with a percentage label' (06h attempts 1-2), asking an image model to draw a chart of real numbers. Karos A slide 2 was briefed as a diagram. It got 3 frames of 'a man opening a metal door in a hallway', all refused (06h2 attempt 3).
- **Slides are text-heavy because there is no graphic vocabulary: no icons, no pictograms, no diagrams or arrows, no charts other than bars, and no client SVG.**
  - Cause: slide-devices.ts:106-176 is the whole library, and devices render only on cover, headline_focus and text_only (slides-data.ts:213; prompt latest.md:984-986). bounded-object.ts:42-60 allows three plate subjects and 'no fourth'. There is no icon set or icon dependency (agents/instagram-agent/package.json). List markers are mono numerals (list-takeaway.html:1313-1325). The render probe and interest floor already count svg/canvas as a subject (render-carousel.ts:928-932; interest-floor.ts:1947-1951), but nothing ever draws one.
  - Evidence: Final render probes for all 8 runs show subjectBoxes.graphic = 0 on all 57 slides and markRuns = 0 on all 57. 54 copy slides declared emphasis, but 7 of the 8 kits have a one-colour palette, so the mark ring has no free colour (workflow:5827-5842). Devices shipped: figure 7, versus 5, timeline 2, spec_table 2, other kinds 0. 39 of 57 slides have no picture, and the average is 37.7 words per slide (the maximum is 75, on the kindlyyours closer). In thepitchbydeel pubsub-21255292697877233, 6 of 8 slides are headline_focus with versus or spec_table text columns.
- **When the writer asks for a graphic, the pipeline turns the request into an AI photograph or a failed frame.**
  - Cause: generate-image.ts:751 opens every brief with 'Create a photographic image' and 862-864 forbids numbers and words, so a chart or labelled diagram cannot be generated honestly. #246 rewrites diagram briefs under a photographic style lock into a documentary photograph (workflow:9469-9470; scene-brief.ts:561-573; visual-direction.ts:623-646). All 8 runs froze a photographic style lock at 04k. The backfill path still sends the diagram brief verbatim (image-density.ts:357-360). #246's test only covers source:'generate' (picture-floor-reaches-three.test.ts:38-47), so the actual Karos path (source:'none', backfilled:true) is still live at HEAD.
  - Evidence: In Karos A, steps 06h attempts 1-3 show gaps [{n:2, prompt:'Abstract editorial graphic suggesting two isolated data silos…', backfilled:true}]. The first subject line of the frozen direction is 'A founder in motion at a threshold' (00d), which is what the generator drew. Karos B's rescue briefs were all rewritten to 'An editorial photograph of the real-world setting behind a slide that says…'. The one that shipped (slide 7) was vetted as 'a generic but compatible background' (06e attempt 3, claimMatch 3).
- **Clients' own imagery policies and graphic languages never reach the decision. Brands that forbid AI imagery or ask for line icons get AI photos and no icons.**
  - Cause: Nothing in agents/ or packages/ reads an AI-imagery policy or brand signature shapes. imageryRegister (visual-system.ts:138,168) feeds only the eyebrow rule (928) and defaults to documentary (1009-1013). The portal's BrandingGuidelines has no iconography, motif or policy fields (karos-portal src/lib/types.ts:1836-1873). Each run's loaded guidelines doc (02e) already describes the icon style in prose, and nothing uses it.
  - Evidence: Sitti's lab profile says 'AI imagery is forbidden' (karos-agents clients/sitti/profile/branding-guidelines.md:63), yet its run shipped an AI frame on slide 2 and bought 8. xodigital says 'No AI-generated imagery, ever' (clients/xodigital/profile/branding-guidelines.md:68) and its run bought 8. thepitchbydeel's brand.yaml says 'no AI imagery ever' and defines d.box and meridian SVG motifs, but the run loaded a guidelines doc of about 1,600 characters with none of it. karoslabs' own spec says 'No stock photography… monoline lucide icons', with icon chips and simple-icons (clients/karoslabs/profile/branding-guidelines.md:68-72; docs/brand/KAROS-BRAND-GUIDELINES.md sections 10-11), yet it shipped 2 AI pictures and 1 Unsplash photo. The 02e docs spell out icon styles: Sitti 1.5px stroke with 2px radius, Kindly 1.5-2px with rounded caps, Geektime lime single-weight stroke, XO thin line with no fill. All 8 art directions set imageryRegister to documentary or product-surface.
- **AI frames that look like photographs of real events, real people or real brand interfaces get through.**
  - Cause: The 'no staged event' and 'no real brand' exclusions apply only in conceptualPromptFor (image-density.ts:119-139, 249-259). The 06d path sends the writer's scene verbatim with only 'no text / no logos' constraints (generate-image.ts:835-872). The vet prompt ranks 'a generated frame' above a credited real news photo (prompts/instagram-image-vet/latest.md:432-438).
  - Evidence: Geektime pubsub-21255132410207986 shipped, as its only picture, a photoreal AI image briefed as 'auditorium packed with Israeli software developers at a Microsoft AI training event… Tel Aviv, 2026' (06d attempt 1, photoreal true, vet claimMatch 2). This came after the vet had correctly refused real but unrelated library photos. Karos A slides 1 and 3 are photoreal AI phones showing the Spotify Wrapped UI with invented '2023 Wrapped' lettering (06d, photoreal true, claimMatch 5). xodigital paid 6 times for a portrait of a real named official.
- **The client's own graphic assets (SVG icons, motifs, symbols) can never reach a slide.**
  - Cause: harvest-site-images.ts rejects svg, gif and ico files and any path token like icon, logo, arrow or badge (152-156, 177-181). It reads only og:image and img tags (239-289), never inline svg. safety.ts:35 forbids svg in model markup, and there is no first-party builder for client vectors.
  - Evidence: Step 05y0 found 'no usable picture' on sitti.app and on kindlyyours.com. On xodigital, '1 downloaded picture(s) were icon-sized… dropped'. Lab motifs sit unused: Deel motif-dbox.svg and motif-globe.svg, Kindly-dot.svg and the DNA dot set, XO xo-d5-symbol-o.svg, and Sitti's pin glyph.
- **The real-picture tiers rarely supply a relevant picture, which pushes the floor into generation.**
  - Cause: The cited-article tier finds nothing. The official-assets tier needs a cited official domain (entity-imagery.ts:457). Google Places returns a photo for any name. The product-cutout step keys on the licence string the vet writes (workflow:10888).
  - Evidence: The cited-article tier returned 0 candidates in all 10 of its runs, and official-assets never ran. kindlyyours pubsub-21255254988332367 shipped Google Places photos for a report publisher (a workshop room) and for an analyst's name (costumes on mannequins). Both were vetted 5/5 and shipped without the Places credit. Step 06h26 ran in 0 of 8 runs, because Hanky Panky's product photo carried the licence 'client-owned asset' and did not match the pattern. Only 2 of the 18 shipped pictures are the client's own; 12 are AI or stock.
- **(H) Full-bleed covers carry too much text, set a huge title over a tiny subtitle, and the gradient shade does not follow the copy.**
  - Cause: There is no cover word budget (slides-data.ts:1126-1134). The title is r-display, and the fit ladder can step it up to --t-figure while the subtitle stays r-lead (cover.html:1606-1607; _design-system.css:117-122). The scrim has fixed stops and is transparent above 62% (cover.html:337-352), plus a uniform veil (style-lock.ts:623-627, 811-824). Neither is sized to the lockup.
  - Evidence: Cover title/subtitle sizes: 139/52px (karoslabs A, kindlyyours), 124/46px (hankypanky, thepitchbydeel, sitti) and 107/40px (karoslabs B), about 2.7:1. The xodigital cover uses 5 sizes and 29 words. The 13-word Karos A title sits on the busy AI phone mid-frame. Sitti slide 1, a cream wash in the brand ground, is the owner's reference.

**Proposed changes**

- [L] (M, D, C, K; agent-engine) Build a first-party graphics layer: code-built SVG in brand tokens, $0 per run. Add a SlideGraphic union on the slide copy with these kinds: icons (1-4 spot icons with labels of 24 characters or less); chart (bars, donut, progress, line or stacked, built only from sourced numbers copied verbatim, with a required source); diagram (flow, converge, split, cycle, hub, funnel, venn or before-after, 2-6 nodes with an optional icon each, arrows mirrored for RTL); badges (the real marks of named entities from the entity route or simple-icons, monochrome, nominative use); motif (the client's own SVG as a bullet, texture or frame). List items gain an optional icon marker. Icons come from a vendored, curated subset of Lucide (ISC) and Phosphor (MIT) path data with LICENSE files, and the model can only pick from a closed IconName enum. Only first-party builders emit SVG; keep safety.ts:35 for model markup. Stroke, linecap, fill, chip shape, radius and ink come from the client's graphics profile. Chart numbers use --f-display/--f-body, never the --f-mono fallback that slide-devices.ts:859-1033 uses today. Add a {{html:graphic}} slot to cover, headline-focus, slide, stat-callout, comparison-card, list-takeaway, quote-card and closer, and widen DEVICE_SLOT_LAYOUTS (slides-data.ts:213).
- [L] (M, D; agent-engine) Replace 'three AI frames guaranteed' with 'three subjects, graphic before generation'. (a) The floor counts plate subjects of any kind: a photo, a bounded real picture, a chart, diagram or icon composition, a product cutout or a motif, per the client's profile. (b) A deterministic choosePlateSubject table runs before sourcing: 2 or more sourced numbers get a chart; a sequence, comparison or cycle, or a brief matching ABSTRACT_GRAPHIC_PATTERN, gets a diagram; a named entity gets a real picture or a badge, never a generated one; the client's product gets the library, site photo or a cutout; anything else gets stock only at subjectMatch 4 or higher, otherwise icons or a motif. Generation comes last, only where policy allows, and only for a real scene no library holds or a concept drawn in the client's own graphic style (not the house styles at image-density.ts:152-160). (c) planImageBackfill tries a graphic first and never sends a diagram or chart brief to image.generate, which closes the Karos path at image-density.ts:357-360. (d) MIN_GENERATED_IMAGES_PER_RUN becomes a per-profile cap with nothing guaranteed; drop FLOOR_RESERVE_FRAMES. (e) Add an attach-graphic ImageryRemedy for the relayout. (f) Apply the staged-event and real-brand exclusions to every generation brief, and refuse photoreal briefs of real events, people, brands or product UIs before billing.
- [M] (M, L, J; agent-engine) Make the visual mix a parameter in three layers. L1 is the platform: at least 3 subjects per 8 slides, at most one icon composition per slide, and never the same graphic kind on consecutive slides. L2 is the industry: photo-first (fashion, food, hospitality, beauty, events: 3-7 photos, 0-2 graphics); editorial (media and news: 2-4 real or credited photos, 1-3 graphics, no AI); data-led (SaaS, fintech, agencies: 1-3 photos, 2-4 graphics, at most 1 AI frame); graphic-first (developer tools, regulated finance, consulting: 0-2 photos, 3-5 graphics, no AI). L3 is the client: instagramVisualMix, graphicsProfile and aiImagery settings, learned preferences and RFC-26 exemplar DNA. Resolve it the way pictureDensity is resolved today (workflow:1270-1360; imagery-floor.ts:194-230). Make imageryRegister load-bearing and add a diagrammatic register (visual-system.ts:138, 928, 1009).
- [M] (M, I, C; agent-engine) Copy prompt v32 and schema changes. Teach the writer the graphic vocabulary: per-industry IconName lists, chart and diagram shapes, and when each applies. Remove 'Photo-driven is the default' and the promise that code generates a frame for picture-free slides (latest.md:1230, 1235-1240). Allow graphics on stat, comparison, list, quote and closer slides (latest.md:984-986). Add source:'graphic' to SCENE_SOURCES (scene-brief.ts:69). Add a graphicSteer from post memory, modelled on arrowBulletSteer.
- [M] (M, D, B, G; agent-engine) Harvest the client's own vector assets instead of discarding them. Read inline svg, use-sprites and .svg files. Classify each as icon, motif, logo or illustration, and record stroke, linecap, fill and radius. Sanitize against an allowlist of elements (path, circle, rect, line, polyline, polygon, ellipse, g), refusing script, foreignObject, url() in style, external href and on* attributes. File the results as a 'graphic' kind in the media library. Import lab kit motifs the same way (Deel d.box and meridian, Kindly dot, XO O symbol, Sitti pin). Render them through img or a CSS mask in brand ink, so nothing unsanitized is inlined.
- [M] (B, D, M, G; karos-portal) Have onboarding capture the graphic language as data, not prose. Add to BrandingGuidelines: iconography (set, stroke, corner, fill, ink, chip), motifs (SVG files with a usage rule), imageryPolicy (aiImagery never / concept-only / fallback; stock allowed / avoid / never), chart style and imageryRegister. Extract them from the site: inline SVG attributes, the border-radius of cards, buttons and chips, and icon-font detection. Let the client confirm them in the branding modal, and project them to the engine.
- [S] (B, M; lab) Make the imagery policy and motifs machine-readable in each client's brand kit (thepitchbydeel's brand.yaml already has them): sitti and xodigital get aiImagery never; karoslabs gets no stock, Lucide monoline icons and simple-icons chips; kindlyyours gets its circle and dot language; hankypanky gets minimal graphics. Have import-lab-client.ts project them, because Deel's run loaded a thin guidelines doc without them.
- [S] (M; data-fix) Once the setting keys exist, set the policy on prep for the 8 clients: aiImagery never for sitti, xodigital and thepitchbydeel; graphic-first with stock avoided for karoslabs; editorial with no generated event photos for geektime; photo-first for hankypanky; data-led with the dot motif for kindlyyours.
- [M] (H, C; agent-engine) (H) Full-bleed covers. Add a cover word budget: title of 8-10 words, subtitle of 12 words or none. Bound the two sizes: the title stays at or under about 1.8 times the subtitle and never steps up to --t-figure over a photo. Size the scrim to the measured lockup: a brand-ground gradient from the foot of the slide to about 1.3 times the lockup height above it, with strength set by requiredHeroScrim on the pixels under each line (Sitti slide 1, generalised). When a cover has no subject, give it a badge or figure graphic instead of promoting an unrelated picture.
- [S] (M; agent-engine) Vet and tier fixes. image-vet@11: a credited real news or press photo outranks any generated frame, and a generated frame showing lettering or a real brand UI is refused. Key product cutout on where the picture came from, not on the vet's licence text (workflow:10888). Use Google Places only for place or venue entities, and always print its credit.
- [S] (M, L, J; agent-engine) Measure the mix. Add an imageryMix record to the gate payload and to PostPerformanceRecord: pictures by tier, graphics by kind, and AI frames bought, landed and paid for, so the L3 layer can learn graphic-versus-photo performance per client. Extend the RFC-26 DNA enums with icon, diagram, chart, illustration and ai-generated.

**Guards**

- ai-imagery-policy.test.ts: with aiImagery set to never (fixtures from the sitti, xodigital and thepitchbydeel guidelines), a fake image.generate that throws is never called by 04n, 06d, 06d2 or the product campaign, and the run still delivers at least 3 subjects.
- graphic-before-generation.test.ts covers two cases. Sitti slide 4 (items 25/20/15/10, source none) under the floor gets a chart whose values equal the copy's numbers, with zero generate calls. Karos A slide 2 (the diagram brief, source none, backfilled) gets a diagram with zero generate calls. #246's test misses this second case.
- chart-numbers-verbatim.test.ts: every number rendered in a chart, badge or diagram appears verbatim in the copy or a fact card, bars start at zero, and shares of 100 draw as parts of a whole (the anti-fabrication rule in bounded-object.ts).
- icon-registry.test.ts: every IconName resolves to vendored path data, each vendored set ships its LICENSE, and no IconName is a trademark. Brand marks come only through entity badges.
- svg-safety.test.ts: first-party fragments use only allowlisted SVG, harvested client SVG passes the sanitizer, and model markup containing svg is still refused (safety.ts:35).
- graphics-brand-tokens source scan (like slide-devices-rtl.test.ts): graphics use only mixes of var(--accent), var(--fg) and var(--bg) plus the client's stroke and radius tokens, use logical properties, and set numbers in --f-display or --f-body. No --f-mono and no hex literals.
- Calibration sweep in real Chromium: every graphic kind on every slot archetype, LTR and Hebrew, at s/m/l. No overflow or collision, graphic share of at least 0.12 on a graphic cover, fit step of 1 or less.
- photoreal-record guard: a brief naming a real event, person, brand or product UI is refused before billing. Fixtures: Geektime's 'Microsoft AI training event… Tel Aviv, 2026', Karos's 'phone displaying Spotify Wrapped' and XO's 'portrait of Otto Lobo'.
- Golden-set run eval: the AI share of shipped pictures stays at or under the profile's cap, AI frames bought, landed and paid for are reported on the gate payload, and posts with 0 subjects stay at 0 (the 2026-09-16/18 defect).
- Cover guard from the render probe: at most 2 text sizes plus a source line on a full-bleed cover, title at or under about 1.8 times the subtitle, words within the budget, and p5 contrast of at least 4.5 under every line after the sized scrim.
- Variety guard: no two consecutive slides carry the same graphic kind, and a graphicSteer fires when the last three posts reused a composition.
- Portal projection test: iconography, motifs and imageryPolicy reach the engine for both portal-onboarded and lab-owned clients.

**Risks**

- This reverses standing owner rulings: RFC-24 section 1 says 'generated conceptual visuals are wanted', the 2026-09-16 ruling says quality work is never optional spend, and the 3-frame guarantee rests on both. It needs the owner's explicit sign-off. Concept frames should stay available wherever the brand allows them.
- Icons can become the next AI tell, the same way arrow bullets did (RFC-24 section 15). Mitigate with a curated vocabulary per industry, one icon style per carousel, caps, and memory across runs.
- Client SVG is untrusted input. Sanitize it, or render it only through img or a CSS mask, and never let copy fields reach SVG.
- Licensing: Lucide is ISC and Phosphor is MIT, so keep their notices. simple-icons data is CC0, but the marks are third-party trademarks: use them only nominatively and in monochrome (Karos guidelines section 11.6), and never use a competitor's mark as decoration.
- A chart can fabricate data. Use only verbatim sourced numbers and honest scales, and label anything illustrative as illustrative.
- New SVG changes the pixel metrics the interest floor measures (occupiedShare, graphic share). Graphics must not become ink that games the floor. Calibrate with a render sweep that local Chrome and CI agree on.
- Dropping the guarantee could bring back posts with no pictures for photo-first clients if the graphic rung and real-photo tiers are weak. Keep the photo-first bands and a subject floor, and watch Hanky Panky.
- Reading a policy out of prose can misfire. The portal must store it as a confirmed field.
- 7 of 8 kits have a one-colour palette, which limits multi-series charts and highlight marks. Graphics have to derive tones from mixes of fg, bg and accent, and onboarding should capture the full palette (letter B).
- Arrows, flows and chart axes must mirror for RTL languages (Geektime is in Hebrew).
- Merge conflicts with #247 and with the other agents editing the 16k-line workflow file.

## Onboarding design-language capture (B, D). Today neither the portal nor the engine captures how a client's site draws boxes, buttons, pills, tables, numbers or labels. This proposes a deterministic headless-browser capture in agent-engine, stored next to the brand kit and read by the renderer's panels, chips, CTA, labels, figures and devices.

**How it works today**

Refs: engine = agent-engine clone @a65cdb8 (scratchpad/agent-engine); portal = karos-portal worktree @df0c7a09; lab = /Users/albertkattan/Code/karos-agents/clients.

WHAT THE PORTAL CAPTURES AT ONBOARDING
- Branding runs at the end of the intel pipeline for non-lab clients (portal src/lib/intel/report.ts:196-216). Lab clients skip it (:202-206). It also runs from the brand modal (src/lib/actions/branding-actions.ts:130,169).
- `applyBrandingForClient` (src/lib/branding.ts:1053-1395) gathers five inputs:
  - a model's webFetch report of fonts and nav/hero/CTA colours (:601-714);
  - a regex pass over hexes and CSS custom properties in the HTML, up to 4 stylesheets and 2 SVG logos (src/lib/branding-site-palette.ts:405-479);
  - a regex var()-chain font resolver (:381-395);
  - a ScrappyCoco screenshot whose pixels are counted (branding.ts:1126-1147; src/lib/branding-scrappycoco.ts:156-169);
  - up to 4 Instagram grid images, for vision.
- The output schema (branding.ts:735-815; src/lib/types.ts:1836-1873) holds only:
  - up to 4 `dominantColors` with free-text roles;
  - `fontHeading`/`fontBody`, whose prompt names archetype fallbacks (Space Grotesk/Syne, Plus Jakarta Sans/Inter, …; :757-776);
  - one `visualStyle` word out of six, plus tone keywords and voice.
- Nothing about radius, borders, shadows, buttons, chips, cards, tables, numerals, icons, image framing, spacing or layout is captured anywhere.
- The projection writes `client/brand.json` (src/lib/agent-engine/context-doc-projection.ts:196-241, 285-335) and rewrites it before every portal dispatch (src/lib/agent-engine/dispatch.ts:81-135).
- The lab import copies up to 4 colours and no fonts or shapes (scripts/import-lab-client.ts:351-415).
- The portal has no headless browser. It rents screenshots from ScrappyCoco.

WHAT THE ENGINE DOES WITH IT
- `client.getBrand` returns that loose file; there is "no canonical producer" (packages/tools/karos-client/src/get-brand.ts:11-58).
- 02c `deriveBrandRenderTokens` (agents/instagram-agent/src/workflow/brand-render-tokens.ts:702-922) keeps only:
  - `--bg`/`--fg`, `--f-display`/`--f-body` (loaded only as Google css2 links, :1071-1074), an accent ring, the logo and the handle;
  - a badge style guessed from adjectives: "tech" gives brackets, a light ground gives a pill (:457-467).
- `--f-mono` is set only from a config override (:780). So every client's eyebrows, sources and handle use the template's IBM Plex Mono (assets/templates/default/_design-system.css:95, 832-840; brand-render-tokens.ts:1116-1150).
- `--surface`/`--line`/`--fg2`/`--alt-ground` are emitted (:733-744), but no plate, `_design-system.css` rule or device rule reads them (0 matches).
- The display register's weight and tracking override the kit's own face: only `--f-display` is stripped (visual-system.ts:1311-1312 vs brand-render-tokens.ts:1174-1183).
- Setup steps:
  - 00-auto-setup only seeds topics (create-instagram-agent-workflow.ts:1178-1235).
  - 00c Template Studio authors whole HTML templates. Its only site evidence is up to 3 pages of TEXT at 4,000 chars, with no images (:3045-3091).
  - 00d (art director) gets that text only when 00c2 ran in the same run (:2857, 3099-3103, 3845). Otherwise it records "no page of the client's own site was fetched" (visual-direction.ts:844).
  - The six per-client visual-system axes (visual-system.ts:164-174) come from a model, or from palette size, adjectives and a slug hash (:955-1038).
- Rendering:
  - Every bounded object is the same 4px-radius gradient panel, running from the accent colour to the text ink: stat-callout.html:1300-1315, comparison-card.html:1301-1316, quote-card.html:1296-1306, closer.html:1329-1350 / 1445-1453 / 1458-1471, cover.html:1510-1525.
  - The cover's gradient ramp exists to clear the 10% device floor (cover.html:1513-1518; interest-floor.ts:428, 1315, 1367).
  - The device stylesheet is the same for every client: square bars, mono labels and values (slide-devices.ts:760-1041, 942, 954, 1032-1036).
  - The stat figure inherits the BODY face (stat-callout.html:1338; _design-system.css:55).
  - A fleet rule bans decorative borders (_design-system.css:19-24).
- Scripts: `sync-design-system.ts` copies that one fleet sheet into the eight plates (scripts/sync-design-system.ts:1-101). `report-brand-contrast.ts` reports contrast only (:1-25, 106-124).
- The only engine code that reads a site's computed styles is `landing.captureSite`. It counts colour and font frequency only, and only the landing builder uses it (packages/tools/karos-landing/src/capture/capture-site-tool.ts:52-121, 206-260). Chromium already ships in the agent-server image (apps/agent-server/Dockerfile:13-17, 108-114).

RUN EVIDENCE (8 prep runs)
- All eight rendered on the default templates:
  - 7 of 8 hit `00c-check-template-studio` with "the studio authored 6 candidate(s) and the battery kept none (6 dropped)".
  - Karos B's fresh studio failed all six. First pass: gate 2 (slot contract) on 4, gate 6 (interest floor) on 2. After repair: gate 6 on 5 (plates measured 95-98% flat), gate 2 on 1. No store step ran.
- 02c: only bg/fg/display/body plus 1-2 accents. `badgeStyle` "brackets" on 6 of 8 runs.
- Engine fonts:
  - Deel, Sitti and XO use Space Grotesk + Inter, and Kindly uses Plus Jakarta Sans + Inter. These are exactly the prompt's fallback fonts.
  - Hanky Panky uses Georgia + Helvetica Neue, which Google Fonts cannot serve.
- Karos A 00d: its palette holds truncated prose ("warm charcoal (mid-tone between the two,") and it records "no page of the client's own site was fetched".
- XO's 2026-09-24 run read a `brand.json` projected 2026-09-20T18:10Z. The portal record was corrected at 19:36Z. So the run painted #06cf9c, a WhatsApp green that is in the portal's own third-party list (branding-site-palette.ts:144).
- Contact sheets show the accent-gradient boxes on Karos A slides 2/4/5/8, Sitti 3/7/8, Hanky Panky 3/5/8 and XO 3/5/8.

WHAT THE SITES ACTUALLY DO (measured today)
Local Playwright prototype, $0, 2-15 s per page. Scripts and outputs in /private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/ (dl-probe.cjs, num-probe.cjs, mobile-type.cjs, dl/<client>/design-language.json).
- karoslabs.com:
  - one ground, #1a1a1a;
  - ONE corner radius, 6px (17 occurrences);
  - transparent cards with 1px #34343b hairline borders;
  - paper buttons (#f2f1ec fill, #141414 text, 6px radius, Hanken Grotesk 500);
  - orange only as eyebrow text or icons, never as a surface.
- deel.com/the-pitch-by-deel:
  - every button a full pill (200px radius);
  - square cards with 1px cream borders;
  - self-hosted Bagoss headings.
- sitti.app:
  - Gaegu everywhere;
  - coral pills, including price chips;
  - 16px-radius cards with 1px #ffd86a borders.
- xodigital.com.br:
  - Plus Jakarta Sans served under a hashed next/font alias;
  - 8px-radius buttons and 16px-radius white bordered cards;
  - yields set bold in peach ("18,50% a.a.");
  - a WhatsApp #25d366 pill (third-party).
- hankypanky.com:
  - self-hosted Relais/Fabriga;
  - 4px-radius buttons and 8px-radius cards.
- Numbers use the display face on all four sites that show enlarged figures.
- On mobile, the headline is 2.0-4.7× the body size.
- Blocked or dead sites:
  - Geektime shows a Cloudflare challenge (403).
  - kindlyyours.com is a GoDaddy for-sale page, and thisiskindly.com is a closed Shopify store (402).
- The lab kits already state these facts, and none reach the engine:
  - Karos: "radius 6px default … hairline dividers instead of boxes" (lab karoslabs/profile/branding-guidelines.md:76); orange "never large backgrounds" (brand-colors.json:25).
  - Deel: "radius tokens 4/8/12/16/24/200", flat and border-based (thepitchbydeel/profile/branding-guidelines.md:32-34).
  - Kindly: radius 3.2rem and tabular numerals (kindlyyours/profile/branding-guidelines.md:70, 94).

**Root causes**

- **The boxes and panels don't look like the client's own (D): Karos A's brown boxes, and pink, green and brown boxes on Sitti, Hanky Panky and XO.**
  - Cause: Every panel is a hardcoded 4px-radius gradient from the accent colour to the text ink, in five plates. They were added to clear the interest floor's pixel checks. No client token exists for card fill, border, radius or shadow, and a fleet rule bans borders.
  - Evidence: stat-callout.html:1300-1315, comparison-card.html:1301-1316, quote-card.html:1296-1306, closer.html:1329-1350/1445-1453/1458-1471, cover.html:1510-1525. The ramp's own comment says it exists to beat the 10% device floor (cover.html:1513-1518). Fleet rule: _design-system.css:19-24. Contact sheets: Karos A slides 2/4/5/8, Sitti 3/7/8, Hanky 3/5/8, XO 3/5/8. karoslabs.com measured: zero accent surfaces, transparent 6px-radius cards with #34343b hairlines. Lab spec: 'hairline dividers instead of boxes' (karoslabs branding-guidelines.md:76).
- **Onboarding captures up to four colours, two font names and one adjective; no design language at all (B).**
  - Cause: The portal's extraction schema, its BrandingGuidelines type and the brand.json projection have no fields for shape, components, numerals, icons or layout. The engine's brand kit is a loose bag with no producer contract.
  - Evidence: branding.ts:735-815; types.ts:1836-1873; context-doc-projection.ts:90-136; get-brand.ts:11-38. Step 02g raw kits for all 7 clients carry only visualStyle, fonts, dominantColors, colors, voice and guidelines.
- **Kit fonts are guesses, and the real brand faces cannot load (A, B).**
  - Cause: The extractor prompt supplies fallback fonts. The regex resolver cannot see next/font aliases, cross-origin stylesheets or JS-loaded fonts. The renderer only emits Google Fonts css2 links.
  - Evidence: Fallback list: branding.ts:764-775; persisted without provenance at :1334-1335; Google-only links at brand-render-tokens.ts:1071-1074. Kit vs site: Deel Space Grotesk vs Bagoss; Sitti Space Grotesk vs Gaegu; XO Space Grotesk vs Plus Jakarta Sans; Hanky Panky Georgia/Helvetica Neue vs Relais/Fabriga; Kindly Plus Jakarta Sans vs the lab's GT Walsheim.
- **Labels, numbers and devices use the same faces and shapes for every client (C, D).**
  - Cause: `--f-mono` (IBM Plex Mono) is never set from the kit, the device sheet is fixed, the stat figure inherits the body face, and the display register's weight overrides the kit face's own weight.
  - Evidence: _design-system.css:95,832-840; slide-devices.ts:942,954,1032-1036; stat-callout.html:1338; visual-system.ts:192,1311-1312 vs brand-render-tokens.ts:1174-1183. Sites: numbers set in the display face on all 4 that show them (XO bold peach Plus Jakarta Sans); Karos eyebrows are Hanken 12px/500 orange uppercase; Karos headings are weight 400/500 while the register forces 600.
- **Devices are chosen from adjectives, not observed: 'brackets' badges on 6 of 8 runs.**
  - Cause: `deriveBadgeStyle` runs a regex over visualStyle ('High-Tech'). The fallback visual system derives from palette size, words and a slug hash.
  - Evidence: brand-render-tokens.ts:457-467; visual-system.ts:974-975,1001-1007; 02c badgeStyle outputs. Geektime's brace-chip motif (lab geektime branding-guidelines.md:50) was spread to Karos, Deel, Sitti and XO. Sitti's real chips are full coral pills (probe).
- **The Template Studio, the only per-client plate mechanism, stores nothing and sees no design evidence.**
  - Cause: It asks a model to author whole HTML templates from site TEXT. The validation battery rejects them, then a 30-day cooldown locks in the default set.
  - Evidence: 00c 'battery kept none (6 dropped)' on 7 of 8 runs. Karos B 00c5-*: first pass gate 2 on 4 and gate 6 on 2; after repair gate 6 on 5 (flat 0.95-0.98) and gate 2 on 1. Code: create-instagram-agent-workflow.ts:3045-3091; template-studio.ts:301-324.
- **The existing surface and line override hooks never reach the pixels.**
  - Cause: The tokens are emitted but have zero consumers.
  - Evidence: brand-render-tokens.ts:733-744. grep for var(--surface|--line|--fg2|--alt-ground) across the 8 plates, _design-system.css and slide-devices.ts returns 0.
- **The visual direction (00d) is written blind to the site.**
  - Cause: Site pages reach it only as text, and only when 00c2 ran in the same run.
  - Evidence: create-instagram-agent-workflow.ts:2857,3099-3103,3845; visual-direction.ts:844. Karos A 00d gaps, and its palette holds prose fragments instead of hex values.
- **Capture inputs are unreliable: dead or blocked sites, and a stale brand.json.**
  - Cause: The portal's website field is trusted with no validity check, and runs not dispatched through the portal never re-project brand.json.
  - Evidence: Kindly: both domains dead (GoDaddy parked page; Shopify 402). Geektime: Cloudflare 403. XO: brand.json projected 2026-09-20T18:10Z, portal corrected at 19:36Z, and the 2026-09-24 run still painted #06cf9c.

**Proposed changes**

- [L] (B, D, A, M; agent-engine) Decision: the engine owns capture, storage and consumption. Chromium already ships in the agent-server image (Dockerfile:13-17,108-114); the portal has none. Build a new tool, media.captureDesignLanguage, modelled on media.screenshotPage (injectable launcher, screenshot-page.ts:30-67). It loads the client's home page plus up to 2 of its own pages at 1440x900 and 390x844, waits for document.fonts.ready and scrolls once. It excludes consent, chat and third-party subtrees, and reads computed styles only:
- type roles (family, size, weight, line-height, tracking, case) and a size histogram;
- loaded font faces, with font-file URLs taken from the network log (Deel's cross-origin stylesheets came back empty through CSSOM), and next/font aliases normalised;
- colour usage by role, weighted by area or character count, using the third-party and framework tables moved over from branding-site-palette.ts:142-198;
- buttons, pills and chips, cards (fill, border, radius, shadow), inputs, tables and definition lists (tabular-nums), numerals, icons (line or solid), image framing, dividers, gradients classed as surface or ambient, section grounds and alignment;
- screenshots, stored in the media bucket.
A validity gate refuses to derive anything from HTTP 400 and above, challenge pages (branding.ts:557-565), parked or closed-store pages, or blank renders (branding.ts:1127-1146). The fallback is a ScrappyCoco screenshot with vision only. landing.captureSite (capture-site-tool.ts:52-121) should share the same extractor.
- [M] (B, D; agent-engine) One engine-owned document per client: clients/<slug>/client/design-language.json, plus append-only vNNNN history (the visual-patterns convention, visual-patterns.ts:31-36). Read and written through client.getDesignLanguage and client.writeDesignLanguage, mirroring getBrief/writeBrief (karos-client brief.ts:37-49,70-75). It must not live inside brand.json, because the portal rewrites that file before every dispatch (context-doc-projection.ts:322; dispatch.ts:111-135).

Every field carries a provenance: stated, measured, inferred or default. The capture writes only measured and inferred fields, so a stated field (Kindly with no live site, Deel's stage-purple social kit, XO's D5 rebrand) is never overwritten.

Render precedence: renderTokens (types.ts:143-189) > stated > measured > vision > fleet default. Conflicts with brand.json are recorded. A brand.json font that is one of the extractor's fallback names (branding.ts:764-775) and is absent from a valid capture is treated as unset.
- [M] (B, D, N; agent-engine) Add it to the Instagram agent's setup as a pre-flight, following the setup-agents pattern (channel-setup.ts:11-44):
- 00f-check-design-language: 90-day TTL, a refreshDesignLanguage flag like refreshTemplates (create-instagram-agent-workflow.ts:2980), and failure backoff (template-studio.ts:257-324);
- 00f1-capture-design-language;
- 00f2-describe-design-language: one Flash vision look over up to 4 screenshots, naming signature devices, layout and icon style. Every line cites a measured component or a screenshot region, or goes to gaps (visual-direction.ts:52-60);
- 00f3-persist-design-language.
Place these before 00c, so the Studio and the art director both consume them. Read the result at render through a new checkpointed step, 02c2-load-design-language, so 02c's checkpoint shape never changes (create-instagram-agent-workflow.ts:1570-1588). Add a setup meter line of about $0.005 (run-budget.ts:2312-2373). Fail open: a blocked site records a gap and never holds a run.
- [S] (B, J; agent-engine) Optional, and still no portal change. intel-report-agent runs a setup pass at onboarding and on Regenerate (the portal already dispatches it: portal dispatch-research-agents.ts:50-106). Add a best-effort 01j-capture-design-language beside 01f/01h (create-intel-report-agent-workflow.ts:408-474), so the design language is captured at onboarding, before the first post. 01h's competitor pages could get the same capture for letter J's benchmarks.
- [L] (D, C, A; agent-engine) Make the pixels read the design language:
- _design-system.css declares --dl-* tokens whose defaults are today's values, synced into the eight plates by sync-design-system.ts. A client with no capture renders byte-identical.
- The five panels read --dl-panel-bg, --dl-panel-border, --dl-panel-radius and --dl-panel-shadow. Karos gets transparent + 1px #34343b + 6px radius; Sitti #fff2bf + 1px #ffd86a + 16px; XO white + #d9e2ec + 16px; Deel 0 radius + a cream hairline.
- The closer CTA (closer.html:1420-1429) uses the client's primary button.
- Eyebrows, sources and the handle use --f-label with the site's case and tracking, instead of IBM Plex Mono (_design-system.css:832-840; brand-render-tokens.ts:1116-1150). The logo chip (_design-system.css:1234-1245) uses the client's radius.
- deviceCssBlock (slide-devices.ts:760-1041) reads --dl-radius-*, --f-label and --f-figure plus the numeric variant, so numbers are set in the brand's display face. The stat figure stops inheriting the body face.
- buildBrandHeadHtml emits the --dl-* sheet and @font-face rules for staged self-hosted faces (licence-gated), instead of only Google links (:1071-1074). The measured weight and tracking replace the display register's (visual-system.ts:1311-1312). The measured chip replaces deriveBadgeStyle (:457-467).
- The fleet rules (_design-system.css:19-24) become 'nothing the client's own site doesn't do'.
- Either wire or delete the dead --surface, --line and --fg2 outputs (:733-744).
- [M] (D, I; agent-engine) Have the decision layer read the measured language:
- fallbackClientVisualSystem takes accentRole from the measured accent roles (eyebrow text only → punctuation or mark; button or surface → field; 3 or more hues → information) and groundTexture from gradient and shadow use, instead of adjectives and a slug hash (visual-system.ts:955-1038).
- pickVisualSystem drops catalogue entries the language forbids (visual-system.ts:730-748,814-858).
- 00c2/00c3 and 00d2 receive the tokens and screenshots instead of text (create-instagram-agent-workflow.ts:3045-3135,3845).
- The Studio battery gets a vocabulary gate: radius in the client's scale, no gradients or shadows the client doesn't use, font families within the client's own.
- Consider varying tokens rather than authoring whole templates, since all 8 runs stored nothing.
- [M] (D, A; agent-engine) Check every render. Extend probePage (render-carousel.ts:548+) to report each bounded element's computed radius, border, background-image and box-shadow, plus document.fonts.check() for each family used. Add checkDesignLanguageConformance next to checkPaletteWithinKit (visual-qa-pre-checks.ts:111) as a fact on the gate payload. A brand face that did not load forces a re-render instead of shipping a fallback.
- [S] (B; agent-engine) Fleet report scripts/report-design-language.ts, beside report-brand-contrast.ts (which reports contrast only). Per client: capture status, age and validity (ok, blocked, parked or closed), kit-vs-site conflicts (a kit font no element uses; an accent seen only inside a third-party widget), and missing tokens.
- [S] (A, B; karos-portal) Not required for the engine branch; recommended. Stop persisting the extractor's fallback fonts as if they were the brand's (branding.ts:757-776,1334-1335), or project their provenance. Add fontsSource: observed | model | human (types.ts:1862-1863; context-doc-projection.ts:117,233), so a measured face replaces a guess but never a human's edit. The portal builds no capture of its own.
- [S] (B, D; data-fix) Seed stated fields where the site can't be read:
- Kindly Yours has no live site: kindlyyours.com is a GoDaddy for-sale page, and thisiskindly.com is a closed Shopify store (402). Seed from the lab kit: GT Walsheim, 3.2rem radius, tabular numerals (lab kindlyyours branding-guidelines.md:66,70,94).
- Geektime's site sits behind Cloudflare. Seed its brace-chip motif and palette from the lab kit (geektime :34,50).
- Fix the portal's website field for Kindly, and re-project XO's stale brand.json.

**Guards**

- Fixture tests for derive.ts on recorded captures:
- karoslabs: radius {6}, transparent cards with #34343b hairlines, accent used as text only;
- Deel: pills at 200px radius, flat bordered cards, Bagoss;
- Sitti: Gaegu and coral pills;
- XO: WhatsApp #25d366 excluded, next/font alias normalised;
- Hanky Panky: Klaviyo and Shopify fonts excluded;
- Cloudflare challenge, GoDaddy parked and closed Shopify store pages must derive no tokens.
- A template source scan in the style of design-system-sync.test.ts: no literal radius, gradient, shadow, border or font-family in any panel, chip, CTA, label, figure or device selector unless it is var(--dl-*|--f-*) with a fallback. scripts/sync-design-system.ts --check stays in CI.
- Token-consumer contract test: every custom property buildBrandHeadHtml emits must have at least one reader. This fails today for --surface, --line, --fg2 and --alt-ground (brand-render-tokens.ts:733-744).
- Byte-identity test: a client with no design-language document composes byte-identical documents to main.
- Real-Chromium sweep of each fixture language × 8 archetypes × {en, he}: the interest floor passes with no threshold moved, probe.overflow stays false, document.fonts.check() is true for every brand family, and the conformance check is clean.
- Per-run checkDesignLanguageConformance fact on the gate payload. A brand face that did not load fails the render and triggers a re-render; it never ships.
- The 00f* and 02c2 steps are checkpointed and 02c's checkpoint shape is unchanged (resume-idempotency.test.ts). A fail-open test proves a capture timeout or bot wall never holds a run. The setup meter line is asserted.
- scripts/report-design-language.ts goes in the promote checklist: no client may ship with a missing, stale (over 90 days) or blocked capture unless it has stated overrides.

**Risks**

- Font licensing: self-hosted commercial faces (Bagoss, Relais/Fabriga, GT Walsheim) usually have web licences that may not cover rendered social images. Staging them needs a per-client licence flag; otherwise use the nearest metric match and report it.
- Interest-floor tension: the gradient panels exist to beat the pixel floors (cover.html:1513-1518). Karos B's quiet studio templates measured 95-98% flat and failed gate 6. Hairline-only languages (Karos, XO D5) need devices from their own vocabulary (Karos's marker band, paper CTA, Spectral figures, 8px screenshot frames), not lowered floors.
- Bot walls and dead sites (Geektime Cloudflare 403; Kindly Yours' two dead domains): a derivation from a challenge or parked page would rebrand the client as Cloudflare, GoDaddy or Shopify. The validity gate and the stated-field fallback are load-bearing.
- Third-party contamination: Cookiebot on Deel, a WhatsApp CTA on XO, Klaviyo/Poppins, Montserrat and proxima-nova on Hanky Panky. Subtree and vendor exclusion is mandatory, and the capture never clicks consent banners.
- Web differs from social: Deel's lab kit grounds social posts in deep purple #201547, and XO's D5 rebrand is not yet on its live site. Stated fields must win, and conflicts must be reported, not resolved silently.
- Two sources of truth for colours and fonts: until the portal ships font provenance, the fallback-name heuristic could override a human choice that happens to match a fallback name.
- One home page is not the whole system: tables, stats and chips often live on inner pages. Sample 3 pages plus mobile, keep the 90-day TTL, and support refreshDesignLanguage after a redesign.
- A captured Latin face may lack Hebrew or Arabic glyphs. Record unicode-range coverage and keep script-fonts.ts's per-script stacks (visual-system.ts:257-297).
- The vision summary could invent 'signature devices'. Require evidence references, and use Flash only (no Opus).
- Cost and performance: 2-15 s per page measured locally, plus Chromium memory on Cloud Run. Run it at setup only, cached; about $0.005 per client per 90 days.
- Merge collisions with PR #249: the tool-registry pin, the design-DNA vocabulary and the 00c2/00d2 inputs.

## Fonts (letters A and C): brand faces, font loading, numerals and source lines, end to end from portal onboarding to the Instagram render

**How it works today**

Audited portal worktree df0c7a09 and agent-engine origin/main a65cdb8, plus the 8 prep runs (all runKind 'recurring', all rendered on the bundled templates, 04c 'bundled:*').

(1) ONBOARDING. applyBrandingForClient runs observeSiteFonts beside a model extraction (karos-portal src/lib/branding.ts:1083-1105). observeSiteFonts fetches the page with plain HTTP, reads at most 4 stylesheets, and returns nothing on any non-2xx response (src/lib/branding-site-palette.ts:241, 302-314, 317-329, 381-395). resolveBrandFonts knows two roles only, heading and body (src/lib/brand-fonts.ts:206-277). When it finds nothing, the prompt says 'archetype fallback only if unknown' (branding.ts:986). The schema lists those fallbacks: Space Grotesk/Syne for High-Tech, Plus Jakarta Sans/Inter for Minimalist, Inter/Geist/Open Sans for body (branding.ts:757-776). The answer is saved as the brand font with no record of where it came from (branding.ts:1327-1335, 1353; types.ts:1862-1863). Staff can only retype two names (src/components/branding-modal.tsx:618-627), and there is no way to upload a font file. The lab import copies colours and the logo, but it ignores brand-colors.json fonts[] and the brand/fonts files (scripts/import-lab-client.ts:351-427).

(2) PROJECTION. toProjectedBrand writes only fonts:{heading,body} into clients/<slug>/client/brand.json (src/lib/agent-engine/context-doc-projection.ts:117, 233, 314-322). It runs at portal dispatch (dispatch.ts:113-135, 181) and on save (branding-actions.ts:119). Both are best-effort and log nothing loud when they fail. Scripts such as backfill-brand-fonts.ts write Firestore only.

(3) ENGINE KIT. client.getBrand reads that file as loose JSON (packages/tools/karos-client/src/get-brand.ts:12-56). Step 02c (agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts:1582-1588) calls deriveBrandRenderTokens:
- display and body come from brand.json; mono comes ONLY from the config override renderTokens.fontMono (brand-render-tokens.ts:746-792, mono at :780);
- any alphanumeric name passes (FONT_FAMILY :105), and a rejected name is dropped silently (:133-136);
- the display fallback stack is a serif (Georgia) for every brand (:118-122).
buildBrandHeadHtml emits one bare css2 <link> per family with no weights (:1005-1012, 1040-1074), so Google serves weight 400 only. The display register adds Oswald or Space Grotesk, and removes its own --f-display only when the kit names a face (:1051-1060, 1161-1184). On a non-Latin script, the register's script face is written on body after the kit and beats it (:1067-1070, 1212-1214; visual-system.ts:346-351). script-fonts.ts adds Heebo/Assistant/Rubik for Hebrew (script-fonts.ts:94-142, 252-291), and names IBM Plex Mono for Greek and Cyrillic (:115-116). A client with no kit gets no brand head at all (workflow :2770). High-Tech kits get mono 'brackets' eyebrows (brand-render-tokens.ts:457-467, 980-997).

(4) TEMPLATES. All 8 plates declare :root --f-display 'Fraunces', --f-body 'Inter', --f-mono 'IBM Plex Mono' (assets/templates/default/_design-system.css:85-96; synced, e.g. cover.html:120-131). They load none of them: agent-engine commit ef81e54 (2026-09-17) deleted the Google Fonts <link> from all 8, yet visual-system.ts:179-181 still says the templates load them.
- The mono role is used for the eyebrow and kicker (_design-system.css:832-833), badge (:848-853), handle (:894-895), pagination (:903-910), source line and note (:1069-1075), the brand-head handle and badge (brand-render-tokens.ts:1116-1150), and device notes, bar values, timeline dates, table labels and axis ends (slide-devices.ts:859, 942, 954, 973, 996, 1033).
- Numbers: .num-figure has no rule and inherits body (stat-callout.html:78, 1338). .dv-figure and .dv-st-value use display (slide-devices.ts:772-776, 1037-1038). Nothing sets font-variant-numeric.
- The studio shell still links and declares Fraunces/Inter/IBM Plex Mono (packages/tools/karos-templates/src/safety.ts:254-265).

(5) RENDER. The renderer waits for the ready flag and for document.fonts.ready (packages/tools/karos-publish/src/render-carousel.ts:1350-1361). probe.fontFamiliesUsed is the FIRST name in the element's computed font-family, which is the requested family (:780-782). The code documents it as proof that a font loaded (:531-532; interest-floor.ts:168-169, 182-183). Nothing checks which face actually painted, and visual QA excludes that question (visual-qa-pre-checks.ts:290-293). The container ships DejaVu, Liberation and Noto (apps/agent-server/Dockerfile:90-96).

PER CLIENT (real fonts → stored in prep → engine 02g → rendered):

1. karoslabs.
- Real: Spectral for h1-h3, Hanken Grotesk for body. Eyebrows use '.eyebrow{font-family:var(--font-label)}', which is Hanken in uppercase. Numbers use '.stat-number{var(--font-sans); tabular-nums}'. DM Mono is loaded but unused. The lab spec says JetBrains Mono for labels and numbers (karos-agents clients/karoslabs/profile/branding-guidelines.md:61-63).
- Stored: Spectral/Hanken Grotesk. 02g: Spectral/Hanken (projected 2026-09-24T06:26Z).
- Rendered: Spectral and Hanken load. Headlines are Spectral Regular with synthetic bold: stem/cap 0.177 and bar/stem 0.71, against 0.178/0.70 for Regular plus synthetic stroke and 0.187/0.43 for the real SemiBold. The mono role is declared IBM Plex Mono but painted in DejaVu Sans Mono: the slide-5 source line measures cap 32 px and x-height 25 px at 44 px device size, which is DejaVu (0.729/0.560 em), not Plex (30.7/23.2 px).

2. geektime.
- Real: Open Sans, Hebrew RTL, self-hosted. Seen in the archived head-load.css and global-load.css of 2026-09-12. The lab has brand/fonts/OpenSans-variable.ttf and branding-guidelines.md:42. The live site returns a Cloudflare 403, and the theme sheets are stylesheets #10 and #13, past the 4-sheet cap.
- Stored: Inter/Inter (model, 2026-07-28). 02g: Inter/Inter.
- Rendered: Heebo for display (the grotesque register's Hebrew face), Inter plus Assistant for Hebrew body glyphs, Rubik for mono. Open Sans on Google Fonts has a Hebrew subset, so one brand face could set the whole plate.

3. thepitchbydeel.
- Real: BagossCondensedFont for headings and Inter for body (207 declarations), plus BagossStandardVF and BagossExtendedFont, self-hosted on website-media.deel.com. The lab kit brand.yaml:45-51 sets display Bagoss Condensed 500, figures Bagoss Extended, body and overline Inter. The woff2/ttf files are in the lab, blocked by the Displaay licence.
- Stored: Space Grotesk/Inter in prep (the High-Tech archetype); Inter/Inter in prod. 02g: Space Grotesk/Inter (2026-09-22).
- Rendered: Space Grotesk, Inter, and DejaVu for mono. Even today's observer would store 'BagossCondensedFont', which Google cannot serve; a Chromium test shows it then paints in Georgia.

4. hankypanky.
- Real: --font-heading 'Relais' and --font-body 'Fabriga', self-hosted on Shopify. Today's observer would wrongly return heading Fabriga, because a Yotpo widget selector (.yotpo-review-title) wins over the --font-heading variable (brand-fonts.ts:152, 232 against 246-257). The lab has no fonts on file (branding-guidelines.md:50-55).
- Stored: Georgia/Helvetica Neue. 02g: the same, from a seeded file with no projectedAt.
- Rendered: Georgia and Helvetica Neue really loaded. Google css2 serves them from Docs-licensed kits (fonts.gstatic.com/l/font?kit=…); their name tables read 'licensed to Google Inc.' (Monotype, Linotype). Mono is DejaVu. Headline figures are Georgia oldstyle while stats are lining.

5. kindlyyours.
- Real: the website on record, kindlyyours.com, is a parked domain (a JS redirect to /lander, then forsale.godaddy.com). The brand site is thisiskindly.com (Shopify, returns 402 today). The lab lists GT Walsheim (commercial), Fraunces and Nunito as stand-ins, and Courier New for spec numbers.
- Stored: Plus Jakarta Sans/Inter, the Minimalist archetype pair word for word. 02g: the same (seeded).
- Rendered: those two faces, and DejaVu for mono.

6. sitti.
- Real: Gaegu everywhere (267 declarations, on html,:host; it is also on Google Fonts at 400 and 700). The lab kit adds JetBrains Mono for stats (sitti/brand/kit/brand.yaml:33-41).
- Stored: Space Grotesk/Inter (High-Tech). 02g: the same (seeded).
- Rendered: Space Grotesk, Inter, and DejaVu for mono.

7. xodigital.
- Real: the locked D5 brand kit uses Fraunces, Geist and Geist Mono, with local TTFs (brand/README.md; branding-guidelines.md:58-64). The live site still serves Plus Jakarta Sans for display and Inter for body.
- Stored: Inter/Inter (prep, 2026-09-20T19:36Z). 02g: Space Grotesk/Inter, a stale projection from 2026-09-20T18:10Z.
- Rendered: Space Grotesk, Inter, and DejaVu for mono. The frozen visual direction (00d) cites 'Inter', so the pipeline holds three different answers.

The run records say 'IBM Plex Mono' on all 7 Latin runs, but that face was painted nowhere.

**Root causes**

- **The fonts on file are model guesses for 5 of 7 clients (thepitchbydeel, sitti, xodigital, kindlyyours, geektime), plus hankypanky's Georgia/Helvetica Neue.**
  - Cause: Onboarding asks a model for HEADING_FONT/BODY_FONT, and its schema tells it to fall back to archetype fonts when unsure (karos-portal src/lib/branding.ts:757-776, 986). The answer is saved as the brand's font with no provenance (branding.ts:1334-1335; types.ts:1862-1863). The CSS observer (PR #191, 2026-09-23) arrived after these records were written, and backfill-brand-fonts.ts was not applied to them.
  - Evidence: Prep records: thepitchbydeel and sitti hold Space Grotesk/Inter with visualStyle High-Tech. kindlyyours holds Plus Jakarta Sans/Inter with visualStyle Minimalist: the schema's archetype pairs word for word. xodigital flipped from Space Grotesk/Inter (engine 02g, projectedAt 2026-09-20T18:10Z) to Inter/Inter (portal updatedAt 19:36Z) in 86 minutes. The real fonts differ in every case (see current_behaviour).
- **The deterministic observer cannot read many real sites and misreads others.**
  - Cause: It uses a plain fetch with a 4-stylesheet cap and returns null on non-2xx (branding-site-palette.ts:241, 302-329, 381-395). It knows only heading and body (brand-fonts.ts:206-277). Loose selector matches in pass 1 beat role variables in pass 2 (brand-fonts.ts:152-153, 218-234 vs 246-270). Emoji families are not filtered (brand-fonts.ts:109, 145). It captures no @font-face src, weights, label face or numeral settings. It cannot tell a challenge page or a parked domain from a real site.
  - Evidence: geektime: Cloudflare 'Just a moment' 403, and its Open Sans rules sit in stylesheets #10 and #13. kindlyyours.com: JS redirect to /lander, then forsale.godaddy.com. hankypanky: the resolver returns heading 'Fabriga' from '.yotpo-review-title' although the CSS says '--font-heading: Relais'. The challenge page's system stack resolves to 'Apple Color Emoji'. The label and numeral rules on karoslabs.com ('.eyebrow{var(--font-label)}', '.stat-number{…tabular-nums}') are never read.
- **No path carries font files or the label/mono and figures roles to the render.**
  - Cause: BrandingGuidelines holds two strings (types.ts:1862-1863). The modal has two text inputs and no upload (branding-modal.tsx:618-627). The lab import ignores fonts[] and brand/fonts files (import-lab-client.ts:351-427). The projection sends two names (context-doc-projection.ts:117, 233). The engine takes mono only from config overrides (brand-render-tokens.ts:780).
  - Evidence: The lab holds Bagoss woff2/ttf (clients/thepitchbydeel/brand/kit/fonts), Fraunces.ttf and Geist.ttf (clients/xodigital/brand/fonts) and OpenSans-variable.ttf (clients/geektime/brand/fonts); none reaches the engine. 02c shows '--f-mono: undefined' on all 8 runs.
- **Every mono element is declared IBM Plex Mono but painted in DejaVu Sans Mono, on all 7 clients: eyebrows, source lines, pagination, handle, and bar, timeline and table numbers.**
  - Cause: No kit sets --f-mono, so every consumer falls to the templates' default 'IBM Plex Mono' (_design-system.css:95; consumers at :832-833, 848-853, 894-895, 903-910, 1069-1075; slide-devices.ts:859, 942, 954, 973, 996, 1033; brand-render-tokens.ts:1116-1150). Commit ef81e54 (2026-09-17) deleted the templates' Google Fonts link, so IBM Plex Mono, Fraunces and Inter are never loaded on the bundled path. Chromium then paints the container's generic monospace, DejaVu (Dockerfile:90-96). visual-system.ts:179-181 still claims the templates load these faces.
  - Evidence: The 08 probe lists IBM Plex Mono on every Latin run. The karoslabs slide-5 source line 'LBBOnline, Dec 2025' measures cap 32 px, x-height 25 px, pitch 28.8 px at 44 px device size. That matches DejaVu Sans Mono (32.1/24.6 px) and not IBM Plex Mono (30.7/23.2) or Liberation Mono (29.0/23.7); see scratchpad fontaudit/mono-compare2.png. 'git show ef81e54' shows the removed '<link …family=Fraunces…&family=Inter…&family=IBM+Plex+Mono…>'.
- **The one check meant to prove a font loaded reports the requested font, so missing fonts ship silently.**
  - Cause: probePage takes getComputedStyle(el).fontFamily.split(',')[0] (render-carousel.ts:780-782). That is the declared list, not the face used, yet it is documented as proof of loading (render-carousel.ts:531-532; interest-floor.ts:168-169, 182-183; emphasis-marks.ts:1296; interest-floor-marks.test.ts:1758-1766). Template-studio gate 8 relies on it (template-studio.ts:2438-2442). karos-landing uses document.fonts.check, which returns true for a family with no @font-face (render-page-tool.ts:79-80). Visual QA explicitly leaves font loading out (visual-qa-pre-checks.ts:290-293).
  - Evidence: Chromium test in this audit (scratchpad fontaudit/probe-semantics.mjs): a declared 'IBM Plex Mono' probes as 'IBM Plex Mono', document.fonts.check returns true, and CDP CSS.getPlatformFontsForNode reports a system fallback (Courier on macOS). A declared 'BagossCondensedFont' probes as itself, check returns true, and the face that paints is Georgia.
- **Brand weights never load, so every bold headline, figure and list title is a synthetic bold of the regular weight.**
  - Cause: Both head builders request bare family names (brand-render-tokens.ts:1005-1012, 1071-1074; script-fonts.ts:279-282), and css2 then serves weight 400 only. The display, figure and list roles ask for 600-700 (visual-system.ts:192-217, 1409-1415), and font-synthesis is left on.
  - Evidence: css2?family= for Spectral, Hanken Grotesk, Space Grotesk, Inter, Plus Jakarta Sans and Heebo each returns only 'font-weight: 400'. The karoslabs slide-2 headline measures stem/cap 0.177 and bar/stem 0.71. Spectral Regular with synthetic emboldening gives 0.178/0.70; the real SemiBold gives 0.187/0.43.
- **The engine picks non-brand faces on its own.**
  - Cause: Display registers name families (visual-system.ts:191-218, 403, 417-420). When a kit has no display face, the register is seeded from the slug (:1001-1007). On a non-Latin run, the register's script face is written on body after the kit and overrides the brand's display face even when the brand face covers the script (brand-render-tokens.ts:1067-1070, 1212-1214; visual-system.ts:346-351). Script packs place Heebo, Assistant and Rubik (and IBM Plex Mono for Greek/Cyrillic) in every role (script-fonts.ts:94-142). FONT_FAMILY accepts any name, and css2 serves Google-Docs-licensed kits for it (brand-render-tokens.ts:105). The display fallback is a serif for every brand (:118-122). A kitless client gets template defaults only (workflow :2770). A High-Tech visualStyle, itself a model archetype, turns eyebrows into bracketed mono tags (brand-render-tokens.ts:457-467).
  - Evidence: geektime rendered Heebo, Assistant and Rubik, although Open Sans ships a Hebrew subset on Google. hankypanky rendered Georgia and Helvetica Neue from fonts.gstatic.com/l/font?kit=…; the name tables read 'licensed to Google Inc.' (Monotype Georgia 5.00a, Linotype Helvetica Neue). A Bagoss name would silently paint as Georgia (Chromium test).
- **Numbers and source lines use up to three faces in one carousel, none of them chosen by the brand.**
  - Cause: .num-figure inherits body (stat-callout.html:78, 1338). Device figures and table values use display (slide-devices.ts:772-776, 1037-1038). Bar values, timeline dates, table labels, pagination and plate source lines use mono (slide-devices.ts:942, 954, 1033; _design-system.css:903-910, 1069-1075). Device sources use body (slide-devices.ts:854-855). Nothing sets font-variant-numeric.
  - Evidence: hankypanky slide 6: '24' and '24 hours' in Georgia oldstyle figures, '44%' in Helvetica Neue lining, list indices and source lines in DejaVu mono (scratchpad fontaudit/hanky-s6.png). karoslabs: '500M+' in Hanken, the device figure in Spectral, the source line in DejaVu. karoslabs.com itself sets stats in Hanken with tabular-nums.
- **Recurring runs read stale or foreign brand kits.**
  - Cause: brand.json is refreshed only by best-effort, portal-side projection (context-doc-projection.ts:285-335 via dispatch.ts:113-135/181 and project-on-save). It fails silently, and branding-actions.ts:115-117 assumes 'the next dispatch re-projects'. The engine accepts any brand.json without provenance (get-brand.ts:44-56).
  - Evidence: All 8 runs are runKind 'recurring'. The 02g kits for sitti, hankypanky and kindlyyours have no projectedAt or projectedBy and a name/handle/accent shape the portal never writes. xodigital read the 18:10Z Space Grotesk projection four days after the portal switched to Inter/Inter. The 00d visual directions for thepitchbydeel and xodigital cite 'Inter' as the display token, while those runs rendered Space Grotesk.

**Proposed changes**

- [M] (A, B, C; karos-portal) Typography contract with provenance. Add BrandingGuidelines.typography with roles display, body, label (eyebrow, source line, handle, pagination) and figures. Each role carries: family, weights and styles, source (upload | lab-kit | google | substitute), https file URLs and sha256, googleFamily, substituteFor, observedFrom (site-css | lab | staff | model), licence (open | client-licensed | unconfirmed), numeric (e.g. 'lining-nums tabular-nums'), status (verified | needs-staff) and revision. fontHeading/fontBody stay as derived mirrors so the other agents keep working. Project the full object into brand.json and add an engine-field-contract entry.
- [S] (A; karos-portal) Stop inventing fonts. Remove the archetype font lists from the schema (branding.ts:757-776) and the 'archetype fallback only if unknown' rule (:986). Drop '?? object.fontHeading/fontBody' (:1334-1335). A model suggestion is stored only as typography.suggested, with status needs-staff, and never as the brand's font.
- [M] (A, B; karos-portal) Read the whole type system from the site. Follow every stylesheet, not 4. Capture each @font-face family with its src URL, weight and style. Prefer role variables (--font-heading/-body/-label/-mono) over loose or third-party selectors (skip .yotpo-* and similar widgets). Add a label role (.eyebrow, label-caps) and a figures role (.stat*, number or tabular rules, font-variant-numeric). Filter emoji and system families. Detect challenge, parked and platform-error pages (403/402, 'Just a moment', /lander, forsale.godaddy, Shopify 'unavailable') and report 'unreadable' instead of guessing. Fall back to a rendered read (the engine's karos-landing capture or ScrappyCoco) for Cloudflare sites.
- [M] (A; karos-portal) Resolve every role to a face that can load, following the owner's order: (1) uploaded or lab files; (2) the same family in the PUBLIC Google Fonts catalog, with the real weights and axes that family ships, rejecting /l/font?kit= Docs kits such as Georgia and Helvetica Neue; (3) the closest free match (by classification and metrics), marked source 'substitute', flagged to staff and never applied silently. Check script coverage per role (Open Sans covers Hebrew).
- [M] (A, B; karos-portal) Font review and upload in the branding modal. Per role, show family plus uploaded files (woff2/ttf/otf), a provenance badge, a licence confirmation and approve/replace for substitutes. Uploads go through a new route modelled on the logo route; saving re-projects.
- [S] (A, B; karos-portal) The lab import carries fonts: read profile/brand-colors.json fonts[] roles and upload brand/fonts/* and brand/kit/fonts/* to Storage with their licence notes.
- [S] (A; karos-portal) Make projection reliable for engine-scheduled runs. Re-project on a schedule and after scripted writes, since backfill-brand-fonts.ts writes Firestore only. Report a skipped projection loudly. Correct the comment at branding-actions.ts:115-117 that says every run is re-projected.
- [S] (A; data-fix) Set verified typography for the 7 clients, prep first, prod after promotion, then re-project.
- karoslabs: Spectral / Hanken Grotesk; label Hanken uppercase, as on the site, or JetBrains Mono, as in the lab spec (owner picks); figures Hanken tabular.
- geektime: Open Sans in all roles, Hebrew included.
- thepitchbydeel: Bagoss files if Displaay and Deel clear the licence, otherwise a flagged substitute; Inter body and overline.
- hankypanky: Relais/Fabriga once the client supplies files, a flagged substitute meanwhile; remove Georgia/Helvetica Neue.
- kindlyyours: fix the website record (parked domain); GT Walsheim needs files; lab stand-ins Fraunces/Nunito, flagged.
- sitti: Gaegu, with JetBrains Mono for stats (founder to confirm).
- xodigital: Fraunces / Geist / Geist Mono from the lab TTFs.
- [S] (A, B; lab) Normalise lab font roles to display/body/label/figures in each client's fonts[], with file paths and licence status. Record the owner's decisions where sources disagree: karoslabs label (Hanken on the site, DM Mono loaded, JetBrains Mono in the spec) and xodigital (kit vs live site).
- [M] (A, C; agent-engine) The engine kit reads the typography roles: display, body, label (feeding --f-label and --f-mono) and figures (--f-figures plus --num-variant), from brand.json. Mono stops being config-only (brand-render-tokens.ts:780). A rejected or unloadable name is reported instead of silently dropped (:133-136).
- [M] (A, C; agent-engine) Load faces as first-party @font-face rules with explicit weight and style descriptors. Font binaries are fetched once per run from the projected https URLs, or Google's static files for the exact weights, cached and embedded as data URIs like the logo (workflow :2620-2660). This replaces the bare css2 links (brand-render-tokens.ts:1040-1074; script-fonts.ts:279-291). Add font-synthesis:none to the design system, and share one resolver with branded-shorts (derive-brand-setup.ts:202-217).
- [M] (A, C; agent-engine) Templates, devices and the studio shell name roles, never families.
- Drop the Fraunces/Inter/IBM Plex Mono defaults (_design-system.css:85-96, synced into the 8 plates; safety.ts:254-265).
- Eyebrow, kicker, badge, handle, pagination, source line and note use var(--f-label).
- Every numeral uses var(--f-figures) with font-variant-numeric var(--num-variant): .num-figure (add a rule), .dv-figure, .dv-bar-value, .dv-tl-at, .dv-st-value, .dv-st-label.
- Device sources and notes use var(--f-label), so each role has one face per carousel.
- [M] (A; agent-engine) The engine never chooses a face.
- Registers keep weight, tracking and bleed only. Remove the family names, REGISTER_DISPLAY_FONT_FAMILY/CONDENSED_DISPLAY_FONT_FAMILY and the register links; the weight snaps to one the brand face ships.
- A script face fills only glyphs the brand face lacks. It is never written over a covering brand face, and it is flagged in the gate payload.
- Remove IBM Plex Mono from the Greek/Cyrillic rows.
- Fallback stacks match the brand face's genre (a sans falls back to a sans).
- Badge style comes from the label role, not from visualStyle.
- [M] (A; agent-engine) Painted-font guard in the renderer. After fonts.ready (render-carousel.ts:1360-1361), call CDP CSS.getPlatformFontsForNode on every text leaf and compare each leaf's computed weight and style with the loaded FontFaces. Return fontsPainted {family, isCustomFont, glyphCount, selector}, replacing the requested-name fontFamiliesUsed (:780-782; slide-metrics.ts:547). Given allowedFaces from the kit, refuse the slide (kind 'brand-font') when any glyph is painted by a system font or a non-allowed family, or with a synthesised weight. Fix the false 'proves it loaded' claims and template-studio gate 8. Reuse the same probe in karos-landing (render-page-tool.ts:79-80).
- [S] (A; agent-engine) Workflow wiring.
- Step 02c records typography provenance, status and brand.json projectedAt.
- For Instagram, a kit with no typography or no projectedBy holds the run with a staff-facing reason instead of rendering template defaults. This covers today's seeded sitti, hankypanky and kindlyyours files and the kitless path at :2770.
- Step 08 passes allowedFaces to the guard.
- The gate payload and the portal card show the faces painted per role and any flagged substitute.

**Guards**

- Render guard (karos-publish): CDP CSS.getPlatformFontsForNode on every text leaf after fonts.ready. A glyph painted by a system or fallback font, or by a family outside the kit's resolved faces (plus flagged substitutes and script gap-fills), refuses the slide as 'brand-font' and names the slide, selector and family. This catches unloaded fonts, DejaVu fallbacks, Georgia-for-Bagoss and Docs-kit fonts, so a non-brand face cannot ship silently.
- Weight guard: font-synthesis:none, and every leaf's computed weight and style must be covered by a loaded FontFace of its family. Synthetic bold (today's Spectral headlines) becomes impossible.
- CI Chromium sweep: the 7 real client kits (fixtures from the data fix, including Hebrew Open Sans) across the 8 plates. Painted families must equal the kit roles, and figures and source lines must sit on their roles. It must fail on today's main (DejaVu mono, Georgia for Bagoss, Heebo on geektime, faux-bold Spectral), and each check must be broken once on purpose to watch it refuse.
- Static tests (extend design-system-sync.test.ts and default-template-render.test.ts): no family literal ('Fraunces', 'Inter', 'IBM Plex Mono', 'Oswald', 'Space Grotesk', …) in _design-system.css, the plates, the safety.ts studio shell, visual-system.ts register stacks or the Latin rows of script-fonts.ts. Every var(--f-*) a template reads must be emitted by the brand head with an @font-face.
- Cross-repo contract test: one typography fixture produced by portal toProjectedBrand is parsed by engine deriveBrandRenderTokens. It covers roles, files, weights and status, and is registered in engine-field-contract.ts with evidence lines.
- Portal tests: BrandingSchema contains no archetype font names, and model output can never persist as verified typography. Resolver fixtures taken from the live sites: karoslabs label and tabular figures; hankypanky --font-heading Relais beating the Yotpo widget; sitti Gaegu; xodigital next/font demangling; Deel Bagoss with Inter; geektime past 4 stylesheets plus a Cloudflare challenge returning unreadable; kindlyyours parked /lander returning unreadable; no emoji family ever returned.
- Catalog check: a 'google' source must exist in the public Google Fonts catalog, and /l/font?kit= responses (Georgia, Helvetica Neue) are rejected.
- Freshness and visibility: step 02c records brand.json projectedAt and the typography revision. Instagram refuses a kit with no projectedBy or no typography. The portal re-projects on a schedule for engine-scheduled runs. The gate card and client settings show each role's source and any substitute or needs-staff flag. scripts/audit-brand-fonts.ts lists unverified clients and must be empty after the data fix.

**Risks**

- Licensing. Bagoss (Displaay) needs a webfont licence plus Deel sign-off (lab brand.yaml:51). Relais, Fabriga and GT Walsheim are commercial, so the client must supply files and confirm the licence; copying a site's self-hosted woff2 into images may breach its EULA. Today's hankypanky renders already use Google-Docs kits licensed to Google Inc.
- Turning on the hard guard before the data fix would hold recurring posts for 5 of 7 clients. Ship the typography data and the flagged-substitute path first, then enforce.
- New faces (Gaegu, Bagoss Condensed, Open Sans Hebrew) change widths and overshoot. The fit ladder, --mk-face-bleed and interest-floor calibrations were measured on Fraunces, Inter, Oswald and Space Grotesk plus DejaVu mono, so the sweeps must be re-run.
- The guard can raise false positives on symbols and emoji (®, →) that brand faces lack. Check coverage from the font cmap before rendering, and only allowlist non-alphanumeric glyphs.
- Sources disagree and the owner must decide: karoslabs label face (site Hanken vs lab JetBrains Mono vs loaded DM Mono) and xodigital (D5 kit Fraunces/Geist vs live site Plus Jakarta Sans/Inter). kindlyyours' website record points to a parked domain.
- Other agents (tiktok, branded-shorts, landing, newsletter) read fonts.heading/body and brand.json. Keep the mirrors and version the typography object.
- Embedding fonts as data URIs grows each slide document by about 40-100 KB per weight, and the CDP probe adds render time (about 50 nodes per slide).
- Some Google families lack weights or axes. Request only the weights the catalog lists; an unlisted axis makes css2 return 400 for the whole request.

## Renderer typography, layout and photo covers (C, D, H): plates/templates, fit ladder, scrim, cover limits, box/device styling

**How it works today**

Scope and method. Code refs are agent-engine origin/main 0709bb8. The scratchpad clone's HEAD a65cdb8 is 3 commits behind: #244 and #248 are only on origin/main, and _design-system.css lines after ~299 shift +45 between the two. Evidence comes from each run's final render step (08-render-carousel-attempt-N or 08a1c-render-relayout-attempt-N, outcome.result.rendered[].geometry.fontSizeSteps and probe), plus a $0 local reproduction in headless Chromium that composes the bundled plates exactly as production does (template sheet, then deviceCssBlock + visualSystemCssBlock + heroScrimCssBlock, then brand head). It returns identical size sets to production. Scripts and renders are under /private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad: type-audit.cjs/.json, repro/harness.mjs, repro/scrim-measure.mjs, repro/proposal-measure*.mjs, repro/face-measure.mjs, repro/out/*.png. All 8 runs rendered on the bundled plates: 04c chose bundled:* for every archetype, and 00c says the studio 'authored 6 candidates and the battery kept none'. So every client shares the same 8 plates and differs only by tokens.

1) THE SCALE THAT RENDERS. _design-system.css:115-122 declares 'six steps' (22/32/46/66/94/200). But visualSystemCssBlock (visual-system.ts:1206-1229) is spliced after the template sheet (headExtras, create-instagram-agent-workflow.ts:5864-5889; composeRawDocument, karos-templates materialize.ts:197-205) and redeclares them on body. It uses TYPE_SCALE_PX 22/32/46/84/124/220 (visual-system.ts:448-461) times a per-run flavour on lead and above (visual-system.ts:477, 487-494: editorial 0.86, display 1.00, condensed 1.12). Two more multipliers apply on top: fontScale (_design-system.css:111-113, s 0.85 / l 1.18) and script (script-fonts.ts:296, Hebrew 0.94).

Effective px at fontScale m (display / editorial / condensed):
- micro 22: eyebrow/kicker :877-884, source-line/note :1114-1120, handle :939-944, pagination :948-956, list counters list-takeaway.html:1361-1365, recap indices closer.html:1412-1416, comparison column labels, quote attribution.
- label 32: stat body stat-callout.html:1387, comparison columns comparison-card.html:1404/1409, closer CTA closer.html:1540, list notes list-takeaway.html:1375, recap titles closer.html:1418-1419.
- lead 46/40/52: cover deck cover.html:1653, slide and headline-focus body, stat sub-label stat-callout.html:1384, closer question, list row titles list-takeaway.html:1373, recap figures closer.html:1427-1435.
- statement 84/72/94: slide headline slide.html:1363, list heading list-takeaway.html:1400, comparison heading comparison-card.html:1398.
- display 124/107/139: cover title cover.html:1652, headline-focus headline headline-focus.html:1388, quote quote-card.html:1375, closer takeaway closer.html:1531.
- figure 220/189/246: stat figure stat-callout.html:1383, list ordinal headline-focus.html:1354-1359.

Devices are NOT on this scale. deviceCssBlock (slide-devices.ts:760-1042) is spliced after the plate sheet and sets:
- .dv-figure 200/150/108 by character count (:777, :789-790; figureSizeClass :229-233)
- .dv-label 30 (:848-852), .dv-source 16 (:854-857), .dv-note 15 (:858-862)
- arrow 56, bar label 26, bar value 24 (:942), timeline 22/25 (:954-958), versus 34/25/26 (:966-975), position map 17/22, spec table 18/34 (:1032-1040)
These scale with --ts but not with the flavour. On equal specificity they beat the design system's own .dv-figure {--t-figure} and .dv-label {--t-lead} (_design-system.css:1226-1241). The latter was raised to lead for the owner's 'the text under 90% is really small', and is now dead. A latent third scale is the side split 132/72/54/38/30 (_design-system.css:438-446), out of rotation (slides-data.ts:1055).

2) THE FIT LADDER (_ds-fit.js, unchanged since 09-18; two passes :256-265). Fitted hosts start at their role.
- GROW (:225-237): the primary alone steps up while nothing overflows (statement to display, display to figure, lead to statement: _design-system.css:1136-1138; cover band guard :219-234).
- UNDO (:236): 'if (overflows()) { grown += 1 }' also runs when the plate already overflowed at step 0 and nothing grew, so it steps the PRIMARY DOWN one rung alone.
- SHRINK (:244-249): all hosts together, at most 2 rungs (_design-system.css:1147-1165; list-takeaway.html:1381-1384; closer.html:1423-1446; devices :1248-1251).
- REPORT (:253): data-fit-step records only the shared shrink, so the probe's fitStep and FIT_STEP_CEILING (interest-floor.ts:2037) never see the grow rung or the undo rung.
The free re-layout then changes fontScale per slide (interest-relayout.ts:100; :983-989 clipped drops a step; :1101-1109 dead-space raises one; :1148-1152 text-wall drops one; applied at create-instagram-agent-workflow.ts:13156).

3) WHAT THE RUNS RENDERED (fontSizeSteps = distinct sizes of visible text leaves, render-carousel.ts:1128-1150).
- Distinct sizes per carousel: Kindly 5; Karos B 7; Karos A 8 [246,139,94,52,32,25,22,15]; Sitti 9; Hanky 9; XO 11 [150,139,94,52,34,32,30,26,25,22,16]; Pitch 14 [220,124,108,84,46,34,32,30,26,25,22,18,16,15].
- Per slide (54 slides): 15 with 2 sizes, 14 with 3, 13 with 4, 4 with 5, 7 with 6. So 24 of 54 exceed 3.
- The widest spread on one slide is 14.7x (Pitch 3: ordinal 220, device figure 108, headline 84, body 46, device label 30, source 16).
- 11 slides carry off-scale 15-26px text, all from devices.
- One role changes size inside a carousel. Karos A interior headlines are 139 on slides 2, 3, 4 and 6 (grow) but 94 on 7 and 8. Pitch headline-focus headlines are 84 (role 124) on six slides at fitStep 0. Karos B's cover is 126/47 against 107/40 inside, because the re-layout raised it to fontScale l.
- The local reproduction confirms the undo rung. On Pitch 2/3, Karos A 8 and XO 6/8 the primary ends at data-fit=1, the rest at 0, data-fit-step 0, with a step-0 overflow (Pitch 3: plate scrollHeight 1504 > 1440).
- At step 2 the hierarchy flattens: Karos B slide 6 prints the list heading and its items both at 32px ([32,22]); Kindly slide 5 sets a 32-word quote at 52; Kindly slide 7 (closer) renders [52,32,22].

4) NUMBERS.
- .num-figure has no font-family (stat-callout.html:1383), so it inherits the body face (_design-system.css:55). Recap figures (closer.html:1427-1439) do the same.
- .dv-figure and .hf-ordinal use the display face (slide-devices.ts:772-773; headline-focus.html:1355).
- Counters, indices, values and pagination use --f-mono, whose default is IBM Plex Mono (_design-system.css:95). No kit declares it (02c lists 2 faces on every run).
- Probe fontFamiliesUsed: every stat slide lacks the display face (Karos A 5: Hanken Grotesk + IBM Plex Mono, so '500M+' is sans between Spectral headlines), and IBM Plex Mono appears on every slide of all 8 runs.

5) COVERS AND WORD LIMITS. The cover's title and subtitle are the copy's headline and body (slides-data.ts:2266-2277). No cover-specific cap exists:
- the generic 30-word statement limit (slide-word-budget.ts:119; 60 total :165; 20 per block :130)
- schema maxima of 200 chars for the headline and 600 for the body (types.ts:866-867)
- BODY_WORD_BUDGET (#243, slides-data.ts:1126-1134) has no cover key and runs only on interior slides (:3070)
- the copy prompt gives no number (prompts/instagram-copy/latest.md:373-377, 548-562)
XO's cover (11 + 19 = 30 words) passed 07h2, which flagged only slides 2 and 3. It rendered [139,52]: four title lines (about 620px) over three lines at 52px.

6) SCRIM PER PLATE.
- Only cover.html (1639) and slide.html (1353) have a .scrim element. The four panels carry data-hero-scrim with nothing to apply it to, and headline-focus and closer carry neither.
- heroScrimStrength is 'standard' on every slide with a hero: gradePictureSet's default scrimFor (style-lock.ts:762-781), and the call at create-instagram-agent-workflow.ts:12508 passes none.
- requiredHeroScrim (style-lock.ts:674, floor 4.5 at :589) is never called.
- The shade is a fixed gradient (_design-system.css:347-362: --bg at 96/86/52/0% at 0/22/42/62% from the bottom, nothing above 62%) plus a flat 0.22/0.45 --bg veil over the whole plate as .scrim::after (style-lock.ts:811-823).
- The portrait cover gets a 180deg 12/62/96% gradient (cover.html:1457-1462). An eyebrow over a photo gets its own chip (_design-system.css:857-875).
- The scrim is hidden when strength is absent (365-367), for mark heroes (273), cutouts (298), framed heroes (341-342, #244), inset interior photos (697, #242) and news-frame covers (cover.html:1502).
- #244 frames a cover or photo when the body has 10 or more words (FRAMED_DECK_MIN_WORDS, slides-data.ts:1182-1199, 3287). Title length is not read.
- Nothing gates text-over-photo legibility. The floor logged XO's cover 'ground/ink contrast 1.00:1 (gates nothing)' with zero findings (08a1d), and visual QA passed 'font-hierarchy' (08b).
- #230 (merged 14:52 UTC) left a bare '.scrim { display: none; }' (87adb80 _design-system.css:275) that also removed the veil. #236 restored it at 16:35 UTC. XO rendered at 16:27-16:28 UTC, inside that window: the render shows no gradient and no veil. The deployed revision is not recorded on the run doc, so this is consistent with the regression rather than proven.

7) BOXES AND DEVICES.
- Five plates carry the same hard-coded 'bounded object' ramp: linear-gradient(146-158deg, accent 22-42% to accent 11-16% to fg 14-22%), radius 4px. The locations are cover .cov-field (cover.html:1555-1571), .num-zone (stat-callout.html:1345-1360), .cmp-cols (comparison-card.html:1346-1361), .quote-block (quote-card.html:1341-1353), and .cl-panel with its block/split forms (closer.html:1374-1393, 1490-1516).
- Their own comments say they exist to pass the interest floor's emptiness and object clauses (stat-callout.html:1339-1343; closer.html:1354-1373; quote-card.html:1335-1340; cover.html:1544-1561). The clauses are LARGEST_EMPTY_RECT_CEILING 0.22/0.28/0.22 (interest-floor.ts:428) and IMAGERY_OR_DEVICE_FLOOR 0.10 (:1315).
- Device fragments carry their own look: a 6px versus bar, 2px table hairlines and opaque bar plates (slide-devices.ts:862-1042).
- Radii are literals: 0, 1, 2, 3, 4, 6, 10 and 22px, 50% and 999px. There is a white #ffffff disc behind comparison logos (comparison-card.html:1371-1380), a white mark chip (_design-system.css:1289-1290), and #fbfbf8/#121212 on the news frame (cover.html:1511-1525).
- The only client inputs are --accent, --fg and --bg. brand-render-tokens.ts:733-743 can emit --surface, --line, --alt-ground, --fg2 and --accent-ink, but no plate reads them.
- The portal projects only colours, heading and body fonts, logo, voice, visualStyle and free-text guidelines (karos-portal src/lib/agent-engine/context-doc-projection.ts:90-136, 196-240). BrandingGuidelines has no mono face or radius (src/lib/types.ts:1862-1863).

**Root causes**

- **C: 'not 100 different sizes'. Base sizes change from run to run and disagree with the declared scale.**
  - Cause: Two scales and three multipliers. _design-system.css:115-122 (22/32/46/66/94/200) is overridden on body by visualSystemCssBlock (visual-system.ts:1223) with TYPE_SCALE_PX 22/32/46/84/124/220 (:448-461). That is then multiplied by the per-run flavour 0.86/1.00/1.12 (:477), by fontScale 0.85/1.18 (_design-system.css:111-113) and by the script factor (script-fonts.ts:296).
  - Evidence: fontSizeSteps from the render records. Sitti (display flavour): cover [124,46,22], stat [220,46,32,22], list heading 84. XO, Karos A and Kindly (condensed): cover [139,52], stat figure 246, statement 94. Karos B (editorial): [107,40] and stat 189. The 66/94/200 scale that the plates declare never renders.
- **C: device text is tiny and adds sizes. The owner's earlier device-label fix is silently undone.**
  - Cause: deviceCssBlock (slide-devices.ts:760-1042) hard-codes 15-56px literals plus 200/150/108 figures chosen by character count (:777, :789-790, :229-233). It lands after the plate sheet (create-instagram-agent-workflow.ts:5864-5889; materialize.ts:197-205), so on a tie it beats .dv-figure {--t-figure} and .dv-label {--t-lead} (_design-system.css:1226-1241).
  - Evidence: Pitch 3 [220,108,84,46,30,16]; XO 7 [150,94,52,30,16]; Hanky 6 [200,124,46,30,22,16], where the device figure is 200 rather than the 220 figure step and the label 30 rather than lead 46. 11 of 54 slides carry 15-26px off-scale text, all from devices, and 7 slides carry 6 sizes.
- **C: extremes, with some text far too big and some far too small, and the same role at different sizes on one carousel.**
  - Cause: Four behaviours in the fit ladder. First, the grow rung (_ds-fit.js:225-237; _design-system.css:1136-1138) lifts short headlines one step. Second, the undo line (_ds-fit.js:236) steps the primary alone one rung DOWN when a plate overflows at step 0 and nothing grew. Third, data-fit-step (:253) reports only the shared shrink, so both of those are invisible. Fourth, the shrink reaches step 2, where headings fall to label 32 and notes and recap titles to micro 22 (_design-system.css:1161-1165; list-takeaway.html:1381-1384; closer.html:1423-1424).
  - Evidence: Pitch slides 2-7 headlines at 84 (role 124), and Karos A 8, XO 6 and XO 8 at 94 (role 139), all at fitStep 0. The local reproduction returns identical size sets with data-fit=1 on the primary only and a step-0 overflow (Pitch 3: 1504px > 1440). Karos A comparison and photo headlines grew 94 to 139 while its list and closer headlines stayed at 94. At step 2: Karos B slide 6 heading and items both 32px; Kindly slide 5 quote at 52; Kindly slide 7 closer [52,32,22].
- **C: one slide's type differs from the rest of the carousel.**
  - Cause: The free re-layout's remedies change fontScale per slide (interest-relayout.ts:100; clipped :983-989, dead-space :1101-1109, text-wall :1148-1152; applied create-instagram-agent-workflow.ts:13156).
  - Evidence: Karos B 08a1b: 'slide 1 left too much of the plate empty; raising its fontScale from m to l'. The cover rendered [126,47] against [107,40] on the interior slides.
- **C: nothing stops these outcomes from shipping.**
  - Cause: The type-discipline clauses are disarmed: TYPE_STEP_CEILING 3, TYPE_CONTRAST_FLOOR and ALIGNMENT_COLUMN_CEILING all have ARMED=false (interest-floor.ts:2021-2027). FIT_STEP_CEILING is not armed (:2037) and reads a fitStep that is blind to the primary's rung. The visual-QA judge scores by eye.
  - Evidence: 24 of 54 slides exceed 3 sizes and every one shipped. Carousels ran 5-14 distinct sizes. XO's visual QA passed 'font-hierarchy' (08b-visual-qa-attempt-3) on a set whose cover measured 1.00:1.
- **C: numbers appear in a different font.**
  - Cause: There is no numeral-face token. The stat figure (stat-callout.html:1383) and recap figures (closer.html:1427-1439) inherit the body face (_design-system.css:55). Device figures and list ordinals use the display face (slide-devices.ts:772-773; headline-focus.html:1355). Counters, indices and values use --f-mono, which defaults to IBM Plex Mono (_design-system.css:95), a face no client declares.
  - Evidence: The probe's fontFamiliesUsed never includes the display face on a stat slide (Karos A 5: Hanken Grotesk + IBM Plex Mono, so '500M+' is sans between Spectral headlines). IBM Plex Mono is on every slide of all 8 runs. Karos Labs' own spec sets numbers and labels in JetBrains Mono (karos-agents/clients/karoslabs/profile/brand-colors.json:107-108).
- **H: covers carry too much text, huge on top and small below.**
  - Cause: No cover caps exist. The cover takes the copy's headline and body (slides-data.ts:2266-2277) under the generic 30-word limit (slide-word-budget.ts:119) and the 200/600-character schema maxima (types.ts:866-867). BODY_WORD_BUDGET has no cover key and applies only to interior slides (slides-data.ts:1126-1134, 3070). The prompt gives the cover no number (instagram-copy latest.md:373-377, 548-562). The title sets at display size (124-139px), and those faces hold only about 15-17 characters a line (measured at 0.45-0.48em per character).
  - Evidence: XO's cover, 11 + 19 = 30 words, passed 07h2 and rendered [139,52]: four title lines over three at 52px. Karos A's 12-word title rendered as five lines at 139. Under #244 the XO copy is framed and the ladder shrinks it to [94,32] at fitStep 1 (local render).
- **H: no shade under the text, so the cover is unreadable.**
  - Cause: Three things combine. #230 left a bare '.scrim { display: none; }' (87adb80 _design-system.css:275), which also removed the veil (a .scrim::after, style-lock.ts:811-823), until #236. Even restored, the scrim is fixed rather than measured: nothing above 62% from the bottom (_design-system.css:347-362) plus a flat 0.22 veil, while tall covers climb above it. Every hero slide gets 'standard' (style-lock.ts:762-781; call at workflow :12508), and requiredHeroScrim with its 4.5 floor (style-lock.ts:589, 674) is never called.
  - Evidence: XO rendered at 16:27-16:28 UTC, inside the #230 (14:52 UTC) to #236 (16:35 UTC) window, with no gradient and no veil; the floor logged ground/ink 1.00:1 and gated nothing. On main with the scrim restored, local renders over a bright ground put XO's title lines 1-2 at 2.16 and 3.40:1 median (p10 1.99 and 2.56) and Karos A's lines 1-3 at 1.77, 1.94 and 3.35. Dark type over a dark ground measures 1.66 and 2.87 (Sitti) and 2.20 and 4.38 (Kindly), against the 4.5:1 floor. Sitti's good slide 1 rendered at 18:19 UTC, after #236, over a light photo: the right picture, not a rule.
- **H: #244's framing rule contradicts the owner's reference cover and doesn't cap the title.**
  - Cause: framedHeroFor frames any cover or photo whose body has 10 or more words (slides-data.ts:1182-1199, 3287) and ignores the title.
  - Evidence: On the 8 audited covers it frames Sitti (a 12-word deck: the owner's own good example), Hanky, Pitch and XO, while Karos A's 12-word title stays a full-bleed poster. A framed XO leaves 623px for 30 words, and the ladder takes it to [94,32]. A framed Sitti title steps down to 84 (local renders).
- **D: boxes and devices do not look like the client's design language (Karos A's brown gradient boxes).**
  - Cause: The bounded-object ramps are hard-coded accent tints (cover.html:1555-1571; stat-callout.html:1345-1360; comparison-card.html:1346-1361; quote-card.html:1341-1353; closer.html:1374-1393, 1490-1516). They were built to satisfy the interest floor (interest-floor.ts:428, 1315; comments at stat-callout.html:1339-1343, closer.html:1354-1373, cover.html:1544-1561). Radii and whites are literals. The only client inputs are --accent, --fg and --bg. The --surface and --line tokens are emitted but never read (brand-render-tokens.ts:733-743). The portal projects no design language (context-doc-projection.ts:90-136, 196-240), and the studio kept no client templates (00c on all runs).
  - Evidence: Karos A slides 2, 4, 5 and 8: accent #ff6b2c at 24% over #1a1a1a is rgb(81,45,30), a brown ramp across panels roughly 950px wide by 400-800px tall. Karos Labs' spec says: radius 6px default and 'hairline dividers instead of boxes' (branding-guidelines.md:76); one ground only, with surfaces retired (:44-45, 108-115); the accent 'never large backgrounds, never more than about 5% of a screen' (brand-colors.json:25); depth comes from 1px borders (:52-55). The engine received 3 colours and 2 faces for Karos (02c/02g).

**Proposed changes**

- [L] (C; agent-engine) One role scale, from one source. Three text roles per carousel: H (every headline-like host: cover title, interior headline, quote, takeaway, list and comparison headings), T (every reading host: body, sub-labels, list rows, comparison columns, CTA, question) and S (eyebrow, kicker, source, handle, credit, indices). F (1.5 x H) is allowed only when a figure is the plate's sole display element. Size each role per client by measure rather than by a seeded flavour. H is where the display face sets about 18 characters a line on the field (about 110-120px for the audited faces: Space Grotesk ~111, Inter ~113, Plus Jakarta ~115, Spectral ~118). T is where the body face sets about 38-40 characters (48-52px). S is 28px (floor 26). Generate the plate scale from one TS table via sync-design-system.ts and delete the 66/94/200 duplicate and the side-split scale. Keep the flavour for face, weight and tracking only. Map .r-figure, .r-display, .r-statement, .r-lead, .r-label and .r-micro onto F, H, H, T, T and S.
- [M] (C, M; agent-engine) Put the device stylesheet on the scale. Every font-size in deviceCssBlock reads F, H, T or S: the figure is F when alone and H otherwise; labels, bodies and table values are T; sources, notes, axis labels and dates are S. Drop the 200/150/108 character-count autosize (figureSizeClass). Delete the shadowed .dv-figure and .dv-label rules so each class has one owner. Set the headline-focus list ordinal at H or S, never above the claim.
- [M] (C; agent-engine) Rewrite the fit ladder as a reported safety net. Remove the grow rungs (-1/-2). Allow at most one shrink rung, on the primary only (H to 0.875H), with floors no rung can cross (H at least 0.85 of its size, T at least 44, S at least 26). Fix _ds-fit.js:236 so the undo runs only when grown < 0. Make data-fit-step report the primary's rung. Delete the data-fit=2 mappings that set headings at label and recap titles or notes at micro. A plate that still overflows is a copy finding, fixed by the free re-layout's move-last-sentence-to-caption remedy, never by smaller type.
- [M] (C; agent-engine) Stop per-slide fontScale changes in the free re-layout. clipped and text-wall move the body's last sentence to the caption (an existing remedy) or reassign the layout. dead-space uses object, photo or layout remedies only. The reviewer's fontScale becomes one carousel-wide setting. Coordinate with open PR #247.
- [S] (C, A; agent-engine) Numbers in the brand's numeral face. Add a --f-num token (default --f-display; a brand may declare its own number face, e.g. JetBrains Mono for Karos Labs) with lining, tabular numerals. Apply it to .num-figure, recap figures, .dv-figure, .hf-ordinal, list counters, recap indices, bar and table values, and pagination. Never render the IBM Plex Mono default for a client that declares no mono: fall back to its body face. The brand head emits --f-num and --f-mono from the kit.
- [M] (C, H; agent-engine) Cover caps and line budgets. Cover title at most 8 words (about 50 characters) and 3 lines at H. The deck is optional: at most 12 words, 2 lines at T, and its first whole sentence only. Cover total at most 20 words. Interior headline at most 10 words and 3 lines at H, body within BODY_WORD_BUDGET and at most 6 lines at T. Enforce before render in slide-word-budget as a $0 writer steer, with a mechanical whole-sentence cut of the deck. Check again after render as line counts plus a copy block no taller than 50% of the frame on a poster. Add a cover entry to BODY_WORD_BUDGET, and state the numbers in a new copy prompt version.
- [L] (H; agent-engine) Scrim rule for any text over a photo. Anchor the scrim's dense band (86-90% --bg) to start one line above the MEASURED top of the copy (set in-page after the fit ladder, before __CAROUSEL_READY__), easing to clear over about 15% of the frame. After render, measure each line box's 10th-percentile background against --fg and require 4.5:1, wiring requiredHeroScrim per line and arming it as a finding. If that is unreachable, the free re-layout switches to the framed composition, never to smaller type. Replace framedHeroFor's deck-of-10-words trigger with this outcome, so a capped poster (like Sitti's slide 1) stays full-bleed. Keep the eyebrow chip. Prototype evidence: capped copy at 112/50px with the anchored scrim gives every line 5.7-16.6:1 at p10 over worst-case bright and dark grounds, against 1.65-2.45:1 today, with the copy in the bottom 47-48% (repro/proposal-measure-112.mjs).
- [L] (D; agent-engine) Boxes and devices from the client's design language. One .ds-box primitive reads --box-style (hairline, fill, tint or none), --box-fill, --box-line, --r-box, --r-pill, --r-media and --accent-budget. It replaces the five accent ramps (cover, stat, comparison, quote, and the closer's three forms), the white comparison-logo disc and the literal radii. The device fragments (versus, spec table, bars, timeline, recap tiles) read the same tokens. The brand head emits them, so the already-emitted --surface and --line finally get consumers. Default when the client declares nothing: a 1px hairline, radius 6, no fill, never an accent gradient. Recalibrate the interest floor to count a declared box's AREA, as COVER_OBJECT_BOX_SHARE already does, so hairline boxes do not bring the tinted fills back.
- [M] (D, B; karos-portal) Project the design language to the engine. ProjectedBrand gains fonts.mono and a designLanguage block: box radius, box style, surface and hairline hexes, pill/button shape, accent budget, numeral face, and table/number style. toProjectedBrand reads it from BrandingGuidelines, which the B onboarding upgrade fills.
- [S] (D, B; lab) Add a machine-readable design-language block to lab client profiles. Karos Labs' brand-colors.json already carries hairlines, surfaces and JetBrains Mono. Add radius 6 (marker 0, avatars 50%), box style hairline, one ground, and an accent budget of about 5% from branding-guidelines.md:76 and 108-115, and add the same block for the other lab clients so lab imports project it.
- [S] (D; data-fix) Once the projection lands, re-project client/brand.json for every client on prep and prod. Karos Labs' engine kit today has 3 colours and 2 faces: no mono, radius or hairline.

**Guards**

- Composed-CSS lint test: build every plate the way production does (template + deviceCssBlock + visualSystemCssBlock + heroScrimCssBlock + brand head) and assert every font-size resolves to var(--t-head|--t-text|--t-source|--t-figure). It fails today on the slide-devices.ts literals and on the 66/94/200 vs 84/124/220 split.
- Single-source scale test: the plate scale is generated from one TS table, and a test compares the generated block to it, so a second scale cannot reappear.
- Render sweep (8 plates x short and long copy x en/he x each client face): each slide's fontSizeSteps is a subset of {H,T,S}, plus F only on a lone stat or cover figure; H at least 0.85 of its size, T at least 44, S at least 26; at most 4 sizes per carousel. Then arm TYPE_STEP_CEILING (interest-floor.ts:2021/2025) at 3.
- Fit-ladder render test built from this audit's harness cases (Pitch 3, Karos A 8): a plate that overflows at step 0 reports data-fit-step of at least 1, no host ever grows, and no host ends below its floor.
- Cover-cap unit tests in slide-word-budget: XO's 11 + 19 word cover is refused or cut before render, Sitti's 8 + 12 passes with the deck cut to one sentence, and a render-time line-count check keeps the poster copy block at or below 50% of the frame.
- Hero legibility render test (repro/scrim-measure.mjs as the template): a poster cover over synthetic bright and dark grounds must clear 4.5:1 at p10 behind every text line. Arm it as a finding whose remedy is framing, never shrinking. This extends mark-hero.test.ts, which today only string-matches a bare '.scrim { display: none; }' rule.
- Device-style test: no plate paints color-mix(var(--accent) N%) as a panel fill unless the client's designLanguage says tint. A Karos Labs fixture (hairline #34343B, radius 6, accent budget 5%) must render stat, comparison and closer boxes as 1px hairlines, with measured accent share at or below 5% of the frame.
- Numeral-face probe test: fontFamiliesUsed for .num-figure, recap figures, .dv-figure, .hf-ordinal and the counters equals the --f-num family, and IBM Plex Mono never appears for a client that did not declare it.
- Re-layout contract test: planInterestRelayout never emits kind 'font-scale', and every slide of an assembled carousel shares one fontScale.
- Visual QA receives the measured numbers (fontSizeSteps, fitStep, per-line hero contrast), so its 'font-hierarchy' rule cannot pass a set the probe measured at 1.00:1.

**Risks**

- The interest floor's armed emptiness clauses (LARGEST_EMPTY_RECT_CEILING 0.22/0.28, interest-floor.ts:428; IMAGERY_OR_DEVICE_FLOOR 0.10, :1315) were calibrated against the accent ramps and the grow rung. Fixed type with hairline boxes will raise dead-space findings, meaning more re-layouts or paid redrafts, unless the floor is recalibrated in the same branch (count box area; accept air on a composed plate).
- Hebrew and RTL: character budgets and the measure-derived H and T differ by script (script-fonts.ts typeScale 0.94, short words, wide faces). Caps and floors need per-script values and sweep rows.
- Removing size flavours reduces cross-client variety, which the owner complained about earlier. Variety has to come from the client's own design language (face, weight, box style, radius), and that depends on B's onboarding capture. Until then every client gets the same quiet default.
- Replacing #244's trigger reverses behaviour merged hours ago on the owner's XO feedback. The owner should confirm that a capped poster (Sitti-like) is the default and framing is the fallback.
- Tighter pre-render caps can cost redrafts at about $0.126 each (run-budget.ts). Mitigate with $0 mechanical whole-sentence cuts of the deck and body, keeping the refusal as a steer on attempt 1 only.
- The anchored scrim runs in-page after layout, so it must be sequenced with the fit ladder's two font-load passes and __CAROUSEL_READY__, or the screenshot can capture a stale gradient.
- The stat figure at 1.5 x H (about 170px, against 220-246 today) may read as too quiet to the owner. Confirm on the planned local re-run before locking F.
- The eight generated plates, golden renders and calibration constants (interest-floor-calibration.test.ts, the TYPE_* constants) all move together: a large diff and a full sweep. Studio and custom-archetype templates must be built on the same tokens, or a client template reintroduces free sizes.

## Copy language (letter C: complete, human, non-AI sentences that fit their lines), traced through 04j angle, 05/05r copy, the 07b/07i/07j/07h2 gates and 07c assembly. Also the Kindly Yours wrong-business data defect, traced from the portal client record through the knowledge mirror to the engine brief (02i). Read-only audit of agent-engine origin/main a65cdb8, karos-portal worktree HEAD df0c7a09, the karos-agents lab, prep and prod Firestore, and 51 prep Instagram runs created since 2026-09-20 (the 8 named runs plus 43 more).

**How it works today**

COPY PATH (agent-engine, agents/instagram-agent).

1. The angle comes first. 04j picks an angle whose rememberLine the writer must reuse 'verbatim or near-verbatim' on the cover or the closer (prompts/instagram-copy/latest.md:933-937). The angle prompt's example of a good rememberLine is itself a negation: 'A default triage is not a designed one' (prompts/instagram-angle/latest.md:34-35). Its wrong-assumption angle is framed as 'name the belief, then name what the evidence says' (:15-16).

2. 05-write-copy uses instagram-copy@31: 97,280 characters, 1,683 lines, pinned to claude-sonnet-4-6 (src/agent/instagram-copy-agent.ts:113,489). These are its only language rules:
- caption: 'Short declarative lines, one idea to a line' (latest.md:56-61)
- headline: 'the short, punchy line' (:149)
- a counted cap of 30 words per slide, aim for 20 (:152-159)
- three tells left to the writer's judgement: rule of three, Let's/Imagine, journey (:640-657)
- §24.2 teaches a sentence 'short, declarative, and it turns in the middle' (:1356-1359)
- §25's position shapes include 'X is not the reason Y happens. Z is.' and 'Your walk in is not dying of old age, it is dying of a dirty condenser coil', with a Hebrew twin (:1442-1466)
- §26 asks for 'at least one headline of six words or fewer' and 'at least one body that turns on a contrast ("not this. that.")' (:1482-1489)

The prompt never asks for complete sentences: 'complete sentence', 'full sentence' and 'fragment' get 0 hits. It never names negative parallelism as a tell. The contrast shapes arrived in v17 on 2026-09-13; the contrarian hookPattern and 'short declarative lines' arrived in v23.

3. Repair and revision. 05m replaces dashes with ', ' (src/workflow/mechanical-repair.ts:114-121). Attempts 2 and 3 are 05r minimal edits (create-instagram-agent-workflow.ts:8248-8253) by instagram-copy-revise@1, also claude-sonnet-4-6 with no tools (src/agent/instagram-copy-revise-agent.ts:49-59).
- The reviser sees only the draft's fields, the findings and the language.
- Its prompt optimises for the fewest fields and the same length (prompts/instagram-copy-revise/latest.md:6-8, 46-63). It carries no banned-phrase list, no §10 rules and no brand voice.
- It cannot edit comparison columns, device labels or kickers (src/workflow/copy-revision.ts:87-93, 175-188).

4. Gates, in the order they run on each attempt:
- 07b craft hygiene (workflow:11238; craft-hygiene.ts:623-798) lints only headline, body and custom slots (slideProse, :203-210, :659).
- 07i free value floor (workflow:11295-11318; value-signals.ts:573-583): the first refusal wins.
  - coverTension counts 'is not / isn't / are not / aren't' and 'not…but' as tension (:384-389), and its refusal text prescribes 'X is not the reason Y happens. Z is.' (:419).
  - namedSpecifics needs digits, capitalised proper nouns or brief terms, and says 'Put one of the fact cards' figures on a slide that has none' (:326-370).
  - rhythm counts the first word of every copy headline, articles included (:525-545).
- 07j value judge (workflow:11755; value-gate.ts:329-376):
  - it reads only the copy's headline and body (:496-507)
  - it is told 'Judge only these four questions. Not grammar, not fluency' (:361)
  - its PASS example cover is 'Your walk-in is not dying of old age. It is dying of a dirty condenser coil.' (:369-371)
  - it accepts a verbatim quote of any length (:598-603)
  - it sets no maxTokens (:783-797) and is priced at $0.003 a call (run-budget.ts:840).

5. After all the gates, 07c assembly (workflow:12541) rewrites text:
- composeBoundedObjects lifts a figure's sentence out of the body into a device label, splicing the figure out (workflow:12323; bounded-object.ts:286-340, 476-600).
- #243's trimToSentenceBudget cuts interior bodies, keyed on the DECLARED layout before resolveLayout (slides-data.ts:1126-1158, applied at :2995; the layout is resolved at :3009). It merged after these 8 runs, so their outputs do not show it.
- The closer routes the whole body into `question` if it contains a '?' (slides-data.ts:2252).
- The recap strip truncates entries with '…' (slides-data.ts:1218-1235; caps at :230-239).
- The interest relayout's merge appends a removed slide's headline and body onto its neighbour's body, even when the neighbour does not render a body (workflow:13132-13133).
- The alt-text packager reads the copy's headline and body, not the rendered text (workflow:13959, 13990).

6. 07h2 word budget (slide-word-budget.ts:119-317; workflow:12689-12712) runs only after all of that. Every gate sends the draft back only on attempts 1..n-1; on the final attempt it only records.

What 51 prep runs since 2026-09-20 show:
- 50 of 51 reached attempt 3.
- 07i refused 84 times: coverTension 34, sourceProse 28, rhythm 14, namedSpecifics 7, payloadShape 1.
- 07h2 ran only on the final attempt in 48 runs and shipped over-budget slides in 33.
- The judge ran only on the final attempt in 40 runs, cost $3.13 over 65 calls (about $0.048 each) and errored 8 times.

KINDLY YOURS DATA PATH.

The portal client vj8pJxRGLtiN2YbBuPwR exists in prep and in prod, created 2026-07-21. The record is identical in both:
- website https://kindlyyours.com/
- no profileSource and an empty industry
- brandingGuidelines, updated 2026-09-01: gold #d4a574 with #2d2d2d and white; Plus Jakarta Sans and Inter; tone 'Elegant, Thoughtful, Timeless, Refined'; a gifting voice ('the personal story behind each gift').

Its 14 clientContextDocs (all version 1, created 2026-07-21 at 12:40 UTC) describe two different businesses:
- product-information, brand-voice, branding-guidelines and client-guidelines describe 'Kindly Yours & Co.' at kindlyyours.co. That domain is cited 42, 5, 3 and 41 times respectively, and client-guidelines says 'The live website is kindlyyours.co'.
- market-strategy, competitor-analysis and action-plan describe the Walmart intimates brand at thisiskindly.com (walmart.com appears 26 times in market-strategy).
- target-audience mixes both.

How the engine read it:
- No per-document context files exist for this client, so the engine read the knowledge mirror, which prefers the client tier (portal src/lib/agent-engine/knowledge-sync.ts:75-77; engine packages/tools/karos-client/src/get-context-doc.ts:119-160). Evidence: 02i1 starts with the client-tier heading '## 2. What It Does'.
- The brief step 00b1 fetched the website's /, /about and /pricing (client-brief.ts:1033-1052). All three returned 'kindlyyours.com is for sale — Buy for $4,999, Lease, or Offer | GoDaddy'.
- buildBriefAgentInput accepts any non-empty page as a `site` source (client-brief.ts:935-942), and `site` counts as grounding (:322-324). 00b3 then added the for-sale pages to the brief's sources on its own.
- The brief (instagram-brief@1, written 2026-09-23 21:20 UTC by run pubsub-21774365812455041) chose the gifting business. It is stored for 30 days at clients/kindlyyours/brief/instagram-brief.json (packages/tools/karos-client/src/brief.ts:70-74), and both 2026-09-24 runs reused it.

**Root causes**

- **'X is not Y. It is Z.', 'Not X.' and 'X, not Y' have become the house voice. This is the owner's 'sounds like AI'.**
  - Cause: Four stages teach and reward the shape, all added on 2026-09-13 (prompt v17 and the new 07i gate):
- the angle prompt's rememberLine example and wrong-assumption framing (instagram-angle/latest.md:15-16, 34-35), with verbatim reuse required on the cover or closer (instagram-copy/latest.md:933-937)
- the copy prompt's own examples (latest.md:1442-1466, 1487-1489, 1356-1359)
- 07i coverTension, which counts negation as tension and prescribes the shape in its refusal text (value-signals.ts:384-389, 419)
- the value judge's position example and PASS cover (value-gate.ts:340, 369-371).
Nothing names the shape as a tell (latest.md:640-657).
  - Evidence: Before and after the change:
- English posts containing 'Not X.' or 'X is not Y. It is Z.': 4 of 28 (14%) before 2026-09-13, 8 of 11 (73%) from 09-13 to 09-19, 26 of 39 (67%) since 09-20.
- Counting ', not X' tails as well: 33 of 51 posts since 09-20.
- 34 of 51 chosen rememberLines contain a negation.
- After a coverTension refusal, 14 of 27 shipped covers carry a negation, against 7 of 24 in runs without one.

Examples from the 8 runs:
- Karos A (pubsub-21254982994413907): 07i refused 'Wrapped works because everyone queries the same record' (attempt 1) and 'Half a billion shares. No agency brief.' (attempt 2; the spelled-out number does not count). It shipped 'Wrapped is not Spotify's best campaign. It is Spotify's best data decision.', slide 2 'Wrapped's distribution is not creative. It is structural.' and the caption 'Spotify Wrapped is not a campaign. It is a data architecture…'.
- Karos B slide 4: 'That asymmetry is not a limitation. It is the architecture.'
- Kindly cover and closer: 'A personal touch is not the finishing detail.' and 'A personal touch is not what you add at the end. It is how you decide what the experience is for.' (the angle's rememberLine, verbatim).
- XO slide 6: 'O teto não era de capacidade. Era de regra.'
- Hanky Panky: 07i refused 'The lace didn't fail you.', and the cover shipped as 'Lace didn't fail you. A $10 shortcut did.'
- **Fragments and staccato: sentences without verbs, lists of nouns set as sentences, label headlines, and open-ended one-line endings.**
  - Cause: The prompt optimises for short and punchy under a word cap but never requires a subject and a verb (latest.md:56-61, 149, 152-159, 1482-1489; 0 hits for 'complete sentence'). No gate checks whether a sentence is complete, and the judge is told not to judge fluency (value-gate.ts:361).
  - Evidence: Across the 51 posts since 09-20:
- 19 carry a 'Not X.' fragment
- 11 carry a run of three or more sentences of four words or fewer
- 19 of 51 captions contain lines without a verb.

Examples from the 8 runs:
- Kindly slide 3 'Not sentiment. A specific act of memory.' and slide 7 'Not a catalog.'
- Karos B slide 3 'No scope. No autonomy level. No named supervisor.'
- Karos A slide 4 'Same campaign. Five times the data. Costs fell twenty-five percent. The architecture changed. The creative did not.', slide 3 'One decision.', and the caption 'Product. Data science. Marketing. One source of truth.'
- Hanky Panky slide 7 headline 'Before coffee. Every day.'
- The Pitch slide 2 'No manual workaround, no real pain' and slide 4 'Why it exists, who it serves, what decision it improves.'
- Sitti slide 5 'Four weeks, 10 to 20% of your content.'
- Geektime subtitle '12 וובינרים, 4 אירועים פיזיים. עם מיקרוסופט.'

Open-ended endings:
- Karos B slide 1 'There is a difference.'
- Karos B closer 'The gate only works if someone reads it'. The word 'gate' is never introduced.
- Karos A closer 'The architecture is the campaign'.
- **Pronouns with nothing to point to, and slide 2 continuing slide 1 instead of standing alone.**
  - Cause: §7's rule that slide 2 is a second cover (latest.md:570) has no check. Separately, code moves the first sentence of a body into a device label, which can leave a body that opens on a pronoun (bounded-object.ts:476-490, 560-600).
  - Evidence: - Sitti slide 2: 'There's a scoring matrix for this.'
- Karos B slide 5 body: 'They use AI as an assistant.'
- Karos A slide 5: 'That is what a unified record produces…'
- Hanky Panky slide 6: the writer's body was 'That step is where stretch settles and hand feel locks in. Skip it, and the itch follows.' It shipped as a device '24' (the unit 'hours' is gone) labelled 'That step is where…', with the body reduced to 'Skip it, and the itch follows.'
- **Code rewrites or cuts copy after every language gate has already passed it.**
  - Cause: Five pieces of assembly-time surgery:
- composeBoundedObjects splices the figure out of its sentence (bounded-object.ts:316-336) and lifts that sentence out of the body (:560-600)
- the recap strip's cutAtWord adds '…' (slides-data.ts:1218-1235)
- #243's trim reads the declared layout, not the resolved one (slides-data.ts:1153-1158, 2995 vs 3009)
- repairDashes turns paired dashes into comma chains (mechanical-repair.ts:114-121)
- the merge appends a slide's headline and body to its neighbour's body, even when the neighbour is a quote_card (workflow:13132-13133).
The alt-text packager reads copy fields rather than rendered text (workflow:13959).
  - Evidence: - XO slide 7: the writer's body 'Autorizada pela CVM (Ato Declaratório 23.290), a plataforma oferece crédito privado tokenizado a partir de R$ 100. O novo limite vale aqui.' shipped as a device '23.290' (a registration number), a label 'Autorizada pela CVM (Ato Declaratório ), a plataforma oferece crédito privado', and a body 'O novo limite vale aqui.'
- 30 of 51 closers carry a truncated recap strip, for example Kindly's 'A personal touch is not the finishing…'.
- Kindly: step 08a1b merged slide 6 into the slide-5 quote card, which renders neither headline nor body. 'Most wedding designs are built around aesthetics…' vanished from the post, yet the 08c alt text still describes it (n5 'Memory is the point…').
- Kindly slide 8 after 05m: 'Which detail, the favor, the place card, the welcome kit, would you design…'
- Replaying #243 on the 8 runs' final copy cuts 4 of 42 interior bodies. Karos A slide 4 loses 'The creative did not.' Sitti slide 5 (declared quote_card, rendered headline_focus) would keep only the fragment 'Four weeks, 10 to 20% of your content.'
- **The retry budget is spent on the free value floor, so the readability checks never steer a rewrite, and each attempt fixes only one finding.**
  - Cause: 07i runs before assembly and returns on its first refusal (workflow:11295-11318; value-signals.ts:573-583). 07h2 depends on the 07c assembly, so it runs only when everything before it has passed (workflow:12541, 12689-12712). On the final attempt a gate only records.
  - Evidence: Across 51 runs:
- 50 reached attempt 3
- 07i refused 84 times
- 07h2 ran only on the final attempt in 48 runs and waived findings in 33
- the judge ran only on the final attempt in 40.

In the 8 runs, 07c and 07h2 ran only on attempt 3 in all 7 carousels. Over-budget slides that shipped:
- Kindly slide 5 (32 words), slide 6 (31), slide 8 (55)
- Karos A slide 4 (70)
- Karos B slide 2 (68), slide 4 (70)
- Hanky Panky slide 3 (33)
- Sitti slide 6 (31), slide 8 (31)
- XO slide 2 (31), slide 3 (32).
- **The minimal-edit reviser bolts copy onto slides to satisfy counters, and on the last attempt it can add banned language that ships anyway.**
  - Cause: The revise prompt optimises for the fewest fields changed and the same length (instagram-copy-revise/latest.md:6-8, 54-56), without the §10 rules, the §24.3 banned phrases or the brand voice. checkNamedSpecifics counts the brief's core terms and tells the writer to put a figure on a slide (value-signals.ts:349-370). Findings arrive one gate at a time.
  - Evidence: - Kindly: 05r attempt 2 appended 'The place card, the favor, the welcome kit: those are the details that last.' Attempt 3 added 'Not a catalog. The discovery consultation asks about…'. Both edits give the same reason: 'brings the named-specific count from 2 to 3'.
- Geektime run pubsub-21702508956715687: 05r attempt 3, answering the closer-carries-cta rule, appended 'מה זה אומר לעתיד אפל? ספרו לנו בתגובות.' ('tell us in the comments'), a banned phrase. 07b attempt 3 refused it, but the final attempt only records, so it shipped.
- **Gates judge text that is never shown and miss text that is. The value judge has no length or output limit.**
  - Cause: - The judge's input carries only the copy's headline and body (value-gate.ts:496-507). A stat_callout renders figure, subLabel and body; a quote_card renders the quote and attribution; a list_takeaway renders the headline and rows (slides-data.ts:2129-2190).
- checkRhythm reads headlines that never render and counts articles as first words (value-signals.ts:525-545).
- The craft gate's slideProse skips stat labels, quotes, list rows, comparison columns and device labels (craft-hygiene.ts:203-210).
- Judge quotes have no length cap (value-gate.ts:598-603) and the judge has no maxTokens (:783-797).
  - Evidence: - Kindly 07i attempt 3 refused 'three consecutive X is Y headlines', counting the quote-card headline 'Memory is the point.', which never renders.
- XO attempt 3 refused 'slides 1, 2, 7, 8 all open with the word "a"'. That is the Portuguese article.
- Judge position quotes ran to 1,650 characters (Karos B), 2,215 (Kindly) and 3,174 (Sitti attempt 2): in effect the whole post.
- The Geektime and XO judge calls hit the 32,768-token output limit (49,122 and 49,124 tokens; $0.2019 and $0.1994; 179 and 211 seconds), returned a tooling error and left both posts unjudged.
- Judge spend on the 8 runs was $0.61, against 9 × $0.003 budgeted.
- **Closer lines are overloaded, and sentences repeat between the cover and the closer.**
  - Cause: The copy schema has no separate cta or question field for the closer, so the whole body becomes the `question` when it contains a '?' (slides-data.ts:2252). The rememberLine must be reused 'verbatim or near-verbatim' (latest.md:933-937), and the angle prompt suggests the cover or the closer (instagram-angle/latest.md:37-38).
  - Evidence: - Kindly slide 8's question field: 'Book your complimentary discovery consultation. Tell us about your occasion and what it means. Which detail… started with the story?' (07h2 counted 55 words).
- 15 of 51 closers carry 2 to 4 sentences in the question or cta field.
- 10 of 51 posts repeat a sentence across slides. Sitti's closer cta repeats the cover subtitle verbatim: 'The rest of the criteria don't care how many followers you have.' Hanky Panky puts 'The process behind it did.' on both the cover and the closer.
- **Kindly Yours' posts are about a different company: wedding favours, a 'complimentary discovery consultation', and links to kindlyyours.co.**
  - Cause: - The portal record points at a parked domain.
- The July 2026 onboarding merged two businesses that share the name into one document set.
- The 2026-09-01 branding step (before the fix in 957f1f46) invented a gifting palette and voice.
- The engine brief read GoDaddy's for-sale page as the client's own site and picked the gifting half.
- The brief is then reused for 30 days.
  - Evidence: What the three domains are today:
- kindlyyours.com is parked for sale. The page redirects by script to /lander and on to forsale.godaddy.com/forsale/kindlyyours.com. Its nameservers are ns1/ns2.afternic.com; the registrar is Unstoppable Domains, created 2011.
- kindlyyours.co is a separate WordPress site for 'Kindly Yours & Co.': 'Elegant, heartfelt gifts … weddings, corporate events', with placeholder products ('Product Name 1 $-').
- thisiskindly.com returns Shopify's 'Store unavailable' (HTTP 402) today.

The lab profile describes the intimates brand: clients/kindlyyours/config.json has brand.category 'intimates' (Walmart since 2021, Amazon Wave 1); profile/product-information.md:27 gives the website as thisiskindly.com; profile/brand-voice.md:109 gives Instagram @teamkindly.

The engine brief (02i):
- its gaps say 'kindlyyours.com is currently parked for sale on GoDaddy' and that the market-strategy and competitor-analysis documents 'describe a sustainable women's intimates brand … not used', yet confidence is 'medium'
- its offers include 'Complimentary Discovery Consultation' with url kindlyyours.co
- its reference accounts are theknot, stylemepretty and 100layercake.

Downstream:
- 03g took the topic from an @theknot post.
- 07g relevance scored the post 5 out of 5.
- All 3 Kindly runs since 09-20 are about wedding favours.
- pubsub-21254987551616377's closer: 'Book your discovery consultation at kindlyyours.co.'
- 04e fed the 09-23 wedding post back as the client's own history.

Prod has no Kindly Instagram runs, but its client record and documents are identical to prep's.
- **No step anywhere checks that a website belongs to the client, and the lab import cannot repair this client as it stands.**
  - Cause: Every reader trusts client.website:
- the brief (client-brief.ts:909-942, 1033-1052)
- the intel report (agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.ts:405-440, which audits the site and searches '"name" industry domain')
- branding (portal src/lib/branding.ts:1053-1070; branding-site-palette.ts:381-405)
- the profile projection (context-doc-projection.ts:252).
Neither repo detects a parked, for-sale, unavailable or mismatched site (grep: 0 hits). No writer for client/voice-rules.json exists in either repo; only engine demo scripts write one.

scripts/import-lab-client.ts:
- reads top-level name and website from config.json (:326-330), which Kindly's config lacks
- defaults the category to 'Technology news & media' (:422)
- spreads the existing brandingGuidelines instead of replacing them (:400-415)
- skips document types that already exist (:459-490).
  - Evidence: Kindly Yours is the only client whose portal website disagrees with its lab config. Hanky Panky, XO Digital, Geektime, Sitti, Karos Labs, The Pitch, N°3 and Don Techno all match.

Running 'import-lab-client.ts kindlyyours --apply' as the script stands would:
- rename the client to 'kindlyyours'
- blank its website
- keep Plus Jakarta Sans, Inter and the gifting voice
- import zero documents, because all six types already exist.

**Proposed changes**

- [M] (C, H, I; agent-engine) New prompt version instagram-copy@32 with a section 'Sentences a person would say', plus rewrites of the sections that teach the negation habit.

The new rules:
(1) Every statement field (cover title and subtitle, headline, body, closer takeaway and action) is one or two complete sentences with a subject and a verb. Labels are allowed only in list rows, comparison, stat and device labels, and kickers.
(2) Say what is true, not what it is not. No 'X is not Y. It is Z.', no sentence that opens with 'Not', and at most one ', not X' tail per post.
(3) Never three short sentences in a row, never a list of nouns set as a sentence, and numbers go inside sentences.
(4) Every it, this, that or they has its noun on the same slide, and slide 2 names its subject.
(5) No one-line endings such as 'There is a difference.' or 'That is the architecture.'; name the actual thing.
(6) A plain-words list: avoid architecture, compound, structural, frictionless, seamless, unlock, elevate, landscape, journey, mechanism, foundation and 'the real X'.
(7) Word caps per field, so the text fits two type sizes: cover title 8, subtitle 12, interior headline 8, body 18 in at most 2 sentences, stat label 12, list row 7 plus a 10-word note, comparison column 12, closer takeaway 10, closer action 14, quote 20 words in whole sentences with no ellipsis. Cut words, never verbs.
(8) The closer's body is ONE action or ONE question.
(9) The rememberLine appears once, on the cover or the closer, and no sentence appears on two slides.

Rewrites of existing sections:
- Replace §25's correction shape and both dirty-coil examples (latest.md:1442-1466) with positive claims, for example 'Dirty condenser coils kill more walk-ins than age does.'
- Delete §24.2's 'turns in the middle' (:1356-1359).
- Delete §26's six-word headline rule and its 'not this. that.' (:1482-1489).
- §2 (:56-61): each caption line becomes a full sentence.
- §17 (:933-937): the rememberLine is used 'once, in your own words' instead of 'verbatim'.

Include before-and-after pairs from the 8 runs, and add a CHANGELOG entry with the cost note.
- [S] (C; agent-engine) New angle prompt instagram-angle@2.
- The rememberLine becomes one positive sentence of at most 16 words, with no not / isn't / didn't framing. This replaces the example at :34-35.
- The wrong-assumption angle states what the evidence shows as the claim; the belief it corrects goes in `notes` (:15-16).
- 'Near-verbatim on the cover or the closer' (:37-38) becomes 'once'.
- [S] (C; agent-engine) Change the 07i free value floor so it stops pushing the negation habit and stops charging for invisible text.
- coverTension no longer counts negation as tension: remove the markers at :388-389. It accepts numbers written as words ('half a billion', 'five times') and comparatives. Its refusal text (:417-419) asks for a positive claim that carries a figure or a name.
- checkRhythm skips articles and determiners in every language and reads only headlines that actually render (:525-545).
- checkNamedSpecifics' remedy (:368) becomes 'rewrite one existing sentence so it carries a card's figure; never append a list'. The brief's core terms stop counting while the brief's identity is unconfirmed.
- [S] (C; agent-engine) Change the 07j value judge and the alt-text packager to read what actually renders, and bound the judge.
- Both read the rendered text: assembled fields including stat labels, quotes, list rows, comparison columns and device labels (value-gate.ts:496-507; workflow:13959, 13990).
- Replace the position example and the PASS cover (:340, :369-371) with positive claims, and add: 'a position never needs a not-X, it-is-Y construction'.
- Cap each quote field at one sentence and 300 characters in the output schema, and downgrade any longer quote.
- Set maxTokens to about 2,500 (:783-797).
- Re-price the judge's cost estimate (STEP_COST_ESTIMATES_USD.valueJudge) from $0.003 to the measured figure (run-budget.ts:840); the 51 runs averaged about $0.048 a call.
- Bump VALUE_RUBRIC_VERSION.
- [M] (C, H, I; agent-engine) New deterministic lint, readable-copy.ts, run as step 07h3-readable-copy-attempt-N. It costs $0 and calls no model.

It reads the ASSEMBLED slides the way slide-word-budget.ts does (the same excluded field lists; list rows from `items`; device labels) plus the caption. Language packs are keyed through resolveExpectedScript: English is fully covered; Portuguese and Hebrew get the same shapes.

Rules that REFUSE (send the draft back on attempts 1 to n-1, record on the final attempt):
- L1: a sentence opening with Not, Não or לא, of 7 words or fewer, with no verb.
- L2: a negated sentence followed by one starting It/That/This/They plus a form of 'to be', or ending 'Z is.' or 'É Y.'.
- L3: two or more ', not X' tails in one post.
- L4: three consecutive sentences of 4 words or fewer on one slide.
- L5: a closer question longer than one sentence, a cta opening on And, But, So, E or Mas, or a closer over 30 words.
- L6: the same sentence on two slides (after normalising), or sentences of 5+ words with at least 0.7 word overlap.
- L7: slide 2 opening on a pronoun or conjunction, or any headline ending 'for this.'.
- L8: the per-field word caps from rule 7 of the prompt change.

Rules that only report to the judge and reviewer, and refuse at 3 or more per post:
- L9: a statement sentence with no verb (English verb list).
- L10: a label headline on a cover, photo, text_only, headline_focus or closer slide.
- L11: plain-words list hits and one-line endings.

L12 reports broken strings as code bugs, never charged to the writer: an ellipsis outside the middle of a quote, empty parentheses, or a device label under 3 words or ending on a preposition.

Prototype calibration on the 51 posts: L1 fires on 19 posts, L2 on 15, L3 on 5, L4 on 11, L5 on 15, L6 on 10. The repo's canonical good copy (GOOD_SLIDE_COPY, __tests__/test-helpers.ts:578-603) triggers only one ', not X', which L3 allows.
- [M] (C; agent-engine) Reorder the gates and send all findings in one pass.
- Right after 07b, build an uncheckpointed preview assembly (assembleSlidesData plus composeBoundedObjects, both pure) so 07h2 and 07h3 run BEFORE 07i on attempts 1 and 2.
- Collect every free finding of the attempt (07b, 07h2, 07h3, 07i) into one list for the reviser, instead of 'first refusal wins' (workflow:11238-11318, 12689-12712; value-signals.ts:573-583).
- Keep 07c as the checkpoint, and re-run 07h3 on it as the final record.
- [M] (C; agent-engine) New reviser prompt instagram-copy-revise@2, and changes to what the reviser receives.
- Give it rules 1 to 9 of the prompt change, the §24.3 banned phrases in English and Hebrew, and the brief's voice and forbidden claims.
- Instruct it: rewrite the whole sentence that carries the finding; never append a clause, a list or a question to satisfy a count; an edited slide must still read as complete sentences.
- Make comparison labels and bodies, device labels and kickers editable (copy-revision.ts:87-93, 175-188).
- Pass each slide's resolved layout, so the reviser knows which fields print.
- Inside the step, re-run 07b and 07h3 on the revision, the way applyNativeCorrections re-checks its patch, and discard edits that fail.
- [M] (C, I; agent-engine) Stop code from rewriting sentences after the gates.
- composeBoundedObjects builds a device only when its label passes the lint: no splicing inside parentheses, no identifier-like figures such as registration numbers, and the value keeps its unit. It never leaves a body that opens on a pronoun (bounded-object.ts:286-340, 476-600).
- #243's trim reads the RESOLVED layout (move withBodyBudget after resolveLayout, slides-data.ts:2995 and 3009) and becomes a final-attempt fallback only, with the kept text re-linted.
- The recap strip never prints '…'. It uses the figure or a short recap label the writer supplies, otherwise it omits the entry (slides-data.ts:1218-1235).
- repairDashes turns a pair of dashes around an aside into parentheses, not commas (mechanical-repair.ts:114-121).
- merge-into-neighbour merges only into slide types that render a body; otherwise the carried text goes into the caption (workflow:13132-13133).
- The closer gets separate cta and question fields in the copy schema (slides-data.ts:2252).
- [M] (B; agent-engine) Engine identity guard for the client brief.

A shared siteIdentity() check classifies every fetched website page:
- parked or for sale: title or text matching 'is for sale', 'buy now', 'make an offer' or 'lease to own'; GoDaddy, Afternic, Sedo, Dan, HugeDomains, Bodis or ParkingCrew hosts; a script or meta redirect to /lander
- unavailable: Shopify 'Store unavailable' or HTTP 402; any 4xx or 5xx
- mismatch: the page title, og:site_name or h1 lacks the client's name.

Step 00b1 runs it before buildBriefAgentInput. Pages that fail are dropped, never counted as `site` grounding (client-brief.ts:322-324, 935-942), and recorded as a typed gap.

A second deterministic check looks across the context documents at the domains each one calls the client's own ('Website:', 'canonical', 'web-observed: <domain>', minus third parties). Two or more distinct own domains, or none matching the profile's website and domains, is a conflict.

Either finding:
- writes identity: 'conflict' on the brief
- blocks the brief from being stored (packages/tools/karos-client/src/brief.ts)
- stops the run before topic selection (step 03), with a reason the reviewer can see. This is a deliberate hold: a post for the wrong company is worse than no post.

Also:
- New brief prompt instagram-brief@2: 'confirm the sources describe one business before writing any field' (prompts/instagram-brief/latest.md:38-40, 211-214).
- The intel report's site audit and client search (create-intel-report-agent-workflow.ts:405-440) use the same check.
- [M] (B; karos-portal) Portal identity guard and import hardening.
- Run the same site-identity check when a client's website is saved, before onboarding dispatch, and in the branding step (src/lib/branding.ts:1053-1070; observeSitePalette and observeSiteFonts in src/lib/branding-site-palette.ts:381-405). Store a websiteStatus on the client, and never extract a palette or fonts from a parked page.
- Flag in the admin setup ladder any client with an agentsRepoSlug whose lab profile exists while profileSource is not 'lab'.
- scripts/import-lab-client.ts:
  - refuse a config.json without a top-level name (:326-330)
  - require --category when the client has none (:422)
  - add --replace-docs to replace the existing context-doc rows (:459-490)
  - replace, rather than spread, brandingGuidelines when the lab supplies fonts and voice (:400-415).
- [S] (B; lab) In the lab, add a top-level "name": "Kindly Yours" and a "website" to clients/kindlyyours/config.json once the client confirms the canonical domain. The lab says thisiskindly.com, but its Shopify store currently shows 'Store unavailable'. Keep @teamkindly as the Instagram handle.
- [S] (B, C; data-fix) Kindly Yours data fix, prep first and then prod (client vj8pJxRGLtiN2YbBuPwR).
(1) Dry run, then delete the 14 context documents from 2026-07-21: 2cOp4wsOc671cIHP36Lw, TRJh6RseUR1qmCZwLKWV, iglwJiBgbQnSsRGu2piZ, BAi8n9x1Fw9bZhEjajOw, i6J0d5DIbzVIp93Mut6w, hMOc4wHko3b3EQ9Tj1WM, FRVbftulk7VNrh6UcLUi, LwwJpiG0UyQ76nYPNcSY, RnnfriznIC9zXJVFFP5w, lRbKITiNaJQMPCow1qj7, FEumee7DTAh8ehT4uSiN, a052HjAXTya7Drs01jVP, Oa9mpnC82llxO5RK7QWq, y6DrPT7vxCa7iuX6xoCf.
(2) Run FIRESTORE_DATABASE_ID=prep npx tsx scripts/import-lab-client.ts kindlyyours --category=<intimates> as a dry run, then with --apply. This imports the lab's 7 profile documents as internal and sets profileSource to 'lab'.
(3) Replace brandingGuidelines wholesale from the lab kit (Coral #F2805F, Sage #A0C9C3, Deep Sea #376A6C, Coral Digital #FF8548, Forest #026C62; GT Walsheim with the kit's fallbacks). Clear the gifting guidelines and tone keywords, set brandVoice from lab brand-voice.md, set the website and domains to the confirmed domain (or leave them empty), and set the industry to intimates.
(4) Regenerate the client-tier summaries, re-run projectClientToWorkspace and the knowledge sync, and overwrite clients/kindlyyours/client/voice-rules.json.
(5) Delete clients/kindlyyours/brief/instagram-brief.json, and any x or linkedin brief, in the prep workspace so the next run writes a fresh one.
(6) Reject pubsub-21254987551616377 at its gate. Void pubsub-21774365812455041 and pubsub-21255254988332367, including their ledger deliverable, performance, skeleton and cross-client rows, so steps 04e and 02k stop feeding wedding favours back in.
(7) Keep the 12 intimates competitors (SKIMS, Aerie, ThirdLove and others), or add the lab's tracking list as source 'lab'.

Re-run one Kindly Instagram run in a later round, not this one.

**Guards**

- readable-copy.test.ts: every shipped string quoted in this audit is a failing fixture: 'Not sentiment. A specific act of memory.'; 'No scope. No autonomy level. No named supervisor.'; 'Wrapped is not Spotify's best campaign. It is Spotify's best data decision.'; 'O teto não era de capacidade. Era de regra.'; Kindly's three-sentence closer question; Sitti's cover sentence repeated on the closer; Sitti slide 2's 'for this.'. The repo's GOOD_SLIDE_COPY must pass, with its single ', not X' allowed.
- A sweep test in the style of craft-hygiene.ts's 468-string sweep: commit the 51-post rendered-text fixture and pin each lint rule's hit counts, so any change to a pattern forces a re-measurement.
- A prompt-text test beside the existing dash rule (instagram-copy/latest.md:203-210): no prompt read by the angle, copy, revise or value-judge steps may contain 'is not the reason', 'not this. that.', 'dying of old age' or a 'not X. It is Y.' example. CI fails if one comes back.
- value-signals tests: coverTension passes 'Spotify's best campaign started as a data decision' and 'Half a billion shares came from one record' without any negation, and still refuses a flat category line. Rhythm ignores 'the', 'a' and Portuguese 'A', and ignores headlines that do not render.
- value-gate tests: a quote longer than one sentence or 300 characters is downgraded, the judge's agent config sets maxTokens, and the recorded 49k-token overflow cannot recur.
- Assembly tests:
- composeBoundedObjects never emits '( )' (XO slide 7 fixture) and never leaves a body that opens on a pronoun (Hanky Panky slide 6 fixture)
- recap strings never contain '…'
- trimToSentenceBudget reads the resolved layout (Sitti slide 5 fixture)
- merge-into-neighbour never targets a quote_card, stat_callout or list_takeaway
- the closer's question field holds one sentence
- alt text is built from rendered fields.
- Loop test: an attempt with both a coverTension refusal and a word-budget overflow sends ONE revision request that names both, and the 05r output is re-linted before it can ship.
- Site-identity tests with the captured pages: the GoDaddy page titled 'kindlyyours.com is for sale — Buy for $4,999, Lease, or Offer | GoDaddy' classifies as parked; Shopify 'Store unavailable' (402) as unavailable. buildBriefAgentInput leaves both out of its grounding sources. A document set that gives the client's site as both kindlyyours.co and thisiskindly.com is an identity conflict: no brief is stored and the run stops before topic selection.
- import-lab-client tests: a config without a top-level name is refused; --replace-docs replaces the six document types; fonts and voice supplied by the lab replace, rather than spread over, the existing brandingGuidelines.
- Nightly portal data check: for every client with an agentsRepoSlug, compare the portal website host with the lab config website host and run the site-identity check. Today only Kindly Yours fails.
- Reusable scratch artifacts (read-only prototypes): /private/tmp/claude-501/-Users-albertkattan-Code-karos-portal--claude-worktrees-xenodochial-galileo-1ba67f/c2b0d13c-4180-4c4d-b89a-2bd0ec24b593/scratchpad/copy-audit/copy-lint.cjs (prototype lint), corpus.json (rendered text of 51 posts), corpus-early.json (94 posts back to 2026-08-20), harvest-corpus.cjs, thresholds.cjs, simulate-243.cjs, loop-stats.cjs, cover-after-refusal.cjs, angles.cjs, ky-client.cjs, ky-doc-grep.cjs.

**Risks**

- Shipping the lint before the prompt and gate changes would refuse about 39 of 51 posts and burn attempts the way 07i does now. Land prompt v32, angle v2 and the value-floor and judge edits first, run the lint in report-only mode for a week of prep runs, and only then let it refuse.
- The English verb list in the prototype (about 550 verbs) wrongly flags roughly one 'verbless' sentence in five, for example 'Brand websites trail at 9%.'. Keep the verbless and label-headline rules as reports or behind a threshold of 3, and grow the list from the corpus.
- Removing negation from coverTension may lower 07j 'position' passes until the judge's examples change in the same PR.
- Portuguese and Hebrew get only the high-precision shapes. 'לא X אלא Y' is idiomatic Hebrew, so a native reader should review the Hebrew pack before it refuses anything.
- The identity guard deliberately stops runs. Clients whose site legitimately lives on another domain (The Pitch under deel.com, Kirsh on wixsite) must be listed in the client's domains so the check does not stop them.
- Kindly's canonical domain is unconfirmed: thisiskindly.com's Shopify store is unavailable and kindlyyours.com is for sale. With the website left empty, the brief counts as thinly grounded (relevance floor 2) until the client answers.
- import-lab-client uploads the logo to a slug-keyed path in the shared bucket. Importing into prep and then prod can leave the first record's logo URL on a stale token (see the script's header); run repair-stale-lab-import-tokens.ts afterwards, or import prod first.
- Voiding the three wedding posts rewrites run history. Prefer reject or void markers over deleting ledger rows.
- Moving the judge from copy headline and body to rendered text changes what the rubric measures. Bump VALUE_RUBRIC_VERSION so telemetry from the two eras is not mixed.
