// READ-ONLY: every instagram-agent run in prep since a cutoff, and whether a portal job points at it.
const { createRequire } = require("module"); const fs = require("fs");
const req = createRequire("/Users/albertkattan/Code/karos-portal/package.json");
const { initializeApp, cert } = req("firebase-admin/app"); const { getFirestore } = req("firebase-admin/firestore");
const env = Object.fromEntries(fs.readFileSync("/Users/albertkattan/Code/karos-portal/.env.local","utf8").split("\n").filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>{const i=l.indexOf("=");let v=l.slice(i+1).trim();if(/^['"]/.test(v))v=v.slice(1,-1);return[l.slice(0,i),v]}));
let raw=env.FIREBASE_SERVICE_ACCOUNT_KEY; if(!raw.trim().startsWith("{")) raw=Buffer.from(raw,"base64").toString("utf8");
const sa=JSON.parse(raw); if(sa.private_key) sa.private_key=sa.private_key.replace(/\\n/g,"\n");
const app=initializeApp({credential:cert(sa),projectId:sa.project_id});
const SINCE = Date.parse(process.argv[2] || "2026-09-23T00:00:00Z");
const toMs = v => typeof v === "number" ? v : v && v.toMillis ? v.toMillis() : typeof v === "string" ? Date.parse(v) : NaN;
(async () => {
  const db = getFirestore(app, process.argv[3] || "prep");
  const snap = await db.collection("agentEngineRuns").where("productId", "==", "instagram-agent").get();
  const rows = [];
  for (const d of snap.docs) { const x = d.data(); const t = toMs(x.createdAt); if (!(t >= SINCE)) continue; rows.push({ id: d.id, t, x }); }
  rows.sort((a, b) => a.t - b.t);
  const jobIds = new Set(); 
  for (const r of rows) { const j = await db.collection("jobs").where("agentEngineRunId", "==", r.id).limit(1).get(); r.job = j.empty ? "" : j.docs[0].id; }
  for (const r of rows) {
    const x = r.x; const inp = x.input || {};
    console.log([new Date(r.t).toISOString().slice(5,16), r.id, (x.clientSlug||"").padEnd(22), (x.status||"").padEnd(10), ("$"+(x.totalCostUsd??"?")).padEnd(8), (x.runKind||""), "lease=" + String(x.leaseOwner||"").slice(0,40), "job=" + (r.job || "NONE"), x.failureReason ? "fail=" + String(x.failureReason).slice(0,60) : "", inp.postType||inp.requestedPostType||inp.mode||""].join(" | "));
  }
  console.log(`\n${rows.length} instagram runs since ${new Date(SINCE).toISOString()}; without a portal job: ${rows.filter(r=>!r.job).length}`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
