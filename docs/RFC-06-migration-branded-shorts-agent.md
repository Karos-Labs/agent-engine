# RFC-06: Migrating Branded Shorts (the video-editing agent)

**Depends on:** RFC-01 (engine core), RFC-02 (migration recipe, §2)
**Source material (read directly this session):** `karos-agents/products/building/branded-shorts/{SKILL.md,docs/PORTAL-ONEPAGER.md,docs/PLAYBOOK.md,assets/INTAKE-REQUEST.md,assets/engine/*.py}` (headers/structure of the six engine scripts; `build_short.py` itself is 54KB and was not read line-by-line — see §5)
**Not registered anywhere in the portal:** no `customAgents` doc, no Dynamic Agent Studio spec, no entry in `karos-agents/catalog/products-catalog.json`, and no `register-branded-shorts*.ts` script exists in `karosCMO/scripts/`. Confirmed by a full listing of that scripts folder and a keyword search of the catalog and of `karosCMO/src/lib/**` for "shorts" — zero hits either way. This is earlier-stage than Instagram (RFC-03), which is at least registered-and-disabled.

---

## 1. This is not a writing agent — it is a deterministic video-rendering pipeline with two small islands of judgment

Every other agent migrated so far (X, Instagram, SEO&GEO, Intel Report) is fundamentally a research-and-writing loop: pull data, reason over it, produce prose or a scored artifact. Branded Shorts is different in kind: it is a **Python + ffmpeg rendering pipeline** — transcription, cut-craft, color grading, caption compositing, motion-graphics rendering, and encoding — where the SKILL.md's own words are "100% deterministic (no AI restyle) — every frame is pixel-verifiable and gated against the client's brand." The two places a model genuinely judges anything are narrow and already fenced:

1. **Graphics/cutaway selection** — given a transcript and the client's `graphics-language.md` (their primitives, composition rules, motion rules), choose which beat gets which archetype and write the cutaway plate prompts. Creative, but constrained to a closed vocabulary the client already approved.
2. **Style Exploration** (one-time, per new client) — propose three candidate style directions from the client's brand, a human locks one, and every video after that is mechanical.

Everything else — the cut, the color, the caption rendering, the endcard, the gates — is code. This changes the migration shape: most of RFC-01's `BaseAgent` steps here are **code steps with no model call at all**, and the few LLM steps are tightly bounded, schema-out, single-purpose calls (a "pinned"-tier judgment call feeding a deterministic renderer), not open-ended agent loops.

## 2. The pipeline, and where each stage sits in RFC-01's tiers

| # | Stage | Tier | What it actually is |
|---|---|---|---|
| 0 | Brand resolve | code | Load the client's locked `brand-profile.json` + `graphics-language.md`. New client → run Style Exploration (below). |
| 1 | Transcribe | code (external API) | ElevenLabs Scribe via the open-source **video-use** engine (`VIDEO_USE_HELPERS` env pointing at a checkout — a real external dependency to vendor/pin, not a Karos-owned tool). |
| 2 | Edit/cut | code | Crop-the-ends-then-filler-only cut logic + `cut_check.py` gate (min 1.5s segments, max 4 cuts/10s, ≥80% window retained). No model involved — the rule is mechanical. |
| 3 | Highlights | **bounded agent step** | Pick the emphasis-word rhythm from the transcript against the "one decisive word every chunk or two" rule. Small, schema-out (a list of word spans), still worth a real BaseAgent step because it reads client-specific corrections dicts and produces a typed artifact the renderer consumes verbatim. |
| 4 | Color | code | HLG→SDR tonemap LUT (`hlg709_N.cube`) + the video-use auto-grade analyzer. Zero judgment; "auto" or a locked profile override. |
| 5 | Graphics | **bounded agent step, then code gate** | The one real creative step: pick an archetype from the client's repertoire per transcript beat, per `graphics-language.md`. Output is validated against `brand_check.py` (palette + zero-red) and `graphic_qa.py` (visibility over the actual footage) — FAIL auto-remedies and re-gates. This is RFC-01 §5.6's self-correction gate already implemented as bespoke Python. |
| 5b | Cutaways/bursts | **bounded agent step, then code gate** | Same shape as graphics: pick 4-5 beats worth a full-frame visual or a burst of real stills, write the plate prompts, gate via `cutaway_check.py` (timing law, mutual exclusion with graphics, count). |
| 6 | Build | code | `build_short.py --profile <config> --job <job.json>` — the actual ffmpeg/PIL render. No model call. |
| 7 | Self-eval + QA gate | code | Frame sampling at every cut/caption/graphic/endcard boundary, saturation sanity check, whole-video flash scan, post-encode hue check. Max 3 auto-fix passes, then deliver. |

Style Exploration (onboarding, one-time) is its own small workflow: propose 3 directions → present → human locks one → write the client's `brand-profile.json` + `graphics-language.md` + `make_motion_repertoire.py`. This is a natural fit for RFC-01's Gate contract (`requiredRole`: Karos ops or the client, `payload`: the three candidate boards).

## 3. Infrastructure this pipeline needs that the other five agents do not

This is the one migration in this set that cannot run on a thin, stateless Cloud Run job the way a research-and-writing agent can:

- **ffmpeg/ffprobe** with `lut3d` support, and the specific filter chain the pipeline depends on (`overlay`, `scale`, `format`, `eq`, `unsharp`, `loudnorm`, `setparams`, `anullsrc`, the `concat` demuxer, `libx264`/`aac`). This has to be baked into whatever image runs this agent's tool container — it is not `npm install`-able.
- **Python with opencv-python-headless<5** specifically (v5 dropped the `CascadeClassifier` the auto-centering crop depends on) — a pinned, load-bearing version constraint worth carrying into the tool's own `package.json`/`requirements.txt` rather than leaving it as tribal knowledge in a SKILL.md comment.
- **The `video-use` external engine** — an open-source checkout, not a package, referenced by an environment variable. This needs a real vendoring decision in `agent-engine` (a pinned submodule, a mirrored copy, or a container layer) before this migration can run anywhere but a laptop with `VIDEO_USE_HELPERS` set by hand.
- **Real disk and CPU/time budget for video encode.** Every other migrated agent's tool calls are sub-second API round-trips; this one's `build_short.py` step is a multi-minute, CPU-bound, disk-heavy encode per video. The tool registry's serving section (RFC-01 §9.3) should treat this tool differently from the others — it needs its own execution profile (memory, timeout, ephemeral storage), not the default thin-API-call assumption the rest of the catalogue was designed around.

None of this is a reason not to migrate it — it is a reason to flag it now rather than discover it mid-build, since it is the first agent in this set with a real infrastructure footprint beyond "call an LLM and a couple of APIs."

## 4. A lesson already paid for, worth carrying forward as a rule

`brand_assets_check.py` exists because karoslabs once carried a **0-byte `Spectral-SemiBold.ttf`** in git — a font used for the caption body, display, and endcard — that passed every `os.path.exists()` check and would have silently killed a run at three different points. The gate now **opens** every referenced asset, not just checks for its presence. This is a general rule worth stating in RFC-01's tool-design section, not just this agent's spec: any tool that reads a client-supplied asset path (fonts, logos, LUTs, templates) should open/parse it at the boundary, not just stat it — the failure mode this prevents is silent and reveals itself downstream, in a much harder-to-debug place.

## 5. What was not read this session, and should be verified before implementation

- `build_short.py` (54KB) — read only its role in the pipeline via SKILL.md/PLAYBOOK.md, not its actual implementation. Before wrapping it as a tool, read it to confirm the job-schema shape (segments/grade/captions/overlays) matches what §2's bounded steps would need to emit.
- `make_motion_repertoire.template.py`, `brand_check.py`, `graphic_qa.py`, `cut_check.py`, `cutaway_check.py` — read at a structural level (what each gate checks, per the prose above) but not fully audited line-by-line for exact CLI contracts. Confirm exact argument shapes before building the `video.*` tool wrappers in §6.
- `docs/CUTAWAY-IMAGE-PROMPTS.md` and `docs/graphics-language.template.md` were read but the per-client instantiations (a client's actual `graphics-language.md`) were not — those live under `clients/<slug>/skills/branded-shorts/`, out of scope per the user's instruction not to pull client output folders.

## 6. Tools needed

- New: `video.transcribe` (wraps video-use/ElevenLabs Scribe), `video.cutGate` (wraps `cut_check.py`), `video.colorGrade`, `video.graphicsGate` (wraps `brand_check.py` + `graphic_qa.py`), `video.cutawayGate` (wraps `cutaway_check.py`), `video.render` (wraps `build_short.py`), `video.selfEvalGate`, `video.assetsCheck` (wraps `brand_assets_check.py`, opens every file per §4).
- Reuse: `client.*` (RFC-01 §9.2) for the brand profile.
- Per RFC-01 §9.1's rule ("adapter, never infra" already stated verbatim in this product's own SKILL.md — the same rule, independently arrived at): these tools wrap the existing Python scripts as-is; they do not reimplement the rendering logic in TypeScript.

## 7. Portal integration

Zero registration exists today, so — same reasoning as Instagram (RFC-03 §6) — there is no legacy prompt-chaining path worth preserving. Register directly as a new Dynamic Agent Studio spec (preferred) or `customAgents` doc once a pilot render clears human QC, named "Branded Shorts" (the product's own name — no rename is indicated here, unlike Carousel/Instagram). The per-upload intake (`assets/INTAKE-REQUEST.md`) maps cleanly onto a `DynamicAgentInputDef[]` — it already reads as a client-facing form (video file, target length, which section, takeaway sentence, exclusions, names, endcard override) with no brand questions, since brand comes from the client profile.

## 8. Definition of done

Per RFC-02 §7, with these additions: (1) `build_short.py` and the five gate scripts are read in full and their CLI contracts confirmed before the `video.*` tools are built; (2) the `video-use` external dependency has a real vendoring decision (§3) rather than an environment variable pointing at someone's laptop checkout; (3) the ffmpeg/opencv version constraints are captured in the tool's own container/build config, not left as SKILL.md prose; (4) one test video clears the full pipeline end-to-end with human QC — the product's own bar for "per-client onboarding" step 4 — before this is called live in Agent Studio.
