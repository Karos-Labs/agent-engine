import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { CampaignGoldenRunSchema, type CampaignGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): CampaignGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return CampaignGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every campaign-orchestrator golden run, validated against `CampaignGoldenRunSchema` at load time. */
export const CAMPAIGN_GOLDEN_RUNS: CampaignGoldenRun[] = [loadGoldenRun("campaign-b2b-product-launch.json")];
