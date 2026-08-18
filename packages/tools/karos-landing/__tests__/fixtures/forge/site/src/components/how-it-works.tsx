"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { HowItWorksContent } from "@/lib/content-schema";
import { Reveal } from "./primitives";
import { clsx } from "clsx";

const EASE = [0.16, 1, 0.3, 1] as const;

export function HowItWorks({ data }: { data: HowItWorksContent }) {
  const reduce = useReducedMotion();
  const n = data.steps.length;
  const [[i, dir], setPage] = useState<[number, number]>([0, 0]);
  const paginate = (d: number) => setPage([(i + d + n) % n, d]);
  const goTo = (idx: number) => setPage([idx, idx > i ? 1 : -1]);
  const step = data.steps[i];

  const variants = {
    enter: (d: number) => ({ x: d > 0 ? 64 : -64, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d > 0 ? -64 : 64, opacity: 0 }),
  };

  return (
    <section id="how" className="border-t border-edge bg-ground-2">
      <div className="mx-auto max-w-6xl px-5 py-28 sm:px-8">
        <Reveal className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-accent">{data.eyebrow}</p>
            <h2 className="font-display max-w-xl text-4xl font-extrabold tracking-tight text-fg sm:text-5xl">
              {data.heading}
            </h2>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => paginate(-1)}
              aria-label="Previous step"
              className="grid h-11 w-11 place-items-center rounded-full border border-muted text-fg transition-colors hover:border-fg"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button
              onClick={() => paginate(1)}
              aria-label="Next step"
              className="grid h-11 w-11 place-items-center rounded-full border border-muted text-fg transition-colors hover:border-fg"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </Reveal>

        <div className="relative mt-12 overflow-hidden rounded-3xl border border-edge bg-ground">
          {/* ember corner wash for character */}
          <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full" style={{ background: "radial-gradient(circle, rgb(var(--accent-rgb) / 0.18), transparent 65%)" }} />
          <AnimatePresence custom={dir} mode="wait" initial={false}>
            <motion.div
              key={i}
              custom={dir}
              variants={reduce ? undefined : variants}
              initial={reduce ? false : "enter"}
              animate={reduce ? undefined : "center"}
              exit={reduce ? undefined : "exit"}
              transition={{ duration: 0.4, ease: EASE }}
              drag={reduce ? false : "x"}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.2}
              dragSnapToOrigin
              onDragEnd={(_, info) => {
                if (info.offset.x < -60 || info.velocity.x < -350) paginate(1);
                else if (info.offset.x > 60 || info.velocity.x > 350) paginate(-1);
              }}
              className="relative grid cursor-grab gap-6 p-8 active:cursor-grabbing sm:grid-cols-[auto_1fr] sm:items-center sm:gap-12 sm:p-14"
            >
              <span className="font-display select-none text-[6rem] font-extrabold leading-none text-muted sm:text-[9rem]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="font-mono text-xs uppercase tracking-widest text-accent">
                  {data.stepLabel} {i + 1} / {n}
                </p>
                <h3 className="font-display mt-3 text-3xl font-bold text-fg sm:text-4xl">{step.title}</h3>
                <p className="mt-4 max-w-md text-lg leading-relaxed text-fg-2">{step.body}</p>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* dots */}
        <div className="mt-6 flex items-center gap-3">
          {data.steps.map((_, idx) => (
            <button
              key={idx}
              onClick={() => goTo(idx)}
              aria-label={`Go to step ${idx + 1}`}
              className={clsx(
                "h-2 rounded-full transition-all duration-300",
                idx === i ? "w-8 bg-accent" : "w-2 bg-muted hover:bg-fg-2",
              )}
            />
          ))}
          <span className="ml-2 font-mono text-xs text-fg-2">drag or tap to move</span>
        </div>
      </div>
    </section>
  );
}
