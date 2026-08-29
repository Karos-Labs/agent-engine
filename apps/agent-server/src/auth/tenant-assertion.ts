import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { describeError, logError, logWarning } from "@agent-engine/telemetry";

/**
 * Tenant entitlement at the engine edge (AU46 / SCRUM-329).
 *
 * `auth/service-identity.ts` (AU1 / SCRUM-287) authenticates the CALLER — it
 * proves "the portal called me" and says so explicitly in its own module
 * docstring (lines 27-42 there): "a verified identity proves the portal
 * called me and says nothing about whether this particular request is
 * legitimately for the `clientSlug` it names." `clientSlug` was, until this
 * change, a caller-asserted value this service trusted outright.
 *
 * Decision 9 of Tomer's 2026-08-28 decision record (SCRUM-333 comment
 * 10404) answers AU46's own question directly: **the portal signs a
 * per-request tenant assertion naming the client, and the engine verifies
 * it.** See `docs/decisions/AU46-tenant-identity.md` for the full reasoning
 * — this module is that decision's engine-side half.
 *
 * ## Wire format
 *
 * Header `X-Tenant-Assertion: <payload>.<signature>`, both segments
 * base64url. `payload` is the JSON-encoded `{clientSlug, iat, exp}` (unix
 * seconds, a short TTL — see `DEFAULT_TTL_SECONDS`); `signature` is
 * `HMAC-SHA256(payload_b64, secret)`. Deliberately NOT a full JWT: no header
 * segment, no algorithm negotiation, one fixed algorithm — the portal and
 * this service share a secret out of band (`TENANT_ASSERTION_SECRET`,
 * mirroring how `AUTH_DEV_TOKEN` is provisioned), so there is nothing to
 * negotiate and a smaller format is a smaller attack surface. `signTenantAssertion`
 * below is the reference implementation of the portal's half, kept here so
 * the two sides can never drift on the wire format even though they live in
 * separate repos.
 *
 * ## What "enforces... at the edge" means here
 *
 * This module only verifies the assertion's signature and expiry and
 * attaches the claimed tenant to the request (`req.tenantAssertion`). It does
 * NOT by itself compare that tenant against anything — every route that
 * accepts or resolves a `clientSlug` must call `enforceTenantEntitlement`
 * itself, because only the route knows what `clientSlug` the request is
 * actually targeting (the body, for `/runs/start`; the stored run record,
 * for every runId-addressed route). See `routes/runs.ts` and
 * `routes/deliverables.ts` for the call sites, and this module's own tests
 * plus `__tests__/tenant-assertion.test.ts` for the failure-mode proof.
 */

const HEADER_NAME = "x-tenant-assertion";
const DEFAULT_TTL_SECONDS = 300;

export interface TenantAssertion {
  clientSlug: string;
}

/** Express augments `Request` per-app, same pattern as `RequestWithCaller` in `service-identity.ts`. */
export interface RequestWithTenantAssertion extends Request {
  tenantAssertion?: TenantAssertion;
}

export interface TenantAssertionConfig {
  /** Master switch. When false every request passes through with no `tenantAssertion` attached — the pre-AU46 behaviour, and the existing-test default. */
  enabled: boolean;
  /** Shared secret with the portal. Required whenever `enabled` is true. */
  secret?: string | undefined;
  /** Injectable clock, unix seconds, for deterministic tests. */
  now?: () => number;
}

interface AssertionPayload {
  clientSlug: string;
  iat: number;
  exp: number;
}

export class TenantAssertionError extends Error {}

function b64urlEncode(input: Buffer): string {
  return input.toString("base64url");
}

function hmac(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

/**
 * Reference implementation of the PORTAL's half of this contract. Lives here
 * (rather than only in prose) so the wire format the engine verifies against
 * and the format a signer produces can never silently drift, and so this
 * module's own tests can construct valid assertions without hand-rolling the
 * format. The portal repo (karosCMO) is expected to port this function
 * verbatim — see the decision doc for the exact hand-off.
 */
export function signTenantAssertion(
  clientSlug: string,
  secret: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const iat = now();
  const payload: AssertionPayload = { clientSlug, iat, exp: iat + ttlSeconds };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sigB64 = b64urlEncode(hmac(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies a tenant assertion's signature and expiry, returning the tenant it
 * names. Throws `TenantAssertionError` on any failure — a bad signature, a
 * malformed payload, or an expired token are all the same "reject" outcome
 * to the caller (see `createTenantAssertionMiddleware`), same as
 * `service-identity.ts` collapses every OIDC verification failure to one
 * 401 rather than leaking which part was wrong.
 */
export function verifyTenantAssertion(token: string, secret: string, now: () => number = () => Math.floor(Date.now() / 1000)): TenantAssertion {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new TenantAssertionError("malformed tenant assertion: expected <payload>.<signature>");
  }
  const [payloadB64, sigB64] = parts as [string, string];

  const expectedSig = hmac(payloadB64, secret);
  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, "base64url");
  } catch {
    throw new TenantAssertionError("malformed tenant assertion signature encoding");
  }
  // Length check before timingSafeEqual: it throws on mismatched lengths
  // rather than returning false, same guard `service-identity.ts`'s
  // `tokensMatch` applies.
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new TenantAssertionError("tenant assertion signature verification failed");
  }

  let payload: AssertionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as AssertionPayload;
  } catch {
    throw new TenantAssertionError("malformed tenant assertion payload");
  }
  if (typeof payload.clientSlug !== "string" || payload.clientSlug.length === 0) {
    throw new TenantAssertionError("tenant assertion payload is missing clientSlug");
  }
  if (typeof payload.exp !== "number") {
    throw new TenantAssertionError("tenant assertion payload is missing exp");
  }
  if (now() > payload.exp) {
    throw new TenantAssertionError("tenant assertion has expired");
  }

  return { clientSlug: payload.clientSlug };
}

/**
 * Builds the tenant-assertion middleware. Mount it AFTER
 * `createServiceIdentityMiddleware` (this is who-is-the-tenant, layered on
 * top of who-is-the-caller) and BEFORE any router that reads or resolves a
 * `clientSlug`.
 */
export function createTenantAssertionMiddleware(config: TenantAssertionConfig): RequestHandler {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  return (req: RequestWithTenantAssertion, res: Response, next: NextFunction): void => {
    if (!config.enabled) {
      next();
      return;
    }

    if (!config.secret) {
      // Fail closed, same posture as service-identity.ts's missing-audience
      // guard: verifying without a secret to check against would mean
      // trusting the header's claimed clientSlug outright, i.e. exactly the
      // status quo this ticket closes.
      logError("TENANT_ASSERTION_ENABLED is set but TENANT_ASSERTION_SECRET is not configured; refusing to verify assertions with nothing to check them against");
      res.status(500).json({ error: "tenant assertion verification is misconfigured" });
      return;
    }

    const header = req.header(HEADER_NAME);
    if (!header) {
      res.status(401).json({ error: `missing ${HEADER_NAME} header` });
      return;
    }

    try {
      req.tenantAssertion = verifyTenantAssertion(header, config.secret, now);
    } catch (err) {
      logWarning(`rejected a tenant assertion: ${describeError(err)}`);
      res.status(401).json({ error: "invalid tenant assertion" });
      return;
    }

    next();
  };
}

/**
 * The actual entitlement check every clientSlug-bearing route must call.
 * Returns `true` (having already written the 403 response) when the
 * request's asserted tenant does not match `targetClientSlug` — callers must
 * `return` immediately when this returns `true`, matching every other guard
 * clause in these route handlers.
 *
 * Returns `false` (no-op) when no assertion is attached to the request at
 * all, which happens only when `TenantAssertionConfig.enabled` is false —
 * the explicit, written status quo this ticket is allowed to leave in place
 * (decision 9 says the portal signs an assertion; it does not say every
 * deployment must already have TENANT_ASSERTION_ENABLED=true before the
 * portal-side signer exists in karosCMO). This is why `enabled` is a real,
 * independently-testable switch rather than always-on: see
 * `__tests__/tenant-assertion.test.ts`'s "disabled" describe block for the
 * proof it actually gates, not just reads as gating.
 */
export function enforceTenantEntitlement(req: RequestWithTenantAssertion, res: Response, targetClientSlug: string): boolean {
  const assertion = req.tenantAssertion;
  if (!assertion) return false;

  if (assertion.clientSlug !== targetClientSlug) {
    logWarning(`tenant assertion for "${assertion.clientSlug}" is not entitled to clientSlug "${targetClientSlug}"`);
    res.status(403).json({ error: `caller is not entitled to clientSlug "${targetClientSlug}"` });
    return true;
  }
  return false;
}
