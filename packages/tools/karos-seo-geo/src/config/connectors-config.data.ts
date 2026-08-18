// Verbatim port of the legacy karos-agents lab-spec config (RFC-04 "port the scoring config as-is").
// Source: karos-agents/products/onboarding/step-02-seo-geo/config/seo-geo-connectors-config.json
// DO NOT hand-edit values here — this is a byte-for-fidelity transcription of the JSON asset.
export const connectorsConfigData = {
  "version": "a3-google-connector-overlay-v1",
  "design_date": "2026-06-24",
  "principle": "Layer 2 (unconnected) is the validated default and fully scorable. Layer 1 (Google connected) is a per-input accuracy upgrade captured into new frozen snapshot hashes on the same deterministic spine. Additive only; clones the Gmail OAuth pattern; folds into the existing scoring config (no separate score-time loader); never alters validated configs/tables; connecting is never a hard dependency.",
  "connectors": [
    {
      "key": "gsc",
      "google_product": "Google Search Console",
      "oauth_scope_readonly": "https://www.googleapis.com/auth/webmasters.readonly",
      "default_consent": true,
      "api": "Search Console API v1 (searchanalytics.query, urlInspection.index.inspect, sitemaps.list)",
      "read_methods_allowlist": [
        "searchanalytics.query",
        "urlInspection.index.inspect",
        "sitemaps.list"
      ],
      "provides": [
        "query positions/impressions/clicks/CTR",
        "Generative-AI / AI-features performance report",
        "AI-features opt-out toggle state (ai_optout_confirmed)",
        "URL-inspection enhancements/issues (Google's own recommendations)"
      ],
      "snapshot_hash": "gsc_snapshot_hash",
      "cron": "google-data-sync @ monthly_geo cadence (5th of month)",
      "note": "Extends the existing seo-gsc edge fn (per-client OAuth replaces the agency GSC_SERVICE_ACCOUNT_KEY path; agency path stays as Karos-property fallback). GSC is a first-party SITE-DATA source, NOT an AI-answer engine; never added to engines[]. crawl_snapshot_hash.gsc_verified/gsc_ai_optout stay FROZEN at capture-time value; the GEO-01/41 opt-out verified flip is sourced from gsc_snapshot_hash.ai_optout_confirmed ONLY, and the drift_event changed_fields lists gsc_snapshot_hash (never crawl_snapshot_hash)."
    },
    {
      "key": "ga4",
      "google_product": "Google Analytics 4",
      "oauth_scope_readonly": "https://www.googleapis.com/auth/analytics.readonly",
      "default_consent": true,
      "api": "Analytics Data API v1 (runReport), Admin API v1 (read)",
      "read_methods_allowlist": [
        "properties.runReport",
        "admin.read"
      ],
      "provides": [
        "native AI-referral channel sessions/conversions (May-2026 'AI Assistant' channel)",
        "organic referrals",
        "conversions/key events"
      ],
      "snapshot_hash": "ga_snapshot_hash",
      "cron": "google-data-sync @ monthly_geo cadence",
      "note": "Outcome/context metrics only. Feeds NO deterministic Index (diagnostics_only). Empty-with-next-step when unconnected, never a fake zero (empty-state lesson)."
    },
    {
      "key": "crux",
      "google_product": "PageSpeed Insights / CrUX (field Core Web Vitals)",
      "oauth_scope_readonly": "NONE — key-gated via PSI_API_KEY (no per-client OAuth)",
      "default_consent": false,
      "api": "PageSpeed Insights API (pagespeedonline.runpagespeed) / CrUX API (chromeuxreport.records:queryRecord)",
      "provides": [
        "real-user field p75 LCP/INP/CLS",
        "Lighthouse lab audit + opportunities (Google's own recommendations)"
      ],
      "snapshot_hash": "crux_snapshot_hash",
      "cron": "captured during google-data-sync (origin-keyed, no token)",
      "per_client_gate": "crux_snapshot_hash un-drops ONLY when a per-client Google-connect opt-in is set, NOT on the global PSI_API_KEY landing. This makes SEO-04 lab->field a logged per-client source change + version bump, never a silent org-wide swap the moment the key lands (Defect-2 fix).",
      "note": "Upgrades SEO-04 lab->field with SAME bands/weights (8/7/5). Per-URL lab fallback when field data absent (crux_data_source frozen per URL). Does NOT ride the OAuth token table."
    },
    {
      "key": "gbp",
      "google_product": "Google Business Profile",
      "oauth_scope_readonly": "https://www.googleapis.com/auth/business.manage (WRITE-CAPABLE; no read-only GBP scope exists)",
      "default_consent": false,
      "scope_hardening": "Kept OUT of the default consent (separate lazy step, local/entity clients only). google-data-sync enforces an explicit READ-method allowlist so a write/post/review-reply endpoint is physically uncallable. Revoke runbook flags elevated risk. Verified-publisher review covers only the default two scopes; adding business.manage later must not re-broaden the default grant.",
      "api": "mybusinessbusinessinformation (read locations) + businessprofileperformance (read insights)",
      "read_methods_allowlist": [
        "mybusinessbusinessinformation.accounts.locations.list",
        "mybusinessbusinessinformation.locations.get",
        "businessprofileperformance.locations.getDailyMetricsTimeSeries"
      ],
      "provides": [
        "verified listing/place_id",
        "categories",
        "NAP",
        "review rating + count",
        "profile completeness"
      ],
      "snapshot_hash": "gbp_snapshot_hash",
      "cron": "google-data-sync @ monthly_geo cadence (only if connected)",
      "note": "Upgrades BOTH-NEW-01 (weight 0 until logged scoring_weights_version bump within the off-site cap of 10pt, no rec >3) and raises GEO-14 review confidence (weight/formula unchanged). Non-local clients => N/A, never penalized."
    }
  ],
  "source_ladder": [
    "first_party_google",
    "measured_ai_capture",
    "research_estimate"
  ],
  "source_ladder_terminal": "UNAVAILABLE (never a fabricated zero; excluded from N_e)",
  "ladder_distinction": "Google/Gemini as an AI-ANSWER ENGINE stays at measured_ai_capture in the Visibility layer and is NOT touched by a GSC connection. Google Search Console is a separate first-party SITE-DATA source at first_party_google feeding SEO/Readiness. The ladder applies per input, not per 'Google'.",
  "input_overlay": [
    {
      "rec_id_or_metric_key": "SEO-04",
      "label": "Core Web Vitals p75 LCP/INP/CLS",
      "connected_source": "crux_snapshot_hash.p75_{lcp,inp,cls} (CrUX field)",
      "connected_confidence": "measured_field",
      "unconnected_fallback": "crawl_snapshot_hash lab p75 via lighthouse-audit",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": false,
      "note": "SAME bands/weights (8/7/5 across LCP/INP/CLS legs); measured value legitimately changes lab->field => drift_event; weights unchanged. Per-URL lab fallback when field absent. Connect-time swap is gated on the per-client opt-in (Defect-2), never the global PSI key."
    },
    {
      "rec_id_or_metric_key": "GEO-01",
      "label": "GSC AI-features opt-out (5 robots legs + opt-out)",
      "connected_source": "gsc_snapshot_hash.ai_optout_confirmed (re-admits the GSC leg)",
      "connected_confidence": "measured",
      "unconnected_fallback": "crawl_snapshot_hash.gsc_verified=false => GSC opt-out leg DROPPED from the multi_bool denominator; partial credit over the remaining robots legs {OAI-SearchBot,PerplexityBot,ClaudeBot,Googlebot,Bingbot} (L329 rule)",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": true,
      "note": "Defect-1 fix: verified flip sourced from gsc_snapshot_hash ONLY; crawl_snapshot_hash.gsc_verified stays frozen at capture value; drift_event.changed_fields lists gsc_snapshot_hash, never crawl_snapshot_hash."
    },
    {
      "rec_id_or_metric_key": "GEO-41",
      "label": "GSC AI-features opt-out (Gemini/AIO reach, 2 legs)",
      "connected_source": "gsc_snapshot_hash.ai_optout_confirmed (re-admits the opt-out leg)",
      "connected_confidence": "measured",
      "unconnected_fallback": "L550 = 2 legs (google_site_count>=1 + GSC opt-out OFF), NO robots legs; gsc_verified=false drops ONLY the opt-out leg, the google_site_count site-presence leg still scores",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": true,
      "note": "Defect-1 fix as GEO-01. Prose corrected: GEO-41 is 2 legs, not robots legs (those belong to GEO-01)."
    },
    {
      "rec_id_or_metric_key": "GEO-28",
      "label": "GSC Generative-AI performance report",
      "connected_source": "gsc_snapshot_hash.genai_report (AI-surface impressions; impressions-only per catalog, no clicks/CTR/query data)",
      "connected_confidence": "measured",
      "unconnected_fallback": "AI-answer capture (response_set_hash) PROXY SUBSTITUTION — a different primitive than GSC AI-surface impressions; never blank",
      "unconnected_confidence": "estimated_proxy",
      "upgrades_from_NEED_GSC": true,
      "note": "Honesty fix: chip reads 'estimated (proxy)' not bare 'estimated' because the unconnected value is a substitute primitive, not the same metric degraded. Diagnostic slot; weight unchanged."
    },
    {
      "rec_id_or_metric_key": "GEO-30",
      "label": "Branded-search demand",
      "connected_source": "gsc_snapshot_hash.branded_query_impressions",
      "connected_confidence": "measured",
      "unconnected_fallback": "third-party brand-volume estimate or omitted-with-disclosure",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": true,
      "note": "Context input, not a weighted leg; no score dependency."
    },
    {
      "rec_id_or_metric_key": "GEO-29",
      "label": "GA4 AI-referral channel",
      "connected_source": "ga_snapshot_hash.ai_referral_sessions_conversions",
      "connected_confidence": "measured",
      "unconnected_fallback": "not measurable unconnected => 'Connect Google Analytics to measure' empty-with-next-step",
      "unconnected_confidence": "unavailable",
      "upgrades_from_NEED_GSC": false,
      "note": "Outcome metric, NOT in any deterministic Index (diagnostics_only). Never a fake zero (empty-state lesson)."
    },
    {
      "rec_id_or_metric_key": "BOTH-NEW-01",
      "label": "Google Business Profile (local/entity)",
      "connected_source": "gbp_snapshot_hash.{verified,categories,nap,review_aggregate}",
      "connected_confidence": "measured",
      "unconnected_fallback": "entity_snapshot_hash (Wikidata/Wikipedia) + reviews_snapshot_hash",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": false,
      "note": "Weight 0 until logged scoring_weights_version bump within off-site cap (10pt total, no rec >3, L752). Off-site bucket scores fully without it. Non-local => not_applicable, no penalty."
    },
    {
      "rec_id_or_metric_key": "GEO-14",
      "label": "Reviews (rating/count)",
      "connected_source": "gbp_snapshot_hash review aggregate (first-party)",
      "connected_confidence": "measured",
      "unconnected_fallback": "reviews_snapshot_hash (third-party export)",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": false,
      "note": "Weight and formula UNCHANGED; only source field + confidence flips."
    },
    {
      "metric_key": "seo.gsc.ranking_family",
      "rec_id_or_metric_key": null,
      "label": "Classic Google positions/impressions/clicks (real ranking signal)",
      "connected_source": "gsc_snapshot_hash.query_rows[]{query,position,impressions,clicks}",
      "connected_confidence": "measured",
      "unconnected_fallback": "only *_site_count index-presence flags (position NOT scored); else third-party rank estimate labelled ESTIMATED",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": true,
      "note": "NEW client-facing DETAIL metric family keyed on metric_key ONLY (no catalog rec_id — BOTH-RANK-01 does not exist in the catalog; avoids a dangling rec_id in the dedup map). Weight 0 in all deterministic Indices (diagnostic). Honest empty state when unconnected, never a fabricated position."
    },
    {
      "rec_id_or_metric_key": "google_own_recommendations",
      "label": "Google's own recommendations (GSC enhancements/issues + Lighthouse)",
      "connected_source": "gsc_snapshot_hash.enhancements_issues + lighthouse-audit -> research_runs.payload.recommendations[] tagged source:'google_connected', confidence:'measured', product_ids:['a3']",
      "connected_confidence": "measured",
      "unconnected_fallback": "deterministic catalog recs + lab Lighthouse only; Google recs omitted (never faked)",
      "unconnected_confidence": "estimated",
      "upgrades_from_NEED_GSC": false,
      "note": "ADDITIVE recommendation rows, never scored inputs, never a gate. Deduped against catalog rec IDs by topic (GSC mobile usability->BOTH-19, Lighthouse LCP->SEO-04, GSC noindex->BOTH-01/GEO-01, structured-data->GEO-39); matches MERGE as corroborating evidence (evidence_source:'google', bumps confidence, no dup line), non-matches APPEND as source:'google' rows."
    }
  ],
  "reproducibility": {
    "new_hashes": [
      "gsc_snapshot_hash",
      "ga_snapshot_hash",
      "crux_snapshot_hash",
      "gbp_snapshot_hash"
    ],
    "hash_set_size": "12 -> 16 (appended in FIXED order gsc,ga,crux,gbp at positions 13-16 after entity_snapshot_hash; GATED on Daniel's sign-off)",
    "data_source_is_frozen": true,
    "data_source_enum": [
      "connected_google",
      "measured_ai_capture",
      "public_crawl",
      "lab",
      "third_party",
      "estimated",
      "snapshot_default"
    ],
    "confidence_enum": [
      "measured",
      "measured_field",
      "measured_grounded",
      "estimated",
      "estimated_proxy",
      "unavailable"
    ],
    "unconnected_sentinel": "UNCONNECTED",
    "back_compat_collapse": "On a Layer-2 run all four overlay hashes == 'UNCONNECTED'. The digest writer DROPS any overlay hash equal to the sentinel before the 0x1F-join, with NO residual separator, so a fully-unconnected overlay run yields the byte-identical inputs_digest as a prior 12-field v2 run. RECOMMENDED over unconditional append; needs Daniel's sign-off (same class as the N vs N_e decision).",
    "byte_order_guarantee": "The four overlay hashes occupy STABLE indices 13-16 in fixed order. A partial connect (e.g. gsc only) keeps the surviving hash at its fixed index and drops the rest cleanly; the 0x1F-join never shifts a downstream byte, so connecting one source cannot fabricate false drift on unrelated inputs. When the whole tail is dropped there is no trailing 0x1F (Defect-3 fix). Until Daniel signs off, the proven-stable 12-field construction stands.",
    "geo01_41_attribution": "Defect-1 fix: GEO-01/41 opt-out verified flips are sourced from gsc_snapshot_hash ONLY. crawl_snapshot_hash.gsc_verified/gsc_ai_optout stay frozen at capture-time value (L68/L329/L770) and do NOT flip on connect. drift_event.changed_fields therefore lists gsc_snapshot_hash, never crawl_snapshot_hash — the labelled step points at the connector.",
    "crux_per_client_gate": "Defect-2 fix: crux_snapshot_hash un-drops ONLY on a per-client Google-connect opt-in, never on the global PSI_API_KEY landing. SEO-04 lab->field is therefore always a logged per-client source change + version bump.",
    "scorer_reads_snapshot_only": "Google is never re-asked live; captured-once-then-frozen like every other input (consistent with L838-839, Visibility never re-asks engines live).",
    "data_source_in_run_hash": "data_source + confidence are written INTO input_values[rec_id] and are inside the run hash (no sibling-column carve-out, consistent with L770).",
    "mid_stream_connect": "logged source change + version bump: nothing recomputes retroactively (past rows immutable); the next scheduled run captures new snapshots, writes a drift_event with changed_fields:[<newly-connected snapshot hash>] + a method_version/scoring_weights_version bump, the renderer draws a labelled STEP ('data source upgraded — now Google-connected'), the trend sentence is suppressed, the segment is colored as a source change (never green/red). data_source flipping with an unchanged value = flat line + source note only.",
    "dependency_split": {
      "seo_and_readiness_add": [
        "crux_snapshot_hash",
        "gsc_snapshot_hash",
        "gbp_snapshot_hash"
      ],
      "visibility_add": [
        "gsc_snapshot_hash (GEO-28 proxy upgrade only)"
      ],
      "diagnostics_only": [
        "ga_snapshot_hash"
      ],
      "guarantee": "Connecting GSC can move SEO-04/GEO-28 while Visibility (Gemini-as-engine, N/N_e) stays provably flat — GSC is not an answer engine."
    }
  },
  "security": {
    "scopes_default_consent": [
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly"
    ],
    "scopes_lazy_separate_consent": [
      "https://www.googleapis.com/auth/business.manage (WRITE-CAPABLE; read-USE only via enforced method allowlist; local/entity clients only; never on the default connect button)"
    ],
    "psi_crux_auth": "PSI_API_KEY server secret — no per-client OAuth scope",
    "write_method_protection": "google-data-sync enforces a per-connector READ-method allowlist (see connectors[].read_methods_allowlist). business.manage is write-capable, so the allowlist makes any write/post/review-reply endpoint physically uncallable — enforced, not a developer convention (FLAG-1 fix).",
    "token_storage": "NEW table client_google_tokens keyed by client_id (subject distinction vs Gmail's team_member_id): provider, account_email, gsc_site_url, ga4_property_id, gbp_account_id, scope, encrypted_refresh_token (AES-256-GCM), encryption_iv, connected_at, revoked_at, updated_at; unique(client_id,provider,account_email). RLS ENABLED, ZERO anon + ZERO authenticated policies, service-role only (email_oauth_tokens/venue_catalog precedent). access_token NOT persisted (minted in memory each sync, gmail-sync risk-review fix). Encryption secret = NEW GOOGLE_CLIENT_TOKEN_ENC_KEY (separate blast radius; env-only, NEVER a DB column).",
    "connection_state_no_anon_leak": "FLAG-2 fix: the portal Connect/Connected chip is derived from the per-client AUTHENTICATED portal context (portal JWT -> server-side lookup), NOT a wire-readable clients column. No connection-existence column ships on any anon-readable table — resolves the conflict with the exposure clause (clients is anon-SELECT).",
    "reuse": "gmail-oauth pattern verbatim: clone gmail-oauth-start/callback -> google-connect-start/callback; clone gmail-sync -> google-data-sync; reuse oauth_state_nonces UNALTERED (provider='google_data', client_id in the state string '<client_id>:<nonce>', team_member_id NULL) — the cloned callback MUST scope its nonce lookup by provider='google_data' so the Gmail and Google-data flows cannot consume each other's nonces (REUSE-FLAG-3 fix); reuse GOOGLE_OAUTH_CLIENT_ID/SECRET; extend seo-gsc + reuse lighthouse-audit. Connect button is CLIENT-FACING in the portal (primary on a3 Service detail page, secondary on Settings/Connections, optional onboarding step) with an ops status mirror; client_id validated server-side against the portal JWT.",
    "cron": "Primary: google-data-sync @ monthly_geo cadence (5th, data pull). Optional: 30-min google-data-sync-health probe (detect revoked/expired, flip revoked_at + 'reconnect' prompt, NOT a data pull). Edge auth: x-api-key vs EDGE_FUNCTION_API_KEY. Clean no-op (200+note) until GOOGLE_OAUTH_CLIENT_* + a non-revoked token row exist.",
    "exposure": "OAuth/refresh tokens, scope strings, vendor/API names, raw GSC/GA rows, and connection-existence-for-other-clients live ONLY in client_google_tokens (zero-anon) and seo_geo_run_internals (zero-anon). NEVER in dashboard_snapshots, client_benchmarks.evidence, or research_runs.payload (anon-readable). Client sees only a 'first-party (connected)' vs 'estimated' chip (reuse shipped .meas/.est chips).",
    "revoke_runbook": "Client/Albert revokes at myaccount.google.com -> Third-party apps; set client_google_tokens.revoked_at=now() (keep audit row, do NOT DELETE); next google-data-sync skips revoked rows => overlay hashes resolve to UNCONNECTED => graceful Layer-2 degrade + a logged drift_event. GBP carries elevated risk (write-capable scope) — note in the runbook. Revoking cannot break the product.",
    "one_time_setup_albert": "Consent screen External+verified (Gmail one is Internal/Workspace-only) with the 2 default read-only scopes (sensitive-scope Google review covers ONLY the default two; business.manage is a separate lazy consent and must not re-broaden the default grant); new redirect URI .../google-connect-callback; secret GOOGLE_CLIENT_TOKEN_ENC_KEY (openssl rand -base64 32, env-only). GOOGLE_OAUTH_CLIENT_ID/SECRET already provisioned."
  },
  "works_unconnected": {
    "guarantee": "For every a3 metric the Layer-2 path is the validated default and produces a complete, scored, deliverable 0-100 result. Connecting Google never adds a REQUIRED input to any deterministic score; it only (a) swaps a measured value into the SAME primitive (SEO-04 lab->field), (b) raises a data_source/confidence label, or (c) lights up weight-0 diagnostic/context metrics. New metrics enter scored buckets ONLY via a logged scoring_weights_version bump. Disconnecting degrades gracefully via the UNCONNECTED sentinel + a logged drift_event; revoking cannot error the product.",
    "per_metric_degradation": [
      "SEO-04 CWV: lab p75 (lighthouse-audit) + same 8/7/5 bands -> full Technical/CWV bucket scores today; connected = same bands, field value (value swap only, per-client-gated).",
      "GEO-01 (5 robots legs + opt-out): gsc_verified=false drops the GSC opt-out leg from the multi_bool denominator, partial credit over remaining robots legs (L329); connected re-admits the leg from gsc_snapshot_hash.",
      "GEO-41 (2 legs): google_site_count site-presence leg scores; gsc_verified=false drops ONLY the opt-out leg (L550, no robots legs); connected re-admits it.",
      "GEO-28 GSC GenAI report: AI-answer capture (response_set_hash) PROXY SUBSTITUTION with 'estimated (proxy)' chip, never blank; connected = real AI-surface impressions (impressions-only). Diagnostic; weight unchanged.",
      "GEO-30 branded search: third-party estimate or 'connect for real data'; weight 0, no dependency.",
      "GEO-29 GA4 AI-referral: explicit empty-with-next-step (empty-state lesson), never a fake zero; not in any Index.",
      "BOTH-NEW-01 GBP: off-site bucket scores fully from entity+reviews snapshots; GBP weight 0 until logged weights bump within the 10pt cap; non-local => N/A no penalty.",
      "classic rankings (seo.gsc.* family, metric_key only): honest empty state ('connect Google'); weight 0 diagnostic; connected = real position/impressions/clicks DETAIL metrics.",
      "Google's own recs: full catalog-derived rec set + lab Lighthouse; Google recs omitted when unconnected (never faked); additive first-party corroboration + new google-tagged recs when connected.",
      "GEO Visibility (Gemini-as-engine): fully measured today, unchanged by any GSC connection (GSC != answer engine)."
    ]
  },
  "open_items": [
    "Sentinel-collapse vs unconditional 16-field digest append — RECOMMEND collapse (keeps v2 runs digest-stable); the 12->16 append is GATED on Daniel's sign-off.",
    "N vs N_e visibility-denominator decision — orthogonal to these connectors (GSC is not an answer engine), remains Daniel's.",
    "Pending per CLAUDE.md: PSI_API_KEY, GA4 'AI Assistant' channel (May 2026), m5 GBP, GSC_SERVICE_ACCOUNT_KEY/GSC_SITE_URL (agency-property fallback path)."
  ]
}
;
