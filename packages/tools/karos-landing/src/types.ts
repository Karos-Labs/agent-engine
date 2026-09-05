import { z } from "zod";

/**
 * The optional hand-curated `landing/brand.json` (v1's ENGINE-SPEC §4
 * contract, kept as an OVERRIDE layer in v2). An account manager's written
 * rules here outrank anything inferred from the portal brand kit or the old
 * site: `brandLaw[]` and `typography` bans reach the blueprint and the
 * checker verbatim, `carryForward[]` must land on the page, `tokens.colors`
 * pin the palette when present. Every field is optional except the client
 * id, because v2 needs none of them to build; `.passthrough()` everywhere
 * because this file is per-client and evolving, and this package is not its
 * schema's owner.
 */
export const CarryForwardItemSchema = z
  .object({
    /** e.g. "tool" (chatbot, configurator, booking widget) or "professional-element" (partner strip, testimonials, awards, signature photography). */
    type: z.string().min(1),
    /** Human-readable description of the thing being carried forward. */
    what: z.string().min(1),
    source: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();
export type CarryForwardItem = z.infer<typeof CarryForwardItemSchema>;

export const BrandTokensSchema = z
  .object({
    colors: z.record(z.string(), z.string()).optional(),
    ratio: z.string().optional(),
    ground: z.string().optional(),
    roles: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const BrandFontsSchema = z
  .object({
    display: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    mono: z.string().optional(),
    rule: z.string().optional(),
  })
  .passthrough();

export const BrandTypographySchema = z
  .object({
    forbidEmDash: z.boolean().optional(),
    forbidEnDash: z.boolean().optional(),
    forbidExclamation: z.boolean().optional(),
  })
  .passthrough();
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

export const BrandJsonSchema = z
  .object({
    client: z.string().min(1).describe("The client's slug, as recorded in this brand.json."),
    company: z.string().min(1).optional(),
    identity: z.record(z.string(), z.unknown()).optional(),
    tokens: BrandTokensSchema.optional(),
    fonts: BrandFontsSchema.optional(),
    brandLaw: z.array(z.string()).default([]).describe("The client's non-negotiable brand rules, as a flat list of statements."),
    typography: BrandTypographySchema.optional().describe("Glyph bans (em dash, en dash, exclamation marks) the page checker enforces."),
    language: z.string().min(1).optional().describe("The language this client's site copy must be written in, free text (SCRUM-309)."),
    voice: z.record(z.string(), z.unknown()).optional(),
    assets: z.record(z.string(), z.unknown()).optional(),
    oldSite: z.record(z.string(), z.unknown()).optional(),
    carryForward: z.array(CarryForwardItemSchema).default([]).describe("Elements that MUST appear on the new page (ENGINE-SPEC §3)."),
    references: z.array(z.string()).default([]).describe("Reference URLs informing this brand's design decisions."),
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type BrandJson = z.infer<typeof BrandJsonSchema>;

/**
 * SCRUM-309 (AU31). Resolves this client's copy language with the same
 * precedence `buildClientVoiceContext` (`@agent-engine/workflow`) applies:
 * the structured field wins, a pre-SCRUM-309 brand.json falls back to the
 * free-text `voice.lang` key, and neither means `undefined`, never a guess.
 */
export function resolveBrandLanguage(brand: Pick<BrandJson, "language" | "voice"> | undefined): string | undefined {
  if (!brand) return undefined;
  if (typeof brand.language === "string" && brand.language.trim().length > 0) return brand.language.trim();
  const legacy = brand.voice?.["lang"];
  if (typeof legacy === "string" && legacy.trim().length > 0) return legacy.trim();
  return undefined;
}
