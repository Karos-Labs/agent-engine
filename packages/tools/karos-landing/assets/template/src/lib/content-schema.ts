/* ============================================================
 * Landing Engine — CANONICAL content schema (merged superset)
 *
 * Neutral, industry-agnostic. This is the single contract every client
 * landing is generated from. Sections are OPTIONAL: the engine includes a
 * section only when intake supplies its content (see ENGINE-SPEC §7). Motion
 * lives in the components; only this DATA changes per client.
 *
 * NOTHING is hardcoded to one brand. Brand name flows through `wordmark`;
 * colors/fonts live in globals.css + layout.tsx; behavior (billing toggle,
 * hero backdrop, section anchors) is content-driven. The agent composes,
 * omits, reorders, and ADDS bespoke sections per client on top of this floor.
 * ============================================================ */

export interface NavContent {
  /** Brand name shown in the header lockup, e.g. "The Pitch", "FORGE", "Acme". Content-driven; never hardcoded. */
  wordmark: string;
  links: Array<{ label: string; href: string }>;
  primaryCta: { label: string; href: string };
}

export interface HeroContent {
  eyebrow: string;
  headline: string;
  sub: string;
  primaryCta: { label: string; href: string };
  secondaryCta: { label: string; href: string };
  /** Big proof stat shown in the hero, optional. */
  statline?: { value: string; label: string; icon?: string };
  /** Hero visual. Client photo/illustration or a generated asset. Omit = text-only (single-column) hero; present = grid layout. */
  image?: { src: string; alt: string };
  /**
   * Animated backdrop variant:
   *   'sweep'  — rotating conic stage spotlight (default; the more mature backdrop)
   *   'mesh'   — two drifting radial blobs
   *   'custom' — reserved: the agent swaps in a bespoke <CustomHeroBackdrop /> per client.
   * All variants read brand tokens and respect useReducedMotion().
   */
  backdrop?: "sweep" | "mesh" | "custom";
}

/** Logos / ratings / press / certifications — neutral credibility row. */
export interface ProofStripContent {
  /** Anchor id for nav links. Defaults to "proof". */
  id?: string;
  label: string;
  stats: Array<{ value: string; label: string }>;
}

/** The client's #1 credibility claim, industry-specific in wording only. */
export interface FlagshipProofContent {
  /** Anchor id for nav links. Defaults to "adaptive". */
  id?: string;
  eyebrow: string;
  headline: string;
  body: string;
  points: Array<{ title: string; body: string }>;
}

export interface HowItWorksContent {
  /** Anchor id for nav links. Defaults to "how". */
  id?: string;
  eyebrow: string;
  heading: string;
  stepLabel: string;
  steps: Array<{ title: string; body: string }>;
}

/** Plans / pricing / packages / prizes — neutral. */
export interface OfferingContent {
  /** Anchor id for nav links. Defaults to "pricing" (e.g. "what-you-win" for a competition). */
  id?: string;
  eyebrow: string;
  heading: string;
  sub: string;
  /**
   * When true, render a monthly/annual billing toggle and compute annual prices
   * (subscription products). When false/omitted, render price + cadence verbatim
   * (works for prize amounts like "$1M / SAFE" as well as flat pricing).
   */
  billingToggle?: boolean;
  plans: Array<{
    name: string;
    price: string;
    cadence: string;
    tag?: string;
    features: string[];
    cta: { label: string; href: string };
    featured?: boolean;
  }>;
  note?: string;
}

/** The ONE signature set-piece — a scroll-drawn data graph. Carry-forward
 *  interactive tools (a client's old dashboard chart, etc.) live here. */
export interface SignatureShowcaseContent {
  /** Anchor id for nav links. Defaults to "progress". */
  id?: string;
  eyebrow: string;
  heading: string;
  sub: string;
  /** Ordered data points for the chart (week → value). */
  series: Array<{ week: number; value: number; pr?: boolean }>;
  yLabel: string;
  caption: string;
  /** Unit suffix next to the headline figure, e.g. "lb", "users", "$". Content-driven; defaults to "". */
  unit?: string;
  /** Label inside the delta pill next to the % change, e.g. "/ 12 weeks". Defaults to "growth". */
  deltaLabel?: string;
}

export interface FaqContent {
  /** Anchor id for nav links. Defaults to "faq". */
  id?: string;
  eyebrow: string;
  heading: string;
  faqs: Array<{ q: string; a: string }>;
}

export interface FooterContent {
  /** Brand name shown in the footer lockup + the oversized background watermark. Content-driven. */
  wordmark: string;
  tagline: string;
  primaryCta: { label: string; href: string };
  columns: Array<{ heading: string; links: Array<{ label: string; href: string }> }>;
  legal: string;
}

/** A capability preserved from the client's old site (chatbot, configurator, …). */
export interface CarryForwardWidget {
  type: "chatbot" | "graph" | "configurator" | "other";
  /** Display label for the widget, e.g. "Coach", "Advisor". Content-driven. */
  label: string;
}

/**
 * Media slots beyond hero.image: testimonial video, case-study carousel, custom
 * animations, etc. The agent adds a bespoke component (<MediaGallery />, …) that
 * consumes this array and wires it into page.tsx as a NEW section (not in the kit).
 */
export interface MediaSlot {
  slot: string;
  src: string;
  alt: string;
  caption?: string;
}

/**
 * Placeholder for per-client bespoke sections the agent adds on top of the kit
 * (e.g. 'testimonials', 'custom-cta', 'live-widget', 'calculator'). The kit
 * ignores these; the agent creates the component, types its data under a new
 * optional field, and adds a render line to page.tsx.
 */
export interface CustomSection {
  id: string;
  type: string;
}

/** The full page. Optional sections are included only when intake supplies them. */
export interface LandingContent {
  lang: string;
  meta: { title: string; description: string };
  nav: NavContent;
  hero: HeroContent;
  proofStrip?: ProofStripContent;
  flagshipProof?: FlagshipProofContent;
  howItWorks?: HowItWorksContent;
  offering?: OfferingContent;
  signatureShowcase?: SignatureShowcaseContent;
  faq?: FaqContent;
  footer: FooterContent;
  /** Partner / sponsor wordmarks for the rotating marquee. Omit = no strip. */
  partners?: string[];
  /** Optional label above the partner marquee, e.g. "Presented in partnership with". */
  partnersLabel?: string;
  /** Carried-forward capabilities from the old site, re-applied to the new brand. */
  carryForward?: CarryForwardWidget[];
  /** Media assets beyond the hero image, consumed by bespoke agent-added sections. */
  media?: MediaSlot[];
  /** Bespoke sections the agent adds per client (documented, not part of the kit). */
  customSections?: CustomSection[];
  /** Things the engine assumed or used a placeholder for (e.g. media not yet supplied —
   *  media option C). Surfaced in result.json.assumptions[] and flagged for human follow-up. */
  assumptions?: string[];
}
