"use client";

import type { FooterContent } from "@/lib/content-schema";
import { Reveal } from "./primitives";

export function SiteFooter({ footer }: { footer: FooterContent }) {
  return (
    <footer className="relative isolate overflow-hidden border-t border-edge bg-ground">
      <div className="mx-auto max-w-6xl px-5 pb-12 pt-24 sm:px-8">
        <Reveal>
          <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
            <h2 className="font-display max-w-xl text-4xl font-extrabold tracking-tight text-fg sm:text-5xl">
              {footer.tagline}
            </h2>
            <a
              href={footer.primaryCta.href}
              className="shrink-0 rounded-full bg-accent px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-widest text-ground transition-colors hover:bg-accent-2"
            >
              {footer.primaryCta.label}
            </a>
          </div>
        </Reveal>

        <div className="mt-20 grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <span className="font-display text-2xl tracking-tight text-fg">
              FORGE<span className="text-accent">.</span>
            </span>
          </div>
          {footer.columns.map((col) => (
            <div key={col.heading}>
              <p className="mb-4 font-mono text-xs uppercase tracking-widest text-fg-2">{col.heading}</p>
              <ul className="flex flex-col gap-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-fg-2 transition-colors hover:text-fg">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-16 border-t border-edge pt-6 font-mono text-xs text-fg-2">{footer.legal}</p>
      </div>

      {/* oversized wordmark watermark */}
      <div aria-hidden className="pointer-events-none absolute -bottom-10 left-0 right-0 select-none text-center">
        <span className="font-display text-[24vw] font-extrabold leading-none tracking-tighter text-fg/[0.03]">
          FORGE
        </span>
      </div>
    </footer>
  );
}
