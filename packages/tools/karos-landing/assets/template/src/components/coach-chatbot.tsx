"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

/* CARRY-FORWARD widget: the "Coach" assistant from the old site.
   The capability and entry point are preserved; only the styling is rebranded.
   (Demo shell — wiring to the real assistant is the developer integration step.) */

export function CoachChatbot({ label = "Coach" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="w-[20rem] overflow-hidden rounded-2xl border border-edge bg-ground-2 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-edge bg-ground px-4 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-accent font-display text-sm font-bold text-ground">C</span>
              <div>
                <p className="font-display text-sm font-bold text-fg">{label}</p>
                <p className="font-mono text-[10px] uppercase tracking-widest text-fg-2">Online</p>
              </div>
            </div>
            <div className="flex flex-col gap-3 px-4 py-4">
              <p className="max-w-[85%] rounded-2xl rounded-tl-sm bg-ground px-3 py-2 text-sm text-fg-2">
                Hey. Want me to check your programming for this week, or break down a lift?
              </p>
              <p className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-sm text-ground">
                How heavy should I go on squats today?
              </p>
            </div>
            <div className="border-t border-edge p-3">
              <input
                disabled
                placeholder="Ask Coach…"
                className="w-full rounded-full border border-edge bg-ground px-4 py-2 font-mono text-xs text-fg-2 placeholder:text-fg-2/60"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close Coach" : "Open Coach"}
        className="grid h-14 w-14 place-items-center rounded-full bg-accent text-ground shadow-xl transition-colors hover:bg-accent-2"
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        )}
      </button>
    </div>
  );
}
