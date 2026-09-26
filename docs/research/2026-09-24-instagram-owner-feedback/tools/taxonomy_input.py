"""Per-account within-account effect vectors for the taxonomy study.
d_i(v) = share of account i's best posts with tag value v minus share of its weakest posts with it.
Writes taxonomy-input.json (vectors + facts per account) and prints the value list used."""
import json, sys, collections, pathlib
JOURNALS, OUT, SCRAPE = sys.argv[1].split(','), sys.argv[2], sys.argv[3]
IND = {"karoslabs": "B2B marketing / AI agency", "geektime": "Tech news media (Hebrew)", "thepitchbydeel": "Startup / founder programs",
       "hankypanky": "Intimate apparel", "kindlyyours": "Intimate apparel", "sitti": "Creator economy / city-guide app",
       "xodigital": "Fintech / investing (Brazil)", "dontechno": "Music media & nightlife"}
FIELDS = ['format','cover_layout','headline_size','distinct_text_sizes','font_style','text_contrast','color_mood','hook_type','language_register','sentence_form','caption_length','cta','logo_position','human_face','visual_source','graphic_devices']
accts = {}
for J in JOURNALS:
    ev = [json.loads(l) for l in open(J) if l.strip()]
    starts = {e['key']: e.get('label','') for e in ev if e.get('type') == 'started'}
    for e in ev:
        if e.get('type') != 'result': continue
        lab = starts.get(e['key'], '')
        if lab.startswith('account:'): _, client, handle = lab.split(':', 2)
        elif lab.startswith('tag:'): client, handle = 'dontechno', lab.split(':', 1)[1]
        else: continue
        r = e.get('result') or {}
        if not r.get('ok'): continue
        h = handle.lstrip('@')
        a = accts.setdefault(h, {**r, 'clients': set(), 'handle': h}); a['clients'].add(client)
def vals(p, f):
    v = p.get(f)
    if v is None or v == '': return []
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]
prev = collections.Counter()
for a in accts.values():
    for p in a.get('posts', []):
        for f in FIELDS:
            for v in vals(p, f): prev[f'{f}={v}'] += 1
VALUES = [k for k, n in prev.most_common() if n >= 40][:48]
out = []
for h, a in accts.items():
    best = [p for p in a.get('posts', []) if p.get('group') == 'best']; worst = [p for p in a.get('posts', []) if p.get('group') == 'worst']
    if len(best) < 2 or len(worst) < 2: continue
    vec = {}
    for key in VALUES:
        f, v = key.split('=', 1)
        pb = sum(v in vals(p, f) for p in best) / len(best); pw = sum(v in vals(p, f) for p in worst) / len(worst)
        if any(v in vals(p, f) for p in best + worst): vec[key] = round(pb - pw, 3)
    prof = {}
    pf = pathlib.Path(SCRAPE) / h / 'profile.json'
    if pf.exists():
        try: prof = json.loads(pf.read_text())
        except Exception: prof = {}
    caps = []
    pp = pathlib.Path(SCRAPE) / h / 'posts.json'
    if pp.exists():
        try: caps = [ (p.get('caption') or '')[:160] for p in json.loads(pp.read_text())[:4] ]
        except Exception: caps = []
    out.append({'handle': h, 'clients': sorted(a['clients']), 'industries': sorted({IND[c] for c in a['clients']}), 'role': a.get('role'),
                'followers': a.get('followers') or prof.get('followers'), 'category': prof.get('category'), 'bio': (prof.get('biography') or '')[:200],
                'captions': caps, 'format_mix': a.get('format_mix'), 'visual_system': (a.get('visual_system') or '')[:300], 'vec': vec})
json.dump({'values': VALUES, 'accounts': out}, open(OUT, 'w'), indent=1)
print(len(out), 'accounts;', len(VALUES), 'tag values')
