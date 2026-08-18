"use client";

import { motion, useReducedMotion } from "motion/react";
import type { HeroContent } from "@/lib/content-schema";
import { GlowButton, EASE } from "./interactions";

export function Hero({ hero }: { hero: HeroContent }) {
  const reduce = useReducedMotion();
  const words = hero.headline.split(" ");

  return (
    <section id="top" className="relative isolate overflow-hidden">
      {/* faint grid */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "linear-gradient(var(--edge) 1px, transparent 1px), linear-gradient(90deg, var(--edge) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(circle at 70% 30%, black, transparent 80%)",
          WebkitMaskImage: "radial-gradient(circle at 70% 30%, black, transparent 80%)",
          opacity: 0.5,
        }}
      />
      {/* drifting ember mesh — two blobs on different timings */}
      <motion.div
        aria-hidden
        className="absolute -right-40 -top-40 -z-10 h-[44rem] w-[44rem] rounded-full"
        style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb) / 0.20), transparent 60%)" }}
        animate={reduce ? undefined : { opacity: [0.5, 0.85, 0.5], scale: [1, 1.08, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-48 -left-40 -z-10 h-[34rem] w-[34rem] rounded-full"
        style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb) / 0.12), transparent 65%)" }}
        animate={reduce ? undefined : { opacity: [0.3, 0.6, 0.3], x: [0, 30, 0] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="mx-auto flex min-h-[90vh] max-w-6xl flex-col justify-center px-5 pb-20 pt-32 sm:px-8">
        <motion.p
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-edge bg-ground-2/60 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {hero.eyebrow}
        </motion.p>

        <h1 className="font-display max-w-4xl text-5xl font-extrabold leading-[0.98] tracking-tight text-fg sm:text-7xl">
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
    </section>
  );
}
