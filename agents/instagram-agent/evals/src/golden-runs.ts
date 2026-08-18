import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { InstagramGoldenRunSchema, type InstagramGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): InstagramGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return InstagramGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every Instagram-agent golden run, validated against `InstagramGoldenRunSchema` at load time. */
export const INSTAGRAM_GOLDEN_RUNS: InstagramGoldenRun[] = [loadGoldenRun("instagram-carousel-quarterly-wins.json")];
