import { z } from "zod";

/**
 * The Landing Builder v2 contracts (RFC-11). Two model-authored documents
 * flow through the pipeline, both validated here so a malformed turn is a
 * repair signal for `BaseAgent`, never a broken page:
 *
 * - `PageBlueprint` — the design + copy decision record for one client's
 *   page, written by the blueprint step from everything the engine already
 *   knows about the client (brand kit, six context docs, the captured old
 *   site, the portal brief). Every headline and fact on the page is decided
 *   HERE, in structured form, so the deterministic checks can hold the
 *   build to it.
 * - `PageParts` — the built page, as parts rather than one opaque string:
 *   `css`, ordered `sections[]` of HTML, and one `script`. `assemblePage()`
 *   turns them into the one `index.html` that ships. Parts, not a blob, so
 *   the assembler owns the `<head>` (lang/dir, meta, fonts, viewport) and a
 *   section can be checked for presence by id instead of by regex over a
 *   whole document.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
export const SECTION_ID = /^[a-z][a-z0-9-]{1,40}$/;

export const HexColorSchema = z.string().regex(HEX, "expected a 6-digit hex color like #1a1a1a");

export const BlueprintPaletteSchema = z.object({
  ground: HexColorSchema.describe("Page background."),
  ground2: HexColorSchema.optional().describe("Raised surface / alternate band background."),
  fg: HexColorSchema.describe("Primary text color on `ground`."),
  fg2: HexColorSchema.optional().describe("Muted text color."),
  accent: HexColorSchema.describe("The one accent: CTAs, the single focal moment per view."),
  accent2: HexColorSchema.optional().describe("Accent hover/variant."),
  edge: HexColorSchema.optional().describe("Hairline borders."),
});
export type BlueprintPalette = z.infer<typeof BlueprintPaletteSchema>;

export const BlueprintTypographySchema = z.object({
  display: z.string().min(1).describe('Display/headline family name exactly as Google Fonts spells it, e.g. "Space Grotesk".'),
  body: z.string().min(1).describe("Body family name."),
  mono: z.string().min(1).optional().describe("Mono family for labels/metadata, when used."),
});
export type BlueprintTypography = z.infer<typeof BlueprintTypographySchema>;

export const BlueprintCtaSchema = z.object({
  label: z.string().min(1),
  href: z.string().min(1).describe("An in-page anchor (#contact), a mailto:, or an https:// URL the sources actually name."),
});

export const BlueprintSectionSchema = z.object({
  id: z.string().regex(SECTION_ID).describe("Kebab-case DOM id, unique on the page. Becomes the section element's id and the nav anchor."),
  kind: z
    .string()
    .min(1)
    .describe("Archetype, free text: nav, hero, proof-strip, problem, how-it-works, offering, services, showcase, story, testimonials, faq, cta, footer, ... Chosen for THIS client, never a fixed list."),
  purpose: z.string().min(1).describe("One sentence: what this section must make the visitor believe or do."),
  eyebrow: z.string().optional(),
  headline: z.string().optional(),
  body: z.string().optional().describe("The section's prose, final copy, in the client's language."),
  items: z
    .array(z.object({ title: z.string().min(1), body: z.string().optional(), meta: z.string().optional() }))
    .optional()
    .describe("Cards / steps / FAQ entries / plan rows: the repeated unit of the section, final copy."),
  cta: BlueprintCtaSchema.optional(),
  layoutNotes: z.string().optional().describe("Direction for the build step: composition, rhythm, what the signature moment is if it lives here."),
});
export type BlueprintSection = z.infer<typeof BlueprintSectionSchema>;

export const BlueprintAssetSchema = z.object({
  kind: z.enum(["logo", "image", "icon", "favicon"]),
  url: z.string().url().describe("An https:// URL that came from the sources (brand kit logo, old-site image, portal upload). Never invented."),
  alt: z.string().min(1),
  usage: z.string().min(1).describe("Where and how the build should use it."),
});
export type BlueprintAsset = z.infer<typeof BlueprintAssetSchema>;

export const PageBlueprintSchema = z.object({
  pov: z.string().min(1).describe("One line stating the page's point of view: ground, type, accent, energy. Every later choice serves it."),
  language: z.string().min(2).describe("BCP-47 tag for the copy, e.g. en-US, he-IL."),
  direction: z.enum(["ltr", "rtl"]),
  palette: BlueprintPaletteSchema,
  typography: BlueprintTypographySchema,
  motionMood: z.enum(["calm", "confident", "bold"]).describe("Drives motion intensity and density in the build."),
  meta: z.object({
    title: z.string().min(1).max(70),
    description: z.string().min(1).max(200),
  }),
  primaryCta: BlueprintCtaSchema,
  sections: z.array(BlueprintSectionSchema).min(3).max(14),
  carryForward: z
    .array(
      z.object({
        what: z.string().min(1).describe("The thing the old site or brand does well that this page must keep, restyled."),
        source: z.enum(["old-site", "brand-kit", "brief"]),
        placement: z.string().regex(SECTION_ID).describe("The `sections[].id` that carries it."),
      }),
    )
    .default([]),
  assets: z.array(BlueprintAssetSchema).default([]),
  sourcedFacts: z
    .array(z.string().min(1))
    .default([])
    .describe("Every number, name, and outcome the page states, each copied VERBATIM from a source (context doc, old site, brief). The check step refuses a number that is neither here nor in the sources."),
  bannedPhrases: z.array(z.string().min(1)).default([]).describe("Words/phrases the brand forbids (from brandLaw, voice rules, the brief's don'ts). Checked case-insensitively against the built page."),
  signatureMoment: z.string().min(1).describe("The one real interactive/scroll-driven moment on the page, stated concretely, and which section owns it."),
  assumptions: z.array(z.string()).default([]),
});
export type PageBlueprint = z.infer<typeof PageBlueprintSchema>;

export const PagePartsSchema = z.object({
  css: z.string().min(1).describe("The complete stylesheet. No @import; Google Fonts are linked by the assembler. Tokens as CSS custom properties on :root."),
  sections: z
    .array(z.object({ id: z.string().regex(SECTION_ID), html: z.string().min(1).describe("The section's outer element INCLUDED, carrying this exact id.") }))
    .min(3),
  script: z.string().default("").describe("Vanilla JS for interactions: intersection reveals, the signature moment, nav state, FAQ. Reduced-motion safe. No external libraries."),
  notes: z.array(z.string()).default([]).describe("What the build assumed or could not do, surfaced to the reviewer."),
});
export type PageParts = z.infer<typeof PagePartsSchema>;

/** What `landing.captureSite` learned about the client's current site: the carry-forward inventory. */
export interface SiteCapture {
  url: string;
  finalUrl: string;
  /** `browser` when Playwright rendered it, `fetch` when only raw HTML was available. */
  method: "browser" | "fetch";
  title?: string;
  description?: string;
  lang?: string;
  headings: Array<{ level: number; text: string }>;
  navLinks: Array<{ text: string; href: string }>;
  ctas: string[];
  /** Visible text blocks in document order, capped. */
  textBlocks: string[];
  images: Array<{ src: string; alt: string; width?: number; height?: number }>;
  /** Computed colors observed on the rendered page (browser method only), most frequent first. */
  colors: string[];
  /** Font families observed on the rendered page (browser method only). */
  fonts: string[];
  /** Full-page screenshots, uploaded when an artifact store is configured. */
  screenshots: Array<{ label: string; url?: string; gcsUri?: string }>;
  /** Third-party embeds/tools the old site carries (chat widgets, booking, forms, video), by hostname. */
  embeds: string[];
  wordCount: number;
}

export interface RenderBreakpointReport {
  label: string;
  width: number;
  height: number;
  consoleErrors: string[];
  failedRequests: string[];
  horizontalOverflow: boolean;
  openerLuminance: number;
  pageHeight: number;
  fontsLoaded: boolean;
  missingFonts: string[];
  h1Count: number;
  brokenImages: number;
  /** Lowest text/background contrast ratio sampled over headings, paragraphs, links and buttons. */
  minContrast: number;
  lowContrastSamples: string[];
  screenshot?: { url?: string; gcsUri?: string };
}

export interface RenderReport {
  breakpoints: RenderBreakpointReport[];
  pass: boolean;
  violations: string[];
}
