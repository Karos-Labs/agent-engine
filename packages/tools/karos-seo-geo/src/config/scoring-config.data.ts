// Verbatim port of the legacy karos-agents lab-spec config (RFC-04 "port the scoring config as-is").
// Source: karos-agents/products/onboarding/step-02-seo-geo/config/seo-geo-scoring-config.json
// DO NOT hand-edit values here — this is a byte-for-fidelity transcription of the JSON asset.
export const scoringConfigData = {
  "version": "a3-scoring-v2",
  "constants": {
    "TARGET_CITE": 0.1,
    "TARGET_MENTION": 0.3,
    "roster_size_field": "competitor_set_hash.roster_count",
    "engine_baseline_share": {
      "chatgpt": 0.0059,
      "perplexity": 0.1305,
      "gemini": 0.04,
      "claude": 0.03,
      "copilot": 0.02
    },
    "sentiment_window": "plus_minus_1_sentence"
  },
  "url_scope": {
    "definition": "sitemap INTERSECT crawl_snapshot reachable URLs",
    "pinned_as": "url_scope_hash (stored inside crawl_snapshot_hash)",
    "applies_to": [
      "BOTH-01",
      "BOTH-02",
      "SEO-06",
      "GEO-02",
      "GEO-19",
      "BOTH-05"
    ]
  },
  "scores": {
    "seo": {
      "weight_total": 100,
      "source_snapshots": [
        "crawl_snapshot_hash"
      ],
      "buckets": [
        {
          "name": "eligibility",
          "weight": 35,
          "inputs": [
            {
              "rec_id": "BOTH-01",
              "measure": "pct of scoped URLs HTTP 200 AND not noindex AND no nosnippet/max-snippet:0 (full snippet eligibility leg)",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 10
            },
            {
              "rec_id": "BOTH-02",
              "measure": "pct of scoped URLs returning main content in anonymous crawlable HTML, no auth/paywall",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 8
            },
            {
              "rec_id": "BOTH-01",
              "measure": "pct of scoped URLs whose robots meta / X-Robots has no noindex (isolated noindex gate leg)",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 7
            },
            {
              "rec_id": "BOTH-09",
              "measure": "sitemap 200 + valid XML AND Sitemap: line in robots.txt AND 0 noindex/non-canonical URLs in sitemap",
              "normalization": "boolean",
              "weight": 5
            },
            {
              "rec_id": "GEO-01",
              "measure": "robots.txt does not Disallow Googlebot for scoped paths AND snapshotted GSC AI opt-out OFF (gsc_ai_optout from crawl_snapshot)",
              "normalization": "boolean",
              "weight": 5
            }
          ]
        },
        {
          "name": "technical_cwv",
          "weight": 25,
          "inputs": [
            {
              "rec_id": "SEO-04",
              "measure": "p75 LCP seconds",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  2.5,
                  1.0
                ],
                [
                  4.0,
                  0.5
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 8
            },
            {
              "rec_id": "SEO-04",
              "measure": "p75 INP ms",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  200,
                  1.0
                ],
                [
                  500,
                  0.5
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 7
            },
            {
              "rec_id": "SEO-04",
              "measure": "p75 CLS",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  0.1,
                  1.0
                ],
                [
                  0.25,
                  0.5
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 5
            },
            {
              "rec_id": "BOTH-19",
              "measure": "viewport meta present AND 360px<->desktop text-node diff ratio >=0.95 AND no horizontal scroll at 360px",
              "normalization": "boolean",
              "weight": 5
            }
          ]
        },
        {
          "name": "on_page",
          "weight": 25,
          "inputs": [
            {
              "rec_id": "BOTH-03",
              "measure": "5-shingle Jaccard similarity vs frozen hashed top-10 snapshot <=0.40 (unique non-commodity content)",
              "normalization": "boolean",
              "weight": 5
            },
            {
              "rec_id": "SEO-02",
              "measure": "title length chars",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  60,
                  1.0
                ],
                [
                  75,
                  0.5
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 5
            },
            {
              "rec_id": "GEO-17",
              "measure": "h1_count == 1 (single H1)",
              "normalization": "boolean",
              "weight": 4
            },
            {
              "rec_id": "SEO-06",
              "measure": "pct scoped URLs with meta description present AND 120<=chars<=158 AND 0 duplicates across crawl",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 3
            },
            {
              "rec_id": "BOTH-05",
              "measure": "internal links per priority page (count, target 3)",
              "normalization": "count_with_target",
              "target": 3,
              "weight": 4
            },
            {
              "rec_id": "GEO-20",
              "measure": "days since genuine dateModified (consistent w/ sitemap lastmod)",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  90,
                  1.0
                ],
                [
                  180,
                  0.5
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 4
            }
          ]
        },
        {
          "name": "structure",
          "weight": 15,
          "inputs": [
            {
              "rec_id": "GEO-02",
              "measure": "share of target H2s with a 40-60 word self-contained capsule at body-offset <=0.30 (target 0.90)",
              "normalization": "ratio_clamp",
              "target": 0.9,
              "weight": 8
            },
            {
              "rec_id": "BOTH-16",
              "measure": "share of sections 120-180 words AND none >300w (anti-micro-chunk per GEO-38) (target 0.80)",
              "normalization": "ratio_clamp",
              "target": 0.8,
              "weight": 7
            }
          ]
        },
        {
          "name": "hygiene_and_reserve",
          "weight": 0,
          "inputs": [
            {
              "rec_id": "GEO-39",
              "measure": "JSON-LD validates with 0 errors; no AI-rationale schema",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "GEO-40",
              "measure": "/llms.txt 200 + Lighthouse llms.txt audit clean, else N/A",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "BOTH-20",
              "measure": "HTTPS site-wide + valid cert + 0 mixed-content (reserve)",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "SEO-05",
              "measure": "soft-404==0 AND redirect chains>1==0 AND param cap; integer count >=0 (reserve)",
              "normalization": "lower_is_better_stepped",
              "bands": [
                [
                  0,
                  1.0
                ],
                [
                  null,
                  0.0
                ]
              ],
              "weight": 0
            },
            {
              "rec_id": "BOTH-07",
              "measure": "canonicals 100% valid AND dup clusters==0 AND single host (reserve)",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "BOTH-08",
              "measure": "raw-HTML word-count >=80% of rendered (reserve)",
              "normalization": "ratio_clamp",
              "target": 0.8,
              "weight": 0
            },
            {
              "rec_id": "SEO-08",
              "measure": "alt-text coverage >=95% (reserve)",
              "normalization": "ratio_clamp",
              "target": 0.95,
              "weight": 0
            }
          ]
        }
      ]
    },
    "geo_readiness": {
      "weight_total": 100,
      "source_snapshots": [
        "crawl_snapshot_hash",
        "entity_snapshot_hash",
        "reviews_snapshot_hash",
        "backlink_export_date"
      ],
      "buckets": [
        {
          "name": "crawler_snippet_access",
          "weight": 28,
          "inputs": [
            {
              "rec_id": "BOTH-01",
              "measure": "pct of scoped URLs HTTP 200 AND not noindex AND no nosnippet/max-snippet:0",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 7
            },
            {
              "rec_id": "BOTH-02",
              "measure": "pct of scoped URLs with primary content in anonymous crawlable HTML AND path not Disallowed for Googlebot",
              "normalization": "ratio_clamp",
              "target": 1.0,
              "weight": 6
            },
            {
              "rec_id": "GEO-01",
              "measure": "robots legs {OAI-SearchBot,PerplexityBot,ClaudeBot,Googlebot,Bingbot} not Disallowed + snapshotted GSC AI opt-out OFF; gsc_verified state is a frozen field, GSC leg dropped from denominator only when gsc_verified==false",
              "normalization": "multi_bool",
              "weight": 6
            },
            {
              "rec_id": "GEO-08",
              "measure": "OAI-SearchBot not Disallowed for audited path AND snapshotted bing_site_count>=1 (ChatGPT pair; ChatGPT-User leg NOT scored, non-enforceable Dec 2025)",
              "normalization": "multi_bool",
              "weight": 5
            },
            {
              "rec_id": "GEO-10",
              "measure": "OAI-SearchBot, PerplexityBot, ClaudeBot, Googlebot each not Disallowed for entity/about pages (4 legs)",
              "normalization": "multi_bool",
              "weight": 4
            }
          ]
        },
        {
          "name": "extractability_capsule",
          "weight": 22,
          "inputs": [
            {
              "rec_id": "GEO-02",
              "measure": "pct of target H2s with 40-60w self-contained capsule at body-offset <=0.30; section 134-167w (target 0.90)",
              "normalization": "ratio_clamp",
              "target": 0.9,
              "weight": 6
            },
            {
              "rec_id": "GEO-18",
              "measure": "recognized entities per 1000w (target 15, version-pinned ner_model_id+gazetteer_hash); gated: norm = anti_stuffing_pass ? min(actual/15,1) : 0; anti_stuffing fails if any non-stop token >3%",
              "normalization": "count_with_target",
              "target": 15,
              "gate": {
                "field": "anti_stuffing_pass",
                "on_fail_norm": 0,
                "order": "gate_applied_after_norm"
              },
              "weight": 4
            },
            {
              "rec_id": "GEO-17",
              "measure": "h1==1 AND zero heading skips AND share of H2/H3 as questions/intent-match >=0.5 (3 legs)",
              "normalization": "multi_bool",
              "weight": 3
            },
            {
              "rec_id": "BOTH-16",
              "measure": "median section 120-180w AND no section >300w AND >=1 definitional X-is <=25w AND Flesch >=50 (4 legs)",
              "normalization": "multi_bool",
              "weight": 3
            },
            {
              "rec_id": "BOTH-21",
              "measure": "primary-keyword density <=2.5% AND no exact phrase >5x AND one primary intent per URL (3 legs)",
              "normalization": "multi_bool",
              "weight": 2
            },
            {
              "rec_id": "GEO-22",
              "measure": "# question-form H2/H3 each followed by <=80w crawlable-HTML answer (target 3)",
              "normalization": "count_with_target",
              "target": 3,
              "weight": 2
            },
            {
              "rec_id": "BOTH-03",
              "measure": "5-shingle Jaccard vs frozen hashed top-10 <=0.40 (differentiation leg)",
              "normalization": "boolean",
              "weight": 2
            }
          ]
        },
        {
          "name": "evidence_density",
          "weight": 15,
          "inputs": [
            {
              "rec_id": "GEO-03",
              "measure": "per-section >=1 numeric stat AND >=1 cited allowlist source; page-level >=1 attributed quote AND >=3 outbound allowlist citations (4 legs) [CONTROLLED causal]",
              "normalization": "multi_bool",
              "weight": 7
            },
            {
              "rec_id": "GEO-09",
              "measure": "citation density + byline + original stat",
              "normalization": "combine",
              "combine": "mean",
              "legs": [
                {
                  "fn": "count_with_target",
                  "field": "inline_cite_per_100w",
                  "target": 0.8
                },
                {
                  "fn": "boolean",
                  "field": "has_named_author_byline"
                },
                {
                  "fn": "boolean",
                  "field": "has_original_statistic"
                }
              ],
              "weight": 5
            },
            {
              "rec_id": "BOTH-11",
              "measure": ">=1 first-person experience marker AND >=1 original (non-sourced) data point (2 legs)",
              "normalization": "multi_bool",
              "weight": 3
            }
          ]
        },
        {
          "name": "freshness",
          "weight": 12,
          "inputs": [
            {
              "rec_id": "GEO-20",
              "measure": "dateModified age gated by consistency and body-change",
              "normalization": "combine",
              "combine": "product",
              "legs": [
                {
                  "fn": "lower_is_better_stepped",
                  "field": "datemodified_age_days",
                  "bands": [
                    [
                      30,
                      1.0
                    ],
                    [
                      90,
                      0.7
                    ],
                    [
                      null,
                      0.0
                    ]
                  ]
                },
                {
                  "fn": "boolean",
                  "field": "date_consistent"
                },
                {
                  "fn": "boolean",
                  "field": "body_changed"
                }
              ],
              "weight": 7
            },
            {
              "rec_id": "GEO-37",
              "measure": "dateModified <=90d on entity/about/pillar pages",
              "normalization": "boolean",
              "weight": 3
            },
            {
              "rec_id": "BOTH-13",
              "measure": "cluster volume + cadence",
              "normalization": "combine",
              "combine": "mean",
              "legs": [
                {
                  "fn": "count_with_target",
                  "field": "indexed_original_articles_in_cluster",
                  "target": 50
                },
                {
                  "fn": "boolean",
                  "field": "publishing_gap_never_over_30d_trailing_6mo"
                }
              ],
              "weight": 2
            }
          ]
        },
        {
          "name": "multimodal",
          "weight": 5,
          "inputs": [
            {
              "rec_id": "GEO-19",
              "measure": "share of priority pages with original media gated by alt completeness",
              "normalization": "combine",
              "combine": "product",
              "legs": [
                {
                  "fn": "ratio_clamp",
                  "field": "share_priority_pages_with_original_media",
                  "target": 0.9
                },
                {
                  "fn": "boolean",
                  "field": "alt_complete"
                }
              ],
              "weight": 5
            }
          ]
        },
        {
          "name": "per_engine_index_reach",
          "weight": 8,
          "inputs": [
            {
              "rec_id": "GEO-24",
              "measure": "snapshotted bing_site_count>=1 AND indexnow_key_http==200 (Copilot + ChatGPT-search reach, 2 legs, from crawl_snapshot)",
              "normalization": "multi_bool",
              "weight": 2
            },
            {
              "rec_id": "GEO-23",
              "measure": "snapshotted brave_site_count>=1 (Claude reach, indexation only; position NOT scored)",
              "normalization": "boolean",
              "weight": 2
            },
            {
              "rec_id": "GEO-41",
              "measure": "snapshotted google_site_count>=1 AND snapshotted GSC AI opt-out OFF (Gemini / AI-Overviews reach, 2 legs)",
              "normalization": "multi_bool",
              "weight": 2
            },
            {
              "rec_id": "BOTH-09",
              "measure": "sitemap 200 + valid XML AND Sitemap: line in robots.txt AND 0 noindex/non-canonical URLs (3 legs)",
              "normalization": "multi_bool",
              "weight": 2
            }
          ]
        },
        {
          "name": "offsite_entity_capped",
          "weight": 10,
          "inputs": [
            {
              "rec_id": "GEO-25",
              "measure": "snapshotted live non-stub Wikipedia article AND Wikidata Q-item with >=5 referenced statements (2 legs, from entity_snapshot_hash)",
              "normalization": "multi_bool",
              "weight": 3
            },
            {
              "rec_id": "GEO-04",
              "measure": "# distinct DR>=40 domains mentioning exact brand in trailing 90d (target 10; DR read from dated backlink_export_date export, not re-queried live; paid excluded)",
              "normalization": "count_with_target",
              "target": 10,
              "weight": 3
            },
            {
              "rec_id": "GEO-07",
              "measure": "snapshotted Wikidata QID resolves with P856 == client root domain (from entity_snapshot_hash)",
              "normalization": "boolean",
              "weight": 2
            },
            {
              "rec_id": "GEO-14",
              "measure": "review rating/platform/count from reviews_snapshot_hash; FTC guard zero undisclosed-incentivized",
              "normalization": "combine",
              "combine": "product",
              "legs": [
                {
                  "fn": "ratio_clamp",
                  "field": "(avg_rating-3.8)/(4.3-3.8)",
                  "target": 1.0
                },
                {
                  "fn": "boolean",
                  "field": "platforms_ge_3"
                },
                {
                  "fn": "boolean",
                  "field": "each_platform_reviews_ge_25"
                }
              ],
              "weight": 2
            }
          ]
        },
        {
          "name": "hygiene",
          "weight": 0,
          "inputs": [
            {
              "rec_id": "GEO-39",
              "measure": "JSON-LD validates 0 errors AND 0 schema types lacking on-page equivalent AND no AI-ranking-rationale schema",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "GEO-40",
              "measure": "/llms.txt 200 + Lighthouse llms.txt audit pass; absent -> N/A no penalty",
              "normalization": "boolean",
              "weight": 0
            },
            {
              "rec_id": "BOTH-12",
              "measure": "Organization JSON-LD sameAs>=4 incl Wikidata; single @id; single canonical brand string (entity hygiene, NOT an AI ranking claim)",
              "normalization": "boolean",
              "weight": 0
            }
          ]
        }
      ]
    }
  },
  "visibility": {
    "engines": [
      "chatgpt",
      "perplexity",
      "gemini",
      "claude",
      "copilot"
    ],
    "source_snapshots": [
      "response_set_hash",
      "competitor_set_hash",
      "gazetteer_hash",
      "classifier_model_id"
    ],
    "index": {
      "weight_total": 100,
      "components": [
        {
          "rec_id": "GEO-11",
          "name": "citation_share",
          "normalization": "ratio_clamp",
          "value": "citation_share_blended",
          "target": "constants.TARGET_CITE",
          "weight": 35
        },
        {
          "rec_id": "BOTH-14",
          "name": "who_ranks_first",
          "normalization": "ratio_clamp",
          "value": "mean_e first_position_rate[e]",
          "target": 1.0,
          "weight": 20
        },
        {
          "rec_id": "GEO-27",
          "name": "share_of_voice",
          "normalization": "ratio_clamp",
          "value": "SOV_client/100",
          "target": "1/roster_size",
          "weight": 20
        },
        {
          "rec_id": "GEO-35",
          "name": "named_mention_rate",
          "normalization": "ratio_clamp",
          "value": "mention_rate_blended",
          "target": "constants.TARGET_MENTION",
          "weight": 15
        },
        {
          "rec_id": "GEO-32",
          "name": "sentiment",
          "normalization": "ratio_clamp",
          "value": "clamp((mean_e net_sentiment + 1)/2, 0, 1)",
          "target": 1.0,
          "weight": 6
        },
        {
          "rec_id": "GEO-26",
          "name": "ghost_penalty",
          "normalization": "ratio_clamp",
          "value": "1 - clamp(mean_e ghost_citation_rate/100, 0, 1)",
          "target": 1.0,
          "weight": 4
        }
      ],
      "formula": "Visibility_Index = round_half_up(100 * sum_component(weight/100 * norm_component)); per-engine index = same components/weights restricted to one engine"
    },
    "metrics": [
      {
        "id": "GEO-11",
        "formula": "citation_share[e] = (sum_p [client root domain in citations[p][e].domain]) / N ; blended = mean over 5 engines",
        "frozen_input": "response_set_hash.citations[].domain, gazetteer_hash client domains"
      },
      {
        "id": "BOTH-14",
        "formula": "first(p,e) = max(first_named, first_cited); first_position_rate[e] = sum_p first / N; emit rank_first_competitor = argmax over competitor_set",
        "frozen_input": "response_set_hash.answer_text offsets + citations[].ordinal, gazetteer_hash, competitor_set_hash"
      },
      {
        "id": "GEO-27",
        "formula": "SOV[b] = mentions(b) / sum_{b' in client+competitor_set} mentions(b') * 100; share_of_voice = SOV[client]; sums to 100 across locked roster",
        "frozen_input": "response_set_hash.answer_text, competitor_set_hash, gazetteer_hash"
      },
      {
        "id": "GEO-35",
        "formula": "mention_share[e] = sum_p named(p,e)/N; mention_rate_blended = sum_pe named/(N*5)",
        "frozen_input": "response_set_hash.answer_text, gazetteer_hash"
      },
      {
        "id": "GEO-26",
        "formula": "ghost_citation_rate[e] = (sum_p cited - sum_p named_AND_cited)/max(sum_p cited,1) * 100; headline ghost-gap = mention_share - citation_share",
        "frozen_input": "response_set_hash answer_text + citations, gazetteer_hash"
      },
      {
        "id": "GEO-32",
        "formula": "net_sentiment[e] = (#pos - #neg)/max(total named mentions,1) over +/-1-sentence mention windows; each mention labeled exactly one of pos/neg/neutral so #pos+#neg <= total guaranteeing range [-1,1]; labels CACHED keyed by (response_set_hash,p,e,mention_index), never re-classified on re-run",
        "frozen_input": "cached labels keyed to response_set_hash, classifier_model_id + frozen lexicon version"
      },
      {
        "id": "GEO-36",
        "formula": "engine_index[e] = citation_share[e] / constants.engine_baseline_share[e]; DIAGNOSTIC ONLY, not folded into Visibility Index (would double-count citation share)",
        "frozen_input": "citation_share[e] / stored versioned baseline constants (part of scoring_weights_version hash surface)"
      }
    ]
  },
  "normalization_fns": {
    "boolean": "norm = 1 if measured == true else 0",
    "count_with_target": "norm = min(actual / target, 1)",
    "ratio_clamp": "norm = clamp(value / target, 0, 1) ; for inputs already a ratio/share or any bounded value with explicit target",
    "percentage": "norm = clamp(value_pct / target_pct, 0, 1) ; for 0-100-native inputs",
    "lower_is_better_stepped": "evaluate bands ascending; return score of first band where value <= bound (null bound = catch-all/floor)",
    "multi_bool": "norm = (# sub-bools passing) / (# sub-bools) ; composition of boolean for partial-credit multi-leg checks",
    "combine": "norm = clamp(combinator(leg_norms), 0, 1) where each leg is one primitive; combinator is mean (average of leg norms) or product (product of leg norms)",
    "points_rule": "input_points = norm * input_weight; score = round_half_up applied ONCE to final 0-100 total only, never to intermediate sums",
    "hygiene_rule": "GEO-39, GEO-40, BOTH-12 run their checks for reporting but input_weight = 0; can never move a score",
    "offsite_cap_rule": "geo_readiness offsite_entity bucket capped at 10 pts total, no single off-site rec > 3 pts; cap is a property of the weight table not a runtime clamp",
    "gate_rule": "an input with a gate object: if gate.field is false, norm forced to gate.on_fail_norm (e.g. GEO-18 anti-stuffing forces 0); otherwise norm computed normally"
  },
  "reproducibility": {
    "hash_inputs": [
      "prompt_set_hash",
      "competitor_set_hash",
      "engine_list_hash",
      "response_set_hash",
      "backlink_export_date",
      "ner_model_id",
      "gazetteer_hash",
      "scoring_weights_version",
      "classifier_model_id",
      "crawl_snapshot_hash",
      "reviews_snapshot_hash",
      "entity_snapshot_hash"
    ],
    "inputs_digest": "SHA-256 over all 12 hash_inputs fields, each UTF-8 encoded, concatenated in the fixed order listed above, joined by the 0x1F unit-separator byte. crawl_snapshot_hash additionally embeds bing_site_count, brave_site_count, google_site_count, indexnow_key_http, gsc_verified, gsc_ai_optout, url_scope_hash. All 12 fields are INSIDE the digest (no sibling-column carve-out).",
    "snapshot_capture_rule": "All site:/IndexNow/Brave/GSC reads (GEO-24/23/41/08/01) are captured into crawl_snapshot_hash at snapshot time and scored from the snapshot, never live. Review data (GEO-14) is read from reviews_snapshot_hash. Wikipedia/Wikidata reads (GEO-25/07) are read from entity_snapshot_hash (Wikipedia revid + Wikidata revision). DR thresholds (GEO-04) read from the dated backlink export, not a live API recompute.",
    "dependency_split": {
      "seo_and_readiness": [
        "crawl_snapshot_hash",
        "ner_model_id",
        "gazetteer_hash",
        "backlink_export_date",
        "reviews_snapshot_hash",
        "entity_snapshot_hash",
        "scoring_weights_version"
      ],
      "visibility": [
        "prompt_set_hash",
        "competitor_set_hash",
        "engine_list_hash",
        "response_set_hash",
        "classifier_model_id",
        "scoring_weights_version"
      ]
    },
    "run_record_fields": [
      "run_id",
      "client_id",
      "run_at",
      "snapshot_id",
      "prompt_set_hash",
      "competitor_set_hash",
      "engine_list_hash",
      "response_set_hash",
      "backlink_export_date",
      "ner_model_id",
      "gazetteer_hash",
      "scoring_weights_version",
      "classifier_model_id",
      "crawl_snapshot_hash",
      "reviews_snapshot_hash",
      "entity_snapshot_hash",
      "inputs_digest",
      "seo_score",
      "geo_readiness",
      "geo_visibility",
      "input_values",
      "group_subtotals",
      "per_engine",
      "inputs_unchanged_since_last_run",
      "drift_log_ref"
    ],
    "per_engine_fields": [
      "citation_share",
      "mention_share",
      "ghost_citation_rate",
      "first_position_rate",
      "rank_first_competitor",
      "share_of_voice",
      "net_sentiment",
      "engine_index"
    ],
    "drift_event_fields": [
      "drift_id",
      "client_id",
      "prev_run_id",
      "new_run_id",
      "changed_fields",
      "version_bump",
      "logged_at",
      "logged_by"
    ],
    "time_series": "scores stored as append-only client_metric series keyed by client_id + run_id (metric_key incl. per-engine keys e.g. geo_vis.perplexity.citation_share); every point traceable to its frozen inputs; flat segment proves nothing changed; scoring_weights_version bump flagged in UI",
    "rule": "For a given client_id, if inputs_digest(run_A) == inputs_digest(run_B) then seo_score, geo_readiness, geo_visibility and every per-engine sub-score are bit-identical integers. Any change to any hashed field writes a drift_event, bumps the relevant version, and is the only permitted way a score changes. metric_run rows are append-only and never mutated. Visibility never re-asks engines live; a live recapture mints a new response_set_hash and a new run. Nothing drifts silently."
  },
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
  },
  "geo_score_model": {
    "version": "geo-score-v3-2026-06-25 (Ines model; supersedes the earlier geo weighting)",
    "method": "10 fixed, client-confirmed prompts sent to each of the 5 engines (ChatGPT, Perplexity, Gemini, Claude, Copilot). Per (prompt,engine) record appears yes/no -> per-engine appearance = count/10.",
    "engine_score_formula": "engine_score = 0.40*appearance + 0.20*citation + 0.15*position + 0.15*share_of_voice + 0.10*sentiment (each component normalized 0-1, *100)",
    "overall": "GEO score = unweighted average of the 5 engine scores",
    "weights": [
      {
        "metric": "appearance",
        "weight": 40,
        "measures": "named in the answer (the X/10 per engine)"
      },
      {
        "metric": "citation",
        "weight": 20,
        "measures": "client domain cited/linked as a source, not just name-dropped"
      },
      {
        "metric": "position",
        "weight": 15,
        "measures": "named first vs buried when present"
      },
      {
        "metric": "share_of_voice",
        "weight": 15,
        "measures": "client mentions vs competitor mentions in the same answers"
      },
      {
        "metric": "sentiment",
        "weight": 10,
        "measures": "positive/neutral/negative tone when mentioned"
      }
    ],
    "weights_total": 100,
    "excluded": [
      "keyword_opportunity (removed per Ines 2026-06-25)",
      "keyword volume / search-opportunity metrics are NOT part of the GEO score"
    ],
    "deterministic": "10 prompts frozen (prompt_set_hash) + answers captured once and frozen (response_set_hash) -> every metric is a plain count/ratio off frozen answers -> identical inputs ALWAYS produce the identical score. No AI re-judgement at score time.",
    "no_estimation": "every count comes from a real captured answer (first-party API for Perplexity/Claude/Gemini; paid tracker returning the real answer for ChatGPT/Copilot). An engine not captured = 'pending', never a guessed number (per grade_data_only_rule).",
    "weights_status": "PROPOSED starting weights — Ines to confirm/tune; the formula recomputes identically with any weight set."
  }
}
;
