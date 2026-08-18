"use client";

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { useRef } from "react";
import type { SignatureShowcaseContent } from "@/lib/content-schema";
import { Reveal } from "./primitives";

/* The signature set-piece: FORGE's progress graph, carried over from the old
   dashboard and rebuilt to the new brand. The line draws as you scroll into it. */

const W = 880;
const H = 340;
const PADL = 30;
const PADR = 28;
const PADT = 30;
const PADB = 44;

export function SignatureShowcase({ data }: { data: SignatureShowcaseContent }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 80%", "center 55%"] });
  const draw = useSpring(scrollYProgress, { stiffness: 90, damping: 24 });
  const areaOpacity = useTransform(draw, [0, 0.6, 1], [0, 0.12, 0.26]);

  const vals = data.series.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = data.series.length;
  const x = (i: number) => PADL + (i / (n - 1)) * (W - PADL - PADR);
  const y = (v: number) => PADT + (1 - (v - min) / span) * (H - PADT - PADB);

  const linePath = data.series.map((d, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${x(n - 1).toFixed(1)} ${H - PADB} L ${x(0).toFixed(1)} ${H - PADB} Z`;

  const last = data.series[n - 1].value;
  const first = data.series[0].value;
  const pct = Math.round(((last - first) / first) * 100);
  const gridYs = [0, 0.5, 1];

  return (
    <section id="progress" className="border-t border-edge">
      <div ref={ref} className="mx-auto max-w-6xl px-5 py-28 sm:px-8">
        <Reveal className="max-w-2xl">
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.25em] text-accent">{data.eyebrow}</p>
          <h2 className="font-display text-4xl font-extrabold tracking-tight text-fg sm:text-5xl">{data.heading}</h2>
          <p className="mt-4 text-lg text-fg-2">{data.sub}</p>
        </Reveal>

        <div className="mt-12 overflow-hidden rounded-2xl border border-edge bg-ground-2 p-6 sm:p-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-5xl font-extrabold text-fg">{last.toLocaleString()}</span>
                <span className="font-mono text-sm text-fg-2">lb</span>
              </div>
              <span className="font-mono text-xs uppercase tracking-widest text-fg-2">{data.yLabel}</span>
            </div>
            <span className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-xs font-semibold text-accent">
              +{pct}% / 12 weeks
            </span>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${data.yLabel}, weeks 1 to ${n}`}>
            {/* gridlines */}
            {gridYs.map((g) => {
              const gy = PADT + g * (H - PADT - PADB);
              return <line key={g} x1={PADL} x2={W - PADR} y1={gy} y2={gy} stroke="var(--edge)" strokeWidth={1} />;
            })}

            {/* area fill */}
            <defs>
              <linearGradient id="emberArea" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <motion.path d={areaPath} fill="url(#emberArea)" style={{ opacity: reduce ? 0.26 : areaOpacity }} />

            {/* the line */}
            <motion.path
              d={linePath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pathLength: reduce ? 1 : draw }}
            />

            {/* PR markers */}
            {data.series.map((d, i) =>
              d.pr ? (
                <motion.circle
                  key={i}
                  cx={x(i)}
                  cy={y(d.value)}
                  r={5}
                  fill="var(--ground)"
                  stroke="var(--accent)"
                  strokeWidth={3}
                  initial={reduce ? false : { scale: 0, opacity: 0 }}
                  whileInView={{ scale: 1, opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.5 + i * 0.04 }}
                  style={{ transformOrigin: `${x(i)}px ${y(d.value)}px` }}
                />
              ) : null,
            )}

            {/* x labels (every other week) */}
            {data.series.map((d, i) =>
              i % 2 === 0 ? (
                <text key={i} x={x(i)} y={H - PADB + 22} textAnchor="middle" className="fill-[var(--fg-2)]" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  W{d.week}
                </text>
              ) : null,
            )}
          </svg>

          <p className="mt-5 font-mono text-xs text-fg-2">{data.caption}</p>
        </div>
      </div>
    </section>
  );
}
