"use client";

import { motion, useReducedMotion } from "motion/react";
import type { HeroContent } from "@/lib/content-schema";
import { GlowButton, EASE } from "./interactions";

export function Hero({ hero }: { hero: HeroContent }) {
  const reduce = useReducedMotion();
  const words = hero.headline.split(" ");
  const hasImage = Boolean(hero.image);
  // 'sweep' (default) = rotating conic spotlight; 'mesh' = two drifting blobs.
  // 'custom' = the agent swaps in a bespoke <CustomHeroBackdrop /> (reads tokens, respects reduced-motion).
  const backdrop = hero.backdrop ?? "sweep";

  return (
    <section id="top" className="relative isolate overflow-hidden">
      {/* faint grid — shared by all backdrop variants */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "linear-gradient(var(--edge) 1px, transparent 1px), linear-gradient(90deg, var(--edge) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(circle at 60% 25%, black, transparent 80%)",
          WebkitMaskImage: "radial-gradient(circle at 60% 25%, black, transparent 80%)",
          opacity: 0.5,
        }}
      />

      {backdrop === "sweep" && (
        <>
          {/* moving stage-spotlight sweep */}
          <motion.div
            aria-hidden
            className="absolute left-1/2 top-[-40%] -z-10 h-[130vh] w-[130vh] -translate-x-1/2"
            style={{
              background:
                "conic-gradient(from 0deg at 50% 0%, transparent 8deg, rgb(var(--accent-rgb) / 0.10) 20deg, transparent 34deg, transparent 326deg, rgb(var(--accent-rgb) / 0.08) 340deg, transparent 352deg)",
            }}
            animate={reduce ? undefined : { rotate: [-8, 8, -8] }}
            transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            aria-hidden
            className="absolute -right-40 -top-40 -z-10 h-[40rem] w-[40rem] rounded-full"
            style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb) / 0.18), transparent 60%)" }}
            animate={reduce ? undefined : { opacity: [0.5, 0.85, 0.5] }}
            transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
          />
        </>
      )}

      {backdrop === "mesh" && (
        <>
          {/* two drifting radial blobs */}
          <motion.div
            aria-hidden
            className="absolute -left-32 -top-32 -z-10 h-[36rem] w-[36rem] rounded-full"
            style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb) / 0.16), transparent 62%)" }}
            animate={reduce ? undefined : { x: [0, 40, 0], y: [0, 24, 0] }}
            transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            aria-hidden
            className="absolute -right-40 top-1/3 -z-10 h-[40rem] w-[40rem] rounded-full"
            style={{ background: "radial-gradient(circle, rgb(var(--fg-rgb) / 0.08), transparent 60%)" }}
            animate={reduce ? undefined : { x: [0, -32, 0], y: [0, -28, 0] }}
            transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
          />
        </>
      )}

      <div
        className={`mx-auto grid min-h-[92vh] max-w-6xl items-center gap-12 px-5 pb-20 pt-32 sm:px-8 ${
          hasImage ? "lg:grid-cols-[1.05fr_0.95fr]" : "grid-cols-1"
        }`}
      >
        <div className="flex flex-col">
          <motion.p
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-edge bg-ground-2/60 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-accent"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {hero.eyebrow}
          </motion.p>

          <h1 className="font-display text-5xl font-extrabold leading-[0.98] tracking-tight text-fg sm:text-6xl">
            {words.map((w, i) => (
              <motion.span
                key={i}
                className="inline-block"
                initial={reduce ? false : { opacity: 0, y: "0.5em" }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: EASE, delay: 0.15 + i * 0.05 }}
              >
                {w}&nbsp;
              </motion.span>
            ))}
          </h1>

          <motion.span
            aria-hidden
            className="mt-4 block h-1 origin-left rounded-full bg-accent"
            initial={reduce ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.15 + words.length * 0.05 }}
            style={{ width: "9rem" }}
          />

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.4 }}
            className="mt-8 max-w-xl text-lg leading-relaxed text-fg-2"
          >
            {hero.sub}
          </motion.p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.52 }}
            className="mt-10 flex flex-wrap items-center gap-4"
          >
            <GlowButton href={hero.primaryCta.href} variant="primary">
              {hero.primaryCta.label}
            </GlowButton>
            <GlowButton href={hero.secondaryCta.href} variant="secondary">
              {hero.secondaryCta.label}
            </GlowButton>
            {hero.statline && (
              <span className="ml-1 font-mono text-sm text-fg-2">
                <span className="font-display text-2xl font-bold text-fg">{hero.statline.value}</span>{" "}
                {hero.statline.label}
              </span>
            )}
          </motion.div>
        </div>

        {hero.image && (
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.96, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.3 }}
            className="relative"
          >
            <motion.div
              animate={reduce ? undefined : { y: [0, -12, 0] }}
              transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
              className="overflow-hidden rounded-2xl border border-edge shadow-2xl"
            >
              {/* Real image asset rendered from /public. Client photos (raster) drop into
                  this same slot via next/image; here it's an authored SVG visual. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={hero.image.src} alt={hero.image.alt} width={900} height={680} className="h-auto w-full" />
            </motion.div>
          </motion.div>
        )}
      </div>
    </section>
  );
}
