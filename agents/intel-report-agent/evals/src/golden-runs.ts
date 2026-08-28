import { loadGoldenRunFixture } from "@agent-engine/evals";
import { IntelReportGoldenRunSchema, type IntelReportGoldenRun } from "./types.js";

/** Every Intel Report golden run, validated against `IntelReportGoldenRunSchema` at load time. */
export const INTEL_REPORT_GOLDEN_RUNS: IntelReportGoldenRun[] = [
  loadGoldenRunFixture(import.meta.url, "intel-report-acme-onboarding.json", IntelReportGoldenRunSchema),
];
