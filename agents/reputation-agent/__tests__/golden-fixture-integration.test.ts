import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createKarosReputationTools, type TriagePayload, type TriageResult } from "@agent-engine/tool-karos-reputation";
import type { AgentToolCallContext } from "@agent-engine/core";

/**
 * `packages/tools/karos-reputation`'s own golden fixtures (copied verbatim
 * from legacy `triage.py`'s `SELF_TEST_FIXTURES`) already prove `triage()`
 * itself is a byte-identical port (see that package's `triage-golden.test.ts`).
 * This test proves the SAME fixtures still match once routed through the
 * exact `reputation.triage` tool surface `agents/reputation-agent`'s own
 * workflow calls (RFC-08 §11 item 1: "the four `triage.py` golden fixtures...
 * reproduce byte-identical output from the ported version before any client
 * is scored against it") — an integration check on the tool wiring, not a
 * re-test of the arithmetic (which the tool package's own suite already
 * covers exhaustively).
 */
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "tools", "karos-reputation", "__tests__", "fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as T;
}

const GOLDEN_FIXTURES = [
  { input: "sample-input.json", expected: "expected-output.json", label: "sample" },
  { input: "edge-cases-input.json", expected: "edge-cases-expected.json", label: "edge-cases" },
  { input: "cross-pulse-input.json", expected: "cross-pulse-expected.json", label: "cross-pulse" },
  { input: "repeat-pulse-input.json", expected: "repeat-pulse-expected.json", label: "repeat-pulse" },
] as const;

const ctx: AgentToolCallContext = {
  ctx: { runId: "golden-fixture-check", clientSlug: "fixture-client", productId: "reputation-agent", runKind: "recurring", metadata: {} },
};

describe("golden-fixture integration check: reputation.triage (the tool surface the pulse workflow actually calls)", () => {
  const tools = createKarosReputationTools();

  for (const fixture of GOLDEN_FIXTURES) {
    it(`reproduces triage.py's own fixture output through the registered tool: ${fixture.label}`, async () => {
      const payload = loadFixture<TriagePayload>(fixture.input);
      const expected = loadFixture<TriageResult>(fixture.expected);

      const outcome = await tools["reputation.triage"]!.execute({ payload }, ctx);
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result).toEqual(expected);
    });
  }
});
