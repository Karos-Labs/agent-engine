import type { LandingContent } from "@/lib/content-schema";

/* FORGE landing copy.
 * Written by the engine from intake.md facts, under brandLaw:
 * second person + present tense, evidence-led, no hype, real numbers framed honestly.
 * `team` is intentionally absent (no people data in intake) — proves content-driven composition. */

export const forge: LandingContent = {
  lang: "en-US",
  meta: {
    title: "FORGE · Train like an athlete, not a tourist",
    description:
      "An adaptive strength program built around you. FORGE tracks every session and adjusts the next block from what you actually lifted.",
  },

  nav: {
    links: [
      { label: "How it works", href: "#how" },
      { label: "Adaptive", href: "#adaptive" },
      { label: "Progress", href: "#progress" },
      { label: "Pricing", href: "#pricing" },
    ],
    primaryCta: { label: "Start free", href: "#pricing" },
  },

  hero: {
    eyebrow: "Strength & conditioning",
    headline: "Train like an athlete, not a tourist.",
    sub: "FORGE builds your program, then rebuilds it every week from what you actually lifted. You bring the work. It handles the math.",
    primaryCta: { label: "Start free", href: "#pricing" },
    secondaryCta: { label: "See how it works", href: "#how" },
    statline: { value: "2M+", label: "workouts logged" },
  },

  proofStrip: {
    label: "Built with athletes who keep score",
    stats: [
      { value: "50K+", label: "athletes training" },
      { value: "2M+", label: "workouts logged" },
      { value: "+18%", label: "median 12-week lift total" },
    ],
  },

  flagshipProof: {
    eyebrow: "Adaptive programming",
    headline: "A program that learns from your lifts.",
    body: "Most apps hand you a fixed plan and hope it fits. FORGE reads every set you log and tunes the next block to your real performance and readiness, so you train hard where it counts and back off before it costs you.",
    points: [
      { title: "Auto-regulated load", body: "Volume and intensity adjust to what you put on the bar, not a static spreadsheet." },
      { title: "Readiness aware", body: "Log a rough night or a heavy week and the next session scales to match." },
      { title: "Built on your numbers", body: "Every recommendation traces back to sets you actually completed." },
    ],
  },

  howItWorks: {
    eyebrow: "The loop",
    heading: "Log, adapt, progress.",
    stepLabel: "STEP",
    steps: [
      { title: "Log your session", body: "Sets, reps, load, and how it felt. Thirty seconds at the rack." },
      { title: "FORGE adapts the block", body: "Your next week is rewritten from what you lifted and how you recovered." },
      { title: "Watch the line climb", body: "Your estimated 1RM and volume trend forward, week over week." },
    ],
  },

  offering: {
    eyebrow: "Pricing",
    heading: "Start free. Upgrade when you are ready to push.",
    sub: "No card to start. Cancel anytime.",
    plans: [
      {
        name: "Free",
        price: "$0",
        cadence: "forever",
        features: ["Log workouts", "Starter templates", "Basic history"],
        cta: { label: "Start free", href: "#" },
      },
      {
        name: "Pro",
        price: "$12",
        cadence: "/mo",
        tag: "Most popular",
        featured: true,
        features: ["Adaptive programming", "Full progress tracking", "Form-check video review", "Unlimited history"],
        cta: { label: "Go Pro", href: "#" },
      },
      {
        name: "Elite",
        price: "$29",
        cadence: "/mo",
        features: ["Everything in Pro", "Human coach check-ins", "Programming reviews", "Priority support"],
        cta: { label: "Go Elite", href: "#" },
      },
    ],
    note: "Median Pro user adds about 18% to their top-three lift total over 12 weeks. Your numbers are your own.",
  },

  signatureShowcase: {
    eyebrow: "Your progress, live",
    heading: "The line you came here to move.",
    sub: "Estimated one-rep-max total across squat, bench, and deadlift. This is a real FORGE trend, not a stock screenshot.",
    yLabel: "est. 1RM total (lb)",
    series: [
      { week: 1, value: 905 },
      { week: 2, value: 920 },
      { week: 3, value: 915 },
      { week: 4, value: 945, pr: true },
      { week: 5, value: 960 },
      { week: 6, value: 955 },
      { week: 7, value: 985, pr: true },
      { week: 8, value: 1000 },
      { week: 9, value: 995 },
      { week: 10, value: 1030, pr: true },
      { week: 11, value: 1055 },
      { week: 12, value: 1070, pr: true },
    ],
    caption: "Carried over from your old dashboard, rebuilt for FORGE.",
  },

  faq: {
    eyebrow: "Questions",
    heading: "Before you start.",
    faqs: [
      { q: "Do I need a gym?", a: "No. FORGE programs for full gyms, home setups, and barbell-only spaces. Tell it what you have and it works within that." },
      { q: "What if I miss a session?", a: "Nothing breaks. FORGE reflows the block around the work you actually did, not the work you planned." },
      { q: "Is my old progress data safe?", a: "Yes. Your history and trend line carry over intact, so the graph you have been building does not reset." },
      { q: "Can I cancel anytime?", a: "Yes. Free stays free, and paid plans cancel in one tap with no lock-in." },
    ],
  },

  footer: {
    tagline: "Train like an athlete, not a tourist.",
    primaryCta: { label: "Start free", href: "#pricing" },
    columns: [
      { heading: "Product", links: [{ label: "How it works", href: "#how" }, { label: "Adaptive", href: "#adaptive" }, { label: "Pricing", href: "#pricing" }] },
      { heading: "Company", links: [{ label: "About", href: "#" }, { label: "Careers", href: "#" }, { label: "Contact", href: "#" }] },
      { heading: "Legal", links: [{ label: "Privacy", href: "#" }, { label: "Terms", href: "#" }] },
    ],
    legal: "© 2026 FORGE. Results vary. Median figures are not a guarantee of individual outcomes.",
  },

  carryForward: [{ type: "chatbot", label: "Coach" }],
};
