import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { SEO_GEO_PROMPT_INTENT_TYPES } from "../workflow/types.js";

export const SeoGeoPromptSetOutputSchema = z.object({
  /** BCP-47-ish tag of the language most of the prompts are written in ("he", "en", "es"). */
  language: z.string().min(2).max(12),
  /** Two or three sentences: who buys, where, in which language they ask, and which market the prompts describe. */
  marketSummary: z.string().min(1),
  /** Other spellings an engine may use for the client — native script, transliteration, a former name. Never the primary name again. */
  brandAliases: z.array(z.string().min(1)).max(6).default([]),
  /** Real, named competitors in this client's actual market, best-known first. Never an invented company. */
  competitors: z
    .array(
      z.object({
        name: z.string().min(1),
        website: z.string().optional(),
      }),
    )
    .max(12)
    .default([]),
  prompts: z
    .array(
      z.object({
        intentType: z.enum(SEO_GEO_PROMPT_INTENT_TYPES),
        promptText: z.string().min(8),
      }),
    )
    .min(15)
    .max(40),
});
export type SeoGeoPromptSetOutput = z.infer<typeof SeoGeoPromptSetOutputSchema>;

/**
 * RFC-04 §2 Phase 1, finally as the source skill described it: "Sonnet drafts
 * 20-35 high-intent prompts per client in the client's language". Until this
 * step existed the prompt set was five English templates per intent filled
 * with the profile's `industry` string — for an Israeli Hebrew-language tech
 * news site that produced "What are the best Technology news & media
 * companies to work with in 2026?", a question no buyer of that client asks,
 * in a language its buyers do not ask it in. Every category prompt then
 * scored a structural zero and the portal showed 0% AI visibility for a brand
 * the engines name readily when asked the way its readers ask.
 *
 * One bounded turn, no tools: everything it needs (profile, brand kit,
 * description, any curated or previously discovered competitors) is
 * hand-assembled by step 02. Its output goes through the same 5-shingle
 * dedupe and per-intent quota as the templates did, and a failed or
 * schema-invalid turn falls back to the templates — drafting judgment can
 * improve the set, never leave a run without one.
 */
export class SeoGeoPromptSetAgent extends BaseAgent<SeoGeoPromptSetOutput> {
  protected readonly config: AgentStepConfig<SeoGeoPromptSetOutput> = {
    id: "seo-geo-prompt-set",
    description: "Draft the client's AI-visibility prompt set — buyer questions in the buyer's own language and market — plus the brand's aliases and real competitor roster.",
    allowedTools: [],
    outputSchema: SeoGeoPromptSetOutputSchema,
    maxTokens: 6_000,
    modelPolicy: resolveModelPolicy("seo-geo-prompt-set", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "seo-geo-prompt-set@1",
  };
}
