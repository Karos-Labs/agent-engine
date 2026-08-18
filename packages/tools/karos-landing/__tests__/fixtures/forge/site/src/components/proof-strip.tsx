"use client";

import type { ProofStripContent } from "@/lib/content-schema";
import { RevealGroup, RevealItem } from "./primitives";

export function ProofStrip({ proof }: { proof: ProofStripContent }) {
  return (
    <section className="border-y border-edge bg-ground-2">
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <p className="mb-8 font-mono text-xs uppercase tracking-[0.2em] text-fg-2">{proof.label}</p>
        <RevealGroup className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          {proof.stats.map((s) => (
            <RevealItem key={s.label} className="flex flex-col">
              <span className="font-display text-5xl font-extrabold tracking-tight text-fg">{s.value}</span>
              <span className="mt-2 font-mono text-xs uppercase tracking-widest text-fg-2">{s.label}</span>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
