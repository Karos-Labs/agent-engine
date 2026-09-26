#!/usr/bin/env python3
"""ScrappyCoco wrapper for the 2026-09-24 Instagram feedback round.

Reuses don-techno-auto's ScrappyCoco client (pinned CLI, retries, idempotency
keys, single-flight lock, balance-floor halt). Every result is cached under
research/scrape/<handle>/, so a repeat call is free. One runaway guard
(SC_GUARD_USD, default 4.50) over this round's ledger; the planned spend is
~$0.008 per account, so the guard only stops a bug, never a normal scrape.

  sc.py profile <handle>          profile.json (followers, bio, category)
  sc.py posts <handle> [--n 30]   posts.json (normalised) + stats.json (outliers)
  sc.py media <handle>            downloads covers + outlier/baseline carousels, builds contact sheets
  sc.py account <handle>          profile + posts + media in one go (what agents call)
  sc.py spend                     ledger total for this round
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import time
import json
import os
import pathlib
import statistics
import subprocess
import sys
import urllib.request
from decimal import Decimal

sys.path.insert(0, os.path.expanduser("~/Code/don-techno-auto"))
os.environ.setdefault("SCRAPPYCOCO_SKILL_AUTO_UPDATE", "0")
from dontechno.discovery.sources import scrappycoco as sc  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent / "research" / "scrape"
SLOTS = int(os.environ.get("SC_SLOTS", "3"))
SLOT_DIR = pathlib.Path.home() / ".cache" / "karos-feedback-round"


@contextlib.contextmanager
def _slots(lock_path=None):
    """Up to SLOTS in-flight ScrappyCoco calls across every process on this Mac.
    The account reserves $1.00 per in-flight call on top of a $1.00 floor, so
    3 slots stay safe on a ~$5 balance (don-techno keeps its own lock at 1)."""
    SLOT_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        for i in range(SLOTS):
            fh = open(SLOT_DIR / f"slot{i}.lock", "a+")
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fh.close()
                continue
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                fh.close()
            return
        time.sleep(1.5)


sc._single_flight = _slots
LEDGER = ROOT / "ledger.jsonl"
GUARD = Decimal(os.environ.get("SC_GUARD_USD", "4.50"))


def clean(handle: str) -> str:
    h = handle.strip().lstrip("@").strip("/")
    if "instagram.com/" in h:
        h = h.split("instagram.com/")[1].split("/")[0].split("?")[0]
    return h.lower()


def guard(next_call: str = "0.01") -> None:
    total, _ = sc.ledger_spend(sc._read_rows(LEDGER)) if LEDGER.exists() else (Decimal("0"), 0)
    if total + Decimal(next_call) > GUARD:
        raise SystemExit(f"runaway guard: ledger at ${total}, guard ${GUARD}")


def dig(obj, *keys, default=None):
    for k in keys:
        if isinstance(obj, dict) and k in obj:
            obj = obj[k]
        else:
            return default
    return obj


def first(*vals):
    for v in vals:
        if v not in (None, "", [], {}):
            return v
    return None


def raw_item(rec):
    return sc._raw_item(rec)


def best_image(item) -> str | None:
    cands = dig(item, "image_versions2", "candidates") or dig(item, "image_versions", "items") or []
    if isinstance(cands, list) and cands:
        c = max(cands, key=lambda x: (x.get("width") or 0) if isinstance(x, dict) else 0)
        return c.get("url") if isinstance(c, dict) else None
    return first(item.get("display_url"), item.get("thumbnail_url"), item.get("image_url"), dig(item, "thumbnail_src"))


def normalise_post(rec) -> dict:
    it = raw_item(rec)
    media_type = it.get("media_type")
    product = it.get("product_type") or ""
    kids = it.get("carousel_media") or dig(it, "edge_sidecar_to_children", "edges") or []
    if kids and isinstance(kids[0], dict) and "node" in kids[0]:
        kids = [k["node"] for k in kids]
    if media_type == 8 or kids:
        kind = "carousel"
    elif media_type == 2 or product == "clips" or it.get("is_video"):
        kind = "reel" if product == "clips" or it.get("is_video") else "video"
    else:
        kind = "image"
    code = first(it.get("code"), it.get("shortcode"))
    cap_edges = dig(it, "edge_media_to_caption", "edges")
    caption = first(dig(it, "caption", "text"),
                    it.get("caption") if isinstance(it.get("caption"), str) else None,
                    dig(cap_edges[0], "node", "text") if isinstance(cap_edges, list) and cap_edges else None)
    likes = first(it.get("like_count"), dig(it, "edge_liked_by", "count"), dig(it, "edge_media_preview_like", "count"))
    comments = first(it.get("comment_count"), dig(it, "edge_media_to_comment", "count"))
    views = first(it.get("play_count"), it.get("ig_play_count"), it.get("view_count"), it.get("video_view_count"))
    ts = first(it.get("taken_at"), it.get("taken_at_timestamp"))
    slides = [u for u in (best_image(k) for k in kids) if u] if kids else []
    return {
        "code": code,
        "url": f"https://www.instagram.com/p/{code}/" if code else None,
        "taken_at": ts,
        "kind": kind,
        "slides": len(kids) if kids else 1,
        "likes": likes if isinstance(likes, int) and likes >= 0 else None,
        "likes_hidden": bool(it.get("like_and_view_counts_disabled")),
        "comments": comments if isinstance(comments, int) else None,
        "views": views if isinstance(views, int) else None,
        "pinned": bool(sc.record_pinned(rec)),
        "caption": (caption or "")[:1500],
        "cover_url": best_image(it) or (slides[0] if slides else None),
        "slide_urls": slides,
    }


def normalise_profile(resp) -> dict:
    recs = resp.get("records") or []
    it = raw_item(recs[0]) if recs else {}
    user = it.get("user") if isinstance(it.get("user"), dict) else dig(it, "data", "user") or it
    return {
        "username": first(user.get("username"), it.get("username")),
        "full_name": user.get("full_name"),
        "followers": first(user.get("follower_count"), dig(user, "edge_followed_by", "count")),
        "following": first(user.get("following_count"), dig(user, "edge_follow", "count")),
        "media_count": first(user.get("media_count"), dig(user, "edge_owner_to_timeline_media", "count")),
        "category": first(user.get("category_name"), user.get("category"), user.get("business_category_name")),
        "is_verified": user.get("is_verified"),
        "biography": (user.get("biography") or "")[:400],
        "external_url": user.get("external_url"),
    }


def cmd_profile(h: str) -> dict:
    d = ROOT / h
    f = d / "profile.json"
    if f.exists():
        return json.loads(f.read_text())
    guard()
    d.mkdir(parents=True, exist_ok=True)
    resp = sc.profile_info("instagram", h, ledger_path=LEDGER)
    (d / "profile.raw.json").write_text(json.dumps(resp)[:2_000_000])
    prof = normalise_profile(resp)
    f.write_text(json.dumps(prof, indent=1))
    return prof


def engagement(p: dict) -> float | None:
    if p["likes"] is None and p["comments"] is None:
        return None
    return (p["likes"] or 0) + 3 * (p["comments"] or 0)


def cmd_posts(h: str, n: int = 30) -> dict:
    d = ROOT / h
    f = d / "posts.json"
    if not f.exists():
        guard("0.03")
        d.mkdir(parents=True, exist_ok=True)
        resp = sc.profile_posts("instagram", h, limit=n, max_posts=n + 6, stable_pages=1, ledger_path=LEDGER)
        (d / "posts.raw.json").write_text(json.dumps(resp)[:20_000_000])
        posts, seen = [], set()
        for rec in resp.get("records") or []:
            p = normalise_post(rec)
            if p["code"] and p["code"] not in seen:
                seen.add(p["code"])
                posts.append(p)
        posts.sort(key=lambda p: p["taken_at"] or 0, reverse=True)
        f.write_text(json.dumps(posts, indent=1))
    posts = json.loads(f.read_text())
    stats = compute_stats(h, posts)
    (d / "stats.json").write_text(json.dumps(stats, indent=1))
    return stats


def compute_stats(h: str, posts: list[dict]) -> dict:
    prof = json.loads((ROOT / h / "profile.json").read_text()) if (ROOT / h / "profile.json").exists() else {}
    followers = prof.get("followers") or None
    pool = [p for p in posts if engagement(p) is not None]
    med = statistics.median([engagement(p) for p in pool]) if pool else None
    ranked = []
    for p in posts:
        e = engagement(p)
        ranked.append({**{k: p[k] for k in ("code", "url", "kind", "slides", "likes", "comments", "views", "pinned", "taken_at")},
                       "engagement": e,
                       "multiple": round(e / med, 2) if (e is not None and med) else None,
                       "er_pct": round(100 * e / followers, 3) if (e is not None and followers) else None})
    ranked.sort(key=lambda r: (r["multiple"] is None, -(r["multiple"] or 0)))
    kinds = {}
    for p in posts:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    return {
        "handle": h, "followers": followers, "posts": len(posts), "kinds": kinds,
        "median_engagement": med,
        "median_er_pct": round(100 * med / followers, 3) if (med and followers) else None,
        "outliers": [r for r in ranked if (r["multiple"] or 0) >= 2.0],
        "ranked": ranked,
        "engagement_formula": "likes + 3*comments; multiple = post / account median over the scraped posts",
    }


def fetch(url: str, dest: pathlib.Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=40) as r:
            dest.write_bytes(r.read())
        return True
    except Exception:
        return False


def sheet(images: list[pathlib.Path], labels: list[str], out: pathlib.Path, tile: str = "360x450") -> None:
    if not images:
        return
    args = ["montage"]
    for img, lab in zip(images, labels):
        args += ["-label", lab, str(img)]
    args += ["-tile", f"{min(len(images), 6)}x", "-geometry", f"{tile}+8+8", "-background", "#f2f2f2",
             "-font", "/System/Library/Fonts/Supplemental/Arial.ttf", "-pointsize", "18", str(out)]
    subprocess.run(args, check=False, capture_output=True)


def cmd_media(h: str, top: int = 6, bottom: int = 6, full: int = 4) -> dict:
    d = ROOT / h
    posts = {p["code"]: p for p in json.loads((d / "posts.json").read_text())}
    stats = json.loads((d / "stats.json").read_text())
    m = d / "media"
    m.mkdir(exist_ok=True)
    scored = [r for r in stats["ranked"] if r["multiple"] is not None and not r["pinned"]]
    best, worst = scored[:top], list(reversed(scored[-bottom:])) if len(scored) > top else []
    out = {"best": [], "worst": [], "carousels": []}
    for group, rows in (("best", best), ("worst", worst)):
        imgs, labs = [], []
        for i, r in enumerate(rows, 1):
            p = posts[r["code"]]
            dest = m / f"{r['code']}-cover.jpg"
            if p["cover_url"] and fetch(p["cover_url"], dest):
                imgs.append(dest)
                labs.append(f"{group[0].upper()}{i} x{r['multiple']} {p['kind'][:4]}{'/' + str(p['slides']) if p['slides'] > 1 else ''}")
                out[group].append({"label": labs[-1].split()[0], "code": r["code"], "file": str(dest), "multiple": r["multiple"],
                                   "kind": p["kind"], "slides": p["slides"], "likes": p["likes"], "comments": p["comments"], "views": p["views"]})
        sheet(imgs, labs, d / f"sheet-{group}.jpg")
    for i, r in enumerate(best[:full], 1):
        p = posts[r["code"]]
        if p["kind"] != "carousel" or not p["slide_urls"]:
            continue
        files = []
        for j, u in enumerate(p["slide_urls"][:10], 1):
            dest = m / f"{r['code']}-s{j}.jpg"
            if fetch(u, dest):
                files.append(dest)
        sheet(files, [f"B{i}.{j}" for j in range(1, len(files) + 1)], d / f"carousel-B{i}-{r['code']}.jpg", tile="300x375")
        out["carousels"].append({"label": f"B{i}", "code": r["code"], "sheet": str(d / f"carousel-B{i}-{r['code']}.jpg"), "slides": len(files)})
    (d / "media.json").write_text(json.dumps(out, indent=1))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["profile", "posts", "media", "account", "spend"])
    ap.add_argument("handle", nargs="?")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--top", type=int, default=6)
    ap.add_argument("--bottom", type=int, default=6)
    ap.add_argument("--full", type=int, default=4)
    a = ap.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    if a.cmd == "spend":
        total, n = sc.ledger_spend(sc._read_rows(LEDGER)) if LEDGER.exists() else (Decimal("0"), 0)
        print(json.dumps({"spent_usd": str(total), "rows": n, "guard_usd": str(GUARD)}))
        return
    h = clean(a.handle)
    try:
        if a.cmd == "profile":
            print(json.dumps(cmd_profile(h), indent=1))
        elif a.cmd == "posts":
            s = cmd_posts(h, a.n)
            print(json.dumps({k: v for k, v in s.items() if k != "ranked"}, indent=1)[:4000])
        elif a.cmd == "media":
            print(json.dumps(cmd_media(h, a.top, a.bottom, a.full), indent=1))
        else:
            prof = cmd_profile(h)
            if not prof.get("username"):
                print(json.dumps({"handle": h, "error": "profile not found or private"}))
                return
            s = cmd_posts(h, a.n)
            med = cmd_media(h, a.top, a.bottom, a.full)
            print(json.dumps({"handle": h, "dir": str(ROOT / h), "profile": prof,
                              "stats": {k: v for k, v in s.items() if k not in ("ranked",)},
                              "media": med}, indent=1)[:12000])
    except sc.ScrappyCocoError as e:
        print(json.dumps({"handle": h, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(2)


if __name__ == "__main__":
    main()
