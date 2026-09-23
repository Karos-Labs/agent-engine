export * from "./adapters/index.js";
export * from "./primitives/index.js";
export * from "./engine/index.js";
export * from "./serializers/index.js";
export * from "./primitives/topic-guardrail.js";
export * from "./primitives/auto-setup.js";
export * from "./primitives/research-candidate.js";
export * from "./primitives/run-direction.js";
export * from "./primitives/client-voice-context.js";
export * from "./primitives/history-dedup.js";
export * from "./primitives/structural-echo.js";
// A draft is written now and published later; this is the check that a
// sentence anchored to "yesterday" never reaches a client's feed.
export * from "./primitives/dated-language.js";
// The writing-system floor, lifted out of instagram-agent's `language-gate.ts`
// on 2026-09-18 when the TikTok family needed the same table. That table's own
// doc comment is the argument for one copy rather than two.
export * from "./primitives/language-script.js";
// SCRUM-380 (D1-v2): the always-latest Brand Voice read. Appended here rather
// than added to `primitives/index.js` to match how every other
// context-building primitive above is exported, and to keep the change to a
// single new line.
export * from "./primitives/brand-voice.js";
// SCRUM-241 (T-A9): the shared `client.getContextDoc` read, appended the same
// way brand-voice.js was.
export * from "./primitives/context-doc.js";
export * from "./primitives/learning-context.js";
export * from "./primitives/strategy-map.js";
// SCRUM-242 (T-A10): the one shared BLOCK/DEGRADED policy table + enforcement
// helper — appended the same way, one new line per new primitive.
export * from "./primitives/context-doc-policy.js";
// Social channel upgrades (2026-09): trend scouting + content-mode rotation, and
// the shared media resolver for the text-first channels. Appended the same way.
export * from "./primitives/social-trend-scout.js";
export * from "./primitives/social-media.js";
// 2026-09: what the client already said on EVERY channel, including their own
// accounts — the cross-channel anti-repetition memory. Appended the same way.
export * from "./primitives/cross-channel-history.js";
