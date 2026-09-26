import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiAdapter } from "../src/router/adapters/gemini-adapter.js";

/**
 * ── THE 98% THAT WAS NOT THE ANSWER. ──
 *
 * `06-vet-images` on `pubsub-21905062348134898` (2026-09-20) billed 9,757,
 * 24,895 and 42,873 output tokens across three attempts. The third call's
 * answer was four selections and 3,232 characters of JSON — about 800 tokens.
 * The rest was reasoning, which Gemini bills at the output rate.
 *
 * The intuitive cause was the candidate pool being re-sent each attempt. The
 * usage says otherwise: input was cached at 2,201 and 2,370 UNCACHED tokens on
 * attempts 2 and 3. The pool was never the cost.
 *
 * These assert the control that bounds it, and — just as importantly — that a
 * caller who sets nothing still behaves exactly as every caller did before the
 * field existed.
 */

const schema = z.object({ ok: z.boolean() });

function fakeClient(capture: { config?: Record<string, unknown> | undefined }) {
  return {
    models: {
      generateContent: vi.fn(async (req: { config?: Record<string, unknown> }) => {
        capture.config = req.config;
        return {
          text: '{"ok":true}',
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0, cachedContentTokenCount: 0 },
        };
      }),
    },
  };
}

function adapterWith(capture: { config?: Record<string, unknown> | undefined }): GeminiAdapter {
  const adapter = new GeminiAdapter({ apiKey: "test" } as never);
  // The adapter resolves a client per model; swap it for the fake.
  (adapter as unknown as { resolveClient: () => unknown }).resolveClient = () => fakeClient(capture);
  return adapter;
}

describe("thinkingBudget: bounding what the model bills for thinking", () => {
  it("passes a budget through as thinkingConfig when one is set", async () => {
    const capture: { config?: Record<string, unknown> | undefined } = {};
    await adapterWith(capture).complete({ prompt: "p", schema, model: "gemini-3.1-pro-preview", thinkingBudget: 6_000 });
    expect(capture.config?.["thinkingConfig"]).toEqual({ thinkingBudget: 6_000 });
  });

  it("sends NO thinkingConfig when none is set, so reasoning stays as unbounded as it always was", async () => {
    // The CAP is opt-in and stays opt-in: a caller that never heard of the
    // field must not suddenly have its reasoning bounded, because that would
    // change what the step produces, not just what it survives.
    const capture: { config?: Record<string, unknown> | undefined } = {};
    await adapterWith(capture).complete({ prompt: "p", schema, model: "gemini-3.1-pro-preview" });
    expect(capture.config).toBeDefined();
    expect("thinkingConfig" in (capture.config ?? {})).toBe(false);
    // The CEILING is not opt-in, and this is the one thing about such a caller
    // that did change on 2026-09-26. `gemini-3.1-pro-preview` reasons whether
    // or not anyone configured it to, so the default 16,384 of answer room now
    // gets the reserve added on top rather than being quietly shared with it.
    // More room, never less — the request is not byte-identical, and that is
    // the point.
    expect(capture.config?.["maxOutputTokens"]).toBe(16_384 + 8_192);
  });

  it("keeps the budget independent of maxTokens, because they buy different things", async () => {
    // On Gemini thoughts count against `maxOutputTokens` too, so one number
    // cannot say "think this much AND answer this much". A shared ceiling is
    // how `04b-research-extract-facts` truncated with 3,059 visible tokens.
    //
    // Which is why this asserted the wrong number until 2026-09-26. It sent
    // the step's 20,000 as the ceiling and the 6,000 as the budget, and called
    // them independent — but a 6,000-token budget drawn from a 20,000-token
    // ceiling leaves the ANSWER 14,000, so the two were never independent at
    // all. The prose above described the fix; the assertion below encoded the
    // defect. `maxOutputTokens` is now the sum, which is the only shape in
    // which `maxTokens: 20_000` still means twenty thousand tokens of answer.
    const capture: { config?: Record<string, unknown> | undefined } = {};
    await adapterWith(capture).complete({ prompt: "p", schema, model: "gemini-3.1-pro-preview", maxTokens: 20_000, thinkingBudget: 6_000 });
    expect(capture.config?.["maxOutputTokens"]).toBe(26_000);
    // The budget itself is still forwarded verbatim — the reserve buys the
    // answer its room, the budget is what actually bounds the reasoning, and
    // this step is the one that needs both.
    expect(capture.config?.["thinkingConfig"]).toEqual({ thinkingBudget: 6_000 });
  });
});
