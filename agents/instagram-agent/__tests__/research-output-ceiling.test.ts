import { describe, expect, it } from "vitest";
import { GEMINI_DEFAULT_MAX_TOKENS } from "@agent-engine/core";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";

/**
 * `04b-research-extract-facts` must not be able to inherit the default ceiling
 * again (Phase 5.5, brief item B).
 *
 * It declared no `maxTokens`, inherited `GEMINI_DEFAULT_MAX_TOKENS` (16,384),
 * and on geektime (prep run `pubsub-21868533047825082`) hit it and resolved
 * `tooling_error` — so that post was written from **zero fact cards**, which
 * is the most expensive single failure in the whole 2026-09-16 set. It also
 * reported $0, because a truncated turn booked nothing until
 * `OutputLimitExceededError` carried its usage
 * (`packages/core/__tests__/truncated-turn-cost.test.ts`).
 *
 * The number is measured, not padded: the three extractions that completed
 * that day returned 3,059 / 3,127 / 3,263 VISIBLE output tokens on 65k-76k of
 * input. The rest of the ceiling went to thinking, which Gemini 2.5 counts
 * against `maxOutputTokens` while excluding it from `candidatesTokenCount` —
 * so the headroom this step needed was the part nobody could see.
 */
describe("InstagramResearchAgent — the output ceiling", () => {
  const config = (
    new InstagramResearchAgent({ router: {} as never, tools: {}, promptStore: {} as never }) as unknown as {
      config: { id: string; maxTokens?: number; modelPolicy: unknown };
    }
  ).config;

  it("declares its own ceiling instead of inheriting the one that truncated it", () => {
    expect(config.id).toBe("instagram-research");
    expect(
      config.maxTokens,
      "an undeclared ceiling is the 16,384 that cost geektime every one of its fact cards",
    ).toBeDefined();
    expect(config.maxTokens).toBeGreaterThan(GEMINI_DEFAULT_MAX_TOKENS);
    expect(config.maxTokens).toBe(24_000);
  });

  it("still routes to Gemini Flash, which is the adapter that reads that ceiling", () => {
    // If this step ever moved vendors the number above would be measured
    // against a different model's thinking behaviour and would need re-taking.
    expect(JSON.stringify(config.modelPolicy)).toContain("gemini-3.8-flash");
  });
});
