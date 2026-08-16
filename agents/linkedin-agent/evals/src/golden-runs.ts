import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { LinkedInGoldenRunSchema, type LinkedInGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): LinkedInGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return LinkedInGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every LinkedIn-agent golden run, validated against `LinkedInGoldenRunSchema` at load time. */
export const LINKEDIN_GOLDEN_RUNS: LinkedInGoldenRun[] = [loadGoldenRun("linkedin-post-hybrid-teams.json")];
