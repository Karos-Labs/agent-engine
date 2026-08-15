import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { GoldenRunSchema, type GoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Golden run fixtures live as plain JSON under `evals/golden-runs/` (RFC-01 §13's layout) — data a human reviews and signs off on, not code. */
function loadGoldenRun(filename: string): GoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return GoldenRunSchema.parse(JSON.parse(raw));
}

/** Every golden run in the suite, validated against `GoldenRunSchema` at load time — a drifted fixture fails fast, not silently. */
export const GOLDEN_RUNS: GoldenRun[] = [loadGoldenRun("linkedin-post-draft.json")];
