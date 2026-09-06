#!/usr/bin/env python3
"""Self-eval gate on the FINISHED file — PLAYBOOK §6, before anyone sees it.

    self_eval.py --video <final.mp4> [--profile <brand-profile.json>] [--job <job.json>]

`video.selfEvalGate` used to verify one thing: the SDR bitstream tags. It said
so honestly in its own evidence ("saturation-sanity, whole-video flash-scan,
and caption-legibility checks ... are not yet implemented"). This closes the
whole-video checks the PLAYBOOK lists:

  1. SDR TAGS + SIDE DATA — colour space/primaries/transfer bt709, range tv,
     no HDR side data left on the stream (the "orange renders as red" saga;
     the same check build_short.py runs on its own output, repeated here on
     purpose: this gate must not trust the builder's word).
  2. FLASH SCAN — per-frame mean luma over the whole file; a spike that
     REVERTS within 3 frames is a stray footage frame or a dropped overlay
     (PLAYBOOK §6: "luma spike reverting within 3 frames = FAIL"). Hard cuts
     between segments, cutaway entries and the endcard cut all PERSIST, so
     they never trip it; burst stills hold ≥ 0.15s (≥ 4 frames at 30fps) by
     cutaway_check.py's PACING law, so they don't either.
  3. ACCENT HUE (needs --profile and --job) — at every overlay's midpoint,
     the pixels near the brand accent must still sit at the accent's hue
     (± ACCENT_HUE_TOL). A shifted accent on the finished file is the encode
     or the grade turning brand orange into red, whatever the PNGs looked
     like ("post-encode accent-hue check", PLAYBOOK §4c/§6).
  4. DURATION (needs --job and --profile) — the file runs the kept segments
     plus the endcard, within tolerance. A silently dropped segment or a
     missing endcard is the cheapest thing to catch and the worst to ship.

Caption legibility is NOT here: build_short.py already measures it twice on
the real frames (pre-composite and post-render, `verify_captions_final`) and
fails its own exit on an emphasis-layer miss; duplicating that here would be
a third copy of one rule.

Output is the bullet contract the other gates use (`toGateVerdictFromBullets`):
exit 0 with `SELF-EVAL GATE: PASS (...)`, or exit 1 with `SELF-EVAL GATE: FAIL (n)`
and one `  - ` reason per failure. `  WARN  ...` lines are advisories.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from ffbin import FFMPEG, FFPROBE  # noqa: E402
from brand_check import TOLERANCE, hexrgb  # noqa: E402

EXPECTED_TAGS = {"color_space": "bt709", "color_primaries": "bt709", "color_transfer": "bt709", "color_range": "tv"}
FLASH_DELTA = 0.22          # mean-luma jump (0-1) that counts as a spike
FLASH_REVERT_FRAMES = 3     # ...and reverts within this many frames
FLASH_REVERT_TOL = 0.06
SCAN_W, SCAN_H = 64, 36     # luma scan resolution; aspect is irrelevant to a mean
ACCENT_HUE_TOL = 8.0        # degrees
ACCENT_MIN_PIXELS = 200
ACCENT_SAT_MIN = 0.30
DURATION_TOL = 0.5          # seconds


def probe_json(video: Path) -> dict:
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=color_space,color_transfer,color_primaries,color_range,r_frame_rate:format=duration",
                        "-of", "json", str(video)], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {video}: {r.stderr.strip()[-500:]}")
    return json.loads(r.stdout or "{}")


def side_data(video: Path) -> str:
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data_list",
                        "-of", "csv=p=0", str(video)], capture_output=True, text=True)
    return r.stdout.strip()


def luma_series(video: Path, fps: float) -> np.ndarray:
    r = subprocess.run([FFMPEG, "-v", "error", "-i", str(video), "-vf", f"fps={fps:g},scale={SCAN_W}:{SCAN_H},format=gray",
                        "-f", "rawvideo", "-"], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg luma scan failed: {r.stderr.decode(errors='replace').strip()[-500:]}")
    n = len(r.stdout) // (SCAN_W * SCAN_H)
    if n == 0:
        return np.zeros(0, dtype="float32")
    a = np.frombuffer(r.stdout[: n * SCAN_W * SCAN_H], dtype=np.uint8).reshape(n, SCAN_H * SCAN_W)
    return a.mean(axis=1).astype("float32") / 255.0


def find_flashes(means: np.ndarray, fps: float) -> list[float]:
    """Pure: indices where luma jumps by ≥ FLASH_DELTA and returns to the pre-jump level within FLASH_REVERT_FRAMES."""
    out = []
    n = len(means)
    for i in range(1, n):
        before = means[i - 1]
        if abs(means[i] - before) < FLASH_DELTA:
            continue
        window = means[i + 1: i + 1 + FLASH_REVERT_FRAMES]
        if len(window) and np.any(np.abs(window - before) <= FLASH_REVERT_TOL):
            out.append(i / fps)
    return out


def frame_at(video: Path, t: float, width: int = 540):
    r = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{max(t, 0):.3f}", "-i", str(video), "-frames:v", "1",
                        "-vf", f"scale={width}:-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    if r.returncode != 0 or len(r.stdout) < width * 3:
        return None
    h = len(r.stdout) // (width * 3)
    return np.frombuffer(r.stdout[: h * width * 3], dtype=np.uint8).reshape(h, width, 3).astype("float32")


def hue_deg(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, (60 * ((g - b) / d)) % 360,
                 np.where(mx == g, 60 * ((b - r) / d) + 120, 60 * ((r - g) / d) + 240))
    return h


def accent_drift(frame: np.ndarray, accent: tuple) -> tuple[int, float | None]:
    """(accent-like pixel count, circular mean hue delta from the accent in degrees or None)."""
    acc = np.array(accent, dtype="float32")
    px = frame.reshape(-1, 3)
    dist = np.sqrt(((px - acc) ** 2).sum(axis=1))
    mx = px.max(axis=1)
    mn = px.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    sel = (dist < TOLERANCE) & (sat > ACCENT_SAT_MIN)
    n = int(sel.sum())
    if n < ACCENT_MIN_PIXELS:
        return n, None
    h = np.radians(hue_deg(px[sel]))
    mean_h = np.degrees(np.arctan2(np.sin(h).mean(), np.cos(h).mean())) % 360
    target = float(hue_deg(acc[None, :])[0])
    delta = abs((mean_h - target + 180) % 360 - 180)
    return n, float(delta)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--profile", type=Path)
    ap.add_argument("--job", type=Path)
    a = ap.parse_args()

    failures, warns, notes = [], [], []
    try:
        info = probe_json(a.video)
    except (RuntimeError, json.JSONDecodeError) as e:
        sys.exit(f"FAILED: {e}")
    stream = (info.get("streams") or [{}])[0]
    duration = float((info.get("format") or {}).get("duration") or 0)

    # 1. SDR tags + side data
    bad = [f"{k}={stream.get(k) or '(unset)'} (expected {v})" for k, v in EXPECTED_TAGS.items() if stream.get(k) != v]
    if bad:
        failures.append("SDR TAGS: " + "; ".join(bad) + " — a player may render tonemapped orange as HDR red")
    sd = side_data(a.video)
    if sd:
        failures.append(f"SIDE DATA: HDR side data still present on the output stream: {sd}")
    notes.append("sdr tags " + ("ok" if not bad and not sd else "BAD"))

    # frame rate for the scan
    fps = 30.0
    rf = stream.get("r_frame_rate") or ""
    if "/" in rf:
        num, den = rf.split("/")
        if float(den) > 0:
            fps = float(num) / float(den)

    # 2. flash scan
    try:
        means = luma_series(a.video, fps)
        flashes = find_flashes(means, fps)
        if flashes:
            shown = ", ".join(f"{t:.2f}s" for t in flashes[:6])
            failures.append(f"FLASH: {len(flashes)} single-frame luma spike(s) that revert within {FLASH_REVERT_FRAMES} frames "
                            f"at {shown} — a stray footage frame or a dropped overlay frame")
        notes.append(f"flash scan {len(means)} frames, {len(flashes)} spikes")
    except RuntimeError as e:
        failures.append(f"FLASH: scan could not run: {e}")

    profile = json.loads(a.profile.read_text()) if a.profile else None
    job = json.loads(a.job.read_text()) if a.job else None

    # 3. accent hue at every overlay midpoint
    if profile and job:
        accent = hexrgb(profile["color"]["accent"])
        checked = 0
        for ov in job.get("overlays", []):
            t_mid = (float(ov["start"]) + float(ov["end"])) / 2
            frame = frame_at(a.video, t_mid)
            if frame is None:
                warns.append(f"accent check: could not decode a frame at {t_mid:.2f}s")
                continue
            n, delta = accent_drift(frame, accent)
            checked += 1
            if delta is None:
                warns.append(f"accent check at {t_mid:.2f}s: only {n} accent-like pixels — graphic {Path(str(ov['file'])).parent.name} "
                             f"may not use the accent; nothing to measure")
            elif delta > ACCENT_HUE_TOL:
                failures.append(f"ACCENT HUE: at {t_mid:.2f}s the accent-like pixels sit {delta:.1f} deg off the brand accent "
                                f"(tolerance {ACCENT_HUE_TOL:g} deg) — the encode or grade is shifting the brand colour")
        notes.append(f"accent hue checked on {checked} overlay frame(s)")

    # 4. duration parity
    if profile and job and job.get("segments"):
        kept = sum(float(e) - float(s) for s, e in job["segments"])
        endcard = float((profile.get("endcard") or {}).get("duration_s", 2.0))
        expected = kept + endcard
        if abs(duration - expected) > DURATION_TOL:
            failures.append(f"DURATION: file runs {duration:.2f}s, expected {expected:.2f}s "
                            f"({kept:.2f}s kept + {endcard:.1f}s endcard) — a segment or the endcard is missing or doubled")
        notes.append(f"duration {duration:.2f}s vs expected {expected:.2f}s")

    for n in notes:
        print(f"  {n}")
    for w in warns:
        print(f"  WARN  {w}")
    if failures:
        print(f"SELF-EVAL GATE: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print(f"SELF-EVAL GATE: PASS ({duration:.2f}s, {'; '.join(notes)})")


if __name__ == "__main__":
    main()
