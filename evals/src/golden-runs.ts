import { loadGoldenRunFixture } from "./fixture-loader.js";
import { GoldenRunSchema, type GoldenRun } from "./types.js";

/** Every golden run in the suite, validated against `GoldenRunSchema` at load time — a drifted fixture fails fast, not silently. */
export const GOLDEN_RUNS: GoldenRun[] = [loadGoldenRunFixture(import.meta.url, "linkedin-post-draft.json", GoldenRunSchema)];
