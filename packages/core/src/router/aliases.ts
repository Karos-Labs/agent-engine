import { z } from "zod";
import type { ModelPolicy } from "../types/model-policy.js";

/**
 * The Dynamic Agent Studio's three-option model picker (RFC-01 §7.3). The
 * Studio UI persists only the alias, never a raw model id — resolving it
 * more rigorously is exactly what `ModelRouter` is for.
 */
export const ModelAliasSchema = z.enum(["haiku", "sonnet", "opus"]);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

/**
 * Alias → `ModelPolicy` table (RFC-01 §7.3), cross-referenced against the
 * real model ids in `karosCMO/src/lib/constants.ts` (`MODELS.SONNET`,
 * `MODELS.HAIKU`) and `karosCMO/src/lib/models/usage-log.ts`'s
 * `MODEL_PRICING` (`claude-opus-4-8`), so a Studio-submitted alias resolves
 * to the same model ids the rest of the platform already bills and reports
 * on. Bump this table, not call sites, when a model generation changes.
 */
export const MODEL_ALIASES = {
  /** Classification, extraction, sorting, dedupe similarity. */
  haiku: { policy: "commodity", model: "claude-haiku-4-5-20251001" },
  /** The default for writing and judgment — reaches a client, stays pinned. */
  sonnet: { policy: "pinned", model: "claude-sonnet-4-6" },
  /** Reserved for when exact phrasing is the deliverable itself. */
  opus: { policy: "pinned", model: "claude-opus-4-8" },
} as const satisfies Record<ModelAlias, ModelPolicy>;

export function resolveModelAlias(alias: ModelAlias): ModelPolicy {
  return MODEL_ALIASES[alias];
}
