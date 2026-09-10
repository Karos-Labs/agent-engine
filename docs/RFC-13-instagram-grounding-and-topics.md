# RFC-13 — Instagram agent: grounding, language, topics and research (Phase 0 + Phase 1)

Status: implementing (PR-A = Phase 0, PR-B = Phase 1). Source: prep audit of 10 runs on 2026-09-08 plus a two-architect design pass on 2026-09-09.

---

# Part 1 — Brief


Repo worktree to work in: `C:\Users\1\Documents\KarosLabs\agent-engine-instagram` (branch `feat/instagram-phase0-grounding`, cut from origin/main 745ba4a).
Never touch `C:\Users\1\Documents\KarosLabs\agent-engine` (dirty shared checkout) or any other `agent-engine-*` worktree.
Files are CRLF. Python text writes must use `newline=""`. Prefer Edit/Write tools over perl/sed.

## Owner's decisions (binding)
- Scope now: **Phase 0 and Phase 1 only** (below). Phases 2-6 are out of scope.
- **One PR per phase**, stacked: PR-A = Phase 0, PR-B = Phase 1 on top of A. Do not merge.
- **Cost ceiling per Instagram run: target $1.00, hard max $1.50** (today $0.19-0.86). So: copy stays on `claude-sonnet-4-6`; new judges/extractors run on the commodity tier (Gemini 2.5 Flash) or Sonnet where language quality demands; no Opus anywhere in the run. Every new model step must justify its cost in a comment and the design must carry a per-run cost estimate.
- **Harvesting/scraping = ScrappyCoco only** (`packages/tools/karos-scraper`, `ScraperProvider`: `searchKeyword`, `socialHistory`, raw page fetch). **No Apify.** No new third-party scraping vendors.
- **Engine-native, high standard**: everything is agents (`BaseAgent` via `wf.step.agent`), typed tools (`packages/tools/*` with zod schemas), and deterministic orchestration steps (`wf.step.code`) in the workflow. No porting of the legacy karos-agents Python/skill code; use it only as a reference for rules.
- Hebrew is a first-class target language (client `geektime`).

## What the audit found (evidence from 10 prep runs, 2026-08-25..09-08)
1. `04a-research-pull` sends the run request verbatim as the web query (`query: "Create content that introduces the new offer to first-time buyers"`), no grounding in the client's business → Karos Labs (AI marketing agency) shipped a real-estate carousel about MassHousing/Gen H. Approved at the gate.
2. Topic fallback is the literal string `${industry} trends this week` (`create-instagram-agent-workflow.ts:~1127`); trend scout (`03a/03b/03c`, shared `runTrendScout` in `packages/workflow/src/primitives/social-trend-scout.ts`) runs only when `claimedTopic.source === "research"` (~:1180). 5 auto runs landed on the same topic.
3. Research is thin: `research.pull` default `maxResults: 4` (`packages/tools/karos-research/src/pull.ts:52`), 4000 chars/doc (`payload.ts:95`), `window: "24h"`; copy agent has `allowedTools: []`.
4. Image vetting (`instagram-image-vet@2`, Gemini Flash) judges objects ("person + laptop + dark setting"), not whether the image shows the slide's claim → client photos of Maccabi TA fans shipped under Juventus/MLS headlines.
5. Non-English: templates hardcode Google Fonts `Fraunces|Inter|IBM Plex Mono` (`agents/instagram-agent/assets/templates/default/*.html`), `brand-render-tokens.ts:~485-592` only adds client-declared families → Hebrew renders in Chromium fallback. Language gate steps `07e-language-script`/`07f-language-fluency` did not run in ANY sampled run (including 2026-09-08); `runLanguageFluency` error result never fails the draft (~:2569); `checkExpectedScript` skips languages missing from `SCRIPT_TABLE` (`language-gate.ts:107-143`) and below a 0.3 ratio (`:177`). `craft-hygiene.ts` tokenises `/[A-Za-z]…/` (`:120`, Latin only) and iterates slides only (`:166`) — the caption is never linted. `02d-load-target-language` returned null for karoslabs (`brand.language` unset); geektime's language must come from the profile.
6. `renderRules` (`frozen.styleConfig.rules.filter(check === "render")`, ~:1023) is empty for every client → `08b-visual-qa` passes with "no render rules provided"; vision `fitScore` is 5 on every slide.
7. Brand accent drifts between runs (`#ff6b2c` vs `#d95f2b`; `--bg` flips) and the learned preference "dark bg + orange text" then fails `checkPaletteWithinKit` → 3-attempt hold, $0.86 burned (run `pubsub-21634455753345065`).
8. Cross-run memory distills colour only (`distillStylePreferences`, ~:880); nothing records archetypes/templates used.
9. Cover slide = headline on blank ground (top 60% empty), no closer/CTA; numbers as prose. (Template work is Phase 2 — out of scope — but Phase 0 renderRules must be satisfiable with the 6 bundled archetypes: `photo`, `stat_callout`, `quote_card`, `comparison_card`, `list_takeaway`, `headline_focus`.)
10. Copy prompt `instagram-copy@11` (`prompts/instagram-copy/latest.md`, H1 wrongly says v10): four mechanical bans, no voice/POV/insight guidance, no hashtags anywhere.

## Phase 0 — fixes that need no redesign (PR-A)
A. **Fonts by script**: renderer adds Hebrew (`Heebo`, `Assistant`, `Rubik`) / Arabic (`Noto Sans Arabic`) / other script families automatically from the target language, with a per-script type scale (size, line-height) — in `brand-render-tokens.ts` + template `<link>` or injected `@import`, driven by `targetLanguage`, not by what the client declared. Tests render a Hebrew slide and assert the font stack.
B. **Language gate always on** for any non-English target: `07e/07f` run every attempt; a `fail` OR an `error` from the fluency judge returns the draft to `05` with the findings (fail-closed, capped by the existing attempt limit → hold). `craft-hygiene` uses `\p{L}` tokenisation and also lints the caption. Target language resolves from `brand.language` → profile/voice-rules inference → hold-with-reason if still unknown for a client whose profile is clearly non-English.
C. **Grounding gate**: a deterministic pre-research step builds a compact `clientBrief` from profile + voice rules + brand + context docs (what they sell, to whom, current offer, core terms, forbidden) and REWRITES the research query as `<request> in the context of <what the client does> for <audience>`; a post-copy relevance judge (commodity tier) answers "would a reader see how this post connects to this business?" with a 1-5 score and reason; below threshold → return to `05` with the reason (existing return/hold semantics). Phase 1 replaces the deterministic brief with the persisted one — design the interface so Phase 1 is a drop-in.
D. **Default renderRules** for every client when the frozen config has none: cover carries an image or a figure device; no slide with fewer than two content elements; a slide whose body leads with a number uses `stat_callout`/`comparison_card`; last slide carries a CTA/question. Deterministic checks where possible (`visual-qa-pre-checks.ts`), the judge only for what needs judgment.
E. **Trend scout always runs** (also with a non-empty catalog and also with a requested subject, as an "alternatives" signal); candidates are weighted against the catalog row and the request; the `trends this week` default is removed; content mode rotation uses the shared `selectContentMode` instead of `ownShippedCount % 3`.
F. **Semantic image vetting**: the vet prompt (bump to `instagram-image-vet@3`) receives each slide's headline + body and returns `claimMatch: 1-5` + reason; selection requires claimMatch ≥ 3; a client (tier-0) photo that does not match its assigned slide is re-offered to the slide it fits best, or left out (existing text-only downgrade path). Vision inspection (`05c`) output feeds the vet as today.
G. **Accent ring alignment**: one source of truth for the accent ring (brand kit); a learned colour preference that is not inside the ring is recorded as a note for the reviewer, never applied — so it cannot cause a hold.

## Phase 1 — topics and research at editor level (PR-B)
H. **Client Brief as a persisted artifact**: a setup-style agent step (runs when missing or older than 30 days; Sonnet) reads profile, brand, voice rules, context docs, the client's site (ScrappyCoco page fetch) and recent own posts (`research.socialHistory`), and writes `clients/<slug>/brief/instagram-brief.json` to the WorkspaceStore: positioning, ICP, current offer(s), core terms, 3-7 reference accounts (platform+handle) with why, forbidden topics/claims, language + register. Typed zod schema in a tool package (`client.getBrief` / `client.writeBrief`). Consumed by scout, research, copy, relevance judge.
I. **Topic engines**: candidates come from (1) niche news (existing scout), (2) what reference accounts posted that worked — `research.socialHistory` on the brief's reference accounts, scored by available engagement fields, (3) audience questions from communities via `searchKeyword` (ScrappyCoco) queries derived from the brief, (4) the client's own assets (context docs: case studies, data, events), (5) evergreen angles from the brief. A scoring step ranks by interest × brand fit × distance from the last 5 posts across channels (existing cross-channel history) and picks one; alternatives are recorded so the reviewer sees what was not chosen. Must stay inside the cost ceiling (one scout model call, deterministic scoring).
J. **Deep research**: 12+ documents, windows 7d (news) / 90d (insight), primary sources preferred (client docs, reports, PDFs), extraction into fact cards `{claim, source, url, date, kind: stat|quote|event|definition}` with dedupe; extraction stays on the commodity tier unless quality tests show it must move to Sonnet (then justify cost). `research.pull` gains `maxResults`/`window`/`contentChars` per call without changing other agents' defaults.
K. **Angle step**: before copy, a Sonnet agent proposes 3 angles (wrong assumption in the niche / surprising number / "what this means for <ICP>") each with the one sentence the reader should remember; deterministic pick by brief fit + novelty vs the ledger; chosen angle + the two rejected ones go to the copy prompt and to the ledger so angles do not repeat. Bump `instagram-copy` to @12 with the angle/brief sections (keep all existing sections).

## Engine conventions to follow
- Steps: `wf.step.code` / `wf.step.agent` in `agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts`; keep step ids stable where possible (Studio keys stageModels by agent class id, e.g. `instagram-copy`). New agents = new class id + prompt folder `prompts/<id>/1.md` + `latest.md` (identical), `skillRef: "<id>@1"`, `modelPolicy: resolveModelPolicy(...)`.
- Prompt bumps: add `prompts/<skill>/<N+1>.md`, make `latest.md` identical, bump `skillRef`, fix the H1 version line.
- Tools: zod input/output schemas, `not_available` for missing credentials, never placeholder data. Scraper access only via `ScraperProvider`.
- Gates: return-to-step vs hold semantics already exist (`07-self-check` attempts, `runReviewCycle`). Reuse them; do not invent a parallel mechanism.
- Tests: vitest per package, helpers in `agents/instagram-agent/__tests__/test-helpers.ts` (fake router turns). Run `npm run build && npm run typecheck` at the root and `npm test -w @agent-engine/agent-instagram -- --testTimeout=180000` plus the suites of every touched package. PRs get **no CI** (quality.yml is workflow_call), so local green is the gate.
- After workflow step changes, note that `agent-middleware/scripts/generate_engine_stages.py --check` must be re-run by the owner (separate repo); list new/renamed step ids in the PR body.
- Commit message trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.


---

# Part 2 — Technical spec

# Instagram agent — Phase 0 + Phase 1 final spec (2026-09-09)

Worktree: `C:\Users\1\Documents\KarosLabs\agent-engine-instagram` (branch `feat/instagram-phase0-grounding`, base 745ba4a). PR-A = Phase 0 (items A-G), PR-B = Phase 1 (items H-K) stacked on A. Binding constraints from the brief hold everywhere: ScrappyCoco only via `ScraperProvider`, no Apify, no Opus, copy stays on `claude-sonnet-4-6`, judges/extractors on Gemini 2.5 Flash (or the existing Haiku `commodity` fluency judge), engine-native (`wf.step.code` / `wf.step.agent` / zod tools), gates reuse `lastSelfCheckReason` + `continue` under `MAX_SELF_CHECK_ATTEMPTS = 3` → `WorkflowHeld`, Hebrew first-class, cost target $1.00 / hard max $1.50 per run.

This spec is a synthesis of Design A (minimal-diff) and Design B (quality-first). Per item it says which candidate the choice came from and why. Section 0 records what was verified in the worktree, including where a candidate was wrong.

---

## 0. Verification results (read before implementing)

| Claim | Verdict | Where |
|---|---|---|
| ScrappyCoco price is unknown / "not in pricing.ts" (A, risk 1) | **A wrong.** `web.search_web` bills ≈ **$0.007 per execution**, documented in the adapter header. Used for every vendor row below. | `packages/tools/karos-scraper/src/scrappycoco.ts:149` |
| `SearchOptions.includeDomains` already exists and reaches the adapter (B) | **B right.** `include_domains` is sent when non-empty. `research.pull` does not expose it yet. | `provider.ts:62`, `scrappycoco.ts:237` |
| `parseContentModeFromSummary` / `selectContentMode` are shared | Both right. Both live in `packages/workflow/src/primitives/social-trend-scout.ts:76-110`; x-agent and linkedin-agent import them. The regex is `/mode: ([a-z-]+)/` so `(mode: hot-news; angle: …)` still parses. | |
| `buildTrendQueries({requestedTopic})` and `runTrendScout({requestedTopic})` exist | **A right**; no primitive change is needed for E. | `social-trend-scout.ts:117,135,294,380` |
| Templates read `calc(Npx * var(--ts, 1))` | Both right (76px in `slide.html`, 118px in `headline-focus.html`, etc.). **Neither noticed** that `--ts` is set by the template's own `:root{--ts:1}` and `body.ts-s / body.ts-l` rules (`slide.html:48-58`, driven by the per-slide `fontScale` field). A script scale must compose with those, not fight them — see A below. | |
| Accent drift mechanism (A §G) | **A right, B incomplete.** `resolveSlideAccent` (`slides-data.ts:180-189`) uses the ring only when `paletteForSlide(...).rotates === true`, i.e. ring length ≥ 2; a **1-member ring falls back to `brandTokens.accentColor ?? brandAccentFallback`** (`:777`). The ring anchor is `overrides.accent ?? brand.accent ?? colors.primaryAccent` (`brand-render-tokens.ts:509`) and `kitAccentCandidates` (`:323`) never includes `brandTokens.accentColor`. So config `#ff6b2c` + brand.json `#d95f2b` → ring `[#d95f2b]` → slides paint `#ff6b2c` → `checkPaletteWithinKit(usedHexes, effectiveKit.palette)` (`workflow:2709`) fails every attempt. B's learned-preference filter alone would not close this. | |
| `brandFragments()` returns `{}` when `effectiveKit === undefined` | Verified (`workflow:1003`). A brandless Hebrew client (karoslabs-shaped empty brand.json) gets **no head fragment at all** today. Script fonts must therefore be emitted independently of the kit (neither design fully handled this; A's `hasAnything` tweak is a partial fix). | |
| `resolveLayout` allows `stat_callout`/`comparison_card`/`quote_card`/`list_takeaway`/`headline_focus` **once per carousel**; a repeat degrades to `text_only` | Verified (`slides-data.ts:468-470`, copy prompt §7). Both designs undersold the consequence for D's "numbers → device" rule: at most one stat_callout AND one comparison_card can exist, so the rule must be paired with prompt guidance ("every other numeric fact leads with the noun"). | |
| `craft-hygiene.ts` is Latin-only and lints slides only | Verified (`:120` `/[A-Za-z][A-Za-z'-]*/g`, `:166` `for (const slide of copy.slides)`). `gate.lintPost` supports `parts` and the instagram 2200-char limit (`lint-post.ts:112,163`). | |
| Fluency `error` never fails the draft; 07e/07f only when `targetLanguage !== undefined`; 02d reads only `brand.language` | Verified (`workflow:2532-2568`, `:789-795`). `SCRIPT_TABLE` is **not exported** from `language-gate.ts` (`:107`, plain `const`); `resolveExpectedScript` is. | |
| `research.pull`: `maxResults` 1..10 default 4, `DEFAULT_CONTENT_CHARS = 4000` hard-wired, cache keyed `(job, query)` with no record of the size fetched | Verified (`pull.ts:48-57,187`, `payload.ts:95`). B's point that a cached 4000-char record must not be served to a larger request is right. | |
| `research.socialHistory` returns `engagement {likes, comments, views}`, platforms x/instagram/reddit/tiktok | Verified (`social-history.ts:38-43`, `provider.ts:20`). LinkedIn/YouTube reference accounts cannot be read. | |
| `ScraperProvider` has `extractUrl`, `searchKeyword`, `socialHistory`, `fetchRaw`, `searchSocial` (+ optional crawl family); no agent-facing tool exposes `extractUrl` | Verified (`provider.ts:196-217`). | |
| `topics.release` exists | Verified (`karos-topics/src/index.ts:19`). | |
| `memory.appendDecision {decisionId, summary, rationale?}` / `memory.read {scope:"decisions", limit}` exist; instagram never writes decisions today | Verified. | |
| `AgentExecutionResult.totalCostUsd` is populated by `wf.step.agent` results | Verified (`base-agent.ts:1062`, `agent-step.ts:176`). Whether Gemini-on-Vertex steps report non-zero is **unverified** → the spend meter uses `max(measured, estimate)` per step. | |
| Registry snapshot test pins the tool count | `packages/tools/__tests__/cross-cutting.test.ts:88` asserts `names.length === 58`. PR-A → 59 (`client.getBrief`), PR-B → 61 (`client.writeBrief`, `research.fetchPages`). | |
| Fixture churn | 30 instagram test files use `fakeRouterSequence` positionally (canonical order research, copy, vet, visualQA — `workflow-e2e.test.ts:110`). Every unconditional new model turn (scout in PR-A; angle in PR-B) shifts them. Budgeted below via `__tests__/turns.ts`. | |
| `pullTrendResearch` is one code step over N queries; `mergeResearchPulls` dedupes by URL; `extractResearchCandidate` produces a real headline from documents | Verified (`social-trend-scout.ts:163-243`, `research-candidate.ts:123`). | |
| Layering: `packages/workflow` "sits below every agent and cannot import one" | Verified (`style-preferences.ts:101` and the workflow file's own import comment). Anything that needs `language-gate.ts` or instagram `types.ts` must live in the agent package. | |

**Placement decision (A over B):** all new logic lives in `agents/instagram-agent/src/workflow/*` (agent-local, like `language-gate.ts`), except what the brief explicitly wants in a tool package (`ClientBriefSchema`, `client.getBrief`/`client.writeBrief` in `karos-client`; `research.fetchPages` and `research.pull` options in `karos-research`). Shared `social-trend-scout.ts` changes are additive with defaults and confined to one Phase 1 WP. Reason: smaller blast radius, no x/linkedin fixture churn in PR-A, and the layering rule above makes B's shared primitives awkward (they would need the script table and topic types lifted first). Lifting to `packages/workflow` is a later refactor, not a Phase 0/1 deliverable.

**Pricing used:** Sonnet 4.6 $3/$15 per 1M in/out; Gemini 2.5 Flash $0.30/$2.50; Haiku 4.5 $1/$5; `gemini-2.5-flash-image` $0.039/image; vision inspection ≈ $0.001/image; ScrappyCoco $0.007/execution (`pricing.ts:49-65,282`; `scrappycoco.ts:149`).

---

## Phase 0 — PR-A

### A. Fonts by script — synthesis (B's ordering + A's table shape, kit-independent emission)

**Files:** new `agents/instagram-agent/src/workflow/script-fonts.ts`; `brand-render-tokens.ts` (`buildBrandHeadHtml` gains an optional `script` option; `deriveBrandRenderTokens` unchanged); workflow `brandFragments()` (integrator).

**Design**
```ts
// script-fonts.ts (agent-local; imports resolveExpectedScript from ./language-gate.js — no cycle)
export interface ScriptTypography {
  display: readonly string[]; body: readonly string[]; mono: readonly string[];
  typeScale: number;                         // multiplies the template's --ts
  lineHeight: { display: number; body: number };
}
export const SCRIPT_TYPOGRAPHY: Record<string, ScriptTypography> = {
  Hebrew:     { display: ["Heebo", "Rubik"], body: ["Assistant", "Heebo"], mono: ["Rubik"], typeScale: 0.94, lineHeight: { display: 1.12, body: 1.6 } },
  Arabic:     { display: ["Noto Sans Arabic", "Cairo"], body: ["Noto Sans Arabic"], mono: ["Noto Sans Arabic"], typeScale: 0.92, lineHeight: { display: 1.25, body: 1.75 } },
  Greek:      { display: ["Noto Serif"], body: ["Noto Sans"], mono: ["IBM Plex Mono"], typeScale: 1, lineHeight: { display: 1.05, body: 1.55 } },
  Cyrillic:   { display: ["Playfair Display"], body: ["Inter"], mono: ["IBM Plex Mono"], typeScale: 1, lineHeight: { display: 1.05, body: 1.55 } },
  Devanagari: { display: ["Noto Sans Devanagari"], body: ["Noto Sans Devanagari"], mono: ["Noto Sans Devanagari"], typeScale: 0.9, lineHeight: { display: 1.3, body: 1.7 } },
  Thai:       { display: ["Noto Sans Thai"], body: ["Noto Sans Thai"], mono: ["Noto Sans Thai"], typeScale: 0.9, lineHeight: { display: 1.35, body: 1.8 } },
  Armenian:   { display: ["Noto Sans Armenian"], body: ["Noto Sans Armenian"], mono: ["Noto Sans Armenian"], typeScale: 0.95, lineHeight: { display: 1.15, body: 1.6 } },
  Georgian:   { display: ["Noto Sans Georgian"], body: ["Noto Sans Georgian"], mono: ["Noto Sans Georgian"], typeScale: 0.95, lineHeight: { display: 1.15, body: 1.6 } },
  Japanese:   { display: ["Noto Sans JP"], body: ["Noto Sans JP"], mono: ["Noto Sans JP"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
  Korean:     { display: ["Noto Sans KR"], body: ["Noto Sans KR"], mono: ["Noto Sans KR"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
  Chinese:    { display: ["Noto Sans SC"], body: ["Noto Sans SC"], mono: ["Noto Sans SC"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
};
/** undefined for Latin / unknown / no language: byte-identical output to today. */
export function scriptTypographyFor(targetLanguage: string | undefined): { script: string; spec: ScriptTypography } | undefined;
/** Pure. Emits: one css2 <link> carrying every family (`family=A&family=B&display=swap`), and a <style> with the font-stack vars, the type-scale rules and the line-height rules. */
export function buildScriptFontHeadHtml(script: string, spec: ScriptTypography, clientFamilies: { display?: string; body?: string; mono?: string }): string;
```
Rules (B's ordering, with one exception):
- **Client family first, script family second, template fallback last** when the client declared a family for that role (`'Fraunces', 'Heebo', 'Rubik', Georgia, serif`) — Chromium falls back per glyph, so Latin loanwords keep the brand face and Hebrew glyphs get Heebo instead of the system fallback.
- **Script family first** when the client declared nothing for that role (`'Heebo', 'Rubik', 'Fraunces', Georgia, serif`): a headline that is mostly Hebrew with a few digits should share one face's metrics rather than mix the template's Latin serif with Heebo.
- Type scale composes with the reviewer's `fontScale`: emit `body { --ts: <s> } body.ts-s { --ts: calc(0.85 * <s>) } body.ts-l { --ts: calc(1.18 * <s>) }` where `<s>` is `typeScale`. Same selectors as the template's own rules (`slide.html:48-58`), so the fragment must be spliced **after** the template's `<style>` in `<head>` (verify `composeRawDocument` in `karos-templates/src/materialize.ts`; if it splices before, wrap the rules in `@layer` or raise specificity to `html body`). Line heights: `.headline, .quote-text, .figure, .cmp-head, .item-title { line-height: <display> } .body, .sub-label, .item-note, .kicker { line-height: <body> }`.
- **Kit-independent**: the workflow's `brandFragments()` becomes `head = [scriptHead, brandHead].filter(Boolean).join("\n")`, where `scriptHead = buildScriptFontHeadHtml(...)` is computed from `targetLanguage` (02d) and `effectiveKit?.cssVars["--f-*"]`-derived client families, **even when `effectiveKit === undefined`**. No checkpoint shape changes anywhere; no reordering of 02c/02d.
- `dir` handling is unchanged (`detectDirection` in `slides-data.ts` already sets `dir="rtl"` from the copy).

**Model/cost:** none. **Gate:** none.

**Tests** (`__tests__/script-fonts.test.ts`, `brand-render-tokens.test.ts`):
- `scriptTypographyFor("Hebrew")`, `("he-IL")` → Hebrew spec; `("en")`, `(undefined)`, `("Klingon")` → undefined.
- `buildScriptFontHeadHtml("Hebrew", spec, { display: "Fraunces" })` → `--f-display: 'Fraunces', 'Heebo', 'Rubik', …`, `--f-body: 'Assistant', 'Heebo', …` (no client body family → script first), one `<link>` containing `family=Heebo` and `family=Assistant`, rule `body.ts-s { --ts: calc(0.85 * 0.94) }`.
- Compose a Hebrew `headline_focus` slide through `composeRawDocument` with `[scriptHead, brandHead]` and assert the script fragment appears after the template's `</style>` and contains `Heebo`.
- Latin target with a kit → head byte-identical to today's `buildBrandHeadHtml` output (regression pin).
- Optional Chromium-gated render behind `isChromiumInstalled()`.

**Risks:** Google Fonts reachability in the render sandbox (already a dependency of the default templates). Rubik as Hebrew mono is a stand-in (mono is rare on slides).

### B. Language gate always on — Design A's 02d-in-place resolution + B's script classification and in-step retry

**Files:** new `agents/instagram-agent/src/workflow/target-language.ts`; `language-gate.ts` (`runLanguageFluency` gains one in-step retry; `SCRIPT_TABLE` gets an exported read-only view `scriptTableEntries()` so the inference can reuse `names`/`tags`/`test`); `craft-hygiene.ts`; workflow `02d` body + `07f` posture (integrator).

**Resolution**
```ts
export type TargetLanguageResolution =
  | { status: "resolved"; language: string; source: "brand" | "profile" | "voice-rules" | "brand-voice-doc" | "script-sniff" }
  | { status: "english-default"; evidence: string[] }
  | { status: "unresolved-non-english"; script: string; candidates: string[]; evidence: string[] };
export function resolveTargetLanguage(input: { brandLanguage?: unknown; profile?: Record<string, unknown>; voiceRules?: Record<string, unknown>; brandVoiceDoc?: string }): TargetLanguageResolution;
```
Order: (1) `brand.language` (non-empty string) wins. (2) An explicit language name/tag from the script table's `names` in `profile.description`, `voiceRules.guidelines`/`doList`, or the brand-voice doc, matched only in the shapes `\b<name>(-|\s)?(language|speaking|only)\b`, `publish(es|ed)? in <name>`, `written in <name>`, `content in <name>` (so "we work with Hebrew-speaking founders" does NOT resolve — "speaking" only counts when followed by "audience|market|readers"; document this in a test). (3) Script sniff of the same prose: if ≥ 50% of `\p{L}` letters fall in one non-Latin script, single-language scripts (Hebrew, Greek, Thai, Armenian, Georgian; Japanese when Hiragana/Katakana present; Korean when Hangul present) resolve to their language; multi-language scripts (Arabic, Cyrillic, Devanagari, Han-only) yield `unresolved-non-english` with the table's `names` as candidates. (4) Otherwise `english-default`.

**Step `02d-load-target-language`** keeps its id and `string | null` checkpoint shape; only the body changes: it reads `client.getBrand`, `client.getProfile`, `client.getVoiceRules` and the brand-voice doc (via `client.getContextDoc`, best-effort), calls `resolveTargetLanguage`, returns the language or `null`, and on `unresolved-non-english` throws `WorkflowHeld("target language could not be resolved for a client whose profile is written in <script> (candidates: …) — set brand.language in the portal")`. Hold, not return-to-step: this is intake. A resumed run replays its old checkpoint value unchanged (additive semantics).

**Gate posture:** for any resolved non-English language, 07e and 07f run on every attempt (they already do once `targetLanguage` is set). **07f fails closed**: `if (fluency.status !== "fluent") { lastSelfCheckReason = …; continue; }`. An `error` reads "the fluency judge could not run (<error>): refusing to ship unverified <language> copy". Mitigation inside the existing semantics: `runLanguageFluency` retries the judge **once within the same step** before reporting `error` (a transient 429 must not cost a Sonnet redraft); the `error` return shape is unchanged, only the caller's posture flips. Bounded by `MAX_SELF_CHECK_ATTEMPTS` → existing `WorkflowHeld`, whose reason names the outage so an operator does not chase a copy problem. `checkExpectedScript`'s 0.3 ratio and unknown-language skip stay (stage 2 now fails closed for those).

**Craft hygiene:** `checkSentenceCase` tokenises `/\p{L}[\p{L}'’-]*/gu`; caps rules apply only to cased tokens (`w !== w.toLowerCase()`), so Hebrew/Arabic/CJK never read as shouting; Title-Case heuristic counts only cased tokens (`/^\p{Lu}\p{Ll}/u`). `checkCraftHygiene` lints the **caption** first via one `gate.lintPost({ text: caption, parts: slides.map(headline+body[+custom fields]), platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 0, bannedPhrases: [] })` call — the caption gets the 2200-char limit for free, a failing part names the slide — then runs `checkSentenceCase` on the caption (hashtags stripped first) and on each slide. Reasons say `caption failed …` vs `slide N failed …`.

**Model/cost:** fluency judge (Haiku, ~4k in / 0.3k out ≈ **$0.0055/attempt**, non-English only) now actually runs. No new model.

**Tests** (`target-language.test.ts` new; `language-compliance-gate.test.ts`, `craft-hygiene.test.ts` updated):
- brand.language wins over a profile that says otherwise; "Israel's largest Hebrew-language technology site" → resolved/profile/Hebrew; Hebrew-script guidelines with no name → resolved/script-sniff/Hebrew; Cyrillic-only profile → unresolved with candidates; "we work with Hebrew-speaking founders" → english-default; plain English → english-default.
- Workflow: geektime-shaped client with NO `brand.language` → `07e-language-script-attempt-1` present (today absent). Invert the existing "a judge that cannot complete never blocks a draft" test: judge `error` on attempt 1 (after the in-step retry also errors) → `05-write-copy-attempt-2` exists; `error` ×3 → hold whose reason contains "could not run"; `not_fluent` ×3 → hold; `08-render-carousel-attempt-1` absent in both hold cases.
- Cyrillic profile → run holds at 02d and no copy turn is consumed (router turn count 0).
- `checkCraftHygiene`: caption with an em dash fails naming the caption; caption of 2300 chars fails; Hebrew slide with a Latin acronym passes; "GDPR IS BROKEN" still fails; Hebrew text never trips caps rules.

### C. Grounding gate — A's schema seam in `karos-client` + A's step placement, B's `confidence/gaps/generatedBy`, B's direction-vs-subject rewrite

**Files:** new `packages/tools/karos-client/src/brief.ts` (schema + `client.getBrief` reader; `client.writeBrief` is Phase 1), `karos-client/src/index.ts` (register + amend the read-only comment), new `agents/instagram-agent/src/workflow/client-brief.ts`, new `agents/instagram-agent/src/workflow/relevance-gate.ts`, `prompts/instagram-copy/12.md` + `latest.md`, `instagram-copy-agent.ts` (`skillRef: "instagram-copy@12"`), workflow steps `02i*`, `04a` query, `07g` (integrator).

**Schema (final; Phase 1 writes exactly this)**
```ts
export const BRIEF_TTL_DAYS = 30;
export const briefSegments = (channel: string) => ["brief", `${channel}-brief`];   // clients/<slug>/brief/instagram-brief.json
export const ClientBriefSchema = z.object({
  version: z.literal(1),
  channel: z.enum(["instagram", "x", "linkedin", "tiktok", "reddit"]),
  generatedAt: z.string().datetime(),
  generatedBy: z.enum(["deterministic", "agent", "human"]),
  agentSkillRef: z.string().optional(),
  sources: z.array(z.object({ kind: z.enum(["profile","brand","voice-rules","context-doc","knowledge","intel","site","social-history"]), ref: z.string() })).default([]),
  positioning: z.object({ oneLiner: z.string().min(1).max(240), whatWeSell: z.string().min(1).max(400), differentiators: z.array(z.string()).max(6).default([]) }),
  icp: z.object({ summary: z.string().min(1).max(240), roles: z.array(z.string()).max(6).default([]), pains: z.array(z.string()).max(6).default([]), industries: z.array(z.string()).max(6).default([]), geos: z.array(z.string()).max(4).default([]) }),
  offers: z.array(z.object({ name: z.string().min(1), summary: z.string().min(1), url: z.string().optional(), validUntil: z.string().optional() })).max(5).default([]),
  coreTerms: z.array(z.string().min(1)).min(1).max(20),
  referenceAccounts: z.array(z.object({ platform: z.enum(["x","instagram","reddit","tiktok"]), handle: z.string().min(1), why: z.string().min(1) })).max(7).default([]),   // only platforms research.socialHistory can read
  forbidden: z.object({ topics: z.array(z.string()).default([]), claims: z.array(z.string()).default([]) }),
  language: z.object({ target: z.string().optional(), register: z.string().optional() }),
  evergreenAngles: z.array(z.string()).max(8).default([]),
  ownAssets: z.array(z.object({ title: z.string(), kind: z.enum(["case_study","data","event","product","doc"]), summary: z.string(), sourceRef: z.string() })).max(12).default([]),
  confidence: z.enum(["high","medium","low"]),
  gaps: z.array(z.string()).default([]),
});
// client.getBrief: input { channel } -> success { brief: ClientBrief, ageDays: number } | not_available("no <channel> brief for this client")
```
`briefForPrompt(brief)` (in `client-brief.ts`) renders positioning, icp, offers, coreTerms, forbidden, language, confidence (≈ 600-800 tokens). `isBriefStale(brief, now)` = `generatedBy === "deterministic"` or age > `BRIEF_TTL_DAYS`.

**Steps**
- `02i-resolve-client-brief` (code, after 02h): `client.getBrief({channel:"instagram"})` → if present and not stale use it (`source: "persisted"`); else `deriveClientBrief({ profile, voiceRules, brand, contextDocs, knowledge, forbiddenTopics: frozen.forbiddenTopics, targetLanguage })` (`source: "derived"`). Context docs read best-effort via the existing `readContextDoc(wf, tools, ctx, docType, stepId)`: `02i1-load-product-information`, `02i2-load-target-audience`, `02i3-load-market-strategy` (brand-voice is already in `clientVoiceContext`). Pure derivation: `positioning.oneLiner` = first sentence of `profile.description` (else `brand.tagline`, else `"<companyName>, <industry>"`); `whatWeSell` = product-information first paragraph (else industry); `icp.summary` = target-audience first paragraph (else `"practitioners in <industry>"`); `coreTerms` = top TF `\p{L}` tokens ≥ 4 letters minus stopwords across profile + docs + voice rules, plus `profile.industry`, top 12; `offers` = product-information lines matching `/offer|launch|new|pricing|plan|מבצע|השקה/iu`; `forbidden.topics` = `frozen.forbiddenTopics`, `forbidden.claims` = `voiceRules.dontList`; `evergreenAngles` = `voiceRules.doList` (≤ 8); `ownAssets` from `client.getKnowledge` assets/transcripts titles; `confidence: "low"`; `gaps` names every missing source. Never blocks; validates against `ClientBriefSchema` before returning. Output `{ brief, source, notes }`.
- `04a-research-pull` (same id, same `{runId, query, result}` shape): `query = buildGroundedQuery(topicClaim, brief)`:
  - `source === "trend"` → the scouted `headline` as-is (already brand-fit judged);
  - otherwise `<subject> in the context of <brief.positioning.whatWeSell> for <brief.icp.summary>`, trimmed to ≤ 200 chars. `<subject>` = the topic, except when the request is a *direction* (starts with a verb like create/write/make/introduce/post about — reuse `run-direction.ts`'s `looksLikeTopic` inverse) in which case the subject is the noun phrase after "about/introducing/on" when present, else the whole request (B's refinement, kept simple).
  - If the grounded pull returns 0 documents, one fallback pull inside the same step with `<subject> <coreTerms[0..1]>` (both cached). The step output additionally records `{ groundedQuery, rewrittenFrom, fallbackUsed }` — additive fields.
- Copy input gains `clientBrief: briefForPrompt(brief)` and, on attempt ≥ 2 after a relevance fail, `relevanceSteer: string`.
- `07g-relevance-attempt-N` (agent, inside `draftOnce`, after 07e script check, before 07f fluency — cheapest paid check first): `runRelevanceJudge(wf, deps, stepId, { brief: briefForPrompt(brief), topic, caption, slides: [{n, headline, body}] })` → `DynamicAgent` id **`instagram-relevance-judge`** (Studio key), `allowedTools: []`, `maxSteps: 1`, `modelPolicy: resolveModelPolicy("instagram-relevance-judge", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" })`, output fields `{ score: 1-5, reason, missingBridge? }` via `buildOutputSchema`. System prompt: "You are a reader who follows this account. Given the brief, would you see how this post connects to what this business sells and to whom? 5 = unmistakably this business; 3 = the bridge exists but takes a sentence; 1-2 = a different business could have posted this. State the missing bridge when < 3." `MIN_RELEVANCE_SCORE = 3`, lowered to `THIN_GROUNDING_MIN_RELEVANCE_SCORE = 2` when the brief is thinly grounded (`isThinlyGrounded`: no product-information AND no target-audience document, so `whatWeSell` is the industry and the ICP is "practitioners in <industry>") — 2 is the rubric's own ceiling for a post written from industry-only grounding, so at floor 3 that client fails every attempt on a verdict no redraft can answer; a relaxed pass carries `relevance.note` on the gate payload and a `${runId}__relevance-thin-grounding-a${attempt}` ledger warn, and 1 is still off-brief. Below the floor → `lastSelfCheckReason = "post does not read as this client's (relevance N/5): <reason>"`, `relevanceSteer = missingBridge ?? reason`, `continue`. Judge `error` → **fail open** with a ledger warn (`eventId: ${runId}__relevance-judge-unavailable-a${attempt}`) — unlike B, this is a quality gate on a run that still has a human gate; the brief's binding rule is about the score, not the outage. Verdict goes into the gate payload as `grounding: { briefSource, briefConfidence, relevance: { score, reason } }` and into the deliverable.
- Cost comment (required by the brief) on the judge: "one Flash call per attempt (~$0.002) closes the MassHousing class of defect at < 2% of the copy step's cost".

**Copy prompt `instagram-copy@12`** (all 14 sections kept; H1 fixed to "v12"): §15 "Who this client is (read before the facts)" — `clientBrief`: every slide must be legible as THIS business speaking to THIS audience; use `coreTerms` where the audience would; `forbidden.claims` are never made; `relevanceSteer` names why the last draft failed the relevance check and must be fixed, not argued with. §7 gains D's rules (text in D below). §2 unchanged (hashtags: out of scope for A-K; flagged for the owner in §Open questions).

**Model/cost:** relevance Flash ~4k in / 0.3k out = **$0.002/attempt**; copy input +~1.5k tokens = **+$0.0045/attempt**; fallback pull +$0.007 (rare).

**Tests** (`client-brief.test.ts`, `grounding-gate.test.ts` new; `karos-client/__tests__/brief.test.ts` new):
- `deriveClientBrief` from a karoslabs-shaped profile ("AI marketing agency for B2B founders") → `positioning.oneLiner` non-empty, `coreTerms` ⊇ {"marketing"}, valid against the schema; empty profile → still valid with `coreTerms: [industry]` and `gaps` non-empty.
- `buildGroundedQuery({topic:"Create content that introduces the new offer to first-time buyers", source:"requested"}, brief)` contains " in the context of " and the ICP, ≤ 200 chars; trend source passes the headline through unchanged.
- `client.getBrief` → `not_available` when missing; returns `ageDays` when present; `isBriefStale` on a 31-day-old brief and on `generatedBy: "deterministic"`.
- Workflow: judge turn `{score: 2, reason, missingBridge}` on attempt 1 and `{score: 5}` on attempt 2 → `05-write-copy-attempt-2` exists and its checkpointed input carries `relevanceSteer`; run delivers; gate payload has `grounding.relevance.score === 5`. Score 2 ×3 → hold naming relevance. Malformed judge turn → run delivers, ledger has the warn event. `04a-research-pull` checkpoint's `query` is the grounded string. Registry count 59 in `cross-cutting.test.ts`.

**Risks:** keyword search vs long natural-language query (fallback pull covers the empty case; one prep sample needed); Flash may over-score generic marketing copy — threshold 3 is deliberately lenient; a 10-draft calibration fixture under `agents/instagram-agent/evals/` is a Phase 1 follow-up.

### D. Default renderRules — synthesis (A's deterministic pre-render step 07h, B's rule ids/year-exclusion/no-deterministic-CTA-fail, prompt-side one-per-carousel guidance)

**Files:** `visual-qa-pre-checks.ts` (`DEFAULT_RENDER_RULES`, `checkDefaultRenderRules`, exported `LAYOUT_FIELD_KEYS`), copy prompt @12 §7 (owned by C's WP; text below), workflow (renderRules resolution ~:1023, new `07h` in the loop, 08b residue; integrator).

**Rules**
```ts
export const DEFAULT_RENDER_RULES: StyleRule[] = [
  { id: "default:cover-carries-device",  check: "render", description: "Slide 1 carries a photograph or a figure device (stat, comparison, quote, list). A headline alone on empty ground is not a cover." },
  { id: "default:two-elements-per-slide", check: "render", description: "Every slide carries at least two content elements (headline + body, figure + label, quote + attribution, image + headline, list with 2+ items)." },
  { id: "default:numbers-are-devices",    check: "render", description: "A slide whose headline or body opens with a number, percentage or currency amount is set as a stat callout or comparison card, never as prose. Only one of each exists per carousel, so every other numeric fact leads with the noun." },
  { id: "default:closer-carries-cta",     check: "render", description: "The last slide of a carousel (the caption, for a single) carries a call to action or a question the reader can answer." },
];
export const LAYOUT_FIELD_KEYS = new Set(["accentColor", "dir", "brandHandle", "seriesBadge", "fontScale", "textAlign"]);  // the workflow's local NON_PROSE_FIELD_KEYS, lifted here
export function checkDefaultRenderRules(slidesData: RenderCarouselInput, copy: InstagramCopyOutput): { failures: Array<{ ruleId: string; slide?: number; reason: string }>; residue: StyleRule[] };
```
Deterministic (no model), run on the **assembled** slides-data (`07c`) so it sees resolved templates and hero images:
- cover: `slides[0].images.hero` present OR template basename ∈ {stat-callout, comparison-card, quote-card, list-takeaway} (incl. `-inv` siblings) → pass; `headline-focus`/`slide`(text_only)/photo-without-hero → failure.
- two elements: prose fields not in `LAYOUT_FIELD_KEYS` with non-empty values + (`images.hero` ? 1 : 0) + (`htmlFragments.itemRows` ? 1 : 0); `< 2` → failure. (On the cover a `headline_focus` headline + body count ONCE, the one lockup the template renders; that slide is already failed by the cover rule, so §7 tells the writer `headline_focus` is a mid-carousel turn and never slide 1.)
- numbers → devices: `LEADS_WITH_FIGURE = /^\s*(?:[$€£₪]\s?)?\d[\d.,]*\s?(?:%|[kKmM]\b|million|billion|אלף|מיליון|מיליארד)?/u` with a year exclusion `(?!\d{4}\b)`, tested on `copy.slides[i].headline` and `.body`; the resolved template must be stat-callout or comparison-card; otherwise failure naming the slide and the leading token.
- closer CTA: deterministic **pass** when the last slide's prose (caption for `single`) contains `?` or matches a small CTA lexicon (`/\b(save|share|comment|tell us|try|download|book|sign up|follow|dm|reply)\b/i`, Hebrew `/(שמרו|שתפו|ספרו|נסו|הורידו|עקבו|מה דעתכם|כתבו לנו)/`). Otherwise **no failure** — the rule goes to the judge as residue with the note "no question mark or lexicon CTA found; judge whether the closer invites action".

Wiring: `renderRuleSource = frozenRender.length > 0 ? "client" : "default"`; `renderRules = frozenRender.length > 0 ? frozenRender : DEFAULT_RENDER_RULES`. The copy step's `styleConfig.rules` includes the defaults when in force (so the writer is told the rules it will be judged by). When defaults are in force: new step `07h-default-render-rules-attempt-N` (code) right after `07c-emit-slides-data`; any failure → `lastSelfCheckReason`, `continue` (no render spent); `residue` joins 08b's `renderRules` input, so "no render rules provided" never happens again. Clients with their own render rules see zero change.

**Copy prompt §7 additions (exact text for C's WP to include in @12):**
> - **Cover.** Slide 1 carries a photograph or a figure device (stat, comparison, quote, list). In archetypes: `photo` with a real image sourced from its `visualNeed`, `stat_callout`, `comparison_card`, `quote_card` or `list_takeaway`. A headline on blank ground is not a cover, so `headline_focus` and `text_only` are never slide 1, and a `kicker` does not turn one into a cover. Whichever you pick, the headline is the one line the reader must see.
> - **Numbers are devices.** One `stat_callout` and one `comparison_card` exist per carousel. Put your strongest number in one of them. Every other numeric fact leads with the noun ("Teams that automated intake cut onboarding 40%"), never with the figure.
> - **Closer.** The last slide carries a call to action or a question the reader can answer, in the client's language.

**Model/cost:** none new; fewer 08b calls when a deterministic rule fails.

**Tests** (`visual-qa-pre-checks.test.ts`, `default-render-rules.test.ts` new, `style-config-render-rules.test.ts`): headline_focus cover without image fails; photo cover with hero passes; stat cover passes; "42% of teams…" body on a `photo` slide fails, on `stat_callout` passes, "2026 was the year…" passes (year exclusion); closer with `?` → no residue; closer without → residue contains the rule, no failure; Hebrew closer with "שתפו" passes deterministically; single-format caption CTA. Workflow: frozen config with zero render rules → `07h-default-render-rules-attempt-1` present and 08b input `renderRules` non-empty; config WITH render rules → `07h` absent and 08b input unchanged; a default failure on attempt 1 consumes zero QA turns.

**Risks:** first prep runs will pay one redraft while the writer adapts (≈ $0.12); the Hebrew figure lexicon may need tuning.

### E. Trend scout always runs — A's structure (unconditional 03a-03c, `03d` mode step, pure selection, alternatives on the claim) + B's degrade-on-scraper-outage, planned-row weighting and `topics.release`

**Files:** new `agents/instagram-agent/src/workflow/topic-selection.ts` (pure), `types.ts` (`InstagramTopicClaim` gains `alternatives?`, `mode?`, `weighting?`), workflow (03 fallback removed, 03a-03c unguarded, new `03d-select-content-mode`, new `03g-select-topic`, 09b `memory.appendDecision`; integrator). `social-trend-scout.ts` untouched in PR-A.

**Design**
- Remove the `if (claimedTopic.source === "research")` guard. `03a/03b/03c` run on every run. `buildTrendQueries({ …, requestedTopic: claimedTopic.source !== "research" ? claimedTopic.topic : undefined })` and `runTrendScout(…, { requestedTopic })` — the request/row is researched alongside the field. `03b` is wrapped in try/catch for `reserved`/`requested` sources: a `WorkflowToolingFailure` (scraper `not_available`/outage) degrades to "scout unavailable: <reason>" recorded on the claim, never a hold for a planned run; for `research` source the failure propagates (tooling, as today).
- `03-claim-topic`: delete the `${industry} trends this week` branch. With no row and no request the step returns `{ topic: industry, source: "research" }` as a **seed only** (or throws the existing hold when there is no industry either); `03g` must replace it or hold.
- `03d-select-content-mode` (code): `memory.read({ scope: "decisions", limit: 20 })` → `parseContentModeFromSummary` on each summary (oldest-first) → `selectContentMode(recentModes, runConfig.requestedMode)`; output `{ mode, source: "requested" | "rotation", priorMode? }`. Replaces `CONTENT_MODES[ownShippedCount % 3]`. (`04h` format rotation is out of scope and unchanged.)
- `03g-select-topic` (code, pure `resolveTopicClaim(seed, scout, mode, { avoidTopics, trendJacking, catalogRow, recentExcerpts })` in `topic-selection.ts`):
  1. `requested` (typed direction or `requestedSubject`) → stands; scout candidates recorded as `alternatives` (`reason: "outranked-by-request"`).
  2. `reserved` → row keeps the slot unless client config `trendJacking === "always"` AND a candidate scores `brandFit ≥ 4 && interest ≥ 4` AND `candidateScore > plannedScore` where `plannedScore = 4 × 3` (a human planned it) and `candidateScore = brandFit × interest × distance` (`distance = 1 − max trigramJaccard(candidate.topic+headline, recentExcerpts)`). When displaced: `source: "trend"`, the row is `topics.release`d (tool exists) and listed in `alternatives` (`reason: "outranked-by-trend"`). Otherwise alternatives carry `reason: "outranked-by-catalog"`.
  3. `research` seed → `selectTrendCandidate(scout.candidates, mode, { avoidTopics })` → `source: "trend"`; nothing eligible → `extractResearchCandidate(trendResearch.merged)` (a real fetched headline, never a literal) → `source: "research"`; nothing at all → `WorkflowHeld("no on-brand subject this week: catalog empty, nothing requested, scout considered N stories (best brand fit X/5) — add a catalog row or a requestedSubject")`.
  Output shape (checkpointed): `InstagramTopicClaim & { mode: ContentMode; alternatives: Array<{ topic; headline?; brandFit?; interest?; mode?; reason }>; weighting: { plannedScore?: number; bestCandidateScore?: number; rule: string }; scoutStatus: "ran" | "no-documents" | "unavailable" }`.
- Gate payload and deliverable carry `topicDecision: { source, mode, alternatives, weighting, scoutStatus }` so the reviewer sees what was not chosen.
- `09b-deliver-and-log`: `memory.appendDecision({ decisionId: `${runId}__topic`, summary: `instagram post: "<topic>" (mode: <mode>; source: <source>; archetypes: <resolved templates joined by ,>)`, rationale })` — idempotent, best-effort (try/catch like the excerpt write). This is the decision log `03d` reads next run, records archetypes used (audit finding 8) at zero cost, and is the row Phase 1's angle ledger extends.
- Source-pinning test (repo style): the string `trends this week` appears nowhere in `create-instagram-agent-workflow.ts`.

**Model/cost:** scout Flash on every run ~12k in / 2k out = **$0.009/run**; 03b ≤ 4 `searchKeyword` executions = **$0.028/run cold**, cached 7d per (job, query) per client — the industry/company queries repeat run to run, so a weekly cadence pays this about once a week.

**Gate:** none new; the only hold is the honest no-subject case.

**Tests** (`topic-selection.test.ts`, `trend-scout-always.test.ts` new; `topic-floor-breach.test.ts` updated; new shared helper `__tests__/turns.ts` exporting `standardTurns({ scout?, research, copy, vet, relevance?, fluency?, qa })` that returns the fake-router turn list in execution order):
- Healthy catalog → step store contains `03c-trend-scout`, claim is `reserved` with 1-3 `alternatives`; with `trendJacking: "always"` and a 5/5 candidate → `trend`, `topics.release` was called (the row is reservable again).
- `requestedSubject` → `requested`, alternatives tagged `outranked-by-request`.
- Empty catalog + scout turn with candidates → `trend`; scout turn with zero eligible candidates → `research` with a headline from the offline scraper's documents (assert not "trends this week"); offline scraper returning no documents → `WorkflowHeld`.
- Scraper `not_available` (`createAllKarosTools(store, undefined, { scraper: null })`) on a reserved run → run proceeds, `scoutStatus: "unavailable"`.
- `03d`: seed decisions `(mode: deep-value)`, `(mode: hot-news)` → `open-discussion`; `requestedMode` wins.
- Fixture migration: the integrator migrates the ~30 positional-turn tests to `standardTurns()` (mechanical, same PR).

### F. Semantic image vetting — Design A (claimMatch + prompt-side re-offer + harvest tier-0 slots), not B's `reoffers` array/06g step

Reason: the vet already sees every photo slide and the whole candidate pool (tier-0 uploads included), so a client photo can move slides through `selections` alone; a second output array and a new step would be a parallel mechanism for the same decision.

**Files:** `types.ts` (`ImageSelectionSchema` += `claimMatch: z.number().int().min(1).max(5)`, `claimMatchReason: z.string().min(1)` — both required, every fixture updated), `instagram-image-vetting-agent.ts` (`skillRef: "instagram-image-vet@3"`), `prompts/instagram-image-vet/3.md` + `latest.md` (H1 "v3"), `__tests__/test-helpers.ts` (`goodImageVettingOutput` adds `claimMatch: 5, claimMatchReason`), workflow 06/06c/06e inputs, `isUnfillable`, `slidesNeedingSource`, candidate tagging (integrator).

**Design**
- Vet input for 06 and every tier re-vet: `slides: [{ n, headline, body, visualNeed, isClientPhotoSlot: boolean }]`; tier-0 candidates get `[client upload, slot N]` prefixed to `description` at 05z (so the vet can tell them apart — `ImageCandidate` has no source field).
- Prompt v3: §1b "CLAIM MATCH — read the slide's headline and body first. `claimMatch` answers: does this picture show what the slide *claims*, not merely the objects `visualNeed` lists? 5 = the picture is evidence for the claim; 3 = compatible and generic, nothing contradicts; 1-2 = a different subject, team, place or era, or the picture contradicts the claim (Maccabi fans under a Juventus headline is 1, however good the photo). A selection needs `claimMatch ≥ 3`; below that return `imagePath: null` and say why in `claimMatchReason`." §6 "CLIENT PHOTOS — a `[client upload, slot N]` candidate may be selected for ANY photo slide it honestly fits best; never forced onto slot N, never chosen over a better-matching candidate solely because it is the client's, and never left unassigned when some slide honestly fits it."
- Deterministic belt: `isUnfillable` += `if (s.imagePath !== null && s.claimMatch < MIN_CLAIM_MATCH /* 3 */) return true` — never trusting the model's own threshold.
- `slidesNeedingSource` no longer excludes `tier0Slots` when `runDirection.mediaSource !== "client"`, so a slide whose upload the vet moved elsewhere has harvester alternatives instead of a forced text-only downgrade. Client-only runs keep today's behaviour (no harvesting).
- `05c` unchanged (per-batch brief cannot be per-slide); vision descriptions reach the vet as today. Follow-up noted: pass the slide claim into 05c's `brief`.

**Cost:** +~1k input tokens per vet call = **+$0.0003/call**; no new call. **Gate:** unchanged — a low `claimMatch` takes the existing text-only downgrade path.

**Tests** (`semantic-image-vetting.test.ts` new; `image-vetting-held.test.ts`, `tier0-user-media.test.ts` updated): vet turn with `claimMatch: 2` on slide 2 → slide 2 ships `text_only` with a downgrade reason quoting `claimMatchReason`; tier-0 upload assigned by the vet to slide 3 renders on slide 3 and slide 1 receives harvester candidates (fake `media.findImages` in the registry); schema rejects a selection without `claimMatch` (existing "failed its own output validation" path); a test pins `skillRef === "instagram-image-vet@3"`, `3.md === latest.md`, H1 "v3"; 05z candidate descriptions start with `[client upload, slot N]`.

### G. Accent ring alignment — Design A's mechanism (single ring source of truth, ring[0] for one-member rings) + learned-off-ring filter as a note (both), directive picks unioned into the palette check (B)

**Files:** `brand-render-tokens.ts` (anchor precedence, `kitAccentCandidates`, new pure `filterLearnedStyleToRing`), `slides-data.ts` (`resolveSlideAccent`), workflow `draftOnce` (~10 lines; integrator).

**Design**
1. Anchor precedence = the precedence `assembleSlidesData` paints with: `asHex(overrides.accent) ?? asHex(brandTokens.accentColor) ?? asHex(b.accent) ?? asHex(colors.primaryAccent)`. `kitAccentCandidates` takes `asHex(brandTokens.accentColor)` **first** (explicit beats derived), so config `#ff6b2c` and brand.json `#d95f2b` are both ring members and the anchor is the one that paints.
2. `resolveSlideAccent`: when the ring is non-empty, every slide's accent comes from the ring — `ring[0]` for a one-member ring (`rotates: false`, reason `"ring=1"` unchanged), the seeded rotation otherwise. `brandTokens.accentColor ?? brandAccentFallback ?? "#C4552F"` is used only when the ring is empty. `checkPaletteWithinKit` therefore cannot fail on a config-vs-brand disagreement; it stays as the belt.
3. Learned accent outside the baseline ring is a **note, never applied**: `filterLearnedStyleToRing(learned: StyleOverrides, ring: readonly string[]) → { applied: StyleOverrides; notes: string[] }` drops `learned.accent` when `ring.length > 0` and the hex is not a member (case-insensitive) — ground/fg are untouched (their own contrast-floor refusal path exists). Wired in `draftOnce` before `varyLearnedStyle`: `const { applied, notes } = filterLearnedStyleToRing(learnedStyle, brandKit?.palette ?? [])`; each note becomes a `StyleRefusal { role: "accent", requested, reason: "learned accent is outside the brand kit's accent ring [..] — recorded for the reviewer, not applied; add it to the kit palette to make it legal" }` pushed onto `allStyleRefusals` (already written to the ledger by `04g-style-directive-record-refusal` and shown as `styleDirectiveOutcome.refusals`).
4. A reviewer's explicit directive pick (Layer 2) stays binding (IGSTYLE-3): because it becomes `overrides.accent`, it is the ring anchor after re-derivation and is painted, so the palette check passes by construction. Belt: `08a2` compares against `[...effectiveKit.palette, ...directiveOverrideHexes]`.
5. `--bg` flips between runs are IGSTYLE-10's seeded 25% inversion (`VARIATION_MIX = 0.25`), not drift — called out in the PR body.

**Model/cost:** none. **Gate:** none — this removes a hold path (~$0.30 per 3-attempt hold).

**Tests** (`brand-kit.test.ts`, `slides-data.test.ts`, `preference-as-prior.test.ts`, `ground-fg-inversion.test.ts` updated; `accent-ring-alignment.test.ts` new): config `accentColor: "#ff6b2c"` + brand.json `accent: "#d95f2b"` → `palette[0] === "#ff6b2c"`, `#d95f2b` in the ring, every slide's `fields.accentColor` in the ring, `checkPaletteWithinKit` passes; one-member ring → every slide paints `ring[0]`; empty ring → today's fallback (regression); learned `accent: "#00ff00"` from seeded `memory.appendFeedback` rows → run delivers on attempt 1, `styleDirectiveOutcome.refusals` names it, no `08a2` failure; a learned accent that IS a ring member is applied as before (flywheel regression); directive pick off-ring → applied and the palette check passes.

### Phase 0 cost controls (new, from the hard-max requirement; A's image cap + B's spend meter, both deterministic holds)

**File:** new `agents/instagram-agent/src/workflow/run-budget.ts`.
```ts
export const GENERATED_IMAGES_PER_RUN_CAP = 8;
export const MAX_RUN_SPEND_USD = 1.5;
export const STEP_COST_ESTIMATES_USD = { copyAttempt: 0.12, vetCall: 0.006, visionInspectPerImage: 0.001, relevance: 0.002, fluency: 0.0055, visualQa: 0.004, scout: 0.009, extraction: 0.005, generatedImage: 0.039, scraperExecution: 0.007, angle: 0.036, brief: 0.113 } as const;
export class RunSpendMeter {
  add(label: string, measuredUsd: number | undefined, estimateUsd: number): void;   // records max(measured ?? 0, estimate)
  get totalUsd(): number; get lines(): ReadonlyArray<{ label: string; usd: number }>;
  canAfford(nextEstimateUsd: number): { ok: true } | { ok: false; reason: string };
}
export function remainingGenerationBudget(generatedSoFar: number): number;
```
Wiring (integrator): every `wf.step.agent` result adds `exec.totalCostUsd` against its estimate; every generated image and scraper execution adds its unit cost; the `generate` rescue tier only requests `min(gaps, remainingGenerationBudget(count))` images, and over-cap gaps take the existing text-only downgrade with reason "generation budget for this run spent". Before attempt ≥ 2 and before each revision's first attempt: `if (!meter.canAfford(STEP_COST_ESTIMATES_USD.copyAttempt + …)) throw new WorkflowHeld("run spend ceiling: $X spent, next attempt ≈ $Y — holding rather than exceeding $1.50; last reason: <lastSelfCheckReason>")`. The running total goes into the gate payload as `spendUsd` so a reviewer sees what a `revise` will cost. The meter is a plain object recreated on resume from the checkpointed step outputs it reads (no new checkpoint); precision is not the point — the bound is.

**Tests** (`run-budget.test.ts`): measured 0 → estimate counts; measured > estimate → measured counts; `canAfford` flips at the ceiling; `remainingGenerationBudget(6)` = 2. Workflow: a fake `image.generate` that always succeeds + 3 attempts with 4 gaps each → at most 8 generate requests total; a run whose meter is seeded above $1.40 holds before attempt 2 with the ceiling wording.

---

## Phase 1 — PR-B (stacked on PR-A)

### H. Client Brief as a persisted artifact — B's lifecycle (check → gather → agent → persist; refuses to overwrite a human brief) + A's tool shapes (`research.fetchPages`, ≤ 4 URLs, cached)

**Files:** `karos-client/src/brief.ts` (+`client.writeBrief`, register), `karos-client/src/index.ts`, new `karos-research/src/fetch-pages.ts` + `index.ts` registration, new `agents/instagram-agent/src/agent/instagram-brief-agent.ts`, `prompts/instagram-brief/1.md` + `latest.md`, `agent/index.ts` export, `client-brief.ts` (+`resolveBriefFreshness`), workflow steps `00b/00b1/00b2/00b3` (integrator), `__tests__/test-helpers.ts` (`setupTestEnvironment({ seedBrief?: ClientBrief | false, scraper?: ScraperProvider | null })`; default seeds a fresh agent brief so existing tests need no brief turn).

**Tools**
- `client.writeBrief { channel, brief: ClientBriefSchema.omit({generatedAt}) }` → validates, refuses (`content_fail`) when the stored brief has `generatedBy: "human"`, stamps `generatedAt`, `store.writeJson(slug, briefSegments(channel), brief)`, returns `{ created, previousGeneratedAt? }`. The karos-client header comment is amended: "read-only except `client.writeBrief`, whose payload is schema-validated, channel-scoped, and never overwrites a human-authored brief".
- `research.fetchPages { urls: z.array(z.string().url()).min(1).max(4), maxChars: z.number().int().min(1000).max(12000).default(8000), window: z.string().default("7d") }` → `scraper.extractUrl(url)` per URL, cached in the research runs store (`job: "page-fetch"`, key = the URL), `not_available` without a scraper, per-URL failures named in `problems` (mirrors `social-history.ts`). Output `{ pages: [{ url, title?, text, fetchedAt, fromCache }], problems: string[] }`. No new vendor.

**Agent:** `InstagramBriefAgent`, id `instagram-brief`, `skillRef: "instagram-brief@1"`, `allowedTools: []`, `maxSteps: 1`, `outputSchema: ClientBriefSchema.omit({ version, channel, generatedAt, generatedBy, agentSkillRef })` (the agent fills `sources`, `confidence`, `gaps` itself), `modelPolicy: resolveModelPolicy("instagram-brief", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true })`. Cost comment: "Sonnet because this is the one document every downstream step reads for a month, in the client's own language; ≈ $0.11 per refresh, amortised over ≥ 4 runs". Prompt: fill each field ONLY from the supplied sources and cite which in `sources`; positioning is the CLIENT's (competitors go nowhere in this document); 3-7 `referenceAccounts` on x/instagram/tiktok/reddit only, each with `why` (peers, publications, communities the ICP reads — never a competitor the client forbids), and a handle must appear in the sources or be a well-known publication in the field — never invented; never invent an offer, a claim, a number; mark everything ungrounded as a `gap`; `language.target` must equal the resolved target language when one was supplied.

**Steps**
- `00b-check-client-brief` (code, after `01-open-run`): `client.getBrief` → `{ action: "reuse" | "refresh" | "create", ageDays?, reason }` via `resolveBriefFreshness(brief, now, wf.input.refreshBrief)`: refresh when missing, `generatedBy: "deterministic"`, age > 30 d, or `refreshBrief === true`; never when `generatedBy: "human"` (reuse with reason).
- `00b1-gather-brief-sources` (code, only on refresh/create): profile, brand, voice rules, `client.getContextDoc` × {product-information, target-audience, market-strategy, brand-voice, competitor-analysis}, `client.getKnowledge`, `intel.getReport` context (`readClientIntelContext`), `research.fetchPages([website, website/about, website/pricing])` (URLs from `profile.website`, deduped; missing website = gap), `research.socialHistory(socialAccountsFromClient(config, brand), window: "24h")` (shared cache with 04e). Every failure is a named `gap`; never a hold. Records which sources were present.
- `00b2-write-client-brief` (agent, only on refresh/create) → `00b3-persist-client-brief` (code): stamps `version/channel/generatedBy: "agent"/agentSkillRef`, `client.writeBrief`. Agent `content_fail`/`budget_exceeded` → record `{ status: "brief-agent-failed" }`, ledger warn, and `02i` falls through to the deterministic brief (`source: "derived"`); the next run retries. Setup never blocks (roster-setup precedent).
- `02i-resolve-client-brief` (PR-A) now finds the persisted brief → `source: "persisted"`, and the gate payload's `grounding.briefGeneratedAt`/`briefConfidence` show it. Consumers: scout (`clientBrief` string, added in I), `03e` engines (reference accounts, evergreen, offers, ownAssets), `04a2` research (rewrite + primary domains), `04i` angle agent, `05` copy (§15), `07g` relevance judge — all already read the brief object from 02i.

**Cost:** Sonnet ~25k in / 2.5k out = **$0.113 per refresh** + ≤ 3 page fetches ($0.021) + ≤ 4 socialHistory accounts ($0.028, shared with 04e's 24h cache) ≈ **$0.16 per refresh**, at most once per 30 days ≈ **$0.04/run amortised** at weekly cadence; a client's first run pays the full $0.16.

**Tests** (`client-brief-setup.test.ts` new; `karos-client/__tests__/brief.test.ts`, `karos-research/__tests__/fetch-pages.test.ts` new): first run with `seedBrief: false` → an `instagram-brief` router turn is consumed, `clients/acme/brief/instagram-brief.json` exists and parses, `02i` reports `persisted`; second run → no brief turn; 31-day-old brief → refreshed; `refreshBrief: true` → refreshed; `generatedBy: "human"` → never refreshed; malformed agent turn → run delivers with `source: "derived"` and a warn event; `client.writeBrief` rejects an invalid brief and a write over a human brief; `research.fetchPages` → `not_available` with `scraper: null`, cache hit on the second call, failing URL named in `problems`. Registry count 61 in `cross-cutting.test.ts`. `prompt-resolution.test.ts` covers `instagram-brief@1` (owned by K's WP; H's WP pins it in its own test).

### I. Topic engines — synthesis: A's single-step signals + pure ranking, B's per-account engagement normalisation, question filter and `includeDomains` communities

**Files:** `packages/workflow/src/primitives/social-trend-scout.ts` (additive: `TrendScoutInput.signals?`, `TrendScoutInput.clientBrief?: string`, `TrendCandidateSchema.engine` with `.default("niche-news")`, `evidenceRefs: z.array(z.string()).default([])`, one prompt paragraph), `packages/workflow/__tests__/social-upgrade.test.ts` (defaults keep x/linkedin green), new `agents/instagram-agent/src/workflow/topic-engines.ts`, `topic-selection.ts` (+`rankTopicCandidates`), workflow `03e`/`03f` (integrator).

**Design — five engines, one model call, deterministic ranking**
- `03e-topic-signals` (code, one step, every source best-effort with a named note; pure helpers in `topic-engines.ts`):
  - (2) reference accounts: `research.socialHistory({ accounts: brief.referenceAccounts.slice(0,6), window: "24h" })`; `scoreReferencePosts(posts)`: per account, `raw = log1p(likes + 3·comments + views/50)`, z-scored within the account when it has ≥ 3 posts (else raw), missing fields = 0; drop posts older than 30 d; top 8 → `{ platform, handle, url, excerpt, publishedAt?, engagementScore }`.
  - (3) audience questions: `buildCommunityQueries(brief)` → 2 queries (`"<coreTerm1> <coreTerm2>" how OR why OR anyone`, `<icp.roles[0] ?? icp.summary> <icp.pains[0] ?? coreTerm3>`), each `research.pull({ job: "instagram-audience-questions", window: "7d", maxResults: 6, includeDomains: ["reddit.com","quora.com","news.ycombinator.com","stackexchange.com"] })` (`includeDomains` added to `research.pull` in J's WP; until merged, omit the field); `extractCommunityQuestions(docs)` keeps titles/first lines containing `?` or opening with `/^(how|why|what|should|is|can|does|anyone|איך|למה|מה|האם|כדאי|מישהו)\b/iu`.
  - (4) own assets: `brief.ownAssets` + headings with a number/date/customer name from the product-information/market-strategy docs already read at 02i.
  - (5) evergreen: `brief.evergreenAngles` minus any overlapping `crossChannelAvoidTopics` (trigram containment).
  - (1) niche news: 03b's merged digest, as today.
  Output `TopicSignals { referencePosts, audienceQuestions, ownAssets, evergreen, notes }`.
- `03c-trend-scout` (same id, same one call) receives `signals` and `clientBrief: briefForPrompt(brief)`. Prompt paragraph (additive): "Candidates may also come from `signals`: what reference accounts posted that landed, questions the audience is asking, the client's own assets, evergreen angles. Tag each candidate's `engine` (niche-news | reference-accounts | audience-questions | own-assets | evergreen) and list its `evidenceRefs` (URLs or doc headings). Offer at least one candidate per engine that has material. `clientBrief` is the authority on who the client is and who they sell to." Output cap stays 10; input grows to ~18k tokens.
- `03f-rank-topic-candidates` (code, pure `rankTopicCandidates(candidates, { mode, brief, recentExcerpts, avoidTopics })`): drop `brandFit < 3` or overlaps `avoidTopics`; `score = interest × brandFit × distance × modeBonus × engineBonus` with `distance = 1 − max trigramJaccard(topic+headline, last 5 cross-channel excerpts ∪ last 5 decision summaries)`, `modeBonus = 1.15` for the selected mode, `engineBonus`: reference-accounts `1 + 0.25·min(engagementScore,1)`, own-assets `1.5` when `brief.offers` non-empty else `1.0`, evergreen `0.8` unless mode is deep-value. Output `{ ranked, chosen, alternatives: next 5 with { score, engine, reason } }`. `03g-select-topic` (E) takes `chosen` from `03f` instead of `selectTrendCandidate`; precedence rules unchanged. Gate payload `topicDecision.alternatives` now carries `engine` and `score`.

**Cost:** scout Flash ~18k in / 2.5k out = **$0.012/run** (replaces E's $0.009); reference accounts ≤ 6 executions = $0.042 (24h cache, shared by every channel that day); community queries 2 executions = $0.014 (7d cache). **≈ $0.068/run cold, ≈ $0.012 warm.**

**Tests** (`topic-engines.test.ts` new; `topic-selection.test.ts`; `social-upgrade.test.ts`): `scoreReferencePosts` ranks a 500-like post above a 20-like one within an account and does not let a large account's median beat a small account's outlier; 31-day-old post dropped; `extractCommunityQuestions` keeps "How do agencies price retainers?" and "למה סוכנויות…?" and drops "Agency pricing report 2026"; `rankTopicCandidates` prefers a 0.9-distant candidate over a near-duplicate with higher brandFit, own-asset bonus only with an offer, alternatives carry reasons; scout schema default `engine: "niche-news"` keeps a v1-shaped candidate valid (x/linkedin fixtures untouched); workflow: offline scraper + a scout turn with mixed `engine` tags → `03e-topic-signals` and `03f-rank-topic-candidates` present, chosen `engine` in the gate payload; `research.socialHistory` `not_available` → engines 3-5 still run and `notes` names the gap.

**Risks:** engagement fields are provider-dependent (recency fallback); web search with `includeDomains` is a proxy for communities (`searchSocial` is not exposed as a tool — follow-up); LinkedIn/YouTube references are schema-forbidden.

### J. Deep research → fact cards — synthesis: B's per-call options incl. `includeDomains` and size-aware cache, B's new step id for the reshaped pull, A's dedupe rules, Flash with a quality floor

**Files:** `karos-research/src/pull.ts` (+`contentChars`, `includeDomains`, `maxResults.max(16)`, size-aware cache), `karos-research/__tests__/research.test.ts`, `types.ts` (`ResearchFactSchema`), `instagram-research-agent.ts` (`@2`), `prompts/instagram-research/2.md` + `latest.md`, new `agents/instagram-agent/src/workflow/research-lanes.ts` (agent-local multi-lane pull — does NOT touch `pullTrendResearch`, so I's WP owns `social-trend-scout.ts` alone), new `fact-cards.ts`, workflow `04a2/04a3/04b/04b2` (integrator).

**Design**
- `research.pull` additive: `maxResults` `.max(16)` (default 4 unchanged); `contentChars: z.number().int().min(500).max(8000).default(DEFAULT_CONTENT_CHARS)` threaded into `toDocument`; `includeDomains: z.array(z.string()).max(8).optional()` passed to `scraper.searchKeyword(query, { limit, includeDomains })`. The `RunRecord` stores `{ maxResults, contentChars }`; a cached record is served only when both are ≥ the request (else refetch). Existing callers' payloads are byte-identical (snapshot test).
- `04a2-research-pull-deep` (code, **new id** because the output shape is a merged multi-lane pull; `04a` retired): `pullResearchLanes(wf, tools, ctx, { stepId, lanes })` in `research-lanes.ts`:
  | lane | queries | window | maxResults | contentChars |
  |---|---|---|---|---|
  | news | grounded query (C); `<subject> <coreTerms[0]>`; `"<companyName>" <subject>` | 7d | 6 | 4000 |
  | insight | `<coreTerms[0..1]> report OR study OR survey <year>`; `<icp.summary> <coreTerms[0]> data` | 90d | 5 | 6000 |
  | primary-domains | `<subject>` with `includeDomains: [client domain, reference publications' domains]` (skipped when none) | 90d | 4 | 6000 |
  Per-query failures recorded; whole-step tooling failure only when every query fails (pullTrendResearch's rule). Merged via `mergeResearchPulls`; output `{ lanes: [{ lane, queries: [{query, status, documents, fromCache}] }], merged, documentCount, note? }` — typically 14-20 unique documents; `< 12` is a note, never a hold (the offline scraper returns fewer).
- `04a3-fetch-primary-sources` (code): ≤ 2 `research.fetchPages` URLs chosen from `merged.documents` matching `/\.pdf$|\/report|\/research|\/study|whitepaper|\.gov\b|\.edu\b|\.ac\./i` or the client domain, `maxChars: 8000`; failures are notes. Client material appended as `clientDocuments` (product-information doc, knowledge assets, brief `ownAssets`) with `primary: true` — zero scraper cost.
- `04b-research-extract-facts` (same id; input gains `documents` ordered primary-first, `clientDocuments`, `clientBrief`): `ResearchFactSchema` += `url: z.string().optional()`, `kind: z.enum(["stat","quote","event","definition"]).default("stat")`, `quote: z.string().max(240).optional()`, `primary: z.boolean().default(false)`; `claim` remains the verbatim `sourceRef` key (`checkSlidesData` unchanged); `facts.max(30)`. Prompt `instagram-research@2`: "return 12-24 fact cards `{claim, kind, source, url, date, quote, primary}`; one claim per card; prefer primary sources and mark them; a secondary article restating a report cites the report when its URL is present; quotes verbatim with the speaker in `source`; an `event` needs a date; `date` falls back to the document's fetch date with a `~` prefix; never merge two sources into one number; PDF text may be absent — say so rather than guess". Model stays Flash; cost comment: "read-and-list over ≤ 16 documents ≈ 20k tokens: Flash $0.014 vs Sonnet $0.11; moves to Sonnet only if `research-extraction-quality.test.ts`'s floor is not met on prep samples".
- `04b2-dedupe-fact-cards` (code, pure `dedupeFactCards(facts)`): normalise (`\p{L}\p{N}` lowercase, numbers normalised the way `numbersSourced` does), drop exact and trigram-Jaccard ≥ 0.8 duplicates (keep primary, then the one with a URL, then the earlier), cap 24, record `dropped: [{claim, duplicateOf}]`. The deduped set is what copy, the angle step and 07 consume.
- Copy prompt @13 (K's WP) §17 says `kind: stat` → `stat_callout`/`comparison_card` candidate (matches D), `kind: quote` → `quote_card` with attribution from `source`, `kind: event` → date it.

**Cost:** ≤ 8 search executions ($0.056 cold; news 7d / insight 90d caches → ≈ $0.02 warm) + ≤ 2 page fetches ($0.014); extraction Flash ~20k in / 3k out = **$0.0135/run**; copy input +~2k tokens = **+$0.006/attempt**. **≈ $0.084/run cold, ≈ $0.04 warm.**

**Tests** (`research.test.ts`; `fact-cards.test.ts`, `deep-research.test.ts`, `research-extraction-quality.test.ts` new): `contentChars: 6000` truncates at 6000; `maxResults: 16` accepted, 17 rejected; a cached 4000-char record is refetched for a 6000 request and served for a 4000 one; default payload snapshot unchanged; `includeDomains` reaches the scraper stub; `dedupeFactCards` drops a paraphrased "42%" duplicate keeping the `.pdf`/primary one and keeps different figures; workflow: offline scraper with `documentsPerQuery: 6` → `04a2` and `04b2` present, `documentCount ≥ 12`, `04b2.kept ≥ 10`, `sourceRef` check still passes with kind-bearing facts; quality fixture: a canned 12-document offline payload + a fake extraction turn shaped from it must yield ≥ 10 cards, ≥ 3 kinds, 0 duplicates — the floor that decides Flash vs Sonnet.

### K. Angle step — B's per-revision agent + scoring formula, A's schema names and ledger codec; copy @13

**Files:** new `agents/instagram-agent/src/agent/instagram-angle-agent.ts`, `prompts/instagram-angle/1.md` + `latest.md`, new `agents/instagram-agent/src/workflow/angle-selection.ts`, `prompts/instagram-copy/13.md` + `latest.md`, `instagram-copy-agent.ts` (`@13`), `__tests__/prompt-resolution.test.ts`, `__tests__/turns.ts` (angle turn), `run-budget.ts` (angle/brief estimates), workflow `04i/04j` inside `draftOnce` (integrator).

**Schema**
```ts
export const AngleSchema = z.object({
  id: z.enum(["wrong-assumption", "surprising-number", "what-it-means"]),
  title: z.string().min(1).max(160),
  rememberLine: z.string().min(1).max(160),       // the ONE sentence the reader should remember, in the target language
  restsOn: z.array(z.string().min(1)).min(1).max(4), // fact-card `claim`s, verbatim
  whyThisClient: z.string().min(1).max(300),
  briefFit: z.number().int().min(1).max(5),        // self-assessed; re-scored deterministically
});
export const AngleProposalSchema = z.object({ angles: z.array(AngleSchema).length(3), notes: z.string().optional() });
```
- `InstagramAngleAgent` id `instagram-angle`, `skillRef: "instagram-angle@1"`, `allowedTools: []`, `maxSteps: 1`, `modelPolicy: resolveModelPolicy("instagram-angle", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true })`. Cost comment: "the angle IS the editorial judgment; Flash proposals in prep read as restated headlines; ≈ $0.036 once per revision (≤ 3 per run), never per attempt".
- `04i-propose-angles` (agent, `rev()`-scoped, at the start of `draftOnce`, outside the attempt loop): input `{ topicDecision, mode, clientBrief, facts (deduped cards, ≤ 14), recentPosts, pastAngles, revisionRequest?, targetLanguage }`, `pastAngles` = `rememberLine`s parsed from the last 20 decision summaries (`angleFromDecisionSummary`). Prompt: exactly one angle per id; a `surprising-number` angle must rest on a `kind: "stat"` card; `restsOn` names existing cards verbatim; nothing may restate a `pastAngles` line; write `rememberLine` in the target language.
- `04j-select-angle` (code, pure `selectAngle(angles, { brief, facts, pastAngles, recentExcerpts, mode })`): drop angles whose `restsOn` names a non-existent card (surprising-number with no stat card → score 0); `fit = 0.5·briefFit/5 + 0.5·min(hits,4)/4` where hits = `coreTerms ∪ offers.name ∪ icp words` present in `title+rememberLine`; `novelty = 1 − max trigramJaccard(rememberLine, pastAngles ∪ last 5 excerpts)`; `modeFit` = 1.0 for hot-news→{surprising-number, what-it-means}, deep-value→wrong-assumption, open-discussion→what-it-means, else 0.85; `score = fit × novelty × modeFit`; ties → the id least used in `pastAngles`. Output `{ chosen, rejected: [2 × { angle, score, why }], scores }`; gate payload `angleDecision`. Agent `content_fail` → `angleDecision: { status: "unavailable" }`, copy runs without an angle, ledger warn — never a hold.
- Copy input `angle: { chosen, rejected }`; prompt `instagram-copy@13` (H1 "v13"; keeps every @12 section): §16 "The angle" — the carousel argues `chosen`; `rememberLine` appears on the cover or the closer, verbatim or near-verbatim, in the target language; the two `rejected` angles are context only — do not blend them in. §17 fact-card kinds (J). (Code comment in `selectAngle`: Hebrew morphology weakens the term-overlap `fit`, so novelty carries more weight there by construction.)
- Ledger: 09b's decision summary (E) becomes `instagram post: "<topic>" (mode: <mode>; source: <source>; angle: <id> | <rememberLine>; archetypes: …)`; `angleDecisionSummary()`/`angleFromDecisionSummary()` codec lives in `angle-selection.ts`; `parseContentModeFromSummary`'s `/mode: ([a-z-]+)/` still matches.

**Cost:** Sonnet ~8k in / 0.8k out = **$0.036 per revision** (≤ 3 per run: $0.108 worst); copy input +~0.8k tokens = **+$0.0025/attempt**.

**Tests** (`angle-selection.test.ts`, `angle-step.test.ts` new; `prompt-resolution.test.ts`): `selectAngle` drops an angle resting on a non-existent card, scores surprising-number without a stat card 0, prefers novelty over a repeat of last run's rememberLine, ties break to the least-used id; codec round-trips through a summary containing parentheses; workflow: angle turn + copy turn → copy input carries `angle.chosen` and two `rejected`, gate payload has `angleDecision`, 09b decision row contains `(angle: surprising-number | …)`; second run with that row seeded → angle input `pastAngles` contains it; a `revise` round consumes a second angle turn (`04i-propose-angles-r1`); malformed angle turn → run delivers with `status: "unavailable"` and a warn; `latest.md === 13.md`, H1 "v13", `instagram-angle@1` and `instagram-brief@1` resolve.

---

## Cross-cutting

**Prompt bumps:** PR-A `instagram-copy@12` (§15 clientBrief/relevanceSteer, §7 cover/numbers/closer, H1 fixed), `instagram-image-vet@3`. PR-B `instagram-copy@13` (§16 angle, §17 fact-card kinds), `instagram-research@2`, new `instagram-brief@1`, `instagram-angle@1`. Two copy bumps because PR-A must be self-consistent alone; each follows `N.md` + identical `latest.md` + `skillRef` + H1.

**New agent class ids (Studio stageModels):** `instagram-relevance-judge` (PR-A, DynamicAgent, Flash), `instagram-brief`, `instagram-angle` (PR-B, Sonnet). Owner re-runs `agent-middleware/scripts/generate_engine_stages.py --check`.

**Step ids** — PR-A new: `02i-resolve-client-brief`, `02i1-load-product-information`, `02i2-load-target-audience`, `02i3-load-market-strategy`, `03d-select-content-mode`, `03g-select-topic`, `07g-relevance-attempt-N`, `07h-default-render-rules-attempt-N` (07g/07h `rev()`-scoped), `02j-plan-run-budget` (the owner amendment's pre-run estimate/adaptation step, before `03`), and `07f-language-fluency-attempt-N-retry` (the fluency judge's one in-step retry). Changed behaviour, same id and shape: `02d-load-target-language`, `03-claim-topic`, `03a/03b/03c` (unconditional), `04a-research-pull` (query + additive fields), `05z` (candidate tags), `05b` (tier-0 slots harvested), `06*` (input), `07b` (caption), `07f` (fail-closed), `08a2` (cannot fail on config/brand accent mismatch), `08b` (residue rules), `09b` (`memory.appendDecision`). PR-B new: `00b-check-client-brief`, `00b1-gather-brief-sources`, `00b2-write-client-brief`, `00b3-persist-client-brief`, `03e-topic-signals`, `03f-rank-topic-candidates`, `04a2-research-pull-deep`, `04a3-fetch-primary-sources`, `04b2-dedupe-fact-cards`, `04i-propose-angles` (rev-scoped), `04j-select-angle` (rev-scoped). PR-B retired: `04a-research-pull`. Nothing else removed or renamed.

**Gate/hold semantics:** everything inside `draftOnce` fails via `continue` (return to 05) under `MAX_SELF_CHECK_ATTEMPTS = 3` → existing `WorkflowHeld`. Direct holds: 02d unresolved non-English profile; 03g "no on-brand subject"; run spend ceiling. Relevance judge and angle/brief agents fail open; fluency fails closed. No parallel retry mechanism.

**Tests to run:** `npm run build && npm run typecheck` at the root; `npm test -w @agent-engine/agent-instagram -- --testTimeout=180000`; `@agent-engine/tool-karos-client`, `@agent-engine/tool-karos-research`, `@agent-engine/tools` (cross-cutting count), `@agent-engine/workflow` (PR-B: `social-upgrade.test.ts` must stay green with the additive defaults). No CI on PRs: local green is the gate.

**Open questions for the owner:** (1) hashtags — the audit lists their absence as a defect but A-K do not ask for them; copy §2 still bans them unless the style config asks. Proposed opt-in: 3-5 hashtags from `coreTerms` on a final caption line when `styleConfig.hashtags === true`. Not implemented. (2) `trendJacking: "always"` is client config today; if the owner wants displacement by default on Instagram, flip the default in `03g` (one constant).

---

## Per-run cost table

Assumptions: carousel; copy today ≈ 18k in / 3.5k out ($0.107); "typical" = 1 attempt, 2 generated images, warm caches; "heavy" = 3 self-check attempts, 8 generated images (the cap), cold caches; "heavy + revision" adds one reviewer `revise` round of 3 attempts (no images left under the cap) and, in Phase 1, a second angle call. Vendor rows use $0.007/execution.

| Step | Model / unit | Today | After PR-A | After PR-B | Per |
|---|---|---|---|---|---|
| 00b2 client brief | Sonnet 25k/2.5k + 3 fetches + ≤4 socialHistory | – | – | $0.16 per refresh → $0.04 amortised | ≤ 1 per 30 d |
| 03b/03e evidence pulls | ScrappyCoco ≤ 4 (+6 +2) | $0 (planned runs) | $0.028 cold / ~$0 warm | $0.084 cold / ~$0.01 warm | run |
| 03c trend scout | Flash 12k→18k in / 2→2.5k out | $0 (planned runs) | $0.009 | $0.012 | run |
| 04a/04a2/04a3 research pulls + fetches | ScrappyCoco 1 → 1-2 → ≤ 8 + 2 | $0.007 | $0.007-0.014 | $0.070 cold / $0.03 warm | run |
| 04b extraction | Flash 5k→20k in / 1.5k→3k out | $0.005 | $0.005 | $0.0135 | run |
| 04i angle | Sonnet 8k/0.8k | – | – | $0.036 | revision |
| topic guardrail | Haiku | $0.0045 | $0.0045 | $0.0045 | revision |
| 05 copy | Sonnet 18k→19.5k→22k in / 3.5k out | $0.107 | $0.111 | $0.119 | attempt |
| 05c vision inspection | Flash images, `CANDIDATES_PER_PHOTO_SLIDE` (6) per photo slide | $0.036 | $0.036 | $0.036 | attempt |
| 06 vet (+ ≤ 2 re-vets) | Flash 6k/1.5k | $0.006 | $0.006 | $0.006 | attempt |
| 07g relevance | Flash 4k/0.3k | – | $0.002 | $0.002 | attempt |
| 07f fluency (non-English) | Haiku 4k/0.3k | $0 (never ran) | $0.0055 | $0.0055 | attempt |
| 07h default render rules | code | – | $0 | $0 | attempt |
| 08a4 rendered inspection | Flash | $0.008 | $0.008 | $0.008 | attempt |
| 08b visual QA | Flash 5k/1k | $0.004 | $0.004 | $0.004 | attempt |
| image generation | flash-image $0.039 | 0-8+ (uncapped) | ≤ 8 per run | ≤ 8 per run | run cap |
| **Fixed per run** | | $0.017 | $0.054 cold / $0.02 warm | $0.26 cold / $0.11 warm (+$0.12 on a refresh run) | |
| **Per attempt (no images)** | | $0.161 | $0.173 | $0.181 | |
| **Typical run** (1 attempt, 2 images, warm) | | **$0.26** | **$0.27** | **$0.37** (first run of a new client $0.49) | |
| **Heavy run** (3 attempts, 8 images, cold) | | $0.86 (uncapped images could exceed it; observed $0.86) | **$0.89** | **$1.07 → planner caps images** | |
| Heavy + 1 revision round | | ~$1.33 (+ more images, uncapped) | $1.34 | uncapped estimate $1.65 → the plan is adapted before the loop, the meter finishes on the cheapest complete path | |
| Heavy + 2 revision rounds (9 copy attempts) | | ~$1.68 (pre-existing exposure) | adapted / cheapest path (meter) | adapted / cheapest path (meter) | |

The 05c row is per CANDIDATE, not per slide: `media.findImages` is asked for `maxPerNeed: CANDIDATES_PER_PHOTO_SLIDE` (6) for every slide that needs a picture, and 05c inspects the whole pool — six photo slides is 36 images, $0.036 an attempt, the second-largest per-attempt cost after the Sonnet draft. Both this table and `estimateRunCost` priced it at one image per slide until 2026-09-10; the correction is why the figures above are higher than the ones the design shipped with, and it is what makes the pre-run planner pull its first lever on the shapes it was written for (the default carousel is $0.988 English, $1.005 with the fluency judge → images capped at 4).

Target $1.00 holds for every non-revision Phase 0 run shape (PR-A heavy = $0.89 cold). A cold Phase 1 heavy run estimates $1.07, and a first-run brief refresh adds $0.16 on top: neither is a hold — `planRunBudget` adapts the plan before the first paid call, in the owner's order (images capped, evidence pulls warm-cache only, one return to step 05, optional re-vets off), and records each adaptation as a run note. Hard max $1.50 is not assumed either: `RunSpendMeter` counts `max(measured, estimate)` per model step, $0.039 per generated image and $0.007 per scraper execution, stops OPTIONAL work at the target and switches to the cheapest complete path over the max — the run still delivers, marked `degraded`. No Opus anywhere; the only Sonnet calls are copy (per attempt, as today), the angle (per revision) and the brief (per 30 days).

---

## Ordering & integration

### Phase 0 (PR-A) — workflow wiring, in execution order

The integrator owns `create-instagram-agent-workflow.ts` and wires the pure modules each WP delivers. Every new model turn changes fixture order; the integrator migrates the 30 positional-turn tests to `standardTurns()` (WP0-5's `__tests__/turns.ts`) in the same PR and updates `workflow-e2e.test.ts`'s expected step-id list.

1. `00a`, `00`, `01`, `02`, `02b`, `02c` — unchanged.
2. `02d-load-target-language` — body replaced by `resolveTargetLanguage` (WP0-2); reads brand, profile, voice rules, brand-voice doc; `null` on english-default; `WorkflowHeld` on unresolved non-English. Shape unchanged.
3. `02e`-`02h` — unchanged.
4. `02i-resolve-client-brief` (+ `02i1/02i2/02i3` doc loads via `readContextDoc`) — `client.getBrief` then `deriveClientBrief` (WP0-3). Result `brief` is read by 03a-03c (`requestedTopic` only in PR-A), 04a, 05, 07g and the gate payload.
5. Local `renderRules` resolution — `DEFAULT_RENDER_RULES` when the frozen config has none; `renderRuleSource` recorded (WP0-4). The copy input's `styleConfig.rules` includes the defaults when in force.
6. `03-claim-topic` — literal fallback removed; `research` seed = industry; existing hold when nothing.
7. `04e0`, `04e`, `04f` — unchanged (they run before the scout today).
8. `03a`, `03b` (try/catch for reserved/requested), `03c` — unconditional, with `requestedTopic` (WP0-5's `topic-selection.ts` supplies `scoutQueryInput()` helpers).
9. `03d-select-content-mode` — `memory.read` decisions → `selectContentMode`.
10. `03g-select-topic` — `resolveTopicClaim(...)`; may call `topics.release`; may hold. `topicClaim` is the result from here on.
11. `04h` unchanged. `04a-research-pull` — `buildGroundedQuery(topicClaim, brief)` + fallback pull; additive output fields. `04b` unchanged.
12. `05a`, `05z` (tier-0 candidates get `[client upload, slot N]` descriptions), `04c`, `04d`, `04g` — otherwise unchanged.
13. `draftOnce(revision)`: `filterLearnedStyleToRing(learnedStyle, brandKit?.palette ?? [])` before `varyLearnedStyle`; notes → `allStyleRefusals` (WP0-1). `RunSpendMeter` instantiated per run (WP0-4); before attempt ≥ 2 / each revision → `canAfford` or hold.
    - `05-write-copy-attempt-N` — input += `clientBrief`, `relevanceSteer?`, defaults in `styleConfig.rules`; meter adds `exec.totalCostUsd`.
    - `05b` — `slidesNeedingSource` includes tier-0 slots unless `mediaSource === "client"`. `05c` unchanged (meter adds per-image estimate).
    - `06-vet-images-attempt-N` (and tier re-vets) — `slides` carry `headline`, `body`, `visualNeed`, `isClientPhotoSlot`. `isUnfillable` += `claimMatch < 3`. Rescue `generate` tier requests ≤ `remainingGenerationBudget()`; excess gaps → text-only with the budget reason.
    - `07a`, `07` — unchanged. `07b-craft-hygiene` — now lints the caption too (WP0-2, no wiring change).
    - `07e-language-script` (unchanged) → **`07g-relevance-attempt-N`** (`runRelevanceJudge`; score < 3 → steer + `continue`; error → warn, proceed) → `07f-language-fluency` (**`status !== "fluent"` → `continue`**) → `07d-dedupe` → `07c-emit-slides-data` → **`07h-default-render-rules-attempt-N`** (only when `renderRuleSource === "default"`; failures → `continue`; `residue` kept for 08b).
    - `08`, `08a2` (palette set = `effectiveKit.palette ∪ directive accent`), `08a3`, `08a4`, `08b` (`renderRules` = client rules or residue defaults).
14. `buildGate` payload += `grounding: { briefSource, briefConfidence, relevance }`, `topicDecision`, `spendUsd`, `learnedStyleNotes` (via existing `styleDirectiveOutcome.refusals`).
15. `09b-deliver-and-log` — deliverable += `grounding`, `topicDecision`; `memory.appendDecision` (best-effort) with the E summary codec.
16. PR body lists the new/changed step ids above and the three Studio class-id notes; owner re-runs `generate_engine_stages.py --check`.

### Phase 1 (PR-B) — additions on top of PR-A, in execution order

1. After `01-open-run`: `00b-check-client-brief` → (on refresh/create) `00b1-gather-brief-sources` → `00b2-write-client-brief` (agent) → `00b3-persist-client-brief` (WP1-1). Failures never hold. `02i` now resolves `persisted`.
2. Between `03b` and `03c`: `03e-topic-signals` (WP1-2's `gatherTopicSignals`); `03c` input += `signals`, `clientBrief`; after `03c`: `03f-rank-topic-candidates`; `03g` takes `chosen`/`alternatives` from `03f`.
3. Replace `04a-research-pull` with `04a2-research-pull-deep` (`pullResearchLanes`, WP1-3) and `04a3-fetch-primary-sources`; `04b` input += ordered `documents`, `clientDocuments`, `clientBrief`; add `04b2-dedupe-fact-cards`; `research.facts` downstream = the deduped cards.
4. Inside `draftOnce`, before the attempt loop: `04i-propose-angles` (rev-scoped agent, WP1-4) → `04j-select-angle`; copy input += `angle`; meter adds the angle cost; `buildGate` += `angleDecision`; 09b summary codec += `angle:`. `04i` input `pastAngles` comes from the same `memory.read` 03d already performed (thread the decisions list, do not re-read).
5. `setupTestEnvironment` defaults to `seedBrief` (fresh agent brief) so PR-A's workflow tests need no brief turn; `standardTurns()` gains `angle` between `research` and `copy`; `workflow-e2e` expected step list updated; registry count 61.
6. PR body: new step ids `00b*`, `03e`, `03f`, `04a2`, `04a3`, `04b2`, `04i`, `04j`; retired `04a`; new class ids `instagram-brief`, `instagram-angle`; new tools `client.writeBrief`, `research.fetchPages`; `research.pull` options.

### Work-package boundaries

Inside a phase, `ownedFiles` are disjoint; `create-instagram-agent-workflow.ts` is owned by nobody (integrator). Shared files: PR-A — `brand-render-tokens.ts`/`slides-data.ts` → WP0-1; `language-gate.ts`/`craft-hygiene.ts` → WP0-2; `karos-client` + copy prompt/agent + `prompt-resolution.test.ts` + `cross-cutting.test.ts` → WP0-3; `visual-qa-pre-checks.ts` → WP0-4; `types.ts` + `test-helpers.ts` + vet agent/prompt → WP0-5. PR-B — `karos-client` + `karos-research/src/index.ts` + `client-brief.ts` + `test-helpers.ts` + `agent/index.ts` + `cross-cutting.test.ts` → WP1-1; `social-trend-scout.ts` + `topic-selection.ts` → WP1-2; `karos-research/src/pull.ts` + `types.ts` + research agent/prompt → WP1-3; copy agent/prompt + `prompt-resolution.test.ts` + `turns.ts` + `run-budget.ts` → WP1-4. Each WP's unit tests pass standalone; its workflow-level tests are written against the step ids in this spec and pass once the integrator wires the phase.

## OWNER AMENDMENT (2026-09-09, binding, overrides anything above about budget holds): budget is adaptive and never a hold

The owner's words: an estimate before the run; if it would exceed, do NOT fail — adapt, learn, run and succeed. If the estimate was low and we still overran, do NOT fail or throw the result away — finish, deliver, and learn so the next run stays under. Limits must never break a run or count as a defect; a deliverable always reaches the client.

Concretely for `run-budget.ts` (WP0-4) and everything the integrator wires:
1. **Pre-run estimate step** (new code step after the plan is known, before the first paid call): estimate cost from the plan — allowed attempts, images that may be generated, research pulls/lanes, model calls — using the per-step cost table in this spec AND the client's own history (past runs' `estimatedUsd`/`actualUsd` from the ledger; EWMA of actual/estimate). If the estimate exceeds the **target $1.00**: no hold, no fail — **adapt the plan to fit**, in this order: cap generated images (prefer tier-0/stock, then text-only downgrade), drop optional evidence pulls to warm-cache only, reduce allowed self-check returns from 2 to 1, skip optional re-vets. Record every adaptation as a run note the reviewer sees ("budget: estimate $1.21 > $1.00 → images capped at 3, one revision instead of two").
2. **Live spend meter**: track actual cost per step. Crossing the target = stop spending on *optional* work (no more image generation, no extra scout pulls, no re-vets beyond the mandatory gates). Crossing the **hard max $1.50** = finish the current attempt on the cheapest path that still yields a complete deliverable (text-only slide downgrade, keep deterministic checks, skip optional model QA) and deliver. Run status stays `completed` (may carry `degraded` + reason). **Never `held` or `failed` because of budget.** The image-generation cap is an adaptation, not a hold: hitting it falls through to stock / text-only exactly like today's "no viable image" path.
3. **Learning**: persist per client, per run: `estimatedUsd`, `actualUsd`, per-step breakdown, adaptations applied, whether the target/max was crossed. The next run's estimator reads this and calibrates (tighter default plan after an overrun; relax again after two runs under target). The gate summary shows "estimate vs actual".
4. Budget must adapt the plan *before* the attempt loop; it must never cut the loop mid-way into a hold. All non-budget hold reasons (rights, brand compliance, language gate exhaustion) are unchanged.
5. Tests: estimate over target → adapted plan + note, run completes; actual over hard max mid-run → run completes with degraded note and a full deliverable, ledger row written; next run reads the ledger and starts tighter. A test that asserts a budget hold is wrong and must be changed.
