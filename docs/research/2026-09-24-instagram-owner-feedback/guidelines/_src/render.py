import json, os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from l1 import L1_PARAMS, L1_LINES
from facets import FACETS
from kits_a import KITS_A
from kits_b import KITS_B
from kits_c import KITS_C
from dna_a import DNA_A
from dna_b import DNA_B
from dna_c import DNA_C
from meta import DEFECTS, DECISIONS, SUMMARY, README_INTRO
from resolved import RESOLVED

KITS = KITS_A + KITS_B + KITS_C
DNAS = DNA_A + DNA_B + DNA_C
written = []
problems = []

def w(name, text):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    written.append(p)

def fmt_line(s):
    m = re.match(r"^\[(MUST|DEFAULT|TRY|n/a)\]\[([a-z ]+)\] (.+)$", s)
    if not m:
        problems.append("bad line format: " + s[:80])
    if "(evidence:" not in s:
        problems.append("no evidence: " + s[:80])
    return s

# ---- DNA validator: resolved values against the L1 MUST gates (C-1, C-2, H-2, M-2, E-1)
LOGO_WORDS = re.compile(r"\b(logo|logotype|wordmark|lockup|monogram|mark|slice|badge|svg)\b", re.I)
PCT_SIZE = re.compile(r"~?\d+(\.\d+)?(-\d+(\.\d+)?)?% of (the )?(canvas |frame )?(width|height)|\d+px box", re.I)

def check_resolved(slug, r):
    errs = []
    for kind in ("cover", "interior"):
        sz = r[kind]
        H, T, S = sz.get("H"), sz.get("T"), sz.get("S")
        if H and T and H[1] / T[0] > 2.5 + 1e-9: errs.append(f"{kind} H:T {H[1]}/{T[0]}={H[1]/T[0]:.2f} > 2.5")
        if H and S and H[1] / S[0] > 4.0 + 1e-9: errs.append(f"{kind} H:S {H[1]}/{S[0]}={H[1]/S[0]:.2f} > 4")
        roles = [x for x in (H, T, S) if x]
        for big, small in zip(roles, roles[1:]):
            if big[0] / small[1] < 1.35 - 1e-9: errs.append(f"{kind} neighbours {big[0]}/{small[1]}={big[0]/small[1]:.2f} < 1.35")
        if T and T[0] < 36: errs.append(f"{kind} T {T[0]} < 36")
        if S and S[0] < (26 if r["S_caps"] else 30): errs.append(f"{kind} S {S[0]} under the floor (caps={r['S_caps']})")
        if kind == "cover" and H and H[0] < (64 if r["photoHook"] else 96): errs.append(f"cover H {H[0]} under the floor (photoHook={r['photoHook']})")
        if kind == "interior" and H and H[0] < 60: errs.append(f"interior H {H[0]} < 60")
    cap = 16 if r["coverKind"] == "photo" else 20
    if r["coverWords"] > cap: errs.append(f"cover words {r['coverWords']} > {cap} ({r['coverKind']})")
    if r["interiorWordsMax"] > 35: errs.append(f"interior words {r['interiorWordsMax']} > 35")
    lg = r["logo"]
    if set(lg) != {"variant", "position", "treatment", "presence", "size"} or lg["size"] != "L1 equal-area":
        errs.append("logo block may set only variant, position, treatment, presence; size must be 'L1 equal-area'")
    return errs

def scan_logo_sizes(slug, texts):
    errs = []
    for t in texts:
        for clause in re.split(r";|\. ", t):
            if re.search(r"down from|was |from a|raised from", clause): continue
            for m in PCT_SIZE.finditer(clause):
                window = clause[max(0, m.start() - 110): m.end()]
                if LOGO_WORDS.search(window):
                    errs.append("hand-set logo size: " + window.strip()[:140]); break
    return errs

# ---- L1
lines = ["# L1 platform: Instagram", "", "id: L1-platform · version 1.1 · owner: Albert (approves every L1 line and every MUST) · scope: every client, every run",
         "", "Mechanism lines with parameters; values come from the brand kit, the category pack or the client DNA. Performance claims here pool globally with one vote per account (183 accounts, `scale.md`); the null results are listed last as noise.", "",
         "## Params (L1 defaults; overrides named per key)", ""]
for name, val, ev, ov in L1_PARAMS:
    lines.append(f"- **{name}**: {val} (evidence: {ev}; overrides: {ov})")
lines += ["", "## Lines", ""]
groups = {}
order = ["process","strategy","format","cadence","imagery","graphics","font sizes","design","layout","logo","language","hook","other"]
for i,(rid,strength,dim,text,ev,enf) in enumerate(L1_LINES):
    groups.setdefault(dim, []).append((rid,strength,dim,text,ev,enf))
n = 0
for dim in order:
    if dim not in groups: continue
    lines.append(f"### {dim}")
    lines.append("")
    for rid,strength,d,text,ev,enf in groups[dim]:
        n += 1
        lines.append(f"{n}. [{strength}][{d}] {text} (evidence: {ev}) — id {rid}; enforced by: {enf}")
    lines.append("")
w("L1-platform.md", "\n".join(lines) + "\n")

# ---- kits and facets
for k in FACETS + KITS:
    if len(k["lines"]) > 25: problems.append(f"{k['id']} has {len(k['lines'])} lines")
    t = [f"# {k['kit']}", "", f"id: {k['id']} · version 1.1 · layer: L2 ({'facet card' if k['kind']=='facet' else 'category pack'}) · clients: {', '.join(k['clients']) if k['clients'] else 'n/a'}",
         "", "Standards and parameter values only; no line claims an engagement lift. Industry statistics appear as evidence refs (one vote per account, `scale.md`); a statistic from fewer than ~8 accounts is TRY-level evidence and never the basis of a DEFAULT on its own.", "",
         "## Params", "", k["params"], "", "## Lines", ""]
    for i, s in enumerate(k["lines"], 1):
        t.append(f"{i}. {fmt_line(s)}")
    if k.get("tries"):
        t += ["", "## Experiment queue (TRY)", ""] + [f"- {x}" for x in k["tries"]]
    w(k["file"], "\n".join(t) + "\n")

# ---- DNAs
for d in DNAS:
    if len(d["lines"]) > 15: problems.append(f"{d['slug']} has {len(d['lines'])} lines")
    if d["slug"] not in RESOLVED: problems.append(f"{d['slug']} has no resolved block")
    else:
        problems += [f"{d['slug']}: {e}" for e in check_resolved(d["slug"], RESOLVED[d["slug"]])]
    problems += [f"{d['slug']}: {e}" for e in scan_logo_sizes(d["slug"], [d["params"]] + d["lines"])]
    t = [f"# ig-dna-{d['slug']}", "", f"id: ig-dna-{d['slug']} · version 1.1 · layer: L3 · kit: {d['kit']} (+ facet-archetype, facet-involvement, facet-locale)",
         "", f"classification: {d['classification']}", "", "## Params", "", d["params"], "", "## Lines", ""]
    for i, s in enumerate(d["lines"], 1):
        t.append(f"{i}. {fmt_line(s)}")
    rv = RESOLVED.get(d["slug"])
    if rv:
        fmt_sz = lambda b: ", ".join(f"{k} {v[0]}-{v[1]}px" if v[0] != v[1] else f"{k} {v[0]}px" for k, v in b.items())
        t += ["", "## Resolved values checked against L1 (compileDNA input)", "",
              f"- cover: {fmt_sz(rv['cover'])}; interior: {fmt_sz(rv['interior'])}; meta in tracked caps: {'yes' if rv['S_caps'] else 'no'}; photo-hook cover: {'yes' if rv['photoHook'] else 'no'}",
              f"- cover words <= {rv['coverWords']} ({rv['coverKind']} cover); interior words <= {rv['interiorWordsMax']}",
              "- logo: " + "; ".join(f"{k} {v}" for k, v in rv["logo"].items())]
    t += ["", "## Kit lines skipped or narrowed (with reason)", ""] + [f"- {x}" for x in d["skipped_kit_lines"]]
    w(d["file"], "\n".join(t) + "\n")

# ---- README
r = [README_INTRO]
r.append("- `L1-platform.md`: L1 platform (" + str(len(L1_LINES)) + " lines, " + str(len(L1_PARAMS)) + " params)")
for k in FACETS + KITS:
    r.append(f"- `{k['file']}`: {k['kit']} ({len(k['lines'])} lines; clients: {', '.join(k['clients']) if k['clients'] else 'n/a'})")
for d in DNAS:
    r.append(f"- `{d['file']}`: {d['slug']} -> {d['kit']} ({len(d['lines'])} lines)")
r += ["", "## Defects mapped to build workstreams", ""]
for defect, ws, guard in DEFECTS:
    r.append(f"- **{ws}**: {defect}. Guard: {guard}")
r += ["", "## Decisions for the owner", ""]
for q, rec, ev in DECISIONS:
    r.append(f"- **Q.** {q}\n  - Recommendation: {rec}\n  - Evidence: {ev}")
SUMMARY_TXT = SUMMARY.format(n_l1=len(L1_LINES), n_params=len(L1_PARAMS), n_defects=len(DEFECTS), n_decisions=len(DECISIONS))
r += ["", "## Summary", "", SUMMARY_TXT, ""]
w("README.md", "\n".join(r))

# ---- JSON for the structured output
AUD = json.load(open(os.path.join(os.path.dirname(OUT), "auditors.json"), encoding="utf-8"))
ROWS = {row["id"]: row for row in AUD["rows"]}
def l1_extent(rid):
    ex = []
    for part in rid.split("/"):
        row = ROWS.get(part)
        if row: ex += [{"row": part, **e} for e in row.get("extent", [])]
    return ex
def client_extent(slug):
    return [{"row": row["id"], "verdict": e.get("verdict"), "note": e.get("note")} for row in AUD["rows"] for e in row.get("extent", []) if e.get("client") == slug]
out = {
 "summary": SUMMARY_TXT,
 "l1_platform": [{"id": rid, "line": f"[{s}][{d}] {t}", "strength": s, "dimension": d, "evidence": ev, "enforced_by": enf, "extent": l1_extent(rid)} for rid,s,d,t,ev,enf in L1_LINES],
 "industry_kits": [{"kit": k["kit"], "clients": k["clients"], "params": k["params"], "lines": k["lines"], "tries": k.get("tries", [])} for k in FACETS + KITS],
 "client_dna": [{"slug": d["slug"], "kit": d["kit"], "params": "classification: " + d["classification"] + " | " + d["params"], "lines": d["lines"], "skipped_kit_lines": d["skipped_kit_lines"], "resolved": RESOLVED.get(d["slug"]), "extent_verdicts": client_extent(d["slug"])} for d in DNAS],
 "parameters": [{"name": n_, "l1_default": v, "evidence": e, "overrides": o} for n_,v,e,o in L1_PARAMS],
 "defects_to_code": [{"defect": a, "workstream": b, "guard": c} for a,b,c in DEFECTS],
 "decisions_for_owner": [{"question": a, "recommendation": b, "evidence": c} for a,b,c in DECISIONS],
 "files_written": written,
}
with open(os.path.join(OUT, "guidelines.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("written", len(written), "files")
print("L1 lines", len(L1_LINES), "params", len(L1_PARAMS))
for k in FACETS + KITS: print(" kit", k["id"], len(k["lines"]))
for d in DNAS: print(" dna", d["slug"], len(d["lines"]))
print("extent keys:", sum(len(x["extent"]) for x in out["l1_platform"]), "on L1;", sum(len(x["extent_verdicts"]) for x in out["client_dna"]), "on DNAs")
print("PROBLEMS:", problems if problems else "none")
if problems: sys.exit(1)
print("json bytes", os.path.getsize(os.path.join(OUT, "guidelines.json")))
