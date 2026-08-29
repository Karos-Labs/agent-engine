import { z } from "zod";

/**
 * The `brand.json` contract (ENGINE-SPEC.md §4) — deliberately loose
 * (`.passthrough()` at every level) because it is a per-client, evolving
 * document and this package is not its schema's owner; only the fields the
 * sandboxed tools/gate actually read are asserted strictly. `carryForward[]`
 * is the one array `landing.gate`'s completeness check depends on, so its
 * shape is the one part asserted in full (ENGINE-SPEC §3's carry-forward
 * rule, ported literally: "the gate fails on a forgotten carry-forward").
 */
export const CarryForwardItemSchema = z
  .object({
    /** e.g. "tool" (chatbot, configurator, quiz, calculator, booking widget) or "professional-element" (sponsor strip, testimonials, awards, trust badges, signature photography) — ENGINE-SPEC §3. */
    type: z.string().min(1),
    /** Human-readable description of the thing being carried forward — this is the string `landing.gate` searches the built output for. */
    what: z.string().min(1),
    source: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();
export type CarryForwardItem = z.infer<typeof CarryForwardItemSchema>;

/**
 * Which of `tokens.colors`' arbitrary per-client keys plays which of the
 * template kit's fixed semantic CSS roles (`--ground`/`--fg`/`--accent`/
 * `--muted`/`--edge`, per the real `engine/template/src/app/globals.css`
 * token contract every component's Tailwind classes — `bg-ground`,
 * `text-fg`, `border-edge` — actually consume). The legacy `brand.json`
 * schema has no structured field for this (a human/coding-agent decided it
 * implicitly when hand-authoring `globals.css`); this port makes it explicit
 * rather than guessing a mapping from a client's arbitrary color names
 * (`ink`, `bone`, `ember`, ...) or parsing free-text prose like
 * `tokens.ratio`/`tokens.ground`, which this package's Deep Parity Audit
 * found generateGlobalsCss had no reliable way to do. Only `ground`/`fg`/
 * `accent` are required; the `-2` variants and `muted`/`edge` are derived
 * programmatically (lighten/darken) when omitted — see
 * `agents/landing-builder-agent`'s `workflow/make.ts`.
 */
export const BrandColorRolesSchema = z
  .object({
    ground: z.string().min(1),
    fg: z.string().min(1),
    accent: z.string().min(1),
    ground2: z.string().optional(),
    fg2: z.string().optional(),
    accent2: z.string().optional(),
    muted: z.string().optional(),
    edge: z.string().optional(),
  })
  .passthrough();
export type BrandColorRoles = z.infer<typeof BrandColorRolesSchema>;

export const BrandTokensSchema = z
  .object({
    colors: z.record(z.string(), z.string()),
    ratio: z.string().optional(),
    /** Free text in practice (e.g. `"ink (dark mode IS the brand - opposite of a cream/light-ground brand)"`, per the FORGE fixture) — not a strict `"light" | "dark"` enum. `classifyFeedbackRound`'s identity-change guard matches on the `tokens.ground` *path*, not this field's value shape, so it doesn't depend on a stricter type here. */
    ground: z.string().optional(),
    ease: z.string().optional(),
    /** See `BrandColorRolesSchema`. Required for `renderGlobalsCss` to produce a working per-client skin — omitted only in brand contracts that never reach MAKE (e.g. a bundle captured before Style Exploration decided a palette). */
    roles: BrandColorRolesSchema.optional(),
  })
  .passthrough();
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

export const BrandFontsSchema = z
  .object({
    display: z.string().min(1),
    body: z.string().min(1),
    mono: z.string().optional(),
    rule: z.string().optional(),
  })
  .passthrough();
export type BrandFonts = z.infer<typeof BrandFontsSchema>;

export const BrandTypographySchema = z
  .object({
    forbidEmDash: z.boolean().optional(),
    forbidEnDash: z.boolean().optional(),
    forbidExclamation: z.boolean().optional(),
  })
  .passthrough();

// No existing per-field TSDoc to transcribe on this schema (SCRUM-293 flag) — descriptions below
// synthesized from FEEDBACK.md §4/§5's idempotency rule (documented on landing.updateBrandFeedback)
// and each field's evident role in that append-only rebuild audit trail.
export const BrandFeedbackRoundSchema = z
  .object({
    round: z.number().int().positive().describe("This feedback round's sequence number. Must equal the client's (brand.feedback?.lastRound ?? 0) + 1, or the write is rejected."),
    reviewedBuild: z.string().min(1).describe("Identifier of the build this round of feedback reviewed."),
    producedBuild: z.string().min(1).optional().describe("Identifier of the rebuild produced in response to this feedback round, once one exists."),
    submittedAt: z.string().min(1).describe("When this feedback was submitted, as an ISO date string."),
    appliedAt: z.string().min(1).optional().describe("When this feedback's changes were applied to the build, as an ISO date string, once they have been."),
    source: z.string().min(1).describe("Who or what submitted this feedback (a human reviewer, a coding agent, etc)."),
    summary: z.string().optional().describe("A short prose summary of this feedback round."),
    applied: z.array(z.record(z.string(), z.unknown())).default([]).describe("Feedback items from this round that were applied to the build."),
    kept: z.array(z.record(z.string(), z.unknown())).default([]).describe("Feedback items from this round that were considered and deliberately left as-is."),
    outOfScope: z.array(z.record(z.string(), z.unknown())).default([]).describe("Feedback items from this round ruled out of scope for this build."),
    roundFile: z.string().optional().describe("Path to a fuller record of this round, if one was written outside brand.json itself."),
  })
  .passthrough();

// Top-level fields below carry .describe() sourced from this schema's own header comment
// ("the brand.json contract, ENGINE-SPEC.md §4") and each field's role in the tools that read it
// (landing.gate, landing.readBundle, landing.updateBrandFeedback). Most fields had no per-field
// TSDoc of their own to transcribe (SCRUM-293 flag) — descriptions below are synthesized from
// the field's evident purpose in this contract, not new invented copy.
export const BrandJsonSchema = z
  .object({
    client: z.string().min(1).describe("The client's slug/identifier, as recorded in this brand.json."),
    company: z.string().min(1).optional().describe("The client's company/display name."),
    identity: z.record(z.string(), z.unknown()).optional().describe("Free-form brand identity fields (loose — not a fixed schema)."),
    tokens: BrandTokensSchema.describe("Design tokens: color palette, contrast ratio, ground mode, ease, and the semantic color-role mapping landing.gate checks against globals.css."),
    fonts: BrandFontsSchema.describe("The client's typeface choices: display, body, and optional mono font, plus an optional usage rule."),
    brandLaw: z.array(z.string()).default([]).describe("The client's non-negotiable brand rules, as a flat list of statements."),
    typography: BrandTypographySchema.optional().describe("Typographic bans (em dash, en dash, exclamation marks) landing.gate's brand-lint check enforces."),
    /**
     * SCRUM-309 (AU31). The language this client's site copy must be
     * written in — same field name and free-text shape as `ClientBrand.language`
     * (`@agent-engine/tool-karos-client`'s `get-brand.ts`), so a language
     * requirement is captured identically wherever a client's brand kit is
     * read, instead of each channel inventing its own path for the same
     * fact. Before this field existed, `landing-copy`'s only route to a
     * client's language was the model reading it back out of the free-form
     * `voice` bag below (`voice.lang`, per `landing-copy-agent.ts`'s own
     * doc comment) — an unstructured, unvalidated, undocumented key that
     * `resolveBrandLanguage` below still falls back to for brand.json files
     * authored before this field existed, but which nothing requires a new
     * client's intake to populate. Optional, same refuse-to-guess posture
     * as the rest of this schema: a brand.json with no language set still
     * builds, in whatever language the model infers from voice/intake, same
     * as before this field existed.
     */
    language: z
      .string()
      .min(1)
      .optional()
      .describe("The language this client's site copy must be written in, free text (SCRUM-309). Optional: absent means infer it from voice/intake, as before this field existed."),
    voice: z.record(z.string(), z.unknown()).optional().describe("Free-form brand voice/tone fields (loose — not a fixed schema)."),
    assets: z.record(z.string(), z.unknown()).optional().describe("Free-form references to the client's brand assets (logos, images, etc — loose, not a fixed schema)."),
    oldSite: z.record(z.string(), z.unknown()).optional().describe("Free-form captured state from the client's previous site, when one existed."),
    carryForward: z
      .array(CarryForwardItemSchema)
      .default([])
      .describe("Elements from the old site or brand that MUST appear somewhere in the new build (ENGINE-SPEC §3) — landing.gate fails if one goes missing."),
    references: z.array(z.string()).default([]).describe("Reference URLs or file paths informing this brand's design/content decisions."),
    content: z.record(z.string(), z.unknown()).optional().describe("Free-form client-supplied content fields feeding page copy (loose — not a fixed schema)."),
    feedback: z
      .object({
        lastRound: z.number().int().positive().describe("The most recent feedback round number recorded."),
        rounds: z.array(BrandFeedbackRoundSchema).default([]).describe("The full history of brand feedback rounds — what was applied, kept, and marked out of scope in each."),
      })
      .optional()
      .describe("The brand-feedback review history landing.updateBrandFeedback appends to."),
  })
  .passthrough();
export type BrandJson = z.infer<typeof BrandJsonSchema>;

/**
 * SCRUM-309 (AU31). Resolves this client's copy language with the same
 * precedence `buildClientVoiceContext` (`@agent-engine/workflow`) applies
 * for the other six channels: the structured field wins whenever it is
 * present, and only a brand.json authored before that field existed falls
 * back to the free-text `voice.lang` key `landing-copy-agent.ts` used to
 * rely on exclusively. Returns `undefined` — never a guessed default — when
 * neither is set, so a client with no language configured yet still builds,
 * in whatever language the model infers, same as before this function
 * existed.
 */
export function resolveBrandLanguage(brand: Pick<BrandJson, "language" | "voice"> | undefined): string | undefined {
  if (!brand) return undefined;
  if (typeof brand.language === "string" && brand.language.trim().length > 0) return brand.language.trim();
  const legacy = brand.voice?.["lang"];
  if (typeof legacy === "string" && legacy.trim().length > 0) return legacy.trim();
  return undefined;
}

/**
 * The section taxonomy (ENGINE-SPEC §7). `nav`/`hero`/`footer` are required
 * on every build; everything else is included only if intake supplies its
 * content. `team` is deliberately excluded here even though ENGINE-SPEC §7's
 * table lists it: the real template kit (`engine/template/src/components/`)
 * and all three shipped fixtures ship no `team.tsx` anywhere — selecting it
 * would generate a `page.tsx` import for a component that doesn't exist. Add
 * it back only once a real `team.tsx` exists in the canonical kit.
 */
export const LANDING_SECTION_TAXONOMY = [
  "nav",
  "hero",
  "proofStrip",
  "flagshipProof",
  "howItWorks",
  "offering",
  "signatureShowcase",
  "faq",
  "footer",
] as const;
export type LandingSection = (typeof LANDING_SECTION_TAXONOMY)[number];
export const REQUIRED_LANDING_SECTIONS: readonly LandingSection[] = ["nav", "hero", "footer"];
