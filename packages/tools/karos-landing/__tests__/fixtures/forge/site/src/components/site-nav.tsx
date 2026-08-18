"use client";

import { useEffect, useState } from "react";
import type { NavContent } from "@/lib/content-schema";

export function SiteNav({ nav }: { nav: NavContent }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled ? "bg-ground/85 border-b border-edge backdrop-blur-md" : "bg-transparent border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" className="font-display text-xl tracking-tight text-fg">
          FORGE<span className="text-accent">.</span>
        </a>

        <div className="hidden items-center gap-8 md:flex">
          {nav.links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="font-mono text-xs uppercase tracking-widest text-fg-2 transition-colors hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </div>

        <a
          href={nav.primaryCta.href}
          className="rounded-full bg-accent px-4 py-2 font-mono text-xs font-semibold uppercase tracking-widest text-ground transition-colors hover:bg-accent-2"
        >
          {nav.primaryCta.label}
        </a>
      </nav>
    </header>
  );
}
