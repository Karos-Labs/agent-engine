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
 *
 * SCRUM-358 raised the stakes rather than lowering them. With the
 * direct-Anthropic hop deleted there is exactly one fallback left and it
 * serves a DIFFERENT MODEL FAMILY, so every firing of it changes what the
 * client receives. A silent failover used to mean "same model, other wire";
 * it now means "Gemini wrote this".
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

  const chain = (primary: ModelAdapter) => new ResilientClaudeAdapter({ primary, tertiary: serving("gemini"), tertiaryModel: "gemini-1.5-flash" });

  it("logs a structured, classifiable event when the Vertex route is rate limited", async () => {
    await chain(failing("agent-platform", 429)).complete(req);

    const [log] = emitted();
    expect(log, "a failover must not be silent").toBeDefined();
    expect(log).toMatchObject({
      event: "model.failover", // stable — a log-based metric counts this
      from: "agent-platform",
      to: "gemini",
      model: "claude-sonnet-4-6",
      // The model actually served. Since SCRUM-358 this is ALWAYS a different
      // family from `model`, which is the whole reason the field is here.
      toModel: "gemini-1.5-flash",
      errorClass: "rate_limited",
      status: 429,
      severity: "WARNING",
    });
  });

  it("distinguishes a 404 from a 429 — different problems, different fixes", async () => {
    await chain(failing("agent-platform", 404)).complete(req);
    expect(emitted()[0]).toMatchObject({ errorClass: "not_served", status: 404 });
  });

  it("records provenance so a deliverable's model family is knowable afterwards", async () => {
    const result = await chain(failing("agent-platform", 429)).complete(req);

    expect(result.provenance).toEqual({
      hop: "tertiary",
      servedBy: "gemini",
      failedOver: [{ from: "agent-platform", errorClass: "rate_limited", status: 429 }],
    });
    expect(result.modelUsed).toBe("gemini-1.5-flash");
  });

  it("emits exactly one event for the one hop that remains", async () => {
    // Before SCRUM-358 this chain was three deep and emitted two events. It is
    // now two deep and emits one. Asserted rather than assumed, because a
    // log-based metric counting `model.failover` would silently halve its
    // reading if this were wrong.
    await chain(failing("agent-platform", 404)).complete(req);
    expect(emitted()).toHaveLength(1);
  });

  it("stays SILENT when nothing fails — the common case must not become noise", async () => {
    const result = await chain(serving("agent-platform")).complete(req);

    expect(emitted()).toHaveLength(0);
    expect(result.provenance).toEqual({ hop: "primary", servedBy: "agent-platform", failedOver: [] });
  });

  it("does not reroute — or log — an error that is not a routing problem", async () => {
    // A 500 is a real failure, not a transport problem. Silently serving it
    // from another model family would hide a genuine fault behind a plausible
    // deliverable.
    await expect(chain(failing("agent-platform", 500)).complete(req)).rejects.toThrow(/500/);
    expect(emitted()).toHaveLength(0);
  });
});
