import { describe, expect, it, vi } from "vitest";
import { looksLikeRefreshToken, resolveGbpCredential, type GbpExchangeFetch } from "../src/capture/gbp-credential.js";

/**
 * The third shape `GOOGLE_BUSINESS_TOKEN` actually arrived in.
 *
 * `gbp-credential.ts` was written for two sources — a pasted user ACCESS token,
 * else the worker's own ADC — with the env value winning because "an operator
 * who pasted a user token meant it". What got pasted, in both projects, is a
 * REFRESH token (`1//…`), which the GBP API rejects as a bearer. So filling the
 * variable in would have taken away the ADC fallback and replaced it with a
 * guaranteed 401: strictly worse than leaving it empty.
 *
 * The property that matters most here is therefore the LAST one: an unusable
 * paste must never cost a deployment a credential that works.
 */

const REFRESH = "1//04jSomeRefreshTokenValue";
const ACCESS = "ya29.a0SomePastedAccessToken";
const MINTED = "ya29.a0MintedFromRefreshToken";
const ADC = "ya29.a0FromServiceAccount";

const withClient = { GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csec" };
const adcProvider = async () => ADC;

function tokenEndpoint(body: unknown, status = 200): GbpExchangeFetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as GbpExchangeFetch;
}

describe("looksLikeRefreshToken", () => {
  it("recognises Google's documented refresh-token prefix and nothing else", () => {
    expect(looksLikeRefreshToken(REFRESH)).toBe(true);
    expect(looksLikeRefreshToken(ACCESS)).toBe(false);
    expect(looksLikeRefreshToken("")).toBe(false);
  });
});

describe("resolveGbpCredential, with a refresh token in the env var", () => {
  it("still prefers a pasted ACCESS token verbatim, exchanging nothing", async () => {
    const fetchImpl = tokenEndpoint({ access_token: MINTED });
    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: ACCESS }, adcProvider, fetchImpl);
    expect(out).toEqual({ ok: true, token: ACCESS, source: "env" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exchanges a refresh token and uses the MINTED token, never the stored one", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: MINTED }), { status: 200 });
    }) as GbpExchangeFetch;

    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: REFRESH, ...withClient }, adcProvider, fetchImpl);

    expect(out).toEqual({ ok: true, token: MINTED, source: "env-exchanged" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const body = String(calls[0]!.init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=cid");
  });

  it("FALLS BACK TO ADC when the OAuth app is not configured — the paste must not cost a working credential", async () => {
    const fetchImpl = tokenEndpoint({ access_token: MINTED });
    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: REFRESH }, adcProvider, fetchImpl);
    expect(out).toEqual({ ok: true, token: ADC, source: "adc" });
    expect(fetchImpl, "with no client id/secret there is nothing to exchange with").not.toHaveBeenCalled();
  });

  it("falls back to ADC when Google refuses the exchange — 401 unauthorized_client is the crossed-clients case", async () => {
    const fetchImpl = tokenEndpoint({ error: "unauthorized_client" }, 401);
    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: REFRESH, ...withClient }, adcProvider, fetchImpl);
    expect(out).toEqual({ ok: true, token: ADC, source: "adc" });
  });

  it("when BOTH the exchange and ADC fail, the reason names the refresh token AND the ADC failure", async () => {
    const fetchImpl = tokenEndpoint({ error: "invalid_grant" }, 400);
    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: REFRESH, ...withClient }, async () => undefined, fetchImpl);

    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toContain("GOOGLE_BUSINESS_TOKEN");
    expect(out.reason).toContain("refresh token");
    expect(out.reason).toContain("HTTP 400");
    expect(out.reason).toContain("Application Default Credentials");
  });

  it("names the missing OAuth variables when the exchange is impossible and no ADC provider is wired", async () => {
    const out = await resolveGbpCredential({ GOOGLE_BUSINESS_TOKEN: REFRESH }, undefined, tokenEndpoint({}));
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(out.reason).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("keeps the original no-credential wording when the variable is simply absent", async () => {
    // Existing tombstones, tests and runbooks grep for this sentence.
    const out = await resolveGbpCredential({}, undefined, tokenEndpoint({}));
    if (out.ok) throw new Error("expected a refusal");
    expect(out.reason).toMatch(/^missing env GOOGLE_BUSINESS_TOKEN/);
  });
});
