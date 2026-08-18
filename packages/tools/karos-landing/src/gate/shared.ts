import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface GateViolation {
  rule: string;
  /** Repo-relative to the site root, or "-" for a whole-site violation with no single file. */
  file: string;
  line: number;
  detail: string;
}

export function violation(rule: string, file: string | null, line: number, detail: string, siteRoot: string): GateViolation {
  return { rule, file: file ? path.relative(siteRoot, file) : "-", line, detail };
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git", "dist"]);

/**
 * Collects every `.ts`/`.tsx`/`.css`/`.json` file under `dir`, mirroring
 * `gate.mjs`'s own `walk()` (same skip list) with one deliberate extension:
 * `.json` is included so the generated carry-forward placement record
 * (`generated-paths.ts`'s `GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH`)
 * is visible to any check that scans the whole file set, even though the
 * generated content module itself is a typed `.ts` file (already covered by
 * the `tsx?` half of this pattern).
 */
export async function collectFiles(dir: string): Promise<string[]> {
  const acc: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(d, entry.name));
      } else if (entry.isFile() && /\.(tsx?|css|json)$/.test(entry.name)) {
        acc.push(path.join(d, entry.name));
      }
    }
  }
  await walk(dir);
  return acc;
}

/** `gate.mjs`'s `famName`: the bare family name ahead of any `(weight, ...)` suffix a `brand.json` font value might carry. */
export function famName(s: unknown): string {
  return String(s ?? "").split("(")[0]!.trim();
}

/** `gate.mjs`'s comment-stripping pass, applied before scanning content files for banned punctuation, so a comment mentioning an em dash never trips the lint. */
export function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/**
 * Finds `key: {` or `"key": {` (an object-literal-valued property named
 * `key`, quoted or bare) in `source` and returns the substring from that `{`
 * through its matching `}`, via a brace-depth counter — robust to arbitrarily
 * nested objects/arrays inside, unlike a greedy/non-greedy regex alone.
 * Returns `undefined` if the key isn't found or its braces never balance.
 * Used by the carry-forward completeness check (`gate/carry-forward.ts`) to
 * scope a presence check to *one section's own content*, not the whole file.
 */
export function extractBalancedRegion(source: string, key: string): string | undefined {
  const keyPattern = new RegExp(`["']?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:\\s*\\{`);
  const match = keyPattern.exec(source);
  if (!match) return undefined;

  const openBraceIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return undefined; // unbalanced — never happens for well-formed generated output, but fail closed rather than throw
}
