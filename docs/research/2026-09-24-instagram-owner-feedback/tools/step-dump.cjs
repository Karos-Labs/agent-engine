// READ-ONLY: print selected step outputs of one run (URLs shortened).
const { createRequire } = require("module"); const fs = require("fs");
const req = createRequire("/Users/albertkattan/Code/karos-portal/package.json");
const { initializeApp, cert } = req("firebase-admin/app"); const { getFirestore } = req("firebase-admin/firestore");
const env = Object.fromEntries(fs.readFileSync("/Users/albertkattan/Code/karos-portal/.env.local","utf8").split("\n").filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>{const i=l.indexOf("=");let v=l.slice(i+1).trim();if(/^['"]/.test(v))v=v.slice(1,-1);return[l.slice(0,i),v]}));
let raw=env.FIREBASE_SERVICE_ACCOUNT_KEY; if(!raw.trim().startsWith("{")) raw=Buffer.from(raw,"base64").toString("utf8");
const sa=JSON.parse(raw); if(sa.private_key) sa.private_key=sa.private_key.replace(/\\n/g,"\n");
const app=initializeApp({credential:cert(sa),projectId:sa.project_id}); const db=getFirestore(app,"prep");
const [runId, ...stepIds] = process.argv.slice(2);
(async () => {
  for (const s of stepIds) {
    const d = await db.collection("agentEngineRuns").doc(runId).collection("steps").doc(s).get();
    const out = JSON.stringify(d.data()?.output ?? null, (k, v) => typeof v === "string" && v.startsWith("https://storage.googleapis.com") ? v.split("?")[0] + "?<signed>" : v, 1);
    console.log(`\n### ${s} (${out.length} chars)\n` + out.slice(0, Number(process.env.MAX || 3500)));
  }
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
