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

/** The one OAuth scope the GBP APIs accept. Write-capable — there is no read-only GBP scope; the karos-connectors allowlist is the read fence. */
export const GBP_OAUTH_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Mints an access token in `GBP_OAUTH_SCOPE` from the deployment's own identity, or `undefined` when it cannot. May throw; the resolver turns that into a reason. */
export type GbpAccessTokenProvider = () => Promise<string | undefined>;

export type GbpCredential = { ok: true; token: string; source: "env" | "adc" } | { ok: false; reason: string };

/**
 * `GOOGLE_BUSINESS_TOKEN` wins when set — an operator who pasted a user token
 * meant it. Otherwise the ADC provider is asked, once. Every failure mode ends
 * in one sentence that starts with the env name every existing tombstone,
 * test and runbook already greps for, followed by what the fallback said.
 */
export async function resolveGbpCredential(
  env: Readonly<Record<string, string | undefined>>,
  accessToken: GbpAccessTokenProvider | undefined,
): Promise<GbpCredential> {
  const fromEnv = env["GOOGLE_BUSINESS_TOKEN"];
  if (fromEnv) return { ok: true, token: fromEnv, source: "env" };

  if (accessToken === undefined) {
    return {
      ok: false,
      reason: "missing env GOOGLE_BUSINESS_TOKEN, and no Application Default Credentials provider is wired in this deployment to mint a business.manage token instead",
    };
  }
  try {
    const token = await accessToken();
    if (!token) {
      return {
        ok: false,
        reason: "missing env GOOGLE_BUSINESS_TOKEN, and Application Default Credentials returned no business.manage token",
      };
    }
    return { ok: true, token, source: "adc" };
  } catch (err) {
    return {
      ok: false,
      reason: `missing env GOOGLE_BUSINESS_TOKEN, and Application Default Credentials could not mint a business.manage token (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
