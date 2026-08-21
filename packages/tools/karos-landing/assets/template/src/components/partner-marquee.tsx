"use client";

import { motion, useReducedMotion } from "motion/react";

/* Rotating sponsor/partner strip — an infinite auto-scrolling marquee.
   Renders partner wordmarks now; real partner logo SVGs drop into the same slot.
   Carried forward from the old site's rotating sponsor tab. */

export function PartnerMarquee({ label, partners }: { label?: string; partners: string[] }) {
  const reduce = useReducedMotion();
  const row = [...partners, ...partners]; // duplicate for a seamless loop

  return (
    <section aria-label="Partners" className="border-y border-edge bg-ground-2/40 py-7">
      {label && (
        <p className="mx-auto mb-5 max-w-6xl px-5 font-mono text-xs uppercase tracking-[0.2em] text-fg-2 sm:px-8">
          {label}
        </p>
      )}
      <div className="relative overflow-hidden">
        <motion.div
          className="flex w-max items-center gap-14 px-6"
          animate={reduce ? undefined : { x: ["0%", "-50%"] }}
          transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
        >
          {row.map((p, i) => (
            <span
              key={i}
              className="font-display whitespace-nowrap text-2xl font-bold tracking-tight text-fg/65 transition-colors hover:text-fg"
            >
              {p}
            </span>
          ))}
        </motion.div>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-24" style={{ background: "linear-gradient(90deg, var(--ground), transparent)" }} />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-24" style={{ background: "linear-gradient(270deg, var(--ground), transparent)" }} />
      </div>
    </section>
  );
}
