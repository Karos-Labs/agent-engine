# RFC-14 - Instagram agent: the visual layer (Phase 2 + Phase 3)

Status: implementing (PR-C = Phase 2, PR-D = Phase 3). Follows RFC-13 (Phase 0/1, merged as #84 and #94).
Driven by the owner's 2026-09-10 feedback: generating templates is not enough, a boring template is a defect,
and repetition across runs is what makes the output read as AI.

---

# Part 1 - Brief


Worktree: `C:\Users\1\Documents\KarosLabs\agent-engine-instagram`. Cut both branches from `origin/main` (Phase 0 = PR #84 and Phase 1 = PR #94 are MERGED; PR #95 fixes a tool-version gate on main). Never touch `C:\Users\1\Documents\KarosLabs\agent-engine` or any other `agent-engine-*` worktree. Files are CRLF; use Edit/Write, Python writes need `newline=""`.

Read `docs/RFC-13-instagram-grounding-and-topics.md` on main for what Phase 0/1 already built and the conventions used.

## Owner's decisions (binding, carried forward)
- **One PR per phase**, stacked: PR-C = Phase 2, PR-D = Phase 3 on top of C. Do not merge.
- **Run cost: target $1.00, hard max $1.50.** Copy stays `claude-sonnet-4-6`; judges/extractors on Gemini 2.5 Flash or Haiku; **no Opus in a run**. One-off SETUP work (template generation, art direction) is a separate, amortised budget: **target $2.00 per client per setup, hard max $3.00**, and it must be reported the same way a run is. Every new model step justifies its cost in a comment.
- **Budgets adapt, never hold** (the standing amendment): estimate before the first paid call, adapt the plan to fit, past the target stop optional work, past the hard max finish on the cheapest complete path and DELIVER; status `completed`, at worst `degraded` with a reason; persist estimate vs actual and calibrate the next run. Never `held`/`failed` for budget. This applies to setup too: a setup that would exceed generates fewer templates rather than failing.
- **Harvesting/scraping = ScrappyCoco only** (`packages/tools/karos-scraper`, `ScraperProvider.searchKeyword` / `socialHistory` / page fetch). **No Apify, no new vendor.**
- **Engine-native**: agents (`BaseAgent` via `wf.step.agent`), typed zod tools under `packages/tools/*`, deterministic orchestration in `wf.step.code`. Use the legacy `karos-agents/products/live/instagram-agent` skill files as a REFERENCE for rules only (`references/taste-design-rules.md`, `references/template-archetypes.md` §3 device library, `SKILL.md` Phase 3) — do not port Python or skill markdown.
- Hebrew is a first-class target language (client `geektime`); anything visual must hold in RTL and in the script fonts Phase 0 added (`src/workflow/script-fonts.ts`).

## NEW owner feedback (2026-09-10) — the boring-template problem
Verbatim: *"צריך ליצור טמפלייטים אבל יש גם טמפלייטים משעממים, למשל בKAROS LABS אתה רואה מסך אפור ברובו, אלה פוסטים שאנשים לא ירצו. בנוסף בגלל שזה חזרתי זה נראה AI."*

Translation and what it means for this work:
1. **Generating templates is not enough — a template can be boring, and a boring template is a defect.** The Karos Labs runs render a mostly-grey slide with a headline in the lower third and a large empty upper area (see the audit artifact and `gs://karoscmo-prep-media-assets/instagram/karoslabs/<runId>/slide-*.png`). Nobody saves that post. **"Technically correct and empty" must fail, not pass.**
2. **Repetition itself reads as AI.** Every slide resolving to the same skeleton, run after run, is the tell. Variety must be real and it must be measured ACROSS runs, not only inside one carousel.

Both become enforceable requirements, not prompt advice:
- **A visual-interest floor measured on the rendered pixels** (see item L). A slide that is overwhelmingly flat background fails and is redrafted or re-laid-out.
- **Structural memory across runs** (item P): what a run shipped is recorded, and the next run for that client cannot repeat the same skeleton sequence.

## What is already in place (do not rebuild)
- Grounding: `02i-resolve-client-brief` + persisted `ClientBrief` (`packages/tools/karos-client/src/brief.ts`, `client.getBrief` / `client.writeBrief`), grounded research query, `07g-relevance` judge.
- Language: `src/workflow/script-fonts.ts` (per-script families + type scale), `target-language.ts`, fail-closed `07e/07f`, Unicode craft hygiene incl. the caption.
- Topics: five engines + `03d/03e/03f/03g` ranking, scout always, fact cards, `03i`-style angle step before copy (`angle-selection.ts`), copy prompt at `instagram-copy@13`.
- Images: four tiers (client uploads, stock, scrape, generate), `media.inspectImages` (now 1.1.0, names identity), `instagram-image-vet@3` with `claimMatch`.
- Budget: `src/workflow/run-budget.ts` (`planRunBudget`, `RunSpendMeter`, posture, history in `memory.updateBeliefs` under `instagramRunBudget`).
- Render: `publish.renderCarousel` → Playwright Chromium → PNG; templates are the 6 bundled archetypes in `packages/tools/karos-templates/src/bundled-store.ts` + `agents/instagram-agent/assets/templates/default/*.html`; `karos-templates` already has `TemplateDefinition`, `qualityScore`, `promoteTemplate`, `reviewTemplate`.
- Deterministic pre-checks: `src/workflow/visual-qa-pre-checks.ts` (default render rules, contrast facts, palette-within-kit) + `08b` judge.

## Phase 2 — the template system that is not boring (PR-C)

L. **Visual-interest floor, measured on pixels.** A new deterministic tool (`publish.measureSlides` or an extension of the render tool, engine-native, no new vendor) reads each rendered PNG and reports per slide: fraction of the canvas that is flat background (single dominant colour within a tolerance), ink coverage, largest empty rectangle, whether imagery/device pixels occupy at least a floor share of the frame, text area share, and the accent's share. Thresholds live in code with named constants and a comment explaining each number. A slide over the flat-background ceiling (start at 70% and justify the number) or under the content floor fails `07h`-style deterministic checks; the failure names the slide and the measured number, and returns the attempt to layout/redraft with that steer (per the standing rule: findings must reach the redraft). Tests: a synthetic mostly-grey PNG fails; a real rendered slide from the bundled archetypes passes; a Hebrew slide passes.

M. **Cover and closer archetypes, plus a device library for numbers.** New bundled archetypes: `cover` (full-bleed image or a generated graphic ground + eyebrow + title, never a headline alone on flat ground), `closer` (recap strip / CTA / question, never near-empty), and number devices — big numeral, bars, before/after, timeline, versus — as composable CSS/HTML devices (the legacy `_cf-devices` is the reference for the RULES: nowrap on figures, length-based autosize, labels wrap beneath, value inside a bar filling ≥72% of its track). A slide whose body leads with a figure must use a device, not prose. Every device must render correctly in RTL and in the script fonts.

N. **Template Studio: 4-6 templates generated PER CLIENT at setup.** A new setup-time agent (`instagram-template-designer`, Sonnet + vision) that: reads the client's brand kit, the persisted `ClientBrief` and the client's own site (ScrappyCoco page fetch); reads what formats actually perform in the niche by pulling the brief's reference accounts with `research.socialHistory` and ranking their posts by the engagement fields available (normalise per account; state plainly in the output which signals were available and which were absent — no invented metrics); then authors 4-6 template HTML files for that client, each declaring which measured format it is derived from and why. Each generated template MUST pass, before it is stored: the slot contract in `packages/tools/karos-templates` (`{{slot}}` / `{{html:slot}}` / `{{image:slot}}` names a template actually reads), a real Chromium render of a sample, the item-L interest floor, contrast checks, and RTL + script-font rendering when the client's language is non-Latin. Stored via the existing `templateStore` at a quality score that lets them be picked (bundled floor is 70 — say what score you use and why). The client approves in the portal; until approval the bundled set is used. A setup that would exceed the setup budget generates fewer templates and says so — it never fails.

O. **Per-run authoring, and the pool that grows.** `customArchetype` stops being "a rare tool": the copy prompt may author one or two slide layouts per carousel when the content calls for it, and each is validated (slot contract + render + interest floor) before it reaches the renderer. A custom layout that shipped through the human gate twice without an edit is **auto-promoted** into that client's template pool (this is the "generator that updates the pool" the owner asked for). Promotion is recorded with the run ids that earned it. Existing `promoteTemplate` / `reviewTemplate` carry the scoring; do not invent a parallel mechanism.

P. **Structural memory across runs.** The ledger records, per shipped post, the ordered list of archetypes/templates used (a "skeleton signature"). The next run for that client: receives the last 5 signatures as an avoid-list in the copy/layout prompt, and a deterministic check refuses a signature identical to the previous post's. `08b` compares composition variety against the previous post, not only within the carousel. This is the enforceable half of "repetition reads as AI".

## Phase 3 — images that look like this client (PR-D)

Q. **Visual direction per client, at setup.** An agent step derives 6-10 art-direction lines (subject, light, palette, treatment, and what is forbidden) from the brand kit, the site and the client's own feed, and stores them as `visualPatterns` on the client. Wire the ALREADY-BUILT but dark `includeVisualPatterns` option on `research.pull` and make `artDirectionFor` (in the workflow) return these lines instead of `undefined`; the generated-image brief must stop falling back to the single line `"Style: realistic photography, natural lighting, clean composition."` (`packages/tools/karos-media/src/generate-image.ts:~396`). Bump the tool version when its prompt changes (the gate on main enforces this; PR #95 is the precedent).

R. **A scene brief instead of twelve words.** The copy prompt's `visualNeed` becomes a short scene brief (what is in frame, why it strengthens the claim) plus an explicit source choice: client upload / stock / generate / no image (device instead). The vetting and generation steps both read it. Keep the total prompt growth inside the cost table.

S. **Style lock for generated images.** One per-client generation style (from item Q) applied to every generated image in a run, plus a uniform renderer-side treatment (duotone / scrim / grain as the brand allows) so a set of images reads as one set. Deterministic, testable.

T. **Client media library.** Uploads stop being single-run attachments: they land in a per-client library with the `media.inspectImages` description (identity named, per 1.1.0), scene tags and `used_in` run ids, so a later post can draw on the archive and never reuses the same frame twice in a row. Reuse must respect the existing `ledger.listUsedImages` rules.

## Engine conventions
- Keep step ids stable where possible; Studio keys `stageModels` by agent class id. New agents need a class id, `prompts/<id>/1.md` + identical `latest.md`, `skillRef: "<id>@1"`, `resolveModelPolicy(...)`, **and an entry in `scripts/prompt-registry.ts`** (a fifth prompt-bump step CI enforces).
- Any change to a file under `packages/tools/` that declares `TOOL_VERSION` must bump it (see PR #95).
- `packages/workflow/__tests__/context-doc-policy-fixture.test.ts` feeds instagram router turns positionally; adding model steps breaks it. Use the named `standardTurns()` helpers and update that cross-package fixture.
- Chromium-gated render tests need `canvas.scale >= 2` (`validateRenderInputs` rejects 1) and self-skip without Chromium; CI has Chromium, so a render assertion there is real verification.
- Tests: `npm run build && npm run typecheck` at the root, then `npm test -w @agent-engine/agent-instagram -- --testTimeout=180000` plus every touched package. Also run `npm run check:tool-versions`, `check:prompts`, `check:config`. PRs get CI now (`.github/workflows/ci.yml` on `pull_request` to main), but the tool-version gate on a PR diffs the merge-base, so run it locally with `--base <previous main tip>`.
- Commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- After merge the owner must re-run `agent-middleware/scripts/generate_engine_stages.py --check` and seed new Studio stages; list every new/renamed step id and agent class id in the PR body.


---

# Part 2 - Technical spec

# Instagram agent — Phase 2 + Phase 3 FINAL SPEC (items L–T)

Lead architect's adjudication of `design-p23-A.md` (minimal-diff) and `design-p23-B.md` (quality-first), verified against the worktree `C:\Users\1\Documents\KarosLabs\agent-engine-instagram` at `fb69c48` (PR #94 merged).

Branches: `feat/instagram-phase2-templates` (PR-C, items L–P) cut from `origin/main`; `feat/instagram-phase3-images` (PR-D, items Q–T) stacked on C. Do not merge. Files are CRLF.

---

## 0. What I verified, and where each design was wrong

Both designs claimed a "verified" table. I re-read the code wherever they disagreed or a claim smelled. Fourteen findings changed the shape of this spec.

| # | Claim under test | Verdict | Evidence |
|---|---|---|---|
| 1 | A pure-Node PNG decoder already exists | **TRUE — both right.** `decodePngSamples`, `brand-logo.ts:258-410`: signature check, chunk walk, `zlib.inflateSync`, per-scanline unfilter with all five filter types incl. Paeth, colour types 0/2/3/4/6, bit depths 8/16, interlace refused, `MAX_LOGO_PIXELS = 16_000_000`. Private, fused to `QUANT_BITS = 4` colour binning at a `MAX_SAMPLES = 100_000` stride. **This is the "dependency already in the repo".** No `sharp`/`pngjs`/`jimp`/`canvas`/`pixelmatch` in any `package.json` — confirmed. | `brand-logo.ts:137-410` |
| 2 | B: a streaming row decoder holds "~17 KB live against 24.9 MB" | **MISLEADING.** The existing decoder does `zlib.inflateSync(Buffer.concat(idat))` — at 2160×2880 RGB that inflated buffer is ~18.7 MB **before** any unfilter output exists. Streaming rows removes the 24.9 MB RGBA *output* copy, not the inflate buffer. Real saving ≈ 25 MB, not 24.9 of 24.9. **Spec takes the row-callback API (B's shape) with `inflateSync` kept (A's simplicity), and states the true memory profile in the doc comment.** | `brand-logo.ts:312-318` |
| 3 | `canvas.scale` | **B right, A/brief loose.** `validateRenderInputs` returns a tooling error for anything **but exactly 2** — not `>= 2`. Every measured PNG is exactly 2160×2880; the grid maths is fixed, not assumed. | `render-carousel.ts:170-171` |
| 4 | The PNG buffer exists in-process once | **TRUE — both right.** `const buffer = await page.screenshot()` then `persistRenderedSlide`; with a `mediaStore` **no local file is written**. Measurement must ride the render. | `render-carousel.ts:348-351` |
| 5 | `playwright` is a `karos-publish`-only dependency (B) | **FALSE.** It is a dependency of `karos-landing`, `karos-media` **and** `karos-publish`. Immaterial to the design, but the claim was wrong. | three `package.json` |
| 6 | Registry tool count | **A right (62), B wrong (61).** `expect(names.length).toBe(62)`. PR-C adds **no** tool → stays 62. PR-D adds two → **64**. | `packages/tools/__tests__/cross-cutting.test.ts:111` |
| 7 | Studio templates should carry **new** `archetypeId`s (B) | **FALSE — a routing dead end, and the most important finding.** `templateForLayout` maps only the fixed layout enum to `LAYOUT_TEMPLATE_FILES` (`stat_callout → stat-callout.html`, …); `custom` maps to `templateFileName(archetypeId)` and requires model-authored `bodyHtml` that attempt. `materializeTemplates` writes `templateFileName(archetypeId)`, which is byte-identical to the `LAYOUT_TEMPLATE_FILES` values. **A studio row can only ever be picked if its `archetypeId` is one of the eight the layout enum knows.** B's "new ids never compete with bundled" would produce templates nothing can route to. **A's approach (same archetype ids, score below the bundled floor) is adopted.** | `slides-data.ts:27-38`, `materialize.ts:14`, `materialize.ts:83-101` |
| 8 | `approval: "pending"` + a new `materializeTemplates` filter (A) | **UNNECESSARY.** `resolveBest` already skips `!candidate.enabled`, and `enabled` is already on `TemplateDefinitionSchema` with `.default(true)`. **B's `enabled: false` until approval is adopted: zero change to `resolveBest`, zero new filter, the row still visible to the portal.** Also note `beats()`: on an equal score a `clientSlug`-scoped row wins, so a studio score must stay strictly below 70. | `composite-store.ts:70-86`, `types.ts:70-78` |
| 9 | `assertSafeMarkup` can gate a generated **cover** (A's item N gate 2) | **FALSE — A's item N is broken for covers.** `assertSafeMarkup` unconditionally refuses `{{html:...}}` and `{{image:...}}` in `bodyHtml`. A studio cover needs `{{image:hero}}`; a device slot needs `{{html:device}}`. **B's explicit opt-in `allowImageSlots`/`allowHtmlSlots` options are adopted** — run-authored custom archetypes keep today's stricter contract by passing no options. | `safety.ts:105-107` |
| 10 | Device CSS can ride the brand head fragment (A's item M) | **FALSE for brandless clients.** `buildBrandHeadHtml` only exists when `deriveBrandRenderTokens` returned tokens; a client with no kit gets no head fragment and would therefore get no device CSS. **Spec adds an explicit `extraHeadHtml` parameter to `composeDocument`/`composeRawDocument`/`materializeTemplates`, always passed, brand-independent.** | `brand-render-tokens.ts:463,718`, `materialize.ts:143,170` |
| 11 | A studio **manifest** via `WorkspaceStore.writeJson` (B) | **NOT AVAILABLE.** The workflow holds `options.templateStore?: TemplateStore` and `options.repoRoot` — there is **no** WorkspaceStore handle, and `client.writeBrief` is described in the registry test as "the registry's single writer". **The manifest is deleted from the design:** the store rows themselves (`derivedFrom`, `enabled`, `qualityScore`) are the record, and the setup-budget history goes to the beliefs document via the `memory.updateBeliefs` the workflow already calls. | workflow `:326,:522,:550`; `cross-cutting.test.ts` comment |
| 12 | Step placement: studio "after `00b3` and before `02j`" (B) | **IMPOSSIBLE.** Order on main is `00b-check-client-brief` (free read) → **`02j-plan-run-budget`** → `00b1` → `00b2` → `00b3`. `02j` is deliberately before the paid brief work. **The studio sits after `00b3` (so it reads a fresh brief), which is after `02j` — harmless, because it runs on its own meter and `02j` reads `meter.totalUsd` of the run meter only.** A's "`00b2` stays on the run meter, already priced by `briefRefresh`" is correct and kept. | workflow `:969,:1018,:1059,:1182,:1186` |
| 13 | "Four holds pinned by `zero-held-guarantee.test.ts`" (A) | **File exists; the count is three, not four.** Its header names: a human rejecting the batch review; no subject at all; research producing no schema-valid facts **or the copy/compliance self-checks never passing inside the retry budget**. The file's opening promise is "a carousel must never fail to ship **because of a picture**". **Adjudication: an interest-floor failure is a picture/layout problem, so it must not become a new hold — it returns while attempts remain and ships `degraded` on the last one (A's semantics), and a new case in that file proves it.** B's "it holds like any other self-check" is consistent with the code but inconsistent with the file's own promise and the owner's "always deliver". | `__tests__/zero-held-guarantee.test.ts:22-48` |
| 14 | Prompt/tool version facts | `instagram-copy` latest = **13**, `instagram-visual-qa` latest = **3** (B's "`instagram-visual-qa@2`" is wrong — that version already shipped), `instagram-image-vet` latest = **3**. `research/pull.ts` = **1.3.0** (`includeVisualPatterns` added in 1.2.0, **no caller** — verified). `generate-image.ts` = **1.0.1**; the registered tool name is **`image.generate`**, not `media.generateImage` (both designs used the wrong name). `inspect-images.ts` declares **1.0.0**, not the 1.1.0 the brief asserts — the identity-naming prompt is in the file at `:124` un-bumped, which is presumably what PR #95 fixes; **no comment or test in these PRs may assert 1.1.0 until #95 lands.** `karos-templates` declares **no** `TOOL_VERSION` anywhere → no bumps there. The gate only scans `defineTool({ name, …, version })` call sites, so a new `png.ts` needs no version. | `prompts/*`, `pull.ts:37`, `generate-image.ts:9,232`, `inspect-images.ts:10`, `scripts/tool-registry.ts:82` |

Two further mechanics confirmed and load-bearing: `returnToCopyWith(reason)` sets `lastSelfCheckReason` **and** `selfCheckSteer`, and `selfCheckSteer` is already handed to `05-write-copy-attempt-N` (`:3050-3053`, `:3079`) — **item L needs no new plumbing to reach the redraft**; and `08a2`'s `paletteGate` failure does a bare `continue` **without** `returnToCopyWith`, so the interest gate must use `returnToCopyWith` explicitly if its numbers are to reach the writer. The slide-downgrade set is named `downgradedForImagesThisAttempt: Set<number>` (`:3637`), not A's invented `coverLostToSourcing`.

**Pricing** (repo-verified, `run-budget.ts:72-112`): `copyAttempt` $0.12, `vetCall` $0.006, `visionInspectPerImage` $0.001, `relevance` $0.002, `fluency` $0.0055, `visualQa` $0.004, `scout` $0.012, `extraction` $0.0135, `generatedImage` $0.039, `scraperExecution` $0.007, `angle` $0.036, `brief` $0.113. Token rates: Sonnet 4.6 $3/$15 per 1M; Gemini 2.5 Flash $0.30/$2.50; Haiku 4.5 $1/$5.

---

# PART 1 — Phase 2 (PR-C)

## Item L — the visual-interest floor, measured on pixels

**Source: synthesis.** Measurement placement and the no-new-tool/no-new-hold posture from **A**; the two-clause rule, the DOM probe, the role split and the free deterministic re-layout from **B**.

### L.1 Where it lives

| File | New/changed | Contents |
|---|---|---|
| `packages/tools/common/src/png.ts` | **new** | `decodePngRows(bytes, onRow): PngHeader \| undefined` (row callback, one row live) and `decodePngPixels(bytes): DecodedPng \| undefined` (buffer convenience). Lifted from `decodePngSamples` — chunk walk, `inflateSync`, the five-filter unfilter — stopping before the colour binning. `node:zlib` only. `PNG_MAX_PIXELS = 16_000_000`. Undecodable/interlaced/16-bit-packed → `undefined`, never a guess. |
| `packages/tools/common/src/index.ts` | changed | re-export. |
| `packages/tools/karos-media/src/brand-logo.ts` | changed | `decodePngSamples` becomes a binning fold over `decodePngRows`. Behaviour-preserving; existing `brand-logo-*` tests are the pin. Declares no `TOOL_VERSION` → no bump. |
| `packages/tools/karos-publish/src/slide-metrics.ts` | **new** | `measureSlidePng(bytes, opts): SlideMetricsOutcome` + `SlideMetricsSchema`. Pure physics, **no thresholds**, no Instagram knowledge — adoptable by tiktok/linkedin/x as-is. |
| `packages/tools/karos-publish/src/render-carousel.ts` | changed, **`TOOL_VERSION 1.0.0 → 1.1.0`** | `measure?: boolean` and `probe?: boolean` inputs; `metrics?` and `probe?` on each `rendered[]` entry. Measurement runs on the in-hand screenshot buffer; the probe is one `page.evaluate` in the page already open. |
| `agents/instagram-agent/src/workflow/interest-floor.ts` | **new** | The thresholds, the per-role policy, `checkInterestFloor`, `interestSteerFor`, `formatInterestFailures`. Editorial policy for one channel, so it sits beside `visual-qa-pre-checks.ts`, not in a package. |
| `agents/instagram-agent/src/workflow/interest-relayout.ts` | **new** | `planInterestRelayout(...)` — the $0 remedy table. |

**No `publish.measureSlides` tool.** B's "second door" costs a registry-count change, a new `not_available` branch and a re-download path for a case that does not exist: with a `mediaStore` the PNG is never on disk (finding 4), and the studio's validation renders call `createRenderCarousel()` directly with `measure: true`. Registry stays at **62** in PR-C.

### L.2 The measurement

One decode pass over the exact 2160×2880 buffer (finding 3), folding each row into:

* **full-resolution counters** — `groundPixels`, `inkPixels`, `accentPixels`, `edgePixels` (4-neighbour ground/ink transitions);
* **a fixed `270 × 360` cell grid** — one cell = 4×4 design px = 8×8 screenshot px = 64 samples, 97,200 cells (the same order of work `brand-logo`'s `MAX_SAMPLES = 100_000` already does). Per cell: channel sums, sum of squares (→ stddev), a 5-bit-per-channel quantised colour set capped at 8 (→ `distinctColours`), ink count.

Fixed, never adaptive: the same PNG must always yield byte-identical numbers, the determinism contract `paletteForSlide`/`isVariationSlot` already state.

**Distance metric**: weighted RGB Euclidean `sqrt(2Δr² + 4Δg² + 3Δb²)/3` on the 0-255 scale. No colour-space dependency.

**Background colour**: the modal quantised mean over cells whose stddev is below `FLAT_CELL_STDDEV`. When the caller supplies `expected.ground` and it is within `FLAT_TOL` of that mode, the **expected** hex is used and `backgroundMatchesBrandGround: true` is reported. Anchoring matters (B's argument, adopted): on a full-bleed photo the modal colour is the photograph, and flat-share against a photograph's dominant tone is meaningless.

```ts
// packages/tools/karos-publish/src/slide-metrics.ts
export interface SlideMetrics {
  backgroundHex: string;
  backgroundMatchesBrandGround: boolean;
  flatBackgroundShare: number;      // full-res pixels within FLAT_TOL of backgroundHex
  inkShare: number;                 // full-res pixels beyond INK_DELTA of backgroundHex
  occupiedShare: number;            // cells with >=4/64 ink pixels or a non-ground mean
  largestEmptyRect: { x: number; y: number; w: number; h: number };  // DESIGN px (1080x1440)
  largestEmptyRectShare: number;
  imageryShare: number;             // cells: distinctColours >= 6 AND stddev >= 8/255
  graphicShare: number;             // cells: inkPixels >= 48/64 AND distinctColours <= 3
  imageryOrDeviceShare: number;     // imageryShare + graphicShare
  textShare: number;                // ink cells that are neither of the above
  accentShare: number;              // 0 when the caller supplied no accent
  accentPresent: boolean;
  edgeDensity: number;              // edgePixels / inkPixels
  quantisedColourCount: number;     // 5-bit colours holding >= 0.5% weight
  clippedEdgeShare: number;         // ink inside an 8-design-px band at any canvas edge
}
export type SlideMetricsOutcome = { ok: true; metrics: SlideMetrics } | { ok: false; reason: string };
```

`measureSlidePng` **never throws** — an undecodable buffer, >16 M pixels or interlaced data returns `{ ok: false, reason }`, and the caller degrades to "not measured".

`largestEmptyRect` is the maximal axis-aligned all-ground rectangle over the cell mask, by the classic histogram + stack sweep, O(cells). **This is the metric that names the owner's complaint**: "a large empty upper area" is one contiguous block, and a slide can pass a flat-share ceiling while carrying it because texture elsewhere dilutes the total.

Cost: ~6.2 M pixel visits ≈ 60–120 ms/slide in JS; 8 slides ≈ 1 s/attempt; a re-measure doubles it. **$0.** Live memory ≈ the 18.7 MB inflate buffer plus one row (~17 KB) — no 25 MB RGBA copy (finding 2).

### L.3 The DOM probe

`probe: true` adds one `page.evaluate` per slide, $0:

```ts
export interface SlideProbe {
  n: number;
  overflow: boolean;          // any element with scrollWidth/scrollHeight over its client box by >1px
  overflowing: string[];      // up to 6 selectors, for the steer
  offscreen: string[];        // boxes escaping the 1080x1440 canvas
  elementCount: number;
  textBoxShare: number;
  fontFamiliesUsed: string[]; // the resolved families actually in use
}
```

Kept from **B**, and it is not decoration: `headline-focus.html` and `stat-callout.html` size their display type from an **in-page `textContent.length` breakpoint** (verified: `headline-focus.html`'s `>60 → tiny`, `>32 → small`). Hebrew's different average glyph width means that breakpoint can pick a size that overflows with no pixel signature except a clipped edge. `fontFamiliesUsed` is also the first real proof that the Phase 0 script font *loaded*, rather than that its `<link>` was emitted.

### L.4 The thresholds

`agents/instagram-agent/src/workflow/interest-floor.ts`, each a named constant carrying its reasoning as a doc comment.

```ts
/** A slide's job in the sequence. Cover and closer are the grid thumbnail and the save moment. */
export type SlideRole = "cover" | "interior" | "closer";
```

| Constant | Value | Why this number |
|---|---|---|
| `FLAT_TOL` | `12` | Chromium AA plus the templates' own `color-mix(in srgb, var(--fg) 78%, transparent)` overlays put ground-adjacent tones a few units off ground. A headless 8-bit screenshot carries no dithering, so AA is the only noise source and it stays inside ±10. Cannot merge two brand neutrals: the derived ground/fg pairs are separated by ≥24 by the contrast floor's construction, and the bundled `#17181C`/`#F4F2EC` pair by 220. |
| `INK_DELTA` | `18` | Outside `FLAT_TOL`, so no pixel is both ground and ink; below the smallest deliberate tonal step in the token system. |
| `ACCENT_TOL` | `20` | An accent renders through `color-mix`/opacity in several places (`.stat-band`, `.eyebrow`, hairlines); measured only at 100% opacity it would under-count itself. |
| `FLAT_CELL_STDDEV` | `6/255` | A cell is flat when its 64 samples vary less than one AA step. |
| **`LARGEST_EMPTY_RECT_CEILING`** | **`0.28` interior / `0.22` cover & closer** | **Inherited, not invented** — B's best contribution. The legacy `DEAD-SPACE` rule the owner already accepted: "no empty horizontal band over 380px on a slide with no background photograph". 380/1440 = **0.264**; 0.28 is that restated as an area share with 6% slack for the 64px margin frame plus one line gap. Cover/closer tighten to 0.22. Today's `headline-focus.html` with a two-line headline measures **≈0.555** and the audit slides ≈0.61 — this clause alone fails them. |
| **`FLAT_BACKGROUND_CEILING`** | **`0.70`** (the brief's starting number, kept) | Deliberately **a trigger, not a verdict**. The bundled typographic archetypes at canonical copy sit roughly 0.62–0.88; a photo slide 0.05–0.20. 0.70 therefore sits *inside* the legitimate typographic range, and failing on it alone would kill a good Swiss type poster. It is half of clause D: above 0.70 the slide must prove it carries its frame another way. The audit slide is ≈0.93 **and** idle, which is what makes it a defect rather than a style. |
| **`OCCUPIED_SHARE_FLOOR`** | **`0.30` interior / `0.42` cover & closer** | Area occupied, not glyph ink: ink is typeface-dependent (a display face covers ~25–30% of its own text block, a body face ~12–18%), so an ink floor would be a hidden font-weight rule. 0.30 ≈ a full-width 432px band fully used — the editorial "third plus margins". The audit slide measures ≈0.18. **Pinned by L.7's calibration test with a required ≥0.08 margin over every bundled archetype**; an archetype that cannot clear its floor with margin is either a wrong constant or a genuinely boring template, and both outcomes are findings. |
| **`IMAGERY_OR_DEVICE_FLOOR`** | **`0.03`, cover & closer only** | The gap is large and the threshold only has to land inside it: full-bleed photo ≈1.0; scrimmed photo panel ≈0.45; the smallest legitimate device the bundled set can make (a 300px figure plus the 132×12 accent band) ≈0.04–0.06; a headline-only cover ≤0.01 (the band alone is 0.001 of the frame). Interior slides are **exempt** — one quiet all-type turn mid-carousel is good design. |
| `INK_SHARE_FLOOR` | `0.015` | **Not taste — render integrity.** A single 74px headline line alone measures ≈0.015–0.02; below that there is no readable content, meaning a font failed, a slot came through empty, or the screenshot caught the page early. Its message says "the render looks broken, not boring" and routes to a re-render, not a redraft. |
| `TEXT_SHARE_CEILING` | `0.55` | Above ~55% glyph-bearing cells the slide is a wall of text, illegible in feed. The opposite failure of everything else here, and cheap to catch. |
| `EDGE_DENSITY_FLOOR` | `0.06` | Cross-check: high ink with almost no edges is a solid wash, not content. **Reported as evidence, never gates alone.** |
| `ACCENT_MIN_SHARE` / `ACCENT_MAX_SHARE` | `0.0008` / `0.45` — **warn only** | 0.0008 ≈ the 132×12 band, the smallest accent moment the system intends: below it the accent did not paint, the accent-drift symptom Phase 0 chased structurally at `resolveSlideAccent`. Above 0.45 the accent has become the ground, sometimes deliberately. Both are facts + a ledger warn — brand furniture must never hold a run, the invariant `assessBrandAssetPresence` already states. |
| `CLIPPED_EDGE_SHARE_CEILING` | `0.004` | ≈6,200 px of ink inside the 8px bleed band — about one clipped line of body text. Below that, edge ink is a deliberate full-bleed element. |

**The rule** — `checkInterestFloor(metrics, probe, role)`, per slide, in this order. **The clause split is the whole argument**: a single flat-background ceiling either passes the audit slide at 0.93 or fails legitimate bold typography at 0.70. The defect is *flat **and** idle*, or *a hole*, and those are two different measurements.

* **A — integrity.** `inkShare < INK_SHARE_FLOOR` → `render-integrity`.
* **B — clipped.** `probe.overflow` or `clippedEdgeShare > ceiling` → `clipped`.
* **C — dead space.** `largestEmptyRectShare > ceiling(role)` → `dead-space`.
* **D — substance.** `flatBackgroundShare > FLAT_BACKGROUND_CEILING` **and** `occupiedShare < OCCUPIED_SHARE_FLOOR(role)` → `empty`.
* **E — cover/closer carries something.** `role !== "interior"` and `imageryOrDeviceShare < IMAGERY_OR_DEVICE_FLOOR` → `no-device`.
* **F — wall of text.** `textShare > TEXT_SHARE_CEILING` → `text-wall`.
* **Warnings, never failures:** accent out of band; `backgroundMatchesBrandGround === false`; `quantisedColourCount < 3`.

**One waiver**, mirroring `07h`'s: when this attempt downgraded a slide for want of a picture (`downgradedForImagesThisAttempt.has(slide.n)` — the real variable, finding 14), clause E is waived on that slide with the reason attached. A redraft cannot conjure a photograph the tiers could not find, and holding for it is exactly the "held because of a picture" this workflow promises never to do.

### L.5 Where it runs, and how the numbers reach the redraft

Inside `draftOnce`'s attempt loop, immediately after the render and **before every paid check** (`08a2`'s palette gate, `08a4` vision ≈$0.008, `08b` Flash $0.004), so a failure costs **zero model calls**:

```
08-render-carousel-attempt-N            (measure: true, probe: true)
  [08a-render-fallback-typographic]     existing content_fail path, unchanged
08a1-interest-floor-attempt-N           NEW  code, $0
  ├─ pass ───────────────────────────────────────────────► 08a2 …
  └─ fail
      08a1b-relayout-for-interest-attempt-N   NEW  code, $0   (at most once per attempt)
      08a1c-render-relayout-attempt-N         NEW  code, $0
      08a1d-interest-floor-recheck-attempt-N  NEW  code, $0
        ├─ pass ───────────────────────────────────────────► 08a2 …
        └─ fail ──► returnToCopyWith(<measured findings>); continue
```

**Stage 1 — the free remedy (`08a1b`), taken from B and the single best idea in either design.** A render is $0; a Sonnet redraft is $0.12. `planInterestRelayout(copy, selections, factCards, failures)` returns **at most one change per failing slide** from a fixed, tested table:

| Failure | Free remedy, in priority order |
|---|---|
| `no-device` on the cover | promote a vetted-but-unused image to the cover as `cover` → else build a `device` from the strongest `kind: "stat"` fact card → else the `colour-block` cover ground |
| `no-device` on the closer | build the recap strip from earlier slides' figures/titles → else a question block + accent rule |
| `dead-space` / `empty` | attach a `device` built from a figure already in that slide's own text → else switch `headline_focus`/`text_only` to the content-shaped archetype (`stat`→`stat_callout`, `quote`→`quote_card`, `items`→`list_takeaway`) → else raise `fontScale` one step |
| `text-wall` | drop `fontScale` one step; still over → move the body's last sentence to the caption |
| `clipped` | drop `fontScale` one step for the named element's slide |
| `render-integrity` | re-render once; a second failure is a `WorkflowToolingFailure`, not a content verdict |

Bounded to one pass, no loop. Recorded on the step and surfaced on the gate as `interestRelayout`, so a reviewer can see that code fixed something the writer got wrong.

**Stage 2 — the paid redraft, with the numbers.** `returnToCopyWith(...)` — which already writes `selfCheckSteer`, already handed to `05-write-copy-attempt-N` (verified) — so **the measured numbers reach the redraft through machinery that exists**. Two verbatim shapes:

> `slide 1 — an empty rectangle covered 41% of the plate (0,0 to 1080,590); the ceiling is 22% for a cover. A cover carries a photograph, a title card over a graphic ground, or a figure device — a headline on flat ground is not a cover. Give slide 1 a real visualNeed, or a device built from the strongest number in this post.`

> `slide 5 — 93% of the pixels were the background colour and only 18% of the frame was occupied (floor 30%). Either give this slide a device (figure, bars, before/after, timeline, versus) or merge it into slide 4 and let the carousel be one slide shorter.`

Three properties held deliberately: the measured number is in the sentence; the remedy names a mechanism the writer controls (`device`, `visualNeed`, archetype, merge), never an aesthetic; and the findings go three places — the copy input, the gate payload + deliverable (`interest: { perSlide, findings, relayout }`), and one ledger warn per failed attempt (`${runId}__interest-floor-a${attempt}`).

### L.6 Gate semantics — no fifth hold

```
if (floor.findings.length > 0) {
  if (attempt < maxAttempts) { returnToCopyWith(formatInterestFailures(floor.findings)); continue; }
  interestDegraded = floor;   // FINAL ATTEMPT: ship, flagged
}
```

* Attempts 1..n−1: **return to 05** with the numbers, after the free re-layout has been tried.
* Final attempt: **degrade and ship** (finding 13). `interestDegraded` rides the gate payload and the deliverable as `visualInterest`; one `ledger.appendEvent` warn names every failing slide and number; the workflow returns `{ status: "degraded", reason }` beside the existing budget marker. `zero-held-guarantee.test.ts` keeps asserting its **three** boundary holds and gains a case proving a permanently-failing floor **delivers**.
* `{ ok: false }` from the measurement **never fails** — a fact on the gate and a ledger warn. An undecodable PNG is a tooling oddity, not an editorial verdict.
* `meter.posture === "cheapest-path"` (past the hard max): measurement still runs (free), **escalation is suppressed**, the post ships `degraded` with the finding — `"interest floor: slide 5 measured 18% occupied (floor 30%) — over the run's hard max, shipped with the finding recorded rather than redrafted"`.
* `08b-visual-qa-attempt-N` receives `interest` for the shipped attempt and grades **only the residue** it can add (does the sequence have rhythm) — the residue pattern `checkDefaultRenderRules`/`08a2` already established.

### L.7 Tests

| Test | File | Pins |
|---|---|---|
| Decoder equivalence | `packages/tools/common/__tests__/decode-png.test.ts` (new) | Hand-built PNGs for colour types 0/2/3/4/6 at both bit depths, each with all five filter types on different rows, against expected pixels; interlaced → `undefined`; truncated IDAT → `undefined`, never partial; >16 M pixels refused. |
| `brand-logo` unchanged | existing `brand-logo-*` tests | The lift is behaviour-preserving. |
| The instrument can fail | `packages/tools/karos-publish/__tests__/slide-metrics.test.ts` (new, Chromium-free, synthetic PNGs via `zlib.deflateSync`) | **The audit slide, synthesised:** 2160×2880 uniform `#17181C` with one 1080×300 block low → `flatBackgroundShare ≥ 0.90`, `occupiedShare ≤ 0.22`, `largestEmptyRectShare ≥ 0.5`, `imageryOrDeviceShare ≈ 0`. Plus: full-frame noise → `imageryShare ≥ 0.9`; half solid accent → `graphicShare ≈ 0.5`, low `edgeDensity`; two known holes → the larger rect returned with exact design-px x/y/w/h; `expected.ground` supplied over a photo modal → `backgroundMatchesBrandGround: false`; undecodable → `{ ok: false }`, no throw; the same PNG twice → byte-identical numbers. |
| Every clause fires alone | `agents/instagram-agent/__tests__/interest-floor.test.ts` (new, pure) | Hand-built `SlideMetrics` per clause; every threshold's boundary asserted at ±0.001; **a bold type poster (flat 0.82, occupied 0.46, no device, role `interior`) PASSES**, and the same metrics at role `cover` fail clause E only; `interestSteerFor` carries the measured percentage, the threshold and the slide number for every kind; `planInterestRelayout` picks the documented remedy per kind, at most one change per slide, and nothing when no free remedy exists. |
| **Calibration — the number-setting test** | `agents/instagram-agent/__tests__/interest-floor-calibration.test.ts` (new, `describe.skipIf(!isChromiumInstalled())`, `canvas.scale: 2`) | Renders all **eight** archetypes (six bundled + `cover` + `closer`) at short/medium/long copy plus a device-bearing variant through the real `createRenderCarousel()`, asserts each **passes its role's floor with margin ≥ 0.08**, and `console.log`s the measured band table the constants cite. One asserted exception: `headline_focus` **fails** the cover role and passes as interior — the pixel proof of the existing `default:cover-carries-device` rule. Also: a Hebrew render of `cover`/`stat_callout`/`list_takeaway`/`closer` (`dir="rtl"`, the Heebo/Assistant stack) passes with `probe.overflow === false`, `probe.fontFamiliesUsed` containing `Heebo`, `textShare > 0` (glyphs painted, not tofu); a real hero slide passes with `imageryShare ≥ 0.5`; a hero pointing at a 1×1 transparent PNG → `imageryOrDeviceShare < 0.03` → `no-device` (the prep defect that had no symptom now has one). CI has Chromium, so this is real verification. |
| Workflow gate | `agents/instagram-agent/__tests__/interest-floor-step.test.ts` (new, fake router) | Failing metrics injected through `fakeRenderCarousel(realTool, { metrics })`: `08a1`/`08a1b`/`08a1c`/`08a1d` present, **zero extra copy turns** when the free re-layout fixes it, gate payload carries `interestRelayout`. Unfixable → `05-write-copy-attempt-2` exists and its checkpointed input's `selfCheckSteer` contains the slide number, the measured share and the word "flat". `08a4`/`08b` turns consumed = passing attempts only (the zero-model-call claim). `posture: "cheapest-path"` seeded → delivers `degraded`, no attempt 2. `{ ok: false }` → delivers, ledger warn, no hold. |
| A permanent floor failure DELIVERS | `agents/instagram-agent/__tests__/zero-held-guarantee.test.ts` (changed) | Failing metrics on every attempt → status `completed`/`degraded`, `visualInterest` on the deliverable, a ledger warn — **not** `held`; the three boundary holds still assert. |

**`fakeRenderCarousel` change** (`test-helpers.ts`): gains an options bag `{ metrics?: (slide) => SlideMetrics; probe?: (slide) => SlideProbe }` and, by default, returns **passing** metrics for its 1×1 PNG. Without this every one of the ~30 workflow fixtures would fail the floor (a 1×1 PNG measures 100% flat — verified: `MINIMAL_PNG_BYTES` is a 1×1). One signature change in one helper keeps every fixture byte-identical, and the option is what makes the gate test real.

### L.8 Risks

1. **The thresholds fail a bundled archetype on day one — they do, `headline_focus`.** Deliberate, and the reason item M's ground rework ships in the same PR. The calibration test prints the numbers so the fix is measured, not argued. **Standing rule: a failing bundled archetype is a template bug, never a threshold to loosen.**
2. `graphicShare` counts a big numeral's stroke interiors as "device" — intended, but a heuristic. Named in the doc comment; `07h`, which knows the archetype, remains the semantic half. The pixels measure; the structure classifies.
3. Grid quantisation rounds `largestEmptyRect` to 4 design px. Stated so nobody debugs a 3px discrepancy.
4. One extra render per failing attempt. Compute, not money; noted in the PR body.
5. A genuinely minimal poster fails the floor → ships `degraded` with the numbers visible, and the constants live in one file with a calibration harness precisely so they can move on evidence.

---

## Item M — cover and closer archetypes, plus a device library

**Source: synthesis.** Both designs agreed on the shape. B's structural insight (`cover` is *incapable* of being a headline on flat ground) and its degrade-target fix; A's token-driven ground rework of `headline-focus.html`; my correction of the CSS delivery channel (finding 10) and of the render-rule inventory (`default:cover-carries-device` and `default:closer-carries-cta` **already exist** — B proposed adding rules that are there).

### M.1 The two archetypes

**New** `agents/instagram-agent/assets/templates/default/cover.html` and `closer.html`.

**`cover`** — `layoutType: "photo"`. Slots `eyebrow`, `title`, `subtitle`, `image:hero`, `html:device`, plus the standing furniture (`accentColor`, `dir`, `fontScale`, `textAlign`, `brandHandle`, `seriesBadge`, `kicker`). Structure: a **ground layer** in priority order — full-bleed `<img class="hero" onerror="this.remove()">` → an accent `colour-block` with a token-derived diagonal keyline → a two-token gradient; a **scrim that sits only where the text sits** (bottom 52%, fading to fully transparent — the legacy hard rule, so the rest of the photograph stays a photograph); then a bottom-anchored, left-aligned eyebrow/title/subtitle lockup with an optional device in the elastic middle. With no hero and no device the colour-block ground plus keyline still puts `imageryOrDeviceShare` ≈ 0.25 — **structurally incapable of being the defect the owner named**.

**`closer`** — `layoutType: "typographic"`. Slots `takeaway`, `cta`, `question`, `html:recap`. A recap strip of 2–4 mini plates (built **by code** from the carousel's own earlier slides' figures/titles), the takeaway in the display face, a CTA/question line with an accent rule.

**Changed, minimally:**

* `types.ts` — `InstagramSlideLayoutSchema` gains `"cover"`, `"closer"`. Both inherit `resolveLayout`'s once-per-carousel rule for free, which is correct by nature.
* `slides-data.ts` — `LAYOUT_TEMPLATE_FILES` gains `cover: "cover.html"`, `closer: "closer.html"` (which extends `ARCHETYPE_TEMPLATE_FILES` automatically); `contentFor` gains both cases; `resolveLayout` gains their content requirements (`cover` needs a hero image **or** a device; `closer` needs a recap-able earlier slide **or** a question/CTA **or** a device).
* **The degrade target changes (B's highest-leverage point, adopted).** `resolveLayout`'s fallback becomes `fallbackArchetypeFor(slide, index, lastIndex)`: `stat` → `stat_callout`, `quote` → `quote_card`, `comparison` → `comparison_card`, `items` → `list_takeaway`, a hero image → `photo`, slide 1 → `cover`, last slide → `closer`, else `headline_focus`. `text_only` remains **only** when the slide truly has nothing but a headline and a body. Today every degrade path converges on `text_only`, which routes to the client's own `slide.html` with no image — i.e. the grey screen. A degrade must not land on the defect.
* `packages/tools/karos-templates/src/bundled-store.ts` — `BUNDLED_ARCHETYPES` gains `{ file: "cover.html", archetypeId: "cover", name: "Cover", photo: true }` and `{ file: "closer.html", archetypeId: "closer", name: "Closer", photo: false }`.
* `packages/tools/karos-templates/src/safety.ts` — `LEGACY_ARCHETYPE_IDS` gains `"cover"`, `"closer"` (the collision guard must know them, or a `custom_` archetype could overwrite one mid-run — the exact hazard `validateCustomArchetypes` already documents).
* `visual-qa-pre-checks.ts` — `DEVICE_TEMPLATE_BASENAMES` gains `cover`, `closer`; `default:cover-carries-device`'s and `default:closer-carries-cta`'s **existing** texts are extended to name the new archetypes.

### M.2 The device library — typed copy in, code-built markup out

`assertSafeMarkup` refuses `{{html:...}}` from model content, and that split is what keeps a copy field from being an injection point. So devices are **never** model-authored HTML: they are a typed object on the slide copy rendered by a first-party fragment builder — the exact pattern `list_takeaway`/`buildListRows` already uses (`slides-data.ts:388,580`).

**New** `agents/instagram-agent/src/workflow/slide-devices.ts`:

```ts
export const SlideDeviceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("figure"),      value: z.string().min(1).max(12), label: z.string().min(1).max(80), source: z.string().min(1).max(120) }),
  z.object({ kind: z.literal("figure_pair"), before: z.object({ value: z.string().max(12), label: z.string().max(40) }),
                                             after:  z.object({ value: z.string().max(12), label: z.string().max(40) }), source: z.string().min(1).max(120) }),
  z.object({ kind: z.literal("bars"),        max: z.number().positive().optional(),
                                             rows: z.array(z.object({ label: z.string().min(1).max(40), value: z.number(), display: z.string().min(1).max(12) })).min(2).max(5),
                                             source: z.string().min(1).max(120) }),
  z.object({ kind: z.literal("timeline"),    points: z.array(z.object({ at: z.string().max(12), what: z.string().max(60) })).min(2).max(4) }),
  z.object({ kind: z.literal("versus"),      left:  z.object({ label: z.string().max(40), body: z.string().max(120) }),
                                             right: z.object({ label: z.string().max(40), body: z.string().max(120) }), winner: z.enum(["left","right","neither"]) }),
  z.object({ kind: z.literal("unit_grid"),   filled: z.number().int().min(1).max(99), of: z.literal(100), label: z.string().max(80) }),
]);
export type SlideDevice = z.infer<typeof SlideDeviceSchema>;

export function buildDeviceFragment(device: SlideDevice, dir: "ltr" | "rtl"): string;  // pure, escaped
export function deviceCssBlock(): string;                                             // one <style> body
export function validateDevice(device: SlideDevice): { ok: true } | { ok: false; reason: string };
export const DEVICE_VALUE_INSIDE_BAR_THRESHOLD = 0.72;
```

`InstagramSlideCopySchema` gains `device: SlideDeviceSchema.optional()`, available on **every** archetype; `contentFor` emits `htmlFragments.device` when present.

Engineering rules carried across from the legacy `_cf-devices` reference (**rules only, no code or CSS ported**):

| Rule | Where enforced |
|---|---|
| A figure never breaks mid-number | CSS `white-space: nowrap` on `.dv-figure` |
| Length-based autosize, three steps | **In code** (`value.length <= 3 → big`, `<= 6 → mid`, else `small`) rather than an in-page script: we already hold the string, and one fewer in-page script is one fewer thing to race the screenshot |
| Labels wrap **beneath**, in the text face | `.dv-label { font-family: var(--f-body); text-wrap: pretty }`, never the mono/label face |
| A device label is a compact figure, ≤12 chars | schema `max(12)` on every `value`/`display` — the "about 50 to 60%" overflow defect becomes unrepresentable |
| A bar's value rides **inside** the bar at ≥72% of its track | `buildDeviceFragment` emits `dv-bar--inset` and moves the value span inside the fill |
| Complementary shares never fill the whole track | `max` defaults to 100 when rows sum to ≈100; otherwise `max = 1.15 × max(value)`, so no bar ends flush |
| One accent per device | exactly one row/point/unit carries `var(--accent)`; the rest `color-mix(in srgb, var(--fg) 22%, transparent)` |
| Every figure names its source | schema **requires** `source` on `figure`/`figure_pair`/`bars`; `checkSlidesData`'s existing verbatim `sourceRef` trace extends to `device.source` |
| An illustrative device says so | `timeline`/`unit_grid` without a source render a `.dv-note` reading "illustrative, not measured", localised through the target-language table |

**RTL and script fonts.** **Logical properties only** — `margin-inline-*`, `padding-inline`, `inset-inline-*`, `border-inline-start`, `text-align: start`; never `left`/`right`. `dir="rtl"` then mirrors the whole device with no second stylesheet. Every size is `calc(Npx * var(--ts, 1))`, which composes with both the reviewer's `body.ts-s/ts-l` classes and `script-fonts.ts`'s per-script `typeScale` (Hebrew 0.94, Arabic 0.92 — verified) — the composition trap RFC-13 §0 flagged.

**How the CSS reaches the documents (finding 10 — both designs got this wrong).** Not via the brand head fragment: `buildBrandHeadHtml` is absent for a client with no brand kit, so devices would silently lose their CSS on exactly the brandless clients. Instead, `composeDocument`, `composeRawDocument` and `materializeTemplates` gain an **`extraHeadHtml?: string`** parameter, spliced immediately before `</head>` **after** the template's own `<style>` (so it wins ties, the rule `materialize.ts` already relies on) and **before** `brandHeadHtml` (so a brand kit still beats the shared device sheet). The workflow always passes `deviceCssBlock()`. `composeCustomArchetypeDocument` passes it too, so custom archetypes and the `-inv` variants get devices as well.

### M.3 The "no bare ground" rework — the actual fix for the grey screen

`headline-focus.html` (and `cover.html` by construction) gain a **token-driven ground**, CSS only, no new slots, so nothing upstream changes:

* a large, very-low-contrast display-face glyph field bleeding off the top-left at `color-mix(in srgb, var(--fg) 6%, transparent)`, **or**
* an accent geometric field: a 3px hairline grid at `color-mix(in srgb, var(--fg) 8%, transparent)` plus one solid accent block anchored to a frame edge.

Chosen per slide by the **existing** seeded low-discrepancy walk `isVariationSlot(index, mix, seed)` (`slides-data.ts:114`), so the choice is deterministic per run, varies across runs, and never lands two identical grounds back to back — **no new randomness mechanism**. This is what takes `headline_focus` from `flatBackgroundShare 0.88 / largestEmptyRectShare 0.555` to roughly `0.55 / 0.30`, i.e. through item L's floor. The calibration test is the proof.

### M.4 A leading figure must be a device

`default:numbers-are-devices` currently accepts only `stat-callout`/`comparison-card`, and `resolveLayout` allows each once per carousel — which is why the rule text has to end with the apologetic "every other numeric fact leads with the noun." With `device` on any archetype that limit disappears: **`FIGURE_TEMPLATE_BASENAMES` is replaced by a per-slide "does this slide carry a `device` whose figure matches the leading token"** check, and the apologetic clause is deleted.

### M.5 Prompts, model, cost

`instagram-copy@14` (new `prompts/instagram-copy/14.md` + byte-identical `latest.md`, H1 `v14`, `skillRef: "instagram-copy@14"`, `scripts/prompt-registry.ts` versions gain `"14"`, `latestVersion: "14"`). Added: §7 gains `cover`/`closer` (eight archetypes) and the two hard placements — **slide 1 is `cover` or `photo`, the last slide is `closer`**; a new §19 "Devices: every figure gets one" with the six shapes and the ≤12-char rule; §16 gains what to do with an `interest:` finding; §20 the custom-archetype licence (item O); §21 the skeleton avoid-list (item P). Net token growth ≈ +1.25k in / +0.15k out.

**No new model step in a run.** Devices are typed copy from the existing Sonnet draft; markup is code. Marginal run cost is prompt growth only: **+$0.006/attempt**.

### M.6 Tests

* `__tests__/slide-devices.test.ts` — every kind's fragment: escaping; the `big/mid/small` autosize table; the ≥72% inset-bar switch at 0.71/0.72; exactly one accent element per fragment; complementary rows normalising to `max: 100`; `bars` refused when a single row would fill the track; a 13-char `display` refused by the schema; an illustrative device carrying the note.
* `__tests__/slide-devices-rtl.test.ts` — source-scan `deviceCssBlock()` and every emitted fragment for physical `left:`/`right:`/`margin-left`/`padding-right` → none (the same source-pinning shape `default-template-render.test.ts` already uses for colour and font literals).
* `__tests__/slides-data.test.ts` (changed) — `cover`/`closer` resolve and route to the right file; a `cover` with neither hero nor device degrades via `fallbackArchetypeFor`, **not** to `text_only`; a second `closer` degrades; a `device` on a `photo` slide reaches `htmlFragments.device`; the full `fallbackArchetypeFor` table.
* `__tests__/default-render-rules.test.ts` (changed) — a leading figure on *any* archetype passes with a matching device and fails without one; the cover and closer rules name the new archetypes.
* `packages/tools/karos-templates/__tests__/` (changed) — `extraHeadHtml` splices after the template's own `<style>` and before `brandHeadHtml`; a brandless client still receives it; `LEGACY_ARCHETYPE_IDS` contains `cover`/`closer` so a `custom_` collision is impossible.
* Source pinning — `cover.html`/`closer.html` carry no bare `font-size:` literal, no `#17181C`/`#F4F2EC` literal, no physical direction property.
* Calibration (L.7) covers the real Chromium renders, LTR and RTL.

### M.7 Risks

Two more files duplicate the ~20-line token block (the known debt `materialize.ts` names). Devices could over-fire — bounded by `resolveLayout`'s once-per-archetype rule, item P's skeleton check, and §19's explicit "the post's key figure MUST get one; a passing mention need not". Hebrew figure autosize steps are a first estimate and the calibration test is what will move them.

---

## Item N — Template Studio: 4–6 templates per client at setup

**Source: synthesis.** A's `00b`-lifecycle shape, honest-signals ranking and evidence schema; B's `enabled: false` approval mechanism (finding 8), `buildStudioTemplateDocument` + `assertSafeMarkup` allowlist (finding 9), one-call-per-template isolation, and the invented-metrics assertion. My corrections: same archetype ids (finding 7), no manifest (finding 11), placement after `00b3` (finding 12).

### N.1 Steps

Placed **after `00b3-persist-client-brief`** (so the studio reads a fresh brief, the brand kit from `02c` and the target language from `02d`) and before `03-claim-topic`. Gated on "does this client already have a studio set", so a normal run consumes none of it.

| Step id | Kind | What |
|---|---|---|
| `00c-check-template-studio` | code | `templateStore.list({ clientSlug })` → `reuse` / `generate` / `awaiting-approval`. `generate` when there are no client-scoped studio rows, or every row is older than `STUDIO_TTL_DAYS = 120`, or `wf.input.refreshTemplates === true`. Free store read. |
| `00c1-plan-setup-budget` | code | `planSetupBudget(shape, history)` before the first paid setup call. Never fails (N.5). |
| `00c2-gather-format-evidence` | code | ScrappyCoco only: `research.socialHistory({ accounts: brief.referenceAccounts.slice(0,6), window: "24h" })` (same cache `03e`/`04e` use, so usually warm), `research.fetchPages` over ≤3 pages of the client's own site (cached from `00b1` on a refresh run), `media.inspectImages` over ≤12 top-ranked reference-post images. Then `rankReferenceFormats()`. Names every problem, invents nothing. |
| `00c3-write-design-brief` | **agent** `instagram-design-brief` (Sonnet) | The format thesis: which 4–6 archetype roles this client should run, each tied to a measured format, plus the set rules (type roles, accent discipline, ground policy). One document every designer call reads. |
| `00c4-design-template-<archetypeId>` | **agent** `instagram-template-designer` (Sonnet), 4–6 calls | Authors **one** template's `bodyHtml` + `css` + `sample` + `derivedFrom`. One call per template, not one for the set: full attention each, and a schema failure costs one template instead of six. |
| `00c5-validate-template-<archetypeId>` | code | The eight-gate battery (N.3). $0. |
| `00c6-review-template-set` | **agent** `instagram-template-set-review` (Flash) | Reads the `media.inspectImages` descriptions of the rendered samples plus their measured metrics; returns per-template `keep`/`repair`/`drop` and one set-level note on whether the set reads as one system. |
| `00c7-repair-template-<archetypeId>` | **agent** `instagram-template-designer` (Sonnet), ≤2 total | One repair per template, input carrying the failing gate id and its **measured numbers** verbatim. |
| `00c8-store-template-set` | code | `promoteTemplate(...)` per survivor, `enabled: false`, `qualityScore: 65`. |

### N.2 Reading what actually performs — and saying what was missing

`research.socialHistory` returns `engagement { likes?, comments?, views? }` and only for `x`/`instagram`/`reddit`/`tiktok` (verified; `ClientBriefSchema.referenceAccounts` already refuses LinkedIn/YouTube for exactly this reason). So the ranking must be honest about what it had:

```ts
// agents/instagram-agent/src/workflow/template-studio.ts (new)
export interface FormatEvidenceRow {
  format: string;                                       // the ranker's own label
  accounts: string[];
  postCount: number;
  /** Per-account z-normalised engagement, mean across accounts. ABSENT when no numeric field existed. */
  normalisedScore?: number;
  signalsAvailable: Array<"likes" | "comments" | "views">;   // exactly what was present
  signalsAbsent: string[];                                   // named: "views absent for 4 of 6 accounts"
  exampleUrls: string[];
}
export function rankReferenceFormats(posts: readonly SocialHistoryPost[]): { rows: FormatEvidenceRow[]; notes: string[] };
export function assertNoInventedMetrics(citation: string, evidenceBlock: string): { ok: true } | { ok: false; reason: string };
```

Normalisation is **per account** (z-score of that account's own posts) before averaging — absolute likes across accounts of different sizes is not a comparison. With no numeric field anywhere, the row carries no `normalisedScore` and the note says the ranking is qualitative. **No invented metrics** is enforced twice: `normalisedScore` is optional while `signalsAbsent` is required, and `assertNoInventedMetrics` (B's contribution, adopted) refuses any numeric claim (`\d+(\.\d+)?\s*(%|x|k|m)?`) in a `derivedFrom.why` that does not appear verbatim in the evidence block handed to the model.

Every stored row records what justified it — two additive optional fields on `TemplateDefinitionSchema`:

```ts
derivedFrom: z.object({
  formatLabel: z.string().min(1),
  accounts: z.array(z.string()).default([]),
  postCount: z.number().int().nonnegative(),
  normalisedScore: z.number().optional(),
  signalsAvailable: z.array(z.string()).default([]),
  signalsAbsent: z.array(z.string()).default([]),
  exampleUrls: z.array(z.string()).max(6).default([]),
  why: z.string().min(1).max(400),
}).optional(),
role: z.enum(["cover", "interior", "closer"]).optional(),   // the interest-floor role this template is judged at
```

`enabled` is **not** added — it already exists with `.default(true)`, so every bundled and promoted row keeps its behaviour byte-identically.

### N.3 The eight gates — a template cannot be stored until it renders and measures

Run in `00c5`, cheapest first, all deterministic, every failure named **with its number**:

1. **Archetype id.** Must be one of the **eight routable ids** (`cover`, `closer`, `stat_callout`, `quote_card`, `comparison_card`, `list_takeaway`, `headline_focus`, `photo`) — finding 7. A studio row is a *better implementation of a routable archetype for this client*, never a new id nothing can route to. At most one row per (client, archetypeId).
2. **Slot contract.** `extractSupportedFields(bodyHtml + css)` ⊆ declared slots ∪ standing furniture; every declared slot appears in the markup; the `sample` fills every declared slot; every extracted name is one `contentFor` can actually supply (a new `KNOWN_SLOT_NAMES` set derived from `contentFor`'s own outputs plus `device`). A template asking for `{{figure}}` on an archetype that never supplies one is refused — the defect `supportedFields` exists to expose.
3. **Safety, with the opt-in allowlist.** `assertSafeMarkup(bodyHtml, css, slots, { allowImageSlots, allowHtmlSlots })` — `allowImageSlots: ["hero"]` only when the declared ground is `image`; `allowHtmlSlots: ["device"]` / `["recap"]` only when that slot was declared. Everything else unchanged, so run-authored custom archetypes (item O) keep today's stricter contract by passing no options. **Without this, a generated cover cannot exist (finding 9).**
4. **Code owns the document.** `buildStudioTemplateDocument({ bodyHtml, css, ground, canvas })` in `karos-templates/src/safety.ts`, a generalisation of `buildCustomArchetypeDocument`: doctype, head, font links, the `:root` token block, reset, the fixed 1080×1440 canvas, the `ts-*`/`ta-*` classes, the ground layer, and **the `window.__CAROUSEL_READY__` script**. The model authors a fragment and a stylesheet, never a document — the boundary `assertSafeMarkup`'s own doc comment already argues for.
5. **A real Chromium render** of the sample through `createRenderCarousel()` at `canvas.scale: 2` (anything else is refused — finding 3), `measure: true`, `probe: true`. Sample content comes from the template's declared slots **filled by code**, never by the model, so a template cannot pass by being handed flattering copy.
6. **The item-L interest floor** at the template's declared `role`, with a **calibration margin of ≥0.05** — tighter than a run's 0, because a template is a standing asset. *This is the join that answers the owner's complaint: a generated template that is boring is refused at generation, not discovered in production.*
7. **Contrast + palette.** `assessContrastFacts` over the token pairs the sample paints and `checkPaletteWithinKit` over painted accents. Below floor → repair, not store.
8. **RTL + script fonts** when the client's target language is non-Latin: a second render with `dir="rtl"` and the `script-fonts.ts` head; must clear the floor, `probe.overflow === false`, and `probe.fontFamiliesUsed` must contain the script family. A template that renders Hebrew as tofu is refused.

Failure → **one** repair (`00c7`, findings verbatim) → **drop**, recorded as a note: *"5 templates stored, 1 dropped (cover: occupied 0.31 against a 0.42 floor after one repair)"*. A dropped template never fails setup; the bundled floor is always there.

### N.4 Storage, score, approval

* `promoteTemplate({ store, archetypeId, name, htmlTemplate: buildStudioTemplateDocument(...), cssStyles: css, layoutType, source: "ai_generated", clientSlug, enabled: false, qualityScore: 65, derivedFrom, role, actor: "studio", note })`. `promoteTemplate` gains an optional `qualityScore` override and an optional `enabled` — it currently seeds from `DEFAULT_QUALITY_BY_SOURCE` with no override.
* **Score 65, and it must be strictly below 70.** Studio rows reuse routable archetype ids, so `resolveBest` **does** put them head-to-head with a bundled row of the same id. 65 sits below the bundled floor of 70, so a per-client generated design never silently displaces a design whose rendering has been verified across the fleet; and above `DEFAULT_QUALITY_BY_SOURCE.ai_generated` (40), which prices an *unvalidated* run-authored fragment, because a studio row has passed a real render, the interest floor with margin, contrast and (where relevant) RTL. Note `beats()`: on an **equal** score a `clientSlug`-scoped row wins, which is exactly why 70 would be wrong. New constant `DEFAULT_QUALITY_STUDIO = 65` in `karos-templates/src/types.ts` carrying this paragraph.
* **Approval is `enabled` (finding 8).** `resolveBest` already skips `!enabled` — so **until the portal approves, the bundled set is used**, with zero new filters and zero change to `materializeTemplates`, and the row still exists for the portal to show. Approval rides the **existing** gate: the first run after a studio build carries `templateStudio: { templates: [{ templateId, archetypeId, role, derivedFrom, measured, sampleUrl }], signalsAvailable, signalsAbsent, dropped, setupBudget }` on the `09a-batch-review` payload; the reviewer's existing `templateFeedback` entry with `verdict: "approved", promote: true` on a studio `templateId` calls a new `setTemplateEnabled(store, id, true, actor, note, now)` in `promote.ts` (a store write plus a feedback entry — the same mechanism, not a new one). `verdict: "revise"` → `reviewTemplate` as today: −15, row stays disabled, two revises and it stops being picked.
* **No manifest file (finding 11).** The store rows are the record. The setup-budget history goes to the beliefs document under `SETUP_BUDGET_BELIEF_KEY` through the `memory.updateBeliefs({ diff })` call `09b` already makes.

### N.5 The setup budget — separate, and it adapts

**Changed** `agents/instagram-agent/src/workflow/run-budget.ts` (same file, so no new module and no new import graph):

```ts
export const TARGET_SETUP_SPEND_USD = 2.0;
export const MAX_SETUP_SPEND_USD = 3.0;
export const SETUP_BUDGET_BELIEF_KEY = "instagramSetupBudget";

export const SETUP_STEP_COST_ESTIMATES_USD = {
  designBrief:     0.042,  // Sonnet ~8k in / 1.2k out — one thesis every designer call reads
  templateDesign:  0.051,  // Sonnet ~7k in / 2.0k out — authors HTML+CSS+sample that must render, in the client's script
  templateRepair:  0.048,  // Sonnet ~6k in / 2.0k out, at most two per setup
  setReview:       0.004,  // Flash ~6k in / 1k out — grades rendered samples it can see described
  sampleInspect:   0.001,  // Flash vision, one look per rendered sample
  formatMap:       0.008,  // Flash ~12k in / 1.5k out — names formats over numbers code already computed
  artDirection:    0.042,  // Sonnet ~8k in / 1.2k out (item Q)
  visualPatterns:  0.033,  // media.ingestVisualPatterns, consent-gated (item Q)
  scraperExecution: 0.007, // ScrappyCoco, cache shared with 00b1/03e
} as const;

export interface SetupShape { templates: number; repairs: number; referenceAccounts: number; sitePages: number; referenceImages: number; setReview: boolean; visualDirection: boolean; }
export interface SetupBudgetPlan { templates: number; repairsAllowed: number; referenceImages: number; setReview: boolean; visualDirection: boolean; }
export function planSetupBudget(shape: SetupShape, history?: SetupBudgetHistory, options?: { spentUsd?: number }): SetupBudgetDecision;
export function summarizeSetupBudget(d: SetupBudgetDecision, m: RunSpendMeter, notes: readonly string[]): SetupBudgetSummary;
```

`RunSpendMeter` gains **one optional constructor argument** — `new RunSpendMeter({ targetUsd, maxUsd })`, defaulting to the run constants (verified: `canAfford`/`overTarget`/`crossedMax` read the module constants today). Every existing `new RunSpendMeter()` call site is unchanged; setup gets its own meter, its own posture, its own lines. The run meter never sees setup spend, so `02j`'s `spentUsd: meter.totalUsd` is unaffected regardless of ordering (finding 12).

**Levers, in order** — budgets adapt, never hold; the brief's rule is "fewer templates rather than failing":

1. `referenceImages` 12 → 6 → 0 (the format map then ranks from text only, and says so).
2. `setReview` off.
3. `templates` 6 → 5 → **4** (never below 4 before the hard max: "two formats is not a menu").
4. `repairsAllowed` 2 → 1 → 0.
5. `visualDirection` off (item Q deferred to the next setup, recorded as a note).
6. `templates` 4 → 3 → 2, **only past the hard max**, with the note "generated N templates instead of 4 on the cheapest complete path".

**Setup never fails and never holds.** No scraper, no reference accounts, a malformed designer turn, a template failing all eight gates — each becomes a `ledger.appendEvent` warn, `00c8` stores whatever passed (possibly nothing), and the run continues on the bundled set. Reported exactly as a run is: `setup.budget` on the gate payload and the deliverable (estimate, actual, plan, adaptations, per-step lines), one ledger row carrying `estimateVsActualLine`, and history to `SETUP_BUDGET_BELIEF_KEY` so the next setup starts calibrated.

### N.6 The three new agents

```ts
// src/agent/instagram-design-brief-agent.ts
id: "instagram-design-brief"
allowedTools: [], maxSteps: 1, maxTokens: 4_000
modelPolicy: resolveModelPolicy("instagram-design-brief", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true })
skillRef: "instagram-design-brief@1"
// ~$0.042 once per client per 120 days, on the SETUP budget. Sonnet and contentLanguageSensitive for
// the two reasons `instagram-brief` documents: this thesis is what a quarter of runs render through,
// and it reasons about the client's own register in their own script (AU33's per-client table).
```

```ts
// src/agent/instagram-template-designer-agent.ts
id: "instagram-template-designer"
allowedTools: [], maxSteps: 1, maxTokens: 6_000
modelPolicy: resolveModelPolicy("instagram-template-designer", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true })
skillRef: "instagram-template-designer@1"
// ~$0.051 per template, 4-6 per client per 120 days, on the SETUP budget. Sonnet because a weak
// layout is not one bad post, it is every post until the next setup; contentLanguageSensitive
// because it authors a type scale and an RTL layout for the client's own script.
// allowedTools: [] / maxSteps: 1 — every source is hand-assembled by 00c2, so this is a fixed
// one-call bill, never an open-ended loop.
```

```ts
// src/agent/instagram-template-set-review-agent.ts
id: "instagram-template-set-review"
allowedTools: [], maxSteps: 1, maxTokens: 2_000
modelPolicy: resolveModelPolicy("instagram-template-set-review", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" })
skillRef: "instagram-template-set-review@1"
// ~$0.004. Flash because the factual half is already answered in code (the eight gates, the measured
// metrics, the vision descriptions); this call only grades the residue — does the set read as one
// system — which is the same residue split 08a2/08b already use.
```

**Vision, honestly.** The brief says "Sonnet + vision". Vision is spent where it is cheap and already proven, not inside the authoring call: `00c2` runs `media.inspectImages` over reference-post images (≤12 × $0.001) and the designer reads those **descriptions**; `00c5` runs one `media.inspectImages` over its own **rendered sample** (per template, $0.001) and its description feeds `00c6`/`00c7`. That is the `05c → 06 → 08a4` pattern this codebase uses everywhere, it costs ~$0.018 instead of ~$0.15 of image tokens per design call, and it means the designer is judged on what it **produced**, not only on what it read. It also avoids storing competitors' pixels, which is a real rights problem the descriptions do not have.

Each agent: `prompts/<id>/1.md` + byte-identical `latest.md`, H1 carrying the version, `skillRef: "<id>@1"`, `resolveModelPolicy(...)`, **and** an entry in `scripts/prompt-registry.ts` (the fifth prompt-bump step CI enforces).

### N.7 Tests

* `__tests__/template-studio.test.ts` — `rankReferenceFormats`: per-account z-scoring; a large account's median does not beat a small account's outlier; a post with no engagement field yields a row with **no** `normalisedScore` and a named absence; posts from one account only still rank; `signalsAvailable: ["likes","comments"] / signalsAbsent: ["views…"]` when the provider returned no views. `assertNoInventedMetrics` catches `"3.2x more saves"` when the evidence block has no `3.2x`, and passes when it does.
* `__tests__/template-studio-validation.test.ts` — each of the eight gates refuses in isolation, with the offending thing named: a non-routable `archetypeId`; an unread declared slot; a read-but-undeclared placeholder; `{{image:hero}}` with a non-image ground; `{{html:device}}` with no declared device slot; a `<script>` in `bodyHtml`; a render `tooling_error`; **a render that fails the interest floor by margin**; a sub-floor contrast pair; a Hebrew render with `textShare === 0` or `probe.overflow === true`.
* `__tests__/template-studio-render.test.ts` (Chromium-gated, `scale: 2`) — a fixture designer output goes end to end through `buildStudioTemplateDocument` → real renderer → real interest floor, LTR and RTL, clearing the floor with the ≥0.05 margin.
* `__tests__/template-studio-workflow.test.ts` (fake router) — `00c` resolves `generate` for a client with no rows and `reuse` when fresh rows exist (and consumes **no** turn); a designer turn failing its schema drops that template, records a warn and **the run still delivers on the bundled set**; a validation failure consumes exactly one repair turn; `research.socialHistory` `not_available` → the studio still runs off the brief and the site, `signalsAbsent` names everything, nothing holds; `templateFeedback` with `promote: true` on a studio id flips `enabled` and the next run materializes it.
* `__tests__/setup-budget.test.ts` — `planSetupBudget` pulls the six levers **in order**; a shape that cannot fit produces 4 (then, past the max, 3) and **never** a refusal; `estimateVsActualLine` is produced; history round-trips through `SETUP_BUDGET_BELIEF_KEY`; `new RunSpendMeter({ targetUsd, maxUsd })` postures on the setup numbers while the default ctor is byte-identical to today.
* `packages/tools/karos-templates/__tests__/` (changed) — an `enabled: false` row is invisible to `resolveBest` and to `materializeTemplates`; `derivedFrom`/`role` round-trip; a `DEFAULT_QUALITY_STUDIO` row loses to a bundled row of the same archetype and wins when the bundled file is absent; `setTemplateEnabled` writes both the row and a feedback entry and is idempotent.
* `__tests__/prompt-resolution.test.ts` (changed) — the three new prompt ids resolve, `1.md` is byte-identical to `latest.md`, H1 versions correct, all present in `scripts/prompt-registry.ts`.

### N.8 Risks

A generated template is a per-client visual single point of failure — bounded by score 65 (never displaces a verified bundled row of the same id), `enabled: false` (a human sees it first), eight gates including the interest floor with margin, and `reviewTemplate`'s −15 dropping a disliked design out of contention in one review. The gates catch empty, illegible and incoherent; **none of them catches dull** — that is the honest residual risk, and it is why human approval gates the set and why the format thesis is a separate call with the evidence in front of it. Reference accounts may be unreadable (LinkedIn-only brief, dormant accounts): the studio then designs from the brand kit and the site, records the absence, and generates fewer templates. A brand-kit change does **not** stale the stored rows: the brand head fragment is spliced at *materialization* time on every run, so a kit change re-themes every stored row automatically.

---

## Item O — per-run authoring, and the pool that grows

**Source: synthesis.** A's reuse-the-existing-promotion argument and `store.get`-first guard; B's `bodyHash` (the decisive detail) and its clean-ship definition.

### O.1 `customArchetype` stops being rare

Prompt-only, plus one code change. `instagram-copy@14` §20 rewrites "Rare case: none of the six fit" into "Author one or two slide layouts when the content calls for it", with the criterion concrete: reach for `custom` when the content has a **shape** no archetype has (a diagonal split, a nested comparison, a five-point grid), never for novelty; at most two per carousel; and `rationale` must name the shape gap, not restate the content.

The code change is the validation-before-render loop, which is what makes authoring safe to encourage. Today `validateCustomArchetypes` checks the id collision and `assertSafeMarkup`; anything failing degrades. Item O adds the **slot-contract** check as a pure, separately-testable function:

```ts
// agents/instagram-agent/src/workflow/custom-archetype-checks.ts (new, pure)
export function validateCustomArchetypeSlots(a: SlideCustomArchetype): { ok: true } | { ok: false; reason: string };
```

`extractSupportedFields(bodyHtml + css)` ∩ declared slots ∪ `KNOWN_SLOT_NAMES` — free, pre-render, and it catches a `{{key}}` the fields object never fills, which today renders as a hole.

**The interest floor is item O's render gate, for free.** A custom archetype that renders empty fails `interest:*` at `08a1` like any other slide, with `custom-<id>` named in the finding. No separate render-and-check pass is needed — item L *is* item O's render validation.

### O.2 Auto-promotion after two clean ships

```ts
// agents/instagram-agent/src/workflow/custom-archetype-memory.ts (new, pure)
export const CUSTOM_ARCHETYPE_BELIEF_KEY = "instagramCustomArchetypes";
export const AUTO_PROMOTE_CLEAN_SHIPS = 2;
export interface CustomArchetypeRecord {
  templateId: string; archetypeId: string; name: string;
  bodyHash: string;              // sha256 of bodyHtml + css
  cleanShips: number; runIds: string[]; lastShippedAt: string;
  promotedAt?: string; promotedFromRunIds?: string[]; resetReason?: string;
}
export function recordCleanShip(history: CustomArchetypeHistory, entry: CleanShip): { history: CustomArchetypeHistory; promote?: CustomArchetypeRecord };
```

A **clean ship** is: the run delivered, the gate decision was `approve`, `hasReviewEdits` touched no field of that slide, and no `templateFeedback` entry for that `templateId` carried `verdict: "revise"`.

**`bodyHash` is load-bearing** (B's detail, adopted): a model reusing `custom_pull_rail` for a *different* layout next week would otherwise have two unrelated ships counted as one design. A mismatch resets `cleanShips` to 1 and records `resetReason`, visible on the gate.

At `cleanShips >= 2`, a new conditional step `09f-auto-promote-templates` (code, after the review cycle, before `09b`) calls the **existing** `promoteTemplate` with `id: templateId`, `source: "ai_generated"`, `clientSlug`, `enabled: true`, `qualityScore: 55`, `actor: "auto:two-clean-ships"`, and a note naming the earning run ids. `store.get(templateId)` first — the same "don't blind-overwrite and reset a score" guard `persistReviewFeedback` already applies, which also makes a resumed run idempotent.

**55**: above `ai_generated`'s 40 (two clean human ships is more evidence than one tick), below a studio template's 65 (a studio row was designed against measured formats and validated in RTL; this one only survived two live gates), below the bundled 70. `reviewTemplate`/`QUALITY_DELTA` move it from there. **No parallel scoring mechanism.** `actor: "auto:two-clean-ships"` is deliberately queryable: a human can ask the registry which designs nobody explicitly chose.

### O.3 Semantics, cost, tests, risks

**Cost $0** (code plus one belief write; prompt growth counted in M). **Gate:** nothing here can hold — a promotion failure is caught and logged like every other `09b` best-effort write.

Tests, `__tests__/custom-archetype-memory.test.ts`: one clean ship does not promote, two do; an `approve` carrying an edit to that slide does not count; a `revise` template verdict does not count; a changed `bodyHash` resets with a reason; promotion is idempotent on a resumed run. `__tests__/custom-archetype.test.ts` (changed): the slot-contract gate degrades an archetype referencing an unfilled slot, and a custom archetype whose render fails the floor produces an `interest:*` finding naming `custom-<id>`. `__tests__/auto-promote-template.test.ts` (new): a memory-backed store, two unedited approved runs → a `09f` step and a row at 55 whose note names both run ids; a third run does not re-promote.

Risks: a reviewer who always approves promotes faster than one who edits — the audit trail (`actor`, `promotedFromRunIds`) is the mitigation, and one `revise` drops the row to 40. The pool grows monotonically; pruning rows below 40 unpicked for 90 days is named as a follow-up, not built here.

---

## Item P — structural memory across runs

**Source: synthesis, closer to B.** B's beliefs-only store and distance metric are right; **A's proposal to reformat `topicDecisionSummary` to an ordered `>` list is rejected** — it puts two live parsers (`parseContentModeFromSummary`, `angleFromDecisionSummary`) at risk to store an array of strings that has a better home. The ordered signature goes to beliefs (machine-read) and to one `ledger.appendEvent` info row (operator-visible in the run trace). `topicDecisionSummary` is left untouched.

### P.1 The signature

```ts
// agents/instagram-agent/src/workflow/skeleton-memory.ts (new, pure)
export const SKELETON_BELIEF_KEY = "instagramSkeletons";
export const SKELETON_HISTORY_LIMIT = 10;    // stored
export const SKELETON_AVOID_WINDOW = 5;      // shown to the writer
export const MIN_SKELETON_DISTANCE = 0.34;

export interface SkeletonEntry {
  runId: string; at: string;
  signature: string;          // "cover:cover>interior:stat_callout>interior:photo>closer:closer"
  archetypes: string[];       // ordered, duplicates KEPT — unlike the decision summary's de-duplicated set
  deviceKinds: string[];      // "" where a slide had none
  roles: SlideRole[];
  occupancy: number[];        // rounded occupiedShare per slide, from item L — the pixel half of "the same skeleton"
  edited: boolean;
}
export function skeletonSignature(slides, roles, devices): string;   // via templateBasename, so `-inv`/`.html` are stripped
export function skeletonDistance(a: SkeletonEntry, b: SkeletonEntry): number;
export function readSkeletonHistory(beliefs: unknown): SkeletonHistory;
export function recordSkeleton(history: SkeletonHistory, entry: SkeletonEntry): SkeletonHistory;  // idempotent per runId, trims to 10
export function skeletonAvoidList(history: SkeletonHistory): string[];
```

`skeletonDistance` is positional agreement over `role:archetype` tokens with a length penalty: identical → 0; one archetype swapped in six → 0.17; two → 0.33; a different length plus two swaps → ≈0.45. `MIN_SKELETON_DISTANCE = 0.34` therefore means **"at least two of six positions must differ from the last post"** — the smallest change a reader could actually notice.

### P.2 Read, enforce, write

* **`02k-read-structural-memory`** (code, new) — `memory.read({ scope: "beliefs" })` → `readSkeletonHistory`. A free store read, and its own step id so "why did this run avoid a stat cover" is legible in the trace. (`03d`'s free `decisions` read already exists and is untouched.)
* **Prompt avoid-list.** `05-write-copy-attempt-N`'s input gains `recentSkeletons: string[]` (last 5, newest first) and `skeletonRule: string`. Copy prompt @14 §21: *"These are the last five posts' slide skeletons. Do not reproduce any of them. At least two positions must differ from the most recent, and the cover's archetype must differ from last week's. Repetition is the single clearest tell that a feed is machine-made."* ≈+150 input tokens.
* **`07k-skeleton-variety-attempt-N`** (code, new, right after `07h`, deliberately **pre-render** so a repeat costs no render at all — and deliberately **not** a `DEFAULT_RENDER_RULES` entry, so a client with its own render rules is unaffected and `07h`'s four-rule surface does not grow):
  * **Hard:** signature identical to the previous post's → `returnToCopyWith("this carousel's layout sequence (cover>photo>photo>closer) is identical to the previous post's — change at least two slides' archetypes, starting with the cover")`, `continue`. This is the brief's mandated refusal, and only on an **exact match with the immediately previous post**.
  * **Soft:** `skeletonDistance < 0.34` → the same return **on attempt 1 only**; from attempt 2 it degrades to a gate warn and a ledger note. Variety is enforced while it is free and never at the cost of the post.
  * Within-carousel: two **adjacent** slides sharing both archetype and (post-render, at `08a1`) the same occupancy bucket → warn, joined to `08b`'s input.
  * On the final attempt this **degrades and ships**, like item L — repetition is a design defect, not a compliance one.
* **`08b` compares against the previous post.** Input gains `previousSkeleton` and `thisSkeleton`; `COMPOSITION_RICHNESS_CRITERION`'s description asks the cross-post question. **`instagram-visual-qa@4`** (not @2 — finding 14) adds one section: *"does this set have rhythm — a quiet cover, a loud slide, a dense one, a calm close — or is it N variations of one slide, and does it read as a different post from the previous one?"* ≈+300 input tokens on Flash.
* **The write.** `09b-deliver-and-log`, inside the block that already reads beliefs and writes `RUN_BUDGET_BELIEF_KEY`, adds two sibling keys to the **same** `memory.updateBeliefs({ diff })` call: `diff: { [RUN_BUDGET_BELIEF_KEY]: nextBudget, [SKELETON_BELIEF_KEY]: nextSkeletons, [CUSTOM_ARCHETYPE_BELIEF_KEY]: nextCustom }`. `updateBeliefs` merges a diff, so the keys never fight. `edited` comes from `hasReviewEdits`, already computed at that scope. Plus one `ledger.appendEvent` info row carrying the signature, so an operator sees it in the run trace without a beliefs read.

### P.3 Reporting

The gate payload and the deliverable gain `skeleton: { signature, previous, repeatedPrevious, distance, recent }` — the first time "are we shipping the same post every week" is answerable from the portal.

### P.4 Tests

`__tests__/skeleton-memory.test.ts` — `signatureOf` keeps order and duplicates (unlike `topicDecisionSummary`'s set) and strips `-inv`/`.html` via `templateBasename`; distance is 0 for identical, ≈0.17 for one swap, ≥0.34 for two; `skeletonAvoidList` returns the newest five, newest first; `recordSkeleton` caps at 10 and is idempotent per `runId` (a resumed delivery must not double-write).

`__tests__/skeleton-repeat-gate.test.ts` (new) — a seeded belief holding last week's exact signature → `07k` fails on attempt 1 **with zero render-tool calls asserted**, the reason names both sequences, attempt 2's copy input carries `recentSkeletons`, and the run delivers; a distance-0.17 near-match returns on attempt 1 and warns on attempt 2; no history → `07k` passes and consumes nothing; three identical drafts → **delivers `degraded`**, not held.

`__tests__/workflow-e2e.test.ts` (changed) — the delivered run writes all three belief keys in one diff and the gate payload carries `skeleton`. `__tests__/topic-selection.test.ts` and `angle-selection.test.ts` are **unchanged**, because the decision summary is not touched (the whole point of rejecting A's reformat).

### P.5 Risks

A client running a genuinely fixed weekly format will fight the soft rule — mitigation: the rule reads `role:archetype` pairs, so a lane keeps its roles while varying archetypes and devices, and the soft clause self-demotes after one attempt. Beliefs is one JSON document, so a concurrent run could clobber a sibling key — `updateBeliefs` takes a merging `diff`, which is why these are new keys rather than a widened one. A first run has no history and both checks are inert.

---

# PART 2 — Phase 3 (PR-D)

## Item Q — visual direction per client, at setup

**Source: synthesis.** B is right that `media.ingestVisualPatterns` **already is** the artefact the brief describes (consent-gated, versioned, per-axis patterns with evidence URLs and confidence, `templateHints`, human review state, `renderVisualPatternReference()` — all verified) and is dark only because nothing calls it and `artDirectionFor` ignores it. A is right that the brief asks for an **agent step** to derive the 6–10 lines, and that Flash-derived patterns alone will be absent for most clients (consent is usually missing). Both, therefore: patterns supply the evidence when they exist; a small Sonnet art-director turns whatever evidence exists into the lines.

**Storage decision (my correction).** The derived direction is **not** written back through `media.ingestVisualPatterns` and does **not** change `visual-patterns.ts`. There is no WorkspaceStore handle in this workflow (finding 11), and widening a versioned tool to accept agent-authored prose would force an `INGEST_TOOL_VERSION` bump for a write the tool was not designed to take. The direction is stored in the beliefs document under `VISUAL_DIRECTION_BELIEF_KEY = "instagramVisualDirection"` via the `memory.updateBeliefs` the workflow already calls — durable, per-client, already read at `02j`/`02k`. Migrating it into the versioned profile once a workspace writer exists is a named follow-up in the PR body, not this PR's work.

### Q.1 Steps

Reuses `00c1-plan-setup-budget`'s meter and plan — one setup budget covers N and Q, which is why the plan's fifth lever is "visual direction off".

| Step id | Kind | What |
|---|---|---|
| `00d-check-visual-direction` | code | `readVisualDirection(beliefs)` + `media.getVisualPatterns` (free, local) → `reuse` / `derive` / `unavailable` on a `VISUAL_DIRECTION_TTL_DAYS = 90` TTL. |
| `00d1-ingest-visual-patterns` | code | `media.ingestVisualPatterns` over the client's **own consented** accounts. Consent-gated by the tool itself; without consent it returns `not_available`, which is recorded as a named reason, never a failure. ≈$0.033 on the setup meter. |
| `00d2-derive-visual-direction` | **agent** `instagram-art-director` (Sonnet) | The 6–10 lines + the forbid list + the style lock. |
| `00d3-persist-visual-direction` | code | `memory.updateBeliefs({ diff: { [VISUAL_DIRECTION_BELIEF_KEY]: direction } })`. Best-effort; a failed write is a warn and the run proceeds on brand tokens. |

### Q.2 The schema

```ts
// agents/instagram-agent/src/workflow/visual-direction.ts (new)
export const VISUAL_DIRECTION_BELIEF_KEY = "instagramVisualDirection";
export const VISUAL_DIRECTION_TTL_DAYS = 90;

export const VisualDirectionSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  generatedBy: z.string(),                                   // "instagram-art-director@1"
  subject: z.array(z.string().max(160)).max(4),
  light: z.array(z.string().max(160)).max(3),
  palette: z.array(z.string().max(40)).max(6),
  treatment: z.array(z.string().max(160)).max(3),
  /** What must never appear. Passed to the generator as an explicit negative block. */
  forbid: z.array(z.string().max(80)).max(10),
  /** 6-10 generation-ready sentences, each carrying its own evidence. */
  lines: z.array(z.object({
    line: z.string().min(1).max(200),
    basis: z.string().min(1).max(160),                       // an evidence URL, a brand token, or a site page
    confidence: z.enum(["high", "medium", "low"]),
  })).min(4).max(10),
  /** Item S: the one per-client generation style every generated image in a run inherits. */
  styleLock: z.object({ id: z.string().min(1).max(40), line: z.string().min(1).max(200) }),
  source: z.enum(["patterns", "patterns+brand", "brand+brief", "brand"]),
  gaps: z.array(z.string()).default([]),
});
export function buildVisualDirectionInput(...): AgentInput;                    // hand-assembled sources
export function fallbackVisualDirection(tokens: BrandTokens, brief?: ClientBrief): VisualDirection | undefined;
export function readVisualDirection(beliefs: unknown): VisualDirection | undefined;
```

`fallbackVisualDirection` is B's insurance and it matters: it derives **at least 4 lines** for any client with either a brand kit or a brief (`positioning`/`icp`/`coreTerms` → subject lines; `brandTokens.palette` → palette; `brief.forbiddenTopics` → forbid), so the neutral fallback string is unreachable in practice even when the agent step is skipped by a budget lever. Every line must name a basis; a line with no basis is a `gap`, not an assertion — the discipline `stampAgentBrief` already enforces on the client brief.

### Q.3 Wiring the dark option, and killing the neutral fallback

* **`research.pull({ includeVisualPatterns: true })`** is passed from `research-lanes.ts` at step `04a2-research-pull-deep`. **No tool change → `pull.ts` is untouched and unbumped** (verified: the read path, the schema and the payload fold all exist since 1.2.0; the file is at 1.3.0; no caller passes it).
* **`artDirectionFor` (changed)** takes the stored direction as a second argument:

```ts
function artDirectionFor(tokens: BrandTokens, direction?: VisualDirection): Record<string, unknown> | undefined {
  const art = {
    ...(direction?.subject[0] ?? tokens.aesthetic ? { aesthetic: direction?.subject[0] ?? tokens.aesthetic } : {}),
    ...(direction?.light[0]   ?? tokens.lighting  ? { lighting:  direction?.light[0]   ?? tokens.lighting  } : {}),
    ...(direction?.palette.length ? { palette: direction.palette } : tokens.palette?.length ? { palette: tokens.palette } : {}),
    ...(tokens.accentColor ? { accentColor: tokens.accentColor } : {}),
    ...(direction?.treatment[0] ?? tokens.visualMood ? { mood: direction?.treatment[0] ?? tokens.visualMood } : {}),
    ...(direction?.lines.length ? { notes: direction.lines.map((l) => l.line).join(" ") } : {}),
    ...(direction?.forbid.length ? { forbid: direction.forbid } : {}),
    ...(direction?.styleLock ? { styleLock: direction.styleLock.line } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}
```

* **`image.generate` (the real tool name — finding 14): `TOOL_VERSION 1.0.1 → 1.1.0`.** `art` gains `forbid: z.array(z.string().min(1)).max(10).optional()` and `styleLock: z.string().min(1).optional()`; `buildBrief` gains a `Do not include:` block and the style-lock line. **The `"Style: realistic photography, natural lighting, clean composition."` fallback stays in the file** — deleting it would make a caller with nothing to say *worse* off, and it is documented prior behaviour. What changes is that the instagram caller now always supplies something.

### Q.4 The agent

```ts
// src/agent/instagram-art-director-agent.ts
id: "instagram-art-director"
allowedTools: [], maxSteps: 1, maxTokens: 3_000
modelPolicy: resolveModelPolicy("instagram-art-director", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: false })
skillRef: "instagram-art-director@1"
// ~$0.042 once per client per 90 days, on the SETUP budget. Sonnet because these 6-10 lines are the
// standing brief every generated image in every run for a quarter inherits; a flat line here is the
// "generic stock" failure `buildBrief`'s own doc comment warns about, repeated across ~13 posts.
// NOT contentLanguageSensitive: the output is an English generation brief for an image model,
// never client-facing copy.
```

Prompt `prompts/instagram-art-director/1.md` + identical `latest.md` + registry entry.

### Q.5 Tests

`__tests__/visual-direction.test.ts` — `00d` freshness resolution on the TTL; no consent → a named `visualPatternsUnavailable` gap and the run proceeds; a reviewed profile (`review.status !== "unreviewed"`) outranks an unreviewed one as evidence; `fallbackVisualDirection` yields ≥4 lines for a client with only a brief; `forbid` carries the brief's forbidden topics; the persisted document round-trips through the belief key. `__tests__/art-direction.test.ts` — `artDirectionFor` returns the lines, `forbid` and `styleLock`; falls back to brand tokens with no direction; returns `undefined` when neither has anything; **a source-pinning test asserts the workflow never calls `image.generate` without an `art` object**. `packages/tools/karos-media/__tests__/generate-image.test.ts` (changed) — `buildBrief` emits `Do not include:` and the style-lock line; **a caller supplying no `art` still gets the byte-identical prior neutral brief** (the regression that matters); `check:tool-versions` sees 1.1.0. `__tests__/research-lanes.test.ts` (changed) — `04a2` passes `includeVisualPatterns: true` and the payload carries the profile when one exists.

### Q.6 Risks

Consent is usually absent, so most clients land on `brand+brief` — still a large improvement on one hardcoded line, and the source is named on the gate as `visualDirection.source`. A wrong line poisons a quarter of images: mitigated by every line carrying its basis and confidence, by the direction being human-readable prose in a belief document, and by generated images still passing `instagram-image-vet@4` and the rights gate. The `forbid` list is advisory to the image model — true, and it is the only lever available.

---

## Item R — a scene brief instead of twelve words

**Source: A's field split, with B's backward-compatible union.** A's three-field split (`visualNeed` prose / `imageSource` / `searchTerms`) resolves the real tension: §6 of the current prompt spends ~45 lines explaining that a rich description breaks the **keyword** image search — true of retrieval, false of generation and vetting. B's `z.union([z.string(), Schema])` + `normaliseVisualNeed` is what keeps ~30 fixtures and every in-flight checkpoint parsing, and is adopted.

```ts
// types.ts — InstagramSlideCopySchema
export const SlideVisualNeedSchema = z.object({
  scene: z.string().min(1).max(240),                            // what is in frame
  why: z.string().min(1).max(200),                              // why the slide is weaker without it
  source: z.enum(["client-upload", "stock", "generate", "none"]).default("stock"),
  searchTerms: z.array(z.string().min(1).max(40)).min(1).max(6).optional(),
});
/** Accepts the legacy bare string; `normaliseVisualNeed` widens it. */
visualNeed: z.union([z.string().min(1), SlideVisualNeedSchema]),
export function normaliseVisualNeed(slide: InstagramSlideCopy): { scene: string; why?: string; source: SceneSource; searchTerms: string[] };
```

Every consumer reads through `normaliseVisualNeed`, so old checkpoints, every existing fixture and a model that regresses to a string all keep working:

* **`05b-source-images-attempt-N`** (changed, id stable) → retrieval queries from `searchTerms`, falling back to the first eight words of `scene`. Keyword search is **better** off, not worse.
* **`image.generate`** → the full scene brief as the need's `prompt`, which is the field `buildBrief` interpolates. This is the field that was starved.
* **`06-vet-images-attempt-N`** → `scene` + `why` as the `claimMatch` subject. **`instagram-image-vet@4`**: "you are given the scene brief and why the slide needs it; judge whether this candidate is *evidence for the claim*, not whether it contains the listed objects."
* **`source: "none"`** → the slide skips image sourcing entirely and **must** carry a `device` (item M) — enforced deterministically by a new `07h` rule `default:no-image-means-device`, which is where items L, M and R meet.

`instagram-copy@15` §22 documents the scene brief and the source choice, with the bias stated: photo-driven is the default; `none` is for ideas that are not photographable.

**Cost.** `imageSource` is the lever. Each slide declaring `"none"` removes `CANDIDATES_PER_PHOTO_SLIDE` (6) vision inspections at $0.001 = **−$0.006/attempt/slide**, plus its share of the rescue scrape and any generated image. The scene brief costs ≈+0.4k in / +0.3k out per attempt on Sonnet = **+$0.0057/attempt**; the vet input +0.5k on Flash = +$0.0002. **Net negative at ≥1 device slide.** `DEFAULT_RUN_SHAPE.photoSlides` stays at **6** deliberately: the estimate must not flatter itself, and the planner should discover the saving as an under-target actual that relaxes the next run's calibration.

**Tests.** `__tests__/scene-brief.test.ts` — `normaliseVisualNeed` on a bare string, a full object, and `source: "none"` with no device (rejected by `07h`, slide named); `05b` queries from `searchTerms` and falls back to a truncated `scene`; `06`'s input carries `why`; a `"none"` slide produces no sourcing call. `__tests__/semantic-image-vetting.test.ts` (changed) — the vet input carries the scene brief; the `claimMatch` floor still gates. **Every existing fixture still parses** — the compatibility pin. `__tests__/prompt-resolution.test.ts` — `instagram-image-vet@4`, `instagram-copy@15` resolve.

**Risks.** A 600-char brief fed to a keyword index would reproduce the "Swedish street kiosk" failure — structurally impossible: retrieval reads `searchTerms` and the fallback truncates. The writer over-selecting `"none"` is bounded by the interest floor (a typographic slide must still be interesting), by `default:cover-carries-device`, and by prompt bias.

---

## Item S — style lock for generated images

**Source: synthesis.** A's per-client (never per-slide) determinism and its contrast-gated duotone; B's frozen-once-per-run step and its insistence that the treatment be measured against the interest floor.

* **Generation side.** `04k-freeze-generation-style` (code, new, once per run **before** the attempt loop): `resolveGenerationStyle(direction, brandTokens, brief)` → one frozen `GenerationStyle`, checkpointed, passed to **every** `image.generate` call in every attempt and every revision. One set of generated images, one look. With no direction, `styleLock` is absent and behaviour is exactly today's.
* **Renderer side.** `pickImageTreatment(kit, styleLock)` (pure, in a new `style-lock.ts`) → `"none" | "warm-desaturate" | "duotone-scrim"`, emitted as `fields.imageTreatment` and rendered by a **code-owned** `.hero-treatment` layer in `slide.html`, `cover.html` and the studio templates.

| id | filter | When |
|---|---|---|
| `none` | `none` | Default, and forced when the kit declares no treatment latitude |
| `warm-desaturate` | `saturate(0.82) sepia(0.06) contrast(1.03)` | The taste rules' own recommendation: "a light desaturation and warm tone… never crush it to flat monochrome" |
| `duotone-scrim` | `saturate(0.55)` + an accent-tinted `mix-blend-mode: multiply` overlay at 12% | **Only** when the accent clears `ACCENT_GROUND_CONTRAST_FLOOR` against the ground (`contrastRatio` is already imported there), so a treatment can never make type illegible |

Deterministic, per client, **never per slide** — that is the point. Grain is a token-derived `repeating-conic-gradient` at 5%, not an image asset: no `url()`, so `assertSafeMarkup`'s CSS rules still hold and nothing is downloaded.

**Cost $0. Gate: none** — a treatment that pushed contrast below floor is caught by the existing `assessContrastFacts` (a fact) and by item L's `imageryShare`.

**Tests.** `__tests__/style-lock.test.ts` — `resolveGenerationStyle` is stable across attempts for a fixed run (checkpoint replay); `pickImageTreatment` is pure and stable; `duotone-scrim` is refused when the accent fails the contrast floor; a one-colour kit yields `none`. `interest-floor-calibration.test.ts` (changed, Chromium) — **the risk that matters, pinned on real pixels:** a photo slide rendered with `warm-desaturate` and with `duotone-scrim` still clears `IMAGERY_OR_DEVICE_FLOOR` and keeps `quantisedColourCount >= 8`. A treatment that flattened a photo into a wash would make item L fail a correct slide; this proves it does not. `generate-image.test.ts` (changed) — every call in a run carries the identical `styleLock` line.

**Risk.** A treatment applied to a generated image that already has the style baked in double-applies — accepted and mild (both are subtractive and gentle); tracking provenance into the CSS is not worth the coupling.

---

## Item T — client media library

**Source: A, with B's sha256 dedupe and its per-run `usedIn` write step.** Uploads currently live in `.media-cache/<runId>/` — per-instance, per-run disk. Persisting them needs a store write, and an agent cannot write the workspace except through a tool, so this is the one item that genuinely needs new tools.

```ts
// packages/tools/karos-media/src/media-library.ts (new)
export const MEDIA_LIBRARY_SEGMENTS = ["client", "media-library"] as const;
export const MEDIA_LIBRARY_LIMIT = 500;

export interface MediaLibraryEntry {
  assetId: string;            // first 16 hex of sha256(bytes) — content-addressed, so one frame is never filed twice
  sha256: string;
  gcsUri: string;             // durable; a signed URL is a convenience, never the identity
  contentType: string; bytes: number;
  addedAt: string; addedByRunId: string;
  rights: { source: string; licence: string; note?: string };
  /** `media.inspectImages`' description, identity NAMED. Stored, so a later run needs no second vision call. */
  description: string; subjects: string[]; textInImage: string[]; mood: string;
  inspectedByToolVersion: string;
  sceneTags: string[];        // derived in code from subjects + mood, lowercased, deduped
  usedIn: Array<{ runId: string; slide: number; at: string }>;
}
// media.libraryAdd  1.0.0 — upsert by assetId; appends usedIn without duplicating
// media.libraryList 1.0.0 — this client's entries, newest first, with sceneTags / excludeUsedInRunIds filters
```

Registry count **62 → 64**; `cross-cutting.test.ts` updated with the reason recorded in a comment, as its existing 60→62 comment does.

**Wiring.**

* `05z-attach-user-media` (changed, id stable) — after the existing `media.inspectImages` pass (whose descriptions it already holds), each upload is staged via `media.ingestAssets` (the tool this workflow actually uses) and recorded via `media.libraryAdd`. **Best-effort:** a failed library write is a note, never a run failure; the upload still works as a run attachment exactly as today.
* `05y-read-media-library` (code, new, before `05b`) — `media.libraryList`, filtered by (a) `ledger.listUsedImages`' existing rules, already read at `05a`, which remain authoritative, and (b) `excludeUsedInRunIds: [previousPostRunId]`, taken from the skeleton history's newest entry (item P), already read this run. Survivors join the candidate pool as **tier 0.5** — after the client's fresh uploads, before stock — and they carry a stored `description`, so **they cost no vision call**: a straight saving against sourcing a new stock image.
* `09g-record-media-library-use` (code, new, beside the existing `ledger.recordUsedImages`) — the shipped frames' `usedIn` gains `{ runId, slide, at }`.

**Tests.** `packages/tools/karos-media/__tests__/media-library.test.ts` — content-addressed upsert (the same bytes twice → one entry); `usedIn` appends idempotently per (runId, slide); `sceneTags` filtering is case- and script-insensitive (a Hebrew tag matches a Hebrew scene); `excludeUsedInRunIds`; no store → `not_available`, never placeholder data; eviction at `MEDIA_LIBRARY_LIMIT` drops the oldest unused **entry**, never the object. `__tests__/media-library-reuse.test.ts` — a library frame is offered at tier 0.5 **with no vision call** (router turn count asserted); a frame used in the immediately previous post is excluded; a frame in `ledger.listUsedImages` is excluded by the existing rule. `__tests__/tier0-user-media.test.ts` (changed) — an upload lands in the library; a library write failure leaves the run byte-identical. `packages/tools/__tests__/cross-cutting.test.ts` (changed) — 64.

**Risks.** Unbounded growth — capped at 500 entries with oldest-unused eviction; retention is a manager concern. A stored description going stale against a newer `media.inspectImages` — the entry records `inspectedByToolVersion`, so a mismatch *permits* re-inspection rather than requiring it. A GCS lifecycle deleting a staged object — re-ingestion fails, the entry is skipped with a note, and the tiers below fill the slide, the same degrade path every image tier already has.

---

# COST

## Per-run cost table — target $1.00, hard max $1.50

Baseline is `estimateRunCost`'s own arithmetic over `DEFAULT_RUN_SHAPE` + `DEFAULT_RUN_BUDGET_PLAN`: cold cache, worst case, English, no brief refresh.

| Line | Today | After PR-C | After PR-D |
|---|---|---|---|
| 03b trend evidence, 4 × $0.007 | 0.028 | 0.028 | 0.028 |
| 03c scout (Flash) | 0.012 | 0.012 | 0.012 |
| 03e topic signals, 8 × $0.007 | 0.056 | 0.056 | 0.056 |
| 04a2 research lanes, 6 × $0.007 | 0.042 | 0.042 | 0.042 |
| 04a3 primary sources, 2 × $0.007 | 0.014 | 0.014 | 0.014 |
| 04b extraction (Flash) — +Q's pattern block | 0.0135 | 0.0135 | 0.0137 |
| 04i angle (Sonnet) | 0.036 | 0.036 | 0.036 |
| 02k / 04k / 05y structural, style, library reads (code) | — | 0 | 0 |
| **fixed subtotal** | **0.2015** | **0.2015** | **0.2017** |
| 05 copy draft (Sonnet) — @14 then @15 prompt growth | 0.120 | 0.126 | 0.1317 |
| 06 image vet (Flash) — @4 scene brief | 0.006 | 0.006 | 0.0062 |
| 07g relevance (Flash) | 0.002 | 0.002 | 0.002 |
| 07h / **07k skeleton variety** (code) | 0 | **0** | **0** |
| 08 render **+ measure + probe** (Chromium) | 0 | **0** | **0** |
| **08a1 interest floor / 08a1b-d free re-layout + re-render** (code) | — | **0** | **0** |
| 08b visual QA (Flash) — @4 previous skeleton | 0.004 | 0.0041 | 0.0041 |
| 05c candidate inspection, 6 slides × 6 × $0.001 | 0.036 | 0.036 | **0.024** (two `source:"none"` slides) |
| 08a4 rendered inspection, 8 × $0.001 | 0.008 | 0.008 | 0.008 |
| **per attempt** | **0.176** | **0.1821** | **0.176** |
| × 3 attempts | 0.528 | 0.5463 | 0.528 |
| rescue tiers, 3 × (3 scrapes + 2 re-vets) | 0.099 | 0.099 | 0.092 |
| generated images, cap 4 × $0.039 | 0.156 | 0.156 | 0.156 |
| 09f / 09g promotion + library writes (code) | — | 0 | 0 |
| **estimate at image cap 4** | **0.9845** | **1.0028** | **0.9777** |

`planRunBudget`'s `fits()` is false at $1.0028, so lever 1 steps the image cap 4 → 2:

| Plan the planner actually chooses | Estimate |
|---|---|
| PR-C, images cap 2, everything else full | **$0.9248** ✅ under the $1.00 target |
| PR-D, images cap 2 | **$0.8997** ✅ |
| **hard max** | $1.50 — ≈$0.60 of headroom |
| Typical prep actual (warm caches, one attempt, no generated images) | ≈**$0.25** |

**Item-by-item run delta.**

| Item | Run cost | Why |
|---|---|---|
| L interest floor | **$0.000**, and it *saves* | Pure Node on bytes that already exist, plus a $0 Chromium re-render. A failure at `08a1` skips `08a4` (−$0.008) and `08b` (−$0.004) for that attempt; at a conservative 40% free-fix rate on interest failures the free re-layout avoids a $0.126 redraft, an expected ≈−$0.017/run — **more than the prompt growth it pays for**. |
| M cover/closer + devices | **+$0.0045/attempt** | §7/§19 prompt growth (~1.1k in, ~0.15k out); markup is code. |
| N Template Studio | **$0.000** | Setup budget. |
| O per-run authoring + promotion | **$0.000** | Prompt growth counted in M; validation is code; promotion is a store write. |
| P structural memory | **+$0.0015/attempt** | ~150 tokens of avoid-list on Sonnet, ~300 on Flash at 08b. Both reads are free. |
| Q visual direction | **+$0.0002** | One belief read; the profile in the Flash extraction payload. |
| R scene brief | **+$0.0059/attempt**, **−$0.006/device-slide/attempt** | Net negative at ≥1 device slide. |
| S style lock | **$0.000** | One prompt line, one CSS filter. |
| T media library | **≤ $0.000** | Two store calls; a reused frame needs **no** vision call. |
| **PR-C total worst case** | **+$0.018** | Absorbed by one step of an existing lever. |
| **PR-D total worst case** | **−$0.025** | The library and `source:"none"` give the money back. |

## Per-client setup cost table — target $2.00, hard max $3.00

Items N and Q, on the **separate** setup meter, at most once per client per 120 days (studio) / 90 days (direction).

| Step | Model / vendor | Unit | Count | Cold | Warm |
|---|---|---|---|---|---|
| `00c2` reference-account history | ScrappyCoco | 0.007 | 6 | 0.042 | 0 (24h cache shared with `03e`/`04e`) |
| `00c2` client site pages | ScrappyCoco | 0.007 | 3 | 0.021 | 0 (cached by `00b1`) |
| `00c2` reference-post inspection | Flash vision | 0.001 | 12 | 0.012 | 0.012 |
| `00c2` format ranking | code | 0 | — | 0.000 | 0.000 |
| `00c3-write-design-brief` | **Sonnet 4.6** (the thesis every designer call reads) | 0.042 | 1 | 0.042 | 0.042 |
| `00c4-design-template-<id>` | **Sonnet 4.6** (authors renderable HTML/CSS in the client's script) | 0.051 | 5 | 0.255 | 0.255 |
| `00c5` Chromium renders + eight gates | code | 0 | 5 (+RTL) | 0.000 | 0.000 |
| `00c5` sample inspection | Flash vision | 0.001 | 5 | 0.005 | 0.005 |
| `00c6-review-template-set` | **Gemini 2.5 Flash** (residue only) | 0.004 | 1 | 0.004 | 0.004 |
| `00c7-repair-template-<id>` | Sonnet 4.6 | 0.048 | 2 | 0.096 | 0.096 |
| `00d1` `media.ingestVisualPatterns` | Flash + vision + ≤3 scrapes | 0.033 | 1 | 0.033 | 0.012 |
| `00d2-derive-visual-direction` | **Sonnet 4.6** (the standing brief a quarter of images inherit) | 0.042 | 1 | 0.042 | 0.042 |
| **raw setup estimate (5 templates, 2 repairs)** | | | | **$0.552** | **$0.468** |

| Scenario | Estimate | Verdict |
|---|---|---|
| Full plan, 6 templates + 3 repairs, cold | **$0.651** | ✅ 33% of the $2.00 target |
| Pessimistic: calibration EWMA at its ceiling (×3, `MAX_CALIBRATION_RATIO`) on the model lines | **$1.752** | ✅ under target; no lever needed |
| Absolute worst: ×3 on everything, 6 templates, 3 repairs | **$1.953** | ✅ under target by $0.05 → lever 1 arms |
| Past $2.00 (a client with a very expensive history) | levers 1–5 in order | 4 templates, no set review, no vision → **≈$0.75 ×3 = $2.25**… → lever 6, 3 templates, note recorded |
| Warm same-day setup | **$0.468** | ✅ |

The whole studio lands at roughly a third of the target. That is deliberate rather than lucky: HTML+CSS output is ~2k tokens per template, so the expensive-looking part is cheap, and the genuinely expensive part — rendering, measuring, re-rendering in RTL — is **free**. The headroom is spent in three named places, each reclaimable by a lever: one call per template rather than one for the set (a schema failure costs one template, not six), a repair turn carrying measured findings rather than a drop, and the vision pass over our own samples.

Reported exactly as a run is: `setup.budget` on the gate payload and the deliverable (estimate, actual, plan, adaptations, per-step lines), one `ledger.appendEvent` row carrying `estimateVsActualLine`, and history to `SETUP_BUDGET_BELIEF_KEY` so the next setup starts calibrated. **A setup that would exceed generates fewer templates. It never fails, and it never holds.**

---

# Ordering & integration

`create-instagram-agent-workflow.ts` is owned by **no work package**. A single integrator wires it, guided by each WP's `integrationNotes`. This is the order the file is edited in, and the invariants the integrator must not break.

## Phase 2 (PR-C) — the wiring order

1. **Setup pre-flight, after `00b3-persist-client-brief`, before `03-claim-topic`** (finding 12 — `02j` is already *above* `00b1`, so the studio necessarily runs after the run plan; that is harmless because it runs on its own meter and `02j` reads only `meter.totalUsd` of the run meter):
   `00c-check-template-studio` → `00c1-plan-setup-budget` (`setupMeter = new RunSpendMeter({ targetUsd: TARGET_SETUP_SPEND_USD, maxUsd: MAX_SETUP_SPEND_USD })`) → `00c2-gather-format-evidence` → `00c3-write-design-brief` → per planned archetype `00c4-design-template-<id>` / `00c5-validate-template-<id>` → `00c6-review-template-set` → `00c7-repair-template-<id>` (≤2) → `00c8-store-template-set`.
   Every step is inside `if (studioCheck.action === "generate")`. Every failure is a `ledger.appendEvent` warn and the block falls through. **No `throw` may be added in this block.**
2. **`02k-read-structural-memory`** immediately after `02j` (a free `memory.read({ scope: "beliefs" })`; it may share the read with `02j` if the integrator prefers, but the step id must exist for trace legibility).
3. **`04c-resolve-templates`** — pass `extraHeadHtml: deviceCssBlock()` into `materializeTemplates`, and `archetypeIds` widened to the eight. Nothing else changes: `enabled: false` studio rows are already invisible to `resolveBest` (finding 8).
4. **`05-write-copy-attempt-N`** input gains `recentSkeletons`, `skeletonRule`, and (attempt ≥ 2) the existing `selfCheckSteer` now carrying interest findings. Agent `skillRef` → `instagram-copy@14`.
5. **`07c-emit-slides-data-attempt-N`** — `validateCustomArchetypes` additionally calls `validateCustomArchetypeSlots`; `assembleSlidesData` receives `device` and the `cover`/`closer` layouts; `measure: { accentHex, foregroundHex, groundHex }` is attached per slide from `slide.fields.accentColor` and `effectiveKit.cssVars`.
6. **`07h-default-render-rules-attempt-N`** — unchanged id; the cover/closer/numbers rule texts and the per-slide device check come from `visual-qa-pre-checks.ts`.
7. **`07k-skeleton-variety-attempt-N`** — new, immediately after `07h`, **before any render**. Hard clause → `returnToCopyWith` + `continue`; soft clause → the same on attempt 1 only; final attempt → degrade.
8. **`08-render-carousel-attempt-N`** — pass `measure: true, probe: true`.
9. **`08a1-interest-floor-attempt-N`** → on failure `08a1b-relayout-for-interest-attempt-N` → `08a1c-render-relayout-attempt-N` → `08a1d-interest-floor-recheck-attempt-N`; still failing → `returnToCopyWith(formatInterestFailures(...))` + `continue`, or, on the final attempt, set `interestDegraded` and fall through. **`08a1` must sit strictly before `08a2`**, which is the entire zero-model-call cost claim.
10. **`08b-visual-qa-attempt-N`** input gains `interest` and `previousSkeleton`; `skillRef` → `instagram-visual-qa@4`.
11. **`09a-batch-review`** payload gains `templateStudio`, `interest`/`visualInterest`, `interestRelayout`, `skeleton`, `setup.budget`. `persistReviewFeedback` gains the `promote: true` → `setTemplateEnabled` branch for studio rows.
12. **`09f-auto-promote-templates`** — new, conditional, after the review cycle and before `09b`.
13. **`09b-deliver-and-log`** — one `memory.updateBeliefs({ diff })` call carrying **three** keys (`RUN_BUDGET_BELIEF_KEY`, `SKELETON_BELIEF_KEY`, `CUSTOM_ARCHETYPE_BELIEF_KEY`), plus the ordered-signature `ledger.appendEvent` info row. `topicDecisionSummary` is **not** touched.

**Fixture containment.** Three new unconditional-looking model turns (`00c3`, `00c4`, `00c6`) would shift every positional fixture. They do not, because (a) all are setup-gated and `setupTestEnvironment` gains `seedStudio`, defaulting to **a fresh, approved studio set** so `00c` resolves `reuse` and no turn is consumed — exactly as `seedBrief` already defaults to a fresh brief so `00b2` consumes none; (b) `__tests__/turns.ts` gains `designBrief`, `templateDesign` (variadic), `setReview`, `templateRepair` to `TURN_ORDER` **immediately after `brief`** (they run at `00c*`, after `00b2` and before `03c` — verified against the file's real order, which is why A's "at the front, before brief" is wrong); (c) `packages/workflow/__tests__/context-doc-policy-fixture.test.ts` consumes the same helper and is re-run explicitly in the PR gate.

## Phase 3 (PR-D) — the wiring order, on top of C

1. **`00d-check-visual-direction`** → `00d1-ingest-visual-patterns` → `00d2-derive-visual-direction` → `00d3-persist-visual-direction`, immediately after `00c8`, on the **same** `setupMeter` and the same plan (lever 5 turns this block off). Same no-throw rule.
2. **`04a2-research-pull-deep`** — `research-lanes.ts` passes `includeVisualPatterns: true`. No tool change.
3. **`04k-freeze-generation-style`** — new, after `04c` and **before** the attempt loop, so every attempt and every revision inherits one frozen style.
4. **`05y-read-media-library`** — new, before `05b`; **`05z-attach-user-media`** also writes.
5. **`05b-source-images-attempt-N`** — retrieval from `searchTerms`; the generate tier passes `art: artDirectionFor(frozen.brandTokens, visualDirection)` plus the frozen `styleLock`; `source: "none"` slides are skipped entirely.
6. **`06-vet-images-attempt-N`** — input carries `scene` + `why`; `skillRef` → `instagram-image-vet@4`.
7. **`07c`/`07h`** — `fields.imageTreatment` from `pickImageTreatment`; the new `default:no-image-means-device` rule.
8. **`05-write-copy-attempt-N`** — `skillRef` → `instagram-copy@15`.
9. **`09g-record-media-library-use`** — new, beside `ledger.recordUsedImages`.

## Cross-cutting checklist for both PRs

* **New agent class ids** (each needs a class, `prompts/<id>/1.md` + byte-identical `latest.md`, H1 version line, `skillRef: "<id>@1"`, `resolveModelPolicy(...)`, **and** a `scripts/prompt-registry.ts` entry): PR-C `instagram-design-brief`, `instagram-template-designer`, `instagram-template-set-review`; PR-D `instagram-art-director`.
* **Prompt bumps:** PR-C `instagram-copy@13 → @14`, `instagram-visual-qa@3 → @4`. PR-D `instagram-copy@14 → @15`, `instagram-image-vet@3 → @4`.
* **`TOOL_VERSION` bumps:** PR-C `publish.renderCarousel` 1.0.0 → **1.2.0** (1.1.0 added `measure`/`probe`; 1.2.0 added the content mask on `metrics` — see "Corrections after review" item 1). PR-D `image.generate` 1.0.1 → **1.1.0**, plus new `media.libraryAdd` / `media.libraryList` at 1.0.0. **No** bump for `packages/tools/common/src/png.ts` or `karos-media/src/brand-logo.ts` (neither declares a `defineTool` version — verified), none anywhere in `karos-templates` (no `TOOL_VERSION` in that package at all), and **none for `research.pull`** (untouched). Do not assert `inspect-images` at 1.1.0 — it declares 1.0.0 on this branch (finding 14).
* **Registry count:** PR-C **62 → 62** (no new tool). PR-D **62 → 64**.
* **Gates and holds, in one place.** Everything inside `draftOnce` fails via `returnToCopyWith(...)` + `continue` under `planRunBudget`'s `maxSelfCheckAttempts`. The interest floor tries a **free deterministic re-layout before it ever escalates**, and on the final attempt **degrades and ships** rather than adding a fourth hold cause. The skeleton hard rule returns once with findings; its soft rule self-demotes after attempt 1; it degrades on the last attempt. Studio validation repairs once then drops a template — never fails a setup. Auto-promotion, library writes, skeleton/direction belief writes and pattern ingestion are all best-effort. Accent share, background mismatch, colour count and every contrast fact are facts + ledger warns, never gates. **No budget path anywhere holds.**
* **Test gate per PR:**
  ```
  npm run build && npm run typecheck                       # root
  npm test -w @agent-engine/agent-instagram -- --testTimeout=180000
  npm test -w @agent-engine/tool-common
  npm test -w @agent-engine/tool-karos-publish
  npm test -w @agent-engine/tool-karos-templates
  npm test -w @agent-engine/tool-karos-media                # PR-D
  npm test -w @agent-engine/tools                           # registry snapshot
  npm test -w @agent-engine/workflow                         # the cross-package instagram fixture
  npm run check:tool-versions -- --base <previous main tip>  # the PR gate diffs the merge-base
  npm run check:prompts && npm run check:config
  ```
  Chromium-gated suites (`interest-floor-calibration`, `template-studio-render`, the device RTL renders, `default-template-render`) self-skip without a browser and are **real verification in CI**, which has one.
* **After merge, the owner must:** re-run `agent-middleware/scripts/generate_engine_stages.py --check` and seed the four new Studio stages (`stageModels` keys by agent class id), and approve each client's studio set at the first review gate — until then the bundled eight are used, by construction.
* **Commit trailer** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and lists every new/renamed step id and agent class id.

## Corrections after review (2026-09-10, PR-C)

Thirteen verified findings changed the implementation after this spec was written. The nine that changed a CONTRACT are recorded here, because a spec that no longer describes the code is the defect this section exists to prevent.

1. **Clause G — decoration is not content.** Item L's clauses all read masks that a decorative ground satisfies. Measured on the real instrument: a 2160x2880 plate painting only item M.3's 45-degree hairline field over `#17181C`, with no headline, body, kicker or device of any kind, reports `flatBackgroundShare` 0.9209, `inkShare` 0.0791, `occupiedShare` 0.4217 and `largestEmptyRectShare` 0.0148, and PASSES clauses A, C, D and F. So `measureSlidePng` gained a second, content-only mask — `contentOccupiedShare`, `largestEmptyContentRect(Share)`: cells whose MEAN colour has left the ground, or that are substantially covered — and `interest-floor.ts` gained **clause G**, `contentOccupiedShare < CONTENT_OCCUPIED_SHARE_FLOOR` (0.06 interior / 0.09 cover & closer) **or** `probe.textBoxShare < PROBE_TEXT_BOX_SHARE_FLOOR` (0.01). The probe limb is load-bearing for `cover.html`, whose accent ground block paints ~29% of the frame unconditionally, so a cover whose slots all came through empty clears the pixel limb. Clause C deliberately keeps reading the mark mask: the legacy DEAD-SPACE rule it inherited its ceiling from is about BARE ground, and a slide with a ground treatment has a background. `render-carousel` is therefore **1.1.0 → 1.2.0** (additive), and the missing guard is now in place: `interest-floor-calibration.test.ts` renders `cover.html`, `closer.html` and `headline-focus.html` with every slot EMPTY and requires a `dead-space` or `empty` finding. `headline-focus.html`'s header no longer explains its 14% mix as "8% measures 17.2, just under the threshold".
2. **Positional roles are calibrated.** `slideRoleFor` assigns cover/closer by position, so the four content archetypes accepted on slide 1 by `default:cover-carries-device` were being judged at floors they had never been measured against. The calibration harness now renders each of them in position 1 and in the last position and asserts that clause E is the ONLY clause they may fail there.
3. **`default:numbers-are-devices` reads the fields each archetype RENDERS**, via `proseFieldsOf`, not a fixed `headline`/`body` pair. `contentFor` emits neither name for a `cover` (`title`/`subtitle`) or a `closer` (`takeaway`/`cta`/`question`), so the rule was blind on the two slides prompt §7 makes slide 1 and the last slide. `quote_card` is exempt: a verbatim quotation is not restructured into a device.
4. **A device renders on three archetypes, not eight.** `DEVICE_SLOT_LAYOUTS` is `{cover, headline_focus}` plus a `closer` with no recap to build, and only those templates declare a slot. §19's "any slide of any archetype may carry one" had the writer doing what `withDevice` then silently dropped, and the rule failing the slide for it. §19 now names the three; `collectDeviceIssues` reports the drop as a fact on the gate; the steer names a mechanism the failing slide's archetype can actually perform; and `contentFor` emits `deviceKind` so `07k` and `buildSkeletonEntry` sign the RENDERED device rather than the requested one.
5. **§7's placement claim says only what is enforced.** "Two hard placements ... nothing else is accepted there and anything else is refused before a render is spent" was false in both halves. §7 now states the six accepted slide-1 archetypes, that `headline_focus`/`text_only` on slide 1 are genuinely refused, and that the closer rule is graded by the judge rather than refused.
6. **Item P.2's adjacency clause is reachable.** `07k` is pre-render and passed no occupancy, so `adjacentRepeatWarnings` returned `[]` always and `skeletonWarnings` never reached `08b`. A new `08a1e-skeleton-occupancy-attempt-N` re-runs the clause against `08a1`'s measured `occupiedShare`, positionally and with holes for unmeasured slides. The stored occupancy is also read back now, onto the gate as `previousOccupancy`; `skeletonDistance` deliberately still compares signatures only.
7. **Item O promotes onto a ROUTABLE archetype id.** A row stored under a `custom_*` id can never be picked: `templateForLayout` maps the fixed layout enum, and `custom` requires model-authored markup that attempt. `buildAutoPromotionRequest` now returns a decision — the design is stored as the client's own `headline_focus`/`closer`/`cover` when its markup reads only that archetype's fields, and otherwise is recorded, not stored, with the reason on the ledger. §20's promise is corrected to match.
8. **The free re-layout is all-or-nothing.** `08a1b`'s copy, selection, style-override and validated-custom mutations are built as a candidate and committed only after `08a1c` renders successfully; the plan still rides the gate, flagged `discarded`. Committed early, a `move-sentence-to-caption` shipped the sentence in the caption AND burned into the slide's PNG whenever the re-render failed.
9. **Two cost and lifecycle corrections.** `copyAttempt` is **0.126** and `visualQa` **0.0041**, at the @14/@4 prompt sizes: left at @13's 0.12 the cold shape read $0.9845 at an image cap of 4, `fits()` was true, and the second image lever never armed against a run that billed over target. And `checkTemplateStudio` reads the setup history, so a setup that stored NOTHING is remembered for `STUDIO_EMPTY_SETUP_COOLDOWN_DAYS = 30` instead of re-paying the whole per-client setup bill on every subsequent run.

Also: `custom-archetype-memory.ts` carried a raw NUL byte in a string literal, which made git treat the module as binary and hid it from every ripgrep-based source guard. It is an escape now, and a test scans `src/workflow` for NUL bytes so it cannot recur.

## What another social agent can lift wholesale

`decodePngRows` + `measureSlidePng` — physics with no policy and no Instagram knowledge (tiktok's title cards and linkedin's carousels are the same measurement, with their own thresholds file); and the studio's shape — *design brief → one call per template → deterministic validation battery → store disabled → approve at the existing gate* — which needs only a channel's own role list, canvas and interest policy.
