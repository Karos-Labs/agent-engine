#!/usr/bin/env python3
"""Brand-asset gate: every file a profile references must OPEN, not just exist.

    brand_assets_check.py --profile <brand-profile.json>

Written after auditing clients/karoslabs on 2026-07-28: its brand-profile.json
referenced 12 files, of which 4 resolved. Spectral-SemiBold.ttf was committed to
git as a ZERO-BYTE blob — empty for everyone, not a local iCloud eviction — and
it is simultaneously the caption body font, the display font and the explainer
caption font. Seven more paths did not exist at all, including the marker-device
italic and the endcard logo. A run would have died at captions, at the marker and
at the endcard, and `os.path.exists()` would have said the 0-byte one was fine.

So this checks three things a path check cannot:
  1. the file is non-empty;
  2. a font actually loads and reports its own family/style name, which also
     catches a file that was renamed rather than converted;
  3. an image actually decodes, and warns when something used as an overlay or a
     tinted mark has no alpha channel to tint through.

Run it as part of onboarding, and again before any run for a client whose assets
may have moved. Exit code 1 on any failure.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

FONT_EXT = {".ttf", ".otf", ".ttc"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
# keys whose images are tinted or composited by the engine, so alpha matters
NEEDS_ALPHA_HINT = ("logo", "mark", "lockup", "wordmark", "icon", "overlay")


def walk_paths(obj, trail=""):
    """Yield (json_path, value) for every string that looks like a file path."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk_paths(v, f"{trail}.{k}" if trail else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk_paths(v, f"{trail}[{i}]")
    elif isinstance(obj, str):
        suf = Path(obj).suffix.lower()
        if suf in FONT_EXT | IMAGE_EXT and "/" in obj:
            yield trail, obj


def check_font(p: Path):
    from PIL import ImageFont
    try:
        f = ImageFont.truetype(str(p), 48)
    except Exception as e:
        return False, f"will not load: {type(e).__name__}: {e}"
    try:
        fam, style = f.getname()
        return True, f"loads as {fam!r} / {style!r}"
    except Exception:
        return True, "loads (no name table)"


def check_image(p: Path, json_key: str):
    from PIL import Image
    try:
        im = Image.open(p)
        im.load()
    except Exception as e:
        return False, f"will not decode: {type(e).__name__}: {e}", None
    note = f"{im.size[0]}x{im.size[1]} {im.mode}"
    warn = None
    if any(h in json_key.lower() for h in NEEDS_ALPHA_HINT):
        if "A" not in im.mode:
            warn = ("no alpha channel, but this key is composited/tinted by the "
                    "engine — it will paste as an opaque rectangle")
        else:
            a = im.getchannel("A")
            lo, hi = a.getextrema()
            if hi == 0:
                warn = "alpha channel is fully transparent — nothing will render"
            elif lo == hi == 255:
                warn = ("alpha is fully opaque everywhere — probably a flattened "
                        "export, so a tint will fill the whole rectangle")
    return True, note, warn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--quiet", action="store_true",
                    help="only print problems")
    args = ap.parse_args()

    profile = json.loads(args.profile.read_text())
    base = args.profile.parent
    seen, fails, warns = {}, [], []

    for key, rel in walk_paths(profile):
        p = (base / rel)
        if rel in seen:
            continue
        seen[rel] = True
        if not p.exists():
            fails.append(f"MISSING   {rel}  (referenced by {key})")
            continue
        size = p.stat().st_size
        if size == 0:
            fails.append(f"ZERO-BYTE {rel}  (referenced by {key}) — exists but "
                         f"is empty; a path check would have passed this")
            continue
        suf = p.suffix.lower()
        if suf in FONT_EXT:
            ok, note = check_font(p)
            if not ok:
                fails.append(f"BAD FONT  {rel}  {note}")
            elif not args.quiet:
                print(f"  OK  {rel:52} {size/1024:7.1f}KB  {note}")
        else:
            ok, note, warn = check_image(p, key)
            if not ok:
                fails.append(f"BAD IMAGE {rel}  {note}")
            else:
                if warn:
                    warns.append(f"{rel}  {warn}")
                if not args.quiet:
                    print(f"  OK  {rel:52} {size/1024:7.1f}KB  {note}")

    total = len(seen)
    print(f"\n{total - len(fails)}/{total} asset paths resolve and open")
    for w in warns:
        print(f"  WARN  {w}")
    if fails:
        print(f"\nBRAND ASSETS: FAIL ({len(fails)})")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)
    print("BRAND ASSETS: PASS")


if __name__ == "__main__":
    main()
