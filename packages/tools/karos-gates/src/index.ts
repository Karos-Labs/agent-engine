import type { AgentToolRegistry } from "@agent-engine/core";
import { lintPost } from "./lint-post.js";
import { noPlaceholder } from "./no-placeholder.js";
import { brandCompliance } from "./brand-compliance.js";
import { leakCheck } from "./leak-check.js";
import { numbersSourced } from "./numbers-sourced.js";
import { subredditRules } from "./subreddit-rules.js";
import { nativeLanguage } from "./native-language.js";

export * from "./lint-post.js";
export * from "./no-placeholder.js";
export * from "./brand-compliance.js";
export * from "./leak-check.js";
export * from "./numbers-sourced.js";
export * from "./subreddit-rules.js";
export * from "./native-language.js";

/** The `karos-gates` MCP server's tool registry (RFC-01 §9.2) — deterministic validators, no model calls. */
export function createKarosGatesTools(): AgentToolRegistry {
  return {
    "gate.lintPost": lintPost,
    "gate.noPlaceholder": noPlaceholder,
    "gate.brandCompliance": brandCompliance,
    "gate.leakCheck": leakCheck,
    "gate.numbersSourced": numbersSourced,
    "gate.subredditRules": subredditRules,
    // RFC-15 §5 — the deterministic half of the plan's `gate.nativeLanguage`.
    // The model half (idiom and register) is `instagram-native-editor`, an
    // agent step, because this registry's contract is "no model calls".
    "gate.nativeLanguage": nativeLanguage,
  };
}
