import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { XGoldenRunSchema, type XGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): XGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return XGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every X-agent golden run, validated against `XGoldenRunSchema` at load time. */
export const X_GOLDEN_RUNS: XGoldenRun[] = [loadGoldenRun("x-post-remote-work.json")];
