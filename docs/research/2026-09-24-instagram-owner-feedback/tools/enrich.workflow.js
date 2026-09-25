export const meta = {
  name: 'layer-enrich-and-design',
  description: 'Enrich the benchmark with ~60 accounts that break the industry/client confounds, and design competitor relevance, the compounding loop, and the impact on the current system',
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
  'PUBLISHERS and PERSONS outside tech news and music: fashion/beauty media, finance media and personal-finance creators (English), food/travel publishers, marketing educators with big audiences, B2B newsletters on Instagram. Mix involvement none/low/high.',
  'INSTITUTIONS, PLATFORMS and BUSINESSES outside startups: universities or schools, museums/festivals, nonprofits, fintech/neo-bank apps, consumer apps (fitness, language, travel), SaaS brands, B2B agencies and consultancies in other fields (design, legal-tech, HR). High involvement mostly.',
  'BRANDS and PLACES outside intimates: DTC beauty/skincare, sneakers or apparel, food and beverage, home goods, hotels/restaurants/venues, premium high-involvement brands (cars, watches, furniture). Also 3-4 Hebrew and 3-4 Portuguese accounts OUTSIDE news and fintech so language stops being nested in industry.',
]
phase('Discover')
const disc = await parallel(GAPS.map((g, i) => () => agent(`${CONTEXT}\n${CARDS}\nPick 20 active public Instagram accounts (posted in the last 60 days, 10k+ followers, mostly carousels or images rather than only reels) for this gap: ${g}\nSpread them across card combinations so that each archetype and involvement level appears in several categories. Verify each handle with  ${SC} profile <handle>  (Bash, timeout 600000; about $0.002 per call; at most 30 calls). Return only verified accounts with their card labels.`, { label: `discover:gap-${i + 1}`, phase: 'Discover', schema: DISC })))
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
  `COMPETITOR RELEVANCE AND WATCH TIERS. The owner: "Does that mean we need to analyze competitors with the same client type, category pack and purchase involvement? How do we measure these for competitors to figure out which we should watch more closely and less closely?" Design a relevance score for any account vs a client (card match weighted by what the evidence says predicts, plus audience, locale, size band, activity, the account's own outlier rate and craft), how competitors are classified with the same one-call onboarding classifier, the watch tiers (e.g. close/peer/benchmark/aspirational, how often each is scraped, what each feeds: L3 direct rules vs the pooled L1/L2 evidence), and how this plugs into the existing competitor tracking and Tomer's RFC-26 exemplar harvest. Include the scraping-correctness fixes (hidden likes, post age under 3 days, busy-account windows, format from the post's shape not caption).`,
  `THE COMPOUNDING LOOP. The owner: "How can we make sure the system keeps compounding to refine this strategy? The strategy is good but not on a huge amount of accounts, so we want to enrich it over time... maybe add a new standard card or new types to each card." Design: a standing benchmark that grows (which accounts to add each month to fill thin card cells), the predictive-test leaderboard (which groupings, tuned shrinkage, permutation test, run cadence), the promotion rule for a card to start carrying performance deltas, the rule to add a new card or a new type (e.g. split an archetype), retirement, and how our own clients' measured posts join the pool. Keep it cheap: say the monthly cost. Reference robustness results: tuned k=30; involvement +1.2%, archetype +0.8-1.3%, industry +0.8-1.0%, all p=0.01; visual style, size and locale add nothing.`,
  `IMPACT ON TODAY'S SYSTEM. Read the current code (agent-engine at ${A.engine}, latest main incl. Tomer's RFC-26 exemplar library #249-#279 and his owner-feedback PRs; agent-middleware at ${A.middleware}; karos-portal at ${A.portal}) and say exactly what the thin-middle design (three standards cards: archetype, category pack, involvement, plus audience modifier; L1 carries pooled performance; L3 client DNA) changes: where industry is used today (CLIENT_SEGMENTS, PHOTO_FIRST_INDUSTRY, learning_settings.sector, Client.category/industry, competitor tracking, the exemplar library's niche), what to keep, replace or delete, the classification fields to add, the migration for the 8 current clients, and the order of work. Mark each change as fitting Tomer's current lane or needing a new ticket.`,
]
const designs = await parallel(TOPICS.map((t, i) => () => agent(`${CONTEXT}\n${CARDS}\nRead the layer and taxonomy evidence: ${A.out}/taxonomy.json (judge verdict under "judge:taxonomy"), ${A.out}/robustness.json, ${A.out}/layer-system.json, ${A.out}/dt.json (Don Techno audit: its competitor-scoring fixes).\n\n${t}`, { label: `design:${['relevance', 'compounding', 'impact'][i]}`, phase: 'Design', schema: DESIGN })))
return { picks, tagged: ok.map(r => ({ handle: r.handle, followers: r.followers, craft: r.craft_score })), failed: tagged.filter(Boolean).filter(r => !r.ok).map(r => r.handle), designs: designs.filter(Boolean) }
