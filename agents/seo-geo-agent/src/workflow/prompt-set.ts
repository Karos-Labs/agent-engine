import { createHash } from "node:crypto";
import type { SeoGeoPrompt } from "./types.js";

/**
 * Deterministic default prompt-set templates (RFC-04 §2 Phase 1). The source
 * skill calls for genuine per-client drafting judgment here (20-35 prompts,
 * "never hardcoded, never reused across clients") as a bounded `BaseAgent`
 * step — but this repo has no real prompt-authoring UI/judgment source yet,
 * and per this migration's own instructions the assembly step is a
 * deterministic `wf.step.code` stand-in instead of faking judgment with an
 * LLM call that has nothing real to reason about. 20 (the low end of RFC-04's
 * 20-35 range) keeps the Phase 3 fan-out (20 prompts x 5 engines = 100 slots)
 * within the "tens of slots" size `runFanout`'s own docstring targets.
 * Every template is generic and industry-parameterized only — never a
 * fabricated fact or a specific competitor name.
 */
const PROMPT_TEMPLATES: readonly ((industry: string) => string)[] = [
  (i) => `What are the best ${i} companies to work with in 2026?`,
  (i) => `Who are the top-rated providers in the ${i} industry?`,
  (i) => `What should I look for when choosing a ${i} provider?`,
  (i) => `What are the leading alternatives for ${i} services?`,
  (i) => `How do I compare different ${i} companies?`,
  (i) => `What are common pricing models in the ${i} industry?`,
  (i) => `What trends are shaping the ${i} industry in 2026?`,
  (i) => `What features matter most when evaluating a ${i} vendor?`,
  (i) => `How do reviews differ across ${i} providers?`,
  (i) => `What are the most reputable ${i} brands?`,
  (i) => `What questions should I ask a ${i} provider before signing up?`,
  (i) => `How has the ${i} industry changed recently?`,
  (i) => `What are the pros and cons of outsourcing ${i}?`,
  (i) => `Which ${i} providers have the strongest customer support?`,
  (i) => `What certifications or standards matter in the ${i} industry?`,
  (i) => `How do small businesses typically choose a ${i} partner?`,
  (i) => `What are the biggest mistakes companies make when picking a ${i} vendor?`,
  (i) => `What does a good onboarding process look like for ${i} services?`,
  (i) => `How do ${i} providers typically price their services?`,
  (i) => `What's the difference between enterprise and SMB ${i} offerings?`,
];

/** Derives the frozen default prompt set for a client's industry — deterministic, so two runs given the same industry produce byte-identical prompts (before any recurring-run reuse logic applies). */
export function deriveDefaultPromptSet(industry: string): SeoGeoPrompt[] {
  return PROMPT_TEMPLATES.map((makeText, index) => ({
    promptId: `prompt_${String(index + 1).padStart(2, "0")}`,
    promptText: makeText(industry),
  }));
}

/** A stable SHA-256 over any JSON-serializable value — used for every RFC-04 §2 "freeze/hash" spine field (`promptSetHash`, `competitorSetHash`, `engineListHash`, `gazetteerHash`, `crawlSnapshotHash`, `responseSetHash`). Internally consistent and deterministic; not required to match any external/legacy hash format (RFC-04's own instructions). */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
