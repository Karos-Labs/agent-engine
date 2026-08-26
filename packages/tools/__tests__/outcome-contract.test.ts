import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { createKarosVideoTools } from "@agent-engine/tool-karos-video";

/**
 * AU8 (SCRUM-289): the four-outcome contract (RFC-01 §6) must hold at the
 * OUTCOME layer, fleet-wide.
 *
 * `success` means the tool did its job. A gate that returns
 * `{status: "success", result: {verdict: "tooling_error"}}` claims success
 * while reporting that it broke — so anything reading `outcome.status` (the
 * ReAct loop, `withToolCallSpan`'s `outcome_status` attribute, any generic
 * caller) sees a successful call where a Python script actually crashed. That
 * is the exact distinction the contract exists to protect, inverted.
 *
 * Two layers of coverage here, deliberately:
 *
 *  1. A behavioural test, for the paths that can be driven deterministically.
 *  2. A source scan, which is the durable part — it fails for any tool in any
 *     package that reintroduces the pattern, including packages that do not
 *     exist yet. The six karos-video tools were the ones actually doing this;
 *     nothing stops a seventh from copying them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = path.resolve(HERE, "..");

const ctx: AgentContext = {
  runId: "run_outcome_contract",
  clientSlug: "acme",
  productId: "branded-shorts-agent",
  runKind: "recurring",
  metadata: {},
};

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__tests__", "assets"].includes(entry.name)) continue;
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("AU8: tooling errors are never wrapped in success()", () => {
  it("every karos-video gate reports a MISSING ENGINE as tooling_error, not a successful verdict", async () => {
    // No BRANDED_SHORTS_ENGINE_DIR: `resolveEngineScript` cannot find any
    // script, which is the one broken-environment path drivable without a
    // Python install. Before AU8 each of these returned
    // {status:"success", result:{verdict:"tooling_error"}}.
    const tools: AgentToolRegistry = createKarosVideoTools({ env: {} });

    const cases: Array<[string, Record<string, unknown>]> = [
      ["video.cutGate", { jobPath: "/tmp/job.json", transcriptPath: "/tmp/t.json" }],
      ["video.cutawayGate", { jobPath: "/tmp/job.json", transcriptPath: "/tmp/t.json" }],
      ["video.brandGate", { jobPath: "/tmp/job.json" }],
      ["video.graphicsGate", { jobPath: "/tmp/job.json" }],
      ["video.assetsCheck", { jobPath: "/tmp/job.json" }],
    ];

    for (const [name, args] of cases) {
      const tool = tools[name];
      expect(tool, `${name} must be registered`).toBeDefined();
      const outcome = await tool!.execute(args as never, { ctx });
      expect(outcome.status, `${name} must not claim success when its engine script is missing`).toBe("tooling_error");
      if (outcome.status !== "success") {
        expect(outcome.reason, `${name} must keep the diagnosis`).toBeTruthy();
      }
    }
  });

  it("no tool in packages/tools returns a tooling_error verdict inside success()", async () => {
    const files = await sourceFiles(TOOLS_ROOT);
    expect(files.length).toBeGreaterThan(50); // the scan actually walked the tree

    // `success(...)` — in any generic form — whose payload sets
    // `verdict: "tooling_error"`. Matches across newlines, since the six
    // offenders were split over four lines each.
    const offending = /success\s*(?:<[^>]*>)?\s*\(\s*\{[^}]*verdict\s*:\s*["']tooling_error["']/s;

    const violations: string[] = [];
    for (const file of files) {
      const src = await fs.readFile(file, "utf8");
      if (offending.test(src)) violations.push(path.relative(TOOLS_ROOT, file));
    }

    expect(violations, `these files wrap a tooling_error verdict in success(): ${violations.join(", ")}`).toEqual([]);
  });
});
