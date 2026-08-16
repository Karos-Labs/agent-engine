import { describe, expect, it } from "vitest";
import { DefaultModelRouter, createModelRouterFromEnv } from "../src/index.js";

describe("createModelRouterFromEnv", () => {
  it("throws a clear error when ANTHROPIC_API_KEY is missing", () => {
    expect(() => createModelRouterFromEnv({ env: {} })).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("constructs a real DefaultModelRouter when ANTHROPIC_API_KEY is present", () => {
    // Only construction is exercised here — no network call happens just by
    // instantiating the SDK client, so this stays fully offline.
    const router = createModelRouterFromEnv({ env: { ANTHROPIC_API_KEY: "sk-ant-test-key" } });
    expect(router).toBeInstanceOf(DefaultModelRouter);
  });

  it("still constructs successfully when an OPENAI_COMPATIBLE_BASE_URL is also configured", () => {
    const router = createModelRouterFromEnv({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        OPENAI_COMPATIBLE_BASE_URL: "https://litellm.internal.example.com",
        OPENAI_COMPATIBLE_API_KEY: "sk-gateway-test-key",
      },
    });
    expect(router).toBeInstanceOf(DefaultModelRouter);
  });
});
