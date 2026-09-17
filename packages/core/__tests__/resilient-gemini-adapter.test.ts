import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentStepTelemetrySchema } from "../src/types/agent-step.js";
import { OutputLimitExceededError } from "../src/router/adapters/structured-output.js";
import { GeminiAdapter } from "../src/router/adapters/gemini-adapter.js";
// Imported by path rather than from `../src/index.js` because
// `router/adapters/index.ts` is not this work package's to edit — adding
// `export * from "./resilient-gemini-adapter.js"` there is the integrator's
// one-line step (see the package's integration notes). Everything asserted
// below is the module's own behaviour, so the import path changes nothing
// about what is tested.
import { GeminiRoutesExhaustedError, ResilientGeminiAdapter, type GeminiTextSubstitution } from "../src/router/adapters/resilient-gemini-adapter.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "../src/router/adapters/types.js";

const OutputSchema = z.object({ text: z.string() });

/** The shape Vertex returned on 2026-09-13/14 — the incident this adapter exists for. */
function vertexDunning403(): Error {
  return Object.assign(new Error("Lightning dunning decision is deny for project karoscmo-prep"), { status: 403 });
}

function httpError(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

function fakeAdapter(providerId: string, impl: (req: CompletionRequest<unknown>) => Promise<CompletionResult<unknown>>): ModelAdapter {
  return { providerId, complete: vi.fn(impl) } as unknown as ModelAdapter;
}

/**
 * Deliberately DIFFERENT token counts per transport, so "booked once" is
 * assertable rather than assumed: if the adapter ever summed the hops, the
 * numbers below would add up instead of matching exactly one of them.
 */
function okResult(providerId: string, model: string): CompletionResult<unknown> {
  const usage: Record<string, { cached: number; uncached: number; out: number }> = {
    "gemini-vertex": { cached: 0, uncached: 1_000, out: 100 },
    "google-gemini-direct": { cached: 7, uncached: 2_000, out: 200 },
    "claude-fallback": { cached: 0, uncached: 3_000, out: 300 },
  };
  const u = usage[providerId] ?? { cached: 0, uncached: 10, out: 5 };
  return { output: { text: `${providerId}:${model}` }, modelUsed: model, inputTokens: { cached: u.cached, uncached: u.uncached }, outputTokens: u.out };
}

const baseReq: CompletionRequest<unknown> = { prompt: "judge this", schema: OutputSchema, model: "gemini-2.5-pro" };

/** The judges that read only text (07g, 07j, 08c, research extraction) — a Claude answer is an honest answer. */
function visionFree(adapter: ModelAdapter, model = "claude-haiku-4-5"): GeminiTextSubstitution {
  return { kind: "allow", adapter, model };
}

describe("ResilientGeminiAdapter", () => {
  it("returns the primary's result directly when Vertex answers — the second transport is never constructed into the call path", async () => {
    const primary = fakeAdapter("gemini-vertex", async (req) => okResult("gemini-vertex", req.model));
    const direct = fakeAdapter("google-gemini-direct", async () => {
      throw new Error("the direct API must not be called when Vertex answered");
    });
    const adapter = new ResilientGeminiAdapter({ primary, direct });

    const result = await adapter.complete(baseReq);

    expect(result.output).toEqual({ text: "gemini-vertex:gemini-2.5-pro" });
    expect(direct.complete).not.toHaveBeenCalled();
    expect(result.provenance).toEqual({ hop: "primary", servedBy: "gemini-vertex", failedOver: [] });
  });

  it("fails over to the Gemini Developer API on the 2026-09-13 Vertex 403, exactly once, with the SAME model id", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const direct = fakeAdapter("google-gemini-direct", async (req) => okResult("google-gemini-direct", req.model));
    const adapter = new ResilientGeminiAdapter({ primary, direct });

    const result = await adapter.complete(baseReq);

    expect(direct.complete).toHaveBeenCalledTimes(1);
    expect(direct.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-2.5-pro" }));
    expect(result.output).toEqual({ text: "google-gemini-direct:gemini-2.5-pro" });
  });

  it("books the serving hop's cost ONCE — a failed hop contributes no tokens and the hops are never summed", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const direct = fakeAdapter("google-gemini-direct", async (req) => okResult("google-gemini-direct", req.model));

    const result = await new ResilientGeminiAdapter({ primary, direct }).complete(baseReq);

    // Exactly the direct transport's own numbers. Summing the two hops would
    // read 3000/300; reporting the primary's would read 1000/100.
    expect(result.inputTokens).toEqual({ cached: 7, uncached: 2_000 });
    expect(result.outputTokens).toBe(200);
  });

  it("records the hop in the shape a step's telemetry accepts, so `vertex 403 -> direct key` reaches the run report", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const direct = fakeAdapter("google-gemini-direct", async (req) => okResult("google-gemini-direct", req.model));

    const result = await new ResilientGeminiAdapter({ primary, direct }).complete(baseReq);

    expect(result.provenance).toEqual({
      hop: "secondary",
      servedBy: "google-gemini-direct",
      failedOver: [{ from: "gemini-vertex", errorClass: "billing_denied", status: 403 }],
    });
    // The assertion that matters for the gate payload: `BaseAgent` copies
    // this straight onto `AgentStepTelemetry.servedBy`, so a shape this
    // schema refuses would be dropped silently at the step boundary.
    const telemetry = AgentStepTelemetrySchema.parse({
      stepIndex: 0,
      modelUsed: result.modelUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: 1_200,
      costUsd: 0.0123,
      status: "success",
      servedBy: { hop: result.provenance?.hop, adapter: result.provenance?.servedBy, failedOver: result.provenance?.failedOver },
    });
    expect(telemetry.servedBy?.failedOver[0]).toEqual({ from: "gemini-vertex", errorClass: "billing_denied", status: 403 });
  });

  it("falls to the Claude model when BOTH Google routes are gone and the step is a vision-free judge", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const direct = fakeAdapter("google-gemini-direct", async () => {
      throw httpError(429, "quota exceeded");
    });
    const claude = fakeAdapter("claude-fallback", async (req) => okResult("claude-fallback", req.model));

    const result = await new ResilientGeminiAdapter({ primary, direct, textSubstitution: visionFree(claude) }).complete(baseReq);

    // The model id CHANGES on this hop, and must: an Anthropic adapter asked
    // to serve `gemini-2.5-pro` is a third, differently-shaped failure.
    expect(claude.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5" }));
    expect(result.output).toEqual({ text: "claude-fallback:claude-haiku-4-5" });
    expect(result.provenance).toEqual({
      hop: "tertiary",
      servedBy: "claude-fallback",
      failedOver: [
        { from: "gemini-vertex", errorClass: "billing_denied", status: 403 },
        { from: "google-gemini-direct", errorClass: "rate_limited", status: 429 },
      ],
    });
  });

  it("resolves not_available on a VISION step instead of letting a text model pretend it looked at the picture", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const direct = fakeAdapter("google-gemini-direct", async () => {
      throw httpError(503, "backend unavailable");
    });
    const claude = fakeAdapter("claude-fallback", async (req) => okResult("claude-fallback", req.model));

    // No `textSubstitution` at all — the default. Saying nothing means refusing.
    const adapter = new ResilientGeminiAdapter({ primary, direct });

    const err = await adapter.complete(baseReq).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GeminiRoutesExhaustedError);
    const exhausted = err as GeminiRoutesExhaustedError;
    expect(exhausted.kind).toBe("not_available");
    expect(exhausted.failedOver).toEqual([
      { from: "gemini-vertex", errorClass: "billing_denied", status: 403 },
      { from: "google-gemini-direct", errorClass: "backend_error", status: 503 },
    ]);
    // The underlying transport error survives the wrapper.
    expect((exhausted.cause as Error).message).toBe("backend unavailable");
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it("decides substitution PER REQUEST, so one adapter instance serves a mix of vision and vision-free Gemini steps", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const claude = fakeAdapter("claude-fallback", async (req) => okResult("claude-fallback", req.model));
    // The Instagram agent's real shape: `instagram-visual-qa` reads rendered
    // plates, `instagram-post-packager` reads only text.
    const adapter = new ResilientGeminiAdapter({
      primary,
      textSubstitution: (req) => (req.prompt.includes("rendered slide") ? { kind: "refuse" } : visionFree(claude)),
    });

    await expect(adapter.complete({ ...baseReq, prompt: "rendered slide 4 of 8" })).rejects.toBeInstanceOf(GeminiRoutesExhaustedError);
    const packaged = await adapter.complete({ ...baseReq, prompt: "write the caption" });
    expect(packaged.provenance?.hop).toBe("tertiary");
  });

  it("does NOT fail over a truncated structured output EVEN WHEN it carries a failover-worthy status — the second route truncates identically, for a second full ceiling of billed tokens", async () => {
    // The status is what makes this test able to fail. A bare
    // `OutputLimitExceededError` carries none, so the status check alone would
    // already refuse it and the `instanceof` limb would be a guard that
    // cannot fire. A transport that wraps a cut-off turn in a 503 (or a
    // future adapter that attaches the HTTP status it saw) is exactly the
    // case that limb exists for: truncation is deterministic and has ALREADY
    // billed a full ceiling of output tokens, so re-issuing it elsewhere buys
    // the same failure at double the price. Delete the `instanceof` line in
    // `isFailoverWorthy` and this test fails.
    const truncation = Object.assign(
      new OutputLimitExceededError('google-gemini: model "gemini-2.5-pro" hit the 16384-token output limit', {
        usage: { modelUsed: "gemini-2.5-pro", inputTokens: { cached: 0, uncached: 65_000 }, outputTokens: 16_384 },
        attemptedMaxTokens: 16_384,
      }),
      { status: 503 },
    );
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw truncation;
    });
    const direct = fakeAdapter("google-gemini-direct", async (req) => okResult("google-gemini-direct", req.model));
    const claude = fakeAdapter("claude-fallback", async (req) => okResult("claude-fallback", req.model));

    const adapter = new ResilientGeminiAdapter({ primary, direct, textSubstitution: visionFree(claude) });

    // It propagates UNCHANGED, so `BaseAgent` still books what the cut-off
    // turn burned (W1-A) instead of seeing a wrapper it does not recognise.
    await expect(adapter.complete(baseReq)).rejects.toBe(truncation);
    expect(direct.complete).not.toHaveBeenCalled();
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it("does NOT fail over a request the model cannot satisfy — a bad schema fails the same way everywhere", async () => {
    const schemaErr = httpError(400, "responseJsonSchema: unsupported keyword `maxItems` in strict mode");
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw schemaErr;
    });
    const direct = fakeAdapter("google-gemini-direct", async (req) => okResult("google-gemini-direct", req.model));

    await expect(new ResilientGeminiAdapter({ primary, direct }).complete(baseReq)).rejects.toBe(schemaErr);
    expect(direct.complete).not.toHaveBeenCalled();
  });

  it("goes straight to the substitution decision when no direct transport is configured", async () => {
    const primary = fakeAdapter("gemini-vertex", async () => {
      throw vertexDunning403();
    });
    const claude = fakeAdapter("claude-fallback", async (req) => okResult("claude-fallback", req.model));

    const result = await new ResilientGeminiAdapter({ primary, textSubstitution: visionFree(claude) }).complete(baseReq);

    expect(result.provenance).toEqual({
      hop: "tertiary",
      servedBy: "claude-fallback",
      failedOver: [{ from: "gemini-vertex", errorClass: "billing_denied", status: 403 }],
    });
  });
});

describe("createDirectGeminiAdapter (the transport AU59 removed, back as a failover only)", () => {
  it("names itself distinctly from the Vertex adapter, so a failover log line says WHICH Google transport is serving", async () => {
    // Constructed directly rather than through the factory: the factory's own
    // `new GoogleGenAI({ apiKey })` would try to resolve credentials. What is
    // under test is that the id is overridable at all — the factory passes
    // exactly this value.
    const vertexShaped = new GeminiAdapter({ client: (() => ({})) as never });
    const directShaped = new GeminiAdapter({ client: (() => ({})) as never, providerId: "google-gemini-direct" });

    expect(vertexShaped.providerId).toBe("google-gemini");
    expect(directShaped.providerId).toBe("google-gemini-direct");
  });
});
