#!/usr/bin/env python3
"""Turn a client's logo file into the alpha-masked brand MARK the engine composites.

`build_short.py`'s endcard and `render_overlays.py`'s `logo` archetype both paste a
solid tint through the mark's ALPHA channel. A logo exported as a screenshot or a
flattened PNG/JPEG has no alpha, so the whole rectangle would render as a white
block. This script derives the mask when the file carries none: the background
colour is estimated from the four corners, every pixel's distance from it becomes
its opacity, and the result is cropped to the visible content with padding.

Usage:
  derive_mark.py --source logo.png --out mark.png            # from a logo file
  derive_mark.py --text K --font Inter-700.ttf --out mark.png # a glyph mark, when no logo exists

Prints `MARK: PASS <w>x<h> <had_alpha|derived_alpha|glyph>` on success; exits 1 with
`- ` bullets on failure, the same contract the other gate-shaped scripts use.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MAX_SIDE = 1024
PAD = 24


def _fail(*bullets: str) -> None:
    for b in bullets:
        print(f"- {b}")
    sys.exit(1)


def _crop_and_fit(rgba: Image.Image) -> Image.Image:
    a = np.array(rgba.getchannel("A"))
    ys, xs = np.where(a > 8)
    if len(xs) == 0:
        _fail("the mark has no visible pixels after masking")
    x0, x1 = max(int(xs.min()) - PAD, 0), min(int(xs.max()) + PAD + 1, rgba.width)
    y0, y1 = max(int(ys.min()) - PAD, 0), min(int(ys.max()) + PAD + 1, rgba.height)
    out = rgba.crop((x0, y0, x1, y1))
    longest = max(out.size)
    if longest > MAX_SIDE:
        scale = MAX_SIDE / longest
        out = out.resize((max(1, int(out.width * scale)), max(1, int(out.height * scale))), Image.LANCZOS)
    return out


def _derive_alpha(img: Image.Image) -> Image.Image:
    rgb = np.array(img.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape
    k = max(2, min(h, w) // 20)
    corners = np.concatenate(
        [rgb[:k, :k].reshape(-1, 3), rgb[:k, -k:].reshape(-1, 3), rgb[-k:, :k].reshape(-1, 3), rgb[-k:, -k:].reshape(-1, 3)]
    )
    background = np.median(corners, axis=0)
    dist = np.sqrt(((rgb - background) ** 2).sum(axis=2))
    # Soft ramp: fully transparent within 24 of the background, fully opaque past 96.
    alpha = np.clip((dist - 24.0) / 72.0, 0.0, 1.0)
    out = np.dstack([rgb, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def _from_source(source: Path) -> tuple[Image.Image, str]:
    try:
        img = Image.open(source)
        img.load()
    except Exception as exc:  # noqa: BLE001 - reported as a bullet, never a traceback
        _fail(f"{source}: will not decode: {type(exc).__name__}: {exc}")
    if "A" in img.mode:
        alpha = np.array(img.convert("RGBA").getchannel("A"))
        if alpha.min() < 250:
            return img.convert("RGBA"), "had_alpha"
    return _derive_alpha(img), "derived_alpha"


def _from_text(text: str, font_path: Path) -> tuple[Image.Image, str]:
    try:
        font = ImageFont.truetype(str(font_path), 512)
    except Exception as exc:  # noqa: BLE001
        _fail(f"{font_path}: font will not load: {type(exc).__name__}: {exc}")
    canvas = Image.new("RGBA", (1400, 900), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x = (canvas.width - (right - left)) // 2 - left
    y = (canvas.height - (bottom - top)) // 2 - top
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return canvas, "glyph"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", type=Path, help="the client's logo file (PNG/JPEG/WebP)")
    ap.add_argument("--text", help="glyph fallback: the letters to render when there is no logo")
    ap.add_argument("--font", type=Path, help="font for --text")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    if args.source is not None:
        img, how = _from_source(args.source)
    elif args.text and args.font is not None:
        img, how = _from_text(args.text, args.font)
    else:
        _fail("give either --source <logo> or --text <letters> --font <ttf>")

    out = _crop_and_fit(img)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out, "PNG")
    print(f"MARK: PASS {out.width}x{out.height} {how}")


if __name__ == "__main__":
    main()
