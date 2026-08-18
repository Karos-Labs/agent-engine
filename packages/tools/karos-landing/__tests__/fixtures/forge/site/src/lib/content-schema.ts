/* ============================================================
 * Landing Engine — generalized content schema (v1)
 * Neutral, industry-agnostic. Replaces the earlier fintech-shaped schema.
 * Sections are OPTIONAL: the engine includes a section only when intake
 * supplies its content (see ENGINE-SPEC §7). Motion lives in the
 * components; only this data changes per client.
 * ============================================================ */

export interface NavContent {
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
  statline?: { value: string; label: string };
}

/** Logos / ratings / press / certifications — neutral credibility row. */
export interface ProofStripContent {
  label: string;
  stats: Array<{ value: string; label: string }>;
}

/** The client's #1 credibility claim, industry-specific in wording only. */
export interface FlagshipProofContent {
  eyebrow: string;
  headline: string;
  body: string;
  points: Array<{ title: string; body: string }>;
}

export interface HowItWorksContent {
  eyebrow: string;
  heading: string;
  stepLabel: string;
  steps: Array<{ title: string; body: string }>;
}

/** Plans / pricing / packages — neutral. */
export interface OfferingContent {
  eyebrow: string;
  heading: string;
  sub: string;
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

/** The ONE signature set-piece. Carry-forward interactive tools live here.
 *  For FORGE this is the progress graph carried over from the old site. */
export interface SignatureShowcaseContent {
  eyebrow: string;
  heading: string;
  sub: string;
  /** Ordered data points for the progress chart (week → value). */
  series: Array<{ week: number; value: number; pr?: boolean }>;
  yLabel: string;
  caption: string;
}

export interface FaqContent {
  eyebrow: string;
  heading: string;
  faqs: Array<{ q: string; a: string }>;
}

export interface FooterContent {
  tagline: string;
  primaryCta: { label: string; href: string };
  columns: Array<{ heading: string; links: Array<{ label: string; href: string }> }>;
  legal: string;
}

/** A capability preserved from the client's old site (chatbot, configurator, …). */
export interface CarryForwardWidget {
  type: "chatbot" | "graph" | "configurator" | "other";
  label: string;
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
  /** Carried-forward capabilities from the old site, re-applied to the new brand. */
  carryForward?: CarryForwardWidget[];
}
