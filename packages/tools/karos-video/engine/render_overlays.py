#!/usr/bin/env python3
"""Render every planned motion-graphic overlay of a job to its PNG sequence.

    render_overlays.py --profile <brand-profile.json> --job <job.json> [--fps 30]

The graphics plan (`job.overlays[]`, written by the agent workflow) names an
ARCHETYPE per overlay and the sequence path `build_short.py` composites and
`graphic_qa.py` gates (`.../anim-<name>-<i>/%04d.png`). Until this script
existed nothing produced those frames: the per-client
`make_motion_repertoire.py` was a hand-run onboarding script, so every real
run would have failed `graphic_qa.py` with NO FRAMES FOUND however good the
plan was (RFC-06 §5, P0#2). This is the repertoire, made profile-driven:

  - the GEOMETRY of each archetype is `make_motion_repertoire.template.py`'s,
    kept verbatim where it could be (mark pop, growth chart, clock, browser
    wireframe, sign-off check, platform row) plus one transcript-driven
    archetype, `callout` (the payoff word in the client's display face);
  - the BRAND — neutral, accent, ink, display font, brand mark, platform
    icons — is read from the profile, never from constants in this file. No
    client's values are a default for another (SKILL.md's brand rule).

Shared production law (graphics-language.template.md, enforced downstream by
brand_check.py / graphic_qa.py): transparent canvas, no background boxes,
neutral strokes over an ink under-rim, accent strokes over a neutral rim,
alpha-only glow in pure accent hex, cubic/back easing never linear, 2×
supersample then PREMULTIPLIED downscale (no edge colour bleed — the
straight-alpha average of accent-over-transparent is a dim brick tone, which
is exactly the pixel the zero-tolerance red detector kills).

Motion contract (graphic_qa.py's MOTION checks): frame 0 is empty (an
entrance exists), the sequence covers the WHOLE window (never a long freeze),
and the last frame holds content. Every archetype here starts from nothing
and holds its final state, and the frame count is derived from the window.

Overlay fields read: `file` (the `%0Nd.png` pattern), `start`/`end`,
`archetype` (falls back to the `anim-<slug>-<i>` directory name), optional
`label` (text for the clock/callout archetypes). Prints one
`rendered <dir>: <n> frames (<archetype>)` line per overlay and a final
`OVERLAYS: PASS (n)`; exit 1 with `- ` bullets when an archetype has no
renderer or lacks an asset it needs (a configuration gap, never silent).
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

S = 2            # supersample factor; premultiplied block-mean downscale below
DEFAULT_FPS = 30
MIN_FRAMES = 12


def hexrgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_back(t, s=1.9):
    t = min(max(t, 0.0), 1.0) - 1
    return 1 + t * t * ((s + 1) * t + s)


class Brand:
    """Everything an archetype needs from the client — resolved once per run, from the profile alone."""

    def __init__(self, profile: dict, pdir: Path):
        c = profile["color"]
        self.neutral = hexrgb(c["foreground"])
        self.accent = hexrgb(c["accent"])
        self.ink = hexrgb(c.get("ink", "#141414"))
        v2 = profile.get("video_captions_v2") or {}
        typo = profile.get("typography") or {}
        font = (v2.get("emphasis") or {}).get("font_file") or (typo.get("display") or {}).get("file")
        self.display_font = (pdir / font) if font else None
        mark = (profile.get("endcard") or {}).get("logo_file")
        self.mark = (pdir / mark) if mark else None
        icons = profile.get("platform_icons") or {}
        icon_paths = icons.values() if isinstance(icons, dict) else icons
        self.icons = [pdir / p for p in icon_paths]
        self._fonts: dict[int, ImageFont.FreeTypeFont] = {}
        self._mark_rimmed = None
        self._icons_rimmed = None

    def font(self, px: int) -> ImageFont.FreeTypeFont:
        if self.display_font is None:
            raise MissingAsset("display font (video_captions_v2.emphasis.font_file or typography.display.file)")
        if px not in self._fonts:
            self._fonts[px] = ImageFont.truetype(str(self.display_font), px)
        return self._fonts[px]

    def rimmed(self, src: Image.Image, spread: int) -> Image.Image:
        """Neutral glyph over an 8-direction ink under-rim — the template's own visibility device for marks and icons."""
        a = src.split()[3]
        under = Image.new("RGBA", src.size, self.ink + (255,))
        solid = Image.new("RGBA", src.size, self.neutral + (255,))
        out = Image.new("RGBA", (src.size[0] + 2 * (spread + 2), src.size[1] + 2 * (spread + 2)), (0, 0, 0, 0))
        o = spread + 2
        for dx in (-spread, 0, spread):
            for dy in (-spread, 0, spread):
                out.paste(under, (o + dx, o + dy), a)
        out.paste(solid, (o, o), a)
        return out

    def mark_rimmed(self) -> Image.Image:
        if self.mark is None:
            raise MissingAsset("brand mark (endcard.logo_file)")
        if self._mark_rimmed is None:
            self._mark_rimmed = self.rimmed(Image.open(self.mark).convert("RGBA"), 6)
        return self._mark_rimmed

    def icons_rimmed(self) -> list[Image.Image]:
        if not self.icons:
            raise MissingAsset("platform icons (profile.platform_icons)")
        if self._icons_rimmed is None:
            self._icons_rimmed = [self.rimmed(Image.open(p).convert("RGBA"), 5) for p in self.icons]
        return self._icons_rimmed


class MissingAsset(Exception):
    pass


def glow_layer(b: Brand, n: int, alpha_peak: int) -> Image.Image:
    n = max(n, 2)
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.sqrt((xx - n / 2) ** 2 + (yy - n / 2) ** 2) / (n / 2)
    a = (np.clip(1 - d, 0, 1) ** 1.8 * alpha_peak).astype(np.uint8)
    layer = np.zeros((n, n, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = b.accent
    layer[..., 3] = a
    return Image.fromarray(layer)


def premult_downscale(img: Image.Image) -> Image.Image:
    """S× premultiplied area downscale. Pure numpy (no cv2): the source is an exact
    S× supersample, so a block mean IS the area filter."""
    a = np.asarray(img, dtype=np.float32)
    alpha = a[..., 3:4] / 255.0
    pm = np.concatenate([a[..., :3] * alpha, alpha], axis=2)
    H, W = pm.shape[0] // S, pm.shape[1] // S
    pm = pm[: H * S, : W * S].reshape(H, S, W, S, 4).mean(axis=(1, 3))
    al = pm[..., 3:4]
    rgb = np.where(al > 1e-4, pm[..., :3] / np.maximum(al, 1e-4), 0)
    out = np.concatenate([np.clip(rgb, 0, 255), np.clip(al * 255, 0, 255)], axis=2).astype(np.uint8)
    return Image.fromarray(out)


def rim_line(d: ImageDraw.ImageDraw, pts, w_core: int, core, rim):
    d.line(pts, fill=rim + (255,), width=w_core + 6 * S)
    d.line(pts, fill=core + (255,), width=w_core)


# ── archetypes ──────────────────────────────────────────────────────────────
# Every renderer: draw(b, img, t, size, label) with t in seconds from the
# overlay's start. Geometry is the repertoire template's; colours are b's.

def logo_pop(b, img, t, size, label):
    head = b.mark_rimmed()
    pop = ease_back(min(t / 0.55, 1.0))
    if pop <= 0.01:
        return
    cx, cy = size * S // 2, int(size * S * 0.42)
    if t > 0.5:
        pulse = 0.7 + 0.3 * math.sin((t - 0.5) * 5)
        g = int(46 * S)
        img.alpha_composite(glow_layer(b, 2 * g, int(200 * pulse)), (cx - g, int(size * S * 0.78) - g))
    d = ImageDraw.Draw(img)
    if t > 0.5:
        r = 18 * S
        dy = int(size * S * 0.78)
        d.polygon([(cx, dy - r), (cx + r, dy), (cx, dy + r), (cx - r, dy)],
                  fill=b.accent + (255,), outline=b.neutral + (255,), width=2 * S)
    w = int(300 * S * pop)
    if w > 4:
        hh = int(head.height * w / head.width)
        img.alpha_composite(head.resize((w, hh)), (cx - w // 2, cy - hh // 2))


def chart(b, img, t, size, label):
    d = ImageDraw.Draw(img)
    fade = ease_out(min(t / 0.4, 1.0))
    ax = int(255 * fade)
    x0, y0 = int(size * S * 0.16), int(size * S * 0.82)
    x1, y1 = int(size * S * 0.88), int(size * S * 0.18)
    if ax > 0:
        d.line([(x0, int(size * S * 0.14)), (x0, y0)], fill=b.neutral + (ax,), width=3 * S)
        d.line([(x0, y0), (int(size * S * 0.9), y0)], fill=b.neutral + (ax,), width=3 * S)
    pts = [(x0 + 8 * S, y0 - 14 * S), (int(size * S * 0.36), int(size * S * 0.62)),
           (int(size * S * 0.58), int(size * S * 0.48)), (x1, y1)]
    prog = ease_out(max(0.0, min((t - 0.35) / 0.9, 1.0)))
    if prog > 0:
        total = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        target = total * prog
        acc, drawn = 0, [pts[0]]
        for i in range(len(pts) - 1):
            seg = math.dist(pts[i], pts[i + 1])
            if acc + seg <= target:
                drawn.append(pts[i + 1]); acc += seg
            else:
                r = (target - acc) / seg
                drawn.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r))
                break
        tip = drawn[-1]
        if prog >= 0.999 and t > 1.35:
            pulse = 0.7 + 0.3 * math.sin((t - 1.35) * 5)
            g = int(44 * S)
            img.alpha_composite(glow_layer(b, 2 * g, int(210 * pulse)), (int(tip[0]) - g, int(tip[1]) - g))
            d = ImageDraw.Draw(img)
        rim_line(d, drawn, 9 * S, b.accent, b.neutral)
        r0 = 13 * S
        d.ellipse([tip[0] - r0 - 3 * S, tip[1] - r0 - 3 * S, tip[0] + r0 + 3 * S, tip[1] + r0 + 3 * S], fill=b.neutral + (255,))
        d.ellipse([tip[0] - r0, tip[1] - r0, tip[0] + r0, tip[1] + r0], fill=b.accent + (255,))


def _rimmed_text(d, xy, text, font, b, alpha=255, rim=2):
    x, y = xy
    for dx, dy in ((-rim * S, 0), (rim * S, 0), (0, -rim * S), (0, rim * S)):
        d.text((x + dx, y + dy), text, font=font, fill=b.ink + (alpha,))
    d.text((x, y), text, font=font, fill=b.neutral + (alpha,))


def clock(b, img, t, size, label):
    d = ImageDraw.Draw(img)
    cx, cy, R = int(size * S * 0.38), int(size * S * 0.5), int(size * S * 0.26)
    prog = ease_out(min(t / 0.5, 1.0))
    box = [cx - R, cy - R, cx + R, cy + R]
    if prog > 0.01:
        d.arc(box, start=-90, end=-90 + 360 * prog, fill=b.ink + (255,), width=11 * S)
        d.arc(box, start=-90, end=-90 + 360 * prog, fill=b.neutral + (255,), width=6 * S)
    if prog >= 0.999:
        for ang in range(0, 360, 30):
            a = math.radians(ang)
            d.line([(cx + (R - 10 * S) * math.cos(a), cy + (R - 10 * S) * math.sin(a)),
                    (cx + (R - 16 * S) * math.cos(a), cy + (R - 16 * S) * math.sin(a))], fill=b.neutral + (255,), width=2 * S)
    if t > 0.5:
        ang = math.radians(-90 + (t - 0.5) * 240)
        x2, y2 = cx + R * 0.62 * math.cos(ang), cy + R * 0.62 * math.sin(ang)
        rim_line(d, [(cx, cy), (x2, y2)], 8 * S, b.accent, b.neutral)
        d.ellipse([cx - 8 * S, cy - 8 * S, cx + 8 * S, cy + 8 * S], fill=b.accent + (255,))
    if t > 0.8:
        fade = int(255 * ease_out(min((t - 0.8) / 0.4, 1.0)))
        text = (label or "24/7").strip()[:8]
        f = b.font(64 * S)
        _rimmed_text(d, (int(size * S * 0.60), cy - 32 * S), text, f, b, alpha=fade)


def browser(b, img, t, size, label):
    d = ImageDraw.Draw(img)
    x0, y0 = int(size * S * 0.14), int(size * S * 0.2)
    x1, y1 = int(size * S * 0.86), int(size * S * 0.8)
    p1 = ease_out(min(t / 0.5, 1.0))
    per = 2 * ((x1 - x0) + (y1 - y0))
    target = per * p1
    pts = [(x0, y0)]
    edges = [((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))]
    acc = 0
    for a, bb in edges:
        seg = math.dist(a, bb)
        if acc + seg <= target:
            pts.append(bb); acc += seg
        else:
            r = (target - acc) / seg if seg else 0
            pts.append((a[0] + (bb[0] - a[0]) * r, a[1] + (bb[1] - a[1]) * r))
            break
    if len(pts) > 1 and target > 1:
        d.line(pts, fill=b.ink + (255,), width=10 * S)
        d.line(pts, fill=b.neutral + (255,), width=5 * S)
    if p1 >= 0.999:
        d.line([(x0, y0 + 34 * S), (x1, y0 + 34 * S)], fill=b.neutral + (255,), width=3 * S)
        for i in range(3):
            xx = x0 + 12 * S + i * 16 * S
            d.ellipse([xx, y0 + 12 * S, xx + 9 * S, y0 + 21 * S], outline=b.neutral + (255,), width=2 * S)
    if t > 0.7:
        f2 = ease_out(min((t - 0.7) / 0.4, 1.0))
        d.rectangle([x0 + 20 * S, y0 + 54 * S, x1 - 20 * S, y0 + 96 * S], outline=b.neutral + (int(255 * f2),), width=3 * S)
    if t > 1.0:
        f3 = ease_out(min((t - 1.0) / 0.5, 1.0))
        bw = int((x1 - x0 - 56 * S) * 0.45 * f3)
        if bw > 2:
            d.rectangle([x0 + 20 * S, y0 + 112 * S, x0 + 20 * S + bw, y1 - 20 * S], fill=b.accent + (255,), outline=b.neutral + (255,), width=2 * S)


def signoff(b, img, t, size, label):
    d = ImageDraw.Draw(img)
    cx, cy, R = size * S // 2, size * S // 2, int(size * S * 0.3)
    prog = ease_out(min(t / 0.5, 1.0))
    box = [cx - R, cy - R, cx + R, cy + R]
    if prog > 0.01:
        d.arc(box, start=-90, end=-90 + 360 * prog, fill=b.ink + (255,), width=11 * S)
        d.arc(box, start=-90, end=-90 + 360 * prog, fill=b.neutral + (255,), width=6 * S)
    if t > 0.5:
        p2 = ease_out(min((t - 0.5) / 0.45, 1.0))
        a = (cx - R * 0.42, cy + R * 0.05)
        bb = (cx - R * 0.1, cy + R * 0.38)
        c = (cx + R * 0.48, cy - R * 0.32)
        seg1, seg2 = math.dist(a, bb), math.dist(bb, c)
        target = (seg1 + seg2) * p2
        if target <= seg1:
            r = target / seg1
            pts = [a, (a[0] + (bb[0] - a[0]) * r, a[1] + (bb[1] - a[1]) * r)]
        else:
            r = (target - seg1) / seg2
            pts = [a, bb, (bb[0] + (c[0] - bb[0]) * r, bb[1] + (c[1] - bb[1]) * r)]
        rim_line(d, pts, 11 * S, b.accent, b.neutral)
    if t > 1.1:
        pulse = 0.7 + 0.3 * math.sin((t - 1.1) * 5)
        g = int(40 * S)
        img.alpha_composite(glow_layer(b, 2 * g, int(140 * pulse)), (cx + int(R * 0.48) - g, cy - int(R * 0.32) - g))


def platforms(b, img, t, size, label):
    icons = b.icons_rimmed()
    n = len(icons)
    total_w = size * S
    iw = int(size * S * 0.19)
    gap = int(size * S * 0.06)
    row_w = n * iw + (n - 1) * gap
    x = (total_w - row_w) // 2
    cy = size * S // 2
    for i, ic in enumerate(icons):
        t0 = 0.15 + i * 0.28
        pop = ease_back(max(0.0, min((t - t0) / 0.4, 1.0)))
        if pop > 0.02:
            w = max(int(iw * pop), 2)
            hh = int(ic.height * w / ic.width)
            img.alpha_composite(ic.resize((w, hh)), (x + i * (iw + gap) + (iw - w) // 2, cy - hh // 2))
    if t > 0.15 + n * 0.28 + 0.1:
        p = ease_out(min((t - (0.15 + n * 0.28 + 0.1)) / 0.4, 1.0))
        y = cy + iw
        rim_line(ImageDraw.Draw(img), [(x, y), (x + row_w * p, y)], 9 * S, b.accent, b.neutral)


def callout(b, img, t, size, label):
    """The payoff word(s), set in the client's display face: pops in with
    overshoot, then an accent rule sweeps beneath and breathes. Transcript-
    driven by construction — there is nothing to draw without `label`."""
    text = (label or "").strip()
    if not text:
        raise MissingAsset("a `label` — the callout archetype renders the payoff word and has nothing to draw without one")
    d = ImageDraw.Draw(img)
    W = size * S
    px = 72 * S
    f = b.font(px)
    while f.getlength(text) > W * 0.86 and px > 28 * S:
        px -= 4 * S
        f = b.font(px)
    pop = ease_back(min(t / 0.45, 1.0))
    if pop <= 0.01:
        return
    tw = f.getlength(text)
    asc, desc = f.getmetrics()
    x = (W - tw) / 2
    y = W * 0.42 - asc / 2
    # overshoot via scale: render at pop-scaled size on a scratch layer
    scratch = Image.new("RGBA", img.size, (0, 0, 0, 0))
    _rimmed_text(ImageDraw.Draw(scratch), (x, y), text, f, b)
    if abs(pop - 1.0) > 0.005:
        cw, ch = int(W * pop), int(W * pop)
        if cw > 2:
            scaled = scratch.resize((cw, ch), Image.BICUBIC)
            img.alpha_composite(scaled, ((W - cw) // 2, (W - ch) // 2))
    else:
        img.alpha_composite(scratch)
    if t > 0.45:
        p = ease_out(min((t - 0.45) / 0.4, 1.0))
        yy = int(y + asc + desc + 10 * S)
        x0 = (W - tw) / 2
        rim_line(d, [(x0, yy), (x0 + tw * p, yy)], 8 * S, b.accent, b.neutral)
        if p >= 0.999 and t > 1.0:
            pulse = 0.7 + 0.3 * math.sin((t - 1.0) * 5)
            g = int(30 * S)
            img.alpha_composite(glow_layer(b, 2 * g, int(120 * pulse)), (int(x0 + tw) - g, yy - g))


ARCHETYPES = {
    "logo": (logo_pop, 480, ("logo", "logo pop", "mark pop", "mark", "brand mark")),
    "chart": (chart, 480, ("chart", "growth chart", "growth", "line chart", "graph", "trend")),
    "clock": (clock, 480, ("clock", "clock 24 7", "24 7", "time", "always on", "round the clock")),
    "browser": (browser, 480, ("browser", "browser wireframe", "wireframe", "website", "web page", "landing page")),
    "signoff": (signoff, 480, ("signoff", "sign off", "sign off check", "check", "checkmark", "approved", "done")),
    "platforms": (platforms, 520, ("platforms", "platform row", "platform icons", "channels", "social platforms")),
    "callout": (callout, 480, ("callout", "type label", "label", "word", "keyword", "headline", "payoff word")),
}


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def resolve_archetype(*candidates: str | None):
    for cand in candidates:
        if not cand:
            continue
        n = norm(cand)
        for key, (_, _, aliases) in ARCHETYPES.items():
            if n == key or n in aliases:
                return key
    return None


def dir_slug(seq_dir: Path) -> str | None:
    m = re.match(r"^anim-(.+?)(?:-\d+)?$", seq_dir.name)
    return m.group(1).replace("_", " ") if m else None


def render_overlay(b: Brand, ov: dict, jdir: Path, fps: int) -> tuple[str, int, str]:
    pattern = Path(str(ov["file"]))
    if "%" not in pattern.name:
        raise ValueError(f"{pattern.name}: not a frame-sequence pattern (expected e.g. %04d.png)")
    seq_dir = (jdir / pattern).parent
    key = resolve_archetype(ov.get("archetype"), dir_slug(seq_dir))
    if key is None:
        raise ValueError(f"{seq_dir.name}: no renderer for archetype {ov.get('archetype') or dir_slug(seq_dir)!r} — "
                         f"known: {', '.join(ARCHETYPES)}")
    draw, size, _ = ARCHETYPES[key]
    window = float(ov["end"]) - float(ov["start"])
    n = max(int(math.ceil(window * fps)), MIN_FRAMES)
    seq_dir.mkdir(parents=True, exist_ok=True)
    for stale in seq_dir.glob("*.png"):
        stale.unlink()
    label = ov.get("label")
    for f in range(n):
        img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
        draw(b, img, f / fps, size, label)
        premult_downscale(img).save(seq_dir / (pattern.name % f))
    return seq_dir.name, n, key


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--job", type=Path, required=True)
    ap.add_argument("--fps", type=int, default=None, help="defaults to the job's fps, else 30")
    a = ap.parse_args()
    profile = json.loads(a.profile.read_text())
    job = json.loads(a.job.read_text())
    fps = a.fps or int(job.get("fps", DEFAULT_FPS))
    b = Brand(profile, a.profile.resolve().parent)
    jdir = a.job.resolve().parent
    failures = []
    rendered = 0
    for ov in job.get("overlays", []):
        try:
            name, n, key = render_overlay(b, ov, jdir, fps)
        except (MissingAsset, ValueError, OSError) as e:
            failures.append(f"{Path(str(ov.get('file', '?'))).parent.name}: {e}")
            continue
        rendered += 1
        print(f"rendered {name}: {n} frames ({key})")
    if failures:
        print(f"OVERLAYS: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print(f"OVERLAYS: PASS ({rendered} rendered)")


if __name__ == "__main__":
    main()
