"""Per-segment auto colour correction — the `grade: "auto"` analyzer
(PLAYBOOK §4b: "grading is the SYSTEM'S design skill, never a human question.
Default 'auto' (per-segment analyzer, hard-capped ±8%, 'clean, not graded');
... skin tones first; the grade never shifts the brand accent hue; subtle
restoration over stylization").

    from grade import auto_grade_for_clip
    filt, stats = auto_grade_for_clip(src, start=12.3, duration=4.1)
    # filt == "" (clean footage: no-op) or "eq=brightness=-0.031:contrast=0.97"

WHY THIS FILE EXISTS HERE. `build_short.py` imports this from the open-source
video-use project's `helpers/` directory (`VIDEO_USE_HELPERS`), which was
never checked out anywhere this engine is deployed — so every run whose
profile carried no locked `video_grade` (the workflow's default) would have
died on `ModuleNotFoundError: grade` at the first segment. This is that
analyzer, written to the PLAYBOOK's rules rather than copied, and vendored
next to the script that imports it so the import cannot go missing again.

WHAT IT DOES. Samples three frames from the segment (10% / 50% / 90% in),
downscaled, and measures mean luminance, the 99th-percentile luminance
(highlight clipping) and mean saturation. Then:

  - overexposure  → pull brightness DOWN, at most -0.08;
  - underexposure → lift brightness, at most +0.08 (a dim room is lifted,
                    but "bright airy footage STAYS bright and airy" — the
                    target band is wide and the dead-band below stops a
                    correctly-exposed frame being touched at all);
  - clipped highlights (p99 ≥ 0.985) → contrast down, at most -0.06;
  - flat saturation → +saturation, at most 1.06; garish → down, at most 0.94.

Every knob is hard-capped inside ±8%, exactly PLAYBOOK §4b's ceiling, and a
change smaller than the dead-band is dropped so clean footage produces "" —
an empty filter is the analyzer saying "leave it", never a bug. Hue is never
touched (no `hue=` filter is ever emitted), which is what keeps the brand
accent where the post-encode hue check expects it.

It is deliberately conservative and deterministic: same input frames, same
filter string, every run — a client's grade must not drift between videos.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ffbin import FFMPEG  # noqa: E402

# PLAYBOOK §4b: "hard-capped ±8%".
CAP = 0.08
# Below this a correction is not worth an encode difference — clean footage
# must round-trip to an empty filter, not to eq=brightness=0.004.
DEAD_BAND = 0.010
# Mean-luminance band (0-1, gamma-encoded) treated as correctly exposed.
LUMA_LO, LUMA_HI = 0.30, 0.60
# 99th-percentile luminance at/above which highlights count as clipping.
CLIP_P99 = 0.985
# Mean saturation band treated as natural.
SAT_LO, SAT_HI = 0.10, 0.48
SAMPLE_W = 160


def _sample_frame(src: Path, t: float):
    """One frame at `t` as an HxWx3 float array in [0,1], or None if ffmpeg could not decode it."""
    import numpy as np
    r = subprocess.run(
        [FFMPEG, "-v", "error", "-ss", f"{max(t, 0.0):.3f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"scale={SAMPLE_W}:-2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    )
    if r.returncode != 0 or len(r.stdout) < SAMPLE_W * 3:
        return None
    n = len(r.stdout) // (SAMPLE_W * 3)
    a = np.frombuffer(r.stdout[: n * SAMPLE_W * 3], dtype=np.uint8).reshape(n, SAMPLE_W, 3)
    return a.astype("float32") / 255.0


def measure(frames) -> dict:
    import numpy as np
    if not frames:
        return {"frames": 0}
    a = np.concatenate([f.reshape(-1, 3) for f in frames], axis=0)
    luma = 0.2126 * a[:, 0] + 0.7152 * a[:, 1] + 0.0722 * a[:, 2]
    mx, mn = a.max(axis=1), a.min(axis=1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return {
        "frames": len(frames),
        "luma_mean": float(luma.mean()),
        "luma_p99": float(np.percentile(luma, 99)),
        "sat_mean": float(sat.mean()),
    }


def decide(stats: dict) -> tuple[str, dict]:
    """Pure decision from measured stats — split out so it is unit-testable without ffmpeg."""
    if not stats.get("frames"):
        return "", {**stats, "decision": "no frames decoded — no-op"}
    brightness = 0.0
    contrast = 1.0
    saturation = 1.0
    lm = stats["luma_mean"]
    if lm > LUMA_HI:
        brightness = -min((lm - LUMA_HI) * 0.6, CAP)
    elif lm < LUMA_LO:
        brightness = min((LUMA_LO - lm) * 0.6, CAP)
    if stats["luma_p99"] >= CLIP_P99:
        contrast = 1.0 - min((stats["luma_p99"] - 0.97) * 2.0, 0.06)
    sm = stats["sat_mean"]
    if sm < SAT_LO:
        saturation = 1.0 + min((SAT_LO - sm) * 0.8, 0.06)
    elif sm > SAT_HI:
        saturation = 1.0 - min((sm - SAT_HI) * 0.5, 0.06)

    parts = []
    if abs(brightness) >= DEAD_BAND:
        parts.append(f"brightness={brightness:.3f}")
    if abs(contrast - 1.0) >= DEAD_BAND:
        parts.append(f"contrast={contrast:.3f}")
    if abs(saturation - 1.0) >= DEAD_BAND:
        parts.append(f"saturation={saturation:.3f}")
    filt = ("eq=" + ":".join(parts)) if parts else ""
    return filt, {**stats, "brightness": brightness, "contrast": contrast, "saturation": saturation,
                  "decision": filt or "clean — no-op"}


def auto_grade_for_clip(src, start: float = 0.0, duration: float | None = None) -> tuple[str, dict]:
    src = Path(src)
    dur = float(duration) if duration else 1.0
    times = [start + dur * f for f in (0.10, 0.50, 0.90)]
    frames = [f for f in (_sample_frame(src, t) for t in times) if f is not None]
    return decide(measure(frames))


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Print the auto-grade decision for one span of a source file.")
    ap.add_argument("source", type=Path)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--duration", type=float, default=None)
    a = ap.parse_args()
    filt, stats = auto_grade_for_clip(a.source, a.start, a.duration)
    print(json.dumps({"filter": filt, "stats": stats}, indent=2))
