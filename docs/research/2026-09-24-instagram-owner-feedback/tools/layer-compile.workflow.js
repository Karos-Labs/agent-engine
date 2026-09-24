export const meta = {
  name: 'layer-compile',
  description: 'Compile audited rows and transfers into L1, middle-layer kits and client DNA documents on the chosen taxonomy, then align with the owner intent',
  phases: [
    { title: 'Compile', detail: 'L1 additions, kits, client DNAs, parameters, defects to code' },
    { title: 'Align', detail: "check against the owner's intent" },
  ],
}

const A = args
const FILES = `Evidence files (read what you need; they are large, so use targeted reads/grep):
- ${A.out}/scale.md: within-account statistics (one vote per account: share of an account's best posts with a tag minus share of its weakest posts), at ALL-ACCOUNTS, per-INDUSTRY and per-CLIENT scale with sign tests; the industry advancement profile; computed transfer candidates. ${A.out}/scale.json has the full tables including per-client.
- ${A.out}/storm.json: the storm's lead synthesis (survived and killed conclusions with the skeptics' reasons), parameters, industry kits, client syntheses (best creators, best content, patterns, gap vs our post, L3/L2 rules), and platform research (ranking, legibility, Karos archive).
- ${A.out}/a16z-deep-dive.md: 72-post study of @a16z for The Pitch by Deel (type measurements, templates, what separates outliers).
- ${A.out}/dt.json: audit of the bespoke Don Techno system (music media) and 13 tagged music-media accounts.
- ${A.out}/layer-system.json: the judged design for the layer system; key "judge:design".recommended holds the auditor rubric this workflow follows.
- ${A.out}/audit.json: the code audit and build plan (workstreams WS-01..13) for mapping defects to code.
Clients (slug: industry): karoslabs: B2B marketing / AI agency; geektime: Tech news media (Hebrew); thepitchbydeel: Startup / founder programs; hankypanky and kindlyyours: Intimate apparel; sitti: Creator economy / city-guide app; xodigital: Fintech / investing (Brazil); dontechno: Music media & nightlife.`
const RUBRIC = `Audit rubric (from the judged layer-system design; apply it to every row):
1. KIND: defect (an existing requirement was not met: wrong font, duplicate slide, lost words) -> engineering ticket + regression test, no prose rule; data fix (wrong client identity data) -> profile fix; constraint (legal, platform policy, legibility floor, brand integrity) -> hard gate, owner-confirmed; standard (the owner's quality/brand bar) -> applies at once at the scope he states, never waits for replication; performance claim ("this works better") -> must be tested at scale before it widens; preference (one client's taste) -> L3; noise -> recorded, no change.
2. BLAME BY PROVENANCE: when the input criticises a rendered element, name which layer or code produced it; fix at the source.
3. MECHANISM / VALUE SPLIT: restate each lesson as a mechanism (usually L1: a renderer behaviour or a gate with a parameter) plus a value (a brand kit, industry or client parameter), so clients differ by parameters, not by rules.
4. SCALE TEST (performance claims only): check the largest scope first. L1 platform only if it holds within accounts across most industries (sign-consistent, not driven by one industry) or has strong primary research; L2 if it holds within one industry's accounts; L3 if only the client's own accounts show it; otherwise TRY (an experiment) or noise. Small n (< ~8 accounts) caps it at TRY.
5. STRENGTH: MUST (hard, a gate enforces it) / DEFAULT (applies unless overridden) / TRY (experiment slot, measured).
6. EXTENT PER CLIENT: for each of the 8 clients: applies / adjusted (say how: the twist) / skip (say why).
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

const allRows = A.rows
const allTransfers = A.transfers
const tally = A.tally
const TAXONOMY = A.taxonomy
phase('Compile')
const COMPILED = {
  type: 'object',
  properties: {
    l1_platform: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, line: { type: 'string' }, strength: { type: 'string' }, dimension: { type: 'string' }, enforced_by: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'line', 'strength', 'dimension', 'evidence'] } },
    industry_kits: { type: 'array', items: { type: 'object', properties: { kit: { type: 'string' }, clients: { type: 'array', items: { type: 'string' } }, params: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } }, tries: { type: 'array', items: { type: 'string' } } }, required: ['kit', 'params', 'lines'] } },
    client_dna: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, kit: { type: 'string' }, params: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } }, skipped_kit_lines: { type: 'array', items: { type: 'string' } } }, required: ['slug', 'kit', 'params', 'lines'] } },
    parameters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, l1_default: { type: 'string' }, overrides: { type: 'string' }, evidence: { type: 'string' } }, required: ['name', 'l1_default', 'evidence'] } },
    defects_to_code: { type: 'array', items: { type: 'object', properties: { defect: { type: 'string' }, workstream: { type: 'string' }, guard: { type: 'string' } }, required: ['defect', 'workstream'] } },
    decisions_for_owner: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, recommendation: { type: 'string' }, evidence: { type: 'string' } }, required: ['question', 'recommendation', 'evidence'] } },
    files_written: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['l1_platform', 'industry_kits', 'client_dna', 'parameters', 'defects_to_code', 'decisions_for_owner', 'summary'],
}
const compiled = await agent(`${RUBRIC}\n\n${OWNER}\n\n${FILES}\n\nCompile the audited rows and transfers into the layer guidelines, organising the middle layer by the TAXONOMY chosen below (not necessarily industries): its layers, closed lists and client mapping decide which kit documents exist and which client points at which kit(s).\n\nTAXONOMY VERDICT:\n${JSON.stringify(TAXONOMY)}\n\n Drop rows refuted by both skeptics; move rows refuted once to the narrower scope named; keep owner standards and defects at the scope the owner stated. Transfers become TRY lines in the target kit or client DNA. Budgets: at most 25 lines per industry kit and 15 per client DNA; each line one sentence with strength, dimension and an evidence reference. Parameters are values the renderer/copy steps read (sizes on a 1080-wide canvas, word caps, text-size count, photo/graphic mix, slide counts, logo size/corner rule, scrim). Map every defect to a build workstream (WS-01..WS-13 in audit.json) with its guard. List the decisions the owner must make, each with a data-backed recommendation (e.g. photo covers: capped full-bleed with a measured shade vs the framed picture from #244; imagery policy; logo corner; CTA style).\n\nAlso WRITE the documents to disk under ${A.out}/guidelines/: L1-platform.md, one ig-kit-<industry-slug>.md per kit and one ig-dna-<client-slug>.md per client (header: id, version 1, kit pointer for DNAs, params block, then numbered lines "[STRENGTH][dimension] line (evidence: ...)"), plus README.md indexing them. Return the same content.\n\nAudited rows:\n${JSON.stringify(allRows)}\n\nTransfers:\n${JSON.stringify(allTransfers)}\n\nSkeptic tally by id:\n${JSON.stringify(tally)}`, { label: 'compile:guidelines', phase: 'Compile', schema: COMPILED, model: 'fable' })

phase('Align')
const align = await agent(`${OWNER}\n\nThe compiled guidelines are in ${A.out}/guidelines/ and below. Check them against the owner's intent point by point (A-S): is each point reflected at the right layer with the right extent per client; did the cross-industry transfers (P) get twists and experiments; did the Don Techno learnings (Q) land where they apply; does the whole make each client more tailored with better design at low cost (R); does the auditor system (S) work as he described (general vs specific, layer, extent, scale)? List gaps, misreadings and risks concretely.\n\nCompiled:\n${JSON.stringify(compiled)}`, { label: 'align:guidelines', phase: 'Align', schema: { type: 'object', properties: { per_point: { type: 'array', items: { type: 'object', properties: { point: { type: 'string' }, status: { type: 'string', enum: ['covered', 'partial', 'missing', 'misread'] }, note: { type: 'string' } }, required: ['point', 'status', 'note'] } }, risks: { type: 'array', items: { type: 'string' } } }, required: ['per_point'] } })

return { compiled, align }
