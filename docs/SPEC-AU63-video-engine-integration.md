# SPEC-AU63: Video engine integration — render vs. generate, and what it takes to un-block branded-shorts

**Ticket:** SCRUM-362 (AU63) · **Status:** SPEC ONLY — no implementation in this change · **Author context:** written against `agent-engine` @ this branch's base commit
**Decision authority this spec answers to:** Tomer, product decision 2026-08-26 (quoted in the ticket body): *"Not building it now. This ticket specs the work so it can be scheduled deliberately."*

This document is the deliverable the ticket asks for. It does not touch runtime code — every claim below is checked against the file it cites, not against RFC-06 or the ticket description (per the evidence rule: descriptions and RFCs are unverified prose until checked against code, and RFC-06 in particular is stale in one specific spot, called out in §3).

---

## 1. The product question, answered

**Render (cut/brand existing footage) and generate (Veo, footage from nothing) are not the same product, and the codebase already proves it by having built both separately, sharing almost nothing.**

This is not a hypothetical to resolve going forward — it is the observed shape of two pipelines that already exist in this repo, built independently, for two different agents:

### 1a. `branded-shorts-agent` — the render/edit product (unbuilt render layer)

`agents/branded-shorts-agent/src/workflow/create-branded-shorts-agent-workflow.ts` calls, in order: `video.transcribe` → `video.cutGate` → `video.colorGrade` → (graphics loop: `video.render` + `video.graphicsGate` + `video.cutawayGate`) → `video.selfEvalGate` (workflow.ts:154, 185, 205, 265-290, 323). Every one of `video.cutGate`, `video.render`, `video.graphicsGate`, `video.cutawayGate`, `video.assetsCheck` and `video.brandGate` resolves a script inside `BRANDED_SHORTS_ENGINE_DIR` via `resolveEngineScript()` (`packages/tools/karos-video/src/config.ts:56-75`) and returns `tooling_error` when that directory is unset (confirmed per-tool: `cut-gate.ts:31-34`, `brand-gate.ts:31-34`, `graphics-gate.ts:36-38`, `cutaway-gate.ts:32-34`, `assets-check.ts:32-34`, `render.ts:59-61`). No environment sets `BRANDED_SHORTS_ENGINE_DIR` anywhere in this repo (`grep -rn BRANDED_SHORTS_ENGINE_DIR` outside `karos-video`'s own source/tests and its one mention in `apps/agent-server/src/wiring/tools.ts:23` and the Dockerfile comment at line 20 returns nothing — no `cloudbuild.yaml` entry, no `.env` template value). This agent operates only on footage the client already supplied — there is no Veo call anywhere in its workflow or in `karos-video`.

### 1b. `tiktok-agent` — the sourcing-cascade product, which already includes generate

`agents/tiktok-agent/src/workflow/create-tiktok-agent-workflow.ts` has a four-tier footage cascade (comments at lines 243, 257, 272, 286): attached run footage → client's own library → `media.harvestVideo` (web harvest, `not_available` until a provider is wired) → `video.generateClip` (Veo, "the last resort, and the only tier that can answer any brief," line 286-289). Once footage exists — sourced OR generated — this agent cuts and brands it with `video.cutClip` and `video.brandFrame` (pure `ffmpeg`, `packages/tools/karos-video/src/tools/clip-compose.ts`), **not** `video.cutGate`/`video.render`/`video.brandGate`. The workflow's own comments explain why, and this is load-bearing evidence, not aspiration: line 380-382 — *"This is the whole cut gate now: the old `video.cutGate` call shelled into the unvendored Python engine with the wrong argument shape and had never once succeeded in production"* — and line 485-487, the identical statement about `video.render`. `video.brandGate` was deliberately dropped too (line 565-566: *"its real contract takes PNG stills for the Python engine, not an MP4, and the branded frame is now composited deterministically upstream"*).

### What this means for scoping

- These are **two pipelines**, and today they share exactly **one** gate (`video.selfEvalGate`, which only shells to `ffprobe`, not the Python engine — `self-eval-gate.ts` has no `resolveEngineScript` call at all). The ticket's working assumption — "probably two pipelines sharing gates" — is half right: two pipelines, confirmed; "sharing gates," plural, is not what's in the codebase today. Only the ffprobe-based QA check is shared. The five gates that wrap the unvendored Python engine (`cutGate`, `brandGate`, `graphicsGate`, `cutawayGate`, `assetsCheck`) plus the render step itself (`render.ts` / `build_short.py`) are used by `branded-shorts-agent` alone.
- Veo is **already shipped** as a sourcing tier for `tiktok-agent` (`video.generateClip`, `packages/tools/karos-media/src/generate-video.ts`, registered unconditionally and reporting `not_available` with no Vertex project — same contract as `image.generate`). There is no VIDEO_GEN_MODEL work left to scope for that product; it already exists, is tested (`packages/tools/karos-media/__tests__/generate-video.test.ts`), and this spec's cost section (§5) covers the one real gap in it (no priced SKU).
- **Do not build a generate-based replacement for the branded-shorts render layer.** `tiktok-agent`'s own commit history (visible in the workflow comments) already tried routing through the Python engine and explicitly moved off it because it "had never once succeeded in production." Generation does not substitute for the six gates' actual job — enforcing a client's locked brand profile pixel-by-pixel against real footage — because Veo has no concept of "this client's font, this client's palette, this client's actual product shots." The branded-shorts render layer is the work this ticket is scoping. Extending `tiktok-agent`'s generate tier is separate, smaller, and mostly already done (see §5).

**Scope for the rest of this document, per the above: the branded-shorts render/edit engine only.** Generation is in scope solely as (a) prior art for the deploy question in §2, and (b) the pricing gap noted in §5.

---

## 2. How the engine reaches the container

Today `BRANDED_SHORTS_ENGINE_DIR` is a directory path read at tool-construction time (`config.ts:44`, `resolveRuntime()`), with zero vendoring behind it — RFC-06 §3 flagged "the `video-use` external engine ... needs a real vendoring decision" and that decision has still not been made; the six Python scripts (`build_short.py`, `cut_check.py`, `brand_check.py`, `graphic_qa.py`, `cutaway_check.py`, `brand_assets_check.py`) do not exist anywhere in this repo (`find . -iname "build_short.py"` returns nothing). Two real options, both with the deploy consequences the ticket calls out:

### Option A — baked into the image (recommended)

Add the engine checkout as a vendored directory in-repo (e.g. `vendor/branded-shorts-engine/`, pinned by git submodule or a mirrored copy — RFC-06 §3's own framing), `COPY`'d into the runtime stage in `apps/agent-server/Dockerfile`, with `BRANDED_SHORTS_ENGINE_DIR` set to that path unconditionally in the image.

- **Image size / cold start:** the six scripts plus their asset dependencies (fonts, LUTs, motion-repertoire templates per RFC-06 §2 rows 0-6) are code and small binary assets, not the multi-minute encode itself — this should add low tens of MB, not a meaningful cold-start regression on top of the Playwright/Chromium install this image already carries (`Dockerfile:23-38`).
- **The concrete failure mode to design against, from this exact repo's own history:** `.dockerignore` currently excludes `**/__tests__`, `**/*.test.ts`, and (with carve-outs) `scripts/` (`.dockerignore`, root). SCRUM-351/AU54 already broke a Cloud Run build this way once — `apps/agent-server/__tests__/dockerignore-build-graph.test.ts` documents the incident: a file (`workspace-graph.mjs`) that existed, typechecked, and ran fine from a checkout was invisible to the build **context** because the carve-out for the new file was never added, and nothing local caught it (`ERR_MODULE_NOT_FOUND` only showed up in Cloud Build). A vendored engine directory is exactly this hazard again: nothing today derives "does the build context actually contain every file `BRANDED_SHORTS_ENGINE_DIR` will point at" the way `dockerignore-build-graph.test.ts` derives the scripts/ carve-out from actual imports. **Action item for the implementation plan:** whatever path the engine lands at needs either (a) to sit outside anything `.dockerignore` currently excludes (i.e., not under `docs/`, `__tests__/`, or `scripts/`), or (b) an explicit carve-out line, verified the same way — a test that lists the vendored directory's real files and asserts none of them are `.dockerignore`-excluded, not a comment promising they aren't.
- **Runtime dependencies beyond the directory itself**, checked against `apps/agent-server/Dockerfile`'s current runtime stage (lines 76-81):
  - `python3` + `python3-pip`: present.
  - `ffmpeg`: present, but installed as whatever version Debian bookworm's `apt` repo currently ships, unpinned (`Dockerfile:79`, no version constraint, no `lut3d`/filter capability check). RFC-06 §3 names a specific filter-chain requirement (`overlay, scale, format, eq, unsharp, loudnorm, setparams, anullsrc`, the `concat` demuxer, `libx264`/`aac`, plus `lut3d` for the HLG→SDR tonemap). **Nothing in this repo verifies the installed ffmpeg build actually has these** — this is a real, currently-unaddressed gap, not a checked-off item.
  - `opencv-python-headless`: installed at `Dockerfile:80` via `pip3 install --no-cache-dir --break-system-packages opencv-python-headless`, **with no version constraint of any kind**. This is a live regression risk, not a resolved one: RFC-06 §3 (`docs/RFC-06-migration-branded-shorts-agent.md:39`) explicitly calls out `opencv-python-headless<5` as load-bearing — "v5 dropped the `CascadeClassifier` the auto-centering crop depends on" — and explicitly frames the pin as *not yet done*: "a pinned, load-bearing version constraint worth carrying into the tool's own `package.json`/`requirements.txt` rather than leaving it as tribal knowledge." Grepping the full repo (`Dockerfile`, every `package.json`, any `requirements*.txt`) for `opencv-python-headless` finds exactly the one unpinned `pip3 install` line above and nothing else. **This is an open action item, not background**, and it belongs explicitly in the implementation plan (§7, item 2): pin the runtime install to `opencv-python-headless<5` in the Dockerfile line itself (`pip3 install --no-cache-dir --break-system-packages 'opencv-python-headless<5'`) as the minimum fix, and consider promoting it to the tool package's own `requirements.txt`/`package.json` per RFC-06's stronger recommendation so the constraint travels with the code that depends on it rather than living only in a comment three files away.

### Option B — mounted volume

Cloud Run supports GCS FUSE volume mounts, but nothing in this repo uses that mechanism today — the only `--add-volume` usage that exists (`cloudbuild.yaml:224-235, 269-280`) is `type=in-memory` (tmpfs scratch space for media/Instagram/template caches), which is ephemeral per-instance storage, not a way to deliver external content into the container. Standing this up for real would mean: a GCS bucket holding the engine checkout, a FUSE volume mount added to both the `deploy-prep`/`deploy-prod` Cloud Run steps, and an update process for that bucket that isn't `git` (so the "pinned version" property Option A gets for free from a commit SHA has to be re-implemented as a bucket-object versioning discipline). This avoids growing the image but adds a second deploy artifact to keep in sync with the code that reads it, and a new cold-start dependency (FUSE mount latency) on every instance start rather than paying it once at build time.

**Recommendation: Option A (baked into image).** It reuses this repo's existing pinning discipline (a git SHA controls what deploys — the exact same guarantee `deploy-prep`/`deploy-prod`'s "prep only ever deploys from `main`" convention already leans on, per `dockerignore-build-graph.test.ts`'s "copy 5" discussion), and it avoids introducing a second, un-precedented deploy mechanism (GCS FUSE) into a Cloud Run setup that has never used one. The image-size cost is real but modest relative to the Playwright/Chromium install already paid.

### The execution-profile gap, separately

RFC-06 §3's closing point stands and is still unaddressed: `build_short.py` is "a multi-minute, CPU-bound, disk-heavy encode," and `cloudbuild.yaml` sets `--memory=2Gi` for the whole server (lines 211, 250) with **no `--timeout` or `--cpu` override anywhere in the file** — meaning this service runs on Cloud Run's default request timeout (300s) and default CPU allocation. A multi-minute render invoked synchronously inside an HTTP request handler will hit that default timeout. This needs either (a) a dedicated Cloud Run service/job for the render step with its own `--timeout`/`--cpu`/`--memory` flags, or (b) the render step dispatched asynchronously (this repo already has a Pub/Sub queue-consumer path — `apps/agent-server/src/queue-consumer.ts`, referenced in `cloudbuild.yaml`'s deploy-worker step) rather than served inline. This is an implementation-plan item (§7), not a decision this spec makes on its own — it depends on how `branded-shorts-agent`'s workflow steps are already scheduled (durable `wf.step.code` calls, per the workflow file's structure), which a follow-up ticket should confirm before choosing.

---

## 3. What the six `video.*` gates need to run

The six tools that resolve a script inside `BRANDED_SHORTS_ENGINE_DIR` and currently fail closed with `tooling_error`:

| Tool | Script | Confirmed at |
|---|---|---|
| `video.assetsCheck` | `brand_assets_check.py` | `assets-check.ts:8,32-34` |
| `video.cutGate` | `cut_check.py` | `cut-gate.ts:9,31-34` |
| `video.brandGate` | `brand_check.py` | `brand-gate.ts:8,31-34` |
| `video.graphicsGate` | `graphic_qa.py` | `graphics-gate.ts:8,36-38` |
| `video.cutawayGate` | `cutaway_check.py` | `cutaway-gate.ts:8,32-34` |
| `video.render` | `build_short.py` | `render.ts:6,59-61` |

(`video.selfEvalGate` and `video.colorGrade` are not in this list: `selfEvalGate` only shells to `ffprobe` — no `resolveEngineScript` call in `self-eval-gate.ts` — and `colorGrade`'s constructor takes no options at all, per `index.ts`'s `createColorGrade()` call with zero arguments, so it is not currently wired to the engine directory either; RFC-06 §2 describes it as depending on "the video-use auto-grade analyzer," which per this spec's Option A vendoring decision would need to move under the same vendored directory before `colorGrade` could do more than the LUT-only path.)

What they need, concretely, to go from `tooling_error` to actually running:

1. **`BRANDED_SHORTS_ENGINE_DIR` set** to a real checkout, per §2's deploy decision — this alone is necessary but not sufficient; `packages/core/src/diagnostics/capability-catalogue.ts:210` is explicit that "pointing the variable at a directory would not change this: there is no engine to point it at" today.
2. **The six scripts' exact CLI contracts confirmed**, per RFC-06 §5's own admission that `build_short.py` (54KB) and the five gate scripts were read only "at a structural level," not audited line-by-line — this has to happen before the TypeScript wrappers' `args` arrays (e.g. `cut-gate.ts:34`: `["--job", jobPath, "--transcript", transcriptPath, ...]`) can be trusted to match the scripts they invoke. This is RFC-06 §8 item 1, still open, and belongs in the implementation plan.
3. **The runtime dependencies in §2** — pinned `opencv-python-headless<5`, and a verified (not assumed) `ffmpeg` build with `lut3d` and the named filter chain.
4. **Client-side assets** (`brand-profile.json`, `graphics-language.md`, LUT files, fonts, motion-repertoire templates per RFC-06 §2 rows 0/4/5) resolvable via `client.*` tools per RFC-06 §6's reuse note — out of this spec's scope to re-verify since `client.*` already exists and is unrelated to the engine-vendoring gap.
5. **A working `video.colorGrade`/`video-use` auto-grade analyzer decision** — see the table note above; this is a second, smaller vendoring question inside the same engine, and should be resolved as part of the same Option A checkout rather than separately.

The `tooling_error`-on-missing-engine behavior itself is correct and already covered by tests (`packages/tools/karos-video/__tests__/*.test.ts` per-tool "reports tooling_error when engineDir is unset" cases exist for at least `cut-gate.test.ts`, `render.test.ts`, per the file list) — nothing in this spec proposes changing that fail-closed contract; the six gates should keep failing loudly until the engine is actually vendored, exactly per `capability-catalogue.ts:210`'s framing.

---

## 4. The transcription/render pairing

`ELEVENLABS_API_KEY` (wiring the real transcription backend for `video.transcribe`, `packages/tools/karos-video/src/tools/transcribe.ts`) and the render engine from §2/§3 are two halves of one dependency, and the codebase's own capability catalogue already states this precisely — `packages/core/src/diagnostics/capability-catalogue.ts:200`:

> "video.transcribe reports not_available, so branded-shorts and tiktok runs cannot plan a cut at all. WIRING THIS ALONE PRODUCES NOTHING: the transcript feeds a renderer that does not exist yet (video-engine, SCRUM-362), so a run with a transcription key and no engine gets further before failing and ships exactly as much video as it does today — none. Fixing this is not fixing video."

This spec's job is to make sure the inverse is recorded with equal weight, since the ticket's own wording ("the second half is never descoped as 'the cheap part'") anticipates exactly the failure mode of only fixing the engine and leaving `ELEVENLABS_API_KEY` unset: `branded-shorts-agent`'s workflow calls `video.transcribe` as its very first tool step (`create-branded-shorts-agent-workflow.ts:154`), before `video.cutGate` ever runs (line 185) — so an engine with no transcription key gets exactly as far as it does today: nowhere, just with a different tool reporting the failure (`transcribe` returning `not_available` instead of `cutGate` returning `tooling_error`). **Neither half is independently useful. Both must land in the same scheduling window**, and a follow-up ticket that implements only one half should be treated as incomplete against this spec, not as partial progress.

---

## 5. Cost shape

Two independent cost lines, neither of which is a token cost — `packages/core/src/telemetry/pricing.ts` models `MODEL_PRICING` (token-based) and `UNIT_PRICING` (per-unit-SKU, e.g. per-image) separately, and video needs a third shape this module does not have a slot for yet:

### 5a. Per-render compute (branded-shorts, once vendored)

`build_short.py`'s cost is CPU/time on the render container itself (RFC-06 §3: "multi-minute, CPU-bound, disk-heavy"), not a billed external API call. Nothing in `pricing.ts` models "our own compute-seconds for a render step" — `UNIT_PRICING` and `MODEL_PRICING` both price a vendor's SKU, not this service's own Cloud Run billing. This is a genuine gap: SCRUM-361 ("neither is a token cost, and the pricing module is a token model") is right about the mismatch, but the fix is not "add a `UNIT_PRICING` row" the way `video.generateClip` needs one (§5b) — a per-render Cloud Run compute cost would need to be estimated from `--cpu`/`--memory` allocation × wall-clock render time, a different calculation shape than either existing table, and out of scope for this spec to design in full; flagging it here is the deliverable per the ticket's cost-shape requirement, and a rate should not be guessed the way `pricing.ts:230-232`'s own comment on video refuses to guess a Veo per-second rate.

### 5b. Generative per-second billing (Veo, already partially priced-for)

`video.generateClip` already reports usage in the shape `{ model, unit: "second", quantity: durationSeconds }` (`generate-video.ts`, final `success(...)` call) — the unit-cost plumbing exists. What's missing is the rate itself: `packages/core/src/telemetry/pricing.ts:215-220`'s `UNIT_PRICING` table has no row for `veo-2.0-generate-001`, and `scripts/check-model-pricing.ts:69-70` explicitly allowlists it as `UNPRICED_PENDING_DECISION`, with its own comment stating why: *"no per-second rate for this exact id could be verified against a page actually read ... a search result suggesting it is deprecated with a mid-2026 shutdown could not be confirmed at source either ... The video line is UNRUNNABLE pending SCRUM-362 regardless, so nothing bills through this today."* This is the correct interim state — loud and building-blocked rather than silently wrong — and this spec does not change it. **Action item, not for this ticket:** before `video.generateClip` is exercised against a live Vertex project in any environment, either confirm `veo-2.0-generate-001`'s current lifecycle/rate from a source that can actually be read, or pick a different default model id, and add the resulting `UNIT_PRICING` row — `check-model-pricing.ts` will fail the build the moment that model id is wired to a real client and no row exists, which is the intended backstop.

### Net cost-shape statement for the scoped work

If §1's product-scoping is followed (this ticket scopes the render layer only, not new generate work), the cost work this ticket's implementation should account for is **5a only** — the Veo per-second gap (5b) is a pre-existing, already-tracked, already-blocked item on a different product (`tiktok-agent`) that this spec does not need to re-open.

---

## 6. What was NOT re-verified in this pass

Per the evidence rule (a citation into a comment/RFC is unverified until checked against code): this spec re-checked every RFC-06 claim it relies on against actual source in this repo (tool files, Dockerfile, cloudbuild.yaml, capability catalogue, pricing module) rather than restating RFC-06 or the ticket description. Two things this spec explicitly did NOT verify, because they require the vendored engine to exist first and are out of scope for a spec-only ticket:
- The six scripts' exact CLI argument contracts (RFC-06 §5, §8 item 1 — still open, listed in §7 below).
- Whether the currently-unpinned `ffmpeg` apt package on `node:22-slim`/bookworm actually has `lut3d` filter support today. This can be checked cheaply once implementation starts (`ffmpeg -filters | grep lut3d` inside the built image) but doing so now would require a build this spec-only ticket shouldn't perform.

---

## 7. Scoped implementation plan (for the follow-up ticket — not built here)

1. Make the vendoring decision concrete: pin a specific commit/version of the branded-shorts engine checkout as a git submodule or mirrored copy under a new top-level directory (Option A, §2); confirm the chosen path is not swallowed by any existing `.dockerignore` exclusion, and add a derived test (in the style of `dockerignore-build-graph.test.ts`) asserting the build context actually contains every file under that directory.
2. Pin `opencv-python-headless<5` in the Dockerfile's `pip3 install` line (`Dockerfile:80`) — this is the one concrete, currently-missing line-level fix this spec identifies; consider also recording the constraint in a `requirements.txt` alongside the vendored engine per RFC-06 §3's stronger recommendation.
3. Verify (do not assume) the `ffmpeg` build in the runtime image supports `lut3d` and the full filter chain RFC-06 §3 names; pin an explicit `ffmpeg` version via a non-default apt source or a static build if the bookworm default is insufficient.
4. Read `build_short.py` and the five gate scripts in full (RFC-06 §5/§8 item 1) and confirm each TypeScript wrapper's CLI argument construction against the real contract before flipping `BRANDED_SHORTS_ENGINE_DIR` on anywhere.
5. Decide the render step's execution profile: dedicated Cloud Run service/job with raised `--timeout`/`--cpu`, or async dispatch via the existing Pub/Sub queue-consumer path (`cloudbuild.yaml`'s deploy-worker target) — do not let a multi-minute render run inside the default-300s HTTP path.
6. Land `ELEVENLABS_API_KEY` (transcription) and the vendored engine (render) in the **same** release/scheduling window per §4 — track this as one work item, not two, so neither is descoped independently.
7. Once BRANDED_SHORTS_ENGINE_DIR is set in a real environment for the first time, add the still-missing `UNIT_PRICING`/compute-cost accounting from §5a before that environment is used for a billed client run.
8. Re-run `apps/agent-server/__tests__/capability-report.test.ts` after wiring — it already asserts `branded-shorts-agent` reports `UNRUNNABLE`/`PENDING_DEVELOPMENT` today (§8 below); once the engine is real, this suite is exactly what should start asserting `RUNNABLE` instead, and its current assertions are the regression guard against flipping that on prematurely.

---

## 8. Acceptance item 3 — capability report — already implemented, verified against code

The ticket's acceptance item 3 ("the capability report shows branded-shorts as UNRUNNABLE (Engine Pending Development)") is **already done in this codebase**, not a gap this ticket needs to close:

- `packages/core/src/diagnostics/capability-catalogue.ts:206-215` defines the `video-engine` capability with `requires: [{ name: "BRANDED_SHORTS_ENGINE_DIR", kind: "required" }]` and a `pendingBuild: { ticket: "SCRUM-362", summary: "render engine pending development" }` block.
- `packages/core/src/diagnostics/capability-report.ts:118-132` derives `UNRUNNABLE` status and a `PENDING_DEVELOPMENT` blocked-reason from that `pendingBuild` field, distinct from a plain missing-config gap (line 121-125's comment: "Reporting branded-shorts as NOT_CONFIGURED because a...").
- `apps/agent-server/__tests__/capability-report.test.ts` asserts this directly and from multiple angles: line 157-158 (`shorts.status` is `UNRUNNABLE`), line 176 (`blockedReason` is `PENDING_DEVELOPMENT`), lines 180-186 (stays `PENDING_DEVELOPMENT` even when a key is *also* missing), and lines 192-198 (**refuses** to call it runnable even with every named env var present — a test that would fail if the `pendingBuild` gate were ever accidentally removed while the underlying engine remained unbuilt).

This spec does not propose changing this mechanism. Section 7 item 8 notes it as the regression guard to watch, not a target to build.

---

## Acceptance checklist

1. ✅ Render-vs-generate answered in writing — §1, with two live, already-diverged pipelines as evidence rather than a hypothetical.
2. ✅ Scoped implementation plan with deploy mechanism chosen (Option A, baked into image) and justified against this repo's existing pinning/build precedent — §2, §7.
3. ✅ Capability report already shows `UNRUNNABLE`/`PENDING_DEVELOPMENT` — verified against code and tests, §8 (no code change needed for this item).
4. ✅ Transcription/render pairing recorded, with the inverse-of-existing-comment risk (engine without key) made explicit — §4.
