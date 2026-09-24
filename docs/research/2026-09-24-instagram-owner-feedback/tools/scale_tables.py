"""Scale tables for the layer auditors (2026-09-24 Instagram study).
Within-account comparisons (one vote per account): for each tag value, share of an
account's best posts carrying it minus share of its weakest posts carrying it.
Aggregated per client set, per industry (accounts deduped) and over all accounts,
with a sign test. Also: industry advancement profile and cross-industry transfer candidates."""
import json, sys, math, collections
JOURNALS, OUT = sys.argv[1].split(','), sys.argv[2]
IND = {"karoslabs": "B2B marketing / AI agency", "geektime": "Tech news media (Hebrew)", "thepitchbydeel": "Startup / founder programs",
       "hankypanky": "Intimate apparel", "kindlyyours": "Intimate apparel", "sitti": "Creator economy / city-guide app", "xodigital": "Fintech / investing (Brazil)", "dontechno": "Music media & nightlife"}
ONE = ['format','cover_layout','headline_size','distinct_text_sizes','font_style','text_contrast','color_mood','hook_type','language_register','sentence_form','caption_length','cta','logo_position','human_face']
MULTI = ['visual_source','graphic_devices']
NUM = ['cover_words','slides','words_per_interior_slide']
accts = {}
for J in JOURNALS:
  ev = [json.loads(l) for l in open(J) if l.strip()]
  starts = {e['key']: e.get('label','') for e in ev if e.get('type') == 'started'}
  for e in ev:
    if e.get('type') != 'result': continue
    lab = starts.get(e['key'], '')
    if lab.startswith('account:'):
        _, client, handle = lab.split(':', 2)
    elif lab.startswith('tag:'):
        client, handle = 'dontechno', lab.split(':', 1)[1]
    else:
        continue
    r = e.get('result') or {}
    if not r.get('ok'): continue
    h = handle.lstrip('@')
    a = accts.setdefault(h, {**r, 'clients': set(), 'handle': h})
    a['clients'].add(client)
def vals(p, f):
    v = p.get(f)
    if v is None or v == '': return []
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]
def binom_two_sided(k, n):
    if n == 0: return 1.0
    from math import comb
    p = sum(comb(n, i) for i in range(0, n + 1) if abs(i - n / 2) >= abs(k - n / 2)) / 2 ** n
    return min(1.0, p)
def account_diffs(a, f):
    best = [p for p in a.get('posts', []) if p.get('group') == 'best']
    worst = [p for p in a.get('posts', []) if p.get('group') == 'worst']
    if len(best) < 2 or len(worst) < 2: return {}
    out = {}
    allv = {v for p in best + worst for v in vals(p, f)}
    for v in allv:
        pb = sum(v in vals(p, f) for p in best) / len(best)
        pw = sum(v in vals(p, f) for p in worst) / len(worst)
        out[v] = (pb, pw)
    return out
def scale(accounts):
    rows = []
    for f in ONE + MULTI:
        per = collections.defaultdict(list)
        for a in accounts:
            for v, (pb, pw) in account_diffs(a, f).items(): per[v].append(pb - pw)
        for v, diffs in per.items():
            n = len(diffs); pos = sum(d > 0 for d in diffs); neg = sum(d < 0 for d in diffs)
            if n < 3: continue
            rows.append({'field': f, 'value': v, 'accounts': n, 'mean_diff': round(sum(diffs) / n, 3), 'pos': pos, 'neg': neg,
                         'sign_p': round(binom_two_sided(pos, pos + neg), 4) if pos + neg else 1.0})
    rows.sort(key=lambda r: (-abs(r['mean_diff']) * math.sqrt(r['accounts'])))
    nums = {}
    for f in NUM:
        diffs = []
        for a in accounts:
            b = [p.get(f) for p in a.get('posts', []) if p.get('group') == 'best' and isinstance(p.get(f), (int, float))]
            w = [p.get(f) for p in a.get('posts', []) if p.get('group') == 'worst' and isinstance(p.get(f), (int, float))]
            if b and w: diffs.append(sorted(b)[len(b)//2] - sorted(w)[len(w)//2])
        if diffs: nums[f] = {'accounts': len(diffs), 'median_best_minus_worst': sorted(diffs)[len(diffs)//2], 'pos': sum(d > 0 for d in diffs), 'neg': sum(d < 0 for d in diffs)}
    return {'n_accounts': len(accounts), 'rows': rows, 'numbers': nums}
def prevalence(accounts, f, v):
    posts = [p for a in accounts for p in a.get('posts', [])]
    return round(sum(v in vals(p, f) for p in posts) / max(1, len(posts)), 3)
all_accts = list(accts.values())
by_ind = collections.defaultdict(list); by_client = collections.defaultdict(list)
for a in all_accts:
    for c in a['clients']:
        by_client[c].append(a)
    for ind in {IND[c] for c in a['clients']}: by_ind[ind].append(a)
res = {'overall': scale(all_accts), 'industries': {k: scale(v) for k, v in by_ind.items()}, 'clients': {k: scale(v) for k, v in by_client.items()}}
# industry advancement profile
prof = {}
for ind, accs in by_ind.items():
    crafts = [a.get('craft_score') for a in accs if isinstance(a.get('craft_score'), (int, float))]
    ers = sorted(a.get('median_er_pct') for a in accs if isinstance(a.get('median_er_pct'), (int, float)))
    best = [p for a in accs for p in a.get('posts', []) if p.get('group') == 'best']
    lay = collections.Counter(p.get('cover_layout') for p in best)
    ent = -sum((c / len(best)) * math.log2(c / len(best)) for c in lay.values()) if best else 0
    dev = collections.Counter(d for p in best for d in vals(p, 'graphic_devices') if d != 'none')
    src = collections.Counter(s for p in best for s in vals(p, 'visual_source'))
    fmt = collections.Counter(p.get('format') for p in best)
    prof[ind] = {'accounts': len(accs), 'mean_craft': round(sum(crafts) / len(crafts), 2) if crafts else None, 'median_er_pct': ers[len(ers)//2] if ers else None,
                 'best_layout_entropy_bits': round(ent, 2), 'best_posts': len(best), 'top_layouts': lay.most_common(4), 'top_devices': dev.most_common(6),
                 'top_visual_sources': src.most_common(5), 'best_formats': fmt.most_common(4),
                 'top_craft_accounts': sorted(((a['handle'], a.get('craft_score')) for a in accs if a.get('craft_score')), key=lambda x: -x[1])[:5]}
res['industry_profile'] = prof
# transfer candidates: strong + consistent in source industry, rare in target industry, not contradicted there
cands = []
for src_ind, table in res['industries'].items():
    for r in table['rows']:
        if r['mean_diff'] < 0.15 or r['accounts'] < 4 or r['pos'] < 0.7 * (r['pos'] + r['neg']): continue
        for tgt_ind, accs in by_ind.items():
            if tgt_ind == src_ind: continue
            prev = prevalence(accs, r['field'], r['value'])
            if prev > 0.15: continue
            tgt_row = next((x for x in res['industries'][tgt_ind]['rows'] if x['field'] == r['field'] and x['value'] == r['value']), None)
            if tgt_row and tgt_row['mean_diff'] < -0.1 and tgt_row['accounts'] >= 4: continue
            cands.append({'pattern': f"{r['field']}={r['value']}", 'source': src_ind, 'source_mean_diff': r['mean_diff'], 'source_accounts': r['accounts'],
                          'source_consistency': f"{r['pos']}+/{r['neg']}-", 'target': tgt_ind, 'target_prevalence': prev,
                          'target_evidence': (f"{tgt_row['mean_diff']} over {tgt_row['accounts']} accts" if tgt_row else 'untested there')})
cands.sort(key=lambda c: -c['source_mean_diff'] * math.sqrt(c['source_accounts']))
res['transfer_candidates'] = cands
json.dump(res, open(OUT + '/scale.json', 'w'), indent=1, default=list)
# compact markdown for prompts
L = []
def table(title, t, top=30):
    L.append(f"### {title} (accounts={t['n_accounts']})")
    for r in t['rows'][:top]:
        L.append(f"- {r['field']}={r['value']}: mean within-account diff {r['mean_diff']:+.2f} over {r['accounts']} accts ({r['pos']}+/{r['neg']}-, sign p={r['sign_p']})")
    for f, s in t['numbers'].items():
        L.append(f"- {f}: median(best-worst) {s['median_best_minus_worst']} over {s['accounts']} accts ({s['pos']}+/{s['neg']}-)")
table('ALL ACCOUNTS', res['overall'], 40)
for k, t in res['industries'].items(): table(f'INDUSTRY {k}', t, 18)
L.append('### INDUSTRY ADVANCEMENT PROFILE')
for k, p in prof.items(): L.append(f"- {k}: {json.dumps(p)}")
L.append('### TRANSFER CANDIDATES (strong+consistent in source, rare in target)')
for c in cands[:40]: L.append(f"- {c['pattern']}: {c['source']} (diff {c['source_mean_diff']:+.2f}, {c['source_accounts']} accts, {c['source_consistency']}) -> {c['target']} (prevalence {c['target_prevalence']}, {c['target_evidence']})")
open(OUT + '/scale.md', 'w').write('\n'.join(L))
print(f"accounts={len(all_accts)} industries={ {k: len(v) for k, v in by_ind.items()} } transfer_candidates={len(cands)}")
print('\n'.join(L[:60]))
