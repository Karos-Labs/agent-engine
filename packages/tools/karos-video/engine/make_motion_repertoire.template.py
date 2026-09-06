#!/usr/bin/env python3
"""Motion-graphics repertoire — TEMPLATE (brand-agnostic).

Copy this to `clients/<client>/skills/branded-shorts/make_motion_repertoire.py`
and fill the BRAND CONSTANTS block below from that client's brand-profile.json.
Nothing here is tied to any one brand: the archetype geometry (mark pop, chart,
clock, browser, sign-off, platform row) is universal; only the palette, fonts,
and brand mark change per client.

Shared production rules (every client): transparent, no backgrounds, neutral/ink
rims for visibility, glow = pure-hex alpha only, cubic easing, premultiplied
downscale (no color bleed). Every graphic renders to
overlays/anim-<name>/%04d.png at 30fps.
"""
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ── BRAND CONSTANTS — fill from the client's brand-profile.json (EXAMPLE values) ──
# Replace every value below with the client's own; nothing here is a default.
NEUTRAL = (245, 245, 245)      # client's light / neutral    [R, G, B]  (EXAMPLE)
ACCENT = (0, 150, 160)         # client's accent color        [R, G, B]  (EXAMPLE)
INK = (18, 18, 18)             # client's darkest ink for under-rims     (EXAMPLE)
DISPLAY_FONT = "Display-SemiBold.ttf"              # filename under brand/fonts/
BRAND_MARK = "../../brand/assets/brand-mark.png"   # client's mark (white/alpha)
PLATFORM_SLUGS = ["x", "reddit", "instagram", "tiktok"]  # icon-<slug>-neutral.png
S = 2
FPS = 30
FONTS = Path("../../brand/fonts")


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_back(t, s=1.9):
    t = min(max(t, 0.0), 1.0) - 1
    return 1 + t * t * ((s + 1) * t + s)


def glow_layer(n, alpha_peak):
    n = max(n, 2)
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.sqrt((xx - n / 2) ** 2 + (yy - n / 2) ** 2) / (n / 2)
    a = (np.clip(1 - d, 0, 1) ** 1.8 * alpha_peak).astype(np.uint8)
    layer = np.zeros((n, n, 4), dtype=np.uint8)
    layer[..., 0], layer[..., 1], layer[..., 2] = ACCENT
    layer[..., 3] = a
    return Image.fromarray(layer)


def premult_downscale(img, w, h):
    a = np.array(img, dtype=np.float32)
    rgb, alpha = a[..., :3], a[..., 3:4] / 255.0
    pm_s = cv2.resize(rgb * alpha, (w, h), interpolation=cv2.INTER_AREA)
    al_s = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA)[..., None]
    out_rgb = np.where(al_s > 1e-4, pm_s / np.maximum(al_s, 1e-4), 0)
    out = np.concatenate([np.clip(out_rgb, 0, 255),
                          np.clip(al_s * 255, 0, 255)], axis=2)
    return Image.fromarray(out.astype(np.uint8))


def render(name, n_frames, draw_frame, size=480):
    out = Path(f"anim-{name}")
    out.mkdir(exist_ok=True)
    for f in range(n_frames):
        img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
        draw_frame(img, f / FPS, size)
        premult_downscale(img, size, size).save(out / f"{f:04d}.png")
    print(f"anim-{name}: {n_frames} frames")


def rim_line(d, pts, w_core, core, rim=NEUTRAL):
    d.line(pts, fill=rim + (255,), width=w_core + 6 * S)
    d.line(pts, fill=core + (255,), width=w_core)


# ---- 1. logo pop: head mark eases in, orange diamond pulses beneath
_head = None
def logo_pop(img, t, size):
    global _head
    if _head is None:
        src = Image.open(BRAND_MARK).convert("RGBA")
        solid = Image.new("RGBA", src.size, NEUTRAL + (255,))
        under = Image.new("RGBA", src.size, INK + (255,))
        h = Image.new("RGBA", src.size, (0, 0, 0, 0))
        a = src.split()[3]
        # ink under-rim by 8-direction offset paste, then paper glyph
        rimmed = Image.new("RGBA", (src.size[0] + 16, src.size[1] + 16), (0, 0, 0, 0))
        for dx in (-6, 0, 6):
            for dy in (-6, 0, 6):
                rimmed.paste(under, (8 + dx, 8 + dy), a)
        rimmed.paste(solid, (8, 8), a)
        _head = rimmed
    pop = ease_back(min(t / 0.55, 1.0))
    if pop <= 0.01:
        return
    cx, cy = size * S // 2, int(size * S * 0.42)
    # diamond glow pulse under (pure hex alpha)
    if t > 0.5:
        pulse = 0.7 + 0.3 * math.sin((t - 0.5) * 5)
        g = int(46 * S)
        img.alpha_composite(glow_layer(2 * g, int(200 * pulse)),
                            (cx - g, int(size * S * 0.78) - g))
    d = ImageDraw.Draw(img)
    if t > 0.5:
        r = 18 * S
        dy = int(size * S * 0.78)
        d.polygon([(cx, dy - r), (cx + r, dy), (cx, dy + r), (cx - r, dy)],
                  fill=ACCENT + (255,), outline=NEUTRAL + (255,), width=2 * S)
    w = int(300 * S * pop)
    if w > 4:
        hh = int(_head.height * w / _head.width)
        head = _head.resize((w, hh))
        img.alpha_composite(head, (cx - w // 2, cy - hh // 2))


# ---- 2. growth chart: axes fade, orange line draws, dot lands with glow
def chart(img, t, size):
    d = ImageDraw.Draw(img)
    fade = ease_out(min(t / 0.4, 1.0))
    ax = int(255 * fade)
    x0, y0 = int(size * S * 0.16), int(size * S * 0.82)
    x1, y1 = int(size * S * 0.88), int(size * S * 0.18)
    d.line([(x0, int(size * S * 0.14)), (x0, y0)], fill=NEUTRAL + (ax,), width=3 * S)
    d.line([(x0, y0), (int(size * S * 0.9), y0)], fill=NEUTRAL + (ax,), width=3 * S)
    pts = [(x0 + 8 * S, y0 - 14 * S),
           (int(size * S * 0.36), int(size * S * 0.62)),
           (int(size * S * 0.58), int(size * S * 0.48)),
           (x1, y1)]
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
                drawn.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
                              pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r))
                break
        tip = drawn[-1]
        if prog >= 0.999 and t > 1.35:
            pulse = 0.7 + 0.3 * math.sin((t - 1.35) * 5)
            g = int(44 * S)
            img.alpha_composite(glow_layer(2 * g, int(210 * pulse)),
                                (int(tip[0]) - g, int(tip[1]) - g))
            d = ImageDraw.Draw(img)
        rim_line(d, drawn, 9 * S, ACCENT)
        r0 = 13 * S
        d.ellipse([tip[0] - r0 - 3 * S, tip[1] - r0 - 3 * S,
                   tip[0] + r0 + 3 * S, tip[1] + r0 + 3 * S], fill=NEUTRAL + (255,))
        d.ellipse([tip[0] - r0, tip[1] - r0, tip[0] + r0, tip[1] + r0],
                  fill=ACCENT + (255,))


# ---- 3. clock 24/7: face draws, orange hand sweeps, serif label fades in
def clock(img, t, size):
    d = ImageDraw.Draw(img)
    cx, cy, R = int(size * S * 0.38), int(size * S * 0.5), int(size * S * 0.26)
    prog = ease_out(min(t / 0.5, 1.0))
    box = [cx - R, cy - R, cx + R, cy + R]
    d.arc(box, start=-90, end=-90 + 360 * prog, fill=INK + (255,), width=11 * S)
    d.arc(box, start=-90, end=-90 + 360 * prog, fill=NEUTRAL + (255,), width=6 * S)
    if prog >= 0.999:
        for ang in range(0, 360, 30):
            a = math.radians(ang)
            d.line([(cx + (R - 10 * S) * math.cos(a), cy + (R - 10 * S) * math.sin(a)),
                    (cx + (R - 16 * S) * math.cos(a), cy + (R - 16 * S) * math.sin(a))],
                   fill=NEUTRAL + (255,), width=2 * S)
    if t > 0.5:
        ang = math.radians(-90 + (t - 0.5) * 240)
        x2, y2 = cx + R * 0.62 * math.cos(ang), cy + R * 0.62 * math.sin(ang)
        rim_line(d, [(cx, cy), (x2, y2)], 8 * S, ACCENT)
        d.ellipse([cx - 8 * S, cy - 8 * S, cx + 8 * S, cy + 8 * S],
                  fill=ACCENT + (255,))
    if t > 0.8:
        fade = int(255 * ease_out(min((t - 0.8) / 0.4, 1.0)))
        f = ImageFont.truetype(str(FONTS / DISPLAY_FONT), 64 * S)
        # ink under-rim for the serif label
        tx, ty = int(size * S * 0.60), cy - 32 * S
        for dx, dy in ((-2*S,0),(2*S,0),(0,-2*S),(0,2*S)):
            d.text((tx + dx, ty + dy), "24/7", font=f, fill=INK + (fade,))
        d.text((tx, ty), "24/7", font=f, fill=NEUTRAL + (fade,))


# ---- 4. browser wireframe draws on, orange block fills last
def browser(img, t, size):
    d = ImageDraw.Draw(img)
    x0, y0 = int(size * S * 0.14), int(size * S * 0.2)
    x1, y1 = int(size * S * 0.86), int(size * S * 0.8)
    p1 = ease_out(min(t / 0.5, 1.0))
    # frame draws clockwise
    per = 2 * ((x1 - x0) + (y1 - y0))
    target = per * p1
    pts = [(x0, y0)]
    edges = [((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)),
             ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))]
    acc = 0
    for a, b in edges:
        seg = math.dist(a, b)
        if acc + seg <= target:
            pts.append(b); acc += seg
        else:
            r = (target - acc) / seg if seg else 0
            pts.append((a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r))
            break
    if len(pts) > 1:
        d.line(pts, fill=INK + (255,), width=10 * S)
        d.line(pts, fill=NEUTRAL + (255,), width=5 * S)
    if p1 >= 0.999:
        d.line([(x0, y0 + 34 * S), (x1, y0 + 34 * S)], fill=NEUTRAL + (255,), width=3 * S)
        for i in range(3):
            xx = x0 + 12 * S + i * 16 * S
            d.ellipse([xx, y0 + 12 * S, xx + 9 * S, y0 + 21 * S],
                      outline=NEUTRAL + (255,), width=2 * S)
    if t > 0.7:
        f2 = ease_out(min((t - 0.7) / 0.4, 1.0))
        d.rectangle([x0 + 20 * S, y0 + 54 * S, x1 - 20 * S, y0 + 96 * S],
                    outline=NEUTRAL + (int(255 * f2),), width=3 * S)
    if t > 1.0:
        f3 = ease_out(min((t - 1.0) / 0.5, 1.0))
        bw = int((x1 - x0 - 56 * S) * 0.45 * f3)
        if bw > 2:
            d.rectangle([x0 + 20 * S, y0 + 112 * S, x0 + 20 * S + bw, y1 - 20 * S],
                        fill=ACCENT + (255,), outline=NEUTRAL + (255,), width=2 * S)


# ---- 5. sign-off check: circle draws, orange check strokes in
def signoff(img, t, size):
    d = ImageDraw.Draw(img)
    cx, cy, R = size * S // 2, size * S // 2, int(size * S * 0.3)
    prog = ease_out(min(t / 0.5, 1.0))
    box = [cx - R, cy - R, cx + R, cy + R]
    d.arc(box, start=-90, end=-90 + 360 * prog, fill=INK + (255,), width=11 * S)
    d.arc(box, start=-90, end=-90 + 360 * prog, fill=NEUTRAL + (255,), width=6 * S)
    if t > 0.5:
        p2 = ease_out(min((t - 0.5) / 0.45, 1.0))
        a = (cx - R * 0.42, cy + R * 0.05)
        b = (cx - R * 0.1, cy + R * 0.38)
        c = (cx + R * 0.48, cy - R * 0.32)
        seg1, seg2 = math.dist(a, b), math.dist(b, c)
        target = (seg1 + seg2) * p2
        if target <= seg1:
            r = target / seg1
            pts = [a, (a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r)]
        else:
            r = (target - seg1) / seg2
            pts = [a, b, (b[0] + (c[0] - b[0]) * r, b[1] + (c[1] - b[1]) * r)]
        rim_line(d, pts, 11 * S, ACCENT)
    if t > 1.1:
        pulse = 0.7 + 0.3 * math.sin((t - 1.1) * 5)
        g = int(40 * S)
        img.alpha_composite(glow_layer(2 * g, int(140 * pulse)),
                            (cx + int(R * 0.48) - g, cy - int(R * 0.32) - g))


# ---- 6. platform icons pop in sequence (official glyphs, paper w/ ink rim)
_icons = None
def platforms(img, t, size):
    global _icons
    slugs = PLATFORM_SLUGS
    if _icons is None:
        _icons = []
        for s_ in slugs:
            src = Image.open(f"icon-{s_}-neutral.png").convert("RGBA")
            a = src.split()[3]
            under = Image.new("RGBA", src.size, INK + (255,))
            solid = Image.new("RGBA", src.size, NEUTRAL + (255,))
            rimmed = Image.new("RGBA", (src.size[0] + 16, src.size[1] + 16), (0, 0, 0, 0))
            for dx in (-5, 0, 5):
                for dy in (-5, 0, 5):
                    rimmed.paste(under, (8 + dx, 8 + dy), a)
            rimmed.paste(solid, (8, 8), a)
            _icons.append(rimmed)
    n = len(slugs)
    total_w = size * S
    iw = int(size * S * 0.19)
    gap = int(size * S * 0.06)
    row_w = n * iw + (n - 1) * gap
    x = (total_w - row_w) // 2
    cy = size * S // 2
    for i, ic in enumerate(_icons):
        t0 = 0.15 + i * 0.28
        pop = ease_back(max(0.0, min((t - t0) / 0.4, 1.0)))
        if pop > 0.02:
            w = max(int(iw * pop), 2)
            hh = int(ic.height * w / ic.width)
            im2 = ic.resize((w, hh))
            img.alpha_composite(im2, (x + i * (iw + gap) + (iw - w) // 2,
                                      cy - hh // 2))
    # orange underline sweeps beneath the row once all landed
    if t > 0.15 + n * 0.28 + 0.1:
        p = ease_out(min((t - (0.15 + n * 0.28 + 0.1)) / 0.4, 1.0))
        y = cy + iw
        d = ImageDraw.Draw(img)
        rim_line(d, [(x, y), (x + row_w * p, y)], 9 * S, ACCENT)


if __name__ == "__main__":
    render("logo", 60, logo_pop)
    render("chart", 75, chart)
    render("clock", 75, clock)
    render("browser", 75, browser)
    render("signoff", 60, signoff)
    render("platforms", 75, platforms, size=520)
    print("repertoire complete")
