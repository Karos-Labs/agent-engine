import { describe, expect, it } from "vitest";
import { describeError } from "../src/index.js";

describe("describeError", () => {
  it("returns the message alone when there is no cause", () => {
    expect(describeError(new Error("disk on fire"))).toBe("disk on fire");
  });

  it("preserves a single-level cause (RFC-01 §16.4)", () => {
    const networkError = new Error("ECONNRESET");
    const wrapped = new Error("fetch failed", { cause: networkError });
    expect(describeError(wrapped)).toBe("fetch failed (cause: ECONNRESET)");
  });

  it("walks a multi-level cause chain, not just one level", () => {
    const root = new Error("socket hang up");
    const middle = new Error("fetch failed", { cause: root });
    const top = new Error("tool call failed", { cause: middle });
    expect(describeError(top)).toBe("tool call failed (cause: fetch failed (cause: socket hang up))");
  });

  it("stringifies a non-Error cause rather than dropping it", () => {
    const wrapped = new Error("upstream rejected", { cause: { code: 503 } });
    expect(describeError(wrapped)).toBe('upstream rejected (cause: [object Object])');
  });

  it("stringifies a thrown non-Error value", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(42)).toBe("42");
  });
});
