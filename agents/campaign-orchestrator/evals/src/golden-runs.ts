import { loadGoldenRunFixture } from "@agent-engine/evals";
import { CampaignGoldenRunSchema, type CampaignGoldenRun } from "./types.js";

/** Every campaign-orchestrator golden run, validated against `CampaignGoldenRunSchema` at load time. */
export const CAMPAIGN_GOLDEN_RUNS: CampaignGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "campaign-b2b-product-launch.json", CampaignGoldenRunSchema),
];
