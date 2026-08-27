import { describe, expect, it } from "vitest";
import { resolveModelPolicy } from "../src/router/step-model-policy.js";
import type { ModelPolicy } from "../src/types/model-policy.js";

const defaultPolicy: ModelPolicy = { policy: "pinned", model: "claude-sonnet-4-6" };

describe("resolveModelPolicy", () => {
  it("returns defaultPolicy completely unchanged when no override env vars are set", () => {
    const resolved = resolveModelPolicy("blog-draft", defaultPolicy, { env: {} });
    expect(resolved).toBe(defaultPolicy);
  });

  it("returns defaultPolicy unchanged when the relevant env vars are simply absent from the object", () => {
    const resolved = resolveModelPolicy("blog-draft", defaultPolicy, { env: { SOME_OTHER_VAR: "x" } });
    expect(resolved).toEqual(defaultPolicy);
  });

  it("overrides both vendor and model together", () => {
    const resolved = resolveModelPolicy("blog-draft", defaultPolicy, {
      env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "gemini", MODEL_STEP_BLOG_DRAFT_MODEL: "gemini-2.5-pro" },
    });
    expect(resolved).toEqual({ policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" });
  });

  it("overrides just the model, leaving defaultPolicy's vendor (absent) as-is", () => {
    const resolved = resolveModelPolicy("blog-draft", defaultPolicy, {
      env: { MODEL_STEP_BLOG_DRAFT_MODEL: "claude-opus-4-8" },
    });
    expect(resolved).toEqual({ policy: "pinned", model: "claude-opus-4-8" });
    expect(resolved.vendor).toBeUndefined();
  });

  it("overrides just the model, preserving an already-set vendor on defaultPolicy", () => {
    const withVendor: ModelPolicy = { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" };
    const resolved = resolveModelPolicy("blog-draft", withVendor, {
      env: { MODEL_STEP_BLOG_DRAFT_MODEL: "gemini-2.5-flash" },
    });
    expect(resolved).toEqual({ policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" });
  });

  it("throws a specific error naming both env vars when VENDOR is set without MODEL", () => {
    expect(() =>
      resolveModelPolicy("blog-draft", defaultPolicy, { env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "gemini" } }),
    ).toThrow(/MODEL_STEP_BLOG_DRAFT_VENDOR/);
    expect(() =>
      resolveModelPolicy("blog-draft", defaultPolicy, { env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "gemini" } }),
    ).toThrow(/MODEL_STEP_BLOG_DRAFT_MODEL/);
  });

  it("throws an error listing the valid vendors when VENDOR is an unrecognized value", () => {
    expect(() =>
      resolveModelPolicy("blog-draft", defaultPolicy, {
        env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "bedrock", MODEL_STEP_BLOG_DRAFT_MODEL: "some-model" },
      }),
    ).toThrow(/not a known vendor/);
    expect(() =>
      resolveModelPolicy("blog-draft", defaultPolicy, {
        env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "bedrock", MODEL_STEP_BLOG_DRAFT_MODEL: "some-model" },
      }),
    ).toThrow(/anthropic, gemini, model-garden, openai-compatible/);
  });

  it("derives the env-var prefix from the step id, uppercasing and swapping hyphens for underscores", () => {
    const resolved = resolveModelPolicy("reputation-extraction", defaultPolicy, {
      env: {
        MODEL_STEP_REPUTATION_EXTRACTION_VENDOR: "model-garden",
        MODEL_STEP_REPUTATION_EXTRACTION_MODEL: "meta/llama-3.3-70b-instruct-maas",
      },
    });
    expect(resolved).toEqual({ policy: "pinned", model: "meta/llama-3.3-70b-instruct-maas", vendor: "model-garden" });
  });

  it("collapses non-alphanumeric runs in the step id into a single underscore, and trims leading/trailing ones", () => {
    const resolved = resolveModelPolicy("x--draft.v2", defaultPolicy, {
      env: { MODEL_STEP_X_DRAFT_V2_MODEL: "claude-opus-4-8" },
    });
    expect(resolved).toEqual({ policy: "pinned", model: "claude-opus-4-8" });
  });

  it("treats an empty-string env var value as unset, same as `readEnv`'s convention elsewhere in this system", () => {
    const resolved = resolveModelPolicy("blog-draft", defaultPolicy, {
      env: { MODEL_STEP_BLOG_DRAFT_VENDOR: "", MODEL_STEP_BLOG_DRAFT_MODEL: "" },
    });
    expect(resolved).toBe(defaultPolicy);
  });

  it("defaults to process.env when no env option is passed", () => {
    const original = process.env["MODEL_STEP_BLOG_DRAFT_MODEL"];
    process.env["MODEL_STEP_BLOG_DRAFT_MODEL"] = "claude-opus-4-8";
    try {
      const resolved = resolveModelPolicy("blog-draft", defaultPolicy);
      expect(resolved.model).toBe("claude-opus-4-8");
    } finally {
      if (original === undefined) delete process.env["MODEL_STEP_BLOG_DRAFT_MODEL"];
      else process.env["MODEL_STEP_BLOG_DRAFT_MODEL"] = original;
    }
  });
});
