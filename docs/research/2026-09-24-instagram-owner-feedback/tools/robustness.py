"""Second check of the grouping test: tuned k (leave-one-account-out over a grid), data cleaning
(drop tagged posts <3 days old at scrape time, drop hidden-likes accounts), carousel-only, and
data-derived facets (format mix, photo-led vs type-led, size)."""
import json, sys, os, time, random, pathlib
W = sys.argv[1].split(','); SCR = pathlib.Path(sys.argv[2]); LAB = json.load(open(sys.argv[3]))
IND = {"karoslabs": "B2B marketing", "geektime": "Tech news (he)", "thepitchbydeel": "Startups", "hankypanky": "Intimates", "kindlyyours": "Intimates", "sitti": "City/creator app", "xodigital": "Fintech (pt)", "dontechno": "Music media"}
F = ['format','cover_layout','headline_size','distinct_text_sizes','font_style','text_contrast','color_mood','hook_type','language_register','sentence_form','caption_length','cta','logo_position','human_face','visual_source','graphic_devices']
acc = {}
for J in W:
    ev = [json.loads(l) for l in open(J) if l.strip()]; st = {}
    for e in ev:
        if e.get('type') == 'started': st.setdefault(e['key'], e.get('label', ''))
    for e in ev:
        if e.get('type') != 'result': continue
        lab = st.get(e['key'], ''); r = e.get('result') or {}
        if lab.startswith('account:'): _, c, h = lab.split(':', 2)
        elif lab.startswith('tag:'): c, h = 'dontechno', lab[4:]
        elif lab.startswith('enrich:'): _, c, h = lab.split(':', 2); IND.setdefault(c, c)
        else: continue
        if r.get('ok'): acc.setdefault(h.lstrip('@').lower(), (c, r))
labels = {l['handle'].lstrip('@').lower(): l for l in LAB}
def vals(p, f):
    v = p.get(f)
    return [] if v in (None, '') else ([str(x) for x in v] if isinstance(v, list) else [str(v)])
def meta(h):
    d = SCR / h; posts = {}; hidden = False; t0 = None
    try:
        pl = json.loads((d / 'posts.json').read_text()); posts = {p['code']: p for p in pl}
        hidden = sum(1 for p in pl if p.get('likes_hidden') or (p.get('likes') or 0) <= 3) > 0.5 * len(pl)
        t0 = os.path.getmtime(d / 'posts.json')
        fm = {}
        for p in pl: fm[p['kind']] = fm.get(p['kind'], 0) + 1
    except Exception: pl, fm = [], {}
    return posts, hidden, t0, fm
rows = []
for h, (c, r) in acc.items():
    posts, hidden, t0, fm = meta(h)
    tagged = []
    for p in r.get('posts', []):
        pm = posts.get(p.get('code'), {})
        age_d = (t0 - pm['taken_at']) / 86400 if (t0 and pm.get('taken_at')) else None
        tagged.append((p, age_d))
    n = sum(fm.values()) or 1
    fmix = 'reel-led' if fm.get('reel', 0) / n >= 0.5 else 'carousel-led' if fm.get('carousel', 0) / n >= 0.5 else 'mixed'
    photo = sum(1 for p, _ in tagged if p.get('group') == 'best' and any(v.startswith('real photo') for v in vals(p, 'visual_source')))
    nb = sum(1 for p, _ in tagged if p.get('group') == 'best') or 1
    style = 'photo-led' if photo / nb >= 0.5 else 'type/graphic-led'
    f = r.get('followers') or 0
    size = '<10k' if f < 1e4 else '10k-100k' if f < 1e5 else '100k-1M' if f < 1e6 else '>1M'
    rows.append(dict(h=h, client=c, industry=IND[c], hidden=hidden, tagged=tagged, fmix=fmix, style=style, size=size, lab=labels.get(h, {})))
def vectors(rs, drop_young=False, carousel_only=False):
    out = []
    for a in rs:
        b = [p for p, age in a['tagged'] if p.get('group') == 'best' and not (drop_young and age is not None and age < 3) and (not carousel_only or p.get('format') == 'carousel')]
        w = [p for p, age in a['tagged'] if p.get('group') == 'worst' and not (drop_young and age is not None and age < 3) and (not carousel_only or p.get('format') == 'carousel')]
        if len(b) < 2 or len(w) < 2: continue
        vec = {}
        for f in F:
            for v in {v for p in b + w for v in vals(p, f)}:
                vec[f'{f}={v}'] = sum(v in vals(p, f) for p in b) / len(b) - sum(v in vals(p, f) for p in w) / len(w)
        out.append((a, vec))
    return out
def skill(data, lab, k):
    keys = {}
    for i, (_, vec) in enumerate(data):
        for v, d in vec.items(): keys.setdefault(v, []).append((i, d))
    seT = seG = 0.0
    for v, idx in keys.items():
        if len(idx) < 8: continue
        tot = sum(d for _, d in idx); gs = {}; gc = {}
        for i, d in idx: gs[lab[i]] = gs.get(lab[i], 0) + d; gc[lab[i]] = gc.get(lab[i], 0) + 1
        for i, d in idx:
            gm = (tot - d) / (len(idx) - 1); c = gc[lab[i]] - 1; pred = gm
            if c > 0: w = c / (c + k); pred = w * (gs[lab[i]] - d) / c + (1 - w) * gm
            seT += (d - pred) ** 2; seG += (d - gm) ** 2
    return 1 - seT / seG if seG else 0
rng = random.Random(7)
def perm(data, lab, k, obs, reps=199):
    ge = 0
    for _ in range(reps):
        sh = lab[:]; rng.shuffle(sh); ge += skill(data, sh, k) >= obs
    return (ge + 1) / (reps + 1)
G = {'industry': lambda a: a['industry'], 'archetype': lambda a: a['lab'].get('archetype', '?'), 'involvement': lambda a: a['lab'].get('involvement', '?'),
     'audience': lambda a: a['lab'].get('audience', '?'), 'content_job': lambda a: a['lab'].get('content_job', '?'), 'size': lambda a: a['size'],
     'format_mix': lambda a: a['fmix'], 'visual_style': lambda a: a['style'], 'fmix x style': lambda a: a['fmix'] + '|' + a['style']}
KS = [1, 3, 10, 30, 100]
res = {}
for name, cfg in {'baseline': dict(), 'no_young_posts': dict(drop_young=True), 'carousels_only': dict(carousel_only=True)}.items():
    for hidden_filter in [False, True]:
        rs = [a for a in rows if not (hidden_filter and a['hidden'])]
        data = vectors(rs, **cfg)
        tag = name + ('+no_hidden_likes' if hidden_filter else '')
        out = []
        for g, fn in G.items():
            lab = [fn(a) for a, _ in data]
            best_k, best = max(((k, skill(data, lab, k)) for k in KS), key=lambda x: x[1])
            out.append({'grouping': g, 'best_k': best_k, 'skill': round(best, 4), 'perm_p': round(perm(data, lab, best_k, best, 99), 3)})
        out.sort(key=lambda r: -r['skill']); res[tag] = {'accounts': len(data), 'rows': out}
        print(tag, len(data), [(r['grouping'], r['skill'], r['perm_p']) for r in out[:4]])
json.dump(res, open(sys.argv[4], 'w'), indent=1)
