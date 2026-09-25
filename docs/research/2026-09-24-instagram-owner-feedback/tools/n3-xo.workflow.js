export const meta = {
  name: 'n3-xo-deepen-and-loops',
  description: 'Add N°3 Courchevel and deepen XO Digital competitor/benchmark accounts, and design the self-enriching loops',
  phases: [
    { title: 'Discover', detail: 'three agents pick accounts that fill missing card combinations' },
    { title: 'Tag', detail: 'one agent per new account, same method as the storm' },
    { title: 'Label', detail: 'label new accounts on the cards' },
    { title: 'Design', detail: 'competitor relevance, compounding loop, impact on today\'s system' },
  ],
}
const A = args
const SC = `cd "${A.sp}" && "${A.py}" sc.py`
const POST_ITEM = {
  type: 'object',
  properties: {
    label: { type: 'string' }, group: { type: 'string', enum: ['best', 'worst'] }, code: { type: 'string' }, multiple: { type: ['number', 'null'] },
    format: { type: 'string', enum: ['carousel', 'reel', 'image', 'video'] },
    cover_layout: { type: 'string', enum: ['full-bleed photo + overlaid headline', 'photo block + text on plain ground', 'text-only plate', 'split photo/text', 'collage/multi-photo', 'screenshot (tweet/news/app)', 'chart/table/data graphic', 'illustration/graphic-led', 'meme/reaction', 'product shot', 'person/face video frame', 'quote card', 'other'] },
    visual_source: { type: 'array', items: { type: 'string', enum: ['real photo: people', 'real photo: product/object', 'real photo: place/scene', 'stock-looking photo', 'AI-generated-looking image', 'illustration/vector', 'icons', 'screenshot', 'none (type only)'] } },
    graphic_devices: { type: 'array', items: { type: 'string', enum: ['icons', 'arrows/lines', 'numbered markers', 'chart', 'table', 'big number/stat', 'stickers/emoji', 'highlight/underline', 'boxes/cards', 'pills/badges', 'other brands logos', 'hand-drawn marks', 'none'] } },
    cover_words: { type: 'number' },
    headline_size: { type: 'string', enum: ['huge', 'large', 'medium', 'small', 'none'] },
    distinct_text_sizes: { type: 'string', enum: ['0', '1', '2', '3', '4+'] },
    font_style: { type: 'string', enum: ['serif', 'sans-serif', 'condensed/display sans', 'handwritten/script', 'mono', 'serif+sans mix', 'none'] },
    text_contrast: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    color_mood: { type: 'string', enum: ['brand-colour heavy', 'muted/neutral', 'dark', 'bright/saturated', 'photo-dominant'] },
    hook_type: { type: 'string', enum: ['number/list', 'question', 'bold claim/opinion', 'how-to/guide', 'news/announcement', 'story/narrative', 'before/after', 'comparison', 'humor/meme', 'product promo/offer', 'quote', 'behind the scenes', 'event recap', 'none'] },
    language_register: { type: 'string', enum: ['conversational', 'authoritative/expert', 'hype/promotional', 'emotional/personal', 'neutral/informational'] },
    sentence_form: { type: 'string', enum: ['complete sentences', 'fragments/labels', 'mixed', 'none'] },
    caption_length: { type: 'string', enum: ['short (<125 chars)', 'medium', 'long (>600 chars)'] },
    cta: { type: 'string', enum: ['save/share', 'comment prompt', 'link in bio/shop', 'follow', 'none'] },
    logo_position: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'centre', 'handle text only', 'none'] },
    human_face: { type: 'boolean' }, slides: { type: 'number' }, words_per_interior_slide: { type: ['number', 'null'] }, why: { type: 'string' },
  },
  required: ['label', 'group', 'format', 'cover_layout', 'visual_source', 'graphic_devices', 'cover_words', 'headline_size', 'distinct_text_sizes', 'font_style', 'hook_type', 'language_register', 'sentence_form', 'why'],
}
const ACCOUNT_SCHEMA = {
  type: 'object',
  properties: {
    handle: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' }, followers: { type: ['number', 'null'] }, posts_scraped: { type: 'number' },
    median_er_pct: { type: ['number', 'null'] }, outlier_count: { type: 'number' }, format_mix: { type: 'string' }, craft_score: { type: 'number' },
    visual_system: { type: 'string' }, what_outliers_share: { type: 'string' }, what_weak_posts_share: { type: 'string' }, best_carousel_notes: { type: 'string' },
    posts: { type: 'array', items: POST_ITEM },
  },
  required: ['handle', 'ok', 'posts'],
}
const TAG_GUIDE = `Tagging rules (use exactly the schema enums):
- Tag every post listed in media.json "best" (labels B1..) and "worst" (labels W1..). Look at the images yourself with the Read tool: sheet-best.jpg, sheet-worst.jpg, and every carousel-B*.jpg (full slides of the top outlier carousels).
- cover_words = words of text visible on the FIRST slide/frame (estimate). words_per_interior_slide = typical words on slides 2..n (only when you saw the full carousel, else null).
- headline_size: the largest text on the cover by line height relative to slide height: huge >8%, large 5-8%, medium 3-5%, small <3%.
- distinct_text_sizes = how many clearly different text sizes appear on the cover.
- AI-generated-looking image = synthetic sheen, impossible details, uncanny people. Be honest; say stock-looking when it looks like a stock photo.
- why = one sentence on what makes this post work (best) or fail (worst) versus the account's other posts.
Outliers are measured WITHIN the account (engagement = likes + 3*comments, multiple = post / account median), which controls for audience size.`


const CARDS = `Cards (closed lists): archetype = brand | place | person | publisher | platform | business | institution; involvement = none (content is the product) | low (impulse, under ~$100, unregulated) | high (considered, regulated, B2B, or an application); audience = B2B | B2C | mixed; category = the field (open list).`
const CONTEXT = `We found (89 benchmark accounts, 7 Karos clients) that grouping accounts barely predicts how posting patterns behave, and the strongest weak signals are purchase involvement and client archetype (about +1% prediction skill with strong shrinkage, p=0.01), with industry close behind. Two confounds limit this: each industry is one client's competitor set, and language is nested inside industry. The existing benchmark (do NOT re-add these): ${A.existing}.`
const DISC = { type: 'object', properties: { accounts: { type: 'array', items: { type: 'object', properties: { handle: { type: 'string' }, category: { type: 'string' }, archetype: { type: 'string' }, involvement: { type: 'string' }, audience: { type: 'string' }, locale: { type: 'string' }, followers: { type: ['number', 'null'] }, why: { type: 'string' } }, required: ['handle', 'category', 'archetype', 'involvement', 'why'] } } }, required: ['accounts'] }
const GAPS = [
  'N\u00b03 COURCHEVEL 1850 (lab folder /Users/albertkattan/Code/karos-agents/clients/n3: read profile/competitor-analysis.md, competitor-tracking.json, product-information.md first): three ultra-luxury apartments to rent in Courchevel 1850, French, an "address book of Courchevel" Instagram. Find its direct competitors on Instagram (luxury chalet/apartment rentals and residences in Courchevel and the Alps, e.g. Les Grandes Alpes and the names in the lab file), the Courchevel palaces and tables, and benchmark pages that do luxury hospitality/residence/place content very well (French and international). Category label: "luxury hospitality & residences".',
  'XO DIGITAL (lab folder /Users/albertkattan/Code/karos-agents/clients/xodigital): Brazilian tokenised fixed-income / investment crowdfunding platform (CVM), Portuguese. The existing set already has invistainco, tokeniza.com.br, liqibr, eqseedinvestimentos, hurst.capital, gcbinvestimentos, xodigital.oficial and finance educators. Go deeper: more direct platforms (tokenisation, crowdfunding, private credit, alternative investments in Brazil), Brazilian banks/brokers with strong carousel content, and international tokenisation/RWA brands with great Instagram. Category label: "fintech & investing".',
]
phase('Discover')
const disc = await parallel(GAPS.map((g, i) => () => agent(`${CONTEXT}\n${CARDS}\nPick 18 active public Instagram accounts (posted in the last 60 days; mostly carousels or images rather than only reels; small direct competitors are fine even under 10k followers) for this client: ${g}\nSpread them across card combinations so that each archetype and involvement level appears in several categories. Verify each handle with  ${SC} profile <handle>  (Bash, timeout 600000; about $0.002 per call; at most 30 calls). Return only verified accounts with their card labels.`, { label: `discover:gap-${i + 1}`, phase: 'Discover', schema: DISC })))
const seen = new Set(A.existing.split(',').map(s => s.trim().toLowerCase()))
const picks = []
for (const d of disc.filter(Boolean)) for (const a of d.accounts) { const h = String(a.handle).replace(/^@/, '').toLowerCase(); if (!seen.has(h)) { seen.add(h); picks.push({ ...a, handle: h }) } }
log(`${picks.length} new accounts to tag`)
phase('Tag')
const tagged = await parallel(picks.map(p => () => agent(`Analyse one Instagram account for the Karos benchmark study: @${p.handle} (${p.category}).
1. Scrape it: run  ${SC} account ${p.handle}  in Bash with timeout 600000. If it prints an error, return ok=false with the error.
   Files: ${A.sp}/research/scrape/${p.handle}/ (stats.json, posts.json with captions, media.json, sheet-best.jpg, sheet-worst.jpg, carousel-B*.jpg).
2. Read the images with the Read tool (all sheets and carousel strips) and the captions of the tagged posts.
3. Tag each best and weakest post. ${TAG_GUIDE}
4. Describe the account: visual_system, what the outliers share, what the weak posts share, and notes on the best carousels.`, { label: `enrich:${p.category.replace(/[:]/g, ' ')}:@${p.handle}`, phase: 'Tag', schema: ACCOUNT_SCHEMA, model: 'sonnet' })))
const ok = tagged.filter(Boolean).filter(r => r.ok)
log(`${ok.length}/${picks.length} tagged`)
phase('Design')
const DESIGN = { type: 'object', properties: { title: { type: 'string' }, proposal: { type: 'string', description: 'the full design in markdown, concrete: formulas, thresholds, data fields, where it lives, cost' }, changes: { type: 'array', items: { type: 'object', properties: { repo: { type: 'string' }, where: { type: 'string' }, change: { type: 'string' }, owner_hint: { type: 'string' } }, required: ['repo', 'where', 'change'] } }, open_questions: { type: 'array', items: { type: 'string' } } }, required: ['title', 'proposal', 'changes'] }
const TOPICS = [
  `LOOPS EVERYWHERE. The owner: "Whenever we do it for a client, it enriches our system and we upgrade the way we do this... whenever we have new clients and we scrape their new data, it automatically improves our system, even on the grouping and the standards cards... there should be loops all over the place that enrich and make it better the whole time for all these different systems." Design the full set of self-enriching loops, each with its trigger, input, what it updates, guardrails (no rule from thin evidence; shrinkage; permutation-tested leaderboard; human approval only where the layer design requires it), cadence and cost: (1) onboarding a new client: classify client + competitors on the cards, harvest their accounts into the shared tagged benchmark; (2) every scrape/harvest (Tomer's RFC-26 exemplar harvest): new tagged posts join the pool, one vote per account; (3) every published post of ours: measured at 48h/7d against the client's median, joins L3 and the pool; (4) owner/client/staff feedback: auditor classifies to a layer and extent; (5) the grouping leaderboard: re-run on a schedule, promotes/demotes cards, proposes new cards or new types when a split earns skill; (6) competitor watch tiers re-scored; (7) the guideline documents (L1, cards, client DNA) regenerated from evidence with diffs for review; (8) cross-industry transfer experiments evaluated and promoted. Map each loop to where it lives (engine, middleware, portal, scheduled job) reusing what exists (analytics cron, what-works projection, middleware learning tables, RFC-26 harvest/judge/library). Give the monthly cost and a build order.`,
]
const designs = await parallel(TOPICS.map((t, i) => () => agent(`${CONTEXT}\n${CARDS}\nRead the layer and taxonomy evidence: ${A.out}/taxonomy.json (judge verdict under "judge:taxonomy"), ${A.out}/robustness.json, ${A.out}/layer-system.json, ${A.out}/dt.json (Don Techno audit: its competitor-scoring fixes).\n\n${t}`, { label: 'design:loops', phase: 'Design', schema: DESIGN })))
return { picks, tagged: ok.map(r => ({ handle: r.handle, followers: r.followers, craft: r.craft_score })), failed: tagged.filter(Boolean).filter(r => !r.ok).map(r => r.handle), designs: designs.filter(Boolean) }
