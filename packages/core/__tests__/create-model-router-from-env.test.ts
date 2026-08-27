import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DefaultModelRouter,
  ResilientClaudeAdapter,
  createModelRouterFromEnv,
  resolveGeminiRoute,
  resolvePinnedRouteProvider,
  type ModelRouter,
} from "../src/index.js";

/**
 * Construction only — instantiating either SDK client makes no network call
 * and, on the Agent Platform path, resolves no credentials until a request is
 * actually sent, so every case here stays fully offline and needs neither an
 * API key nor GCP credentials.
 */
describe("createModelRouterFromEnv", () => {
  describe("route selection", () => {
    it("defaults to Google Cloud's Agent Platform when MODEL_PROVIDER is unset", () => {
      expect(resolvePinnedRouteProvider({})).toBe("agent-platform");
    });

    it("accepts `vertex` as an alias for the Agent Platform's pre-rename name", () => {
      expect(resolvePinnedRouteProvider({ MODEL_PROVIDER: "vertex" })).toBe("agent-platform");
      expect(resolvePinnedRouteProvider({ MODEL_PROVIDER: "VERTEX" })).toBe("agent-platform");
    });

    it("REFUSES MODEL_PROVIDER=anthropic, naming the removal rather than reading as a typo", () => {
      // SCRUM-358 part 2. This value is set on real machines and in real shell
      // histories. Resolving it quietly to the Vertex route would let a
      // deployment that asked for the direct API believe it got one, so the
      // error has to say the route was REMOVED — which is also why it is not
      // folded into the unknown-value branch below.
      expect(() => resolvePinnedRouteProvider({ MODEL_PROVIDER: "anthropic" })).toThrow(/REMOVED in SCRUM-358/);
      expect(() => resolvePinnedRouteProvider({ MODEL_PROVIDER: "anthropic" })).toThrow(/Vertex only/);
    });

    it("rejects an unknown MODEL_PROVIDER instead of silently falling back to a route nobody asked for", () => {
      expect(() => resolvePinnedRouteProvider({ MODEL_PROVIDER: "bedrock" })).toThrow(/not a known route/);
    });
  });

  describe("Agent Platform route (default)", () => {
    it("constructs from ANTHROPIC_VERTEX_PROJECT_ID alone — no API key anywhere", () => {
      const router = createModelRouterFromEnv({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "karos-labs-prep" } });
      expect(router).toBeInstanceOf(DefaultModelRouter);
    });

    it("falls back to GOOGLE_CLOUD_PROJECT, which this repo already sets for Firestore and telemetry", () => {
      const router = createModelRouterFromEnv({ env: { GOOGLE_CLOUD_PROJECT: "karos-labs-prep" } });
      expect(router).toBeInstanceOf(DefaultModelRouter);
    });

    it("names the missing variable, and the escape hatch, when no project is configured", () => {
      expect(() => createModelRouterFromEnv({ env: {} })).toThrow(/ANTHROPIC_VERTEX_PROJECT_ID/);
      expect(() => createModelRouterFromEnv({ env: {} })).toThrow(/MODEL_PROVIDER=anthropic/);
    });

    it("does NOT accept an ANTHROPIC_API_KEY as a substitute for a project id — the route is the key", () => {
      // Regression guard: a deployment that only rotated its secret and never
      // set a project should fail loudly at startup, not fall back to the
      // API-key route and quietly keep billing Anthropic directly.
      expect(() => createModelRouterFromEnv({ env: { ANTHROPIC_API_KEY: "sk-ant-test-key" } })).toThrow(
        /ANTHROPIC_VERTEX_PROJECT_ID/,
      );
    });

    it("accepts VERTEX_AI_LOCATION, the region variable this repo already carries for the prompt store", () => {
      const router = createModelRouterFromEnv({
        env: { GOOGLE_CLOUD_PROJECT: "karos-labs-prep", VERTEX_AI_LOCATION: "us-east5" },
      });
      expect(router).toBeInstanceOf(DefaultModelRouter);
    });

    it("tolerates a malformed region rather than building a base URL that 404s with nothing pointing at the cause", () => {
      const router = createModelRouterFromEnv({
        env: { GOOGLE_CLOUD_PROJECT: "karos-labs-prep", CLOUD_ML_REGION: "https://oops/not-a-region" },
      });
      expect(router).toBeInstanceOf(DefaultModelRouter);
    });
  });

  describe("the deleted direct-Anthropic route (SCRUM-358)", () => {
    it("refuses to build a router, WITH a key present — a valid key must not resurrect the route", () => {
      // The direction that matters. Refusing when the key is missing proves
      // nothing; anyone would. This proves that holding a working
      // ANTHROPIC_API_KEY is no longer sufficient to reach Anthropic directly.
      expect(() =>
        createModelRouterFromEnv({ env: { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-key" } }),
      ).toThrow(/REMOVED in SCRUM-358/);
    });

    it("refuses with no key too, for the same reason and with the same message", () => {
      expect(() => createModelRouterFromEnv({ env: { MODEL_PROVIDER: "anthropic" } })).toThrow(/REMOVED in SCRUM-358/);
    });
  });

  it("still constructs successfully when an OPENAI_COMPATIBLE_BASE_URL is also configured", () => {
    const router = createModelRouterFromEnv({
      env: {
        GOOGLE_CLOUD_PROJECT: "karos-labs-prep",
        OPENAI_COMPATIBLE_BASE_URL: "https://litellm.internal.example.com",
        OPENAI_COMPATIBLE_API_KEY: "sk-gateway-test-key",
      },
    });
    expect(router).toBeInstanceOf(DefaultModelRouter);
  });
});

/** Reaches into `DefaultModelRouter`'s private adapter map — the only way to
 * assert an optional vendor adapter got built (or didn't) without driving a
 * real network call through it. */
function adapterFor(router: ModelRouter, vendor: string): unknown {
  return (router as unknown as { adapters: Record<string, unknown> }).adapters[vendor];
}

const anthropicBaseline = { GOOGLE_CLOUD_PROJECT: "karos-labs-prep" };
const OutputSchema = z.object({ text: z.string() });

describe("resolveGeminiRoute", () => {
  it("defaults to agent-platform when GEMINI_ROUTE is unset", () => {
    expect(resolveGeminiRoute({})).toBe("agent-platform");
  });

  it("accepts 'direct'", () => {
    expect(resolveGeminiRoute({ GEMINI_ROUTE: "direct" })).toBe("direct");
  });

  it("accepts 'vertex' as an alias for agent-platform, case-insensitively", () => {
    expect(resolveGeminiRoute({ GEMINI_ROUTE: "vertex" })).toBe("agent-platform");
    expect(resolveGeminiRoute({ GEMINI_ROUTE: "AGENT-PLATFORM" })).toBe("agent-platform");
  });

  it("rejects an unknown GEMINI_ROUTE", () => {
    expect(() => resolveGeminiRoute({ GEMINI_ROUTE: "bedrock" })).toThrow(/not a known route/);
  });
});

describe("createModelRouterFromEnv — gemini vendor adapter", () => {
  it("builds a gemini adapter via the agent-platform sub-route when a project id is present", () => {
    const router = createModelRouterFromEnv({
      env: { ...anthropicBaseline, GEMINI_VERTEX_PROJECT_ID: "karos-labs-prep" },
    });
    expect(adapterFor(router, "gemini")).toBeDefined();
  });

  it("falls back to GOOGLE_CLOUD_PROJECT for the agent-platform sub-route, same as the Claude route does", () => {
    const router = createModelRouterFromEnv({ env: anthropicBaseline });
    // GOOGLE_CLOUD_PROJECT is already set for the Anthropic baseline above, and
    // Gemini's agent-platform sub-route reads the same variable as a fallback.
    expect(adapterFor(router, "gemini")).toBeDefined();
  });

  it("builds a gemini adapter via the direct sub-route when GEMINI_API_KEY is present", () => {
    const router = createModelRouterFromEnv({
      env: { ...anthropicBaseline, GEMINI_ROUTE: "direct", GEMINI_API_KEY: "test-key" },
    });
    expect(adapterFor(router, "gemini")).toBeDefined();
  });

  it("leaves the gemini adapter undefined on the direct sub-route when GEMINI_API_KEY is absent", () => {
    const router = createModelRouterFromEnv({
      env: { ...anthropicBaseline, GEMINI_ROUTE: "direct" },
    });
    expect(adapterFor(router, "gemini")).toBeUndefined();
  });

  it("router still builds fine with no gemini configuration at all, but a gemini-vendor call fails loudly and specifically", async () => {
    // No GEMINI_VERTEX_PROJECT_ID and no GEMINI_API_KEY. Claude's own Vertex
    // project is named explicitly rather than via GOOGLE_CLOUD_PROJECT, whose
    // fallback would configure the Gemini sub-route as a side effect and
    // defeat the point of the test.
    const router = createModelRouterFromEnv({
      env: { ANTHROPIC_VERTEX_PROJECT_ID: "karos-labs-prep" },
    });
    expect(router).toBeInstanceOf(DefaultModelRouter);
    expect(adapterFor(router, "gemini")).toBeUndefined();

    await expect(
      router.complete("draft this", OutputSchema, { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" }),
    ).rejects.toThrow(/GEMINI_VERTEX_PROJECT_ID|GEMINI_API_KEY/);
  });
});

describe("createModelRouterFromEnv — anthropic dual-layer fallback wiring", () => {
  it("stays a bare adapter (no wrapper) when nothing configures a fallback target", () => {
    // ANTHROPIC_VERTEX_PROJECT_ID, not GOOGLE_CLOUD_PROJECT: the latter would
    // also satisfy Gemini's own agent-platform fallback (see the "falls back
    // to GOOGLE_CLOUD_PROJECT" gemini test below) and defeat this case.
    const router = createModelRouterFromEnv({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "karos-labs-prep" } });
    expect(adapterFor(router, "gemini")).toBeUndefined();
    expect(adapterFor(router, "anthropic")).not.toBeInstanceOf(ResilientClaudeAdapter);
  });

  it("does NOT wrap merely because an ANTHROPIC_API_KEY is lying around — the key buys nothing now", () => {
    // Before SCRUM-358 this exact env produced a ResilientClaudeAdapter whose
    // second hop was the direct API. A leftover key in someone's shell must
    // not quietly change the routing shape any more.
    const router = createModelRouterFromEnv({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "karos-labs-prep", ANTHROPIC_API_KEY: "sk-ant-test-key" } });
    expect(adapterFor(router, "anthropic")).not.toBeInstanceOf(ResilientClaudeAdapter);
  });

  it("wraps in ResilientClaudeAdapter when a Gemini vendor adapter is configured — the only thing left to fall back to", () => {
    // anthropicBaseline's own GOOGLE_CLOUD_PROJECT is enough to build the
    // Gemini agent-platform sub-route too (same fallback this repo's own
    // Claude route already relies on).
    const router = createModelRouterFromEnv({ env: anthropicBaseline });
    expect(adapterFor(router, "gemini")).toBeDefined();
    expect(adapterFor(router, "anthropic")).toBeInstanceOf(ResilientClaudeAdapter);
  });

  it("leaves a bare Agent Platform adapter when nothing configures Gemini — not a wrapper that does nothing", () => {
    const router = createModelRouterFromEnv({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "karos-labs-prep" } });
    expect(adapterFor(router, "anthropic")).not.toBeInstanceOf(ResilientClaudeAdapter);
  });
});

describe("createModelRouterFromEnv — model-garden vendor adapter", () => {
  it("builds a model-garden adapter when MODEL_GARDEN_PROJECT_ID is set", () => {
    const router = createModelRouterFromEnv({
      env: { ...anthropicBaseline, MODEL_GARDEN_PROJECT_ID: "karos-labs-prep" },
    });
    expect(adapterFor(router, "model-garden")).toBeDefined();
  });

  it("leaves the model-garden adapter undefined when nothing configures it", () => {
    const router = createModelRouterFromEnv({ env: anthropicBaseline });
    expect(adapterFor(router, "model-garden")).toBeUndefined();
  });

  it("does NOT fall back to GOOGLE_CLOUD_PROJECT — setting only that leaves the model-garden adapter undefined", () => {
    // GOOGLE_CLOUD_PROJECT is exactly what anthropicBaseline sets, and it's
    // enough to build the Anthropic and Gemini agent-platform adapters, but
    // model-garden is deliberately opt-in only via its own project id
    // (create-model-router-from-env.ts's own doc comment on this).
    const router = createModelRouterFromEnv({ env: anthropicBaseline });
    expect(adapterFor(router, "model-garden")).toBeUndefined();

    return expect(
      router.complete("classify this", OutputSchema, {
        policy: "commodity",
        model: "meta/llama-3.1-70b-instruct-maas",
        vendor: "model-garden",
      }),
    ).rejects.toThrow(/MODEL_GARDEN_PROJECT_ID/);
  });
});
