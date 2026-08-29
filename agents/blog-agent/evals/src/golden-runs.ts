import { loadGoldenRunFixture } from "@agent-engine/evals";
import { BlogGoldenRunSchema, type BlogGoldenRun } from "./types.js";

/** Every Blog-agent golden run, validated against `BlogGoldenRunSchema` at load time. */
export const BLOG_GOLDEN_RUNS: BlogGoldenRun[] = [loadGoldenRunFixture(import.meta.url, "blog-post-structured-onboarding.json", BlogGoldenRunSchema)];
