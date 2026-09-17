import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_LOGO_MAX_BYTES,
  describeBrandLogoFailure,
  downloadBrandLogo,
  downloadBrandLogoOutcome,
  type BrandLogoFailureReason,
} from "@agent-engine/tool-karos-media";

/**
 * Phase 5.5, item F1 — **the logo failure names itself.**
 *
 * The owner, 2026-09-16: *"there is their logo at the top, which is
 * excellent"* — and it rendered for exactly one of three clients. karoslabs
 * and thepitchbydeel showed only their `@handle`, although karoslabs' brand
 * kit carries a `logoUrl`. The only thing the gate payload could say was
 * `assessBrandAssetPresence`'s four-way disjunction: *"bad status, wrong
 * content-type, over the size cap, or a network error"* — six distinct
 * refusals inside `downloadBrandLogo` collapsed into one bare `undefined`, so
 * nobody could tell an expired Firebase token from a size cap we chose.
 *
 * Each case below is one of those six, and each asserts the DETAIL as well as
 * the reason, because the detail is the half that turns a report into a fix:
 * "HTTP 403" is re-upload the asset, "2,410,112 bytes > 4,000,000" is export
 * the mark instead of a screenshot of it.
 *
 * The two live candidates for karoslabs are pinned as their own cases: its
 * `logoUrl` is a Firebase Storage `Screenshot_2026-07-10_124752.png` behind
 * an `alt=media&token=` query, so the suspects are the old 1.5MB cap and an
 * `application/octet-stream` content type. This suite is what makes the next
 * prep run answer that in one line instead of by hand.
 */

function fakeFetch(response: {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  bytes?: Uint8Array;
  contentLength?: string;
}): typeof fetch {
  return (async () => ({
    ok: response.ok ?? true,
    status: response.status ?? (response.ok === false ? 500 : 200),
    headers: {
      get: (name: string) =>
        name === "content-type" ? (response.contentType === undefined ? "image/png" : response.contentType) : name === "content-length" ? (response.contentLength ?? null) : null,
    },
    arrayBuffer: async () => (response.bytes ?? new Uint8Array([1, 2, 3])).buffer,
  })) as unknown as typeof fetch;
}

const URL_OK = "https://firebasestorage.googleapis.com/v0/b/karos/o/Screenshot_2026-07-10_124752.png?alt=media&token=abc";

async function refusal(f: typeof fetch, url = URL_OK): Promise<{ reason: BrandLogoFailureReason; detail: string }> {
  const outcome = await downloadBrandLogoOutcome(f, url);
  if (outcome.ok) throw new Error("expected a refusal, got a download");
  return { reason: outcome.reason, detail: outcome.detail };
}

describe("downloadBrandLogoOutcome names which of the six refusals fired, and what it measured", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an HTTP failure carries the status", async () => {
    expect(await refusal(fakeFetch({ ok: false, status: 403 }))).toEqual({ reason: "http-status", detail: "HTTP 403" });
    expect((await refusal(fakeFetch({ ok: false, status: 404 }))).detail).toBe("HTTP 404");
  });

  it("a content type outside the whitelist carries the type, unparsed", async () => {
    expect(await refusal(fakeFetch({ contentType: "text/html" }))).toEqual({ reason: "content-type", detail: "content-type: text/html" });
    // karoslabs' live candidate: a storage bucket serving the bytes untyped.
    expect(await refusal(fakeFetch({ contentType: "application/octet-stream" }))).toEqual({
      reason: "content-type",
      detail: "content-type: application/octet-stream",
    });
    expect((await refusal(fakeFetch({ contentType: null }))).detail).toBe("content-type: (absent)");
  });

  it("an over-size body carries the two numbers, grouped", async () => {
    const tooBig = new Uint8Array(BRAND_LOGO_MAX_BYTES + 1);
    const { reason, detail } = await refusal(fakeFetch({ bytes: tooBig }));
    expect(reason).toBe("too-large");
    expect(detail).toBe("4,000,001 bytes > 4,000,000");
  });

  it("a declared content-length past the cap is refused before the body is read", async () => {
    const { reason, detail } = await refusal(fakeFetch({ contentLength: "9000000" }));
    expect(reason).toBe("too-large");
    expect(detail).toBe("content-length 9,000,000 bytes > 4,000,000");
  });

  it("an empty body and a thrown fetch are their own reasons", async () => {
    expect(await refusal(fakeFetch({ bytes: new Uint8Array(0) }))).toEqual({ reason: "empty", detail: "the response body was 0 bytes" });
    const throwing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await refusal(throwing)).toEqual({ reason: "network", detail: "ECONNRESET" });
  });

  it("a non-https URL is its own reason, and still warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reason, detail } = await refusal(fakeFetch({}), "gs://karos-brand-assets/acme/logo.png");
    expect(reason).toBe("not-https");
    expect(detail).toContain("gs://karos-brand-assets/acme/logo.png");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("every refusal produces a sentence a reviewer can act on", async () => {
    const seen = new Set<BrandLogoFailureReason>();
    for (const f of [
      fakeFetch({ ok: false, status: 403 }),
      fakeFetch({ contentType: "application/octet-stream" }),
      fakeFetch({ bytes: new Uint8Array(BRAND_LOGO_MAX_BYTES + 1) }),
      fakeFetch({ bytes: new Uint8Array(0) }),
      (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    ]) {
      const outcome = await downloadBrandLogoOutcome(f, URL_OK);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      seen.add(outcome.reason);
      const sentence = describeBrandLogoFailure(outcome, URL_OK);
      expect(sentence).toContain(URL_OK);
      expect(sentence).toContain(outcome.detail);
      // A remedy, not just a diagnosis: every sentence tells the reader what
      // to do next.
      expect(sentence.length).toBeGreaterThan(outcome.detail.length + 40);
    }
    expect(seen.size).toBe(5);
  });
});

describe("the size cap and the whitelist, raised to fit what clients actually upload", () => {
  it("a 2MB PNG — a screenshot-sized logo — now SUCCEEDS where the old 1.5MB cap refused it", () => {
    const twoMb = 2_000_000;
    // The premise: this is the size that used to fail. If the cap ever drops
    // back under it, this line is what says so.
    expect(twoMb).toBeGreaterThan(1_500_000);
    expect(twoMb).toBeLessThan(BRAND_LOGO_MAX_BYTES);
  });

  it("2MB downloads and 5MB does not", async () => {
    const two = await downloadBrandLogoOutcome(fakeFetch({ bytes: new Uint8Array(2_000_000) }), URL_OK);
    expect(two.ok).toBe(true);
    const five = await downloadBrandLogoOutcome(fakeFetch({ bytes: new Uint8Array(5_000_000) }), URL_OK);
    expect(five.ok).toBe(false);
  });

  it("AVIF is accepted alongside PNG, JPEG, WebP and SVG", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/avif"]) {
      const outcome = await downloadBrandLogoOutcome(fakeFetch({ contentType: `${mime}; charset=utf-8` }), URL_OK);
      expect(outcome.ok, mime).toBe(true);
      if (outcome.ok) expect(outcome.download.mime).toBe(mime);
    }
  });
});

describe("downloadBrandLogo stays the fail-open wrapper every existing caller was written against", () => {
  it("returns the bytes on success and `undefined` on every refusal, exactly as before", async () => {
    expect((await downloadBrandLogo(fakeFetch({}), URL_OK))?.mime).toBe("image/png");
    expect(await downloadBrandLogo(fakeFetch({ ok: false, status: 403 }), URL_OK)).toBeUndefined();
    expect(await downloadBrandLogo(fakeFetch({ contentType: "text/html" }), URL_OK)).toBeUndefined();
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await downloadBrandLogo(throwing, URL_OK)).toBeUndefined();
  });
});
