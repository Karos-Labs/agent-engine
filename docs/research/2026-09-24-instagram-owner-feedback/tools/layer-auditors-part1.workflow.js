export const meta = {
  name: 'layer-auditors-part1',
  description: 'Classify every owner feedback point and research finding into layers with per-client extent, find cross-industry transfers, and refute them',
  phases: [
    { title: 'Feedback audit', detail: "the owner's points, one audited row each" },
    { title: 'Findings audit', detail: 'four dimension auditors test each finding at client, industry and platform scale' },
    { title: 'Transfer', detail: 'patterns that win in one industry and are missing in another, with a twist' },
    { title: 'Refute', detail: 'skeptics on every platform-wide or MUST line and the top transfers' },
  ],
}

const A = args
const FILES = `Evidence files (read what you need; they are large, so use targeted reads/grep):
- ${A.out}/scale.md: within-account statistics (one vote per account: share of an account's best posts with a tag minus share of its weakest posts), at ALL-ACCOUNTS, per-INDUSTRY and per-CLIENT scale with sign tests; the industry advancement profile; computed transfer candidates. ${A.out}/scale.json has the full tables including per-client.
- ${A.out}/storm-extract.json: the 7 client syntheses (best creators, best content, patterns, gap vs our post, L3/L2 rules) and platform research (legibility, Karos archive).
- ${A.out}/storm-lead.json: the lead synthesis (conclusions, parameters, industry kits), the ranking research, and the three skeptics' verdicts on each conclusion.
- ${A.out}/a16z-deep-dive.md: 72-post study of @a16z for The Pitch by Deel (type measurements, templates, what separates outliers).
- ${A.out}/dt.json: audit of the bespoke Don Techno system (music media) and 13 tagged music-media accounts.
- ${A.out}/layer-system.json: the judged design for the layer system; key "judge:design".recommended holds the auditor rubric this workflow follows.
- ${A.out}/audit.json: the code audit and build plan (workstreams WS-01..13) for mapping defects to code.
Clients (slug: industry): karoslabs: B2B marketing / AI agency; geektime: Tech news media (Hebrew); thepitchbydeel: Startup / founder programs; hankypanky and kindlyyours: Intimate apparel; sitti: Creator economy / city-guide app; xodigital: Fintech / investing (Brazil); dontechno: Music media & nightlife; n3: luxury hospitality & residences (N°3 Courchevel, French, three ultra-luxury apartments). Benchmark now 183 accounts incl. ~90 enrichment accounts that break the industry=client confound; the grouping test (robustness-v2.json) ranks involvement, then archetype and audience, then industry; the taxonomy verdict (taxonomy.json, judge:taxonomy) sets a thin middle of standards cards.`

const RUBRIC = `Audit rubric (from the judged layer-system design; apply it to every row):
1. KIND: defect (an existing requirement was not met: wrong font, duplicate slide, lost words) -> engineering ticket + regression test, no prose rule; data fix (wrong client identity data) -> profile fix; constraint (legal, platform policy, legibility floor, brand integrity) -> hard gate, owner-confirmed; standard (the owner's quality/brand bar) -> applies at once at the scope he states, never waits for replication; performance claim ("this works better") -> must be tested at scale before it widens; preference (one client's taste) -> L3; noise -> recorded, no change.
2. BLAME BY PROVENANCE: when the input criticises a rendered element, name which layer or code produced it; fix at the source.
3. MECHANISM / VALUE SPLIT: restate each lesson as a mechanism (usually L1: a renderer behaviour or a gate with a parameter) plus a value (a brand kit, industry or client parameter), so clients differ by parameters, not by rules.
4. SCALE TEST (performance claims only): check the largest scope first. L1 platform only if it holds within accounts across most industries (sign-consistent, not driven by one industry) or has strong primary research; L2 if it holds within one industry's accounts; L3 if only the client's own accounts show it; otherwise TRY (an experiment) or noise. Small n (< ~8 accounts) caps it at TRY.
5. STRENGTH: MUST (hard, a gate enforces it) / DEFAULT (applies unless overridden) / TRY (experiment slot, measured).
6. EXTENT PER CLIENT: for each of the 9 clients: applies / adjusted (say how: the twist) / skip (say why).
7. LOCALE: note it when a rule is language-specific (Hebrew RTL, Portuguese).`

const OWNER = `The owner's feedback points (this session):
A. Posts must use only the client's own fonts, always loaded; never again.
B. Onboarding must capture the whole design language (fonts, palette and how colours are used, box/button rounding, pills, layouts, tables, how numbers are set).
C. Two text sizes plus a small source line; bigger text; lines that fit (two words a line is fine); complete human sentences, not AI-sounding; numbers in the brand font; harmonious, no extremes.
D. Boxes/devices must look like the client's own design language.
E. Logo: one optimal size and position per client chosen by a rule.
F. An uploaded logo beats a scraped one.
G. Onboarding decides how each logo is displayed, incl. background removal.
H. Full-bleed photo covers: less text, balanced sizes, a gradient shade so text reads.
I. Slides flow as one set; no two slides alike.
J-L. Learn from competitors' and benchmark pages' outliers per industry and for the platform; understand the algorithm and attention.
M. Add graphics/icons; posts are too text-heavy and too AI-picture heavy.
O. (added) a16z's main account is close to what The Pitch should do.
P. (added) Cross-industry transfer: some industries are more advanced in design, marketing, ideation and trends; a trend or format proven in one industry, applied to another with a twist, could have large upside.
Q. (added) Learn from the bespoke Don Techno system (how it finds stories, reverse-engineers others and beats them to market) and use its data as another industry.
R. (overall aim) Much more tailored per client, better design, still cost-effective, using the data.
S. (system) Auditors decide whether feedback is general, which layer it belongs to, and how far it applies to each client; patterns seen at scale across all working posts go into that layer's guidelines.`

const ROW = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    source: { type: 'string', description: 'owner point letter, storm conclusion id, research, a16z, don-techno, transfer' },
    lesson: { type: 'string' },
    mechanism: { type: 'string' },
    value: { type: 'string' },
    kind: { type: 'string', enum: ['defect', 'data fix', 'constraint', 'standard', 'performance claim', 'preference', 'noise'] },
    layer: { type: 'string', enum: ['L1 platform', 'L2 industry', 'L3 client', 'code only'] },
    scope: { type: 'string' },
    strength: { type: 'string', enum: ['MUST', 'DEFAULT', 'TRY', 'n/a'] },
    dimension: { type: 'string', enum: ['language', 'design', 'layout', 'font sizes', 'graphics', 'imagery', 'format', 'hook', 'logo', 'cadence', 'strategy', 'process', 'other'] },
    evidence: { type: 'string', description: 'within-account diffs with account counts and sign tests, research refs, named example posts' },
    extent: { type: 'array', items: { type: 'object', properties: { client: { type: 'string' }, verdict: { type: 'string', enum: ['applies', 'adjusted', 'skip'] }, note: { type: 'string' } }, required: ['client', 'verdict'] } },
    locale: { type: 'string' },
    agent_change: { type: 'string', description: 'concrete change: parameter, gate, template, prompt line, onboarding capture, workstream id' },
  },
  required: ['id', 'source', 'lesson', 'kind', 'layer', 'scope', 'strength', 'dimension', 'evidence', 'extent', 'agent_change'],
}
const ROWS_SCHEMA = { type: 'object', properties: { rows: { type: 'array', items: ROW }, notes: { type: 'string' } }, required: ['rows'] }

phase('Feedback audit')
const fbP = agent(`${RUBRIC}\n\n${OWNER}\n\n${FILES}\n\nAudit EVERY owner point (A-S) as one or more rows. Most execution complaints are defects or standards: do not dress them up as performance claims. Where the storm or a16z data supports or contradicts a point, cite it. Give the per-client extent for all 9 clients.`, { label: 'audit:owner-feedback', phase: 'Feedback audit', schema: ROWS_SCHEMA })

phase('Findings audit')
const GROUPS = [
  { key: 'language', dims: 'language, hooks, captions, CTAs, sentence form, register' },
  { key: 'design', dims: 'design, layout, font sizes, number of text sizes, contrast, boxes/devices, colour mood, logo position' },
  { key: 'imagery', dims: 'graphics, icons, charts, photos vs AI images vs screenshots, human faces, product shots' },
  { key: 'format', dims: 'format (carousel/reel/image), slide count, series/franchises, cadence, topics and story sourcing, timing' },
]
const findingsP = parallel(GROUPS.map(g => () => agent(`${RUBRIC}\n\n${FILES}\n\nYou audit the research findings for these dimensions: ${g.dims}. Sources: the storm's survived AND killed conclusions (a killed one can still hold at a narrower scope), the within-account scale tables (all/industry/client), the client syntheses, platform research, the a16z deep dive and the Don Techno audit and tags. For each distinct lesson in your dimensions, produce one audited row: find the widest scope where it genuinely holds, mark TRY when evidence is thin, and give the extent for all 9 clients (with the twist when adjusted). Prefer fewer, stronger rows over many weak ones; merge duplicates.`, { label: `audit:findings-${g.key}`, phase: 'Findings audit', schema: ROWS_SCHEMA })))

phase('Transfer')
const TRANSFER = {
  type: 'object',
  properties: {
    industry_advancement: { type: 'array', items: { type: 'object', properties: { industry: { type: 'string' }, rank: { type: 'number' }, strongest_at: { type: 'string' }, weakest_at: { type: 'string' } }, required: ['industry', 'rank', 'strongest_at'] } },
    transfers: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, pattern: { type: 'string' }, source_industry: { type: 'string' }, source_evidence: { type: 'string' },
      target: { type: 'string', description: 'target industry and/or client' }, twist: { type: 'string', description: 'how it must change to fit the target (topic, register, visuals, brand rules)' },
      why_it_should_transfer: { type: 'string', description: 'the audience or platform mechanism that makes it portable' },
      risk: { type: 'string' }, experiment: { type: 'string', description: 'how to test it as a TRY: posts, metric, window, success bar' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    }, required: ['id', 'pattern', 'source_industry', 'source_evidence', 'target', 'twist', 'why_it_should_transfer', 'experiment', 'priority'] } },
  },
  required: ['industry_advancement', 'transfers'],
}
const transferP = parallel([
  () => agent(`${FILES}\n\nThe owner: "some markets are more advanced in design, marketing, ideation and trends; something proven in one industry, applied to another with a twist specific to that industry, could have huge potential." Use the QUANTITATIVE side: the industry advancement profile and the computed transfer candidates in scale.md (strong and sign-consistent within the source industry's accounts, rare in the target's posts, not contradicted there). Rank the 7 industries by how advanced their Instagram practice is (design craft, format innovation, hooks) and say where each is strongest. Then keep only transfers with a plausible mechanism, and write the twist for each target and a TRY experiment.`, { label: 'transfer:quant', phase: 'Transfer', schema: TRANSFER }),
  () => agent(`${FILES}\n\nThe owner: "some markets are more advanced in design, marketing, ideation and trends; something proven in one industry, applied to another with a twist specific to that industry, could have huge potential." Use the QUALITATIVE side: the best creators and best content named in each client synthesis, the a16z deep dive (archival 'then' carousels, typographic manifestos, primary artifacts), the Don Techno audit (story sourcing one step upstream, beating others to market), and the Karos archive. Find formats, series, trends and ideation methods that one industry has mastered and another lacks. For each: the twist per target industry or client, why it should transfer, risk, and a TRY experiment. Include at least one idea for every client.`, { label: 'transfer:qual', phase: 'Transfer', schema: TRANSFER }),
])

const [fb, findings, transfers] = await Promise.all([fbP, findingsP, transferP])
const allRows = [].concat(fb ? fb.rows : [], ...findings.filter(Boolean).map(f => f.rows))
const allTransfers = [].concat(...transfers.filter(Boolean).map(t => t.transfers))
log(`${allRows.length} audited rows, ${allTransfers.length} transfer proposals`)

phase('Refute')
const hard = allRows.filter(r => r.layer === 'L1 platform' || r.strength === 'MUST')
const topT = allTransfers.filter(t => t.priority === 'high')
const VERDICT = { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, refuted: { type: 'boolean' }, narrower_scope: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'refuted', 'reason'] } } }, required: ['verdicts'] }
const votes = await parallel([
  'statistics and breadth: does it really hold across industries/accounts at the claimed layer, or is it driven by a few accounts or one industry?',
  'transfer and harm: would it hurt any client (brand rules, locale, industry norms, legal), and is the twist enough to make a transfer fit?',
].map((lens, i) => () => agent(`${FILES}\n\nSkeptic ${i + 1} of 2. Lens: ${lens}\nTry to refute each row and transfer below. refuted=true means it must not ship at the claimed layer/strength; give narrower_scope when it survives only narrower. Owner standards and defects are NOT refutable on evidence grounds (they are his bar); judge only whether their layer/extent is right.\n\nRows (platform-wide or MUST):\n${JSON.stringify(hard.map(r => ({ id: r.id, kind: r.kind, layer: r.layer, strength: r.strength, lesson: r.lesson, evidence: r.evidence })))}\n\nHigh-priority transfers:\n${JSON.stringify(topT.map(t => ({ id: t.id, pattern: t.pattern, source: t.source_industry, target: t.target, twist: t.twist, evidence: t.source_evidence })))}`, { label: `refute:${i + 1}`, phase: 'Refute', schema: VERDICT })))
const tally = {}
for (const v of votes.filter(Boolean)) for (const x of v.verdicts) { const t = (tally[x.id] = tally[x.id] || { refuted: 0, notes: [] }); if (x.refuted) t.refuted++; t.notes.push(x.narrower_scope ? `narrower: ${x.narrower_scope}` : x.reason) }

return { rows: allRows, transfers: allTransfers, advancement: transfers.filter(Boolean).map(t => t.industry_advancement), tally }
