import type { BrandTokens } from "../types.js";
import { violation, type GateViolation } from "./shared.js";

export interface TokenDriftResult {
  violations: GateViolation[];
  colorCount: number;
}

/**
 * `gate.mjs` check 1, ported verbatim: every color in `brand.tokens.colors`
 * must appear (case-insensitively) in the site's `globals.css` — the brand
 * contract is authoritative, so a color that silently drifted out of the CSS
 * is a hard violation, not a warning.
 */
export function checkTokenDrift(tokens: BrandTokens, globalsCss: string, siteRoot: string): TokenDriftResult {
  const violations: GateViolation[] = [];
  const cssLower = globalsCss.toLowerCase();
  const colors = tokens.colors ?? {};
  for (const [name, hex] of Object.entries(colors)) {
    if (typeof hex !== "string") continue;
    if (!cssLower.includes(hex.toLowerCase())) {
      violations.push(violation("token-drift", null, 0, `brand color ${name} (${hex}) not found in globals.css`, siteRoot));
    }
  }
  if (!globalsCss) {
    violations.push(violation("no-globals", null, 0, "no globals.css found under the site src/", siteRoot));
  }
  return { violations, colorCount: Object.keys(colors).length };
}
