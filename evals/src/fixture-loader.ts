import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { z } from "zod";

/**
 * Loads and validates one golden-run fixture (RFC-01 §13's layout: plain JSON
 * under a package's own `evals/golden-runs/`, sibling to `evals/src/`) — the
 * mechanical half of every per-agent `golden-runs.ts` (AU16 / SCRUM-300):
 * `readFileSync` + `fileURLToPath` + `path.join` + `schema.parse(JSON.parse(...))`
 * was hand-rolled identically in each of the eight, parameterized only by the
 * agent's own `GoldenRunSchema` and filename.
 *
 * `moduleUrl` is the CALLING module's own `import.meta.url` (not this file's) —
 * fixtures live relative to each agent's own `evals/` directory, so the caller
 * has to supply its own location for `../golden-runs/<filename>` to resolve
 * correctly.
 */
export function loadGoldenRunFixture<T>(moduleUrl: string, filename: string, schema: z.ZodType<T>): T {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const raw = readFileSync(path.join(here, "..", "golden-runs", filename), "utf8");
  return schema.parse(JSON.parse(raw));
}
