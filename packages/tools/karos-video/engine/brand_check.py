#!/usr/bin/env python3
"""Brand palette gate (Lola 2026-07-06: "check the company colors and fonts
and if something doesn't align you do it again").

    brand_check.py --profile <brand-profile.json> <image.png> [...]

Every meaningfully-visible pixel of a graphic must sit near one of the
profile's palette colors. Soft glows and gradients that fade the accent into
the ground create dim in-between tones (dim orange reads RED) — those pixels
fail the gate. Exit code 1 on any failure; the pipeline must regenerate.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TOLERANCE = 60        # euclidean RGB distance to nearest palette color
MAX_VIOLATION = 0.015  # more than 1.5% off-palette pixels = FAIL


def hexrgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def palette_from_profile(profile):
    c = profile["color"]
    pal = [c[k] for k in ("background", "foreground", "accent", "ink",
                          "surface_1", "surface_2", "border",
                          "muted_foreground") if k in c]
    return np.array([hexrgb(h) for h in pal], dtype=np.int32)


def check(path, pal):
    im = Image.open(path).convert("RGBA")
    a = np.array(im, dtype=np.int32)
    visible = a[..., 3] > 24
    rgb = a[..., :3][visible]
    if rgb.size == 0:
        return True, 0.0, []
    d = np.linalg.norm(rgb[:, None, :] - pal[None, :, :], axis=2).min(axis=1)
    bad = d > TOLERANCE
    # BRIGHT orange-family pixels (accent anti-aliased against paper /
    # transparency) are legal — vividness is the line: bright stays, dark
    # brick dies below.
    r0, g0, b0 = rgb[:, 0].astype(float), rgb[:, 1].astype(float), rgb[:, 2].astype(float)
    mx0 = np.maximum(np.maximum(r0, g0), b0)
    mn0 = np.minimum(np.minimum(r0, g0), b0)
    hue0 = np.where((mx0 == r0) & (mx0 > mn0),
                    60 * ((g0 - b0) / np.maximum(mx0 - mn0, 1)) % 360, 999)
    vivid_orange = (hue0 >= 13) & (hue0 < 42) & (mx0 >= 190)
    # neutral grays are blends of the brand's own ink/paper/charcoal
    # (rim anti-aliasing) — never a violation; RED stays zero-tolerance below
    sat_all = np.where(mx0 > 0, (mx0 - mn0) / np.maximum(mx0, 1), 0)
    neutral = sat_all < 0.14
    bad = bad & ~vivid_orange & ~neutral
    frac = bad.mean()
    # ZERO-TOLERANCE RED DETECTOR (Lola 2026-07-06): any visibly reddish
    # pixel — red hue, or accent-orange darkened into brick — fails the
    # graphic outright, regardless of how few pixels there are.
    r, g, b = rgb[:, 0].astype(float), rgb[:, 1].astype(float), rgb[:, 2].astype(float)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    # hue for red/orange region: r dominant
    huedeg = np.where((mx == r) & (mx > mn),
                      60 * ((g - b) / np.maximum(mx - mn, 1)) % 360, 999)
    is_reddish = (huedeg < 13) & (sat > 0.30) & (mx > 40)
    is_brick = (huedeg >= 13) & (huedeg < 35) & (sat > 0.35) & (mx < 150) & (mx > 45)
    n_red = int((is_reddish | is_brick).sum())
    if n_red > 0:
        return False, 1.0, [f"RED/BRICK PIXELS: {n_red} (zero tolerance)"]
    offenders = []
    if bad.any():
        bad_px = rgb[bad]
        # cluster crudely by rounding to /32 buckets, report top 3
        keys, counts = np.unique(bad_px // 32 * 32 + 16, axis=0,
                                 return_counts=True)
        for i in np.argsort(-counts)[:3]:
            r, g, b = keys[i]
            offenders.append(f"#{r:02X}{g:02X}{b:02X} x{counts[i]}")
    return frac <= MAX_VIOLATION, frac, offenders


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("images", nargs="+", type=Path)
    args = ap.parse_args()
    pal = palette_from_profile(json.loads(args.profile.read_text()))
    failed = False
    for img in args.images:
        ok, frac, offenders = check(img, pal)
        status = "PASS" if ok else "FAIL"
        extra = f"  offenders: {', '.join(offenders)}" if offenders else ""
        print(f"{status}  {img.name}  off-palette {frac*100:.2f}%{extra}")
        failed |= not ok
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
