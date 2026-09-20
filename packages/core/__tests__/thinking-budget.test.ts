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

  it("sends NO thinkingConfig when none is set, so every existing caller is byte-identical", async () => {
    // The field is opt-in. A caller that never heard of it must produce the
    // same request it produced before the field existed — otherwise this is a
    // silent behaviour change to every Gemini step in the repo.
    const capture: { config?: Record<string, unknown> | undefined } = {};
    await adapterWith(capture).complete({ prompt: "p", schema, model: "gemini-3.1-pro-preview" });
    expect(capture.config).toBeDefined();
    expect("thinkingConfig" in (capture.config ?? {})).toBe(false);
  });

  it("keeps the budget independent of maxTokens, because they buy different things", async () => {
    // On Gemini thoughts count against `maxOutputTokens` too, so one number
    // cannot say "think this much AND answer this much". A shared ceiling is
    // how `04b-research-extract-facts` truncated with 3,059 visible tokens.
    const capture: { config?: Record<string, unknown> | undefined } = {};
    await adapterWith(capture).complete({ prompt: "p", schema, model: "gemini-3.1-pro-preview", maxTokens: 20_000, thinkingBudget: 6_000 });
    expect(capture.config?.["maxOutputTokens"]).toBe(20_000);
    expect(capture.config?.["thinkingConfig"]).toEqual({ thinkingBudget: 6_000 });
  });
});
