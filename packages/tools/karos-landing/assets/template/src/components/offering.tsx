"use client";

import { useState } from "react";
import { motion } from "motion/react";
import type { OfferingContent } from "@/lib/content-schema";
import { Reveal, RevealGroup, RevealItem } from "./primitives";
import { TiltCard, GlowButton } from "./interactions";
import { clsx } from "clsx";

/* Offering / pricing / prizes.
 *
 * billingToggle CONTROLS behavior, content-driven:
 *   • billingToggle: true  → monthly/annual toggle + computed annual prices (subscriptions).
 *   • billingToggle falsy  → price + cadence render VERBATIM (prize amounts like "$1M / SAFE",
 *                            or flat pricing). No toggle, no price math.
 * Nothing here is brand-specific. */

function monthlyNum(price: string) {
  const m = price.replace(/[^0-9.]/g, "");
  return m ? parseFloat(m) : 0;
}

export function Offering({ data }: { data: OfferingContent }) {
  const toggle = Boolean(data.billingToggle);
  const [annual, setAnnual] = useState(false);

  // toggle layout favors 3 columns; static layout favors 2.
  const gridCols = toggle ? "lg:grid-cols-3" : "md:grid-cols-2";

  return (
    <section id={data.id ?? "pricing"} className="mx-auto max-w-6xl px-5 py-28 sm:px-8">
      <Reveal className="max-w-2xl">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-accent">{data.eyebrow}</p>
        <h2 className="font-display text-4xl font-extrabold tracking-tight text-fg sm:text-5xl">{data.heading}</h2>
        <p className="mt-4 text-lg text-fg-2">{data.sub}</p>
      </Reveal>

      {/* billing toggle — only when content opts in */}
      {toggle && (
        <Reveal className="mt-10" delay={0.05}>
          <div className="inline-flex items-center gap-1 rounded-full border border-edge bg-ground-2 p-1">
            {(["monthly", "annual"] as const).map((mode) => {
              const active = (mode === "annual") === annual;
              return (
                <button
                  key={mode}
                  onClick={() => setAnnual(mode === "annual")}
                  className="relative rounded-full px-5 py-2 font-mono text-xs uppercase tracking-widest"
                >
                  {active && (
                    <motion.span
                      layoutId="billing-pill"
                      className="absolute inset-0 rounded-full bg-accent"
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    />
                  )}
                  <span className={clsx("relative", active ? "text-ground" : "text-fg-2")}>
                    {mode === "monthly" ? "Monthly" : "Annual"}
                  </span>
                </button>
              );
            })}
            <span className="px-3 font-mono text-xs text-accent">save 17%</span>
          </div>
        </Reveal>
      )}

      <RevealGroup className={clsx("mt-12 grid gap-6", gridCols)} stagger={0.1}>
        {data.plans.map((p) => {
          // Toggle math only runs when the toggle is on; otherwise render verbatim.
          const base = monthlyNum(p.price);
          const isFree = base === 0;
          const shownPrice = !toggle ? p.price : isFree ? p.price : annual ? `$${Math.round(base * 0.83)}` : p.price;
          const shownCadence = !toggle ? p.cadence : isFree ? p.cadence : "/mo";
          return (
            <RevealItem key={p.name}>
              <TiltCard
                className={clsx(
                  "flex h-full flex-col rounded-2xl border p-8",
                  p.featured ? "border-accent bg-ground-2" : "border-edge bg-ground-2/60",
                )}
              >
                {p.tag && (
                  <span className="absolute -top-3 left-8 rounded-full bg-accent px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-ground">
                    {p.tag}
                  </span>
                )}
                <h3 className="font-display text-xl font-bold text-fg">{p.name}</h3>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="font-display text-5xl font-extrabold text-fg sm:text-6xl">{shownPrice}</span>
                  <span className="font-mono text-sm uppercase tracking-widest text-fg-2">{shownCadence}</span>
                </div>
                {toggle && (
                  <p className="mt-1 h-4 font-mono text-xs text-fg-2">
                    {!isFree && annual ? "billed annually" : " "}
                  </p>
                )}
                <ul className="mt-7 flex flex-1 flex-col gap-3">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-3 text-fg-2">
                      <svg className="mt-1 shrink-0 text-accent" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <GlowButton href={p.cta.href} variant={p.featured ? "primary" : "secondary"} className="mt-8 w-full">
                  {p.cta.label}
                </GlowButton>
              </TiltCard>
            </RevealItem>
          );
        })}
      </RevealGroup>

      {data.note && <p className="mt-8 max-w-2xl font-mono text-xs leading-relaxed text-fg-2">{data.note}</p>}
    </section>
  );
}
