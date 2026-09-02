// Verbatim port of the legacy karos-agents lab-spec config (RFC-04 "port the scoring config as-is").
// Source: karos-agents/products/onboarding/step-02-seo-geo/config/seo-geo-capture-config.json
// DO NOT hand-edit values here — this is a byte-for-fidelity transcription of the JSON asset.
//
// ── SCRUM-396: PARTLY HISTORY. Read this before quoting anything below. ──
//
// This is the transcription of `geo-capture-v1.1`. Its provenance is the whole
// point of the file, so nothing in it is edited — but v1.1 is no longer the
// authority on the engine list, and three things below will mislead a reader
// who takes them as current:
//
//   * `engines[]` (5 entries) — superseded by `SEO_GEO_VISIBILITY_ENGINES` in
//     `../types.ts`, which is seven: v1.1 predates `aimode` and `google_aio`.
//     The per-engine method/limits/cost notes here are still the best record of
//     HOW each of those five is captured, and `claude`'s entry in particular is
//     the costed first-party spec `capture-adapters/claude.ts` implements.
//   * `presentation.hero_honesty`'s "across 5 engines" and
//     `presentation.ranking_report`'s "add 5th engine column" — engine counts
//     frozen at v1.1. Nothing renders these strings (they are design notes, not
//     copy), and the report states its own engine list as of SCRUM-396, so a
//     renderer has no reason to read a count from here. Do not start.
//   * `presentation.measured_vs_estimated`'s per-engine tier roll-call — same
//     vintage; `SEO_GEO_VISIBILITY_ENGINE_SPECS` is the current statement of
//     which engines this build captures and why.
//
// The v2 skill did exactly this to its own predecessor doc rather than silently
// rewriting it (`docs/SEO-GEO-V2-CAPTURE-CONTRACT.md`'s HISTORY banner). Same
// treatment here, for the same reason: SCRUM-387 and SCRUM-396 were both caused
// by someone building against a document's text instead of its current state.
export const captureConfigData = {
  "version": "geo-capture-v1.1",
  "extends": "karos-geo-monitor Phase 1-2-5 (edge fn geo-monitor, monthly_geo cron)",
  "feeds": "seo-geo-scoring-config.json visibility.*",
  "engines": [
    {
      "key": "perplexity",
      "query_method": "first_party_sonar_api",
      "api": "Perplexity Sonar (sonar / sonar-pro)",
      "available": true,
      "extracts": [
        "answer_text",
        "citations[].url",
        "citations[].domain",
        "citations[].ordinal",
        "citations[].title"
      ],
      "limits": "Native citations as response metadata, no token cost; freeze with the blob. API key runs on DRAINING CREDITS since 2026-06-12 (Pro sub killed). Pre-flight credit probe AND per-cell 402 handling mid-batch: a cell that 402s flips to UNAVAILABLE with a logged note, never a silent zero; tiering is per cell, not a binary per-engine flip. Cached 24h.",
      "cost_note": "~$0.001-0.003/query (sonar); $3/$15 per 1M tok + per-request context fee (pro)",
      "capture_label_default": "MEASURED"
    },
    {
      "key": "claude",
      "query_method": "first_party_api_web_search_tool",
      "api": "Anthropic Messages API + web_search server tool",
      "available": true,
      "extracts": [
        "answer_text",
        "citations[].url",
        "citations[].domain",
        "citations[].ordinal",
        "citations[].title"
      ],
      "limits": "Native cited_text/title/url blocks, citation fields do not bill tokens. Brave-backed index (GEO-23). Use Haiku-class for the raw capture call, never the report model.",
      "cost_note": "$10 per 1,000 searches + Haiku capture tokens ~= $0.012-0.02/query",
      "capture_label_default": "MEASURED"
    },
    {
      "key": "gemini",
      "query_method": "first_party_grounding_api",
      "api": "Gemini API 'Grounding with Google Search' (groundingMetadata)",
      "available": true,
      "extracts": [
        "answer_text",
        "citations[].url",
        "citations[].domain",
        "citations[].ordinal",
        "ai_overview_present"
      ],
      "limits": "API-grounded surface is MEASURED but NOT identical to the literal consumer AI Overview; labelled 'MEASURED (grounded)', no equivalence claimed. AIO-absent cell = no_ai_overview, a distinct status excluded from the Gemini denominator (N_e), never brand-absent. ai_overview_present is read only from the frozen field, never recomputed from a re-query. Literal AIO via SerpAPI google_ai_overview is OFF BY DEFAULT (supplementary ESTIMATED-source, manual opt-in only): it is the exact product under Google's DMCA suit vs SerpApi (filed 2025-12-19 N.D.Cal., motion to dismiss 2026-02-20, hearing 2026-05-19). SHARED-VENDOR RISK: same SerpApi family as the ChatGPT path. TWO-GOOGLE-SURFACES CAVEAT (v1.1, per claude-seo v2.2.0 seo-geo): Google now has TWO distinct AI citation surfaces — AI Overviews (ranking-correlated) and AI Mode (Gemini 3.5 Flash, 1B+ users, broader pool weighting freshness+entity authority). Ahrefs 540K-pair study: they reach the same conclusion ~86% of the time but cite the same URLs only 13.7% of the time. This grounded column approximates NEITHER exactly and must not be read as 'the Google AI surface'. OPEN DECISION (Daniel): add a distinct 6th 'Google AI Mode' column (would start ESTIMATED/tracker-based like Copilot; SE Ranking ai_mode_sov or GSC's Generative-AI report are the candidate sources) vs keep one grounded column with this caveat. Not built in v1.1.",
      "cost_note": "Gemini token cost + per-search grounding fee",
      "capture_label_default": "MEASURED_grounded"
    },
    {
      "key": "chatgpt",
      "query_method": "first_party_api_web_search_tool",
      "api": "OpenAI Responses API with a FORCED web_search tool (tool_choice: {type: web_search}), reading output_text + url_citation annotations (gpt-4o class). Verified live 2026-07-14 on a full 20-prompt run (search_ran=true on every cell). Method upgraded 2026-07-14 from third_party_scraper_or_tracker: this is the same first-party search-grounded family as the Claude and Gemini columns.",
      "available": true,
      "extracts": [
        "answer_text",
        "citations[].url",
        "citations[].domain",
        "citations[].ordinal"
      ],
      "limits": "The API search surface is MEASURED but NOT identical to the literal consumer ChatGPT app; labelled 'MEASURED (api-search)', no equivalence claimed (mirrors the Gemini grounded caveat). The web_search tool MUST be forced via tool_choice: an unforced call answers from model memory with ZERO citations and MUST NOT be labelled measured. Plain Chat Completions never counts as MEASURED. Verify a web_search_call item exists in output before assigning the measured tier; else the cell is ESTIMATED. Dedupe repeated url_citation URLs preserving first-occurrence order before assigning ordinals. Optional literal-consumer-surface alternative: SearchApi.io chatgpt_search (SerpApi exposes NO chatgpt engine, probed live 2026-07-14).",
      "cost_note": "OpenAI web_search tool calls: standard token pricing + search tool fee; a 20-prompt column ~ $0.5-1",
      "capture_label_default": "MEASURED_api_search_if_search_ran_else_ESTIMATED"
    },
    {
      "key": "copilot",
      "query_method": "third_party_tracker_or_manual",
      "api": "No public consumer-answer API. Third-party tracker (Otterly/Profound) or manual capture; Bing/IndexNow-backed (GEO-24).",
      "available": "partial",
      "extracts": [
        "answer_text",
        "citations[].url",
        "citations[].domain",
        "citations[].ordinal"
      ],
      "limits": "Weakest to capture programmatically; default ESTIMATED unless a paid tracker feed is wired. Engine baseline 0.02. Never a fabricated MEASURED zero. Presentation: all-ESTIMATED Copilot column is visually de-weighted so it does not read as equal-confidence data.",
      "cost_note": "Otterly ~$29/mo / Profound ~$499/mo, or analyst time",
      "capture_label_default": "ESTIMATED"
    }
  ],
  "prompt_set": {
    "generation": "Sonnet drafts 20-35 high-intent prompts per client in the client's language from category/profile/competitors (never hardcoded); one Haiku pass tags intent type + de-dupes (5-shingle). Per-intent-type quota enforced so coverage is guaranteed and reproducible.",
    "intent_types": [
      "discovery",
      "comparison",
      "brand",
      "problem",
      "navigational"
    ],
    "client_confirmation": "One approval screen (existing approval_queue): client keeps/edits/deletes/adds prompts (edits re-tagged by Haiku); per kept prompt approves desired_outcome enum (named_first|named_in_answer|cited|not_applicable) + desired_positioning sentence; confirms 3-8 competitor roster and gazetteer aliases + root domains.",
    "desired_outcome_prefill_default": "named_in_answer",
    "prefill_rule": "Pre-fill is NEUTRAL: default desired_outcome = named_in_answer (never named_first, which makes every prompt read as failure; never not_applicable, which hides gaps). The pre-fill rationale is shown next to each toggle so the client makes a real choice, not a rubber-stamp.",
    "appearance_target_scope": "desired_positioning/appearance_target is descriptive context for the gap narrative + implementation brief ONLY, deliberately excluded from the deterministic Index so an opinion cannot move a score.",
    "frozen_as": "prompt_set_hash"
  },
  "response_set": {
    "per_prompt_engine_fields": [
      "prompt_id",
      "prompt_intent",
      "engine",
      "capture_method",
      "capture_source",
      "capture_tier",
      "captured_at",
      "status",
      "raw_blob_ref",
      "raw_sha256",
      "answer_text",
      "answer_text_sha256",
      "ai_overview_present",
      "brand_mentioned",
      "brand_first_mention.char_offset",
      "brand_first_mention.mention_ordinal",
      "brand_first_mention.sentence_index",
      "competitors_named[].brand_id",
      "competitors_named[].char_offset",
      "competitors_named[].appearance_ordinal",
      "mention_counts{brand}",
      "citations[].domain",
      "citations[].url",
      "citations[].ordinal",
      "brand_cited",
      "brand_first_citation_ordinal",
      "sentiment.per_mention[].mention_index",
      "sentiment.per_mention[].label",
      "sentiment.cache_key"
    ],
    "non_scoring_fields": {
      "note": "These captured fields feed NO scoring metric; flagged so the 'every field feeds a metric' claim is qualified to the parsed scoring subset.",
      "prompt_intent": "prompt-set quota/dedup + display metadata only; not in any visibility metric and not in hash_composition.",
      "ai_overview_present": "Gemini denominator gate (excludes no_ai_overview cells from N_e); not a metric value itself.",
      "provenance": [
        "raw_blob_ref",
        "raw_sha256",
        "captured_at",
        "capture_source"
      ]
    },
    "parsing_rules": [
      "Pure string-match/ordinal against pinned gazetteer_hash + competitor_set_hash; no LLM judges any number.",
      "Gazetteer match: case_insensitive + accent_insensitive (e.g. PT-BR Sao==Sao) + word_boundary + longest_form_wins + min_token_len_for_acronym=2 (guards short two-letter brand acronyms).",
      "Sentence tokenize via frozen VERSIONED PT/EN-aware regex (tokenizer_version) for sentence_index and the +/-1-sentence sentiment window; tokenizer_version folded into classifier_model_id (FLAG 4).",
      "mention_ordinal/appearance_ordinal = 1-based rank of brand first-appearances sorted by char_offset ascending.",
      "citations[].domain = PSL-normalized registrable root domain; psl_version is pinned INSIDE gazetteer_hash so a PSL update logs a drift_event (FLAG 3).",
      "citations[].ordinal = engine return order; for third-party scrapers (chatgpt/copilot) citations are stably sorted by (url, first_DOM_appearance_index) BEFORE ordinal assignment so the frozen ordinal is reproducible from raw_blob and two scrapes of an unchanged answer mint the same hash (FLAG 2).",
      "brand_cited = client root_domains intersect citations[].domain != empty; brand_first_citation_ordinal = min matching ordinal.",
      "Sentiment: client mentions only, +/-1-sentence window, Haiku + frozen lexicon (classifier_model_id), label in {pos,neg,neutral}, CACHED keyed (response_set_hash, classifier_model_id, prompt_id, engine, mention_index) (FLAG 1: classifier_model_id added to the cache key); never re-classified; any sentiment recompute forbidden unless a new response_set_hash is minted.",
      "Denominator N_e = records where capture_tier != UNAVAILABLE; UNAVAILABLE and no_ai_overview excluded so a dead engine does not dilute others; MEASURED and ESTIMATED both count. ai_overview_present read only from the frozen field, never recomputed from a re-query (FLAG 5). Capture also freezes plain N per cell so the config's current N-based formulas remain reproducible from the same blob until the N-vs-N_e decision is resolved.",
      "capture_tier set at capture PER CELL and frozen; never silently upgraded; client's own absence is MEASURED where the run executed, competitor bars on ESTIMATED runs carry the pattern-estimate disclosure verbatim."
    ],
    "frozen_as": "response_set_hash",
    "hash_composition": "SHA-256 over RFC-8785-canonical records sorted by (prompt_id,engine), covering only fields that would change a metric: capture_method, capture_tier, answer_text_sha256, citations[]{domain,url,ordinal}, cached sentiment labels. Sibling frozen fields stored ALONGSIDE not inside: prompt_set_hash, competitor_set_hash, engine_list_hash, gazetteer_hash (now embeds psl_version), classifier_model_id (now embeds tokenizer_version + frozen lexicon version). These six are the Visibility subset of the 12-field inputs_digest (reproducibility.dependency_split.visibility). After FLAGs 1/3/4 every previously sibling-escapable input (classifier model, psl_version, tokenizer_version) is inside a drift-tracked hash; nothing moves a score silently.",
    "feeds_metrics": [
      {
        "metric_rec_id": "GEO-11",
        "weight": 35,
        "from_fields": [
          "brand_cited",
          "citations[].domain",
          "gazetteer client root_domains",
          "N_e"
        ]
      },
      {
        "metric_rec_id": "BOTH-14",
        "weight": 20,
        "from_fields": [
          "brand_first_mention.mention_ordinal",
          "brand_first_citation_ordinal",
          "competitors_named[].appearance_ordinal",
          "citations[].ordinal",
          "N_e"
        ]
      },
      {
        "metric_rec_id": "GEO-27",
        "weight": 20,
        "from_fields": [
          "mention_counts{brand}",
          "competitor_set_hash roster"
        ]
      },
      {
        "metric_rec_id": "GEO-35",
        "weight": 15,
        "from_fields": [
          "brand_mentioned",
          "N_e"
        ]
      },
      {
        "metric_rec_id": "GEO-32",
        "weight": 6,
        "from_fields": [
          "sentiment.per_mention[].label (cached)"
        ]
      },
      {
        "metric_rec_id": "GEO-26",
        "weight": 4,
        "from_fields": [
          "brand_cited",
          "brand_mentioned"
        ]
      },
      {
        "metric_rec_id": "GEO-36",
        "weight": "diagnostic_only_not_in_index",
        "from_fields": [
          "citation_share[e]",
          "constants.engine_baseline_share[e]"
        ]
      }
    ]
  },
  "open_scoring_decisions": {
    "N_vs_N_e": "BLOCKING, for Daniel. seo-geo-scoring-config.json divides every visibility metric by N (prompt count) and GEO-35 blended is hard-coded /(N*5). This capture uses N_e = records where capture_tier != UNAVAILABLE, which differs from N the moment any cell is UNAVAILABLE or no_ai_overview, so the two definitions do NOT produce bit-identical scores. Recommendation: amend config formulas to N_e, drop the *5 constant (use sum_e N_e), and add the no_ai_overview/UNAVAILABLE carve-out to the scored model. Until sign-off, capture freezes BOTH N and N_e per cell. This is a scoring-model change, not a capture detail.",
    "source_snapshots_gap": "config visibility.source_snapshots lists only [response_set_hash, competitor_set_hash, gazetteer_hash, classifier_model_id]; extend it to also include prompt_set_hash and engine_list_hash to match reproducibility.dependency_split.visibility (6 fields)."
  },
  "presentation": {
    "client_view_fields": [
      "appears_yes_no",
      "position_who_is_first",
      "who_is_ahead_ordered",
      "share_among_tracked_roster_pct",
      "citation_share_pct",
      "sentiment",
      "ghost_gap",
      "blended_visibility_index_0_100",
      "desired_vs_actual_per_prompt",
      "per_cell_MEASURED_or_EST_chip"
    ],
    "sov_label": "GEO-27 surfaced as 'share among tracked roster', NOT unqualified 'share of voice' (mentions of brands outside the 3-8 roster are excluded from the denominator, so an open-roster SOV would be inflated).",
    "ranking_report": "Extend generateGeoReport: add 5th engine column (Copilot) to grid header + cell loop; reuse existing .meas/.est chips, share bars, per-engine cards. Cell = first/appears/absent + frozen tier chip. The all-ESTIMATED Copilot column is visually de-weighted (muted header, no solid chip) so it does not read as equal-confidence data. Add desired-vs-actual narrative line per prompt.",
    "hero_honesty": "Hero = blended Index + 'appears in X% across 5 engines'. When fewer than 3 engines are MEASURED this run, the tier mix moves INLINE into the hero (e.g. '2 measured, 1 grounded, 2 estimated') and a MEASURED-only Index is shown alongside, rather than being footnoted.",
    "aio_fire_rate": "Gemini AIO-fire rate is reported as an OBSERVED per-run statistic (sum ai_overview_present / N), never a hardcoded prose constant, so the figure cannot go stale.",
    "share_of_model_dashboard": "Per-engine time series keyed geo_vis.<engine>.<metric>; flat line = feature (nothing changed); step = new response_set_hash; run-provenance row carries all 12 hashes + tier mix; roster SOV stacked bars sum to 100; ghost-gap and GEO-36 baseline panels (diagnostic).",
    "measured_vs_estimated": "capture_tier (MEASURED|MEASURED_grounded|ESTIMATED|UNAVAILABLE) frozen PER CELL, surfaced as the per-cell chip exactly like the shipped reports. Perplexity+Claude unconditionally MEASURED; Gemini MEASURED(grounded); ChatGPT/Copilot MEASURED only when scraper/tracker returned text else ESTIMATED; never a fabricated MEASURED zero; client's own absence is MEASURED wherever the run executed (e.g. a measured 0% appearance)."
  },
  "reuses": {
    "skill": "karos-geo-monitor",
    "function": "geo-monitor",
    "cadence": "monthly_geo",
    "degradation": "Perplexity credit pre-flight probe + per-cell 402 handling (closes api-credit-watchdog Perplexity gap); cost caps honored; Haiku capture/Sonnet synth; a fresh capture = new response_set_hash = new append-only metric_run + drift_event.",
    "cost_note": "Full 5-engine 35-prompt MEASURED run ~= $1.5-3; well under the $200/mo ceiling on monthly cadence."
  },
  "build_order": "Capture writers first (mint prompt_set_hash -> competitor_set_hash/gazetteer_hash -> frozen answer_records -> response_set_hash, with classifier_model_id sibling), then Daniel's pure-function scorer reading only the frozen set. Blocked items: N-vs-N_e sign-off; source_snapshots extension; Gemini literal-AIO OFF pending 2026-05-19 hearing; Copilot MEASURED pending a wired tracker feed.",
  "google_connector_overlay_ref": {
    "ref_doc": "SEO-GEO-GOOGLE-CONNECTORS.md",
    "ref_config": "seo-geo-connectors-config.json",
    "summary": "Two-layer Google data model: connected (first-party GSC/GA4/CrUX/GBP, highest accuracy) overlays these inputs; unconnected = this config's research/lab/estimate values (the default, always works). Per-input mapping lives in the connectors overlay.",
    "gated_on_daniel": "Deeper edits in seo-geo-connectors-config-edits.txt (hash_inputs 12->16 append + sentinel-collapse digest rule, the inline google_overlay block) are GATED on Daniel's determinism sign-off and NOT yet applied here.",
    "added": "2026-06-24"
  },
  "grade_data_only_rule": {
    "rule": "GRADE = MEASURED DATA ONLY (hard rule, 2026-06-25, Albert/Ines).",
    "definition": "Every number that feeds a grade (SEO score, GEO readiness, GEO visibility, per-engine sub-scores) must come from a REAL capture: a first-party API call, a real third-party capture where the tool returned the actual answer/data, connected-Google data, or a real site fetch. ESTIMATED values (filled from a pattern, not actually queried) are NEVER included in any grade.",
    "estimated_inputs": "excluded from the grade; may appear only as clearly-labelled CONTEXT, never in the number.",
    "need_data_inputs": "excluded from the grade; shown as 'pending', never guessed.",
    "third_party_is_data": "A paid third-party tracker (e.g. ChatGPT/Copilot via SerpApi/Otterly) that returns the REAL answer text COUNTS as measured data. 'Third-party' is not 'estimated'. Pattern-estimation does NOT count.",
    "coverage": "The grade carries a data_coverage % = measured weight / total weight. A grade is issued only over the inputs with real data; uncovered weight is shown as 'pending', and the score is labelled partial until coverage is complete.",
    "dependency": "A full grade therefore requires the engine captures wired (Perplexity Sonar + Claude API + Gemini grounding first-party; a paid tracker for ChatGPT + Copilot) AND the client connecting Google (for CWV field data, rankings, opt-out). Until then the grade covers only what is truly measured."
  }
}
;
