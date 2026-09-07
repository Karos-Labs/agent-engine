# 2026-09-07 — Research agents: measure the site, ask the buyer's questions

**Status:** decided and shipped (agent-engine `fix/research-agents-elite`, karosCMO
`fix/regenerate-condense-and-research-facts`).

## What was wrong

A Regenerate for the Geektime client (prep, 2026-09-07) produced:

- **SEO 30, GEO-Readiness 19** with every measured input passing. Only the
  technical crawl fed real measurements (30% of the SEO weight, 19% of GEO), and
  `grade_data_only_rule` scores every unmeasured input 0. The score was a
  statement about our instrumentation, not the site. Three of the four Phase 2
  fan-out slots (`on-page`, `performance-cwv`, `keyword-content-gaps`) were
  `research.pull` web searches for the bare domain string — a placeholder.
- **AI visibility 0** on the portal (category prompts only): the prompt set was
  five English industry-string templates per intent — "What are the best
  Technology news & media companies to work with in 2026?" — for a Hebrew
  Israeli tech news site. Its buyers never ask that. Brand prompts named it 10/10.
- **Competitor roster empty** on onboarding: the intel report that would have
  supplied it runs in parallel.
- **Intel report** drafted from six web results about the *category*, with no
  page of the client's own site in evidence and a craft rule to "score 50-65 when
  uncertain" — every client landed in the mid-60s.
- **The Regenerate failed** although both engine runs completed: the portal's
  client-tier condensation of two escalated documents went to Opus alone, Opus
  answered `No output generated`, and a single failed condensation threw the whole
  pipeline.

## What changed

### agent-engine

- `research.auditOnPage` (karos-research): plain-GET HTML for up to 8 pages,
  parsed by a dependency-free extractor (`html-signals.ts`): titles, descriptions,
  robots meta, canonical, headings + per-section word counts + opening capsules,
  JSON-LD, dates, bylines, links, media, stats/quotes/first-person markers,
  keyword density, Flesch (Latin only), mixed content, content hash; plus
  `/llms.txt` and sitemap `<lastmod>` cadence; body-change detection against the
  previous audit of the same seed.
- `research.fetchCoreWebVitals`: PageSpeed Insights v5 — CrUX p75 LCP/INP/CLS
  (field data only feeds the score; lab is diagnostic). Reads `PSI_API_KEY`,
  now mounted from the existing `psi-api-key` secret in both cloudbuild files.
  The .env.example "Defect-2" gate (no silent lab→field basis change) is met
  by step 06 logging a per-client `measurement_source_change` decision.
- `research.lookupEntity`: Wikidata by name + aliases, accepting only an item
  whose P856 is the client's domain; referenced-statement count, sitelinks, and a
  Wikipedia intro stub check.
- `buildTechnicalMeasurements` now takes all four snapshots. Measurable weight
  went from 30 → ~90 (SEO) and 19 → ~70 (GEO) on a first run. Inputs that need
  Search Console / Bing / Brave, NER, sentiment, backlinks, reviews or a top-10
  SERP snapshot stay honestly unavailable.
- `ScoreBreakdown.measuredBasisScore`: points over measured weight, always shown
  next to `dataCoveragePct`; never replaces `score`.
- `SeoGeoPromptSetAgent` (`seo-geo-prompt-set@1`): drafts the prompt set in the
  buyer's language and market with brand aliases and a real competitor roster;
  production wiring passes `promptDrafter: "agent"`; templates remain the
  fallback. `PROMPT_TEMPLATE_VERSION` → 4 so every client redrafts once.
  `research.captureVisibility` 1.3.0 matches `clientBrandAliases`.
- The report carries `measuredFacts`, `measurementSources`, the roster and
  aliases; step 20 writes `seoGeoLatestSnapshot` to client memory.
- intel-report-agent steps `01f-01i`: the client's site audited, the client
  researched by name, competitor homepages read, the SEO/GEO snapshot loaded;
  `intel-report-craft@6` scores from evidence with a `rationale` per dimension.

### karosCMO

- Condensation: escalated routes fall back to the Sonnet chain; one retry on
  transient errors; a document that still fails is written without its
  client-tier copy (allowed by the contract) instead of failing the Regenerate.
- Context docs and the SEO/GEO asset show the measured facts and the
  measured-basis figure next to each score; `clientSeoGeo` carries both.

## Still unavailable (by design, not oversight)

GSC AI opt-out (GEO-01/GEO-41), Bing/Brave/Google `site:` counts and IndexNow
(GEO-08/23/24/41), NER entity density (GEO-18), the frozen top-10 shingle
comparison (BOTH-03), backlink DR (GEO-04), review platforms (GEO-14), the
360px layout legs of BOTH-19, SEO-05 redirect chains, BOTH-08 rendered word
count. Each needs a connector or a browser this environment does not have.
