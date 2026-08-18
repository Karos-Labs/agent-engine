import { describe, expect, it } from "vitest";
import { assertHttpUrl, RenderCheckInputSchema } from "../src/render-check/render-check-tool.js";

/**
 * These tests exercise only the Chromium-free half of `landing.renderCheck`
 * (URL validation + schema defaults) — actually launching Chromium against a
 * live dev server is an integration/e2e concern, same posture as
 * `publish.renderCarousel`'s own test suite.
 */
describe("assertHttpUrl", () => {
  it("accepts a well-formed http URL", () => {
    expect(assertHttpUrl("http://localhost:3005").protocol).toBe("http:");
  });

  it("accepts a well-formed https URL", () => {
    expect(assertHttpUrl("https://preview.example.com").protocol).toBe("https:");
  });

  it("refuses a malformed URL", () => {
    expect(() => assertHttpUrl("not a url")).toThrow(/well-formed URL/);
  });

  it("refuses a file:// URL", () => {
    expect(() => assertHttpUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
  });

  it("refuses a javascript: URL", () => {
    expect(() => assertHttpUrl("javascript:alert(1)")).toThrow(/http\(s\)/);
  });
});

describe("RenderCheckInputSchema", () => {
  it("defaults to the @390 mobile + @1280 desktop breakpoints and a luminance floor of 20", () => {
    const parsed = RenderCheckInputSchema.parse({ baseUrl: "http://localhost:3005" });
    expect(parsed.path).toBe("/");
    expect(parsed.breakpoints).toEqual([
      { label: "mobile", width: 390, height: 844 },
      { label: "desktop", width: 1280, height: 800 },
    ]);
    expect(parsed.minOpenerLuminance).toBe(20);
  });

  it("accepts a custom breakpoint list", () => {
    const parsed = RenderCheckInputSchema.parse({ baseUrl: "http://localhost:3005", breakpoints: [{ label: "tablet", width: 768, height: 1024 }] });
    expect(parsed.breakpoints).toHaveLength(1);
  });
});
