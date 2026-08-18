import { promises as fs } from "node:fs";
import type { BrandJson } from "../types.js";
import { stripComments } from "./shared.js";
import { violation, type GateViolation } from "./shared.js";

export interface BrandLintResult {
  hard: GateViolation[];
  warn: GateViolation[];
  forbidEmDash: boolean;
  forbidEnDash: boolean;
  forbidExcl: boolean;
}

/**
 * `gate.mjs` check 3, ported verbatim: config-driven, permissive-by-default
 * typography lint. A rule only fires when `brand.typography` states it
 * explicitly or `brand.brandLaw` phrases it in prose (`"no em dashes"`
 * etc.) — an unconfigured client is never penalized for punctuation it never
 * asked to forbid.
 */
export async function checkBrandLint(brand: BrandJson, contentFiles: string[], siteRoot: string): Promise<BrandLintResult> {
  const law = ([] as string[]).concat(brand.brandLaw ?? []).join(" ");
  const typo = brand.typography ?? {};
  const has = (re: RegExp) => re.test(law);
  const forbidEmDash = typo.forbidEmDash ?? has(/\bno\b[^.]{0,40}em[\s-]?dash/i);
  const forbidEnDash = typo.forbidEnDash ?? has(/\bno\b[^.]{0,40}en[\s-]?dash/i);
  const forbidExcl = typo.forbidExclamation ?? has(/\bno\b[^.]{0,30}exclamation/i);

  const hard: GateViolation[] = [];
  const warn: GateViolation[] = [];

  for (const f of contentFiles) {
    const raw = await fs.readFile(f, "utf8");
    const code = stripComments(raw);
    code.split("\n").forEach((ln, i) => {
      const n = i + 1;
      const t = ln.trim().slice(0, 90);
      if (forbidEmDash && ln.includes("—")) hard.push(violation("em-dash", f, n, t, siteRoot));
      if (forbidEnDash && ln.includes("–")) hard.push(violation("en-dash", f, n, t, siteRoot));
      if (forbidExcl && /[A-Za-z0-9,)]\s*!(?!=)/.test(ln) && !/!==|!=|&&\s*!|\(\s*!|\{\s*!/.test(ln)) {
        warn.push(violation("exclamation", f, n, t, siteRoot));
      }
    });
  }

  return { hard, warn, forbidEmDash, forbidEnDash, forbidExcl };
}
