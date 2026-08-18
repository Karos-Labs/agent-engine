"use client";

import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useState, type ReactNode } from "react";
import { clsx } from "clsx";

const EASE = [0.16, 1, 0.3, 1] as const;

/** CTA with cursor-reactive lift + ember glow on hover, press on tap. */
export function GlowButton({
  href,
  children,
  variant = "primary",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const reduce = useReducedMotion();
  const base =
    "relative inline-flex items-center justify-center rounded-full px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-widest transition-colors";
  const look =
    variant === "primary"
      ? "bg-accent text-ground hover:bg-accent-2"
      : "border border-muted text-fg hover:border-fg";
  return (
    <motion.a
      href={href}
      className={clsx(base, look, className)}
      whileHover={
        reduce
          ? undefined
          : {
              y: -2,
              boxShadow:
                variant === "primary"
                  ? "0 12px 34px -8px rgb(var(--accent-rgb) / 0.6)"
                  : "0 10px 26px -10px rgb(var(--fg-rgb) / 0.25)",
            }
      }
      whileTap={reduce ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.25, ease: EASE }}
    >
      {children}
    </motion.a>
  );
}

/** Card that tilts toward the cursor in 3D and trails an ember glow. */
export function TiltCard({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const rx = useSpring(useTransform(my, [0, 1], [5.5, -5.5]), { stiffness: 150, damping: 18 });
  const ry = useSpring(useTransform(mx, [0, 1], [-5.5, 5.5]), { stiffness: 150, damping: 18 });
  const glow = useTransform(
    [mx, my],
    ([x, y]) =>
      `radial-gradient(280px circle at ${(x as number) * 100}% ${(y as number) * 100}%, rgb(var(--accent-rgb) / 0.16), transparent 72%)`,
  );
  const [hovered, setHovered] = useState(false);

  if (reduce) return <div className={clsx("relative", className)}>{children}</div>;

  return (
    <motion.div
      className={clsx("relative", className)}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        mx.set((e.clientX - r.left) / r.width);
        my.set((e.clientY - r.top) / r.height);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        mx.set(0.5);
        my.set(0.5);
      }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-300"
        style={{ background: glow, opacity: hovered ? 1 : 0 }}
      />
      {children}
    </motion.div>
  );
}

export { EASE };
