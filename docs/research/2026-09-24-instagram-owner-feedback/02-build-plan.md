# Build plan: one agent-engine branch, thirteen workstreams

Branch: `agent-engine `feat/instagram-owner-feedback-2026-09-24`, cut from origin/main 2792638a (#247 is MERGED there, with #244/#248/#232; the scratchpad clone a65cdb8 and the local ae-build branch feat/instagram-feedback-2026-09-24 @0709bb8c are both behind and must be rebased onto 2792638a first). One commit series per workstream in the order below, never squashed, so Tomer can rebase or cherry-pick per commit; every workflow-file edit is a thin call site into a new module (tuning.ts, set-integrity.ts, readable-copy.ts, slide-graphics.ts, visual-mix.ts, design-language.ts) to keep the 16k-line create-instagram-agent-workflow.ts diff small. Only #249 and #250 are open on the engine (both RFC-26, outside the render path); WS-12 lands after they merge. Companion portal branch `feat/brand-contract-2026-09-24` (open portal #214 touches only asset-card/version-comparison/text-diff, no overlap). Spend rule from the owner is baked into WS-01: no cap ever stops a step mid-way; the run may overrun its $1.80 target up to a $5.00 allowance when the work is hard.`.

## Corrections applied after the drift review

- Run budgets are unchanged. The owner's "up to $5 is fine" was about research scraping, not production runs.
- No new holds. Always-deliver (RFC-14) stands. Anything the plan called a hold becomes a visible gate finding.
- No commercial font files (Bagoss, Relais, Fabriga, GT Walsheim) are committed. Test fixtures use OFL fonts only.
- #244 (framed hero) and #246 (generated-frames floor) are not reversed until the owner decides (see decisions).
- Tomer's #249 and #250 (RFC-26 exemplar harvest and judge) are his. WS-12 consumes them after they merge.

## Workstreams

### WS-01 Base: parameter registry (L1/L2/L3), finish-what-you-start spend policy, RFC-27 stub

Letters: N, L, C, H, M · Size: S · Depends on: none

**Changes**

- New agents/instagram-agent/src/workflow/tuning.ts: ONE typed table for every named parameter this branch introduces (cover/interior word caps, H/T/S/F sizes and floors, title:subtitle ratio, logo area and caps, scrim band, photo/graphic mix bands, distinctness thresholds, dHash distance, AI-frame caps, hold flags) with defaults equal to today's values, resolved L1 platform -> L2 industry -> L3 client (client field instagramTuning); the parallel Instagram study lands as data in this table, never as code.
- Spend policy (owner's verbatim rule): TARGET_RUN_SPEND_USD 1.8 stays a report line; add RUN_OVERAGE_ALLOWANCE_USD = 5.0 (tunable) as the ONLY hard ceiling; posture 'cheapest-path' (today skips vision inspection, the value judge, the visual-QA call and 07k returns past MAX_RUN_SPEND_USD 2.6) may engage only above the allowance and only at a step boundary; a started step (scrape, render, judge, vet) always finishes and records; the setup meter (MAX_SETUP_SPEND_USD 3.0) gets the same allowance so the new capture steps never stop mid-way; every crossing is a gate-payload note, not a hold.
- docs/RFC-27-instagram-owner-feedback-2026-09-24.md stub: owner letters A-N -> consequence -> workstream -> guard (filled by WS-13); register any new env read in scripts/config-inventory.

**Files**

- agents/instagram-agent/src/workflow/tuning.ts (new)
- agents/instagram-agent/src/workflow/run-budget.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (posture reads at 6874, 9535, 11771, 12758, 13341, 13628, 13757, 14085)
- docs/RFC-27-instagram-owner-feedback-2026-09-24.md (new)
- scripts/config-inventory.ts (registration only)

**Tests and guards**

- tuning.test.ts: defaults equal today's constants (BODY_WORD_BUDGET, TYPE_SCALE_PX, MIN_PICTURE_SLIDES, GENERATED_IMAGES_PER_RUN_CAP...); L3 overrides L2 overrides L1; unknown keys refused; every key has a unit and a doc line.
- run-budget.test.ts: a meter at $2.61-$4.99 never reports 'cheapest-path'; posture cannot change between a step's start and its record; allowance crossing produces a note and no hold; setup meter same.
- Existing budget tests (run-budget, interest-floor-step #247 rounds) updated, all with the fake router (no model).

**Overlap with open PRs:** None open. run-budget.ts and the relayout loop were touched by #247 (merged) - rebase base only.

### WS-02 Fonts: typography roles, real @font-face loading, role-only templates, painted-font guard

Letters: A, C · Size: L · Depends on: WS-01

**Changes**

- brand.json typography contract read by karos-client get-brand.ts and deriveBrandRenderTokens: roles display/body/label/figures, each with family, weights/styles, source (upload|lab-kit|google|substitute), https file URLs + sha256, numeric variant, status, projectedAt/projectedBy; --f-mono/--f-label no longer config-only (brand-render-tokens.ts:780); a rejected or unloadable name is reported, never dropped (:133-136).
- Load faces as first-party @font-face rules with explicit weight/style descriptors: binaries fetched once per run from projected URLs or Google's static files for the exact weights, cached and embedded as data URIs like the logo (workflow ~2620-2660); replaces bare css2 links (:1040-1074; script-fonts.ts:279-291); font-synthesis:none in the design system; one resolver shared with branded-shorts derive-brand-setup.ts.
- Templates, devices and the studio shell name ROLES only: drop Fraunces/Inter/IBM Plex Mono defaults (_design-system.css:85-96, safety.ts:254-265); eyebrow/kicker/badge/handle/pagination/source/note -> var(--f-label); every numeral -> var(--f-figures) + font-variant-numeric var(--num-variant) (.num-figure gets a rule; .dv-figure, .dv-bar-value, .dv-tl-at, .dv-st-value/label, recap figures, counters); device sources/notes -> --f-label.
- The engine never chooses a face: registers keep weight/tracking/bleed only (remove REGISTER_DISPLAY_FONT_FAMILY / CONDENSED_DISPLAY_FONT_FAMILY and register links; weight snaps to one the brand ships); script faces fill only glyphs the brand face lacks and are flagged; IBM Plex Mono removed from Greek/Cyrillic rows; fallback stacks match the brand face's genre; badge style from the label role, not visualStyle.
- Painted-font guard in karos-publish render-carousel: after fonts.ready, CDP CSS.getPlatformFontsForNode on every text leaf -> fontsPainted{family,isCustomFont,glyphCount,selector} replacing the requested-name fontFamiliesUsed (:780-782; slide-metrics.ts:547); with allowedFaces from the kit, refuse the slide (kind 'brand-font') on any system font, non-allowed family or synthesised weight; fix the false 'proves it loaded' claims (render-carousel :531, interest-floor :168/:182, emphasis-marks :1296), template-studio gate 8, and karos-landing render-page-tool's fonts.check; non-alphanumeric glyphs allowlisted from the cmap. TOOL_VERSION bump.
- Workflow: 02c records typography provenance/status/projectedAt; Instagram holds a kit with no typography or no projectedBy with a staff-facing reason behind tuning FONT_HOLD_ENABLED (off until data fix D1 lands, then on; covers the seeded sitti/hankypanky/kindlyyours kits and the kitless path at :2770); 08 passes allowedFaces; gate payload lists painted faces per role and flagged substitutes.

**Files**

- agents/instagram-agent/src/workflow/brand-render-tokens.ts
- agents/instagram-agent/src/workflow/script-fonts.ts
- agents/instagram-agent/src/workflow/visual-system.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts
- agents/instagram-agent/src/workflow/types.ts
- agents/instagram-agent/assets/templates/default/_design-system.css (+8 plates via scripts/sync-design-system.ts)
- agents/instagram-agent/assets/templates/default/stat-callout.html
- agents/instagram-agent/src/workflow/slide-devices.ts
- packages/tools/karos-templates/src/safety.ts
- packages/tools/karos-client/src/get-brand.ts
- packages/tools/karos-publish/src/render-carousel.ts
- packages/tools/karos-publish/src/slide-metrics.ts
- agents/instagram-agent/src/workflow/interest-floor.ts
- agents/instagram-agent/src/workflow/template-studio.ts
- agents/instagram-agent/src/workflow/emphasis-marks.ts
- packages/tools/karos-landing/src/render/render-page-tool.ts
- agents/branded-shorts-agent/src/workflow/derive-brand-setup.ts
- agents/instagram-agent/__tests__/fixtures/typography/* (7 client kits + font files, new)

**Tests and guards**

- Static (extend design-system-sync.test.ts, default-template-render.test.ts): no family literal ('Fraunces','Inter','IBM Plex Mono','Oswald','Space Grotesk','Heebo'...) in _design-system.css, the 8 plates, safety.ts, visual-system register stacks or the Latin rows of script-fonts.ts; every var(--f-*) a template reads is emitted by the brand head with an @font-face.
- Chromium sweep (Playwright, no network: fonts from __tests__/fixtures): 7 real client kits incl. Hebrew Open Sans x 8 plates -> painted families == kit roles, figures and source lines on their roles; must FAIL on today's main (DejaVu mono, Georgia-for-Bagoss, Heebo on geektime, faux-bold Spectral); each check broken once on purpose in a reverted commit.
- Weight guard: every leaf's computed weight/style is covered by a loaded FontFace; synthetic bold impossible with font-synthesis:none.
- Probe-semantics test: a declared-but-unloaded family (e.g. 'BagossCondensedFont') is reported as the painted fallback, and document.fonts.check's true is never trusted.
- Cross-repo contract test: one typography fixture produced by portal toProjectedBrand parsed by deriveBrandRenderTokens (roles, files, weights, status), registered in portal engine-field-contract.ts.
- Catalog check: a 'google' source must exist in the public catalog; /l/font?kit= (Georgia, Helvetica Neue) rejected.

**Overlap with open PRs:** None open (#249/#250 never touch the font path). interest-floor-calibration and mark-hero tests changed by #244 (merged) - rebase.

### WS-03 Site identity guard for briefs, captures and intel

Letters: B · Size: M · Depends on: WS-01

**Changes**

- Shared packages/tools/karos-research/src/site-identity.ts classifier: parked/for-sale (title/text 'is for sale', 'make an offer', GoDaddy/Afternic/Sedo/Dan/HugeDomains/Bodis/ParkingCrew hosts, script/meta redirect to /lander), unavailable (Shopify 'Store unavailable', HTTP 402, any 4xx/5xx), challenge (Cloudflare 'Just a moment'), mismatch (title/og:site_name/h1 lacks the client name unless client.domains lists the host).
- 00b1 runs it before buildBriefAgentInput: failing pages are dropped, never counted as `site` grounding (client-brief.ts:322-324, 935-942), recorded as a typed gap; a cross-document own-domain conflict (two distinct own domains, or none matching the profile) writes identity:'conflict', blocks brief storage (karos-client brief.ts) and holds the run before 03 with a reviewer-visible reason (a post for the wrong company is worse than no post).
- instagram-brief@2: confirm the sources describe one business before writing any field; intel-report site audit and client search (01) use the same check; WS-04's capture validity gate reuses it.

**Files**

- packages/tools/karos-research/src/site-identity.ts (new)
- packages/tools/karos-research/src/index.ts
- agents/instagram-agent/src/workflow/client-brief.ts
- packages/tools/karos-client/src/brief.ts
- agents/instagram-agent/prompts/instagram-brief/2.md + latest.md, scripts/prompt-registry.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts
- agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.ts

**Tests and guards**

- site-identity.test.ts on captured pages: GoDaddy 'kindlyyours.com is for sale' -> parked; Shopify 402 -> unavailable; Cloudflare challenge -> challenge; deel.com/the-pitch-by-deel with domains allowlist -> ok.
- client-brief.test.ts: buildBriefAgentInput leaves parked/unavailable pages out of grounding; a doc set naming kindlyyours.co and thisiskindly.com -> conflict, no brief stored, run stops before topic selection (runToGate with fake router).
- check:prompts registry drift passes with @2.

**Overlap with open PRs:** #249 edits packages/tools/karos-research/src/index.ts (adds instagram-exemplars exports) - append the new export on its own trailing line so the rebase is trivial.

### WS-04 Design-language capture: engine-owned measurement of the client's site, stored with provenance

Letters: B, D, M, A · Size: L · Depends on: WS-01, WS-03

**Changes**

- New tool media.captureDesignLanguage (Chromium already in the agent-server image; injectable launcher like screenshot-page.ts:30-67): home + up to 2 own pages at 1440x900 and 390x844, document.fonts.ready, one scroll, consent/chat/third-party subtrees excluded, computed styles only -> type roles + size histogram, loaded font faces with file URLs from the network log (next/font aliases normalised), colour usage by role weighted by area (third-party/framework tables moved from portal branding-site-palette.ts:142-198), buttons/pills/chips, cards (fill, border, radius, shadow), inputs, tables + tabular-nums, numerals, icons (line/solid, stroke, caps), image framing, dividers, gradients (surface vs ambient), section grounds, alignment; screenshots to the media bucket; validity gate = WS-03 classifier + blank-render check; landing.captureSite shares the extractor.
- One engine-owned document per client clients/<slug>/client/design-language.json + append-only vNNNN history via client.getDesignLanguage/writeDesignLanguage (mirrors getBrief/writeBrief) - NOT inside brand.json, which the portal rewrites before dispatch; every field carries provenance stated|measured|inferred|default; the capture writes only measured/inferred so a stated field (Kindly, Deel's purple social kit, XO's D5) is never overwritten; render precedence renderTokens > stated > measured > vision > fleet default; conflicts with brand.json recorded; a brand.json font equal to an extractor fallback name and absent from a valid capture is treated as unset.
- Setup steps before 00c: 00f-check-design-language (90-day TTL, refreshDesignLanguage flag, failure backoff), 00f1-capture, 00f2-describe (one Flash vision look over <=4 screenshots naming signature devices/layout/icon style, every line citing a measured component or screenshot region, else gaps), 00f3-persist; render reads it through a new checkpointed 02c2-load-design-language so 02c's checkpoint shape is unchanged; setup meter line ~$0.005; fail-open (blocked site -> gap, never a hold).
- Optional 01j-capture-design-language in intel-report beside 01f/01h so the language exists at onboarding; 01h competitor pages get the same capture (feeds WS-12).
- scripts/report-design-language.ts fleet report: capture status/age/validity, kit-vs-site conflicts, missing tokens; added to the promote checklist.

**Files**

- packages/tools/karos-media/src/design-language/{extract,derive,schema}.ts (new)
- packages/tools/karos-media/src/capture-design-language.ts (new)
- packages/tools/karos-media/src/index.ts
- packages/tools/karos-landing/src/capture/capture-site-tool.ts
- apps/agent-server/src/wiring/tools.ts
- packages/tools/__tests__/cross-cutting.test.ts (tool-registry pin)
- packages/tools/karos-client/src/design-language.ts (new) + index.ts
- agents/instagram-agent/src/workflow/design-language.ts (new)
- agents/instagram-agent/src/workflow/types.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts
- agents/instagram-agent/src/workflow/run-budget.ts
- agents/instagram-agent/src/agent/instagram-design-language-agent.ts + prompts/instagram-design-language/1.md (new)
- agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.ts
- scripts/report-design-language.ts (new)

**Tests and guards**

- derive.test.ts on recorded captures (saved HTML/CSS under fixtures, Chromium offline): karoslabs radius {6}, transparent cards + #34343b hairlines, accent as text only; deel 200px pills + flat bordered cards + Bagoss; sitti Gaegu + coral pills; xodigital #25d366 excluded + next/font alias normalised; hankypanky Klaviyo/Shopify fonts excluded; Cloudflare/GoDaddy/closed-Shopify pages derive NO tokens.
- Byte-identity: a client with no design-language document composes byte-identical documents to main.
- resume-idempotency.test.ts: 00f*/02c2 checkpointed, 02c shape unchanged; fail-open test (capture timeout or bot wall never holds a run); setup meter line asserted.
- Vision step tested with the fake router: every describe line must carry an evidence reference or land in gaps.

**Overlap with open PRs:** #249 bumps the tool-registry pin in packages/tools/__tests__/cross-cutting.test.ts (69->70) and #250 edits packages/tools/karos-media/src/index.ts: on rebase take theirs, then re-add this tool's export and +1 the pin. Share one DesignLanguage schema with #249/#250's design DNA (source: kit|web|feed) - see WS-12.

### WS-05 Logo: one spec per client, background treatment, corner and size by rule, discovery demoted

Letters: E, F, G · Size: M · Depends on: WS-01

**Changes**

- ClientBrand.logo = BrandLogoSpec (sources[] with kind upload|lab|site|instagram-avatar, chosen + reason, variants onLight/onDark/mark, treatment background/recolor/onPhoto, placement corner/rule/box/inset, status, specHash, decidedAt); deriveBrandRenderTokens carries it; brandLogoCss sizes from the spec box instead of the 65px width clamp (equal visual area LOGO_AREA_PX2 default 4900, height floor max(32, brand min), width cap 240, height cap 96, inset 44 - all tuning) and picks the variant by the slide's ground; reserved zone = box + 16 instead of the fixed 132px square; planBrandLogo stays as a contrast check on the chosen variant; old brand.json without a logo object keeps working via logoUrl.
- Corner from the spec, never from the run: chooseCorner defaults top-start (top-left LTR, top-right RTL); top-end only by brand rule and then below Instagram's counter pill (block inset >= 112); delete the eyebrow/series-badge flip at workflow 2721-2723; studio (00c) and posts resolve the same corner.
- Discovery demoted: never runs when brand.json has a spec or any configured logo; a failed download renders NO logo and puts a named finding on the gate (never a scraped substitute); homepageUrlFor keeps the client's path (deel.com/the-pitch-by-deel is itself); a discovered candidate passes the same background/tile analysis, is reported site-unapproved and saved as a candidate; until a spec exists the engine derives ONE provisional spec per client and caches it in the workspace (like branded-shorts derive-brand-setup) so file, corner and size are stable run to run.
- Ink reader sees backgrounds: an opaque border-connected colour is background{hex,coverage}, contrast on ink alone, plan returns 'needs treatment' unless the spec keeps the background; currentColor SVGs resolved per variant, never placed unmeasured.
- Photo slides: measure the rendered pixels under the logo box in-page before the final screenshot (reuse the unused mark-placement.ts from #227), apply the spec's onPhoto rule (variant reaching 3:1 / brand plate / omit), record variant + ratio per slide.
- Gate: brandAsset carries source, specHash, variant, rendered box, background, per-slide photo ratio; verdictLine degraded marker (visible, never a hold) for site-unapproved, background-carrying, below-minimum or missing; the judge is no longer told legibility was verified in those cases; scripts/report-brand-logos.ts fleet check.

**Files**

- packages/tools/karos-client/src/get-brand.ts
- agents/instagram-agent/src/workflow/brand-render-tokens.ts
- agents/instagram-agent/src/workflow/visual-system.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts
- packages/tools/karos-media/src/brand-logo.ts
- agents/instagram-agent/src/workflow/logo-discovery.ts
- packages/tools/karos-publish/src/mark-placement.ts
- packages/tools/karos-publish/src/render-carousel.ts
- agents/instagram-agent/src/workflow/slides-data.ts
- agents/instagram-agent/src/workflow/visual-qa-pre-checks.ts
- agents/instagram-agent/src/workflow/gate-verdict.ts
- agents/instagram-agent/assets/templates/default/_design-system.css
- scripts/report-brand-logos.ts (new)

**Tests and guards**

- brand-logo-spec test: corner and box are a pure function of the spec - identical for the 00c studio render, eyebrow topical/none, badge on/off, 1- and 8-slide posts.
- Chromium: the .brand-logo box never intersects the counter-pill rect (38-107 x 38-130 css px at the top reading-end corner), LTR and RTL fixtures.
- Size on real assets: Hanky Panky 864x157 SVG >= 32px tall, a square mark 64-76px, every logo meets its spec minimum - fails on today's 64x12.
- brand-logo-contrast: an XO-like 1024x1024 opaque PNG with #F7F7F7 border reports a background and never 'place' (invert the assertion at brand-logo-contrast.test.ts:229); nested-tile fixture (Sitti) returns only the inner mark; busy background refused, never cut.
- logo-discovery.test.ts: deel.com/the-pitch-by-deel read as itself, the deel.com root logo never a candidate (replaces the path-dropping assertion at :62); a JS-redirect lander reports 'site unreadable'.
- Workflow test with a fetch spy: zero homepage fetches when a spec/configured logo exists, even when its download fails -> gate says 'upload unreachable', no logo rendered.
- Freshness: 02c records brand.json projectedAt + specHash and the gate flags a brand.json older than the spec's decidedAt in the run input; verdictLine marker tests.

**Overlap with open PRs:** None open (no open PR mentions 'logo'). Portal branch pbd-rebrand-portal-2026-09-17 (eb6d3fa3) wrote The Pitch's black lockup straight into prod and must be reconciled with the spec.

### WS-06 Type: one role scale (H/T/S + lone F), devices on the scale, fit ladder as a reported safety net, numerals in the brand face

Letters: C, A · Size: L · Depends on: WS-01, WS-02

**Changes**

- One role scale from one TS table (visual-system.ts) generated into the plates by sync-design-system.ts: H (every headline-like host), T (every reading host), S (eyebrow/kicker/source/handle/credit/indices), F = 1.5xH only when a figure is the plate's sole display element; sized per client by MEASURE (H where the display face sets ~18 chars/line, T ~38-40 chars of the body face, S 28 floor 26 - all tuning params) instead of a seeded flavour; delete the 66/94/200 duplicate and the side-split scale; flavour keeps weight/tracking only; .r-figure/.r-display/.r-statement/.r-lead/.r-label/.r-micro -> F/H/H/T/T/S.
- deviceCssBlock on the scale: figure F alone else H; labels/bodies/table values T; sources/notes/axis ends/dates S; drop the 200/150/108 char-count autosize (figureSizeClass); delete the shadowed .dv-figure/.dv-label rules; headline-focus ordinal at H or S, never above the claim.
- Fit ladder rewritten as a safety net: remove grow rungs; at most one shrink rung on the primary only (H -> 0.875H) with floors no rung crosses (H >= 0.85, T >= 44, S >= 26); fix _ds-fit.js:236 so undo runs only when grown < 0; data-fit-step reports the primary's rung; delete the data-fit=2 mappings that set headings at label and recap titles/notes at micro; a plate that still overflows is a COPY finding fixed by move-last-sentence-to-caption, never by smaller type.
- Free re-layout stops per-slide fontScale changes (interest-relayout.ts clipped/dead-space/text-wall remedies): clipped and text-wall move the last sentence to the caption or reassign the layout; dead-space uses object/photo/layout remedies; the reviewer's fontScale is one carousel-wide setting.
- Numerals: --f-num token (default --f-display; a brand may declare its own, e.g. JetBrains Mono for Karos) with lining tabular numerals on .num-figure, recap figures, .dv-figure, .hf-ordinal, list counters, recap indices, bar/table values, pagination; a client that declares no mono NEVER gets IBM Plex Mono (falls back to its body face). Same token WS-02 emits as --f-figures; WS-02 declares, WS-06 places.

**Files**

- agents/instagram-agent/src/workflow/visual-system.ts
- agents/instagram-agent/assets/templates/default/_design-system.css
- agents/instagram-agent/assets/templates/default/{cover,slide,headline-focus,stat-callout,list-takeaway,comparison-card,quote-card,closer}.html
- agents/instagram-agent/assets/templates/default/_ds-fit.js
- scripts/sync-design-system.ts
- agents/instagram-agent/src/workflow/script-fonts.ts
- agents/instagram-agent/src/workflow/slide-devices.ts
- agents/instagram-agent/src/workflow/interest-relayout.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (13156 apply site)
- agents/instagram-agent/src/workflow/slides-data.ts
- agents/instagram-agent/src/workflow/brand-render-tokens.ts
- agents/instagram-agent/src/workflow/interest-floor.ts

**Tests and guards**

- Composed-CSS lint: build every plate as production does (template + deviceCssBlock + visualSystemCssBlock + heroScrimCssBlock + brand head) and assert every font-size resolves to var(--t-head|--t-text|--t-source|--t-figure) - fails today on the slide-devices literals and the 84/124/220 vs 66/94/200 split.
- Single-source scale test: the generated plate block equals the TS table; a second scale cannot reappear (design-system-sync.test.ts).
- Chromium sweep 8 plates x short/long copy x en/he x each client face: fontSizeSteps subset of {H,T,S} (+F only on a lone figure), floors respected, <= 4 sizes per carousel; then arm TYPE_STEP_CEILING at 3 (interest-floor.ts:2021/2025).
- Fit-ladder render test from the audit harness cases (Pitch 3, Karos A 8): a step-0 overflow reports data-fit-step >= 1, no host ever grows, no host ends below its floor.
- Re-layout contract: planInterestRelayout never emits kind 'font-scale'; every slide of an assembled carousel shares one fontScale (interest-relayout-ladder.test.ts, #247's two-round path included).
- Numeral-face probe: fontsPainted for .num-figure, recap figures, .dv-figure, .hf-ordinal and counters equals the --f-num family; IBM Plex Mono never appears for a client that did not declare it.

**Overlap with open PRs:** None open. #247 (merged) loops the relayout twice - this workstream edits the remedy table it calls; #244 (merged) added framed-hero CSS to all 8 plates and calibration numbers in interest-floor-calibration.test.ts - rebase and re-measure.

### WS-07 Boxes and devices from the client's design language; decision layer and interest floor read measured tokens

Letters: D, C, I · Size: L · Depends on: WS-04, WS-06

**Changes**

- One .ds-box primitive reading --box-style (hairline|fill|tint|none), --box-fill, --box-line, --r-box, --r-pill, --r-media, --accent-budget, fed by the --dl-* tokens WS-04's brand head emits (renderTokens > stated > measured > default: 1px hairline, radius 6, no fill, NEVER an accent gradient); replaces the five hard-coded accent ramps (cover .cov-field, .num-zone, .cmp-cols, .quote-block, .cl-panel forms), the white comparison-logo disc, the news-frame whites and every literal radius; device fragments (versus bar, spec table, bars, timeline, recap tiles) read the same tokens; closer CTA = the client's primary button; logo chip uses the client's radius; --surface/--line/--fg2/--alt-ground either wired or deleted; the fleet rule becomes 'nothing the client's own site doesn't do'. Karos: transparent + 1px #34343b + 6px; Sitti #fff2bf + 1px #ffd86a + 16px; XO white + #d9e2ec + 16px; Deel 0 radius + cream hairline.
- Interest floor recalibrated to count a declared box's AREA (as COVER_OBJECT_BOX_SHARE does) so hairline boxes never bring the tinted fills back; hairline-only languages get devices from their own vocabulary (Karos marker band, paper CTA, figures, screenshot frames), not lowered floors.
- Decision layer reads the measured language: fallbackClientVisualSystem takes accentRole from measured accent roles and groundTexture from gradient/shadow use instead of adjectives and the slug hash (visual-system.ts:955-1038); pickVisualSystem drops catalogue entries the language forbids; 00c2/00c3 and 00d2 receive tokens + screenshots instead of page text; the Studio battery gets a vocabulary gate (radius in the client's scale, no foreign gradients/shadows, client fonts only); Studio varies tokens rather than authoring whole templates (all 8 runs stored none).

**Files**

- agents/instagram-agent/assets/templates/default/_design-system.css
- agents/instagram-agent/assets/templates/default/{cover,stat-callout,comparison-card,quote-card,closer}.html
- scripts/sync-design-system.ts
- agents/instagram-agent/src/workflow/slide-devices.ts
- agents/instagram-agent/src/workflow/brand-render-tokens.ts
- agents/instagram-agent/src/workflow/interest-floor.ts
- agents/instagram-agent/src/workflow/visual-system.ts
- agents/instagram-agent/src/workflow/template-studio.ts
- agents/instagram-agent/src/workflow/visual-direction.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (3045-3135, 3845)
- agents/instagram-agent/prompts/instagram-design-brief|instagram-template-designer|instagram-art-director (new versions + registry)

**Tests and guards**

- Template source scan (design-system-sync style): no literal radius, gradient, shadow, border or font-family in any panel/chip/CTA/label/figure/device selector unless var(--dl-*|--f-*|--box-*) with a fallback; sync --check stays in CI.
- Token-consumer contract: every custom property buildBrandHeadHtml emits has at least one reader - fails today on --surface/--line/--fg2/--alt-ground.
- Byte-identity: a client with no design-language document composes byte-identical documents to main.
- Karos fixture (hairline #34343B, radius 6, accent budget 5%): stat/comparison/closer boxes render as 1px hairlines and measured accent share <= 5% of the frame; no plate paints color-mix(var(--accent) N%) as a fill unless the language says tint.
- Chromium sweep fixture languages x 8 archetypes x {en,he}: interest floor passes with no threshold moved, probe.overflow false, conformance clean.
- checkDesignLanguageConformance fact (radius/border/background-image/box-shadow per bounded element from the extended probe) on the gate payload.

**Overlap with open PRs:** None open. Re-run #247's relayout calibration after the panel tokens move the pixels its clauses measure.

### WS-08 Full-bleed covers: caps, balanced sizes, anchored scrim measured per line, framing only as fallback

Letters: H, C · Size: M · Depends on: WS-01, WS-06

**Changes**

- Cover caps in tuning: title <= 8 words / 3 lines at H, deck optional <= 12 words / 2 lines at T and its first whole sentence only, cover total <= 20; interior headline <= 10 words / 3 lines, body within BODY_WORD_BUDGET and <= 6 lines; enforced pre-render in slide-word-budget as a $0 steer with a mechanical whole-sentence cut of the deck (refusal only on attempt 1), and post-render as line counts + copy block <= 50% of the frame on a poster; BODY_WORD_BUDGET gets a cover key; title:subtitle <= TITLE_SUBTITLE_RATIO (1.8) and the title never steps to figure size over a photo.
- Scrim rule for any text over a photo: the dense band (86-90% --bg) anchored one line above the MEASURED top of the copy (set in-page after the fit ladder's two font passes, before __CAROUSEL_READY__), easing to clear over ~15% of the frame; after render, each line box's p10 background vs --fg must reach 4.5:1 (requiredHeroScrim wired per line and armed as a finding); unreachable -> the free re-layout switches to the framed composition, never to smaller type; framedHeroFor's 10-word deck trigger (#244) replaced by this outcome so a capped poster like Sitti slide 1 stays full-bleed; eyebrow chip kept; a cover with no subject gets a badge/figure graphic (WS-11) rather than an unrelated picture.
- Prototype evidence carried into the tests: capped copy at 112/50px with the anchored scrim gives 5.7-16.6:1 p10 over worst-case bright and dark grounds (repro/proposal-measure-112.mjs).

**Files**

- agents/instagram-agent/src/workflow/slide-word-budget.ts
- agents/instagram-agent/src/workflow/slides-data.ts
- agents/instagram-agent/src/workflow/interest-floor.ts
- agents/instagram-agent/src/workflow/interest-relayout.ts
- agents/instagram-agent/assets/templates/default/_design-system.css
- agents/instagram-agent/assets/templates/default/cover.html
- agents/instagram-agent/assets/templates/default/slide.html
- agents/instagram-agent/assets/templates/default/_ds-fit.js
- agents/instagram-agent/src/workflow/style-lock.ts
- packages/tools/karos-publish/src/render-carousel.ts
- agents/instagram-agent/__tests__/framed-hero.test.ts

**Tests and guards**

- Cover-cap unit tests: XO's 11+19-word cover is refused/cut before render; Sitti's 8+12 passes with the deck cut to one sentence; render-time line-count check keeps the poster copy block <= 50%.
- Hero legibility Chromium test (repro/scrim-measure.mjs as template): a poster cover over synthetic bright and dark grounds clears 4.5:1 p10 behind every text line; finding's remedy is framing, never shrinking; extends mark-hero.test.ts beyond its bare '.scrim { display: none; }' string match.
- framed-hero.test.ts rewritten to the outcome trigger (capped poster stays full-bleed; unreachable contrast frames).
- Sequencing test: the scrim anchor runs after both font-load passes and before the ready flag, so the screenshot never captures a stale gradient.
- Visual QA receives fontSizeSteps, fitStep and per-line hero contrast so 'font-hierarchy' cannot pass a 1.00:1 set.

**Overlap with open PRs:** None open. Reverses the trigger of #244 (merged today on the owner's XO feedback) - owner sign-off requested; replaces #236's string-match guard with a measurement.

### WS-09 Set integrity: per-render object keys, safe merges, no lost words, no duplicate or same-point slides, series grammar

Letters: I, C, H · Size: L · Depends on: WS-01

**Changes**

- renderKey per render: objects at instagram/<client>/<postId>/<renderKey>/slide-<n>.png (and <outDir>/<renderKey>/ locally); default = sha256-12 of the slides data, the workflow passes the step id (resume-safe) at 08, 08-typographic, 08a1c and #247's -round-2 render; TOOL_VERSION 1.11.0 -> 1.12.0; path-pinning tests updated; deliverable and portal rehost already use explicit URLs.
- Merge only where its words will be seen: mergeRemedy's `into` must be photo/headline_focus/text_only and words(into.body)+carry must fit BODY_WORD_BUDGET; previous then next neighbour, else no merge and the ladder continues; new recorded fold-into-caption change (final attempt, respects slides_min, modelled on move-sentence-to-caption); the apply case verifies every carried sentence is in the candidate's fields or is rolled back; 08a1d also runs checkSlideWordBudget and checkDefaultRenderRules and discards a candidate that adds a failure.
- Final attempt: a plate 07h fails for no-image-means-device is FIXED pre-render (promote an unused vetted picture -> content-shaped archetype -> verbatim device -> fold-into-caption) instead of waived, then rendered once - removes the flag/waive/render/merge/delete chain behind 24 of 29 merges.
- set-integrity.ts (new, pure): measureSlidePng adds a 9x8 luminance-grid dHash + sha256 in the existing decode pass; checks exactly one cover at 0 and one closer at last, contiguous 1..N, unique paths/gcsUris, no duplicate sha256, no pair with dHash <= 6 AND text similarity >= 0.6, text coverage (every primary field per archetype + every merge carry is in the rendered document or the caption), OCR warn-only; runs as 08a1f after 08a1d (feeds the ladder) and again in 09b before ledger.writeDeliverable, where byte-identical plates, a second closer or a lost carry throw WorkflowToolingFailure.
- Alt text and the judge read what rendered: packager slides built from finalSlidesData fields (title/subtitle, figure/subLabel/sourceLine, quoteText/attribution, list items) not finalCopy headline/body; 08b gets intendedText per slide + the relayout plan; visual-QA prompt @6 §5 compares OCR to intendedText and §6.2 names any two slides making the same point; contact-sheet brief asks which slides look alike.
- Harmony in code: adjacency token = archetype + figurePlacement with the device suffix dropped, returned on attempts 1..n-1 at 07k and remedied by the free ladder on the final attempt (the_list exempt while device kinds alternate); slide-text-distinctness.ts at 07 (no sentence verbatim on two slides, headline pair >= 0.4 trigram, closer takeaway vs cover title >= 0.4, a figure on <= 2 plates, closer never repeats a recap figure, paraphrase question added to 07j); series grammar: headline_focus never directly follows quote_card or list_takeaway in the_breakdown/the_playbook/in_their_words; reconcile the headline_focus repeat exemption (#238) with the copy prompt.

**Files**

- packages/tools/karos-publish/src/render-carousel.ts + __tests__/render-carousel.test.ts
- packages/tools/karos-publish/src/slide-metrics.ts
- agents/instagram-agent/src/workflow/set-integrity.ts (new)
- agents/instagram-agent/src/workflow/interest-relayout.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (12645-12663, 13130-13151, 13215-13222, 13266-13280, 13990, 15298-15307)
- agents/instagram-agent/src/workflow/slides-data.ts
- agents/instagram-agent/src/workflow/skeleton-memory.ts
- agents/instagram-agent/src/workflow/slide-text-distinctness.ts (new)
- agents/instagram-agent/src/workflow/value-gate.ts
- agents/instagram-agent/src/workflow/editorial-series.ts
- agents/instagram-agent/src/agent/instagram-visual-qa-agent.ts + prompts/instagram-visual-qa/6.md
- agents/instagram-agent/src/agent/instagram-post-packager-agent.ts

**Tests and guards**

- render-carousel.test.ts: render 8 then 7 slides for one postId against a recording fake media store -> disjoint prefixes, no objectPath uploaded twice, no slide-8 in the 7-render.
- interest-floor-step.test.ts (runToGate, fake router): fixtures shaped like Kindly (quote_card@5 + thin headline_focus@6, final attempt) and Sitti (list_takeaway@4): delivered fields or caption contain the carry, rendered.length === slides.length, distinct gcsUris, exactly one closer.html at the last index - through #247's two rounds.
- interest-relayout-ladder property test over every archetype as `into`: never cover/quote_card/list_takeaway/stat_callout/comparison_card/closer, never over budget; the carry appears in assembleSlidesData(nextCopy) for every series and failing position.
- text-coverage fixtures from the two real relayout documents (Kindly slide 5, Sitti slide 4) must fail; set-integrity.test.ts: byte-identical Kindly 7/8 PNGs refused, Sitti near-identical closers refused, Pitch's 8 plates pass; 09b throws on a second closer, non-contiguous n or duplicate sha256.
- slide-text-distinctness on Sitti's final copy (cover subtitle == closer CTA; title vs slide 5 at 0.57); Kindly paraphrase (0.10) reaches the judge question; skeleton-memory adjacency (headline_focus+versus next to headline_focus is a finding; the_list alternating passes); editorial-series middle-order test; prompt/code once-per-carousel sync test; packager input test; 09b ledger invariant carries-lost == 0.

**Overlap with open PRs:** None open. #247 (merged) is the direct base: give its round-2 render its own renderKey and route its merge through the new guard, or a post can lose two slides and keep two orphans; #244 (merged) extended interest-relayout-ladder tests to build on.

### WS-10 Copy language: complete human sentences, no negation habit, readable-copy lint, one-pass findings, no post-gate surgery

Letters: C, H, I · Size: L · Depends on: WS-01, WS-09

**Changes**

- instagram-copy@32: new section 'Sentences a person would say' - every statement field is one or two complete sentences with a subject and a verb (labels only in list rows, comparison/stat/device labels, kickers); say what is true, not what it is not (no 'X is not Y. It is Z.', no sentence opening 'Not', <= 1 ', not X' tail per post); never three short sentences in a row or a noun list set as a sentence; every pronoun has its noun on the slide and slide 2 names its subject; no one-line endings; plain-words list; per-field word caps from tuning; the closer's body is ONE action or ONE question; rememberLine once, in the writer's words; no slide restates another; graphics vocabulary + removal of 'Photo-driven is the default' (from WS-11); rewrite §25/§24.2/§26/§2/§17 examples to positive claims; before/after pairs from the 8 runs; CHANGELOG + registry.
- instagram-angle@2: rememberLine = one positive sentence <= 16 words; the wrong-assumption angle states the evidence as the claim and puts the belief in notes; 'near-verbatim' -> 'once'.
- 07i free value floor: coverTension stops counting negation and accepts spelled-out numbers and comparatives, refusal text asks for a positive claim with a figure or name; checkRhythm skips articles/determiners in every language and reads only headlines that render; namedSpecifics remedy = rewrite one sentence, never append; brief core terms don't count while identity is unconfirmed.
- 07j value judge and the packager read the RENDERED fields (stat labels, quotes, list rows, comparison columns, device labels); positive examples replace the dirty-coil PASS cover; quote fields <= 1 sentence / 300 chars else downgraded; maxTokens ~2500; STEP_COST_ESTIMATES_USD.valueJudge re-priced from $0.003 to the measured ~$0.048; VALUE_RUBRIC_VERSION bump.
- readable-copy.ts, step 07h3 ($0, deterministic, language packs via resolveExpectedScript): L1 verbless 'Not/Nao/לא' openers <= 7 words; L2 negation followed by It/That/This/They + to-be or 'Z is.'; L3 >= 2 ', not X' tails; L4 three consecutive <= 4-word sentences; L5 closer question > 1 sentence / cta opening on And/But/So/E/Mas / closer > 30 words; L6 sentence reuse or >= 0.7 word overlap; L7 slide 2 opening on a pronoun/conjunction or a headline ending 'for this.'; L8 per-field caps; L9-L11 report-only (verbless statement, label headline on a statement slide, plain-words hits/one-line endings), refuse at >= 3; L12 code-bug reports (ellipsis, empty parentheses, device label < 3 words or ending on a preposition). Ships REPORT_ONLY (tuning) for a week of prep runs before refusing.
- Gate reorder: an uncheckpointed preview assembly (assembleSlidesData + composeBoundedObjects, pure) right after 07b so 07h2/07h3 run BEFORE 07i on attempts 1-2; all free findings of an attempt (07b, 07h2, 07h3, 07i) go to the reviser in one list instead of first-refusal-wins; 07c stays the checkpoint and 07h3 re-runs on it as the final record.
- instagram-copy-revise@2: receives rules 1-9, the §24.3 banned phrases (EN/HE), the brief's voice and forbidden claims and each slide's resolved layout; rewrites the whole sentence carrying a finding, never appends a clause/list/question to satisfy a count; comparison labels/bodies, device labels and kickers become editable; the step re-runs 07b + 07h3 on the revision and discards edits that fail.
- Stop post-gate surgery: composeBoundedObjects builds a device only when its label passes the lint (no splicing inside parentheses, no identifier-like figures, unit kept, never a body opening on a pronoun); #243's trim moves after resolveLayout and becomes a final-attempt fallback with re-lint; the recap strip never prints '…' (figure or writer-supplied recap label, else omitted); repairDashes turns paired dashes into parentheses; the closer gets separate cta and question fields; merge-into-neighbour targets only body-rendering slides (shared with WS-09).

**Files**

- agents/instagram-agent/prompts/instagram-copy/32.md + latest.md + CHANGELOG.md
- agents/instagram-agent/prompts/instagram-angle/2.md + latest.md
- agents/instagram-agent/prompts/instagram-copy-revise/2.md + latest.md
- scripts/prompt-registry.ts
- agents/instagram-agent/src/agent/{instagram-copy-agent,instagram-angle-agent,instagram-copy-revise-agent}.ts
- agents/instagram-agent/src/workflow/value-signals.ts
- agents/instagram-agent/src/workflow/value-gate.ts
- agents/instagram-agent/src/workflow/run-budget.ts
- agents/instagram-agent/src/workflow/readable-copy.ts (new)
- agents/instagram-agent/src/workflow/copy-revision.ts
- agents/instagram-agent/src/workflow/bounded-object.ts
- agents/instagram-agent/src/workflow/slides-data.ts
- agents/instagram-agent/src/workflow/mechanical-repair.ts
- agents/instagram-agent/src/workflow/types.ts
- agents/instagram-agent/assets/templates/default/closer.html
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (11238-11318, 12584-12712)

**Tests and guards**

- readable-copy.test.ts: every shipped string quoted in the audit is a failing fixture ('Not sentiment. A specific act of memory.', 'No scope. No autonomy level. No named supervisor.', 'Wrapped is not Spotify's best campaign. It is Spotify's best data decision.', 'O teto nao era de capacidade. Era de regra.', Kindly's three-sentence closer question, Sitti's repeated cover sentence, 'for this.'); GOOD_SLIDE_COPY passes with its single ', not X'.
- Corpus sweep (craft-hygiene style): commit the 51-post rendered-text fixture and pin each lint rule's hit counts (L1 19, L2 15, L3 5, L4 11, L5 15, L6 10) so a pattern change forces re-measurement.
- Prompt-text test: no prompt read by the angle, copy, revise or judge steps contains 'is not the reason', 'not this. that.', 'dying of old age' or a 'not X. It is Y.' example.
- value-signals: coverTension passes 'Spotify's best campaign started as a data decision' and 'Half a billion shares came from one record', still refuses a flat category line; rhythm ignores 'the'/'a'/Portuguese 'A' and non-rendering headlines. value-gate: long quotes downgraded, maxTokens set, the 49k-token overflow cannot recur.
- Assembly tests: no '( )' (XO slide 7 fixture), no pronoun-opening remainder (Hanky Panky slide 6), no '…' in recap strings, trim reads the resolved layout (Sitti slide 5), closer question holds one sentence, alt text built from rendered fields.
- Loop test (fake router): an attempt with both a coverTension refusal and a word-budget overflow sends ONE revision request naming both, and 05r's output is re-linted before it can ship; check:prompts registry drift passes.

**Overlap with open PRs:** None open. #243 (merged) trim is superseded; #249's harvested captions/hooks become later voice examples, no code overlap.

### WS-11 Graphics layer and imagery policy: code-built icons, charts, diagrams and client motifs before any generated picture

Letters: M, D, K, L, J · Size: L · Depends on: WS-01, WS-04, WS-06, WS-07

**Changes**

- SlideGraphic union on the slide copy: icons (1-4 spot icons, labels <= 24 chars), chart (bars/donut/progress/line/stacked from verbatim sourced numbers, source required, bars from zero, shares of 100 as parts of a whole), diagram (flow/converge/split/cycle/hub/funnel/venn/before-after, 2-6 nodes, optional icon, arrows mirrored for RTL), badges (real marks of named entities via the entity route or simple-icons, monochrome, nominative), motif (the client's own SVG as bullet/texture/frame); list items get an optional icon marker; vendored curated Lucide (ISC) + Phosphor (MIT) path subsets with LICENSES.md via scripts/vendor-icons.mjs; the model picks only from a closed IconName enum; only first-party builders emit SVG (safety.ts:35 kept for model markup); stroke/linecap/fill/chip/radius/ink from the graphics profile (WS-04 tokens); numbers in --f-num; {{html:graphic}} slot in all 8 plates and DEVICE_SLOT_LAYOUTS widened.
- 'Three subjects, graphic before generation' replaces 'three AI frames guaranteed': the floor counts plate subjects of any kind (photo, bounded real picture, chart/diagram/icon composition, product cutout, motif); a deterministic choosePlateSubject table runs before sourcing (>= 2 sourced numbers -> chart; sequence/comparison/cycle or ABSTRACT_GRAPHIC_PATTERN -> diagram; named entity -> real picture or badge, never generated; client product -> library/site photo/cutout; else stock only at subjectMatch >= 4, otherwise icons or motif; generation last, policy-gated, only for a real scene no library holds or a concept in the client's own graphic style); planImageBackfill tries a graphic first and never sends a diagram/chart brief to image.generate (closes the Karos path at image-density.ts:357-360); MIN_GENERATED_IMAGES_PER_RUN becomes a per-profile cap with nothing guaranteed and FLOOR_RESERVE_FRAMES is dropped; attach-graphic ImageryRemedy for the relayout; staged-event/real-brand/real-person/product-UI exclusions applied to EVERY generation brief and refused before billing.
- Visual mix as tuning L1/L2/L3: L1 platform (>= 3 subjects per 8 slides, <= 1 icon composition per slide, never the same graphic kind on consecutive slides); L2 industry bands photo-first / editorial (no AI) / data-led (<= 1 AI frame) / graphic-first (no AI); L3 client instagramVisualMix, graphicsProfile, aiImagery (never|concept-only|fallback), learned preferences and exemplar DNA; resolved like pictureDensity; imageryRegister becomes load-bearing with a diagrammatic register.
- Harvest the client's own vector assets: inline svg, use-sprites and .svg files, classified icon/motif/logo/illustration with stroke/linecap/fill/radius, sanitized against an element allowlist (no script/foreignObject/url()/external href/on*), filed as a 'graphic' media-library kind, lab kit motifs imported the same way (Deel d.box + meridian, Kindly dot set, XO O symbol, Sitti pin), rendered only through img or a CSS mask in brand ink.
- Vet and tier fixes: image-vet@11 (a credited real news/press photo outranks any generated frame; a generated frame with lettering or a real brand UI is refused); product cutout keyed on provenance not on the vet's licence text; Google Places only for place/venue entities, credit always printed.
- imageryMix telemetry on the gate payload and PostPerformanceRecord (pictures by tier, graphics by kind, AI frames bought/landed/paid) so L3 can learn graphic-vs-photo performance; RFC-26 DNA enums extended with icon, diagram, chart, illustration, ai-generated once #250 merges.

**Files**

- agents/instagram-agent/src/workflow/slide-graphics.ts (new)
- agents/instagram-agent/assets/icons/{lucide,phosphor}.json + LICENSES.md (new)
- scripts/vendor-icons.mjs (new)
- agents/instagram-agent/src/workflow/{types,slide-devices,slides-data,imagery-floor,image-density,image-gap-partition,run-budget,scene-brief,interest-relayout,visual-system,post-performance,entity-imagery}.ts
- agents/instagram-agent/src/workflow/visual-mix.ts (new)
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (9085-9930, 10555-10900)
- agents/instagram-agent/assets/templates/default/*.html + _design-system.css
- packages/tools/karos-media/src/{generate-image,harvest-site-images,media-library,routing}.ts
- packages/tools/karos-media/src/harvest-site-graphics.ts (new)
- packages/tools/karos-media/src/svg-sanitize.ts (new)
- agents/instagram-agent/src/workflow/media-library.ts
- agents/instagram-agent/prompts/instagram-image-vet/11.md + latest.md
- packages/tools/karos-media/src/judge-exemplars.ts (after #250 merges)

**Tests and guards**

- ai-imagery-policy.test.ts: with aiImagery 'never' (sitti, xodigital, thepitchbydeel fixtures) a throwing fake image.generate is never called by 04n, 06d, 06d2 or the product campaign, and the run still delivers >= 3 subjects.
- graphic-before-generation.test.ts: Sitti slide 4 (25/20/15/10, source none) gets a chart whose values equal the copy's numbers with zero generate calls; Karos A slide 2 (diagram brief, source none, backfilled:true) gets a diagram with zero generate calls - the case picture-floor-reaches-three.test.ts (#246) misses.
- chart-numbers-verbatim, icon-registry (every IconName resolves, LICENSE present, no trademark), svg-safety (first-party fragments allowlisted, harvested SVG sanitized, model svg still refused), brand-tokens source scan (only var mixes of --accent/--fg/--bg + stroke/radius tokens, logical properties, --f-num, no hex, no --f-mono).
- Chromium calibration sweep: every graphic kind x slot archetype x LTR/Hebrew x s/m/l - no overflow or collision, graphic share >= 0.12 on a graphic cover, fit step <= 1.
- photoreal-record guard fixtures refused before billing: Geektime 'Microsoft AI training event... Tel Aviv, 2026', Karos 'phone displaying Spotify Wrapped', XO 'portrait of Otto Lobo'.
- Golden-set eval with the fake router: AI share of shipped pictures <= the profile cap, bought/landed/paid reported on the gate payload, 0-subject posts stay 0; variety guard (no two consecutive slides with the same graphic kind; graphicSteer fires after three reused compositions).

**Overlap with open PRs:** #250 (packages/tools/karos-media/src/judge-exemplars.ts + index.ts) and #249 (harvest): extend their enums only after they merge; both otherwise untouched. #246 (merged, HEAD of the clone) is partly reversed here (diagram->photo rewrite, 8+4 frames, the guarantee) - owner sign-off requested. The 06d/06h workflow blocks were touched by #246/#247: rebase.

### WS-12 Benchmarks, priors and the Karos house reference: J/K/L inputs as data

Letters: J, K, L, B · Size: M · Depends on: WS-04, WS-11

**Changes**

- Consume #249's harvest and #250's design DNA as source:'feed' evidence in the shared DesignLanguage schema (kit|web|feed); feed DNA may set cover type, device mix, picture placement and share of photographic slides, and can NEVER write identity tokens (fonts, colour roles, radius, borders, box style).
- Competitor and benchmark pages per client: 01h in intel-report runs WS-04's capture on each tracked competitor's site (ScrappyCoco screenshot + Flash vision fallback when blocked), writing clients/<slug>/client/benchmarks.json (ranked exemplars from #249, competitor design tokens, hook/format mix) read by 00d's art direction and the visual-mix resolver; ScrappyCoco executions are never truncated mid-scrape by a budget posture (WS-01).
- Karos Labs' older Instagram engine (karos-agents clients/karoslabs/skills/instagram-agent/engine: 30 posts' data.json, 8 templates, karos-core.css - disc lockup top-left at 48px, mono eyebrow top-right in accent uppercase, marker band, hairline dividers, Spectral display/Hanken body) converted by scripts/import-house-reference.ts into (a) Chromium render fixtures for WS-05/06/07/11 guards and (b) a stated design-language document for karoslabs (provenance 'stated', source 'house-reference'), plus a lessons list (what those designs did that the current plates don't) in RFC-27.
- L1/L2/L3 priors tables in tuning.ts with named EMPTY slots (attention/hook windows, first-slide word budgets, photo/graphic ratios, type ratios, carousel length, per-industry bands, per-platform floors) that the parallel algorithm study fills as data; a schema test forbids an untyped or unit-less value.

**Files**

- packages/tools/karos-client/src/design-language.ts (feed source)
- packages/tools/karos-research/src/instagram-exemplars.ts (read-only consumer, after #249)
- agents/intel-report-agent/src/workflow/create-intel-report-agent-workflow.ts (01h)
- packages/tools/karos-media/src/capture-design-language.ts
- agents/instagram-agent/src/workflow/{tuning,visual-mix,visual-direction}.ts
- agents/instagram-agent/__tests__/fixtures/karos-house-reference/* (new)
- scripts/import-house-reference.ts (new)
- docs/RFC-27-instagram-owner-feedback-2026-09-24.md (lessons section)

**Tests and guards**

- Schema test: feed-sourced fields can never write identity tokens; priors table typed and complete (every L1/L2 key has a default, a unit and a doc line; empty research slots are explicit nulls, not missing).
- House-reference fixture renders (Chromium) pass the logo, type, box and numeral guards of WS-05/06/07; the imported stated document round-trips through getDesignLanguage.
- benchmarks.json round-trip and 01h fail-open (blocked competitor site records a gap, never holds the intel run).

**Overlap with open PRs:** Direct dependency on #249 and #250 - land this workstream LAST, after both merge, so nothing here rebases over their files (karos-research index/exemplars, karos-media judge-exemplars, cross-cutting pin).

### WS-13 Visibility, fleet reports, RFC-27 and the PR summary

Letters: N, A, D, E, F, G, I, M · Size: S · Depends on: WS-01, WS-02, WS-03, WS-04, WS-05, WS-06, WS-07, WS-08, WS-09, WS-10, WS-11, WS-12

**Changes**

- Gate payload + portal card fields: faces painted per role and flagged substitutes (WS-02), logo source/variant/marker (WS-05), design-language conformance (WS-07), set-integrity result (WS-09), imageryMix (WS-11), budget lines incl. any overage note (WS-01); BQ insert schema updated.
- Promote checklist gains scripts/audit-brand-fonts.ts, report-brand-logos.ts and report-design-language.ts: no client ships with an unverified font, an unapproved logo or a missing/stale (> 90 days)/blocked capture without stated overrides.
- docs/RFC-27 completed as the PR summary: each owner letter A-N -> consequence -> workstream -> guard; corrects #196's diagnosis (the incident was an orphaned render object, not a writer's second closer); notes #244's trigger reversal and #246's partial reversal; lists the seven data fixes and the portal companion; scripts/rerun-instagram-local.ts prepared for the next round's local re-run (not run now) under the owner's spend rule.

**Files**

- agents/instagram-agent/src/workflow/visual-qa-pre-checks.ts
- agents/instagram-agent/src/workflow/gate-verdict.ts
- agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts (gate payload)
- scripts/{audit-brand-fonts,report-brand-logos,report-design-language,rerun-instagram-local}.ts
- docs/RFC-27-instagram-owner-feedback-2026-09-24.md
- docs/AGENT-ARCHITECTURE.md (gate card fields)

**Tests and guards**

- Gate payload schema test + npm run check:bq-schema green with the new fields; report scripts run against fixture workspaces (no network); check:prompts, check:tool-versions, check:config, typecheck all green on the branch head.

**Overlap with open PRs:** None.

## Verification without model spend

Every guard runs in `npm run verify` (typecheck + vitest across workspaces) with zero model calls: model turns come from fakeRouterSequence fixtures (__tests__/test-helpers.ts), image.generate / ScrappyCoco / Google Fonts / site fetches are replaced by throwing fakes or recorded fixtures (saved HTML+CSS pages, captured font binaries and logos under __tests__/fixtures), and pixels come from real Chromium via Playwright, which CI already installs (`npx playwright install --with-deps chromium` in quality.yml) and isChromiumInstalled() guards locally. Order of proof per workstream: (1) static source scans (no family/radius/gradient literals, prompt-text bans, prompt registry, tool-version drift, config inventory, BQ schema); (2) unit and property tests on the pure modules (tuning, set-integrity, readable-copy, slide-graphics, site-identity, derive.ts, brand-logo spec, merge guard); (3) Chromium fixture renders: the 7 client kits x 8 plates sweeps for painted fonts, type scale, boxes, logos, scrim contrast and graphics, each sweep required to FAIL on today's main and each check broken once on purpose in a reverted commit recorded in the PR; (4) runToGate workflow tests with the fake router (Kindly/Sitti-shaped merge fixtures, budget posture, fail-open captures, identity hold, AI-policy never-called); (5) the golden-set eval in evals/ with fake routers for imageryMix and set-integrity invariants; (6) a corpus regression: the 51-post rendered-text fixture and the 67-run prep relayout census pinned so thresholds cannot drift silently. The only paid verification, the local re-run of the 8 clients, is deferred to the next round (letter N) and, when it runs, follows the owner's rule: no cap stops it mid-step, overage to the $5 allowance is acceptable.

## Portal companion branch

Companion branch karos-portal `feat/brand-contract-2026-09-24` (no overlap with open #214, which touches only asset-card.tsx, version-comparison.tsx and text-diff.ts). P1 Typography with provenance (letters A, B, C): BrandingGuidelines.typography roles display/body/label/figures (family, weights, source upload|lab-kit|google|substitute, file URLs + sha256, googleFamily, observedFrom, licence, numeric, status, revision) with fontHeading/fontBody kept as derived mirrors; branding.ts drops the archetype font lists (757-776), the 'archetype fallback only if unknown' rule (986) and the '?? fontHeading/fontBody' persistence (1334-1335) - a model suggestion is stored only as typography.suggested with status needs-staff; brand-fonts.ts/branding-site-palette.ts observer follows every stylesheet, captures @font-face src/weight/style, prefers role variables over widget selectors (skip .yotpo-*), adds label and figures roles, filters emoji/system families and reports 'unreadable' for challenge/parked/platform-error pages (shares the site-identity classifier); new brand-font-resolve.ts (uploaded/lab files -> public Google catalog with real weights, rejecting /l/font?kit= kits -> flagged closest free substitute, never silent); branding-modal font review + upload per role and a fonts route modelled on the logo route; import-lab-client reads brand-colors.json fonts[] and uploads brand/fonts/* with licence notes; toProjectedBrand projects the full typography object (+ fonts.mono) with an engine-field-contract entry; projection made reliable (re-project on a schedule and after scripted writes, loud skip, backfill-brand-fonts re-projects, fix the branding-actions.ts:115-117 comment). P2 Site identity (B): the same classifier on website save, before onboarding dispatch and in the branding step, storing websiteStatus and never extracting a palette or fonts from a parked page; setup-ladder flag for lab-profiled clients not marked profileSource 'lab'; import-lab-client hardening (refuse a config without a top-level name, require --category, add --replace-docs, replace rather than spread brandingGuidelines). P3 Stated design language (B, D, M, G): BrandingGuidelines gains iconography (set, stroke, corner, fill, ink, chip), motifs (SVG files + usage rule), imageryPolicy (aiImagery, stock), chart style, imageryRegister, box radius/style, surface and hairline hexes, pill/button shape, accent budget, numeral face - confirmed in the modal, projected as a designLanguage block; the portal builds no capture of its own (the engine owns measurement; portal fields are 'stated' and win over measured). P4 Logo spec (E, F, G): BrandLogoSpec type + pure brand-logo-spec.ts (precedence upload > lab > site > avatar; matching lab file = the clean file; corner rule; equal-area size rule); brand-logo-onboarding.ts collects the upload, lab variants, the site SVGs branding-site-palette already finds and the Instagram avatar, processes them (SVG canvas-rect strip, currentColor per variant, uniform/nested-tile background removal, trim, refuse-not-cut), derives onLight/onDark, stores content-addressed files under clients/<id>/brand-logo/<sha>-<variant>.<ext>, writes status auto for staff approval; upload route records source=upload + runs the decision + re-projects; brand-logo-field/branding-modal show the processed result on the ground and a sample photo with approve / keep background / use lab asset, and the portal UI tile is separated from the post logo; engineBrandLogoUrl reads the spec; projection writes a logo object (variants, box, corner, treatment, specHash, decidedAt) keeping logoUrl as the default variant with durable URLs; import-lab-client imports the whole logo set (logo-dark -> onLight, logo-light -> onDark, mark files, brand.yaml logo block), deletes the Geektime-specific filename, never replaces an upload's identity; every engine run start projects first (dispatch.ts, scheduler route, project-on-save) with specHash + contextProjectedAt in the run input. Tests: BrandingSchema contains no archetype font names and model output never persists as verified; resolver fixtures from the live sites (karoslabs label/tabular, hankypanky --font-heading Relais beating Yotpo, sitti Gaegu, xodigital next/font demangling, Deel Bagoss + Inter, geektime past 4 sheets + Cloudflare unreadable, kindlyyours parked unreadable, no emoji family); precedence, projection (logo object + content-addressed URL), importer tripwire (no client slug or filename in the script), upload-route and nightly website-vs-lab identity checks; context-doc-projection.test.ts extended for typography, designLanguage and logo.

## Data fixes (not performed; each needs the owner's yes)

- 1. Typography (prep, then prod after promote, then re-project brand.json for all seven): karoslabs Spectral / Hanken Grotesk, label per owner's pick (Hanken uppercase or JetBrains Mono), figures Hanken tabular; geektime Open Sans in every role incl. Hebrew; thepitchbydeel Bagoss files only once Displaay + Deel clear the webfont licence, else a flagged substitute, Inter body/overline; hankypanky Relais/Fabriga once the client supplies files, flagged substitute meanwhile, remove Georgia/Helvetica Neue; kindlyyours GT Walsheim needs files, lab stand-ins Fraunces/Nunito flagged; sitti Gaegu + JetBrains Mono for stats (founder to confirm); xodigital Fraunces / Geist / Geist Mono from the lab TTFs (or the live site's pair, per owner). scripts/audit-brand-fonts.ts must be empty afterwards.
- 2. Logo specs (prep first): bring The Pitch's prod logo (the-pitch-logo-dark-v4.png, set by eb6d3fa3 after prep's last sync) into prep; run the decision for all seven and get staff approval - karoslabs lab figure or disc (keep-or-replace call on the 2026-07-10 screenshot upload), geektime logo-dark.svg on white + logo-light.svg for dark grounds/photos, thepitchbydeel prod upload with the lab pair picked by ground, hankypanky logo-dark/logo-light, kindlyyours logo-dark/logo-light, sitti the grapefruit only (lab logo-dark.png), xodigital lab logo-light.svg on navy (keep-or-replace call on images.jpg); then re-project.
- 3. Kindly Yours (client vj8pJxRGLtiN2YbBuPwR, prep then prod): fix the website field (kindlyyours.com is parked; lab says thisiskindly.com, currently Shopify 402 - confirm with the client, else leave empty); dry-run then delete the 14 mixed context docs from 2026-07-21; import the lab profile with --category intimates (--replace-docs after P2), setting profileSource 'lab'; replace brandingGuidelines wholesale from the lab kit (Coral #F2805F, Sage #A0C9C3, Deep Sea #376A6C, Coral Digital #FF8548, Forest #026C62; GT Walsheim + fallbacks), clear the gifting voice/tone, set industry; regenerate client-tier summaries, re-run projectClientToWorkspace + knowledge sync, overwrite clients/kindlyyours/client/voice-rules.json; delete the stale instagram/x/linkedin briefs in the prep workspace; reject pubsub-21254987551616377 at its gate and mark pubsub-21774365812455041 and pubsub-21255254988332367 void (markers, not deletions) incl. their ledger deliverable/performance/skeleton/cross-client rows; keep the 12 intimates competitors.
- 4. xodigital: re-project the stale clients/xodigital/client/brand.json (projectedAt 2026-09-20T18:10Z) so the portal's 19:36Z correction reaches the engine and #06cf9c never paints again; same re-projection for every client once P1/P3/P4 land.
- 5. Seed stated design-language documents where the site cannot be read: kindlyyours (GT Walsheim, 3.2rem radius, tabular numerals, dot motif), geektime (brace-chip motif, palette from the lab kit), karoslabs (house reference from the older engine: radius 6, hairline boxes, one ground, accent budget ~5%, disc lockup top-left).
- 6. Imagery policy on prep for the 8 clients once the keys exist: aiImagery never for sitti, xodigital, thepitchbydeel; karoslabs graphic-first with no stock and Lucide monoline icons + simple-icons chips; geektime editorial with no generated event photos; hankypanky photo-first; kindlyyours data-led with the dot motif.
- 7. Lab repo (karos-agents): normalise fonts[] to display/body/label/figures with file paths and licence status; brand.yaml logo blocks (light_ground, dark_ground, mark_only, placement, min_px, recolor, on_photo, do_nots) for every client (karoslabs from skills/instagram-agent/engine/config.yaml:30-44) and fix the stale 'intentionally empty' README in thepitchbydeel/brand/logos; machine-readable design-language block (radius, box style, ground, accent budget, tables/numbers) and imagery policy per client; kindlyyours config.json gets a top-level name and website.
- 8. Storage and review hygiene (needs an account with karoscmo-prep-media-assets access; the portal service account gets 403): delete the 29 orphaned first-render slide-8.png objects listed by merge-census.cjs, add a lifecycle rule expiring superseded render prefixes after ~30 days once renderKey ships, and re-harvest the review sheets from the deliverable's rendered list (or the last committed 08a1c step) so the owner's review shows the 7 slides that shipped.

## Drift review, letter by letter

- **A** (partial): WS-02 plus portal P1 cover how fonts work. Fonts become roles with provenance (upload|lab-kit|google|substitute) and are embedded as @font-face with font-synthesis off. Templates name roles only. A painted-font check through CDP replaces fontFamiliesUsed, which today records the requested family name, not the face that painted (verified: render-carousel.ts:531/801, slide-metrics.ts:547). The owner's order (uploaded, then Google, then a flagged free substitute) is kept. The 'never again' guarantee has a hole. WS-02 deletes the bundled Fraunces/Inter/IBM Plex Mono defaults (verified at _design-system.css:93-95) but leaves FONT_HOLD_ENABLED off until data fix D1. In that window a client with no kit or no typography (the :2770 path, and the seeded sitti/hankypanky/kindlyyours kits) renders in system fallbacks or is refused with no defined outcome, which is exactly the failure A forbids. Fix: land D1 first, or ship the hold on for that path. Google faces are also fetched on every run instead of copied once to our bucket. Three clients (Bagoss, Relais/Fabriga, GT Walsheim) stay on flagged substitutes until their licences clear.
- **B** (partial): WS-04 measures everything the letter names: type roles and loaded faces, colour use by role weighted by area, buttons/pills/chips, cards and radius, tables and tabular numerals, icons, gradients and section grounds. It stores the result with provenance outside brand.json, which the portal rewrites. P1-P3 remove the portal's archetype-font fallback (verified at branding.ts:765-766, 986, 1334-1335) and add stated fields. Gaps: (1) The capture runs mainly as a setup step of the first Instagram run (00f*, 90-day TTL). The onboarding hook (01j in intel-report) is marked 'Optional', but the letter says onboarding does the capture. (2) Layouts only get a one-off Flash vision description. (3) The requested audit of what onboarding does today exists only as line references in the plan, with no deliverable. Make 01j mandatory (fail-open) and add an 'onboarding today vs after' section to RFC-27. WS-03's site-identity guard supports B but adds new behaviour: a run hold and blocked brief storage.
- **C** (partial): Bigger reading text is met: the T floor is 44px against today's 32px body ('label' in TYPE_SCALE_PX, visual-system.ts:448), and S is 26-28px against 22px. Numerals move to the brand face, and WS-10 addresses complete, human sentences. Deviations: (1) F = 1.5xH is a third display size. The owner asked for two text sizes plus a source line, and the open question only asks whether F is too quiet. (2) The shrink rung (H to 0.875H) gives some slides an off-scale headline, so a carousel can carry more than two sizes plus the source line. (3) WS-08's title:subtitle cap of 1.8 is impossible on WS-06's own scale: H at about 18 characters a line and T at 38-40 gives H/T of about 2.2. (4) The readable-copy lint ships REPORT_ONLY, so at merge nothing refuses copy that reads like AI. (5) The numeral token is --f-figures in WS-02 but --f-num in WS-06 and WS-11; pick one.
- **D** (covered): WS-07's .ds-box primitive and --dl-*/--box-* tokens replace the five hard-coded accent ramps. There is no accent fill or gradient unless the client's language says tint. Device fragments, the closer CTA and the logo chip read the same tokens. A Karos fixture asserts 1px #34343B hairlines, radius 6 and accent at or under 5%. The Studio gets a vocabulary gate, and conformance goes on the gate payload; WS-04 and P3 supply the tokens. One fix is required. WS-07's test 'a client with no design-language document composes byte-identical documents to main' contradicts its own new default (hairline, radius 6, no gradient). If the test wins, any client whose capture fails open (Cloudflare or parked sites) keeps the brown accent-gradient boxes.
- **E** (covered): WS-05 gives each client one spec. The corner follows a rule: top-left, or top-right for right-to-left scripts; top-end only by brand rule, and then below Instagram's n/N counter pill. Size follows an equal-area rule (4900px2, 32px floor, 240/96 caps). It deletes today's per-run flip where an eyebrow or series badge moves the logo to top-end (verified at workflow 2721-2723), so studio and posts resolve the same corner. The corner default is correctly put to the owner, and the older Karos engine agrees with it: its config.yaml locks the logo top-left, 'same position every slide'. But that lockup (54px disc plus wordmark, about 260px wide) breaks WS-05's 240px/4900px2 rule, so K's fixtures and the size rule must be reconciled. Also, mark-placement.ts, which WS-05 calls unused, is live: render-carousel uses it (placeAutoMarkBadge) to position entity mark badges, and reusing it must not change that.
- **F** (covered): Logo discovery never runs when a spec or configured logo exists. A failed upload download renders no logo and posts a named gate finding, never a scraped substitute, and a fetch-spy test proves zero homepage fetches. P4 sets the order upload > lab > site > avatar and re-projects at every run start. Data fix 2 brings The Pitch's prod upload into prep. The plan correctly asks whether screenshot-quality uploads (karoslabs, sitti, xodigital) should beat clean lab files.
- **G** (covered): P4 has onboarding decide how each logo displays: it strips canvas rects and removes uniform or nested-tile backgrounds, refusing rather than cutting. It also sets currentColor per variant, makes light-ground and dark-ground versions, and asks staff to approve in the modal. In the engine, WS-05's ink reader treats an opaque border colour as background, and a Sitti nested-tile fixture must return only the inner mark. The on-photo rule is measured on rendered pixels. Data fix 2 picks Sitti's grapefruit-only lab file.
- **H** (covered): WS-08 caps the cover: title at most 8 words, deck at most 12 words and one sentence, 20 words in total. It adds a title:subtitle cap and a scrim anchored one line above the measured copy, with per-line p10 contrast of at least 4.5:1. Framing becomes the fallback only when that contrast is unreachable, and a Sitti slide 1 fixture checks the result. This replaces #244's FRAMED_DECK_MIN_WORDS = 10 trigger (verified at slides-data.ts:1182). Two fixes before building: set TITLE_SUBTITLE_RATIO to agree with the scale and with its own prototype (112/50 = 2.24, not 1.8 or less), and get sign-off to reverse #244, merged today on the owner's XO feedback.
- **I** (covered): WS-09 fixes the real cause of the duplicate Sitti 7/8 and Kindly 7/8 slides. render-carousel writes instagram/<client>/<postId>/slide-<n>.png with no per-render key (verified at render-carousel.ts:1441, TOOL_VERSION 1.11.0), so a shorter re-render left the old slide-8 in place. The fix adds a render key, dHash/sha256 duplicate checks, exactly one cover and one closer, text-coverage checks, and merges only into slides that show a body. WS-09's adjacency token and series grammar cover 'flows as one set', along with WS-10's distinctness and 'rememberLine once' and one carousel-wide font scale.
- **J** (partial): The ScrappyCoco research 'running in parallel' is engine PR #249 (harvests client, competitor and reference accounts) and #250 (craft and design-DNA judge). Both are open under the karoslabs account, not Tomer's. The plan only consumes them in WS-12, which lands last and waits for both to merge. The plan's own J work captures competitor websites (01h). But 'benchmark pages' most likely means benchmark Instagram accounts (#249's 'reference' role), and nothing in the plan decides or stores each client's benchmark accounts. WS-12 also duplicates RFC-26's own Phase 3 design (Studio evidence at 00c2, direction at 00d1/00d2, a 30-day refresh at 00h). It leaves out RFC-26's owner consent decision on harvesting competitors.
- **K** (partial): WS-12 imports the older engine as Chromium fixtures, a stated Karos design-language document and an RFC-27 lessons list. The source exists: karos-agents clients/karoslabs/skills/instagram-agent/engine has 30 data.json posts, 8 templates and karos-core.css. But K sits in the last workstream and waits on #249/#250, which it does not depend on. Its lessons therefore arrive after WS-05 to WS-11 have already fixed the logo, type and box rules they should inform. The test that the house renders pass the new guards contradicts the older design itself: a 54px disc plus a 33px Spectral wordmark at top 48px, and a 19px mono eyebrow under the S floor of 26. Do K first, as an input to the rules.
- **L** (partial): The plan builds places to hold the answers: WS-01's L1/L2/L3 tuning table, WS-11's visual-mix bands, and WS-12's empty priors slots that 'the parallel algorithm study' is meant to fill. The deep dive into the algorithm and attention, and its conclusions, are not in the plan. I found no session or PR doing that study; the only Instagram research in flight is #249/#250, which is J. WS-11's per-industry bands (photo-first, editorial, data-led, graphic-first) are set before any study. The L3 client fields (instagramTuning, instagramVisualMix, graphicsProfile) don't exist on main, and P1-P4 give them no portal field, projection or engine-field-contract entry. L1 covers Instagram only.
- **M** (covered): WS-11 builds graphics in code: icons (vendored Lucide ISC and Phosphor MIT), charts from verbatim sourced numbers, diagrams, badges and client motifs, all tried before any generated picture. AI imagery becomes a per-profile policy (never, concept-only or fallback), and a throwing fake proves zero generate calls under 'never'. The picture floor counts subjects of any kind, and the copy caps in WS-08/WS-10 cut text. This reverses #246's guarantee of three generated frames (RFC-24 ruling, merged today), so it needs owner sign-off. The simple-icons badges would put third-party trademarks on client posts.
- **N** (covered): The engine branch is cut from origin/main 2792638a (#247, verified as head), with one commit series per workstream and no squashing. RFC-27 serves as the PR summary: each letter, its consequence, the workstream and the guard. The rerun script is prepared but not run. Verification uses fake routers and offline Chromium, which keeps to 'no new posts this round'. Caveats: the work also needs a portal companion branch (B's 'probably on a branch' allows that), edits in karos-agents and live data fixes. WS-13 depends on WS-12, which waits for #249/#250, so the PR and its summary can't be finished until those merge. The local feat/instagram-feedback-2026-09-24 (0709bb8c) has no commits beyond main, so there is nothing to rebase; delete it so Tomer doesn't see two similar branches.

## Risks from the drift review

- The spend rule is applied more widely than the owner said it. The owner's words were about scraping and research ('stopping mid-scrape', 'pulling very good conclusions'). WS-01's first commit turns them into production policy for every Instagram run: the point where the cheap path engages moves from $2.60 to $5.00 per run (MAX_RUN_SPEND_USD) and from $3.00 to $5.00 per setup (MAX_SETUP_SPEND_USD). That happens before the owner answers the plan's own spend question. A workflow comment near line 11577 says the owner gave the hard max as a loop-breaker, so raising it also weakens runaway protection. Worst case for the next 8-client re-run is about $80 before any saving posture engages, against about $45 today. Recommendation: ship 'a started step always finishes' now, since that is the owner's actual point, and hold the $5 production figure until the owner confirms it. Also apply the rule to this round's research, which the plan doesn't govern. RFC-26 estimates about $0.30 per client for a full harvest plus judge, roughly $2.40 for 8 clients, well inside $5. The cost of the L study is unknown.
- WS-01 never mentions the essential-only posture. It switches on at the $1.80 target and stops new generated images and rescue re-vets (run-budget.ts:1207). So even with a $5 allowance, a hard run is still cut back at $1.80, and the spend tests only check cheapest-path. The plan also names 8 posture checks, while main has about 15 live ones, including setup inspection (3251), setup art direction (3739), lead-claim verification (11581), the native-editor judge downgrade (12006) and 13711. Put the allowance and a per-step snapshot inside SpendMeter.posture rather than editing call sites.
- The plan adds holds that clash with the owner's always-deliver rule. RFC-14's standing amendment says budgets adapt and never hold, and agents/instagram-agent/__tests__/zero-held-guarantee.test.ts allows exactly three kinds of hold: a human rejection, no subject, and nothing to write from. The plan adds a font hold (WS-02), a brand-font slide refusal, an identity-conflict hold before step 03 (WS-03), and a set-integrity failure at 09b (WS-09). That last one throws WorkflowToolingFailure before ledger.writeDeliverable, so the run ends degraded with no deliverable. None of these mention the test; each needs an owner ruling and a test update.
- Commercial font files would land in the repo. The engine repo contains no font binaries today, and WS-02 adds '7 client kits + font files' as test fixtures. That would publish Bagoss, Relais/Fabriga and GT Walsheim to GitHub, when the plan itself says their licences are unresolved. Use OFL fonts or the flagged substitutes as fixtures. Separately, copy each client's Google font files into the media bucket (content-addressed) when the brand is projected, so a run never depends on fonts.gstatic.com.
- The plan contradicts itself in places; fix these before coding. (a) WS-07's byte-identity test for clients with no design-language document conflicts with WS-07's own new default and with WS-02/WS-06's fleet-wide font and scale changes. If the test wins, clients whose capture fails keep the brown gradient boxes. (b) A title:subtitle cap of 1.8 can't hold when the scale gives H/T of about 2.2, and the plan's own 112/50 prototype is 2.24. (c) The numeral token is named --f-figures in one place and --f-num in others. (d) WS-09 plans render-carousel TOOL_VERSION 1.11.0 to 1.12.0, but WS-02 bumps that version first and WS-05/WS-08 edit the same file, so the numbers shift and per-commit cherry-picks collide. (e) WS-12's Karos house-reference renders cannot pass WS-05/WS-06's logo and type guards as written.
- The plan reverses owner-driven PRs merged today: #244 (the framed-hero trigger, from the owner's XO feedback), #246 (the guarantee of three generated frames, an RFC-24 ruling), #243 (its trim becomes a fallback), and the diagnosis in #196. Get the owner's yes before building WS-08 and WS-11; a no means reworking a large part of two L-size workstreams.
- Tomer and open PRs, checked 2026-09-24. Tomer (tomerelkaros) has no open PR on agent-engine, karos-portal or agent-middleware, and his last engine commit is 2026-09-16, so nothing conflicts with Tomer's work. The only open engine PRs, #249 and #250, are from the karoslabs account (which wrote most of #224-#248), so the question 'should Tomer merge those first' is aimed at the wrong person. Portal #214, which the plan calls open, merged at 20:47Z; the portal has no open PRs and main is cb7703c0 (#217), so cut feat/brand-contract-2026-09-24 from there. The real overlaps with #249/#250 are: karos-research/src/index.ts (WS-03); karos-media/src/index.ts (WS-04, and WS-11 if its new modules are exported); the cross-cutting tool-registry count (69 to 70 in #249, then +1 for each new tool); and karos-scraper/src/provider.ts if WS-12's ScrappyCoco screenshot needs a new provider method.
- The scope goes well beyond the letters: 13 workstreams, 6 of them L-size, across three repos plus live data. Additions not asked for in A-N: WS-03's identity hold and brief-storage block; WS-02's edits to the karos-landing render-page tool and branded-shorts derive-brand-setup; WS-04's rework of landing.captureSite; WS-11's harvesting of client SVGs, an SVG sanitizer, vendored icon sets and simple-icons trademark badges; WS-12's competitor-website capture in intel-report; WS-13's BQ schema and portal-card fields. The promise that Tomer can cherry-pick per commit is unrealistic: WS-06 needs WS-02, WS-07 needs WS-04 and WS-06, WS-10 needs WS-09, WS-11 needs WS-01/04/06/07, and most workstreams share files (the 16,035-line workflow, _design-system.css plus 8 plates, render-carousel). The plan also breaks each check once on purpose in a reverted commit and never squashes, which leaves broken commits for anyone bisecting. Keep those proofs in the PR text or a throwaway branch.
- Model spend hides in a round that is meant to have none, and after it. (a) Data fix 3 regenerates Kindly Yours' client-tier summaries, which calls a model (portal src/lib/intel/condense.ts uses streamText), and re-runs the knowledge sync. (b) WS-04 adds a Flash vision call per capture plus an optional capture at onboarding (01j), and WS-12 adds a Flash fallback for each blocked competitor site. That is small, but it is new recurring spend. (c) WS-10 makes the copy@32 prompt longer and raises the judge's maxTokens. (d) None of the new prompt versions can be shown to work without paid runs: brief@2, copy@32, angle@2, copy-revise@2, visual-qa@6, image-vet@11, design-language@1, and new design-brief, template-designer and art-director versions. Fake-router tests prove only the wiring, so the first real measure is the next round's re-run, which should get an explicit budget under the owner's rule.
- Several data fixes are destructive or irreversible and each needs the owner's yes; only the storage deletion is among the plan's open questions. They are: deleting 14 Kindly Yours context docs (prep, then prod); rejecting pubsub-21254987551616377 at its gate; voiding two runs and their ledger, performance, skeleton and cross-client rows; overwriting voice-rules.json; replacing brandingGuidelines wholesale; writing The Pitch's prod logo into prep; and deleting 29 storage objects plus adding a lifecycle rule. Several of these touch production.
- Order of work. WS-12 carries J and K, and WS-13 (the PR summary) waits for WS-12, so a slow merge of #249/#250 leaves the whole branch unfinished. Split K and the priors slots out of WS-12, or build the stand-in code the open questions mention. In practice, data fixes D1 (fonts) and D2 (logos) gate letters A and F: until they land the font hold is off and no logo specs exist, so plan them alongside the code, not after it.