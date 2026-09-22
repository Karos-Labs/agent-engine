import { describe, expect, it, vi } from "vitest";
import { logError, logWarning, withLogScope, withToolCallSpan, withWorkflowRunSpan, withWorkflowStepSpan } from "../src/index.js";

/**
 * The ambient log scope (2026-09-22).
 *
 * The defect this covers: a `model.failover` warning named the model that
 * hopped and said nothing about whose work it was, so "every run silently
 * fails over" and "one run hit a 429 once" produced the same log line. The
 * adapter that writes it is constructed once per process and shared by every
 * client, several frames below a `ModelRouter.complete()` that is itself told
 * nothing about the run — so the identity has to arrive out of band.
 */

/** The JSON payloads `logWarning`/`logError` wrote while `fn` ran. */
async function captureLogs(fn: () => Promise<void> | void): Promise<Array<Record<string, unknown>>> {
  const payloads: Array<Record<string, unknown>> = [];
  const record = (line: unknown): void => {
    payloads.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  const log = vi.spyOn(console, "log").mockImplementation(record);
  const err = vi.spyOn(console, "error").mockImplementation(record);
  try {
    await fn();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return payloads;
}

describe("withLogScope", () => {
  it("writes no identity fields at all outside any scope", async () => {
    const [entry] = await captureLogs(() => {
      logWarning("model failover: primary -> secondary", { event: "model.failover" });
    });
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("runId");
    expect(entry).not.toHaveProperty("clientSlug");
    expect(entry?.["event"]).toBe("model.failover");
  });

  it("stamps a warning written several frames below the workflow with the run it belongs to", async () => {
    // Stands in for `recordFailover` inside a shared model adapter: it names
    // no run, and must not have to.
    function deepInsideASharedAdapter(): void {
      logWarning("model failover: primary -> secondary (rate_limit 429) for claude-opus-5", { event: "model.failover", from: "primary", to: "secondary" });
    }

    const entries = await captureLogs(() =>
      withWorkflowRunSpan({ runId: "run_7", clientSlug: "acme", productId: "instagram", runKind: "recurring" }, async () =>
        withWorkflowStepSpan({ runId: "run_7", clientSlug: "acme", productId: "instagram", stepId: "04-copy", stepKind: "agent" }, async () => {
          deepInsideASharedAdapter();
          return null;
        }),
      ),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "WARNING",
      event: "model.failover",
      runId: "run_7",
      clientSlug: "acme",
      productId: "instagram",
      runKind: "recurring",
      stepId: "04-copy",
    });
  });

  it("survives awaits, so an async continuation is still attributed", async () => {
    const entries = await captureLogs(() =>
      withLogScope({ runId: "run_8" }, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 1));
        logError("something broke after two awaits", new Error("boom"));
      }),
    );
    expect(entries[0]?.["runId"]).toBe("run_8");
    expect(entries[0]?.["severity"]).toBe("ERROR");
  });

  it("merges nested scopes outermost-first and keeps a tool name beside the step", async () => {
    const entries = await captureLogs(() =>
      withWorkflowRunSpan({ runId: "run_9", clientSlug: "acme", productId: "tiktok", runKind: "manual" }, async () =>
        withWorkflowStepSpan({ runId: "run_9", clientSlug: "acme", productId: "tiktok", slotId: "beats__slot_2", stepId: "06-footage", stepKind: "code" }, async () =>
          withToolCallSpan({ runId: "run_9", clientSlug: "acme", productId: "tiktok", toolName: "video.stockSearch", toolVersion: "1.2.0" }, async () => {
            logWarning("no clip matched this beat");
            return null;
          }),
        ),
      ),
    );
    expect(entries[0]).toMatchObject({
      runId: "run_9",
      clientSlug: "acme",
      productId: "tiktok",
      runKind: "manual",
      slotId: "beats__slot_2",
      stepId: "06-footage",
      toolName: "video.stockSearch",
    });
  });

  it("lets an explicit field win over the ambient one", async () => {
    // A call site that knows better than the scope — e.g. a sweep logging
    // about a DIFFERENT run than the one it is executing inside.
    const entries = await captureLogs(() =>
      withLogScope({ runId: "run_outer" }, () => {
        logWarning("resolving a gate for another run", { runId: "run_inner" });
      }),
    );
    expect(entries[0]?.["runId"]).toBe("run_inner");
  });
});
