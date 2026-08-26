import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { describeError, logError, logWarning } from "@agent-engine/telemetry";

/**
 * Service-to-service authentication for the agent-engine HTTP surface (AU1 /
 * SCRUM-287).
 *
 * This deliberately mirrors `agent-middleware`'s `app/security.py` rather than
 * inventing a second vocabulary for the same job: the same two ways in (Google
 * OIDC in deployed environments, a static bearer token for local development
 * that is refused outright in production), the same `CallerIdentity`
 * `{subject, email, method}` shape, and the same
 * `enabled`/`audience`/`allowedServiceAccounts`/`devToken` configuration axes.
 * Two services in one system with two different auth models is a cost we would
 * be choosing for no benefit.
 *
 * ## Why the audience check is not optional
 *
 * Verifying only the signature proves nothing useful: Google will issue a
 * valid, correctly-signed identity token to *any* account on *any* project. The
 * `aud` claim is what binds a token to this specific service, so a token minted
 * for something else cannot be replayed here. When authentication is enabled
 * without an audience configured this middleware fails the request closed (500)
 * rather than verifying without one.
 *
 * ## What this does NOT do: tenant entitlement
 *
 * This authenticates the CALLER, not the tenant. The only caller today is the
 * karosCMO portal, whose single service account legitimately acts on behalf of
 * every client — so a verified identity proves "the portal called me" and says
 * nothing about whether this particular request is legitimately for the
 * `clientSlug` it names. `clientSlug` remains a caller-asserted value that this
 * service trusts, exactly as before; the portal is responsible for its own
 * end-user authorization.
 *
 * Closing that gap needs the portal to forward an end-user-scoped claim (or
 * per-tenant service accounts) and is tracked separately — it is a cross-repo
 * change, not something this middleware can do alone. Do not read the presence
 * of authentication here as tenant isolation: below this layer, isolation is
 * structural (`sanitizeSegment`, the write-fence, tenant-free tool schemas),
 * and that is still what actually confines a run to one client's data.
 */
export interface CallerIdentity {
  /** The token's `sub` claim, or a fixed marker for the non-OIDC methods. */
  subject: string;
  /** The token's `email` claim — the calling service account. Absent for the dev-token and disabled paths. */
  email: string | undefined;
  method: "oidc" | "dev_token" | "disabled";
}

/** The caller attached to every request when authentication is switched off, so handlers never branch on `undefined`. */
export const ANONYMOUS_CALLER: CallerIdentity = { subject: "anonymous", email: undefined, method: "disabled" };

/** The subset of an OIDC token's claims this service reads. */
export interface VerifiedTokenClaims {
  sub?: string | undefined;
  email?: string | undefined;
}

/**
 * Verifies a Google-issued OIDC token against an expected audience, resolving
 * with its claims and rejecting on any verification failure. Injected rather
 * than constructed here, matching `VerifyPushIdToken` and every other
 * real-client dependency in this app: the real implementation
 * (`google-auth-library`) is built once at `server.ts`'s composition root, and
 * tests inject a fake that never makes a network call.
 */
export type VerifyIdToken = (idToken: string, audience: string) => Promise<VerifiedTokenClaims>;

export interface ServiceIdentityConfig {
  /** Master switch. When false every request is let through as `ANONYMOUS_CALLER` — the local-development and existing-test default. */
  enabled: boolean;
  /** This service's own URL, the only value a token's `aud` may carry. Required whenever `enabled` is true and the dev token is not in play. */
  audience?: string | undefined;
  /**
   * Service-account emails permitted to call. Empty means "any identity Google
   * vouches for for this audience", which is only safe because Cloud Run IAM
   * (`roles/run.invoker`) already restricts who can reach the service at all —
   * the normal deployment. Populate it for defence in depth.
   */
  allowedServiceAccounts: readonly string[];
  /** Development convenience for curl and local portals. Ignored outright when `isProduction` is true. */
  devToken?: string | undefined;
  /** Derived from `FIRESTORE_DATABASE_ID`, the same prep/prod signal the tracer already uses. Gates the dev-token path. */
  isProduction: boolean;
  verifyIdToken?: VerifyIdToken | undefined;
}

/** Express augments `Request` per-app; this app attaches the authenticated caller so handlers and logs can name who acted without re-parsing the header. */
export interface RequestWithCaller extends Request {
  caller?: CallerIdentity;
}

function unauthorized(res: Response, detail: string): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: detail });
}

/** Constant-time comparison that also tolerates differing lengths (`timingSafeEqual` throws on those). */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Builds the authentication middleware. Mount it AFTER the health route (a
 * liveness probe carries no credentials) and after the Pub/Sub push route,
 * which authenticates against a different audience — its own endpoint URL,
 * which is what Pub/Sub mints push tokens for — and would fail this check.
 */
export function createServiceIdentityMiddleware(config: ServiceIdentityConfig): RequestHandler {
  const devTokenPermitted = config.devToken !== undefined && config.devToken.length > 0 && !config.isProduction;

  return async (req: RequestWithCaller, res: Response, next: NextFunction): Promise<void> => {
    if (!config.enabled) {
      req.caller = ANONYMOUS_CALLER;
      next();
      return;
    }

    const bearer = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer) {
      unauthorized(res, "missing bearer token");
      return;
    }

    if (devTokenPermitted && tokensMatch(bearer, config.devToken as string)) {
      req.caller = { subject: "dev-token", email: undefined, method: "dev_token" };
      next();
      return;
    }
    // A non-matching token may still be a real OIDC token — fall through.

    if (!config.audience) {
      // Refusing is the safe direction: verifying without an audience would
      // accept any Google-signed token in existence (see the module docstring).
      logError("AUTH_ENABLED is set but AUTH_AUDIENCE is not configured; refusing to verify tokens without an audience to bind them to this service");
      res.status(500).json({ error: "service authentication is misconfigured" });
      return;
    }
    if (!config.verifyIdToken) {
      logError("AUTH_ENABLED is set but no token verifier was wired at the composition root");
      res.status(500).json({ error: "service authentication is misconfigured" });
      return;
    }

    let claims: VerifiedTokenClaims;
    try {
      claims = await config.verifyIdToken(bearer, config.audience);
    } catch (err) {
      // The reason stays server-side: a verification failure detail tells an
      // unauthenticated caller which part of their forgery was wrong.
      logWarning(`rejected an identity token: ${describeError(err)}`);
      unauthorized(res, "invalid identity token");
      return;
    }

    const email = claims.email;
    if (config.allowedServiceAccounts.length > 0 && (email === undefined || !config.allowedServiceAccounts.includes(email))) {
      logWarning(`caller ${email ?? "(no email claim)"} is not in the service-account allowlist`);
      res.status(403).json({ error: "caller is not authorized to use this service" });
      return;
    }

    req.caller = { subject: claims.sub ?? "unknown", email, method: "oidc" };
    next();
  };
}
