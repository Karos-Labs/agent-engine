import { promises as fs } from "node:fs";
import { violation, type GateViolation } from "./shared.js";

/**
 * `gate.mjs` check 4, ported verbatim: every section component under
 * `components/` must export something and return JSX. A missing export is
 * hard (the component literally cannot render); a missing JSX return is a
 * warning (heuristic — a component that returns via an intermediate
 * variable would false-positive here, same caveat the source script has).
 */
export async function checkStructure(componentFiles: string[], siteRoot: string): Promise<{ hard: GateViolation[]; warn: GateViolation[] }> {
  const hard: GateViolation[] = [];
  const warn: GateViolation[] = [];
  for (const f of componentFiles) {
    const src = await fs.readFile(f, "utf8");
    if (!/export\s+(default\s+)?function\s+\w+|export\s+const\s+\w+\s*=/.test(src)) {
      hard.push(violation("no-export", f, 0, "no exported component", siteRoot));
    }
    if (!/return\s*\(/.test(src) && !/=>\s*\(/.test(src)) {
      warn.push(violation("no-jsx-return", f, 0, "no JSX return found", siteRoot));
    }
  }
  return { hard, warn };
}
