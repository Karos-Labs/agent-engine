import type { LandingContent } from "@/lib/content-schema";

/* ============================================================
 * EXAMPLE CONTENT — neutral placeholder for the canonical template.
 *
 * Valid, complete, BUILDS. Industry-agnostic copy with a fictional brand
 * ("Northwind"). Exercises every section in the kit so the template renders
 * end-to-end out of the box. Per client, the engine writes a NEW content file
 * from intake (e.g. src/content/<client>.ts) and points page.tsx at it; this
 * file is never shipped to a client.
 *
 * No em/en dashes; clean, direct copy (matches the strictest brandLaw).
 * ============================================================ */

export const example: LandingContent = {
  lang: "en-US",
  meta: {
    title: "Northwind · The platform your team actually wants to use",
    description:
      "Northwind is the neutral example landing built from the canonical engine template. Replace this content per client.",
  },

  nav: {
    wordmark: "Northwind",
    links: [
      { label: "Why", href: "#adaptive" },
      { label: "How it works", href: "#how" },
      { label: "Pricing", href: "#pricing" },
      { label: "FAQ", href: "#faq" },
    ],
    primaryCta: { label: "Start free", href: "#pricing" },
  },

  hero: {
    eyebrow: "The example skin · replace per client",
    headline: "Build it once. Ship it everywhere.",
    sub: "Northwind is the placeholder brand for the canonical landing template. Every section here is composable, content-driven, and reskinned from one design system. Swap the tokens, fonts, and copy to make it your own.",
    primaryCta: { label: "Start free", href: "#pricing" },
    secondaryCta: { label: "See how it works", href: "#how" },
    statline: { value: "12k+", label: "teams onboarded" },
    // No `image` => text-only single-column hero. Add { src, alt } for the grid layout.
    backdrop: "sweep", // try "mesh" for two drifting blobs
  },

  partners: ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne"],
  partnersLabel: "Trusted by teams at",

  proofStrip: {
    label: "The numbers behind the platform",
    stats: [
      { value: "99.98%", label: "uptime last 12 months" },
      { value: "4.9 / 5", label: "average customer rating" },
      { value: "30 min", label: "median time to first value" },
    ],
  },

  flagshipProof: {
    eyebrow: "Why teams switch",
    headline: "One platform that adapts to how you already work.",
    body: "Most tools make you bend to their model. Northwind meets your team where it is, then scales as you grow. No migration weekend, no lock-in, no surprises.",
    points: [
      { title: "Set up in minutes", body: "Connect your stack and import your data with guided steps. Most teams are live the same afternoon." },
      { title: "Built to scale", body: "From a five-person team to a global org, the same workspace grows with you without a re-platform." },
      { title: "Owned by you", body: "Export everything any time. Your data stays portable, and your workflows stay yours." },
    ],
  },

  howItWorks: {
    eyebrow: "The path to value",
    heading: "Three steps from signup to shipped.",
    stepLabel: "STEP",
    steps: [
      { title: "Connect", body: "Link your existing tools in a few clicks. Northwind maps your data automatically so nothing gets left behind." },
      { title: "Configure", body: "Pick a starting template or build your own. Sensible defaults mean you can launch without reading a manual." },
      { title: "Ship", body: "Invite your team and go. Real-time collaboration and clear ownership keep everyone moving in the same direction." },
    ],
  },

  signatureShowcase: {
    eyebrow: "Your growth, live",
    heading: "The number you came here to move.",
    sub: "Weekly active teams across a sample workspace. This is a real trend the platform tracks, not a stock screenshot.",
    yLabel: "weekly active teams",
    unit: "teams",
    deltaLabel: "/ 12 weeks",
    series: [
      { week: 1, value: 120 },
      { week: 2, value: 138 },
      { week: 3, value: 134 },
      { week: 4, value: 162, pr: true },
      { week: 5, value: 175 },
      { week: 6, value: 170 },
      { week: 7, value: 198, pr: true },
      { week: 8, value: 214 },
      { week: 9, value: 231 },
      { week: 10, value: 248, pr: true },
      { week: 11, value: 262 },
      { week: 12, value: 289, pr: true },
    ],
    caption: "Sample workspace. Your dashboard shows your own live numbers.",
  },

  offering: {
    eyebrow: "Pricing",
    heading: "Start free. Upgrade when you grow.",
    sub: "Simple plans, no hidden seats. Switch monthly or annual any time.",
    billingToggle: true, // set false for static price/cadence (e.g. prize amounts)
    plans: [
      {
        name: "Starter",
        price: "$0",
        cadence: "forever",
        features: ["Up to 5 teammates", "Core workspace", "Community support", "1 GB storage"],
        cta: { label: "Start free", href: "#" },
      },
      {
        name: "Team",
        price: "$24",
        cadence: "/mo",
        tag: "Most popular",
        featured: true,
        features: ["Unlimited teammates", "Advanced workflows", "Priority support", "Unlimited storage", "Audit log"],
        cta: { label: "Start 14-day trial", href: "#" },
      },
      {
        name: "Enterprise",
        price: "Custom",
        cadence: "talk to us",
        features: ["SSO and SCIM", "Dedicated success manager", "Custom SLAs", "Security review", "On-prem option"],
        cta: { label: "Contact sales", href: "#" },
      },
    ],
    note: "All paid plans include a 14-day trial. Annual billing saves about 17 percent. No credit card to start.",
  },

  faq: {
    eyebrow: "Questions",
    heading: "Before you start.",
    faqs: [
      { q: "Is there really a free plan?", a: "Yes. The Starter plan is free forever for up to five teammates, with no credit card required to begin." },
      { q: "How long does setup take?", a: "Most teams are live the same afternoon. Guided import maps your existing data so you are not starting from scratch." },
      { q: "Can I export my data?", a: "Any time. Your data is portable and yours; export everything in standard formats with one click." },
      { q: "Do you offer SSO?", a: "SSO and SCIM provisioning are included on the Enterprise plan, along with a security review and custom SLAs." },
      { q: "What does support look like?", a: "Community support on Starter, priority support on Team, and a dedicated success manager on Enterprise." },
    ],
  },

  footer: {
    wordmark: "Northwind",
    tagline: "Build it once. Ship it everywhere.",
    primaryCta: { label: "Start free", href: "#pricing" },
    columns: [
      { heading: "Product", links: [{ label: "Why", href: "#adaptive" }, { label: "How it works", href: "#how" }, { label: "Pricing", href: "#pricing" }] },
      { heading: "Company", links: [{ label: "About", href: "#" }, { label: "Careers", href: "#" }, { label: "Blog", href: "#" }] },
      { heading: "Legal", links: [{ label: "Terms", href: "#" }, { label: "Privacy", href: "#" }] },
    ],
    legal: "Northwind is a fictional brand used as the neutral example for the Karos landing engine template. Replace per client.",
  },

  // Carry-forward demo: a floating chat widget reskinned to the new brand.
  carryForward: [{ type: "chatbot", label: "Assistant" }],
};
