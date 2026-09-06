#!/usr/bin/env python3
"""Graphic QA gate — every motion graphic must pass ALL checks over the
ACTUAL footage it will sit on, before compositing. (Lola: "a system so that
each graphic looks super good.")

    graphic_qa.py --profile <brand-profile.json> --video <final-or-base.mp4> \
                  --job <job.json>

Checks per overlay:
  1. PALETTE  — brand_check on the sequence's key frames (zero red).
  2. VISIBILITY — composite the graphic's densest frame over the real footage
     at its scheduled time/position; the graphic's stroke pixels must differ
     from the background beneath them by >= 28 luma steps on average, and no
     more than 25% of stroke pixels may be "lost" (delta < 15).
  3. CHROMA SAFETY — accent strokes must survive 4:2:0: erode accent mask by
     2px; if fewer than 30% of accent pixels survive, strokes are too thin.
  4. MOTION SANITY — first frame ~empty (entrance exists), last frame holds
     content (no dead end), sequence length covers >= 60% of the window.
Exit 1 on any failure with a per-graphic report and remedy hints.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from brand_check import TOLERANCE, palette_from_profile, check as palette_check
from ffbin import FFMPEG


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def qa_overlay(ov, jdir, video, pal, cs, prof=None):
    prof = prof or {}
    name = Path(ov["file"]).parent.name
    seq_dir = (jdir / ov["file"]).parent
    frames = sorted(seq_dir.glob("*.png"))
    if not frames:
        return [f"{name}: NO FRAMES FOUND"]
    problems = []

    # pick densest frame (most visible pixels) as the representative
    def density(p):
        arr = np.array(Image.open(p).convert("RGBA"))
        return (arr[..., 3] > 24).sum()
    key = max(frames[len(frames) // 2:], key=density, default=frames[-1])
    g = np.array(Image.open(key).convert("RGBA"), dtype=np.int32)

    # 1. palette (reuse brand gate)
    ok, frac, offenders = palette_check(key, pal)
    if not ok:
        problems.append(f"{name}: PALETTE fail ({', '.join(offenders)})")

    # 2. visibility over real footage at scheduled time+position
    t_mid = (ov["start"] + ov["end"]) / 2
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t_mid:.2f}",
                        "-i", str(video), "-frames:v", "1", tf.name],
                       check=True, capture_output=True)
        bg = np.array(Image.open(tf.name).convert("RGB"), dtype=np.int32)
    gh, gw = g.shape[0] * cs, g.shape[1] * cs
    x = (bg.shape[1] - gw) // 2 if ov.get("x", "center") == "center" \
        else int(ov["x"]) * cs
    y = int(ov.get("y", 700)) * cs
    x = max(0, min(x, bg.shape[1] - gw))
    y = max(0, min(y, bg.shape[0] - gh))
    region = bg[y:y + gh, x:x + gw]
    gbig = np.array(Image.open(key).convert("RGBA").resize((gw, gh)),
                    dtype=np.int32)
    # opaque CONTENT pixels only: ink under-rims are support (they exist to
    # protect cores over bright zones) — ink-over-dark is invisible by design
    # and must not count as "lost" content (false positive found 2026-07-13,
    # team->1 graphic over a dark hoodie).
    ink = np.array([int(prof_ink[i:i + 2], 16) for i in (1, 3, 5)]) \
        if (prof_ink := prof.get("color", {}).get("ink")) else np.array([20, 20, 20])
    dist_ink = np.sqrt(((gbig[..., :3] - ink) ** 2).sum(-1))
    stroke = (gbig[..., 3] > 200) & (dist_ink > 60)
    if stroke.sum() > 100:
        delta = np.abs(luma(gbig[..., :3]) - luma(region))[stroke]
        lost = (delta < 15).mean()
        if delta.mean() < 28 or lost > 0.25:
            problems.append(
                f"{name}: VISIBILITY fail (mean contrast {delta.mean():.0f}, "
                f"{lost*100:.0f}% strokes lost over footage) — remedy: heavier "
                f"ink rim, or reposition away from bright zone")

    # 3. chroma safety: accent strokes thick enough to survive 4:2:0.
    # The accent comes from the profile, same as the ink above. The old
    # hardcoded window (r>200, 60<g<160, b<90) only ever matched Karos
    # #FF6B2C, so every other brand scored zero accent pixels and this gate
    # silently passed without checking anything (found 2026-07-27 standing up
    # thepitchbydeel, whose accent is Acai purple #5938B7).
    acc = np.array([int(prof_acc[i:i + 2], 16) for i in (1, 3, 5)]) \
        if (prof_acc := prof.get("color", {}).get("accent")) \
        else np.array([255, 107, 44])
    accent = (g[..., 3] > 128) & \
        (np.sqrt(((g[..., :3] - acc) ** 2).sum(-1)) < TOLERANCE)
    # Erosion is manual on purpose: scipy is optional in the container. The
    # `from scipy import ndimage` that used to sit here was never used by the
    # code below, but being unguarded it crashed the whole gate whenever a
    # graphic had >200 accent pixels and scipy was absent.
    if accent.sum() > 200:
        m = accent
        er = m[2:-2, 2:-2] & m[:-4, 2:-2] & m[4:, 2:-2] & m[2:-2, :-4] & m[2:-2, 4:]
        if er.sum() / m.sum() < 0.30:
            problems.append(f"{name}: CHROMA fail (accent strokes too thin "
                            f"for 4:2:0) — remedy: thicken accent elements")

    # 4. motion sanity
    first = np.array(Image.open(frames[0]).convert("RGBA"))
    if (first[..., 3] > 24).sum() > 0.5 * density(key):
        problems.append(f"{name}: MOTION fail (no entrance — first frame "
                        f"already dense)")
    dur = len(frames) / 30.0
    if dur < 0.6 * (ov["end"] - ov["start"]):
        problems.append(f"{name}: MOTION warn (anim {dur:.1f}s much shorter "
                        f"than window {ov['end']-ov['start']:.1f}s — long "
                        f"freeze on last frame)")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--video", type=Path, required=True,
                    help="footage timeline to test against (base.mp4)")
    ap.add_argument("--job", type=Path, required=True)
    args = ap.parse_args()
    prof = json.loads(args.profile.read_text())
    pal = palette_from_profile(prof)
    job = json.loads(args.job.read_text())
    cs = int(job.get("canvas_scale", 1))
    jdir = args.job.parent
    failed = False
    for ov in job.get("overlays", []):
        if "%" not in str(ov["file"]):
            # A single static PNG has no sequence to judge motion or
            # visibility on, but it is still a graphic on the client's
            # footage: the palette law applies, and it is REPORTED. This loop
            # used to `continue` here, so a job whose overlays were all static
            # files passed with no output at all.
            static = jdir / ov["file"]
            name = static.stem
            if not static.exists():
                failed = True
                print(f"FAIL  {name}: FILE NOT FOUND ({static})")
                continue
            ok, frac, offenders = palette_check(static, pal)
            if ok:
                print(f"PASS  {name}  (static image: palette only, off-palette {frac*100:.2f}%)")
            else:
                failed = True
                print(f"FAIL  {name}: PALETTE fail ({', '.join(offenders)})")
            continue
        problems = qa_overlay(ov, jdir, args.video, pal, cs, prof)
        name = Path(ov["file"]).parent.name
        if problems:
            failed = True
            for p in problems:
                print(f"FAIL  {p}")
        else:
            print(f"PASS  {name}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
