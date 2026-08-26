# agent-engine — Architecture Audit & Optimization Plan

**Date:** 2026-08-26 · **Scope:** full repository at HEAD (packages/core, packages/workflow, 17 tool packages, 14 agent packages, apps/agent-server, evals, deployment) plus cross-references into `karos-agents` (legacy SEO/GEO v2 skill) and the karosCMO contracts.
**Method:** three parallel deep-read passes (core+agents, tool layer, runtime/persistence/integrations), findings spot-verified against source. Builds on — does not restate — the prior 360° self-audit (`audit-scorecard.html`, 75/100 at commit `f17e640`, 2026-08-19) and `docs/PLAN-2026-08-status-and-roadmap.md`.
**Rule of evidence:** every finding carries a `file:line` reference. Claims of "fixed since the prior audit" were re-verified in current source, not assumed.

---

## 1. Executive Summary & System Health Score

### Verdict: 80/100 — architecturally excellent, operationally unfinished

The engine's bones are genuinely strong, and stronger than the last audit's snapshot:

- The **three-layer invariant holds everywhere**: L1 workflows make no content judgments, `BaseAgent` performs zero direct I/O, every external effect goes through a typed tool. Resume-by-replay with per-step checkpoints is elegant and safe; run-claiming is a real Firestore transaction.
- **"The model extracts, arithmetic routes" held across the whole repo** — zero LLM-decided numbers found (SEO scoring, reputation triage, intel scoring are pure, fixture-locked functions).
- **The prior audit's P0 and 9 of its 20 P1s are verified fixed at HEAD**: `allowedTools` is now enforced three-deep (`z.enum` in the turn schema at `packages/core/src/agent/base-agent.ts:302-314`, a membership re-check at `:438-458`, and a scoped registry at `:322-331`); `claimRun` closes the double-execution race; `GateAlreadyResolvedError` protects the approval audit trail; LLM retry/backoff exists (`packages/core/src/router/adapters/retry.ts`); the Firestore `undefined` crash is fixed by `sanitizeForFirestore`; the build script is topological; gate-id round-tripping works; terminal transitions clear stale fields; budget survives resume.
- 1,294 tests / 161 files / 0 TypeScript errors, near-zero `any`, no test theater. All 13 products are now dispatchable (`apps/agent-server/src/wiring/workflows.ts`).

### The five gaps that hold it below production-elite

| # | Finding | Severity | Where |
|---|---|---|---|
| G1 | **The LLM never sees a tool description.** `AgentTool` has no `description` field and there are **zero** Zod `.describe()` annotations across all ~74 tools — the model receives bare field names and types. All of the repo's excellent tool documentation is TSDoc, stripped at compile time. | P0 (quality) | `packages/core/src/agent/tool.ts:28-34`, `base-agent.ts:258-269` |
| G2 | **`seo-geo-agent` is dispatchable but hollow.** `research.captureVisibility` is a stub that returns `captureTier:"UNAVAILABLE"` for every cell (`packages/tools/karos-research/src/capture-visibility.ts:86-97`, documented as "Phase 1 has no real capture adapter wired up"), and technical measurements are hardcoded `unavailable` (`agents/seo-geo-agent/src/workflow/measurements.ts`). A run completes, persists, and hands a client a report scored from zero data. | P0 (product) | see §4c |
| G3 | **No application-layer auth on any HTTP route** (`apps/agent-server/src/app.ts:36-52` — only `express.json()` is installed). Any Cloud Run invoker can start/resume runs and read deliverables for **any tenant**, and can create/replace agent definitions. The Pub/Sub push endpoint is app-layer-unauthenticated in prep *and* prod (neither `PUBSUB_PUSH_TOKEN` nor `PUBSUB_PUSH_AUDIENCE_URL` set in `cloudbuild.yaml` / `cloudbuild.promote.yaml`). | P0 (security) | `app.ts`, `routes/queue.ts:66-92` |
| G4 | **Feedback loops are fragmented and mostly write-only.** Two parallel human-feedback stores exist; the ledger one has no reader at all; only 6 of 13 products inject past feedback into drafting; rejected draft content is never persisted; eval results are never stored or consumed anywhere. | P1 | see §4 |
| G5 | **Token waste in the ReAct loop.** The full transcript (tool args + results) is re-serialized every turn, pretty-printed (`JSON.stringify(..., null, 2)`), inside the **uncached** user message; the constant response contract and tool schemas are re-sent per turn instead of living in the cached system block. Quadratic for `landing-make` (`maxSteps: 24`). | P1 (cost) | `base-agent.ts:184-198`, `messages-api-adapter.ts:174-205` |

### Dimension scores (current → achievable with this plan)

| Dimension | Score | Notes |
|---|---|---|
| Architecture & orchestration | 88 → 93 | Layering, checkpointing, gates, and vendor routing are elite; step timeout doesn't cancel, fanout unbounded |
| Tool layer quality | 62 → 90 | G1 alone caps this; plus 11 dead tools, 5 duplicated clones, 4 gate-verdict shapes, one retry site |
| Agent capability parity | 70 → 88 | Shared primitives adopted unevenly (see §3 matrix); 3 agents lack any content gate |
| Feedback & learning | 45 → 85 | Mechanism exists (`runReviewCycle` → memory) but reaches under half the fleet; evals feed nothing back |
| Security & tenancy | 65 → 90 | Structural tenancy below the API is excellent; the API itself has none |
| Observability & cost | 70 → 88 | OTel wired but only 4 span sites; no request/run spans, no metrics; unknown models silently bill at Sonnet rates (`pricing.ts:91`) |
| Integrations & data | 60 → 85 | Prod missing `APIFY_TOKEN` (prep calls it "effectively required"); 14+ env vars undocumented; SEO/GEO connectors gated-not-applied |

---

## 2. Tools Audit & Refactoring Matrix

The tool layer is a bespoke registry (`AgentToolRegistry`, `packages/core/src/agent/tool.ts:37`) with a uniform 4-outcome contract (`success` / `content_fail` / `tooling_error` / `not_available`) enforced by `defineTool` (`packages/tools/common/src/tool-factory.ts:27-60`), which also provides Zod validation, strip-unknown-keys tenant isolation, and per-call telemetry spans. Config injection is consistently excellent — no tool reads `process.env` at module load; everything is constructor-injected from one composition root (`apps/agent-server/src/wiring/tools.ts`). Comments call these "MCP servers" but no MCP protocol code exists — worth renaming in docs or actually adopting MCP framing later.

### 2.1 Redundant tools — merge/deprecate

| ID | Overlap | Evidence | Action |
|---|---|---|---|
| R1 | **5 agent-local `render.preview` clones** — all register under the *identical* name, identical skeleton, differ only in char-limit constants (which are *also* duplicated in `gate.lintPost`'s `PLATFORM_MAX_LENGTH` table) | `agents/{x,linkedin,reddit,blog,newsletter}-agent/src/tools/render-preview.ts`; limits table at `packages/tools/karos-gates/src/lint-post.ts:108` | One shared `gate.renderPreview({platform, ...})` in karos-gates, single source of truth for platform limits |
| R2 | **4 media tools = four tiers of one tool** — `media.ingestAssets` / `media.findImages` / `media.scrapeImages` / `image.generate` share input shape, `.media-cache/<runId>` dir, `FindImagesCandidate[]` result, and a downloader (`scrape-images.ts` imports from `find-images.ts`). `image.generate` breaks the `media.` prefix convention. | `packages/tools/karos-media/src/{find-images,scrape-images,generate-image,ingest-assets}.ts` | One `media.source` with a `tier` discriminator (or at minimum rename `image.generate` → `media.generate` and extract the shared pipeline) |
| R3 | **2 human-feedback logs** — `memory.appendFeedback` (approve/revise/reject, has a reader, injected into drafts) vs `ledger.feedbackAppend` (approve/reject, **no read tool exists — write-only forever**) | `karos-memory/src/append-feedback.ts:48` vs `karos-ledger/src/feedback-append.ts:26` | Keep memory's; migrate the 6 `ledger.feedbackAppend` call sites; delete the ledger tool (§4) |
| R4 | **2 disk-write sandboxes** — landing and video each reimplement path fencing + symlink-escape checks; video's own comment says it's checked "the same way karos-landing's site sandbox is" | `karos-landing/src/sandbox/site-sandbox.ts` vs `karos-video/src/sandbox.ts` | One `createSandboxedRoot()` helper in `tools/common` |
| R5 | **3–4 fetch stacks** — scraper (no timeout at all), media `fetchJson` (15s), reputation `fetchWithDeadline` (15s, the best one), media `brand-logo.ts` downloader. Retry exists in exactly **one** tool (`image.generate`, exp backoff). | `karos-scraper/src/scrappycoco.ts`, `karos-media/src/providers.ts`, `karos-reputation/src/capture/http.ts` | Promote reputation's `fetchWithDeadline` + a shared retry policy into `tools/common`; adopt everywhere |
| R6 | **3 GCS upload wrappers** | `landing.uploadSiteBundle`, `video.uploadDeliverable`, `renderCarousel`'s `persistRenderedSlide` | Thin shared `uploadArtifact` helper |
| R7 | **4 incompatible gate-verdict shapes** — `GateVerdict`, `LandingGateVerdict`, `DoctrineGateResult`, `SeoGeoScoreResult`; workflow code branches per family | `karos-landing/src/gate/gate-tool.ts:104`, `karos-reputation/src/doctrine/types.ts`, `karos-seo-geo/src/score-tool.ts:12-20` | Shared discriminated `GateVerdict` base + per-family extensions |

### 2.2 Dead tools — deprecate or wire (11 = ~20% of the always-on registry)

Zero production references (verified by grep across `agents/`, `apps/`, `evals/`): `ledger.upsertBrief`, `memory.appendHypothesis`, `memory.resolveHypothesis`, `publish.draft`, `publish.schedule`, `publish.status`, `research.getRuns`, `research.writeRun`, `research.checkFreshness`, `video.assetsCheck`, plus test-only `intel.getReport`.

Notes:
- These are **spec-driven, not accidental** — RFC-01 §9.2 still lists them as designed surface. Reconcile the RFC in the same change.
- `video.assetsCheck` guards against a real past incident (0-byte fonts) and has **no call site** — wire it into onboarding rather than deleting it.
- Three of `karos-publish`'s four tools are dead; the live one (`renderCarousel`) is a *rendering* tool. Rename the package's intent or build real publishing (§2.3).

### 2.3 Missing tools to build

1. **Real AI-visibility capture adapters** for `research.captureVisibility` — the implementation spec already exists in the legacy v2 skill (§4c).
2. **Social publish connectors** — nothing in the repo ever posts to X/LinkedIn/Instagram/Reddit; `publish.*` writes JSON records only. Content ends at a human-approved draft.
3. **Technical-SEO crawler** — `measurements.ts` hardcodes `coverage:"unavailable"`.
4. **GSC/GA/CrUX/GBP connectors** — a fully-designed overlay exists (`karos-seo-geo/src/config/seo-geo-connectors-config-edits.txt`) gated `GATED_NOT_APPLIED`; zero env vars wired.
5. **Historical-post visual ingestion** for media agents (§4d).

### 2.4 Schema & quality fixes

| Fix | Detail |
|---|---|
| **Add `description` to `AgentTool` + `.describe()` on every schema field** (G1) | Thread through `describeAllowedTools` (`base-agent.ts:258-269`). Source the text from the existing TSDoc — it is already written, it just never ships. Highest-leverage single change in this audit. |
| **Fix karos-video gate outcome smuggling** | 6 tools return `success<GateVerdict>({verdict:"tooling_error", ...})` — a broken Python script reads as a *successful* call, inverting the RFC-01 §6 contract. Verified at `karos-video/src/tools/cut-gate.ts:34` and `gate-helpers.ts`; also affects `brand-gate`, `graphics-gate`, `cutaway-gate`, `self-eval-gate`, `assets-check`. Return `toolingError(...)` at the outcome layer. |
| Remove 7 redundant double-parses | Tools re-running `Schema.parse` inside `execute` after `defineTool` already parsed: `find-images.ts:121`, `generate-image.ts:225`, `ingest-assets.ts:170`, `scrape-images.ts:79`, `append-feedback.ts:52,109`, `pull.ts:105` |
| Make `TOOL_VERSION` real | ~50 duplicated `"1.0.0"` literals; only `research.pull` was ever bumped. Centralize or lint-enforce bumps. |
| Output validation at external boundaries | External JSON crosses via bare TS casts (`"N/A"` rating → `NaN` in reputation capture); only `video.transcribe` Zod-parses its response. `safeParse` at every adapter boundary. |
| Bound history reads | `memory.read` still lists **all** decisions/hypotheses (`karos-memory/src/read.ts:57-62`); `latestRun()` parses every historical run record per cache check (`karos-research/src/runs.ts`). Add `limit`/`since`; write a `latest.json` pointer. Still-open prior-audit P1. |
| GCS/file store conformance | The two "interchangeable" workspace backends differ in listing scope, sort order, and I/O pattern (`gcs-workspace-store.ts:63-71` vs `file-git/workspace-store.ts:107-115`). Still-open prior-audit P1 — add a cross-backend conformance test. |

---

## 3. Agent-by-Agent Deep Dive

**Fleet shape:** 14 packages, 27 `BaseAgent` sub-agents. 26 of 27 pinned to `claude-sonnet-4-6`; one (`reputation-extraction`) runs `commodity`. 21 of 27 have `allowedTools: []` — tool minimalism is genuinely enforced, the opposite of tool-clutter. No agent sets `maxTokens` (all inherit the 16,384 default; truncation is a hard, non-repairable failure at `messages-api-adapter.ts:111-116`).

### 3.1 Capability matrix

| Agent | Sub-agents | selfCritique | Human gate | In-run revise | Guardrail | Dedupe scored | Feedback read | Evals |
|---|---|---|---|---|---|---|---|---|
| x | 1 | ✅ | 1 | ✅ | ✅ | ❌ advisory | ✅ | ✅ |
| linkedin | 1 | ✅ | 1 | ✅ | ✅ | ❌ advisory | ✅ | ✅ |
| blog | 1 | ✅ | 1 | ✅ | ✅ | ❌ advisory | ✅ | ✅ |
| newsletter | 1 | ✅ | 1 | ✅ | ✅ | ❌ advisory | ✅ | ✅ |
| reddit | 1 | ✅ | 1 | ✅ | ✅ | ❌ advisory | ✅ | ✅ |
| instagram | 4 | ❌ | 1 | ✅ | ✅ | ✅ **only one** | ✅ (inlined copy) | ✅ |
| campaign-orch | 1 | ❌ | 1 | ❌ | ❌ | ❌ | ❌ | ✅ |
| intel-report | 1 | ❌ | 1 | ❌ | ❌ | ❌ | ❌ | ✅ |
| landing-builder | 4 | ❌ | 1 | rebuild-mode | ✅ | ❌ | own schema | ❌ |
| branded-shorts | 3 | ✅ (1/3) | 2 | ❌ | ✅ | ❌ | ❌ | ❌ |
| reputation | 5 | ❌ | 1 | retry loops | ✅ | ❌ | ❌ | ❌ |
| seo-geo | 2 | ❌ | 2 | ❌ | ❌ | ❌ | ❌ | ⚠ nonstandard |
| tiktok | 2 | ❌ | 1 | ❌ | ✅ | ❌ | ❌ | ❌ |
| setup-agents | 0 (by design) | — | 0 | — | n/a | — | — | ❌ |

### 3.2 Per-agent findings and refactoring plan

**x-agent** — *Ordering bug (P1):* `gate.noPlaceholder` and `gate.leakCheck` run at steps 16/17, **after** the `15-batch-review` human gate and outside the revision loop (`create-x-agent-workflow.ts:465-477`; the comment confirms they were "previously-dead gates, wired in right before persistence"). A leak found at 17 throws `WorkflowHeld` on a draft a human already approved, with no revision path. Every sibling runs these inside `draftOnce`. **Fix:** move both into `draftOnce` under `rev(...)`.

**instagram-agent** — The largest workflow (2,071 lines) and the geektime case-study subject (§4b). Calls **zero `gate.*` L3 tools** — all copy QA is bespoke local code (`craft-hygiene.ts`) + model judgment, diverging from the karos-gates contract every sibling uses. Inlines its own `readPastFeedback` (`create-instagram-agent-workflow.ts:1101-1113`, identical to the shared primitive) and a local `MAX_REVISION_ROUNDS`. Conversely it is the **only** agent that verifies dedupe (`checkOutputDedupe`) rather than merely prompting for it. **Fix:** adopt `gate.brandCompliance`/`gate.noPlaceholder` on copy, delete the inlined copies, add the language gate (§4b), and export its dedupe-verification pattern to the other six agents.

**campaign-orchestrator** — Forces `autoApprove: true` on all five channel workflows in its fanout, so campaign-produced posts **bypass every per-channel batch-review**; the single campaign gate at step 13 is the only human surface, and it's assembled *after* all drafting. Campaign output gets less scrutiny than standalone runs. No guardrail, no selfCritique. **Fix:** include full per-channel drafts in the campaign gate payload, or drop autoApprove and resolve channel gates from the campaign review; add the guardrail.

**intel-report-agent** — The thinnest QA of any content agent: no revision loop, no guardrail, no dedupe, no feedback read, no selfCritique (blocked on static-only `gateArgs` — see below), and the **highest truncation risk** in the fleet (8 scores + 7 prose sections + SWOT + competitor table against the 16,384-token default). **Fix:** set `maxTokens`, adopt `runReviewCycle` + guardrail, and use the `gateInput` transform below.

**seo-geo-agent** — Well-designed 20-step workflow with two human gates and a narrative-numbers verification step, but the entire measurement front end is stubbed (G2). No revision loop, no guardrail; both sub-agents document *why* they lack selfCritique (static `gateArgs` can't express draft→gate-input). Nonstandard evals shape. **Fix path is §4c.**

**landing-builder-agent** — `LandingMakeAgent` is the only file-writing agent (`allowedTools: ["landing.writeSiteFile","landing.readSiteFile"]`, `maxSteps: 24` — the worst case for the G5 transcript cost). Sophisticated out-of-run rebuild-mode feedback (`src/workflow/feedback.ts`, 347 lines, keeps/freeze/revert machinery) that shares nothing with `memory.*`. Residual security: `landing.gate` still builds model-authored code (`shell:true` is fixed; the ACE surface is not — needs a credential-free, network-restricted build sandbox before this agent runs alongside credentialed workloads). No evals.

**reputation-agent** — Best failure-isolation design in the fleet (per-leg tombstones, separate content-retry vs tooling-retry budgets). Deviations: claims/ledgers are read/written via a raw `WorkspaceStoreLike` from L1 rather than registered tools (loses `toolVersion` attribution), and the analysis workflow's layers 1–5 are honest `not_yet_ported` placeholders. No evals.

**tiktok-agent** — 9 unused imports (`create-tiktok-agent-workflow.ts:4-15`, pre-`runTopicGuardrail` leftovers); only agent using `readRichRunInput` instead of `readRunDirection`; `TikTokCommentaryAgent` is the only channel agent with `client.*` reads in-loop (fine — but the others get the same data via workflow steps; pick one pattern). No revision loop, no evals.

**branded-shorts / blog / linkedin / newsletter / reddit / setup-agents** — Broadly healthy; inherit the fleet-wide fixes. setup-agents' "no model in the intake path" stance is correct and should stay.

### 3.3 Fleet-wide refactors

1. **`gateInput` transform on selfCritique (~10 lines, unblocks 3 agents).** `selfCritique.gateArgs` supports only static fields; seo-geo ×2 and intel-report cite exactly this as why they have no content gate. Add `gateInput?: (draft) => unknown` to `AgentStepConfig`, apply at `base-agent.ts:622`.
2. **Set `maxTokens` per agent** — at minimum intel-report, blog, newsletter.
3. **Lift the mechanical duplications into `packages/workflow`:** `toAgentContext()` ×15 (byte-identical); `runGate()` ×9 (seo-geo's own comment: "Copied verbatim from linkedin-agent"); evals scaffolding ×8 (`index.ts` byte-identical — the root `evals/` package already *is* the generic harness and is used by nothing); the persist-triple ×8 → a `finalizeDeliverable()` primitive (~400 lines removed, and "did this agent record its output excerpt" becomes a wiring fact).
4. **Make dedupe verified, not advisory** — adopt `checkOutputDedupe` in the 6 agents that read history but never score the finished draft.
5. **Dynamic-agent resume:** `POST /runs/:id/resume` rejects any productId outside the 13 fixed ones (`routes/runs.ts:145-149`) — a dynamic agent that hits a gate is stuck forever. Route resume through the same `resolveWorkflowFn` used by start.
6. **Engine-level:** step timeout doesn't cancel the underlying agent (`step-agent.ts:31-45`); `fanout` is unbounded `Promise.all` (`fanout.ts:36`) — seo-geo's capture fanout is N prompts × 5 engines the moment a real adapter lands. Add abort propagation and a concurrency cap.
7. **Studio model-override validation:** `applyStageModelOverride` accepts any string (`step-model-policy.ts:118-127`) — no catalog or vendor-consistency check, unlike the env path. Ties into the model catalog (§4b).

---

## 4. Data, Memory & Feedback Loop Architecture

### 4.1 Persistence map (current)

| Store | Holds | Notes |
|---|---|---|
| **Firestore** (`karoscmo` project; `prep` / `(default)` DBs) | Run state (`agentEngineRuns/{runId}` + steps/slots), gates (top-level `agentEngineGates`), agent definitions, **prompts** (`prompts/` + `promptVersions/`), slide templates | >900KB step outputs auto-archive to GCS (losing per-model cost detail — accepted tradeoff) |
| **GCS workspace store** | All tenant business state as JSON blobs under `clients/{slug}/…`: brand kits (`client/brand`), voice rules, strategy docs, ledger (deliverables/events/feedback/used-images/output-history), memory (beliefs/decisions/feedback), topics, research runs, reputation ledgers | File+git backend for local dev |
| **GCS media/artifacts buckets** | Carousel PNGs, MP4s, landing bundles, archived step outputs | 7-day signed URLs |
| **BigQuery** (`bi_telemetry.agent_runs_bi`) | Per-step cost/token/duration rows, fire-and-forget | The only analytics surface |

**There is no Postgres, no Redis, no vector DB anywhere** (verified — zero `.sql` files, no client libs). This is *fine at current scale*: the real problem is not the store choice but the **unbounded full-history reads** on hot paths (§2.4) and that everything is unindexed JSON with no query capability. Recommendation: fix the read-bounding first; revisit a queryable store only when a concrete need (cross-client analytics, semantic retrieval) arrives.

### 4.2 Feedback today: three unreconciled systems, one real loop

- **The one real loop:** `runReviewCycle.onDecision` → `memory.appendFeedback` (every decision incl. approvals, idempotent on `${runId}-r${revision}`) → `readPastFeedback` (limit 10) injected into the next run's drafting prompt. Wired in x/linkedin/reddit/blog/newsletter/instagram only.
- **Write-only:** `ledger.feedbackAppend` (6 call sites, no read tool exists).
- **Isolated:** landing-builder's `FeedbackRoundSchema` machinery — never talks to `memory.*`, never informs other agents.
- **Lost signal:** a `reject` throws `WorkflowHeld` and the rejected draft content survives only in step checkpoints — never persisted to the ledger, never surfaced, never learned from.
- **Evals feed nothing back:** the entire eval system is 5 deterministic gate checks over one frozen endorsed output per agent, run only in CI. No agent is ever executed, no LLM-judge exists (RFC-01 §12 rungs 3–5 unbuilt), no score is persisted anywhere. 5 agents have no evals at all.
- **Memory is not product-scoped:** decisions are keyed by `clientSlug` only, so LinkedIn's "never same archetype as last post" rule silently no-ops for any multi-channel client (still-open prior-audit P1, `karos-memory/src/append-decision.ts:22-23`).

### 4.3 Target feedback architecture

1. **One feedback pipeline:** `runReviewCycle` (adopted fleet-wide) → `memory.appendFeedback` → `readPastFeedback` injected into **every** drafting agent. Migrate the 6 `ledger.feedbackAppend` sites; delete the tool.
2. **Persist rejected drafts** (content + reason) to `memory/feedback` so revisers and future runs see *what* was rejected, not only why.
3. **Product-scoped memory keys** (`productId` segmentation) — fixes the LinkedIn no-repeat no-op.
4. **Score persistence:** eval + judge scores → BigQuery (the telemetry table already has the row shape); production sampling of approved vs revised drafts becomes the training signal for prompt and model changes.
5. **Brand-kit adherence as an enforced contract:** today `client.getBrand` + `gate.brandCompliance` cover 5 channels; instagram (zero gate coverage) and the landing/branded-shorts brand paths are separate. Unify on one BrandKit schema — including the new `language` field (§4b) and asset references (§4d) — with a compliance gate in every deliverable path.

### 4b. Case study: geektime Instagram run — Hebrew quality failure, and the per-step model-recommendation feature

**Incident** (job `0ltqevQ4rBQDPqdQ2TzT`, app-prep): geektime's brand-voice document specifies Hebrew content; the delivered carousel's on-image text was poor Hebrew — bad vocabulary and grammar — yet passed every check and reached the client-facing gate.

**Root causes, all verifiable in source:**
1. **No language dimension exists anywhere in the QA chain.** The Hebrew requirement lives in `client/voice-rules`, but instagram's checks are English-centric heuristics (`craft-hygiene.ts`), it calls zero `gate.*` tools (§3.2), and neither `instagram-image-vet@2` nor `instagram-visual-qa@1` prompts ask "is the rendered text fluent, grammatical Hebrew?" The self-check loop cannot catch what no check measures.
2. **One model for everything.** 26 of 27 sub-agents are pinned to `claude-sonnet-4-6` regardless of task language or difficulty. No policy consults the client's content language when selecting the copy model.
3. **Typography/RTL risk compounds it:** templates and font stacks (`brand-render-tokens.ts`) were built against Latin scripts; RTL layout correctness is unverified.

**Fixes, tactical → structural:**

- **Today, zero code:** override the copy step per deployment — `MODEL_STEP_INSTAGRAM_COPY_VENDOR=gemini`, `MODEL_STEP_INSTAGRAM_COPY_MODEL=gemini-2.5-pro` (mechanism at `packages/core/src/router/step-model-policy.ts`). Limitation: this is global per deployment, not per client — which motivates the design below.
- **Language-compliance gate:** add `language` to the BrandKit contract; thread it into the copy prompt; add a two-stage check inside the instagram self-check loop before render — a cheap deterministic script/charset check plus an LLM-judge fluency grade in the target language (a `commodity`-tier call, same pattern as `runTopicGuardrail`).
- **Per-client model policy:** extend `ModelPolicy` resolution to consult client config (`client/config` already exists in the workspace store) so a Hebrew-content client automatically gets a Hebrew-strong model on copy steps without a deployment change.

**Feature: per-step model recommendation (user-requested).** The *switching* machinery is already excellent (env per-step overrides + Studio per-run `stageModels`). What's missing is the *decision layer*:

1. **Model-capability catalog** — a typed table per model id: language/RTL strength, modality, context window, cost tier, structured-output reliability, availability region. `applyStageModelOverride` validates against it (closing §3.3-7), and the Studio renders it.
2. **Recommender** — given a step's task type (copy / extraction / QA / narrative) + client language + budget tier, surface a ranked suggestion in the Studio (e.g., "copy step, Hebrew client → `gemini-2.5-pro` or `claude-opus-4-8`; not the Sonnet default").
3. **Measurement loop** — per-language golden runs + LLM-judge scores persisted to BigQuery (§4.3-4), so recommendations are earned from data. This is the same missing RFC-01 §12 machinery, now with a concrete business driver: the model-tier decision the three-tier policy was designed for finally gets its measurement path.

**Models to enable on Vertex for more options** (in recommended order):

| Model | Why | Wiring |
|---|---|---|
| `gemini-2.5-pro` | Strong Hebrew/multilingual + RTL; adapter already exists | `GEMINI_ROUTE=agent-platform`, already supported — enable in Model Garden, set per-step vars |
| `claude-opus-4-8` | Highest-quality multilingual copy for flagship clients | Request in Model Garden (24–48h); alias table already has pricing |
| `gemini-2.5-flash` | Cheap commodity tier for guardrails/judges in non-English | Same Gemini adapter |
| A multilingual open model (e.g. via Model-as-a-Service) | Optional commodity fallback; adapter exists (`model-garden`) | `MODEL_GARDEN_PROJECT_ID` + region vars; **note** unknown ids currently bill at Sonnet rates silently (`pricing.ts:91`) — add pricing rows first |

### 4c. SEO/GEO: ingestion architecture evaluation & legacy-v2 extraction

**Context:** three SEO/GEO systems now exist — (1) karosCMO's live simple system, (2) agent-engine's `karos-seo-geo` + `seo-geo-agent` (built, dispatchable, measurement front-end stubbed), and (3) the legacy v2 Claude Skill at `karos-agents/products/building/seo-geo-agent-v2/` — which is the most evolved on domain logic and **proven end-to-end on a real client** (`clients/karoslabs/outputs/seo-geo-agent-v2/2026-08-20-full-cycle-001/`: real provider responses, 116 graded observations, $0.63 measured cost).

**Recommended division of authority:** v2 skill = domain-logic source of truth · agent-engine = production runtime · karosCMO `Recommendation` shape = portal compatibility target (the thin mapping the roadmap doc's Phase A already prescribes).

#### Ingestion evaluation: Option A (crawlers) vs Option B (native LLM APIs) vs hybrid

The v2 skill has **already run this evaluation** and encoded the verdict in `docs/SEO-GEO-V2-CAPTURE-CONTRACT.md` + `assets/config/scrappycoco-routes.json`: a **per-engine hybrid**, because no single approach covers all engines.

| Engine | Method (v2 verdict) | Tier label | Cost/query |
|---|---|---|---|
| Perplexity | First-party Sonar API, native citations | MEASURED | ~$0.001–0.003 |
| Claude | Anthropic Messages + `web_search` server tool (Haiku-class capture, never the report model) | MEASURED | ~$0.012–0.02 |
| Gemini | Gemini API "Grounding with Google Search" — explicitly labeled **MEASURED (grounded)**, no equivalence claimed to consumer AI Overviews; AIO-absent cells get a distinct status, never brand-absent | MEASURED (grounded) | API rates |
| ChatGPT / Copilot / AI Mode / google_aio | ScrappyCoco CLI routes (pinned `@scrappycoco/cli@0.8.3`, API-key auth, concurrency 3 on a warmed token) | per route | per route |
| SerpApi google_ai_overview | **Deliberately OFF** — subject of Google's Dec-2025 DMCA suit; enable only as flagged ESTIMATED supplement | ESTIMATED | — |

Key contract properties worth porting verbatim: per-cell frozen `capture_tier ∈ {MEASURED, ESTIMATED, UNAVAILABLE}` never silently upgraded; raw provider payload frozen with `raw_sha256` so scoring is a pure function of the frozen set (bit-identical re-scores, drift is a logged event — this is what kills "60% one run, 50% the next"); pre-flight credit probes with per-cell 402 → UNAVAILABLE.

**Recommendation:** adopt this per-engine adapter matrix as the implementation spec for `research.captureVisibility` (whose contract was explicitly designed for a drop-in adapter swap — `capture-visibility.ts:60-67`). Benchmark only what v2 didn't settle: current ScrappyCoco route reliability/latency per engine, and whether Apify actors are a cheaper fallback for the scraped engines. Do not re-derive the first-party API decisions.

#### Legacy logic extraction (skill → production workflow)

The v2 skill is instructions + a deterministic Python engine — not typed tools, not `BaseAgent`. Extraction targets:

1. **Scoring engine** — `assets/engine/` (`score.py`, `visibility.py`, `recommend.py`, `citations.py`, 132-assertion `selftest.py`, real-provider fixtures for 6 engines). Port to TypeScript inside `karos-seo-geo` (preferred — the repo already ports Python scoring for reputation) or wrap as a versioned tool the way `karos-video` wraps its Python engine. The agent-engine rec-catalog port predates v2 — diff and reconcile.
2. **"Known vs Found, never blended"** — v2 retired the single visibility score (2026-08-20): *Known* (recognition when the prompt names the company) and *Found* (discovery when it doesn't) are reported separately, never averaged; `never_blend` travels with the data; engines with <10 answers publish counts, not percentages. This supersedes parts of `karos-seo-geo/src/visibility-metrics.ts` **and resolves the open N/N_e denominator decision** the code carries as `denominatorDecision.status:"pending"` — v2's answer: per-engine rates use N_e, the blended index uses N, both always printed. (Also fixes the still-open prior-audit P1 where the blended rate ignores N_e.)
3. **Prompt-set generation + client approval** — 20–35 prompts **in the client's language**, five locked intent types under enforced quotas, 5-shingle dedupe, client approval with `desired_outcome` (neutral `named_in_answer` pre-fill — never the flattering default), frozen `prompt_set_hash` / `competitor_set_hash` / `gazetteer_hash`. Maps directly onto the existing `02-draft-prompt-set → 03-prompt-set-review` gate in `create-seo-geo-agent-workflow.ts`.
4. **Run protocol** — frozen-vs-live split, raw-first capture, HALT semantics, cost reconciliation. Most of this maps onto the workflow engine's checkpointing already; the genuinely new piece is **frozen-set reproducibility hashing**, worth adding as a first-class workflow concept.
5. **Guard against zero-data reports** (G2 stopgap, ship first): `WorkflowHeld` when `capturedCount === 0` so the dispatchable agent can't persist a report scored from nothing.

### 4d. Media agents: dynamic brand aesthetics & pattern learning

1. **Historical post ingestion & pattern learning.** Extend `karos-media`/`karos-scraper` with an opt-in capability to pull the client's own past high-performing posts (Apify actors are already integrated in `karos-media/src/providers/apify.ts`; `research.pull` already has an account-history path), extract visual/layout/engagement patterns via a vision-model analysis step, and inject them as dynamic reference context into copy prompts and template selection — replacing static generic templates as the only aesthetic source. Store the learned pattern profile under `clients/{slug}/client/visual-patterns` so it's versioned per client and reviewable.
2. **Dynamic brand assets — logo placement.** Auto-resolve the client's verified SVG/PNG logo from the BrandKit/GCS (`karos-media/src/brand-logo.ts` already downloads SVG logos — extend it, don't duplicate) and inject into `publish.renderCarousel` templates and video covers, with deterministic contrast (WCAG against the slide background token) and positioning rules — enforced in code, not prompt.
3. **Creative palette variation.** Extend `brand-render-tokens.ts` (instagram) with guided rotation of primary/secondary/accent tokens from the Brand Kit across carousel slides and video covers — seeded by slide index so it's reproducible — preventing visual monotony while staying inside the kit.
4. **Elevated visual QA.** Extend `instagram-visual-qa@1` (and the branded-shorts self-eval gate) with explicit grading criteria: composition richness, font hierarchy, brand-asset integration, color harmony — plus the §4b language gate. Add deterministic pre-checks where possible (logo present? palette tokens within kit? contrast ratio?) so the LLM judge grades only what code cannot.

---

## 5. Phase-by-Phase Implementation Roadmap

Ordering respects the standing business priority (SEO/GEO serves paying clients; `docs/PLAN-2026-08-status-and-roadmap.md`) while front-loading cheap safety and quality wins. Each phase lists acceptance criteria (AC).

### Phase 0 — Safety valves (days, no design work)

| Task | Files | AC |
|---|---|---|
| Hold seo-geo runs with zero captured cells | `create-seo-geo-agent-workflow.ts` (after step 08) | A run with `capturedCount === 0` ends `held`, never persists a report |
| Move x-agent gates 16/17 inside `draftOnce` | `create-x-agent-workflow.ts:465-477` | Placeholder/leak failures surface pre-approval with a revision path; test added |
| Fix video-gate outcome smuggling (6 tools) | `karos-video/src/tools/*.ts`, `gate-helpers.ts` | Engine failures return `toolingError(...)`; cross-cutting test asserts no `success`-wrapped `tooling_error` fleet-wide |
| Set `maxTokens` on intel-report/blog/newsletter drafts | `agents/*/src/agent/*.ts` | Explicit values sized to output schemas |
| Wire push auth | `cloudbuild.yaml`, `cloudbuild.promote.yaml` (`PUBSUB_PUSH_AUDIENCE_URL`) | Unauthenticated push envelope → 401 in prep + prod |
| Minimal app-layer authz | `apps/agent-server/src/app.ts` middleware | OIDC verification + slug entitlement on runs/agents/deliverables routes; internal error strings no longer leaked |
| Prod secret parity | `cloudbuild.promote.yaml` | `APIFY_TOKEN` (+ media keys as intended) present in prod, or the omission documented as deliberate |

### Phase 1 — Tool unification & schemas (1–2 weeks)

1. `description` on `AgentTool` + `.describe()` rollout across all 74 tools, threaded into `describeAllowedTools` — text lifted from existing TSDoc. **AC:** JSON schema snapshot test proves every exposed tool carries prose; eval golden runs unchanged or improved.
2. Merge R1–R7 (§2.1): shared `gate.renderPreview`, unified media pipeline, single feedback log, shared sandbox helper, common `fetchWithDeadline`+retry, shared upload helper, unified gate-verdict base.
3. Delete/wire the 11 dead tools; wire `video.assetsCheck` into onboarding; reconcile RFC-01 §9.2.
4. §2.4 quality fixes: double-parses, TOOL_VERSION policy, boundary `safeParse`, bounded history reads, store conformance test.
**AC:** registry count test updated intentionally; `npm run verify` green; tool-layer README regenerated from the new descriptions.

### Phase 2 — Prompt externalization & tuning (1 week)

Prompts are already DB-backed (Firestore driver in prep+prod, versioned `.md` sources, CI publish with pin verification — genuinely good). Remaining:
1. Fix `latest.md` drift in `blog-craft` and `newsletter-craft` (publish script would silently mint a phantom v4 and repoint `latestVersion`).
2. A typed prompt registry (ids, versions, owning agent) replacing filesystem walking in scripts; add a drift check to CI.
3. **Token efficiency (G5):** move `describeResponseContract` + `describeAllowedTools` into the cached `system` block; drop the `null, 2` pretty-print; elide/summarize observations older than N turns.
4. Per-prompt hygiene pass: structured-output requirements and anti-hallucination guardrails asserted per prompt (blocked-intake behavior, "never invent numbers" with `gate.numbersSourced` cross-check), language directive threaded from BrandKit (§4b).
**AC:** measured uncached-input-token reduction on a `landing-make` fixture run (expect >40%); prompt publish CI fails on drift.

### Phase 3 — Agent workflow refactor & feedback loops (2–3 weeks)

1. Lift `toAgentContext`/`runGate`/evals scaffolding/persist-triple into shared packages (§3.3-3).
2. `gateInput` transform → selfCritique for seo-geo ×2 + intel-report; adopt `runReviewCycle` + guardrail in intel-report, tiktok, campaign (with the campaign gate-payload fix), seo-geo.
3. Unified feedback pipeline + rejected-draft persistence + product-scoped memory keys (§4.3).
4. `checkOutputDedupe` fleet-wide; dynamic-agent resume; fanout concurrency cap; step-abort propagation.
5. **Geektime fix set:** BrandKit `language` field, language-compliance gate in instagram's self-check loop, per-client model policy, model-capability catalog + Studio recommender (§4b), enable `gemini-2.5-pro` / `claude-opus-4-8` (+ pricing rows before enabling any Model-Garden model).
**AC:** capability matrix (§3.1) shows revise/guardrail/feedback columns green fleet-wide; a Hebrew-client instagram fixture run fails the language gate on planted bad Hebrew and passes on good.

### Phase 4 — Integrations, DB persistence & testing (3–5 weeks, parallelizable)

1. **SEO/GEO capture layer** to the v2 per-engine matrix (§4c): Perplexity Sonar, Anthropic `web_search`, Gemini grounding adapters + ScrappyCoco routes; frozen-blob + sha256 reproducibility; apply the gated Google-connector config (needs the named sign-off); technical-SEO crawler for `measurements.ts`.
2. **V2 engine/metrics extraction:** Known/Found model, N/N_e resolution, prompt-set generation + approval flow, rec-catalog reconciliation; portal compatibility mapping to karosCMO's `Recommendation` shape.
3. **Media enhancements (§4d):** historical-post ingestion + pattern profiles; logo injection with contrast rules; palette variation; elevated visual-QA criteria.
4. **Evals ladder rungs 3–5:** LLM-judge harness, per-language golden runs, score persistence to BigQuery, production sampling — the measurement path for the model recommender.
5. **Observability:** Express/HTTP instrumentation, run-level spans, gate + adapter spans, OTel metrics; fix unknown-model pricing fallback to fail loudly.
6. **Ops:** `.env.example` completed (14+ missing vars); landing build isolation (credential-free sandboxed build); IaC for the hand-provisioned buckets/topics/subscriptions/DLQs/IAM; DLQ provisioning in-repo.
**AC:** one real client's seo-geo run produces a report with MEASURED cells end-to-end behind both human gates; eval-judge scores visible in BigQuery; a full trace exists from HTTP request → run → steps → tool calls → model calls.

---

## Appendix A — Prior-audit findings status (verified at HEAD)

Fixed: `allowedTools` P0 · concurrency guard · Firestore `undefined` crash · stale terminal fields · gate-id asymmetry · gate overwrite · budget-on-resume · LLM retry/backoff · build-script omissions · slug charset at ingress.
Still open: app-layer authz · landing builds model-authored code (shell removed; ACE surface remains) · unbounded history reads · GCS/file store divergence · blended rate ignores N_e (superseded by §4c's Known/Found port) · LinkedIn never-repeat no-op (product-scoped memory, Phase 3) · gate timeouts decorative · O(n²) Firestore reads for budget/status · inline whole-run execution in the HTTP request (mitigated by claimRun; 202+background still recommended) · prompt store fails quiet without `PROMPT_STORE_DRIVER`.

## Appendix B — Env/config gaps

Undocumented in `.env.example` (verified zero mentions): `ELEVENLABS_API_KEY`, `YELP_API_KEY`, `GOOGLE_BUSINESS_TOKEN`, `BRANDED_SHORTS_ENGINE_DIR`, `LANDING_ENGINE_ROOT/_TEMPLATE_ROOT/_BUNDLES_ROOT/_CLIENTS_ROOT`, `DYNAMIC_CODE_STEPS_ENABLED`, `DYNAMIC_CODE_SANDBOX_IMAGE`, `INSTAGRAM_AGENT_REPO_ROOT`, `BQ_PROJECT_ID`, `BQ_DATASET_ID`, `IMAGE_GEN_MODEL`, `IMAGE_GEN_LOCATION`, `KAROS_VIDEO_PYTHON_BIN`, `KAROS_VIDEO_FFPROBE_BIN`.
Prod (`cloudbuild.promote.yaml`) wires 2 secrets vs prep's 6 — missing `APIFY_TOKEN` (prep's own comment: "effectively required… to produce content at all"), `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`.
