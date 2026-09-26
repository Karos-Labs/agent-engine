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
const N = A.n

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
const BATCH = 25
const batches = []
for (let i = 0; i < N; i += BATCH) batches.push([i, Math.min(N, i + BATCH)])
const labelsP = parallel(batches.map(([s0, s1], bi) => () => agent(`Label each Instagram account with ONE value per facet (exact enum values). Read accounts ${s0} to ${s1 - 1} (0-based, end inclusive) of the JSON array in ${A.file} (fields: handle, followers, category, bio, captions, format_mix, industries = the client it was benchmarked for). Judge the ACCOUNT itself (what kind of organisation or person runs it and what its posts are for), not the Karos client. Facets:
${Object.entries(FACETS).map(([k, v]) => `- ${k}: ${v.join(' | ')}`).join('\n')}\nNotes: involvement = how considered a purchase from this account is (media accounts whose content is the product are "none"). visual_dependency = whether what they sell or cover is itself visual. locale = the language the posts are written in. Return one row per account in your range.`, { label: `label:batch-${bi + 1}`, phase: 'Label', schema: LABEL_SCHEMA, model: 'sonnet' })))

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
const allLabels = labelBatches.filter(Boolean).flatMap(b => b.labels)
const testOut = await agent(`Write this JSON array to ${A.labelsFile} exactly as given, then run: python3 ${A.skillScript} ${A.inputFile} ${A.labelsFile}  and return ONLY the script's JSON output, unchanged.

${JSON.stringify(allLabels)}`, { label: 'test:skill', phase: 'Test', model: 'sonnet' })
let parsed = { skill: [], distribution: {}, accounts: 0 }
try { parsed = JSON.parse(String(testOut).slice(String(testOut).indexOf('{'), String(testOut).lastIndexOf('}') + 1)) } catch (e) { log('could not parse the skill test output') }
const rows = parsed.skill, distribution = parsed.distribution
const accts = { length: parsed.accounts }
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

return { skill: rows, distribution, labels: allLabels, research, designs: designs.filter(Boolean), verdict }
