/**
 * Model-id translation between the Claude API and Google Cloud's Agent
 * Platform (formerly Vertex AI).
 *
 * The two surfaces serve the *same* models under two spellings: the Claude
 * API dates a pinned snapshot with a hyphen (`claude-haiku-4-5-20251001`),
 * Agent Platform dates it with an `@` (`claude-haiku-4-5@20251001`).
 * Dateless ids (`claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-6`) are
 * byte-identical on both, and — from the 4.6 generation on — are themselves
 * pinned snapshots rather than evergreen pointers.
 *
 * **The design rule this file exists to enforce:** everything else in this
 * codebase speaks *canonical Claude API ids* — `router/aliases.ts`'s alias
 * table, every agent's `modelPolicy.model`, `telemetry/pricing.ts`'s
 * `MODEL_PRICING`, and the `DynamicAgentRunStep.model` the portal renders
 * (RFC-01 §7.1). Translation happens only at the adapter boundary, in both
 * directions: outbound on the request, and inbound on `response.model`.
 *
 * Skipping the inbound direction is not cosmetic. `computeStepCostUsd` looks
 * the returned model name up in `MODEL_PRICING`, and a miss now throws
 * refused by `assertModelPriced` at selection time rather than billing at
 * `DEFAULT_MODEL_PRICING` (Sonnet's $3/$15) — so an un-normalized Agent
 * Platform run would fail the step loudly instead of billing Opus work at
 * Sonnet rates in every telemetry record and every per-step cost report
 * (RFC-01 §11). A wrong number that looks plausible is worse than a missing
 * one, and a missing one is worse than a loud failure.
 */

/** `claude-haiku-4-5-20251001` → captures (`claude-haiku-4-5`, `20251001`). */
const CLAUDE_API_DATED = /^(.*)-(\d{8})$/;
/** `claude-haiku-4-5@20251001` → captures (`claude-haiku-4-5`, `20251001`). */
const AGENT_PLATFORM_DATED = /^(.*)@(\d{8})$/;

/**
 * Escape hatch for any id whose Agent Platform spelling is *not* the
 * mechanical `-YYYYMMDD` → `@YYYYMMDD` rewrite. Deliberately empty: every
 * currently-served Claude model follows the rule. Add an entry here (with a
 * dated comment) rather than special-casing a call site if Google ever ships
 * one that doesn't — this table is checked before the mechanical rule.
 */
export const AGENT_PLATFORM_MODEL_ID_OVERRIDES: Readonly<Record<string, string>> = {};

/** Canonical Claude API id → the id Agent Platform expects on the wire. */
export function toAgentPlatformModelId(canonicalModelId: string): string {
  const override = AGENT_PLATFORM_MODEL_ID_OVERRIDES[canonicalModelId];
  if (override !== undefined) return override;
  // Already provider-shaped (e.g. a `stepModels` override authored against
  // Agent Platform directly) — leave it alone rather than mangling it.
  if (AGENT_PLATFORM_DATED.test(canonicalModelId)) return canonicalModelId;
  const dated = CLAUDE_API_DATED.exec(canonicalModelId);
  return dated ? `${dated[1]}@${dated[2]}` : canonicalModelId;
}

/** Agent Platform id → the canonical Claude API id the rest of this system speaks. */
export function toCanonicalModelId(providerModelId: string): string {
  const dated = AGENT_PLATFORM_DATED.exec(providerModelId);
  return dated ? `${dated[1]}-${dated[2]}` : providerModelId;
}

/**
 * The `VERTEX_REGION_*` env vars that may pin one model to its own region,
 * most specific first.
 *
 * Needed because Agent Platform's `global` endpoint does not serve every
 * Claude model, and region is baked into the client's base URL rather than
 * passed per request — so a per-model override means a second client, not a
 * second parameter. `claude-haiku-4-5-20251001` yields
 * `["VERTEX_REGION_CLAUDE_HAIKU_4_5_20251001", "VERTEX_REGION_CLAUDE_HAIKU_4_5"]`;
 * the second form is the one Claude Code's own documented variables use, so a
 * team that already pins regions for Claude Code can reuse the same names.
 */
export function regionEnvVarNamesFor(canonicalModelId: string): string[] {
  const toVarName = (id: string): string => `VERTEX_REGION_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const dated = CLAUDE_API_DATED.exec(canonicalModelId);
  return dated ? [toVarName(canonicalModelId), toVarName(dated[1]!)] : [toVarName(canonicalModelId)];
}
