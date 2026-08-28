import { loadGoldenRunFixture } from "@agent-engine/evals";
import { NewsletterGoldenRunSchema, type NewsletterGoldenRun } from "./types.js";

/** Every Newsletter-agent golden run, validated against `NewsletterGoldenRunSchema` at load time. */
export const NEWSLETTER_GOLDEN_RUNS: NewsletterGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "newsletter-edition-industry-digest.json", NewsletterGoldenRunSchema),
];
