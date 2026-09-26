// READ-ONLY harvest: for each run, the final render's slide PNGs (via their signed URLs) + slide copy + topic + caption.
const { createRequire } = require("module"); const fs = require("fs"); const path = require("path");
const req = createRequire("/Users/albertkattan/Code/karos-portal/package.json");
const { initializeApp, cert } = req("firebase-admin/app"); const { getFirestore } = req("firebase-admin/firestore");
const env = Object.fromEntries(fs.readFileSync("/Users/albertkattan/Code/karos-portal/.env.local","utf8").split("\n").filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>{const i=l.indexOf("=");let v=l.slice(i+1).trim();if(/^['"]/.test(v))v=v.slice(1,-1);return[l.slice(0,i),v]}));
let raw=env.FIREBASE_SERVICE_ACCOUNT_KEY; if(!raw.trim().startsWith("{")) raw=Buffer.from(raw,"base64").toString("utf8");
const sa=JSON.parse(raw); if(sa.private_key) sa.private_key=sa.private_key.replace(/\\n/g,"\n");
const app=initializeApp({credential:cert(sa),projectId:sa.project_id}); const db=getFirestore(app,"prep");
const OUT = process.argv[2]; const runIds = process.argv.slice(3);
const attemptOf = id => { const m = id.match(/-attempt-(\d+)$/); return m ? Number(m[1]) : 0; };
function findKey(obj, key, depth = 0) { if (!obj || typeof obj !== "object" || depth > 6) return undefined; if (typeof obj[key] === "string" && obj[key].trim()) return obj[key]; for (const v of Object.values(obj)) { const r = findKey(v, key, depth + 1); if (r) return r; } }
(async () => {
  const manifest = [];
  for (const runId of runIds) {
    const run = (await db.collection("agentEngineRuns").doc(runId).get()).data();
    const steps = Object.fromEntries((await db.collection("agentEngineRuns").doc(runId).collection("steps").get()).docs.map(d => [d.id, d.data()]));
    const ids = Object.keys(steps);
    const renderId = ids.filter(i => i.startsWith("08-render-carousel") && steps[i].output?.result?.rendered?.length).sort((a,b)=>attemptOf(b)-attemptOf(a))[0];
    if (!renderId) { console.log(runId, "no render step"); continue; }
    const att = attemptOf(renderId);
    const slidesStep = steps[`07c-emit-slides-data-attempt-${att}`] || steps[ids.filter(i=>i.startsWith("07c-emit-slides-data")).sort((a,b)=>attemptOf(b)-attemptOf(a))[0]];
    const slides = slidesStep?.output?.slides ?? [];
    // caption: newest step output that carries a top-level-ish "caption" string
    let caption; for (const i of ids.filter(i => /^(05r-revise-copy|05-write-copy|07c|08c)/.test(i)).sort((a,b)=>attemptOf(b)-attemptOf(a) || b.localeCompare(a))) { caption = findKey(steps[i].output, "caption"); if (caption) break; }
    const pkg = steps["08c-package-post"]?.output?.finalOutput ?? {};
    const topicStep = steps["03g-select-topic"]?.output ?? {}; const mode = steps["03d-select-content-mode"]?.output;
    const dir = path.join(OUT, runId); fs.mkdirSync(dir, { recursive: true });
    const rendered = steps[renderId].output.result.rendered;
    const out = [];
    for (const r of rendered) {
      const file = path.join(dir, `slide-${r.n}.png`);
      if (!fs.existsSync(file)) { const res = await fetch(r.path); if (!res.ok) { console.log(runId, "slide", r.n, "HTTP", res.status); continue; } fs.writeFileSync(file, Buffer.from(await res.arrayBuffer())); }
      const s = slides.find(x => x.n === r.n) || {};
      const f = s.fields || {};
      const text = ["title","headline","subtitle","body","stat","statLabel","quote","attribution","cta","question"].map(k => f[k]).filter(Boolean);
      out.push({ n: r.n, file, template: (s.template || "").replace(/\.html$/, ""), placement: f.figurePlacement || "", hasImage: Boolean(s.images && Object.keys(s.images).length), device: f.deviceKind || "", text });
    }
    manifest.push({ runId, client: run.clientSlug, status: run.status, costUsd: run.totalCostUsd, createdAt: run.createdAt, renderAttempt: att,
      topic: topicStep.topic, topicHeadline: topicStep.headline, topicMode: topicStep.mode, contentMode: mode && (mode.mode || mode.contentMode || mode.selected),
      caption, hashtags: pkg.hashtags || [], firstComment: pkg.firstCommentText, slides: out });
    console.log(runId, run.clientSlug, "attempt", att, "slides", out.length, "caption", caption ? caption.length + "ch" : "none");
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
  process.exit(0);
})().catch(e => { console.error("ERR", e.stack); process.exit(1); });
