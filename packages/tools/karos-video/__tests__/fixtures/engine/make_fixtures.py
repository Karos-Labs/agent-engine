#!/usr/bin/env python3
"""Writes the fixture set engine-contract.test.ts drives the real engine with.

    make_fixtures.py <dir> [--font <ttf>] [--with-source]

Everything a run needs, in one directory that stands in for a client's
branded-shorts folder plus a run's work directory:

  brand-profile.json          v2 profile: palette, captions, endcard, a LOCKED
                              `video_grade` in the engine's own {filter} shape
  brand/fonts/Body.ttf        copies of the one system font we can rely on
  brand/fonts/Emphasis.ttf
  brand/assets/mark.png       a neutral glyph on alpha — the brand mark
  brand/library/index.json    a two-still asset library (bursts)
  brand/library/*.png         the stills
  graphics/clean.png          every visible pixel on-palette (brand_check PASS)
  graphics/red.png            one brick-red stroke (brand_check zero-tolerance FAIL)
  transcript.json             6s of word-level tokens incl. one "um" and one false start
  job-cut-pass.json           cut list: crop the ends, remove only the "um"
  job-cut-fail.json           a silent content cut (HONESTY fail)
  job-cutaways-pass.json      4 cutaways timed 100ms ahead of their words
  job-cutaways-fail.json      one cutaway entering AFTER its word
  job-overlays.json           two overlays: a chart and a labelled callout
  job-build.json              the full build job (needs --with-source's src.mp4)
  zero-byte/brand-profile.json  a profile whose font is a 0-byte file

Deterministic: same inputs, byte-identical outputs, so the contract test can
assert exact stdout shapes rather than "something was printed".
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CANDIDATE_FONTS = [
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
]
BG, FG, ACCENT, INK = "#1A1A1A", "#F2F1EC", "#FF6B2C", "#141414"


def hexrgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def find_font(explicit: str | None) -> Path:
    for c in ([explicit] if explicit else []) + CANDIDATE_FONTS:
        if c and Path(c).exists():
            return Path(c)
    sys.exit("FAILED: no TrueType font found for fixtures (pass --font)")


def write_profile(root: Path, font: Path) -> None:
    fonts = root / "brand" / "fonts"
    fonts.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(font, fonts / "Body.ttf")
    shutil.copyfile(font, fonts / "Emphasis.ttf")
    assets = root / "brand" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    mark = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(mark)
    d.ellipse([28, 28, 228, 228], outline=hexrgb(FG) + (255,), width=26)
    d.rectangle([116, 60, 140, 196], fill=hexrgb(FG) + (255,))
    mark.save(assets / "mark.png")
    lib = root / "brand" / "library"
    lib.mkdir(parents=True, exist_ok=True)
    for i, tone in enumerate((90, 200)):
        still = Image.new("RGB", (1080, 1920), (tone, tone, tone + 20))
        ImageDraw.Draw(still).rectangle([200 + i * 100, 700, 880 - i * 100, 1300], fill=hexrgb(ACCENT))
        still.save(lib / f"still-{i}.png")
    (lib / "index.json").write_text(json.dumps({
        "stills": [
            {"file": "library/still-0.png", "subjects": ["a computer", "the lab"]},
            {"file": "library/still-1.png", "subjects": ["the founder", "a desk"]},
        ]
    }, indent=2))
    profile = {
        "brand": "Fixture Co",
        "color": {"background": BG, "foreground": FG, "accent": ACCENT, "ink": INK, "surface_1": "#242429"},
        "video_grade": {"name": "fixture-natural", "filter": "eq=contrast=1.02"},
        "video_captions_v2": {
            "keyword_device": "typographic",
            "body": {"font_file": "brand/fonts/Body.ttf", "size_px_at_1920h": 62, "color": "foreground"},
            "emphasis": {"font_file": "brand/fonts/Emphasis.ttf", "size_px_at_1920h": 100, "color": "accent", "dy_px": 6},
            "corrections": {"Karros": "Karos"},
        },
        "endcard": {
            "logo_file": "brand/assets/mark.png", "logo_tint": FG, "logo_width": 220,
            "wordmark_text": "Fixture Co", "wordmark_font_file": "brand/fonts/Body.ttf", "wordmark_size": 64,
            "eyebrow_text": "YOUR TEST CMO", "eyebrow_font_file": "brand/fonts/Body.ttf", "eyebrow_size": 26,
            "eyebrow_tracking": 8, "duration_s": 2.0,
        },
    }
    (root / "brand-profile.json").write_text(json.dumps(profile, indent=2))

    zb = root / "zero-byte"
    (zb / "brand" / "fonts").mkdir(parents=True, exist_ok=True)
    (zb / "brand" / "fonts" / "Body.ttf").write_bytes(b"")
    broken = json.loads(json.dumps(profile))
    broken["endcard"]["logo_file"] = "../brand/assets/mark.png"
    broken["endcard"]["wordmark_font_file"] = "../brand/fonts/Body.ttf"
    broken["endcard"]["eyebrow_font_file"] = "../brand/fonts/Body.ttf"
    broken["video_captions_v2"]["emphasis"]["font_file"] = "../brand/fonts/Emphasis.ttf"
    (zb / "brand-profile.json").write_text(json.dumps(broken, indent=2))


def write_graphics(root: Path) -> None:
    g = root / "graphics"
    g.mkdir(exist_ok=True)
    clean = Image.new("RGBA", (480, 480), (0, 0, 0, 0))
    d = ImageDraw.Draw(clean)
    d.line([(60, 400), (420, 90)], fill=hexrgb(FG) + (255,), width=26)
    d.line([(60, 400), (420, 90)], fill=hexrgb(ACCENT) + (255,), width=14)
    clean.save(g / "clean.png")
    red = clean.copy()
    ImageDraw.Draw(red).rectangle([200, 200, 260, 260], fill=(150, 40, 30, 255))  # brick: hue ~7°, sat .8, max 150
    red.save(g / "red.png")


# The one "um" sits mid-sentence so that removing it (±65ms) leaves BOTH kept
# segments over cut_check.py's 1.5s minimum — a filler right after the first
# two words would be glued back in by the planner, not cut.
WORDS = [
    ("Hello", 0.50, 0.85), ("everyone", 0.90, 1.35), ("today", 1.45, 1.80), ("we", 1.90, 2.05),
    ("we", 2.10, 2.25), ("tripled", 2.30, 2.75), ("um", 2.80, 3.05), ("revenue", 3.15, 3.60),
    ("at", 3.65, 3.75), ("Karros", 3.80, 4.20), ("Labs.", 4.25, 4.65), ("Ship", 4.85, 5.15),
    ("faster", 5.20, 5.60), ("now.", 5.65, 5.95),
]


def write_transcript(root: Path) -> None:
    words = [{"type": "word", "text": t, "start": s, "end": e} for t, s, e in WORDS]
    (root / "transcript.json").write_text(json.dumps({"words": words}, indent=2))


def out_time(t: float, segments) -> float:
    acc = 0.0
    for s0, s1 in segments:
        if t <= s1:
            return acc + (t - s0)
        acc += s1 - s0
    raise ValueError(t)


def write_jobs(root: Path, with_source: bool) -> None:
    root_s = str(root).replace("\\", "/")
    # crop the ends (0.50 / 5.95), remove only the "um" (2.80-3.05, ±65ms pad)
    segs = [[0.50, 2.735], [3.115, 5.95]]
    base = {
        "source": f"{root_s}/src.mp4", "transcript": f"{root_s}/transcript.json",
        "edit_dir": f"{root_s}/edit", "output": f"{root_s}/edit/final.mp4",
        "crop": "auto", "grade": "eq=contrast=1.02", "fps": 30,
        "segments": segs, "content_cuts": [], "highlight_starts": [2.30, 4.85],
        "overlays": [], "cutaways": [],
    }
    (root / "job-cut-pass.json").write_text(json.dumps(base, indent=2))
    # a silent content cut: "tripled um revenue" removed with no declaration
    bad = dict(base, segments=[[0.50, 2.27], [3.62, 5.95]])
    (root / "job-cut-fail.json").write_text(json.dumps(bad, indent=2))

    def cutaway(word_start: float, word_end_next: float, phrase: str, i: int):
        start = round(out_time(word_start, segs) - 0.100, 3)          # 100ms lead
        end = round(out_time(word_end_next, segs) + 0.010, 3)          # exits on a word boundary
        return {"file": f"{root_s}/edit/cutaway/{i}/plate.png", "start": start, "end": end,
                "word_src_start": word_start, "phrase": phrase}

    # (word start, the END of a word to exit on) — never mid-word
    cuts = [cutaway(0.90, 1.35, "everyone", 0), cutaway(1.45, 1.80, "today", 1),
            cutaway(2.30, 2.75, "tripled", 2), cutaway(4.85, 5.15, "ship", 3)]
    ok = dict(base, cutaways=cuts)
    (root / "job-cutaways-pass.json").write_text(json.dumps(ok, indent=2))
    late = json.loads(json.dumps(ok))
    late["cutaways"][2]["start"] = round(out_time(2.30, segs) + 0.050, 3)    # enters AFTER the word
    (root / "job-cutaways-fail.json").write_text(json.dumps(late, indent=2))

    # windows in OUTPUT time; the callout ends before the "ship" plate enters (~3.87s) — one visual layer per beat
    overlays = [
        {"file": f"{root_s}/edit/overlays/anim-growth_chart-0/%04d.png", "start": 1.0, "end": 2.6, "archetype": "Growth Chart"},
        {"file": f"{root_s}/edit/overlays/anim-callout-1/%04d.png", "start": 2.9, "end": 3.8, "archetype": "callout", "label": "tripled"},
    ]
    (root / "job-overlays.json").write_text(json.dumps(dict(base, overlays=overlays), indent=2))
    if with_source:
        # the full build: overlays + one plate cutaway (a library still stands in for a generated plate)
        plate = dict(cuts[3], file=f"{root_s}/brand/library/still-1.png")
        (root / "job-build.json").write_text(json.dumps(dict(base, overlays=overlays, cutaways=[plate],
                                                             corrections={"Karros": "Karos"},
                                                             endcard_override="FIXTURE RUN"), indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--font")
    ap.add_argument("--with-source", action="store_true")
    a = ap.parse_args()
    root = a.dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    font = find_font(a.font)
    write_profile(root, font)
    write_graphics(root)
    write_transcript(root)
    write_jobs(root, a.with_source)
    print(f"fixtures -> {root} (font {font.name})")


if __name__ == "__main__":
    main()
