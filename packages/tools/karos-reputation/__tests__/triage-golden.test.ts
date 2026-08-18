import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { triage } from "../src/triage/triage.js";
import { DEFAULT_TRIAGE_CONFIG } from "../src/triage/config.js";
import type { TriagePayload, TriageResult } from "../src/triage/types.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as T;
}

/**
 * The 4 golden fixture pairs copied verbatim from `triage.py`'s own
 * `SELF_TEST_FIXTURES` (RFC-08 task spec: "any divergence is a port bug").
 * `sample` = the route/crisis happy paths; `edge-cases` = partial recency
 * decay, factual_error, naive timestamps, and the three "crisis does NOT
 * fire" negative paths; `cross-pulse` = B4 semantics (straddling burst
 * fires, seen keyword review excluded, alerted dip suppressed);
 * `repeat-pulse` = a pure trailing-window re-ingest re-fires nothing.
 */
const GOLDEN_FIXTURES = [
  { input: "sample-input.json", expected: "expected-output.json", label: "sample" },
  { input: "edge-cases-input.json", expected: "edge-cases-expected.json", label: "edge-cases" },
  { input: "cross-pulse-input.json", expected: "cross-pulse-expected.json", label: "cross-pulse" },
  { input: "repeat-pulse-input.json", expected: "repeat-pulse-expected.json", label: "repeat-pulse" },
] as const;

describe("triage() golden fixtures (byte-identical port of triage.py)", () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`matches triage.py's own fixture output: ${fixture.label}`, () => {
      const input = loadFixture<TriagePayload>(fixture.input);
      const expected = loadFixture<TriageResult>(fixture.expected);
      const actual = triage(input, DEFAULT_TRIAGE_CONFIG);
      expect(actual).toEqual(expected);
    });
  }
});
