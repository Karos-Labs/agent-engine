import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runInToolUsageScope, type ToolUnitUsage } from "@agent-engine/core";
import { contentFail, defineTool, success } from "@agent-engine/tool-common";

/**
 * `defineTool` is the one place every tool's outcome passes through, so it
 * is where per-unit usage reaches the step that is running (2026-09-08).
 * Without this, a step was billed for a tool only when its body happened to
 * return the tool's outcome — see `tool-usage-attribution.test.ts` in the
 * workflow package for the run that exposed it.
 */

const ctx = { ctx: { runId: "r", clientSlug: "acme", productId: "p", runKind: "recurring" } } as never;

const counted = defineTool<{ seconds: number }, { path: string }>({
  name: "test.generate",
  description: "test",
  version: "1.0.0",
  inputSchema: z.object({ seconds: z.number() }),
  async execute({ seconds }) {
    return success({ path: "x.mp4" }, [{ model: "veo-3.1-generate-001", unit: "second", quantity: seconds }]);
  },
});

const declined = defineTool<{ seconds: number }, { path: string }>({
  name: "test.declined",
  description: "test",
  version: "1.0.0",
  inputSchema: z.object({ seconds: z.number() }),
  async execute() {
    return contentFail("the model declined");
  },
});

describe("defineTool records per-unit usage into the active tool-usage scope", () => {
  it("pushes a success outcome's usage onto the scope's sink, the very same entries the outcome carries", async () => {
    const sink: ToolUnitUsage[] = [];
    const outcome = await runInToolUsageScope(sink, () => counted.execute({ seconds: 6 }, ctx));
    expect(sink).toEqual([{ model: "veo-3.1-generate-001", unit: "second", quantity: 6 }]);
    // Identity, not just equality: `mergeToolUsage` dedupes by reference.
    expect(outcome.status === "success" && outcome.usage?.[0]).toBe(sink[0]);
  });

  it("records nothing for a declined call — nothing billable was consumed", async () => {
    const sink: ToolUnitUsage[] = [];
    await runInToolUsageScope(sink, () => declined.execute({ seconds: 6 }, ctx));
    expect(sink).toEqual([]);
  });

  it("is a no-op outside any scope", async () => {
    const outcome = await counted.execute({ seconds: 4 }, ctx);
    expect(outcome.status).toBe("success");
  });
});
