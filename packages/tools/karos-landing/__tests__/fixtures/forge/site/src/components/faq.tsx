"use client";

import { useState } from "react";
import type { FaqContent } from "@/lib/content-schema";
import { Reveal } from "./primitives";

export function Faq({ data }: { data: FaqContent }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="border-t border-edge bg-ground-2">
      <div className="mx-auto max-w-3xl px-5 py-28 sm:px-8">
        <Reveal>
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-accent">{data.eyebrow}</p>
          <h2 className="font-display text-4xl font-extrabold tracking-tight text-fg sm:text-5xl">{data.heading}</h2>
        </Reveal>

        <div className="mt-12 divide-y divide-edge border-y border-edge">
          {data.faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <div key={f.q}>
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-6 py-5 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="font-display text-lg font-semibold text-fg">{f.q}</span>
                  <span
                    aria-hidden
                    className="grid h-6 w-6 shrink-0 place-items-center text-accent transition-transform duration-300"
                    style={{ transform: isOpen ? "rotate(45deg)" : "rotate(0deg)" }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                </button>
                <div
                  className="grid transition-all duration-300 ease-out"
                  style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
                >
                  <div className="overflow-hidden">
                    <p className="pb-5 pr-10 leading-relaxed text-fg-2">{f.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
