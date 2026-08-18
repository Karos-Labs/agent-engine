// Verbatim port of the legacy triage rubric (RFC-08 §2: "the model extracts, arithmetic routes").
// Source: karos-agents/products/building/reputation-agent-v2/assets/triage-config.json
// DO NOT hand-edit values here — this is a byte-for-fidelity transcription of the JSON asset.
export const triageConfigData = {
  "_comment": "Product-default triage rubric v1. Frozen: a per-client copy is written to clients/<slug>/skills/reputation-agent-v2/triage-config.json at stand-up; any threshold change bumps triage_config_version and is logged as a config-change event (mirrors the a3 drift discipline). All numbers here are configuration defaults pending pilot calibration, not measured claims.",
  "triage_config_version": "1.2.0",
  "proposed_actions": {
    "_comment": "Proposal-first doctrine (Ines, 2026-07-31): a FLAG is never homework — every FLAG row carries the action we propose, chosen deterministically by FIRST MATCH in rule order (order = priority). `when_any_signal` matches exact signal names; `when_any_signal_prefix` matches prefixed signals (e.g. crisis_keywords:...). RESPOND rows carry their proposal as the attached draft; NO_ACTION rows carry their reason. Editing these rules bumps triage_config_version.",
    "rules": [
      { "id": "crisis-escalation", "when_any_signal_prefix": ["crisis_keywords:"],
        "action": "Escalate today: alert the owner, post one calm public acknowledgment (no arguing specifics), and move the conversation to a direct channel. Draft attached when eligible." },
      { "id": "burst-response", "when_any_signal": ["burst_context"],
        "action": "Part of a negative burst: reply to each member individually (never copy-paste), name the shared issue once the cause is known, and watch the crisis panel for the burst trigger." },
      { "id": "influencer-priority", "when_any_signal": ["influence_badge"],
        "action": "High-visibility author: priority reply within 24h in the brand voice; show the owner before posting." },
      { "id": "service-recovery", "when_any_signal": ["service_recovery_opportunity", "fixable_complaint"],
        "action": "Service recovery: warm 1-2 sentence apology with the concrete fix, invite the reviewer back, and log the complaint theme for an operational fix." },
      { "id": "factual-correction", "when_any_signal": ["factual_error"],
        "action": "Polite correction: state the accurate fact once, point to where the right answer lives, no debate." },
      { "id": "answer-question", "when_any_signal": ["has_question"],
        "action": "Answer the question directly in a short public reply — questions in reviews are read by every future customer." },
      { "id": "low-rating-outreach", "when_any_signal": ["rating_1", "rating_2"],
        "action": "Warm recovery reply per the response doctrine (1-2 sentences, no defensiveness), then invite the reviewer to continue offline." }
    ],
    "already_responded": "Already answered publicly: no new reply — keep the review in the monthly themes only.",
    "default": "Read and decide: approve the suggested reply angle or log the review as a theme; nothing here is urgent on its own."
  },
  "value_signals": {
    "has_question": 30,
    "factual_error": 25,
    "fixable_complaint": 20,
    "service_recovery_opportunity": 15,
    "detailed_positive": 10,
    "platform_visibility": { "google": 10, "yelp": 8, "default": 5 }
  },
  "recency_decay": {
    "full_value_within_days": 30,
    "zero_value_after_days": 180
  },
  "urgency_signals": {
    "rating_1": 35,
    "rating_2": 25,
    "crisis_keyword": 40,
    "influence_badge": 10,
    "burst_context": 20
  },
  "routes": {
    "flag_threshold": 50,
    "respond_threshold": 40
  },
  "crisis": {
    "rating_dip": { "delta": 0.3, "window_days": 7, "min_reviews_in_window": 3, "baseline_days": 30 },
    "negative_burst": { "count": 3, "max_rating": 2, "window_hours": 72 },
    "keyword_instant": true,
    "max_trigger_age_days": 30
  },
  "crisis_keywords": {
    "en": [
      "scam", "fraud", "lawsuit", "lawyer", "legal action", "take you to court",
      "police", "unsafe", "injury", "injured", "food poisoning", "got sick",
      "health hazard", "discrimination", "discriminated", "harassment",
      "racist", "sexist", "chargeback", "report you", "reporting you",
      "consumer protection", "better business bureau", "the press", "news story",
      "data breach", "stolen", "theft"
    ],
    "pt": [
      "golpe", "fraude", "processo", "processar", "advogado", "procon",
      "justiça", "denúncia", "denunciar", "polícia", "inseguro",
      "discriminação", "assédio", "racista", "imprensa", "vazamento de dados",
      "roubo", "roubado", "estorno negado"
    ]
  }
}
;
