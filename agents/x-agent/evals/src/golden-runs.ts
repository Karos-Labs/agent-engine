import { loadGoldenRunFixture } from "@agent-engine/evals";
import { XGoldenRunSchema, type XGoldenRun } from "./types.js";

/** Every X-agent golden run, validated against `XGoldenRunSchema` at load time. */
export const X_GOLDEN_RUNS: XGoldenRun[] = [loadGoldenRunFixture(import.meta.url, "x-post-remote-work.json", XGoldenRunSchema)];
