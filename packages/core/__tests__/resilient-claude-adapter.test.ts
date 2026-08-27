import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ResilientClaudeAdapter, type CompletionRequest, type CompletionResult, type ModelAdapter } from "../src/index.js";

const OutputSchema = z.object({ text: z.string() });

function httpError(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

function fakeAdapter(providerId: string, impl: (req: CompletionRequest<unknown>) => Promise<CompletionResult<unknown>>): ModelAdapter {
  return { providerId, complete: vi.fn(impl) } as unknown as ModelAdapter;
}

function okResult(providerId: string, model: string): CompletionResult<unknown> {
  return { output: { text: `${providerId}:${model}` }, modelUsed: model, inputTokens: { cached: 0, uncached: 10 }, outputTokens: 5 };
}

const baseReq: CompletionRequest<unknown> = { prompt: "hi", schema: OutputSchema, model: "claude-sonnet-4-6" };

/**
 * SCRUM-358 part 2 removed the middle hop (direct Anthropic), so this chain is
 * now two adapters, not three — and the surviving hop is the one that CHANGES
 * MODEL FAMILY.
 *
 * That inverts what these tests are for. They used to protect a property that
 * made failover cheap: the first hop served the same model id over a different
 * transport, so a 429 was absorbed invisibly and correctly. There is no cheap
 * hop left. Every failover from here is a Claude request answered by Gemini,
 * which is why the assertions below care about the model id sent, the model id
 * returned, and the provenance recorded — not merely that something answered.
 */
describe("ResilientClaudeAdapter (Vertex Claude -> Vertex Gemini)", () => {
  it("returns the primary's result directly when it succeeds — the fallback is never touched", async () => {
    const primary = fakeAdapter("agent-platform", async (req) => okResult("agent-platform", req.model));
    const tertiary = fakeAdapter("gemini", async () => {
      throw new Error("should never be called");
    });
    const adapter = new ResilientClaudeAdapter({ primary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    const result = await adapter.complete(baseReq);
    expect(result.output).toEqual({ text: "agent-platform:claude-sonnet-4-6" });
    expect(tertiary.complete).not.toHaveBeenCalled();
    expect(result.provenance).toEqual({ hop: "primary", servedBy: "agent-platform", failedOver: [] });
  });

  it.each([429, 404])("falls over to Gemini on a %i from Vertex, sending the GEMINI model id", async (status) => {
    const primary = fakeAdapter("agent-platform", async () => {
      throw httpError(status, `vertex said ${status}`);
    });
    const tertiary = fakeAdapter("gemini", async (req) => okResult("gemini", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    const result = await adapter.complete(baseReq);

    // Asking Gemini to serve a Claude model id would just be a second,
    // differently-shaped failure.
    expect(tertiary.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-1.5-flash" }));
    expect(result.output).toEqual({ text: "gemini:gemini-1.5-flash" });
    expect(result.modelUsed).toBe("gemini-1.5-flash");
  });

  it("records, on the result itself, that a different model family produced it", async () => {
    // The load-bearing one. Before SCRUM-358 the first failover preserved the
    // model id, so a deliverable was the same deliverable either way. Now it
    // is not, and `modelUsed` alone cannot say whether that was intended — the
    // caller pinned a Claude model and got a Gemini one.
    const primary = fakeAdapter("agent-platform", async () => {
      throw httpError(429, "quota exceeded");
    });
    const tertiary = fakeAdapter("gemini", async (req) => okResult("gemini", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    const result = await adapter.complete(baseReq);

    expect(result.provenance).toEqual({
      hop: "tertiary",
      servedBy: "gemini",
      failedOver: [{ from: "agent-platform", errorClass: "rate_limited", status: 429 }],
    });
  });

  it("REFUSES to fall over on an error that is not a routing problem — a 400 propagates as-is", async () => {
    // Serving a genuine request fault from another model family would hide a
    // real bug behind a plausible-looking deliverable.
    const primary = fakeAdapter("agent-platform", async () => {
      throw httpError(400, "bad request");
    });
    const tertiary = fakeAdapter("gemini", async (req) => okResult("gemini", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    await expect(adapter.complete(baseReq)).rejects.toThrow("bad request");
    expect(tertiary.complete).not.toHaveBeenCalled();
  });

  it("propagates the primary's error unchanged when no fallback is configured", async () => {
    // The shape a deployment with no Gemini configured gets. It must fail, not
    // succeed quietly on some other route.
    const primary = fakeAdapter("agent-platform", async () => {
      throw httpError(429, "quota exceeded");
    });
    const adapter = new ResilientClaudeAdapter({ primary });

    await expect(adapter.complete(baseReq)).rejects.toThrow("quota exceeded");
  });

  it("defaults to the requested model id when no tertiaryModel is given", async () => {
    const primary = fakeAdapter("agent-platform", async () => {
      throw httpError(429);
    });
    const tertiary = fakeAdapter("gemini", async (req) => okResult("gemini", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, tertiary });

    const result = await adapter.complete(baseReq);
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
  });
});
