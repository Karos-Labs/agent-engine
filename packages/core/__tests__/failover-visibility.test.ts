import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ResilientClaudeAdapter } from "../src/router/adapters/resilient-claude-adapter.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "../src/router/adapters/types.js";

/**
 * AU61 (SCRUM-360): a fallback is only worth its line if its firing is
 * observable.
 *
 * Before this, `complete()` caught, failed over and returned in silence, so
 * "never fired" and "fires constantly" were indistinguishable from outside —
 * and in the second case output comes from a different route than anyone
 * believes while every dashboard stays green. It is why answering "has it ever
 * fired?" needed Vertex error metrics and a 30-day window instead of a query.
 *
 * That matters more here than it would elsewhere: Claude on Vertex emits NO
 * publisher metrics at all (verified across model_invocation_count,
 * token_count and consumed_throughput — the only model present is
 * gemini-2.5-flash-image), so these emissions are the ONLY possible signal.
 */

function failing(providerId: string, status: number): ModelAdapter {
  return {
    providerId,
    async complete() {
      const err = new Error(`${status} simulated`) as Error & { status: number };
      err.status = status;
      throw err;
    },
  };
}

function serving(providerId: string): ModelAdapter {
  return {
    providerId,
    async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
      return { output: {} as T, modelUsed: req.model, inputTokens: { cached: 0, uncached: 10 }, outputTokens: 5 };
    },
  };
}

const req = { model: "claude-sonnet-4-6", system: "", messages: [], schema: {} } as unknown as CompletionRequest<unknown>;

describe("AU61: every failover is audible and attributable", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // structured-log writes WARNING through console.log; vitest intercepts
    // console before it reaches process.stdout, so spy at that level.
    logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logged.mockRestore();
  });

  const emitted = (): Record<string, unknown>[] =>
    (logged.mock.calls as unknown[][])
      .map((call): string => String(call[0]))
      .filter((line: string) => line.includes("model.failover"))
      .map((line: string) => JSON.parse(line) as Record<string, unknown>);

  it("logs a structured, classifiable event when the primary is rate limited", async () => {
    const adapter = new ResilientClaudeAdapter({ primary: failing("agent-platform", 429), secondary: serving("anthropic") });
    await adapter.complete(req);

    const [log] = emitted();
    expect(log, "a failover must not be silent").toBeDefined();
    expect(log).toMatchObject({
      event: "model.failover", // stable — a log-based metric counts this
      from: "agent-platform",
      to: "anthropic",
      model: "claude-sonnet-4-6",
      errorClass: "rate_limited",
      status: 429,
      severity: "WARNING",
    });
  });

  it("distinguishes a 404 from a 429 — different problems, different fixes", async () => {
    const adapter = new ResilientClaudeAdapter({ primary: failing("agent-platform", 404), secondary: serving("anthropic") });
    await adapter.complete(req);
    expect(emitted()[0]).toMatchObject({ errorClass: "not_served", status: 404 });
  });

  it("records provenance so a deliverable's route is knowable afterwards", async () => {
    // The point: primary and secondary return the SAME model id, so modelUsed
    // alone cannot tell anyone which route produced what they are holding.
    const adapter = new ResilientClaudeAdapter({ primary: failing("agent-platform", 429), secondary: serving("anthropic") });
    const result = await adapter.complete(req);

    expect(result.provenance).toEqual({
      hop: "secondary",
      servedBy: "anthropic",
      failedOver: [{ from: "agent-platform", errorClass: "rate_limited", status: 429 }],
    });
  });

  it("emits one event per hop, and records the model change on the last one", async () => {
    const adapter = new ResilientClaudeAdapter({
      primary: failing("agent-platform", 404),
      secondary: failing("anthropic", 429),
      tertiary: serving("gemini"),
      tertiaryModel: "gemini-1.5-flash",
    });
    const result = await adapter.complete(req);

    const logs = emitted();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ from: "anthropic", to: "gemini", toModel: "gemini-1.5-flash" });

    // A genuinely different model family answered — the one hop that changes
    // model identity, and the one most worth being able to see after the fact.
    expect(result.modelUsed).toBe("gemini-1.5-flash");
    expect(result.provenance?.hop).toBe("tertiary");
    expect(result.provenance?.failedOver).toHaveLength(2);
  });

  it("stays SILENT when nothing fails — the common case must not become noise", async () => {
    const adapter = new ResilientClaudeAdapter({ primary: serving("agent-platform"), secondary: serving("anthropic") });
    const result = await adapter.complete(req);

    expect(emitted()).toHaveLength(0);
    expect(result.provenance).toEqual({ hop: "primary", servedBy: "agent-platform", failedOver: [] });
  });

  it("does not reroute — or log — an error that is not a routing problem", async () => {
    // A 500 is a real failure, not a transport problem. Silently serving it
    // from another vendor would hide a genuine fault.
    const adapter = new ResilientClaudeAdapter({ primary: failing("agent-platform", 500), secondary: serving("anthropic") });
    await expect(adapter.complete(req)).rejects.toThrow(/500/);
    expect(emitted()).toHaveLength(0);
  });
});
