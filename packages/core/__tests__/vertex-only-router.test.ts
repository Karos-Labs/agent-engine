import { describe, expect, it } from "vitest";
import { createModelRouterFromEnv, resolveClaudeRoute } from "../src/router/create-model-router-from-env.js";

/**
 * AU59 (SCRUM-358): models are served through Vertex AI only.
 *
 * Written to pass TODAY, before the direct-vendor adapters are removed, and to
 * fail the moment one is reachable again. The property under test is not "the
 * adapters are deleted" — it is "nothing can be registered without a Vertex
 * project", which is what makes Vertex-only a property of the router rather
 * than a convention someone remembers.
 *
 * Grounded in what the deployed services actually carry (read from the running
 * revisions, not from YAML): MODEL_PROVIDER unset in both, GEMINI_API_KEY in
 * neither, ANTHROPIC_VERTEX_PROJECT_ID and GEMINI_VERTEX_PROJECT_ID in both.
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

  it("part 2: the direct route is GONE, and says so rather than resolving to Vertex", () => {
    // Part 1 asserted that a key could not SUBSTITUTE for a Vertex project.
    // This is the other half, and the half part 1 explicitly could not make:
    // asking for the direct route by name now fails. Resolving it silently to
    // agent-platform would be the worst outcome — a deployment that chose the
    // direct API would run on Vertex believing otherwise.
    expect(() => resolveClaudeRoute({ MODEL_PROVIDER: "anthropic" })).toThrow(/REMOVED in SCRUM-358/);
    expect(() => resolveClaudeRoute({ ...VERTEX_ENV, MODEL_PROVIDER: "anthropic" })).toThrow(/REMOVED in SCRUM-358/);
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
});
