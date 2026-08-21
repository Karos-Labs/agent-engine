"use client";

import type { FlagshipProofContent } from "@/lib/content-schema";
import { Reveal, RevealGroup, RevealItem } from "./primitives";

export function FlagshipProof({ data }: { data: FlagshipProofContent }) {
  return (
    <section id={data.id ?? "adaptive"} className="mx-auto max-w-6xl px-5 py-28 sm:px-8">
      <div className="grid gap-14 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
        <Reveal>
          <p className="mb-5 font-mono text-xs uppercase tracking-[0.25em] text-accent">{data.eyebrow}</p>
          <h2 className="font-display text-4xl font-extrabold leading-tight tracking-tight text-fg sm:text-5xl">
            {data.headline}
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-fg-2">{data.body}</p>
        </Reveal>

        <RevealGroup className="flex flex-col gap-px overflow-hidden rounded-2xl border border-edge bg-edge">
          {data.points.map((p, i) => (
            <RevealItem key={p.title} className="bg-ground-2 p-7">
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-sm text-accent">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-display text-xl font-bold text-fg">{p.title}</h3>
                  <p className="mt-2 leading-relaxed text-fg-2">{p.body}</p>
                </div>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
