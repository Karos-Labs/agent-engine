import type { BrandFonts } from "../types.js";
import { famName } from "./shared.js";
import { violation, type GateViolation } from "./shared.js";

export interface FontFidelityResult {
  violations: GateViolation[];
  families: string[];
}

/**
 * `gate.mjs` check 2, ported verbatim: a font is "wired" if `globals.css`'s
 * `@theme` block maps a `--font-*` role variable. A brand with declared
 * fonts but no such mapping is a warning (not hard) — matching the source
 * script's own severity.
 */
export function checkFontFidelity(fonts: BrandFonts, globalsCss: string, siteRoot: string): FontFidelityResult {
  const families = [fonts.display, fonts.body, fonts.mono].map(famName).filter(Boolean);
  const fontsWired = /--font-(display|sans|mono)\s*:/i.test(globalsCss);
  const violations: GateViolation[] = [];
  if (families.length && !fontsWired) {
    violations.push(violation("font-fidelity", null, 0, `--font-* not mapped in globals.css @theme (families: ${families.join(", ")})`, siteRoot));
  }
  return { violations, families };
}
