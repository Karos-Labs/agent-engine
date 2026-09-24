// READ-ONLY: list a run's step records and show which carry rendered-slide URLs.
const { createRequire } = require("module"); const fs = require("fs");
const req = createRequire("/Users/albertkattan/Code/karos-portal/package.json");
const { initializeApp, cert } = req("firebase-admin/app"); const { getFirestore } = req("firebase-admin/firestore");
const env = Object.fromEntries(fs.readFileSync("/Users/albertkattan/Code/karos-portal/.env.local","utf8").split("\n").filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>{const i=l.indexOf("=");let v=l.slice(i+1).trim();if(/^['"]/.test(v))v=v.slice(1,-1);return[l.slice(0,i),v]}));
let raw=env.FIREBASE_SERVICE_ACCOUNT_KEY; if(!raw.trim().startsWith("{")) raw=Buffer.from(raw,"base64").toString("utf8");
const sa=JSON.parse(raw); if(sa.private_key) sa.private_key=sa.private_key.replace(/\\n/g,"\n");
const app=initializeApp({credential:cert(sa),projectId:sa.project_id}); const db=getFirestore(app,"prep");
const runId = process.argv[2];
(async () => {
  const steps = await db.collection("agentEngineRuns").doc(runId).collection("steps").get();
  for (const d of steps.docs.sort((a,b)=>a.id.localeCompare(b.id))) {
    const x = d.data(); const s = JSON.stringify(x.output ?? null);
    const urls = (s.match(/https:\/\/storage\.googleapis\.com[^"\\]+|gs:\/\/[^"\\]+/g) || []);
    console.log(d.id.padEnd(40), (x.status||"").padEnd(10), "outBytes=" + s.length, urls.length ? "urls=" + urls.length + " e.g. " + urls[0].slice(0,110) : "", x.output && x.output.archived ? "ARCHIVED " + x.output.gcsUri : "");
  }
  const slots = await db.collection("agentEngineRuns").doc(runId).collection("slots").get();
  console.log("slots:", slots.size, slots.docs.slice(0,5).map(d=>d.id).join(", "));
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
