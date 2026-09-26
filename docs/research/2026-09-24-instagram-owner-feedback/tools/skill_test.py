"""Leave-one-account-out skill of candidate groupings (taxonomy study).
Usage: skill_test.py taxonomy-input.json labels.json > result.json"""
import json, sys, random
inp = json.load(open(sys.argv[1])); labels = {l['handle'].lstrip('@').lower(): l for l in json.load(open(sys.argv[2]))}
def tier(f):
    if not f: return 'unknown'
    return '<10k' if f < 1e4 else '10k-100k' if f < 1e5 else '100k-1M' if f < 1e6 else '>1M'
acc = [a for a in inp['accounts'] if a['handle'].lower() in labels]
facts = [dict(labels[a['handle'].lower()], industry=a['industries'][0], size=tier(a.get('followers'))) for a in acc]
values = sorted({v for a in acc for v in a['vec']})
def skill(lab, k=3):
    seT = seG = 0.0; n = 0
    for v in values:
        idx = [(i, a['vec'][v]) for i, a in enumerate(acc) if v in a['vec']]
        if len(idx) < 4: continue
        tot = sum(d for _, d in idx); gs = {}; gc = {}
        for i, d in idx: gs[lab[i]] = gs.get(lab[i], 0) + d; gc[lab[i]] = gc.get(lab[i], 0) + 1
        for i, d in idx:
            gm = (tot - d) / (len(idx) - 1); c = gc[lab[i]] - 1; pred = gm
            if c > 0: w = c / (c + k); pred = w * (gs[lab[i]] - d) / c + (1 - w) * gm
            seT += (d - pred) ** 2; seG += (d - gm) ** 2; n += 1
    return (1 - seT / seG) if seG else 0.0
rng = random.Random(12345)
def perm_p(lab, obs, reps=199):
    ge = 0
    for _ in range(reps):
        sh = lab[:]; rng.shuffle(sh)
        if skill(sh) >= obs: ge += 1
    return (ge + 1) / (reps + 1)
C = ['industry', 'vertical', 'archetype', 'audience', 'involvement', 'content_job', 'visual_dependency', 'locale', 'size']
P = [('archetype', 'vertical'), ('archetype', 'locale'), ('involvement', 'content_job'), ('archetype', 'involvement'), ('vertical', 'locale'), ('audience', 'content_job'), ('archetype', 'visual_dependency')]
rows = []
for f in C + [f'{a} x {b}' for a, b in P]:
    lab = [x[f] if ' x ' not in f else f"{x[f.split(' x ')[0]]}|{x[f.split(' x ')[1]]}" for x in facts]
    s = skill(lab); rows.append({'grouping': f, 'groups': len(set(lab)), 'skill': round(s, 4), 'perm_p': round(perm_p(lab, s), 3)})
rows.sort(key=lambda r: -r['skill'])
dist = {f: {} for f in C}
for x in facts:
    for f in C: dist[f][x[f]] = dist[f].get(x[f], 0) + 1
print(json.dumps({'accounts': len(acc), 'skill': rows, 'distribution': dist}, indent=1))
