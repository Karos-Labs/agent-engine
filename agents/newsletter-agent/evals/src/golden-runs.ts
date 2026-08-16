import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { NewsletterGoldenRunSchema, type NewsletterGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): NewsletterGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return NewsletterGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every Newsletter-agent golden run, validated against `NewsletterGoldenRunSchema` at load time. */
export const NEWSLETTER_GOLDEN_RUNS: NewsletterGoldenRun[] = [loadGoldenRun("newsletter-edition-industry-digest.json")];
