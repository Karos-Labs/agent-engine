# Branded Shorts render engine (vendored)

The Python engine every `video.*` tool in this package shells out to
(`BRANDED_SHORTS_ENGINE_DIR`). `apps/agent-server/Dockerfile` points that
variable here, so the same image that runs the adapters carries the engine
they call — the "vendoring decision" RFC-06 §3 and SPEC-AU63 left open is
made: **Option A, in-repo, inside the package that wraps it.**

## Provenance

Copied from `karos-agents/products/building/branded-shorts/assets/engine/`
at commit `81774a8` (2026-08-03, "branded-shorts: v2 IS the product — v1
archived"). That product folder remains the home of the PLAYBOOK, SKILL.md
and the per-client onboarding material; this directory is the runtime.

Verbatim (byte-identical to the source): `cut_check.py`, `cutaway_check.py`,
`brand_check.py`, `brand_assets_check.py`, `hlg709_N.cube`,
`make_motion_repertoire.template.py`.

## What changed, and why each change exists

Every change below closes a gap between what the TypeScript adapters and the
agent workflow were written to expect and what the engine actually did. The
adapters were written against the scripts' docstrings without the scripts
running anywhere (RFC-06 §5 says so); this is the first time both halves
have run together.

| File | Change | Without it |
| --- | --- | --- |
| `ffbin.py` (new) | Every `ffmpeg`/`ffprobe` call resolves through `KAROS_VIDEO_FFMPEG_BIN` / `KAROS_VIDEO_FFPROBE_BIN`, the same variables `config.ts` already honoured for the TypeScript-side calls. | The two halves of one pipeline could resolve two different binaries; a dev box without ffmpeg on PATH could not run the engine at all. |
| `grade.py` (new) | The `grade: "auto"` per-segment analyzer, written to PLAYBOOK §4b (hard-capped ±8%, no-op on clean footage, never touches hue). | `build_short.py` imported it from a `video-use` checkout that exists in no environment — every run with no locked `video_grade` (the workflow's default) died on `ModuleNotFoundError`. |
| `build_short.py` | Imports `grade`/`ffbin` from its own directory; `VIDEO_USE_HELPERS` is optional. | As above. |
| `build_short.py` | `corrections()` / `caption_default_y()` fall back across the v2 block, the archived v1 block and the job. | A v2-only profile (the only kind that builds since 2026-07-30) hit `KeyError: 'video_captions'` at the first caption. |
| `build_short.py` | `video_grade` accepted as a string or `{filter}`. | The engine expected an object; `BrandProfileSchema` and `video.colorGrade` passed a string. |
| `build_short.py` | `prepare_beats` derives the renderer's `beats[]` from the gate's `cutaways[]` when only the latter is present; a cutaway whose `file` is a still becomes a Ken Burns **plate** (`prepare_plate`); the caption-zone brand ground (`burst_scrim`) is shared by bursts and plates. | The gate read `cutaways`, the renderer read `beats`; a job written for the gate rendered zero cutaways, silently. A plate PNG could not be rendered at all. |
| `build_short.py` | `--until base` stops after `edit/base.mp4`; prints `base: <path>`. | `graphic_qa.py` must gate overlays against the footage timeline, not the finished composite (which already carries the graphic being judged). The workflow renders base once, gates, then composites. |
| `build_short.py` | Job `corrections` (per-run spoken names) merge over the profile's; job `endcard_override` replaces the eyebrow text. | Intake questions 7 and 8 were collected and never applied. |
| `graphic_qa.py` | A static (non-sequence) overlay gets the palette check and a PASS/FAIL line instead of being skipped. | A job whose overlays were all static files passed with no output at all. |
| `render_overlays.py` (new) | Renders every planned overlay's frame sequence from the profile-driven archetype repertoire (`make_motion_repertoire.template.py`'s geometry, the client's colours/fonts/marks) plus the transcript-driven `callout`. | Nothing produced the PNG sequences the plan pointed at; every real run would have failed `graphic_qa.py` with `NO FRAMES FOUND` (P0#2). |
| `self_eval.py` (new) | PLAYBOOK §6 on the finished file: SDR tags + side data, whole-video flash scan, post-encode accent-hue check, duration parity. | `video.selfEvalGate` verified the colour tags only, and said so. |
| `unpack_bundle.py` (new) | Unpacks a client's brand asset bundle (`brand-profile.json` + fonts/marks/library) into the run's work directory, zip-slip safe. | Per-client brand assets had no way onto a Cloud Run instance. |

## Contract with the adapters

The stdout formats the TypeScript wrappers parse (`gate-helpers.ts`,
`render.ts`) are the scripts' own and are pinned by
`packages/tools/karos-video/__tests__/engine-contract.test.ts`, which runs
the real scripts against fixtures whenever `python3` with numpy + Pillow is
present, and fails (not skips) in CI where the deps are installed.

## Runtime requirements

`python3`, `numpy`, `pillow`, `opencv-python-headless<5` (face detection for
`crop: "auto"`; v5 dropped `CascadeClassifier`), and an `ffmpeg`/`ffprobe`
with `lut3d`, `overlay`, `setparams`, `loudnorm`, `libx264`, `aac` — see
`apps/agent-server/Dockerfile`.
