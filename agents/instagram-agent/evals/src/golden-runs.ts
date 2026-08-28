import { loadGoldenRunFixture } from "@agent-engine/evals";
import { InstagramGoldenRunSchema, type InstagramGoldenRun } from "./types.js";

/** Every Instagram-agent golden run, validated against `InstagramGoldenRunSchema` at load time. */
export const INSTAGRAM_GOLDEN_RUNS: InstagramGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "instagram-carousel-quarterly-wins.json", InstagramGoldenRunSchema),
];
