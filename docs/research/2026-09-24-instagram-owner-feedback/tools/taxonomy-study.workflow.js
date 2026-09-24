export const meta = {
  name: 'layer-taxonomy-study',
  description: 'Decide how the middle layer should group clients (industries, client types, facets, or an extra layer) using a predictive test on ~100 tagged accounts plus research and a design panel',
  phases: [
    { title: 'Label', detail: 'label every benchmark account with candidate groupings' },
    { title: 'Research', detail: 'how marketing theory and agencies segment content strategy' },
    { title: 'Test', detail: 'which grouping best predicts how patterns behave for an unseen account' },
    { title: 'Design', detail: 'three structures built on the evidence' },
    { title: 'Judge', detail: 'score and recommend one structure' },
  ],
}

const A = args
const ACCTS = A.accounts

const FACETS = {
  vertical: ['marketing & advertising', 'tech & business news', 'startups & venture', 'fashion & intimates', 'travel, places & local discovery', 'personal finance & investing', 'music & nightlife', 'other'],
  archetype: ['media / publisher', 'consumer product brand', 'B2B service / agency', 'software / app', 'marketplace / platform', 'program / event / institution', 'creator / personality', 'educator / advisor'],
  audience: ['B2B', 'B2C', 'mixed'],
  involvement: ['none (content is the product)', 'low (impulse, cheap)', 'high (considered, expensive or regulated)'],
  content_job: ['entertain', 'inform / news', 'educate / advise', 'inspire / aspire', 'sell / promote'],
  visual_dependency: ['visual product or place', 'abstract (service, software, money, ideas)'],
  locale: ['en', 'he', 'pt-BR', 'es', 'multi', 'other'],
}
const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: Object.assign({ handle: { type: 'string' } }, ...Object.entries(FACETS).map(([k, vals]) => ({ [k]: { type: 'string', enum: vals } }))),
        required: ['handle'].concat(Object.keys(FACETS)),
      },
    },
  },
  required: ['labels'],
}

phase('Label')
const BATCH = 26
const batches = []
for (let i = 0; i < ACCTS.length; i += BATCH) batches.push(ACCTS.slice(i, i + BATCH))
const labelsP = parallel(batches.map((b, bi) => () => agent(`Label each Instagram account below with ONE value per facet (exact enum values). Judge the ACCOUNT itself (what kind of organisation or person runs it and what its posts are for), not the Karos client it was benchmarked for. Facets:\n${Object.entries(FACETS).map(([k, v]) => `- ${k}: ${v.join(' | ')}`).join('\n')}\nNotes: involvement = how considered a purchase from this account is (media accounts whose content is the product are "none"). visual_dependency = whether what they sell or cover is itself visual. locale = the language the posts are written in.\n\nAccounts:\n${JSON.stringify(b.map(a => ({ handle: a.handle, followers: a.followers, category: a.category, bio: a.bio, captions: a.captions, format_mix: a.format_mix, benchmarked_for: a.industries })))}`, { label: `label:batch-${bi + 1}`, phase: 'Label', schema: LABEL_SCHEMA, model: 'sonnet' })))

phase('Research')
const RESEARCH = {
  type: 'object',
  properties: {
    frameworks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, what_it_segments_by: { type: 'string' }, evidence_or_adoption: { type: 'string' }, implication_for_our_layers: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['name', 'what_it_segments_by', 'implication_for_our_layers'] } },
    practice: { type: 'array', items: { type: 'string' }, description: 'how agencies/platforms actually group clients for social content playbooks' },
    recommendation_from_literature: { type: 'string' },
  },
  required: ['frameworks', 'practice', 'recommendation_from_literature'],
}
const researchP = agent(`We run an AI agent that makes Instagram content for many brands with three layers of guidance: L1 platform (all Instagram), L2 a middle layer, L3 the client. The owner asks whether the middle layer should be industries, categories, or types of clients, whether to split it, or add another layer. Research how marketing science and practice segment content and creative strategy: e.g. the FCB grid (involvement x think/feel), Rossiter-Percy grid (involvement x informational/transformational motivation), Ehrenberg-Bass category entry points and distinctive assets, B2B vs B2C social research (LinkedIn B2B Institute, Meta business categories), content typologies (hero/hub/help, entertain/educate/inspire/convince), creator vs brand vs publisher account behaviour, and how agencies organise vertical playbooks. Load WebSearch/WebFetch with ToolSearch. For each framework: what it segments by, evidence behind it, and what it implies for our middle layer. Be concrete and cite sources.`, { label: 'research:segmentation', phase: 'Research', schema: RESEARCH })

const [labelBatches, research] = await Promise.all([labelsP, researchP])
const labelOf = {}
for (const b of labelBatches.filter(Boolean)) for (const l of b.labels) labelOf[String(l.handle).replace(/^@/, '').toLowerCase()] = l

phase('Test')
function sizeTier(f) { if (!f) return 'unknown'; if (f < 10000) return '<10k'; if (f < 100000) return '10k-100k'; if (f < 1000000) return '100k-1M'; return '>1M' }
const accts = ACCTS.filter(a => labelOf[a.handle.toLowerCase()])
const facts = accts.map(a => Object.assign({ industry: a.industries[0], size: sizeTier(a.followers) }, labelOf[a.handle.toLowerCase()]))
function skillFast(labels, k) {
  const values = new Set(); accts.forEach(a => Object.keys(a.vec).forEach(v => values.add(v)))
  let seT = 0, seG = 0, n = 0
  for (const v of values) {
    const idx = [], ds = []
    accts.forEach((a, i) => { if (a.vec[v] !== undefined) { idx.push(i); ds.push(a.vec[v]) } })
    if (idx.length < 4) continue
    const tot = ds.reduce((s, x) => s + x, 0)
    const gs = {}, gc = {}
    idx.forEach((i, j) => { const g = labels[i]; gs[g] = (gs[g] || 0) + ds[j]; gc[g] = (gc[g] || 0) + 1 })
    idx.forEach((i, j) => {
      const d = ds[j], g = labels[i], gm = (tot - d) / (idx.length - 1), cnt = gc[g] - 1
      let pred = gm
      if (cnt > 0) { const sm = (gs[g] - d) / cnt; const w = cnt / (cnt + k); pred = w * sm + (1 - w) * gm }
      seT += (d - pred) ** 2; seG += (d - gm) ** 2; n++
    })
  }
  return { skill: seG ? 1 - seT / seG : 0, n }
}
function prng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296 } }
function permP(labels, observed, k, reps) {
  const rnd = prng(12345)
  let ge = 0
  for (let r = 0; r < reps; r++) {
    const sh = labels.slice()
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = sh[i]; sh[i] = sh[j]; sh[j] = t }
    if (skillFast(sh, k).skill >= observed) ge++
  }
  return (ge + 1) / (reps + 1)
}
const CANDIDATES = ['industry', 'vertical', 'archetype', 'audience', 'involvement', 'content_job', 'visual_dependency', 'locale', 'size']
const rows = []
for (const f of CANDIDATES) {
  const labels = facts.map(x => x[f])
  const s = skillFast(labels, 3)
  rows.push({ grouping: f, groups: new Set(labels).size, skill: Math.round(s.skill * 1000) / 1000, perm_p: permP(labels, s.skill, 3, 199), n: s.n })
}
const PAIRS = [['archetype', 'vertical'], ['archetype', 'locale'], ['involvement', 'content_job'], ['archetype', 'involvement'], ['vertical', 'locale'], ['audience', 'content_job'], ['archetype', 'visual_dependency']]
for (const [f1, f2] of PAIRS) {
  const labels = facts.map(x => `${x[f1]}|${x[f2]}`)
  const s = skillFast(labels, 3)
  rows.push({ grouping: `${f1} x ${f2}`, groups: new Set(labels).size, skill: Math.round(s.skill * 1000) / 1000, perm_p: permP(labels, s.skill, 3, 199), n: s.n })
}
rows.sort((a, b) => b.skill - a.skill)
const distribution = Object.fromEntries(CANDIDATES.map(f => [f, facts.reduce((m, x) => (m[x[f]] = (m[x[f]] || 0) + 1, m), {})]))
log(`Grouping skill (leave-one-account-out, shrinkage k=3): ${rows.slice(0, 6).map(r => `${r.grouping} ${r.skill} (p=${r.perm_p})`).join('; ')}`)

phase('Design')
const EVIDENCE = `Predictive test: for every benchmark account and tag value, predict that account's within-account effect (best-minus-weakest share) from the OTHER accounts, either globally or from accounts in the same group (shrunk toward global with k=3). skill = 1 - error(grouped)/error(global); >0 means the grouping carries real information about how patterns behave; perm_p is a label-shuffle test (199 shuffles). ${accts.length} accounts.\n${JSON.stringify(rows)}\n\nGroup sizes per facet:\n${JSON.stringify(distribution)}\n\nThe 8 clients: karoslabs (AI marketing agency), geektime (Hebrew tech news publisher), thepitchbydeel (startup pitch competition by Deel), hankypanky (premium lace intimates), kindlyyours (size-inclusive value intimates), sitti (creator city-map marketplace app), xodigital (Brazilian tokenised investment platform), dontechno (house/techno music media page).\n\nResearch on segmentation frameworks:\n${JSON.stringify(research)}`
const DESIGN = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    layers: { type: 'string', description: 'the full stack, e.g. L1 platform / L2a ... / L2b ... / L3 client, and qualifiers like locale' },
    taxonomy: { type: 'string', description: 'the closed lists and definitions' },
    client_mapping: { type: 'string', description: 'where each of the 8 clients lands' },
    how_a_client_is_classified: { type: 'string' },
    how_guidance_composes: { type: 'string', description: 'merge order and conflict rule' },
    how_evidence_pools: { type: 'string', description: 'which grouping is used for replication and scale tests' },
    documents_to_maintain: { type: 'string' },
    why_this_fits_the_evidence: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'layers', 'taxonomy', 'client_mapping', 'how_a_client_is_classified', 'how_guidance_composes', 'how_evidence_pools', 'documents_to_maintain', 'why_this_fits_the_evidence'],
}
const ANGLES = [
  'ONE MIDDLE LAYER: pick the single best grouping (industry, client type, or another) and justify it; simplest to run.',
  'TWO AXES: a client-type layer (what the account is and what its content is for) plus a vertical layer (topics, lingo, visuals of the field), composed; say which sits above which and why.',
  'COMPOSABLE FACETS: small parameter packs per facet (type, vertical, involvement, locale, size) merged by rules; each facet only owns the parameters the evidence says it predicts.',
]
const designs = await parallel(ANGLES.map((ang, i) => () => agent(`${EVIDENCE}\n\nDesign the middle of the layer stack from this angle: ${ang}\nThe owner: "should it be industries, categories, or types of clients? That layer maybe needs better defining... maybe it's valuable to add another layer... worth putting a lot of thought, research and consideration into before doing it." The design must work with the judged layer system (L1 platform, kits as parameter sets, client DNA, locale as a qualifier, evidence pooled across benchmark accounts, one vote per account) and stay cheap to run.`, { label: `design:${i + 1}`, phase: 'Design', schema: DESIGN })))

phase('Judge')
const verdict = await agent(`${EVIDENCE}\n\nThree designs:\n${JSON.stringify(designs.filter(Boolean))}\n\nScore each 1-10 on: fit to the predictive evidence, fit to the research, simplicity to run, and how well it tailors per client. Recommend one structure (graft the best of the others). State plainly what the data says (including if no grouping predicts much, which would mean L1 + L3 carry most of the weight), what the new stack is, the closed lists, where each of the 8 clients lands, and what must be true before adding a layer later.`, { label: 'judge:taxonomy', phase: 'Judge', schema: { type: 'object', properties: { scores: { type: 'array', items: { type: 'object', properties: { design: { type: 'string' }, evidence_fit: { type: 'number' }, research_fit: { type: 'number' }, simplicity: { type: 'number' }, tailoring: { type: 'number' }, comment: { type: 'string' } }, required: ['design', 'evidence_fit', 'research_fit', 'simplicity', 'tailoring', 'comment'] } }, recommended: DESIGN, what_the_data_says: { type: 'string' }, preconditions_for_more_layers: { type: 'string' } }, required: ['scores', 'recommended', 'what_the_data_says'] }, model: 'fable' })

return { skill: rows, distribution, labels: facts.map((x, i) => Object.assign({ handle: accts[i].handle }, x)), research, designs: designs.filter(Boolean), verdict }
