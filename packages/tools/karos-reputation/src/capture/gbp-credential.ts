/**
 * The Google Business Profile credential, resolved once per call from the two
 * places it can come from.
 *
 * ## Why two sources
 *
 * Until 2026-09-06 the GBP legs (`reputation.capture`'s `gbp` adapter and
 * `reputation.discoverGbpLocations`) read exactly one thing: `GOOGLE_BUSINESS_TOKEN`,
 * a user OAuth access token someone had to mint and paste into the worker's
 * environment. Nobody ever did — neither prep nor prod worker carries it — so
 * every Google leg on every client's pulse was an UNAVAILABLE tombstone and
 * every Google surface in setup was "skipped: missing env GOOGLE_BUSINESS_TOKEN".
 *
 * The engine already runs as a Google service account with Application
 * Default Credentials, and the GBP APIs accept a service-account token in the
 * `business.manage` scope exactly like a user's — for the Business Profiles
 * that account has been added to as a manager. So when the env token is
 * absent the legs now ask the deployment's ADC for one, and the credential
 * gap that remains is a human one ("add the service account as a manager of
 * this client's profile"), stated in the tombstone as such.
 *
 * ## What this package deliberately does NOT hold
 *
 * No `google-auth-library` import. The composition root (`apps/agent-server`'s
 * `wiring/tools.ts`) mints the token and hands a `GbpAccessTokenProvider`
 * in — the same shape `vertexAuthorize`/`synthesizeVoice.authorize` already
 * use for the two other ADC-backed capabilities, and for the same reason: a
 * tool package should hold a header minter's TYPE, never a credential or the
 * library that finds one. Tests pass a stub provider; a composition with none
 * (the golden-fixture tests, a laptop with no ADC) reports the gap honestly.
 */

/**
 * ## A third shape the env var can arrive in (2026-09-07)
 *
 * The doc above calls `GOOGLE_BUSINESS_TOKEN` "a user OAuth access token
 * someone had to mint and paste". One was pasted — and it is a REFRESH token
 * (1//…), in both projects. That matters more than it sounds, because the env
 * value WINS over ADC by design ("an operator who pasted a user token meant
 * it"): a refresh token sent as a bearer earns 401 "Expected OAuth 2 access
 * token", so filling this variable in would have DISABLED the working ADC
 * fallback this module exists to provide.
 *
 * A refresh token is also the only Google credential durable enough to sit in
 * Secret Manager — an access token expires within the hour — so it is the
 * sensible thing for a person to store, and the resolver is what has to cope.
 * It is exchanged here, per call, persisted nowhere, exactly as
 * `karos-connectors/src/access-token.ts` does for Search Console and GA4.
 *
 * When that exchange cannot be made (no GOOGLE_OAUTH_CLIENT_ID /
 * GOOGLE_OAUTH_CLIENT_SECRET, or Google refuses them) the resolver does NOT
 * fail: it falls through to ADC, and mentions the exchange failure only if ADC
 * fails too. An unusable paste must never cost a deployment a credential that
 * works.
 */

/** The one OAuth scope the GBP APIs accept. Write-capable — there is no read-only GBP scope; the karos-connectors allowlist is the read fence. */
export const GBP_OAUTH_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Mints an access token in `GBP_OAUTH_SCOPE` from the deployment's own identity, or `undefined` when it cannot. May throw; the resolver turns that into a reason. */
export type GbpAccessTokenProvider = () => Promise<string | undefined>;

export type GbpCredential = { ok: true; token: string; source: "env" | "env-exchanged" | "adc" } | { ok: false; reason: string };

/** The subset of `fetch` the exchange needs. Kept local so this package still imports no HTTP client. */
export type GbpExchangeFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Google issues refresh tokens with this prefix; access tokens (`ya29.…`) never carry it. */
const REFRESH_TOKEN_PREFIX = "1//";

export function looksLikeRefreshToken(value: string): boolean {
  return value.startsWith(REFRESH_TOKEN_PREFIX);
}

/**
 * Exchanges a pasted refresh token for a short-lived access token. Returns a
 * reason rather than throwing, because the caller's next move on any failure is
 * the same: try ADC instead.
 */
async function exchangeRefreshToken(
  refreshToken: string,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: GbpExchangeFetch | undefined,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"]?.trim();
  const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"]?.trim();
  if (!clientId || !clientSecret) {
    return { ok: false, reason: "GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET for the OAuth app that issued it are not set" };
  }
  if (!fetchImpl) {
    return { ok: false, reason: "no fetch implementation was supplied to exchange it with" };
  }
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  let response: Response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, reason: `the Google OAuth token endpoint could not be reached (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!response.ok) {
    // 400 invalid_grant is a revoked grant; 401 unauthorized_client means the
    // token belongs to a DIFFERENT OAuth app than the one configured — which is
    // what happened when these two secrets first arrived crossed between the
    // projects, and what no retry can fix.
    return { ok: false, reason: `the Google OAuth token endpoint returned HTTP ${response.status}` };
  }
  let token: unknown;
  try {
    token = ((await response.json()) as { access_token?: unknown }).access_token;
  } catch (err) {
    return { ok: false, reason: `the Google OAuth token endpoint returned a body that is not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "the Google OAuth token endpoint returned no access_token" };
  }
  return { ok: true, token };
}

/**
 * `GOOGLE_BUSINESS_TOKEN` wins when set — an operator who pasted a user token
 * meant it. Otherwise the ADC provider is asked, once. Every failure mode ends
 * in one sentence that starts with the env name every existing tombstone,
 * test and runbook already greps for, followed by what the fallback said.
 */
export async function resolveGbpCredential(
  env: Readonly<Record<string, string | undefined>>,
  accessToken: GbpAccessTokenProvider | undefined,
  fetchImpl?: GbpExchangeFetch,
): Promise<GbpCredential> {
  const fromEnv = env["GOOGLE_BUSINESS_TOKEN"]?.trim();
  let exchangeFailure: string | undefined;
  if (fromEnv && !looksLikeRefreshToken(fromEnv)) {
    return { ok: true, token: fromEnv, source: "env" };
  }
  if (fromEnv) {
    const exchanged = await exchangeRefreshToken(fromEnv, env, fetchImpl);
    if (exchanged.ok) return { ok: true, token: exchanged.token, source: "env-exchanged" };
    // Deliberately not a failure yet — ADC below is a real credential, and a
    // pasted token that cannot be exchanged must not take it away.
    exchangeFailure = exchanged.reason;
  }

  /** Every reason still opens with the env-name sentence existing tombstones, tests and runbooks grep for. */
  const lead = exchangeFailure
    ? `GOOGLE_BUSINESS_TOKEN holds a refresh token that could not be exchanged (${exchangeFailure})`
    : "missing env GOOGLE_BUSINESS_TOKEN";
  if (accessToken === undefined) {
    return {
      ok: false,
      reason: `${lead}, and no Application Default Credentials provider is wired in this deployment to mint a business.manage token instead`,
    };
  }
  try {
    const token = await accessToken();
    if (!token) {
      return { ok: false, reason: `${lead}, and Application Default Credentials returned no business.manage token` };
    }
    return { ok: true, token, source: "adc" };
  } catch (err) {
    return {
      ok: false,
      reason: `${lead}, and Application Default Credentials could not mint a business.manage token (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
