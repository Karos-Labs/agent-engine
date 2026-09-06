#!/usr/bin/env python3
"""Brand-agnostic short-form video builder for the branded-shorts product.

    build_short.py --profile <brand-profile.json> --job <job.json>

The BRAND (colors, fonts, marker, endcard, corrections) comes from the profile.
The VIDEO decisions (source, cut list, highlights, crop, beat) come from the job.
Follows the video-use hard rules: per-segment extract -> lossless concat, 30ms
audio fades, word-boundary cuts, captions composited LAST, loudnorm -14 LUFS.

Job spec (paths relative to the job file's directory):
{
  "source": "IMG_2953.MOV",
  "transcript": "edit/transcripts/IMG_2953.json",
  "edit_dir": "edit",
  "output": "edit/final.mp4",
  "crop": "crop=1012:1800:(iw-1012)/2:360,scale=1080:1920",
  "grade": "eq=contrast=1.06:saturation=0.92",
  "fps": 30,
  "segments": [[0.85, 12.66], ...],
  "highlight_starts": [3.68, ...],
  "beat": {"file": "edit/animations/x.mp4", "src": [0.0, 8.0],
            "out_start": 25.34, "stretch": 1.046,
            "suppress": [[25.40, 33.71]]},         // optional
  "beats": [ ...same shape..., or a BURST (v2, Lola 2026-07-30):
    {"stills": ["edit/burst/a.png", ...],  // 3-6 TREATED real photos, in order
     "out_start": 20.34, "duration": 1.40, // whole burst window (s)
     "sfx": {"first": "path/shutter.wav", "rest": "path/click.wav",
             "gain_first": 0.85, "gain_rest": 0.7},   // optional click track
     "suppress": [[20.34, 21.74]]}]
  // Burst stills must be RELEVANT: they copy the transcript exactly like the
  // motion graphics do (talking about AI models -> the real lab's logo, its
  // CEO, a computer). Declare the burst as ONE entry in "cutaways" for the
  // gate; all 4d laws apply to the whole burst window.
}
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import os
ENGINE_DIR = Path(__file__).resolve().parent
# `grade.py` (the "auto" analyzer) and `ffbin.py` are vendored beside this
# script. VIDEO_USE_HELPERS is still honoured for a deployment that prefers an
# upstream video-use checkout, but nothing needs it any more: the old default
# pointed at a directory that existed nowhere this engine ran, so every
# `grade: "auto"` build died on ModuleNotFoundError at the first segment.
sys.path.insert(0, str(ENGINE_DIR))
_helpers = os.environ.get("VIDEO_USE_HELPERS")
if _helpers:
    sys.path.insert(0, _helpers)
from ffbin import FFMPEG, FFPROBE  # noqa: E402

# HLG ingest via custom LUT (Lola 2026-07-06: "4k really natural, never
# washed"): inverse HLG OETF -> OOTF -> filmic highlight rolloff -> 2020->709
# gamut -> 2.2 encode w/ saturation compensation. The old colorspace-filter
# fallback produced the "ashed out white" look and is retired.
HLG_LUT = Path(__file__).parent / "hlg709_N.cube"
TONEMAP = ("scale=in_color_matrix=bt2020:in_range=tv,format=rgb24,"
           f"lut3d='{HLG_LUT}'")
TO_YUV709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
# EVERY encode must carry explicit SDR tags. Without them ffmpeg copies the
# SOURCE's HDR tags onto converted-SDR output and players render everything
# shifted (orange -> red). This was the root cause of the recurring red
# (Lola, 2026-07-06 — she was right that it was "the editing").
SDR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv"]
# frame-property stamp: CLI tags only fix the container; the BITSTREAM VUI
# comes from frame props. Without this, HLG/bt2020 props ride through from
# iPhone frames and players render orange as neon red (the final red boss).
SETPARAMS = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv"


def run(cmd):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"FAILED: {' '.join(str(c) for c in cmd[:8])}\n{r.stderr[-1500:]}")


def hexrgb(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def strip_hdr_atoms(path):
    """MANDATORY post-process (Lola red saga, 2026-07-06): iPhone HLG sources
    carry an Apple 'Ambient Viewing Environment' (amve) atom that survives
    every ffmpeg re-encode and makes macOS render saturated orange as RED.
    Rename amve + friends to 'free' atoms in-place. Byte-exact."""
    data = bytearray(Path(path).read_bytes())
    killed = []
    for atom in (b"amve", b"mdcv", b"clli", b"dvcC", b"dvvC"):
        i = 0
        while True:
            i = data.find(atom, i)
            if i < 0:
                break
            size = int.from_bytes(data[i - 4:i], "big")
            if 8 <= size < 256:
                data[i:i + 4] = b"free"
                killed.append(atom.decode())
            i += 4
    Path(path).write_bytes(bytes(data))
    return killed


def is_hdr(video):
    # NOTE: newer iPhone recordings add an extra stream attribute that makes
    # the csv writer emit a trailing comma ("arib-std-b67,"); an exact match
    # here silently skipped the tonemap and shipped washed flat footage
    # (Lola's "black and white", 2026-07-13). Parse defensively.
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=color_transfer",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        capture_output=True, text=True).stdout.strip().strip(",")
    return any(t in out for t in HDR_TRANSFERS)


class Build:
    def __init__(self, profile_path, job_path, until="full"):
        self.pdir = profile_path.parent
        self.jdir = job_path.parent
        self.P = json.loads(profile_path.read_text())
        self.J = json.loads(job_path.read_text())
        self.edit = self.jdir / self.J.get("edit_dir", "edit")
        self.clips = self.edit / "clips_graded"
        self.clips.mkdir(parents=True, exist_ok=True)
        cs = int(self.J.get("canvas_scale", 1))
        self.CS = cs
        self.OW, self.OH = 1080 * cs, 1920 * cs
        c = self.P["color"]
        self.CHARCOAL = hexrgb(c["background"])
        self.PAPER = hexrgb(c["foreground"])
        self.ACCENT = hexrgb(c["accent"])
        self.INK = hexrgb(c.get("ink", "#141414"))
        # A v2 profile (PLAYBOOK §2) need not carry the archived v1
        # `video_captions` block at all; the two things this file still read
        # from it (the corrections dict and the default caption y) now come
        # through `corrections()` / `caption_default_y()`, which fall back
        # across both blocks and the job instead of KeyError-ing a v2-only
        # profile at the first caption.
        self.VC_META = self.P.get("video_captions") or {}
        # "base" stops after base.mp4 (segments extracted, graded, concatenated):
        # what graphic_qa.py gates overlays AGAINST, so the workflow can gate a
        # plan on the real footage before paying for a full composite.
        self.until = until

    def ppath(self, rel):
        return self.pdir / rel

    def token_colors(self):
        """Every named color in the client's palette, usable by captions —
        includes tertiary tokens (surface_1, muted_foreground, ...) so a
        white-on-white flip can land on a real brand color, not just ink."""
        m = {"foreground": self.PAPER, "accent": self.ACCENT,
             "ink": self.INK, "background": self.CHARCOAL}
        for k, v in self.P["color"].items():
            if isinstance(v, str) and v.startswith("#") and len(v) == 7:
                m.setdefault(k, hexrgb(v))
        return m

    def caption_alt_color(self):
        """The flip target when light text lands on a light layer (Lola
        2026-07-30: 'change to a tertiary color in the palette'): the
        profile's body color_alt if set, else surface_1 (the brand's
        tertiary), else ink."""
        vc = self.P["video_captions_v2"]
        alt = vc["body"].get("color_alt")
        if alt:
            return alt
        return "surface_1" if "surface_1" in self.token_colors() else "ink"

    def corrections(self):
        """ASR spelling fixes, merged: the profile's v1 block, then its v2
        block, then the job's own `corrections` (per-run names from the intake,
        SKILL.md Q7) winning over both. Never trust the transcript for names."""
        m = {}
        m.update(self.VC_META.get("corrections") or {})
        m.update((self.P.get("video_captions_v2") or {}).get("corrections") or {})
        m.update(self.J.get("corrections") or {})
        return m

    def caption_default_y(self):
        """Default caption y (px @1920h): the job's `caption_y`, else the v2
        block's `y_at_1920`, else the v1 block's, else 380 — the value every
        existing profile was built against."""
        v2 = self.P.get("video_captions_v2") or {}
        return int(self.J.get("caption_y", v2.get("y_at_1920", self.VC_META.get("y_at_1920", 380))))

    def jpath(self, rel):
        return self.jdir / rel

    # -- framing ---------------------------------------------------------
    # Lola rule: the person is ALWAYS centered. crop:"auto" detects the face
    # across sampled frames (on DECODED frames, so rotation metadata can never
    # fool us again) and derives a 9:16 crop centered on the subject.
    BEAUTY_GRADE = ("eq=brightness=0.04:contrast=1.05:saturation=1.08,"
                    "unsharp=5:5:0.4:5:5:0.0")

    def auto_center_crop(self, src):
        import cv2
        import tempfile
        dur = float(subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout)
        tmp = Path(tempfile.mkdtemp(prefix="autocenter_"))
        centers, dims = [], None
        cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        for i in range(7):
            t = dur * (i + 1) / 8
            f = tmp / f"f{i}.jpg"
            subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", f"{t:.2f}",
                            "-i", str(src), "-frames:v", "1", str(f)],
                           check=True, capture_output=True)
            img = cv2.imread(str(f))
            if img is None:
                continue
            dims = (img.shape[1], img.shape[0])  # decoded (rotated) w, h
            faces = cascade.detectMultiScale(
                cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 1.1, 5,
                minSize=(img.shape[1] // 12, img.shape[1] // 12))
            if len(faces):
                x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
                centers.append((x + w / 2, y + h / 2))
        iw, ih = dims
        if centers:
            centers.sort()
            cx, cy = centers[len(centers) // 2]
        else:
            print("  auto-center: NO FACE FOUND, using frame center")
            cx, cy = iw / 2, ih / 2
        self.face_cx_norm = cx / iw  # remembered for face-aware overlay placement
        ch = min(ih, int(iw * 16 / 9))
        cw = int(ch * 9 / 16)
        x0 = int(min(max(cx - cw / 2, 0), iw - cw))
        y0 = int(min(max(cy - 0.42 * ch, 0), ih - ch))
        crop = "" if (cw >= iw and ch >= ih) else f"crop={cw}:{ch}:{x0}:{y0},"
        print(f"  auto-center: decoded {iw}x{ih}, face at ({cx:.0f},{cy:.0f}) "
              f"from {len(centers)} frames -> {crop or 'no crop needed,'}scale")
        return f"{crop}scale={self.OW}:{self.OH}"

    # -- cut ------------------------------------------------------------
    def extract_segments(self):
        src = self.jpath(self.J["source"])
        vf_parts = []
        if is_hdr(src):
            vf_parts.append(TONEMAP)
        crop = self.J.get("crop")
        if crop == "auto":
            crop = self.auto_center_crop(src)
            self.J["crop"] = crop  # reuse for beat extraction
        if crop:
            vf_parts.append(crop)
        grade = self.J.get("grade", "auto")
        if grade == "beauty":
            grade = self.BEAUTY_GRADE
        elif grade == "profile":
            # per-client grade from the brand profile (Lola 2026-07-06)
            vg = self.P.get("video_grade", "")
            grade = vg.get("filter", "") if isinstance(vg, dict) else (vg or "")
        auto_grade = None
        if grade == "auto":
            # video-use skill's analyzer: subtle per-segment correction,
            # hard-capped, pulls back overexposure, no-ops on clean footage
            # (Lola 2026-07-06: grading is the system's design skill, never
            # a human question; the only human choice is the STYLE)
            from grade import auto_grade_for_clip
            auto_grade = auto_grade_for_clip
            grade = ""
        fps = str(self.J.get("fps", 30))
        paths = []
        for i, (s, e) in enumerate(self.J["segments"]):
            dur = e - s
            seg_grade = grade
            if auto_grade is not None:
                seg_grade, stats = auto_grade(src, start=s, duration=dur)
                print(f"  auto-grade seg_{i:02d}: {seg_grade}")
            seg_parts = vf_parts + ([seg_grade] if seg_grade else []) + [SETPARAMS, TO_YUV709]
            vf = ",".join(seg_parts)
            out = self.clips / f"seg_{i:02d}.mp4"
            af = (f"afade=t=in:st=0:d=0.03,"
                  f"afade=t=out:st={dur - 0.03:.3f}:d=0.03")
            run([FFMPEG, "-y", "-ss", f"{s:.3f}", "-i", src, "-t", f"{dur:.3f}",
                 "-map", "0:v:0", "-map", "0:a:0", "-vf", vf, "-af", af,
                 "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                 "-pix_fmt", "yuv420p", "-r", fps,
                 "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                 *SDR_TAGS, "-movflags", "+faststart", out])
            paths.append(out)
            print(f"  seg_{i:02d}: {dur:.2f}s")
        return paths

    def concat(self, paths, out):
        lst = self.edit / "concat.txt"
        lst.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
        run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst,
             "-c", "copy", *SDR_TAGS, "-movflags", "+faststart", out])

    # -- captions --------------------------------------------------------
    def caption_events(self):
        corrections = self.corrections()
        hl = {round(h, 2) for h in self.J.get("highlight_starts", [])}
        words = [w for w in json.loads(
            self.jpath(self.J["transcript"]).read_text())["words"]
            if w["type"] == "word"]
        offset, mapped = 0.0, []
        for seg_i, (s, e) in enumerate(self.J["segments"]):
            for w in words:
                if s <= w["start"] < e:
                    mapped.append({
                        "t": w["start"] - s + offset,
                        "end": w["end"] - s + offset, "seg": seg_i,
                        "text": corrections.get(w["text"], w["text"]),
                        "hl": round(w["start"], 2) in hl})
            offset += e - s
        units, u = [], []
        for w in mapped:
            if u and not (u[-1]["hl"] and w["hl"] and w["seg"] == u[-1]["seg"]):
                units.append(u); u = []
            u.append(w)
        units.append(u)
        chunks, cur = [], []
        for unit in units:
            w0 = unit[0]
            if cur and (len(cur) + len(unit) > 3
                        or w0["seg"] != cur[-1]["seg"]
                        or w0["t"] - cur[-1]["end"] > 0.6):
                chunks.append(cur); cur = []
            cur.extend(unit)
            # sentence end ALWAYS breaks the chunk — a chunk must never span
            # two sentences (it can drag a sentence tail into a beat window)
            if cur[-1]["text"].rstrip(",").endswith((".", "?", "!")):
                chunks.append(cur); cur = []
        if cur:
            chunks.append(cur)
        events = []
        for i, ch in enumerate(chunks):
            start = ch[0]["t"]
            end = (min(chunks[i + 1][0]["t"], ch[-1]["end"] + 0.9)
                   if i + 1 < len(chunks) else ch[-1]["end"] + 0.5)
            events.append({"start": start, "end": end, "words": ch})
        print(f"  {len(chunks)} caption chunks, speech ends {offset:.2f}s")
        return events

    def render_caption_pngs(self, events):
        """v2 IS the product (2026-07-30): the typographic caption system is
        the only renderer. The v1 marker-band renderer is archived in
        _ARCHIVE/v1-2026-07-30/build_short-v1.py — never reach into an
        archive for new work."""
        if not self.P.get("video_captions_v2"):
            sys.exit("v1 captions are ARCHIVED (2026-07-30): add a "
                     "video_captions_v2 block (body + emphasis fonts from "
                     "the client's own families) to the client profile.")
        return self.render_caption_pngs_v2(events)

    def render_caption_pngs_v2(self, events):
        """V2 TYPOGRAPHIC keyword device (Lola 2026-07-30, picked from mock
        v2c): two brand fonts, no bands. Body words in the client's body
        font; the 1-3 emphasis words in their second font, larger, in the
        brand accent. Mutually exclusive with the v1 marker band per client
        (double emphasis reads as noise — PLAYBOOK-V2). Profile block:
          "video_captions_v2": {
            "body":     {"font_file": ..., "size_px_at_1920h": 62,
                         "color": "foreground"},
            "emphasis": {"font_file": ..., "size_px_at_1920h": 100,
                         "color": "accent", "dy_px": 6}}
        Both fonts MUST be the client's own families (brand rule 1).
        Lola 2026-07-30 caption rules (v2 only): NO commas in captions;
        disfluencies ("uh"/"um"...) are NEVER captioned even when the audio
        keeps them; emphasis should land every few words (density warning
        below); body color adapts per chunk when the background is too
        close (gate flips it to the brand alt color, default ink)."""
        from PIL import Image, ImageDraw, ImageFont
        vc = self.P["video_captions_v2"]
        cs = self.CS
        bcfg, ecfg = vc["body"], vc["emphasis"]
        body = ImageFont.truetype(str(self.ppath(bcfg["font_file"])),
                                  bcfg.get("size_px_at_1920h", 62) * cs)
        emph = ImageFont.truetype(str(self.ppath(ecfg["font_file"])),
                                  ecfg.get("size_px_at_1920h", 100) * cs)
        col = self.token_colors()
        bcol = col.get(bcfg.get("color", "foreground"), self.PAPER)
        ecol = col.get(ecfg.get("color", "accent"), self.ACCENT)
        edy = int(ecfg.get("dy_px", 6) * cs)
        b_asc, b_desc = body.getmetrics()
        e_asc, e_desc = emph.getmetrics()
        line_h = e_asc + e_desc + edy + 8
        space = body.getlength(" ")
        cap_dir = self.edit / "captions"
        cap_dir.mkdir(exist_ok=True)

        FILLERS = {"uh", "um", "er", "uhh", "umm", "mm", "hmm", "ah", "eh"}

        def tokens_for(ev):
            toks = []
            for w in ev["words"]:
                t = w["text"].replace(",", "")           # NO commas (Lola)
                if t.lower().strip(".!?…-") in FILLERS:  # never caption "uh"
                    continue
                if not t:
                    continue
                if w["hl"] and toks and toks[-1][1]:
                    toks[-1] = (toks[-1][0] + " " + t, True)
                else:
                    toks.append((t, w["hl"]))
            return toks

        bare = 0   # density check: emphasis every few words (Lola)
        for i, ev in enumerate(events):
            toks = tokens_for(ev)
            if not toks:                 # chunk was all fillers
                ev["png"] = None
                continue
            bare = 0 if any(h for _, h in toks) else bare + 1
            if bare >= 3:
                print(f"  caption density WARNING: 3+ consecutive chunks "
                      f"without an emphasis word around cap_{i:02d} — v2 "
                      f"rule wants the second font every few words")
                bare = 0
            override = ev.get("body_color_override")
            bc = col.get(override, bcol) if override else bcol
            words = [(t, h, (emph if h else body).getlength(t))
                     for t, h in toks]
            lines, cur, curw = [], [], 0.0
            for t, h, wd in words:
                add = wd if not cur else wd + space
                if cur and curw + add > (self.OW - 100):
                    lines.append(cur); cur, curw = [], 0.0
                    add = wd
                cur.append((t, h, wd)); curw += add
            lines.append(cur)
            layers = {}
            for name in ("all", "body", "emph"):
                layers[name] = Image.new(
                    "RGBA", (self.OW, line_h * len(lines) + 30), (0, 0, 0, 0))
            draws = {k: ImageDraw.Draw(v) for k, v in layers.items()}
            baseline = 10 + e_asc
            for line in lines:
                total = sum(wd for _, _, wd in line) + space * (len(line) - 1)
                x = (self.OW - total) / 2
                for t, h, wd in line:
                    if h:
                        for k in ("all", "emph"):
                            draws[k].text((x, baseline - e_asc + edy), t,
                                          font=emph, fill=ecol)
                    else:
                        for k in ("all", "body"):
                            draws[k].text((x, baseline - b_asc), t,
                                          font=body, fill=bc)
                    x += wd + space
                baseline += line_h
            layers["all"].save(cap_dir / f"cap_{i:02d}.png")
            layers["body"].save(cap_dir / f"cap_{i:02d}_body.png")
            layers["emph"].save(cap_dir / f"cap_{i:02d}_emph.png")
            ev["png"] = cap_dir / f"cap_{i:02d}.png"
            ev["png_body"] = cap_dir / f"cap_{i:02d}_body.png"
            ev["png_emph"] = cap_dir / f"cap_{i:02d}_emph.png"

    # v2 caption contrast gate (PLAYBOOK-V2): band-less captions must clear
    # ONE of two floors against the real footage under the glyphs —
    # luminance contrast (WCAG-style ratio) OR chroma distance (an accent
    # word can sit at the same luminance as the footage and still pop by
    # hue: orange-on-beige measured CR 1.06 but is plainly readable).
    # Calibrated 2026-07-30 on the approved proof: cream body over the
    # bright wall = CR 2.39 (pass by luma), orange emphasis over the same
    # wall = CR 1.06 / chroma 0.38 (pass by chroma), cream-on-white =
    # CR ~1.1 / chroma ~0.14 (fails both, correctly).
    CAPTION_CR_FLOOR = 1.6
    CAPTION_CD_FLOOR = 0.25      # opponent chroma distance, [0,1]
    # Emphasis is >=1.5x body size and bold — large bold type reads at
    # lower contrast (the WCAG large-text allowance, 3:1 vs 4.5:1).
    CAPTION_EMPH_FACTOR = 0.75
    CAPTION_Y_NUDGES = [0, -60, 60, -120, 120]   # px@1920, top-center window
    CAPTION_Y_RANGE = (240, 620)
    # Burst stills get a brand-ground gradient over the caption zone: a
    # chunk can cross stills of OPPOSITE polarity (light then dark), where
    # NO single text color reads (measured 2026-07-30: cream 2.1 -> 0.79,
    # purple 0.94 -> 2.5 across one chunk). The stills are ours — the
    # ground guarantees the zone instead of flickering caption colors.
    SCRIM_ALPHA = 0.55
    SCRIM_FADE_Y = 760           # px@1920: alpha fades to 0 by here

    @staticmethod
    def _rel_luma(rgb):
        import numpy as np
        c = (np.asarray(rgb, dtype="float32") / 255.0) ** 2.2
        return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]

    @staticmethod
    def _opp_chroma(text_mean, bg_px):
        """Perceptual chroma distance for TEXT legibility: red-green
        opponent difference counts in full, blue-yellow barely (the eye
        reads edges by luminance and red-green; yellow-on-white has a huge
        raw RGB distance but is unreadable — 2026-07-30, 'the white
        clashed with the images')."""
        import numpy as np
        t, b = text_mean.astype("float32"), bg_px.astype("float32")
        o1 = (t[0] - t[1]) - (b[..., 0] - b[..., 1])
        o2 = ((t[0] + t[1]) / 2 - t[2]) - \
             ((b[..., 0] + b[..., 1]) / 2 - b[..., 2])
        return float(np.sqrt(o1 ** 2 + 0.05 * o2 ** 2).mean()) / 255.0

    def _sample_specs(self, ev, beats, final=None):
        """Times (and sources) to measure a chunk at: start/mid/end PLUS
        every burst-still onset inside the chunk — one midpoint frame lied
        on 2026-07-30 (a chunk spans several stills; the light one was the
        one that clashed). final=<path> samples everything from the
        finished file instead of base/beat clips."""
        if not hasattr(self, "_base_dur"):
            self._base_dur = float(subprocess.run(
                [FFPROBE, "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(self.edit / "base.mp4")],
                capture_output=True, text=True).stdout or 0)
        # a chunk's hold can outlive the speech/base — clamp sample times
        # (also for the final file: past base_dur the ENDCARD is on screen,
        # sampling it reads "no caption" and false-fails the verify)
        hi = self._base_dur - 0.08
        times = {round(ev["start"] + 0.06, 3),
                 round((ev["start"] + ev["end"]) / 2, 3),
                 round(ev["end"] - 0.06, 3)}
        for b in beats:
            ws, we = b["window"]
            if ws < ev["end"] and ev["start"] < we:
                for o in b.get("onsets") or [(ws + we) / 2]:
                    if ev["start"] <= o + 0.05 <= ev["end"]:
                        times.add(round(o + 0.05, 3))
        if hi is not None:
            times = {min(t, hi) for t in times}
        specs = []
        for t in sorted(times):
            if final is not None:
                specs.append((final, t))
                continue
            src, off = self.edit / "base.mp4", t
            for b in beats:
                ws, we = b["window"]
                if ws <= t <= we:
                    src, off = b["clip"], t - ws
                    break
            specs.append((src, off))
        return specs

    def _worst_layer_score(self, png, frame, y0, cr_floor, cd_floor,
                           text_rgb=None):
        """Worst LOCAL contrast of a caption layer over one frame: the
        glyph mask is split into 8 x-bins and every bin must read — a
        line-wide mean lets an invisible half hide behind a readable
        half (the 2026-07-30 clash). Returns (worst_score, cr, cd) for
        the worst bin, or None if the layer is empty."""
        import numpy as np
        from PIL import Image
        cap = np.asarray(Image.open(png))
        mask = cap[..., 3] > 200
        if not mask.any():
            return None
        yc = y0 * self.CS
        region = frame[yc:yc + cap.shape[0], :cap.shape[1]]
        m = mask[:region.shape[0], :region.shape[1]]
        xs = np.where(m.any(0))[0]
        if not len(xs):
            return None
        scores = []
        edges = np.linspace(xs.min(), xs.max() + 1, 9).astype(int)
        for k in range(8):
            sub = m.copy()
            sub[:, :edges[k]] = False
            sub[:, edges[k + 1]:] = False
            if sub.sum() < 150:
                continue
            text = cap[..., :3][:region.shape[0], :region.shape[1]][sub]
            bg = region[sub].astype("float32")
            tmean = text_rgb if text_rgb is not None else text.mean(0)
            lt = float(self._rel_luma(tmean))
            lb = float(self._rel_luma(bg).mean())
            cr = (max(lt, lb) + 0.05) / (min(lt, lb) + 0.05)
            cd = self._opp_chroma(np.asarray(tmean, "float32"), bg)
            scores.append((max(cr / cr_floor, cd / cd_floor), cr, cd))
        if not scores:
            return None
        # one bad 8th is tolerated (a letter crossing a dark patch); the
        # SECOND-worst bin decides — no flat color reads on every pixel of
        # a busy mixed still, and demanding that would fail every option.
        scores.sort(key=lambda s: s[0])
        return scores[min(1, len(scores) - 1)]

    def gate_captions_v2(self, events, beats):
        """LEGIBILITY GATE for band-less v2 captions (the v1 band did
        contrast duty; without it bright footage can wash the text out).
        Measures each chunk against the background it will REALLY sit on —
        the beat/burst clip when the chunk falls inside an insert window,
        the footage otherwise (Lola 2026-07-30: "you can't use white if
        there will be a white overlay"). Body and emphasis layers are
        measured separately; a failing body may flip to the brand's
        TERTIARY color for that chunk. Every chunk is sampled at start/
        mid/end PLUS each burst-still onset it spans, and judged by its
        WORST 8th of the line on its WORST frame (2026-07-30: a midpoint
        mean said PASS while cream body clashed with a light still).
        Picks ONE y for the whole video — captions never jump per chunk
        (2026-07-28: adjust WITHIN the default). No combination passes =
        the build FAILS with per-chunk numbers; anything further is a
        human call."""
        import numpy as np
        from PIL import Image
        col = self.token_colors()
        alt_name = self.caption_alt_color()
        alt_rgb = np.array(col[alt_name][:3], dtype="float32")
        events = [ev for ev in events if ev.get("png")]
        qdir = self.edit / "captions" / "qa_frames"
        qdir.mkdir(parents=True, exist_ok=True)
        seen, ev_frames = {}, []
        for ev in events:
            paths = []
            for src, off in self._sample_specs(ev, beats):
                key = (str(src), off)
                if key not in seen:
                    fp = qdir / f"s{len(seen):03d}.png"
                    run([FFMPEG, "-y", "-ss", f"{off:.3f}", "-i", src,
                         "-frames:v", "1", fp])
                    seen[key] = fp if fp.exists() else None
                if seen[key] is not None:
                    paths.append(seen[key])
            ev_frames.append(paths)

        default_y = self.caption_default_y()
        lo, hi = self.CAPTION_Y_RANGE
        CR, CD = self.CAPTION_CR_FLOOR, self.CAPTION_CD_FLOOR
        report = None
        for nudge in self.CAPTION_Y_NUDGES:
            y0 = min(max(default_y + nudge, lo), hi)
            flips, rows, all_ok = {}, [], True
            for i, (ev, paths) in enumerate(zip(events, ev_frames)):
                worst = {"b": None, "ba": None, "e": None}
                ef = self.CAPTION_EMPH_FACTOR
                for p in paths:
                    frame = np.asarray(Image.open(p).convert("RGB")
                                       ).astype("float32")
                    for k, png, rgb, f in (("b", ev["png_body"], None, 1),
                                           ("ba", ev["png_body"], alt_rgb, 1),
                                           ("e", ev["png_emph"], None, ef)):
                        s = self._worst_layer_score(png, frame, y0,
                                                    CR * f, CD * f,
                                                    text_rgb=rgb)
                        if s is not None and (worst[k] is None or
                                              s[0] < worst[k][0]):
                            worst[k] = s
                e_w, b_w, ba_w = worst["e"], worst["b"], worst["ba"]
                if e_w is not None and e_w[0] < 1.0:
                    all_ok = False           # accent is fixed — only y helps
                    rows.append((ev["png"].name, "emphasis", e_w[1], e_w[2]))
                if b_w is not None and b_w[0] < 1.0:
                    if ba_w is not None and ba_w[0] >= 1.0:
                        flips[i] = alt_name  # body flips to the tertiary
                    else:
                        all_ok = False
                        rows.append((ev["png"].name, "body", b_w[1], b_w[2]))
            if all_ok:
                self.cap_y_override = y0
                if flips:
                    for i, name in flips.items():
                        events[i]["body_color_override"] = name
                    self.render_caption_pngs_v2(events)
                    print(f"  caption gate: {len(flips)} chunk(s) flip body "
                          f"to {alt_name} (light background under the text)")
                print(f"  caption gate: PASS at y={y0} "
                      f"({len(flips)} color flips; floors CR "
                      f"{self.CAPTION_CR_FLOOR} / chroma "
                      f"{self.CAPTION_CD_FLOOR})")
                return
            if report is None:
                report = (y0, rows)
        y0, rows = report
        print(f"CAPTION GATE: FAIL — no y/color combination in the "
              f"top-center window passes. At default y={y0}:")
        for name, layer, cr, cd in rows:
            print(f"  - {name} [{layer}]: CR {cr:.2f}, chroma {cd:.2f}")
        sys.exit("caption contrast gate failed: nudge + color flip "
                 "exhausted. Human call: different emphasis moments, or "
                 "keep this client on the v1 marker captions.")

    # Post-render floors get ~10% grace vs the pre-gate: encode softening
    # and the grade slightly compress measured contrast on the final file.
    CAPTION_POST_CR = 1.45
    CAPTION_POST_CD = 0.22

    def verify_captions_final(self, out_path, events, beats):
        """POST-RENDER white-on-white check (Lola 2026-07-30: 'check if
        there is white on white after render'): sample the FINISHED video
        at each chunk's midpoint and measure the actual shipped contrast —
        glyph-core pixels vs the ring immediately around the letters. The
        pre-composite gate predicts; this verifies reality (grade, encode
        and every overlay included). Returns indices of body-layer fails
        (they re-render in the tertiary and the video re-finishes);
        an emphasis-layer fail aborts — accent never changes color."""
        import numpy as np
        from PIL import Image

        def grow(m, n):
            out = m.copy()
            for _ in range(n):
                out = out | np.roll(out, 1, 0) | np.roll(out, -1, 0) \
                          | np.roll(out, 1, 1) | np.roll(out, -1, 1)
            return out

        def shrink(m, n):
            out = m.copy()
            for _ in range(n):
                out = out & np.roll(out, 1, 0) & np.roll(out, -1, 0) \
                          & np.roll(out, 1, 1) & np.roll(out, -1, 1)
            return out

        y0 = getattr(self, "cap_y_override", None) or self.caption_default_y()
        yc = y0 * self.CS
        qdir = self.edit / "captions" / "qa_final"
        qdir.mkdir(parents=True, exist_ok=True)

        def worst_final(ev, key, frame):
            """Worst 8th of the layer on this final frame: glyph cores vs
            the ring around the letters, per x-bin."""
            cap = np.asarray(Image.open(ev[key]))
            mask_full = cap[..., 3] > 200
            if not mask_full.any():
                return None
            region = frame[yc:yc + cap.shape[0], :cap.shape[1]]
            m = mask_full[:region.shape[0], :region.shape[1]]
            core_a, ring_a = shrink(m, 2), grow(m, 8) & ~grow(m, 3)
            xs = np.where(m.any(0))[0]
            if not len(xs):
                return None
            scores = []
            edges = np.linspace(xs.min(), xs.max() + 1, 9).astype(int)
            for k in range(8):
                sel = np.zeros_like(m)
                sel[:, edges[k]:edges[k + 1]] = True
                core, ring = core_a & sel, ring_a & sel
                if core.sum() < 80 or ring.sum() < 80:
                    continue
                core_mean = region[core].mean(0)
                lt = float(self._rel_luma(core_mean))
                lb = float(self._rel_luma(region[ring].mean(0)))
                cr = (max(lt, lb) + 0.05) / (min(lt, lb) + 0.05)
                cd = self._opp_chroma(core_mean, region[ring])
                f = self.CAPTION_EMPH_FACTOR if key == "png_emph" else 1
                scores.append((max(cr / (self.CAPTION_POST_CR * f),
                                   cd / (self.CAPTION_POST_CD * f)),
                               cr, cd))
            if not scores:
                return None
            scores.sort(key=lambda s: s[0])   # one bad 8th tolerated
            return scores[min(1, len(scores) - 1)]

        body_fails, emph_fail = [], None
        seen = {}
        for i, ev in enumerate(events):
            w = {"body": None, "emph": None}
            for src, t in self._sample_specs(ev, beats, final=out_path):
                if t not in seen:
                    fp = qdir / f"f{len(seen):03d}.png"
                    run([FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", src,
                         "-frames:v", "1", fp])
                    seen[t] = fp
                frame = np.asarray(Image.open(seen[t]).convert("RGB")
                                   ).astype("float32")
                for layer, key in (("body", "png_body"),
                                   ("emph", "png_emph")):
                    s = worst_final(ev, key, frame)
                    if s is not None and (w[layer] is None or
                                          s[0] < w[layer][0]):
                        w[layer] = s
            if w["emph"] is not None and w["emph"][0] < 1.0:
                emph_fail = (i, w["emph"][1], w["emph"][2])
            if w["body"] is not None and w["body"][0] < 1.0:
                body_fails.append((i, w["body"][1], w["body"][2]))
        if emph_fail:
            i, cr, cd = emph_fail
            sys.exit(f"POST-RENDER caption check: emphasis layer of chunk "
                     f"{i} shipped low-contrast (CR {cr:.2f}, chroma "
                     f"{cd:.2f}) — accent never flips; fix the schedule "
                     f"or emphasis moments.")
        return body_fails

    def finish(self, events, beats, out_path):
        """composite -> sfx -> endcard concat -> loudnorm -> color checks.
        Split out of build() so the post-render caption check can re-run
        the tail after a tertiary color flip."""
        self.composite(events, beats)
        self.concat([self.mix_sfx(), self.edit / "endcard.mp4"],
                    self.edit / "assembled.mp4")
        print("loudnorm -> " + out_path.name)
        run([FFMPEG, "-y", "-i", self.edit / "assembled.mp4",
             "-af", "loudnorm=I=-14:TP=-1:LRA=11",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             *SDR_TAGS, "-movflags", "+faststart", out_path])
        killed = strip_hdr_atoms(out_path)
        if killed:
            print(f"  stripped HDR atoms: {killed}")
        vui = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=color_space,color_primaries,color_transfer",
             "-of", "csv=p=0", str(out_path)],
            capture_output=True, text=True).stdout.strip()
        if any(x not in ("bt709", "unknown") for x in vui.split(",") if x):
            sys.exit(f"FAIL: bitstream color not bt709: {vui}")
        print(f"  bitstream color: {vui}")
        leftover = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream_side_data_list", "-of", "csv=p=0",
             str(out_path)], capture_output=True, text=True).stdout.strip()
        if leftover:
            sys.exit(f"FAIL: HDR side data still present on output: {leftover}")

    # -- beat / endcard / composite ---------------------------------------
    # snap-settle scale per frame index (proven in the 2026-07-30 test scene)
    BURST_SETTLE = {0: 0.048, 1: 0.018, 2: 0.006}
    BURST_JITTER = [-1.2, 0.9, -0.7, 1.1, -0.9, 0.8]  # deg, cycles per still

    def prepare_burst(self, n, b):
        """v2 burst cutaway: 3-6 TREATED real stills snap in sequence
        (click-click-click). Stills arrive already graded into the brand
        world; this renders the snap motion only (rotation jitter + 3-frame
        scale settle, hard cuts) and queues the click SFX events."""
        from PIL import Image, ImageOps
        fps = self.J.get("fps", 30)
        stills = b["stills"]
        total = int(round(b["duration"] * fps))
        per = [total // len(stills)] * len(stills)
        for k in range(total - sum(per)):       # distribute remainder frames
            per[k % len(stills)] += 1
        fdir = self.edit / "animations" / f"burst_{n}"
        fdir.mkdir(parents=True, exist_ok=True)
        W, H = self.OW, self.OH
        BW, BH = int(W * 1.2), int(H * 1.2)     # rotation crop buffer
        onsets, t, fi = [], b["out_start"], 0
        for i, (still, nf) in enumerate(zip(stills, per)):
            im = ImageOps.exif_transpose(Image.open(self.jpath(still)))
            im = im.convert("RGB").resize((BW, BH), Image.LANCZOS)
            im = im.rotate(self.BURST_JITTER[i % len(self.BURST_JITTER)],
                           Image.BICUBIC, expand=False)
            for f in range(nf):
                s = 1.06 + self.BURST_SETTLE.get(f, 0.0)
                cw, ch = int(W * s), int(H * s)
                x0, y0 = (BW - cw) // 2, (BH - ch) // 2
                fr = im.crop((x0, y0, x0 + cw, y0 + ch)).resize(
                    (W, H), Image.LANCZOS).convert("RGBA")
                Image.alpha_composite(fr, self.burst_scrim()).convert(
                    "RGB").save(fdir / f"f{fi:04d}.png")
                fi += 1
            onsets.append(t)
            t += nf / fps
        out = self.edit / "animations" / f"insert_{n}.mp4"
        run([FFMPEG, "-y", "-framerate", str(fps), "-i", fdir / "f%04d.png",
             "-c:v", "libx264", "-preset", "fast", "-crf", "17",
             "-pix_fmt", "yuv420p", *SDR_TAGS, out])
        sfx = b.get("sfx")
        if sfx:
            self.sfx_events.append((self.jpath(sfx["first"]), onsets[0],
                                    sfx.get("gain_first", 0.85)))
            for o in onsets[1:]:
                self.sfx_events.append((self.jpath(sfx["rest"]), o,
                                        sfx.get("gain_rest", 0.7)))
        return {"clip": out, "onsets": onsets,
                "window": (b["out_start"], b["out_start"] + total / fps),
                "suppress": [tuple(x) for x in b.get("suppress", [])]}

    IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
    PLATE_PUSH = 1.08   # Ken Burns push-in: 100% -> 108% over the window, cubic ease-out

    def burst_scrim(self):
        """PLAYBOOK §4d.6: the engine-drawn brand-ground gradient over the
        caption zone that every full-frame insert carries — a chunk can cross
        stills of opposite polarity where no single text colour reads, so the
        ground guarantees the zone. Built once, shared by bursts and plates."""
        if not hasattr(self, "_burst_scrim"):
            import numpy as np
            from PIL import Image
            W, H = self.OW, self.OH
            a = np.zeros((H, W, 4), dtype="uint8")
            a[..., :3] = self.CHARCOAL[:3]
            fade = self.SCRIM_FADE_Y * self.CS
            col_a = (np.clip(1 - np.arange(H) / fade, 0, 1)
                     * self.SCRIM_ALPHA * 255).astype("uint8")
            a[..., 3] = col_a[:, None]
            self._burst_scrim = Image.fromarray(a)
        return self._burst_scrim

    def beat_from_cutaway(self, c):
        """The gate-side `cutaways[]` entry (cutaway_check.py's shape: start/
        end in OUTPUT time, `file` for a plate or `stills` for a burst),
        mapped to the shape this renderer has always consumed."""
        dur = float(c["end"]) - float(c["start"])
        if "stills" in c:
            b = {"stills": c["stills"], "out_start": c["start"], "duration": dur,
                 "suppress": c.get("suppress", [])}
            if c.get("sfx"):
                b["sfx"] = c["sfx"]
            return b
        return {"file": c["file"], "src": [0.0, dur], "out_start": c["start"],
                "suppress": c.get("suppress", []),
                "plate": Path(str(c["file"])).suffix.lower() in self.IMAGE_EXT}

    def prepare_plate(self, n, b):
        """A single cutaway plate (one still, AI-generated per
        docs/CUTAWAY-IMAGE-PROMPTS.md and treated into the brand world before
        it gets here) animated deterministically — SKILL.md step 5b: "Ken
        Burns push-in, cubic ease" — and carrying the same caption-zone
        brand ground as a burst, since captions continue over it."""
        from PIL import Image, ImageOps
        fps = self.J.get("fps", 30)
        dur = float(b["src"][1]) - float(b["src"][0])
        total = max(int(round(dur * fps)), 1)
        W, H = self.OW, self.OH
        im = ImageOps.exif_transpose(Image.open(self.jpath(b["file"]))).convert("RGB")
        # cover-fit the still to the canvas at MAX zoom once, so every frame is
        # a crop of one high-resolution source rather than a re-upscale
        BW, BH = int(W * self.PLATE_PUSH) + 2, int(H * self.PLATE_PUSH) + 2
        scale = max(BW / im.width, BH / im.height)
        im = im.resize((int(im.width * scale) + 1, int(im.height * scale) + 1), Image.LANCZOS)
        cx, cy = im.width // 2, im.height // 2
        fdir = self.edit / "animations" / f"plate_{n}"
        fdir.mkdir(parents=True, exist_ok=True)
        for f in range(total):
            t = f / max(total - 1, 1)
            z = 1 + (self.PLATE_PUSH - 1) * (1 - (1 - t) ** 3)
            cw, ch = int(round(W * self.PLATE_PUSH / z)), int(round(H * self.PLATE_PUSH / z))
            x0, y0 = cx - cw // 2, cy - ch // 2
            fr = im.crop((x0, y0, x0 + cw, y0 + ch)).resize((W, H), Image.LANCZOS).convert("RGBA")
            Image.alpha_composite(fr, self.burst_scrim()).convert("RGB").save(fdir / f"f{f:04d}.png")
        out = self.edit / "animations" / f"insert_{n}.mp4"
        run([FFMPEG, "-y", "-framerate", str(fps), "-i", fdir / "f%04d.png",
             "-c:v", "libx264", "-preset", "fast", "-crf", "17",
             "-pix_fmt", "yuv420p", *SDR_TAGS, out])
        return {"clip": out, "window": (b["out_start"], b["out_start"] + total / fps),
                "suppress": [tuple(x) for x in b.get("suppress", [])]}

    def prepare_beats(self):
        """Full-frame inserts: single legacy "beat" or a "beats" list
        (cutaways, playbook 4d: VO + captions continue over them). A list
        entry with "stills" is a v2 BURST (see prepare_burst); an entry whose
        `file` is a still image is a PLATE (see prepare_plate)."""
        self.sfx_events = []
        raw = self.J.get("beats", [])
        if self.J.get("beat"):
            raw = [self.J["beat"]] + list(raw)
        if not raw and self.J.get("cutaways"):
            # The gate (cutaway_check.py) reads `cutaways[]`; this renderer
            # read only `beats[]`. Two names for one schedule meant a job
            # written for the gate rendered ZERO cutaways, silently — the
            # workflow declares them once, in the gate's shape, and this
            # derives the renderer's shape from it.
            raw = [self.beat_from_cutaway(c) for c in self.J["cutaways"]]
        beats = []
        for n, b in enumerate(raw):
            if "stills" in b:
                beats.append(self.prepare_burst(n, b))
                continue
            if b.get("plate") or Path(str(b["file"])).suffix.lower() in self.IMAGE_EXT:
                beats.append(self.prepare_plate(n, b))
                continue
            bs, be = b["src"]
            stretch = b.get("stretch", 1.0)
            out = self.edit / "animations" / f"insert_{n}.mp4"
            out.parent.mkdir(exist_ok=True)
            run([FFMPEG, "-y", "-ss", f"{bs:.3f}", "-i", self.jpath(b["file"]),
                 "-t", f"{(be - bs) * stretch:.3f}",
                 "-vf", f"scale={self.OW}:{self.OH},setsar=1,setpts=PTS*{stretch:.4f}", "-an",
                 "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                 "-pix_fmt", "yuv420p", "-r", str(self.J.get("fps", 30)), *SDR_TAGS, out])
            beats.append({"clip": out,
                          "window": (b["out_start"],
                                     b["out_start"] + (be - bs) * stretch),
                          "suppress": [tuple(x) for x in b.get("suppress", [])]})
        return beats

    def build_endcard(self):
        from PIL import Image, ImageDraw, ImageFont
        E = self.P["endcard"]
        cs = self.CS
        W, H = self.OW, self.OH
        img = Image.new("RGB", (W, H), self.CHARCOAL[:3])
        src = Image.open(self.ppath(E["logo_file"])).convert("RGBA")
        solid = Image.new("RGBA", src.size, hexrgb(E.get("logo_tint", "#FFFFFF")))
        logo = Image.new("RGBA", src.size, (0, 0, 0, 0))
        logo.paste(solid, (0, 0), src.split()[3])
        lw = E.get("logo_width", 220) * cs
        logo = logo.resize((lw, int(logo.height * lw / logo.width)))
        img.paste(logo, ((W - lw) // 2, int(H * 0.38) - logo.height // 2), logo)
        d = ImageDraw.Draw(img)
        y_word = int(H * 0.38) + logo.height // 2 + 56 * cs
        # A brand may supply its wordmark as outlined artwork and forbid
        # re-typesetting it in a substitute face (The Pitch by Deel s239/s257:
        # "always place the vector, never set it live in a system font").
        # wordmark_file takes precedence; wordmark_text stays the default so
        # profiles written against the old shape are unaffected.
        wm_file = E.get("wordmark_file")
        if wm_file:
            wsrc = Image.open(self.ppath(wm_file)).convert("RGBA")
            tint = E.get("wordmark_tint")
            if tint:
                solid_w = Image.new("RGBA", wsrc.size, hexrgb(tint))
                wm = Image.new("RGBA", wsrc.size, (0, 0, 0, 0))
                wm.paste(solid_w, (0, 0), wsrc.split()[3])
            else:
                wm = wsrc
            ww = E.get("wordmark_width", 560) * cs
            wm = wm.resize((ww, int(wm.height * ww / wm.width)))
            img.paste(wm, ((W - ww) // 2, y_word), wm)
            y_eyebrow = y_word + wm.height + 46 * cs
        elif E.get("wordmark_text"):
            word = ImageFont.truetype(str(self.ppath(E["wordmark_font_file"])),
                                      E.get("wordmark_size", 64) * cs)
            tw = d.textlength(E["wordmark_text"], font=word)
            d.text(((W - tw) / 2, y_word), E["wordmark_text"], font=word,
                   fill=self.PAPER)
            y_eyebrow = y_word + 110 * cs
        else:
            # logo_file is an approved lockup that already carries the wordmark,
            # so drawing a second one would print the name twice.
            y_eyebrow = y_word
        mono = ImageFont.truetype(str(self.ppath(E["eyebrow_font_file"])),
                                  E.get("eyebrow_size", 26) * cs)
        track = E.get("eyebrow_tracking", 8) * cs
        text = self.J.get("endcard_override") or E["eyebrow_text"]
        total = sum(mono.getlength(c) + track for c in text) - track
        x = (W - total) / 2
        for ch in text:
            d.text((x, y_eyebrow), ch, font=mono, fill=self.ACCENT)
            x += mono.getlength(ch) + track
        img.save(self.edit / "endcard.png")
        run([FFMPEG, "-y", "-loop", "1", "-i", self.edit / "endcard.png",
             "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
             "-vf", SETPARAMS,
             "-t", f"{E.get('duration_s', 2.0):.1f}",
             "-r", str(self.J.get("fps", 30)),
             "-c:v", "libx264", "-preset", "fast", "-crf", "20",
             "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
             *SDR_TAGS, "-movflags", "+faststart", self.edit / "endcard.mp4"])

    def composite(self, events, beats):
        suppress = [w for b in beats for w in b["suppress"]] + \
            [tuple(x) for x in self.J.get("caption_suppress", [])]
        kept = [ev for ev in events
                if not any(ev["start"] < we and ev["end"] > ws
                           for ws, we in suppress)]
        if len(kept) < len(events):
            print(f"  captions suppressed during beat: {len(events) - len(kept)}")
        inputs = ["-i", self.edit / "base.mp4"]
        base_dur = float(subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(self.edit / "base.mp4")],
            capture_output=True, text=True).stdout)
        parts, cur, idx = [], "[0:v]", 0
        for beat in beats:
            ws, we = beat["window"]
            # a beat running to the video end must cover EVERY last frame —
            # eof_action=repeat holds the beat's final frame over PTS rounding
            # gaps, and the enable window is pushed past the base end so no
            # footage frame can flash before the endcard (Lola 2026-07-13)
            if we >= base_dur - 0.05:
                we = base_dur + 0.5
            idx += 1
            inputs += ["-i", beat["clip"]]
            parts.append(f"[{idx}:v]setpts=PTS-STARTPTS+{ws:.3f}/TB[ins{idx}]")
            parts.append(f"{cur}[ins{idx}]overlay=0:0:eof_action=repeat:"
                         f"enable='between(t,{ws:.3f},{we:.3f})'[v{idx}]")
            cur = f"[v{idx}]"
        # deterministic graphic overlays (the ~20% design layer) — under
        # captions (Rule 1), in the client's LOCKED style, word-perfect
        for ov in self.J.get("overlays", []):
            idx += 1
            is_seq = "%" in str(ov["file"])
            if is_seq:
                inputs += ["-framerate", str(self.J.get("fps", 30)),
                           "-start_number", "0", "-i", self.jpath(ov["file"])]
            else:
                inputs += ["-i", self.jpath(ov["file"])]
            # pre-chain: scale graphics to canvas, time-shift sequences
            chain = []
            if self.CS > 1:
                chain.append(f"scale=iw*{self.CS}:ih*{self.CS}")
            if is_seq:
                chain.append(f"setpts=PTS-STARTPTS+{ov['start']:.3f}/TB")
            src_lbl = f"[{idx}:v]"
            if chain:
                parts.append(f"{src_lbl}{','.join(chain)}[ovp{idx}]")
                src_lbl = f"[ovp{idx}]"
            xv = ov.get("x", "center")
            if xv == "center":
                x = "(W-w)/2"
            elif xv == "auto-side":
                # place on the side AWAY from the detected face — an overlay
                # must never cover the person's face
                face_right = getattr(self, "face_cx_norm", 0.5) >= 0.5
                x = "60" if face_right else "W-w-60"  # graphic PNGs are pre-scaled
            else:
                x = str(int(xv) * self.CS)
            y = str(ov.get("y", 700) * self.CS)
            parts.append(f"{cur}{src_lbl}overlay={x}:{y}:eof_action=repeat:"
                         f"enable='between(t,{ov['start']:.3f},{ov['end']:.3f})'[v{idx}]")
            cur = f"[v{idx}]"
        # Caption height is footage-dependent, not a house constant: the band has
        # to miss the mouth AND land somewhere the accent still reads as ours.
        # On the Deel proof footage the old fixed 380 sat beside the venue's
        # yellow wayfinding signs, so the Cornbread marker stopped reading as a
        # brand spotlight. Default stays 380 so existing profiles are unchanged.
        cap_y = getattr(self, "cap_y_override", None) or self.caption_default_y()
        for ev in kept:
            idx += 1
            inputs += ["-i", ev["png"]]
            parts.append(f"{cur}[{idx}:v]overlay=(W-w)/2:{cap_y * self.CS}:"
                         f"enable='between(t,{ev['start']:.3f},{ev['end']:.3f})'[v{idx}]")
            cur = f"[v{idx}]"
        parts.append(f"{cur}{SETPARAMS}[vout]")
        cur = "[vout]"
        run([FFMPEG, "-y", *inputs, "-filter_complex", ";".join(parts),
             "-map", cur, "-map", "0:a",
             "-c:v", "libx264", "-preset", "fast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-c:a", "copy",
             "-movflags", "+faststart", self.edit / "captioned.mp4"])

    def mix_sfx(self):
        """Mix queued burst click SFX under the VO (normalize=0 so speech is
        untouched; final loudnorm still runs last). No events = no-op."""
        src = self.edit / "captioned.mp4"
        if not getattr(self, "sfx_events", None):
            return src
        out = self.edit / "captioned_sfx.mp4"
        inputs, parts, lbls = ["-i", src], [], []
        for k, (path, at, gain) in enumerate(self.sfx_events):
            inputs += ["-i", str(path)]
            ms = int(round(at * 1000))
            parts.append(f"[{k + 1}:a]volume={gain},"
                         f"adelay={ms}|{ms}[s{k}]")
            lbls.append(f"[s{k}]")
        parts.append(f"[0:a]{''.join(lbls)}"
                     f"amix=inputs={len(lbls) + 1}:duration=first:"
                     f"normalize=0[a]")
        run([FFMPEG, "-y", *inputs, "-filter_complex", ";".join(parts),
             "-map", "0:v", "-map", "[a]", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-movflags", "+faststart", out])
        print(f"  sfx mixed: {len(self.sfx_events)} events")
        return out

    def build(self):
        out_path = self.jpath(self.J["output"])
        print("extracting segments")
        segs = self.extract_segments()
        print("concat -> base.mp4")
        self.concat(segs, self.edit / "base.mp4")
        if self.until == "base":
            print(f"base: {self.edit / 'base.mp4'}")
            return
        print("captions")
        events = self.caption_events()
        self.render_caption_pngs(events)
        beats = self.prepare_beats()
        self.gate_captions_v2(events, beats)
        events = [ev for ev in events if ev.get("png")]
        print("endcard")
        self.build_endcard()
        print(f"compositing ({len(beats)} beats), captions LAST")
        self.finish(events, beats, out_path)
        fails = self.verify_captions_final(out_path, events, beats)
        if fails:
            alt = self.caption_alt_color()
            for i, cr, cd in fails:
                print(f"  POST-RENDER: chunk {i} body shipped "
                      f"low-contrast (CR {cr:.2f}, chroma {cd:.2f}) "
                      f"-> flip to {alt}")
                events[i]["body_color_override"] = alt
            self.render_caption_pngs_v2(events)
            print("re-finishing with tertiary flips")
            self.finish(events, beats, out_path)
            still = self.verify_captions_final(out_path, events, beats)
            if still:
                sys.exit(f"POST-RENDER caption check: {len(still)} "
                         f"chunk(s) still low-contrast after the "
                         f"tertiary flip — human call.")
        print(f"  post-render caption check: PASS "
              f"({len(events)} chunks verified on the final file)")
        dur = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(out_path)],
            capture_output=True, text=True).stdout.strip()
        print(f"done: {out_path}  duration={dur}s  (side-data clean)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--job", type=Path, required=True)
    ap.add_argument("--until", choices=("base", "full"), default="full",
                    help="base: stop after edit/base.mp4 (the footage timeline graphic_qa.py gates against)")
    a = ap.parse_args()
    Build(a.profile.resolve(), a.job.resolve(), until=a.until).build()


if __name__ == "__main__":
    main()
