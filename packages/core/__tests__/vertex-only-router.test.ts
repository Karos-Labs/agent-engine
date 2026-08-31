import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createModelRouterFromEnv, resolveClaudeRoute } from "../src/router/create-model-router-from-env.js";
import type { ModelRouter } from "../src/router/model-router.js";

/** Reaches into `DefaultModelRouter`'s private adapter map — same helper
 * `create-model-router-from-env.test.ts` uses, duplicated here rather than
 * shared so this file stays readable as the one place Half A's whole
 * "no adapter without a Vertex project" property is asserted together. */
function adapterFor(router: ModelRouter, vendor: string): unknown {
  return (router as unknown as { adapters: Record<string, unknown> }).adapters[vendor];
}

/**
 * AU59 (SCRUM-358): models are served through Vertex AI only.
 *
 * **Half A only** (this file's whole scope). Half A removed the
 * `openai-compatible` vendor's env-driven wiring entirely and the Gemini
 * `direct` sub-route's adapter construction — `OPENAI_COMPATIBLE_BASE_URL`,
 * `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` build
 * nothing any more, full credentials or not. This file asserts exactly that,
 * and nothing broader.
 *
 * It deliberately does NOT assert "the router has no non-Vertex fallback at
 * all" — `ResilientClaudeAdapter`'s direct-Anthropic hop
 * (`createClaudeDirectAdapter`, wired whenever `ANTHROPIC_API_KEY` is set on
 * the agent-platform route) is Half B, held on SCRUM-375/AU73's finding that
 * it currently carries most of production Claude spend. A test here that
 * failed when `ANTHROPIC_API_KEY` produces a working fallback would be
 * asserting a property Half B has not established yet — see
 * `create-model-router-from-env.test.ts`'s "anthropic dual-layer fallback
 * wiring" suite for that behaviour, which is intentionally unchanged.
 *
 * Grounded in what the deployed services actually carry (read from the running
 * revisions, not from YAML): MODEL_PROVIDER unset in both, GEMINI_API_KEY and
 * OPENAI_COMPATIBLE_BASE_URL in neither, ANTHROPIC_VERTEX_PROJECT_ID and
 * GEMINI_VERTEX_PROJECT_ID in both.
 */

/** Exactly what prep and prod set today, minus anything direct-vendor. */
const VERTEX_ENV: Record<string, string> = {
  GOOGLE_CLOUD_PROJECT: "karoscmo",
  ANTHROPIC_VERTEX_PROJECT_ID: "karoscmo-prep",
  GEMINI_VERTEX_PROJECT_ID: "karoscmo-prep",
  CLOUD_ML_REGION: "global",
  VERTEX_AI_LOCATION: "us-central1",
};

describe("AU59: the router serves models through Vertex only", () => {
  it("defaults to the Vertex route when MODEL_PROVIDER is unset, as both environments leave it", () => {
    expect(resolveClaudeRoute({})).toBe("agent-platform");
    expect(resolveClaudeRoute(VERTEX_ENV)).toBe("agent-platform");
  });

  it("accepts the Vertex spellings", () => {
    expect(resolveClaudeRoute({ MODEL_PROVIDER: "agent-platform" })).toBe("agent-platform");
    expect(resolveClaudeRoute({ MODEL_PROVIDER: "vertex" })).toBe("agent-platform");
  });

  it("builds a working router from Vertex configuration alone — no API key anywhere", () => {
    const router = createModelRouterFromEnv({ env: VERTEX_ENV });
    expect(router).toBeDefined();
  });

  it("REFUSES to build when no Vertex project is configured, rather than falling back to a keyed route", () => {
    // The load-bearing assertion. If a direct-vendor adapter is ever
    // reintroduced as a fallback, this stops throwing — an environment with no
    // Vertex project would quietly acquire a working router again, which is
    // precisely the state AU59 removes.
    expect(() => createModelRouterFromEnv({ env: {} })).toThrow(/VERTEX_PROJECT_ID|GOOGLE_CLOUD_PROJECT/);
  });

  it("an API key alone does not produce a usable router", () => {
    // Same property from the other side: credentials for a direct vendor must
    // not be sufficient. Without a Vertex project this must still refuse.
    expect(() =>
      createModelRouterFromEnv({
        env: {
          ANTHROPIC_API_KEY: "sk-ant-should-not-help",
          GEMINI_API_KEY: "gemini-should-not-help",
          OPENAI_API_KEY: "sk-should-not-help",
          OPENAI_COMPATIBLE_BASE_URL: "https://gateway.invalid/v1",
        },
      }),
    ).toThrow();
  });

  it("does not build an OpenAI-compatible adapter from a base URL with no credential", () => {
    // AU59: `?? "unused"` used to manufacture a placeholder key, producing an
    // adapter that looked configured and failed at call time instead of
    // declining at wiring time. A router built with a Vertex project plus a
    // bare gateway URL must not gain a second vendor from the URL alone.
    const router = createModelRouterFromEnv({ env: { ...VERTEX_ENV, OPENAI_COMPATIBLE_BASE_URL: "https://gateway.invalid/v1" } });
    expect(router).toBeDefined();
  });

  describe("Half A's own removals: no adapter reachable without a Vertex project", () => {
    it("registers no openai-compatible adapter even with a base URL AND a full credential — the function that built one is deleted, not just gated", () => {
      const router = createModelRouterFromEnv({
        env: {
          ...VERTEX_ENV,
          OPENAI_COMPATIBLE_BASE_URL: "https://gateway.invalid/v1",
          OPENAI_COMPATIBLE_API_KEY: "sk-gateway-should-not-help",
          OPENAI_API_KEY: "sk-openai-should-not-help",
        },
      });
      expect(adapterFor(router, "openai-compatible")).toBeUndefined();

      // The whole point of removing the factory rather than leaving it merely
      // unreachable: a step that names this vendor still fails, but ONLY from
      // DefaultModelRouter's own point-of-use error — never by constructing a
      // client from these three variables first.
      return expect(
        router.complete("classify this", z.object({ text: z.string() }), {
          policy: "commodity",
          model: "gpt-4o-mini",
          vendor: "openai-compatible",
        }),
      ).rejects.toThrow(/Vertex AI only/);
    });

    it("registers no gemini adapter via the direct sub-route even with GEMINI_API_KEY set, when nothing satisfies the Vertex route", () => {
      // GEMINI_ROUTE=direct with no ANTHROPIC_VERTEX_PROJECT_ID/GOOGLE_CLOUD_
      // PROJECT/GEMINI_VERTEX_PROJECT_ID fallback available for Gemini's own
      // agent-platform sub-route: the ONLY thing that could build a gemini
      // adapter here is the removed direct branch, so this isolates it from
      // VERTEX_ENV's own GOOGLE_CLOUD_PROJECT, which would otherwise mask the
      // result via the fallback this file is not testing here.
      const router = createModelRouterFromEnv({
        env: { ANTHROPIC_VERTEX_PROJECT_ID: "karoscmo-prep", GEMINI_ROUTE: "direct", GEMINI_API_KEY: "gemini-should-not-help" },
      });
      expect(adapterFor(router, "gemini")).toBeUndefined();
    });

    it("still builds a working gemini adapter through the untouched Vertex branch, with no key of any kind", () => {
      // The other half of the same property: removing the direct branch must
      // not have collaterally broken the branch AU59 was told to leave alone.
      const router = createModelRouterFromEnv({ env: VERTEX_ENV });
      expect(adapterFor(router, "gemini")).toBeDefined();
    });
  });
});
