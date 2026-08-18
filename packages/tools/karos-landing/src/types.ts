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

export const BrandFeedbackRoundSchema = z
  .object({
    round: z.number().int().positive(),
    reviewedBuild: z.string().min(1),
    producedBuild: z.string().min(1).optional(),
    submittedAt: z.string().min(1),
    appliedAt: z.string().min(1).optional(),
    source: z.string().min(1),
    summary: z.string().optional(),
    applied: z.array(z.record(z.string(), z.unknown())).default([]),
    kept: z.array(z.record(z.string(), z.unknown())).default([]),
    outOfScope: z.array(z.record(z.string(), z.unknown())).default([]),
    roundFile: z.string().optional(),
  })
  .passthrough();

export const BrandJsonSchema = z
  .object({
    client: z.string().min(1),
    company: z.string().min(1).optional(),
    identity: z.record(z.string(), z.unknown()).optional(),
    tokens: BrandTokensSchema,
    fonts: BrandFontsSchema,
    brandLaw: z.array(z.string()).default([]),
    typography: BrandTypographySchema.optional(),
    voice: z.record(z.string(), z.unknown()).optional(),
    assets: z.record(z.string(), z.unknown()).optional(),
    oldSite: z.record(z.string(), z.unknown()).optional(),
    carryForward: z.array(CarryForwardItemSchema).default([]),
    references: z.array(z.string()).default([]),
    content: z.record(z.string(), z.unknown()).optional(),
    feedback: z
      .object({
        lastRound: z.number().int().positive(),
        rounds: z.array(BrandFeedbackRoundSchema).default([]),
      })
      .optional(),
  })
  .passthrough();
export type BrandJson = z.infer<typeof BrandJsonSchema>;

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
