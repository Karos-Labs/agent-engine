import json, base64, html, os, sys, datetime
root = sys.argv[1]; out = sys.argv[2]
m = {r["runId"]: r for r in json.load(open(os.path.join(root, "manifest.json")))}
ORDER = [  # letter, runId, display name, note
 ("A","pubsub-21254982994413907","KAROS Labs","latest run"),
 ("B","pubsub-21254987466423505","KAROS Labs","the run in Tomer's Hebrew report"),
 ("C","pubsub-21255292697877233","The Pitch by Deel","latest run · the one in your photo"),
 ("D","pubsub-21255132410207986","Geektime","latest run · single-image news post"),
 ("E","pubsub-20296546809871980","Hanky Panky","latest run"),
 ("F","pubsub-21255254988332367","Kindly Yours","latest run"),
 ("G","pubsub-21255328593979584","Sitti","latest run"),
 ("H","pubsub-21255292697884248","XO Digital","latest run · Portuguese"),
]
def b64(p): return base64.b64encode(open(p,"rb").read()).decode()
secs = []; nav = []
for letter, rid, name, note in ORDER:
    r = m[rid]; t = datetime.datetime.fromtimestamp(r["createdAt"]/1000, datetime.timezone.utc)
    local = (t - datetime.timedelta(hours=3)).strftime("%H:%M")
    tiles = []
    for s in r["slides"]:
        src = s["file"].replace(".png", ".hi.jpg")
        code = f"{letter}{s['n']}"
        kind = s["template"].replace("-", " ") or "slide"
        extra = " · photo" if s["hasImage"] else ""
        if s["device"]: extra += f" · {s['device'].replace('_',' ')}"
        alt = html.escape(" / ".join(s["text"])[:300])
        tiles.append(f'<figure class="tile" data-code="{code}"><button type="button" class="shot" aria-label="Open {code}"><img loading="lazy" alt="{alt}" src="data:image/jpeg;base64,{b64(src)}"></button><figcaption><b>{code}</b><span>{html.escape(kind)}{html.escape(extra)}</span></figcaption></figure>')
    cap = html.escape(r.get("caption") or "").replace("\n", "<br>")
    tags = " ".join("#" + html.escape(h) for h in r.get("hashtags") or [])
    status = {"awaiting_gate": "waiting at the review gate", "completed": "completed"}.get(r["status"], r["status"])
    secs.append(f'''<section id="c{letter}"><header><span class="letter">{letter}</span><div><h2>{html.escape(name)} <small>{html.escape(note)}</small></h2>
<p class="topic">{html.escape(r.get("topic") or "")}</p>
<p class="meta">{local} your time · {status} · ${r["costUsd"]:.2f} · {len(r["slides"])} slide{"s" if len(r["slides"])!=1 else ""} · <code>{rid}</code></p></div></header>
<div class="row">{"".join(tiles)}</div>
<details><summary>Caption{(" & hashtags" if tags else "")}</summary><p>{cap}</p><p class="tags">{tags}</p></details></section>''')
    nav.append(f'<a href="#c{letter}"><b>{letter}</b> {html.escape(name)}</a>')
page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instagram run review</title>
<style>
:root{{--bg:#f4f2ee;--panel:#fff;--ink:#1b1a18;--muted:#6b675f;--line:#e2ddd4;--accent:#ff6b2c;--tile:#e9e5de}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16140f;--panel:#1f1c17;--ink:#f1ede6;--muted:#a59f94;--line:#332f28;--tile:#2a2620}}}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}}
.wrap{{max-width:1400px;margin:0 auto;padding:20px 16px 60px}}
h1{{font-size:22px;margin:0 0 4px}} .lede{{color:var(--muted);margin:0 0 14px;max-width:70ch}}
nav{{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;border-bottom:1px solid var(--line)}}
nav a{{color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:13px;background:var(--panel)}} nav a b{{color:var(--accent)}}
section{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 18px;scroll-margin-top:56px}}
header{{display:flex;gap:12px;align-items:flex-start;margin-bottom:10px}}
.letter{{flex:none;width:34px;height:34px;border-radius:8px;background:var(--accent);color:#fff;font-weight:700;display:grid;place-items:center;font-size:18px}}
h2{{font-size:17px;margin:0}} h2 small{{font-weight:400;color:var(--muted);font-size:13px;margin-left:6px}}
.topic{{margin:2px 0 0;font-weight:500}} .meta{{margin:2px 0 0;color:var(--muted);font-size:12.5px}} code{{font-size:11.5px}}
.row{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}}
.tile{{margin:0}} .shot{{all:unset;cursor:zoom-in;display:block;border-radius:6px;overflow:hidden;background:var(--tile);aspect-ratio:3/4;outline-offset:2px}}
.shot:focus-visible{{outline:2px solid var(--accent)}} .shot img{{width:100%;height:100%;object-fit:cover;display:block}}
figcaption{{font-size:12px;color:var(--muted);margin-top:4px;display:flex;gap:6px;align-items:baseline}} figcaption b{{color:var(--ink);font-size:13px}}
details{{margin-top:10px;font-size:14px}} summary{{cursor:pointer;color:var(--muted)}} .tags{{color:var(--muted)}}
#lb{{position:fixed;inset:0;background:rgba(10,9,7,.94);display:none;z-index:9;align-items:center;justify-content:center;flex-direction:column;padding:12px}}
#lb.on{{display:flex}} #lb img{{max-width:100%;max-height:calc(100vh - 70px);border-radius:4px}}
#lb .bar{{color:#eee;margin-top:8px;display:flex;gap:14px;align-items:center;font-size:14px}}
#lb button{{background:#333;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:14px;cursor:pointer}}
</style></head><body><div class="wrap">
<h1>Tomer's Instagram runs, 24 Sep</h1>
<p class="lede">These are the latest agent-engine runs for each client, taken straight from the prep run records. Every slide has a code (A1, C4…). Tap a slide to enlarge it and use the arrow keys to move between slides. To give feedback, reply in chat with codes, for example “C2–C7 all look the same” or “E5 quote is cut off”.</p>
<nav>{"".join(nav)}</nav>
{"".join(secs)}
</div>
<div id="lb" role="dialog" aria-modal="true"><img alt=""><div class="bar"><button type="button" data-d="-1">‹ Prev</button><b id="lbc"></b><button type="button" data-d="1">Next ›</button><button type="button" id="lbx">Close</button></div></div>
<script>
const tiles=[...document.querySelectorAll('.tile')];const lb=document.getElementById('lb');const im=lb.querySelector('img');const lbc=document.getElementById('lbc');let i=0;
function show(k){{i=(k+tiles.length)%tiles.length;const t=tiles[i];im.src=t.querySelector('img').src;im.alt=t.querySelector('img').alt;lbc.textContent=t.dataset.code+' · '+t.querySelector('figcaption span').textContent;lb.classList.add('on');}}
tiles.forEach((t,k)=>t.querySelector('.shot').addEventListener('click',()=>show(k)));
lb.querySelectorAll('[data-d]').forEach(b=>b.addEventListener('click',e=>{{e.stopPropagation();show(i+Number(b.dataset.d));}}));
document.getElementById('lbx').addEventListener('click',()=>lb.classList.remove('on'));
lb.addEventListener('click',e=>{{if(e.target===lb)lb.classList.remove('on');}});
document.addEventListener('keydown',e=>{{if(!lb.classList.contains('on'))return;if(e.key==='Escape')lb.classList.remove('on');if(e.key==='ArrowRight')show(i+1);if(e.key==='ArrowLeft')show(i-1);}});
</script></body></html>'''
open(out, "w").write(page)
print(out, round(os.path.getsize(out)/1e6, 1), "MB")
