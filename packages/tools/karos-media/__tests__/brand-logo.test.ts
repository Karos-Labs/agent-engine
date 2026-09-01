import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_LOGO_MAX_BYTES, brandLogoDataUri, downloadBrandLogo } from "../src/brand-logo.js";

function fakeFetch(response: { ok?: boolean; contentType?: string; bytes?: Uint8Array; contentLength?: string }): typeof fetch {
  return (async () => ({
    ok: response.ok ?? true,
    headers: {
      get: (name: string) =>
        name === "content-type" ? (response.contentType ?? null) : name === "content-length" ? (response.contentLength ?? null) : null,
    },
    arrayBuffer: async () => (response.bytes ?? new Uint8Array([1, 2, 3])).buffer,
  })) as unknown as typeof fetch;
}

describe("downloadBrandLogo", () => {
  it("accepts an SVG — the format real client logos usually are, which the hero downloader deliberately refuses", async () => {
    const result = await downloadBrandLogo(fakeFetch({ contentType: "image/svg+xml; charset=utf-8" }), "https://x.example/logo.svg");
    expect(result?.mime).toBe("image/svg+xml");
  });

  it.each(["image/png", "image/jpeg", "image/webp"])("accepts %s", async (mime) => {
    expect((await downloadBrandLogo(fakeFetch({ contentType: mime }), "https://x.example/logo"))?.mime).toBe(mime);
  });

  it("refuses a content type outside the whitelist", async () => {
    expect(await downloadBrandLogo(fakeFetch({ contentType: "text/html" }), "https://x.example/logo")).toBeUndefined();
    expect(await downloadBrandLogo(fakeFetch({ contentType: "application/octet-stream" }), "https://x.example/logo")).toBeUndefined();
  });

  it("refuses a non-https url outright", async () => {
    expect(await downloadBrandLogo(fakeFetch({ contentType: "image/png" }), "http://x.example/logo.png")).toBeUndefined();
    expect(await downloadBrandLogo(fakeFetch({ contentType: "image/png" }), "gs://bucket/logo.png")).toBeUndefined();
  });

  // SCRUM-383: this refusal used to be a bare `return undefined` on this
  // function's first line — no diagnostic at all, indistinguishable from
  // every other reason a download can fail. It must now emit SOMETHING,
  // so a caller that reaches this function directly with an unfiltered URL
  // (rather than going through `deriveBrandRenderTokens`, which rejects a
  // gs:// URL before it gets here and reports why through its own trace)
  // still leaves a trace of what happened, instead of silence.
  describe("the non-https refusal (SCRUM-383)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("emits a diagnostic rather than returning silently", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await downloadBrandLogo(fakeFetch({ contentType: "image/png" }), "gs://bucket/logo.png");
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("gs://bucket/logo.png");
      expect(warn.mock.calls[0]?.[0]).toMatch(/https/i);
    });

    it("never warns for an accepted https:// url, even on a subsequent unrelated failure", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await downloadBrandLogo(fakeFetch({ contentType: "text/html" }), "https://x.example/logo.png");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("refuses a body over the size cap, whatever the header claimed", async () => {
    const big = new Uint8Array(BRAND_LOGO_MAX_BYTES + 1);
    expect(await downloadBrandLogo(fakeFetch({ contentType: "image/png", bytes: big, contentLength: "10" }), "https://x.example/l.png")).toBeUndefined();
  });

  it("refuses an empty body and a failed response, and swallows a thrown fetch", async () => {
    expect(await downloadBrandLogo(fakeFetch({ contentType: "image/png", bytes: new Uint8Array(0) }), "https://x.example/l.png")).toBeUndefined();
    expect(await downloadBrandLogo(fakeFetch({ ok: false, contentType: "image/png" }), "https://x.example/l.png")).toBeUndefined();
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await downloadBrandLogo(throwing, "https://x.example/l.png")).toBeUndefined();
  });
});

describe("brandLogoDataUri", () => {
  it("builds a data URI whose base64 payload can never collide with a {{slot}}", () => {
    const uri = brandLogoDataUri({ bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png" });
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(uri).not.toContain("{{");
  });
});
