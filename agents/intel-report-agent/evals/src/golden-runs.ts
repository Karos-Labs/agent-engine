import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { IntelReportGoldenRunSchema, type IntelReportGoldenRun } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadGoldenRun(filename: string): IntelReportGoldenRun {
  const raw = readFileSync(path.join(HERE, "..", "golden-runs", filename), "utf8");
  return IntelReportGoldenRunSchema.parse(JSON.parse(raw));
}

/** Every Intel Report golden run, validated against `IntelReportGoldenRunSchema` at load time. */
export const INTEL_REPORT_GOLDEN_RUNS: IntelReportGoldenRun[] = [loadGoldenRun("intel-report-acme-onboarding.json")];
