import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { DEFAULT_AGENT_STEP_TIMEOUT_MS } from "@agent-engine/workflow";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_JOB_SRC = readFileSync(path.join(HERE, "..", "src", "run-job.ts"), "utf8");

/**
 * `intel-report-agent`'s drafting step gets a longer bound than the fleet
 * default, and the fleet default stays where it is.
 *
 * On 2026-09-04 that step ran past ten minutes and the run was recorded as a
 * tooling failure — a full report's worth of spend, discarded. The default is
 * sized off VETTING steps (its own comment cites a ~182s image vet); this one
 * streams an entire structured report against the fleet's largest output
 * ceiling from a prompt carrying six research documents.
 *
 * A source assertion because the value is a table entry consumed inside
 * `startRunJob`, which needs a real queue, a durable store and a runtime to
 * call. What matters and is checkable here is that the override exists, is
 * scoped to one product, and is bigger than the default — not the plumbing,
 * which the run-job tests already exercise.
 */
describe("agent-step timeout overrides", () => {
  it("raises the bound for intel-report-agent only", () => {
    const table = /AGENT_STEP_TIMEOUT_OVERRIDES_MS[\s\S]*?\{([\s\S]*?)\};/.exec(RUN_JOB_SRC);
    expect(table, "the override table is gone — the 2026-09-04 timeout will recur").not.toBeNull();

    const entries = [...table![1]!.matchAll(/"([a-z0-9-]+)":\s*([\d*_\s]+),/g)].map((m) => m[1]);
    expect(entries).toEqual(["intel-report-agent"]);
  });

  it("gives it more than the fleet default, not less", () => {
    // An override that undercut the default would be a silent tightening.
    expect(/"intel-report-agent":\s*25 \* 60_000/.test(RUN_JOB_SRC)).toBe(true);
    expect(25 * 60_000).toBeGreaterThan(DEFAULT_AGENT_STEP_TIMEOUT_MS);
  });

  it("leaves the fleet default alone", () => {
    // Thirteen other agents rely on the tighter bound; loosening it globally to
    // accommodate one outlier would remove a real guard from all of them.
    expect(DEFAULT_AGENT_STEP_TIMEOUT_MS).toBe(10 * 60_000);
  });
});
