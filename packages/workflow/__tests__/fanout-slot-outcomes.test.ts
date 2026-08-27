import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MemoryDurableStepStore, WorkflowEngine, type WorkflowContext } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * SCRUM-366: `fanout` is safe by ACCIDENT, and this converts that into safe by
 * ASSERTION.
 *
 * AU67 taught `step.code` to translate a tool's four-outcome result into a step
 * status, because tools report failure as a RETURNED VALUE and the recorder
 * only listened for exceptions. `fanout` was examined as part of closing that
 * set and is NOT structurally immune: `fn` is arbitrary caller code exactly
 * like `step.code`'s body, so a slot returning a tool outcome directly records
 * `status: "completed"` for a `tooling_error`.
 *
 * It misreports nothing today, and that is a property of the six call sites
 * rather than of the primitive — campaign-orchestrator's slots run whole
 * channel workflows, reputation's and seo-geo's route through `step.code`/
 * `step.agent` inside the slot, and all of those record correctly on their own.
 *
 * The real fix widens `SlotRecord.status` the way AU67 widened `StepRecord`'s,
 * which touches persisted slot records and `report.ts`'s `listSlots` and needs
 * its own enumeration first. This is the cheap half: it costs nothing now and
 * fails THE DAY someone writes the slot that would have broken it — which is
 * the day nobody will be looking, because "we fixed that".
 */
describe("SCRUM-366: no fanout slot returns a tool outcome directly", () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  const callSites = sourceFiles(path.join(repoRoot, "agents"))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes(".fanout("));

  it("finds the fanout call sites at all — the premise, asserted not assumed", () => {
    // Without this the suite passes by covering nothing, which is exactly what
    // happened to AU66's first metered-tool derivation: a signal that matched
    // zero files made every assertion under it vacuously true.
    expect(callSites.length, "no file calls .fanout( — the scan is looking in the wrong place").toBeGreaterThan(0);
  });

  it.each(callSites.map(({ file }) => path.relative(repoRoot, file).split(path.sep).join("/")))("%s", (rel) => {
    const source = callSites.find(({ file }) => file.endsWith(path.basename(rel)))!.source;

    // The shape that would reintroduce AU67: a slot body whose LAST expression
    // hands back a tool call's result, so the outcome becomes the slot's output
    // and `SlotRecord.status` records "completed" regardless of what it says.
    //
    // Deliberately narrow. `const x = await tools[...].execute(...)` inside a
    // slot is fine and common — the slot inspects it and returns something
    // else. Only handing it straight back is the hazard.
    const offenders = [...source.matchAll(/\breturn\s+(?:await\s+)?tools\s*\[[^\]]+\]\s*!?\s*\.execute\s*\(/g)];
    expect(
      offenders.map((m) => m[0]),
      `${rel} returns a tool outcome directly from a slot. SlotRecord.status would record "completed" for a tooling_error — ` +
        `the AU67 defect, in the primitive AU67 did not fix. Inspect the outcome and return a domain value, or wrap it in wf.step.code.`,
    ).toEqual([]);
  });
});

describe("SCRUM-366: the behaviour this guards, demonstrated", () => {
  it("records a slot as completed even when its body returned a tooling_error", async () => {
    // Not a wish — this is what `fanout` does today, asserted so the ticket has
    // a failing-shaped fact to point at rather than a description. When
    // SlotRecord.status is widened, THIS test changes, and its change is the
    // signal that the widening actually took effect.
    const store = new MemoryDurableStepStore();
    const workflowFn = async (wf: WorkflowContext) =>
      wf.fanout("slots", [1], async () => ({ status: "tooling_error", reason: "browser launch timed out", result: {} }));

    await new WorkflowEngine(store).run(workflowFn, {
      runId: "run_fanout_outcome",
      clientSlug: "acme",
      productId: "linkedin",
      runKind: "recurring",
    });

    const slots = await store.listSlots("run_fanout_outcome", "slots");
    expect(slots).toHaveLength(1);
    expect(slots[0]!.status, "TODAY this is `completed` — that is the defect SCRUM-366 exists to close").toBe("completed");
  });
});
