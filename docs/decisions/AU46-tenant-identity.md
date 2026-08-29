# AU46 (SCRUM-329) — which identity carries the tenant

Status: **Decided and implemented.** Decision made by Tomer, 2026-08-28 (decision
record on SCRUM-333, comment id 10404). This document is the write-up that
decision required before implementation — see AU46's own instruction: "DO NOT
PICK ONE IN CODE FIRST. Write the decision down, then implement it."

## The question AU46 asked

AU1 (SCRUM-287, `apps/agent-server/src/auth/service-identity.ts`) gave the
engine's HTTP API caller authentication, and said explicitly what it did not
give it:

> "This authenticates the CALLER, not the tenant. The only caller today is the
> karosCMO portal, whose single service account legitimately acts on behalf of
> every client — so a verified identity proves 'the portal called me' and says
> nothing about whether this particular request is legitimately for the
> `clientSlug` it names."
> — `apps/agent-server/src/auth/service-identity.ts:27-42`

Every caller of the engine is a **service**, not a person: the portal (via
`iamIdToken()`) and Pub/Sub push. A service identity says "the portal is
calling", never "the portal is calling on behalf of client X". AU46 named
three ways to close that gap and refused to pick one without a written
decision:

1. The portal signs a per-request assertion naming the tenant, and the engine
   verifies it.
2. The engine trusts the portal as a confused-deputy-accepting boundary and
   tenancy stays enforced only structurally below the API, made explicit and
   accepted in writing.
3. Per-tenant service identities (does not scale to seven clients pleasantly,
   worth naming and rejecting explicitly).

## The decision

**Option 1.** Verbatim, decision 9 of Tomer's 2026-08-28 decision record
(SCRUM-333 comment 10404):

> "SCRUM-329 — tenant identity at the engine edge: THE PORTAL SIGNS A
> PER-REQUEST TENANT ASSERTION."

This is the authoritative answer to AU46's own question. It is not re-derived
here — this document records the reasoning for the record and the exact
contract the engine implements against it, per the ticket's own instruction
("this directly answers AU46's own 'which identity carries the tenant'
question — do not re-derive it, implement against it").

### Why option 1, briefly (for completeness, not as re-litigation)

- **Option 2** (accept the status quo) is what AU1 already documented as
  temporary, not a resting state — a service that can act for any of seven
  paying clients with zero per-request tenant check is a confused-deputy hole
  large enough that it was flagged as G3's "practical blast radius" in AU1's
  own writeup and picked back up here rather than closed with a shrug.
- **Option 3** (per-tenant service identities) means seven — soon more —
  distinct GCP service accounts, IAM bindings, and secrets to keep in sync
  across two projects (prep/prod, per AU50/SCRUM-333's parity ledger), for a
  problem a single shared secret and a signed claim solves without any new
  infrastructure. Named, and rejected, per the ticket's own instruction to
  name it rather than silently drop it.
- **Option 1** costs one shared secret and a small, auditable amount of code
  on each side, needs no new GCP infrastructure, and produces a
  request-scoped claim that can carry a short TTL — a compromised or
  misdirected token has a small blast radius by construction, unlike a
  standing per-tenant credential.

## The contract this repo implements

Engine-side, in full, at `apps/agent-server/src/auth/tenant-assertion.ts`:

- **Header**: `X-Tenant-Assertion: <payload>.<signature>`, both segments
  base64url (`apps/agent-server/src/auth/tenant-assertion.ts:48`, the
  `HEADER_NAME` constant).
- **Payload**: JSON `{clientSlug, iat, exp}` (unix seconds), default TTL 300s
  (`apps/agent-server/src/auth/tenant-assertion.ts:49`, `DEFAULT_TTL_SECONDS`).
  Short-lived on purpose — the assertion answers "which tenant is THIS
  request for", not "who may ever call this service" (that's still AU1's
  job), so it should not outlive the request it rides on by much.
- **Signature**: `HMAC-SHA256(payload_b64, secret)`, verified in constant time
  (`verifyTenantAssertion`, `apps/agent-server/src/auth/tenant-assertion.ts:114-152`,
  using `node:crypto`'s `timingSafeEqual` the same way
  `service-identity.ts`'s `tokensMatch` already does for the dev-token path).
  Deliberately not a full JWT: one fixed algorithm, no header segment, no
  algorithm negotiation — portal and engine share a secret out of band
  (`TENANT_ASSERTION_SECRET`), so there is nothing to negotiate and a smaller
  format is a smaller attack surface.
- **Reference signer**: `signTenantAssertion`
  (`apps/agent-server/src/auth/tenant-assertion.ts:93-102`) is the portal's
  half of the contract, implemented here so the two sides of a cross-repo
  wire format cannot silently drift, and so this module's own tests
  (`apps/agent-server/__tests__/tenant-assertion.test.ts`) construct real
  valid assertions rather than hand-rolling the format a second time.
  **karosCMO must port this function** (or produce byte-identical output) —
  that port is cross-repo work this ticket cannot do from the agent-engine
  clone, and is the concrete follow-up item below.

### Enforcement — the part AU46 specifically asked for ("enforces clientSlug entitlement at the edge")

Verifying the assertion's signature only proves the portal (or whoever holds
the shared secret) issued a claim naming *some* clientSlug. It does not by
itself stop a request whose *target* clientSlug differs from the asserted
one. That comparison is `enforceTenantEntitlement`
(`apps/agent-server/src/auth/tenant-assertion.ts:214-224`), and it is called
at every point in the HTTP surface where a `clientSlug` is accepted or
resolved:

| Route | Where the target clientSlug comes from | Call site |
| --- | --- | --- |
| `POST /api/v1/runs/start` | The request body itself | `apps/agent-server/src/routes/runs.ts:172` |
| `POST /api/v1/runs/:runId/resume` | The stored run record (`durableStore.getRun`) | `apps/agent-server/src/routes/runs.ts:234` |
| `GET /api/v1/runs/:runId/status` | The stored run record | `apps/agent-server/src/routes/runs.ts:349` |
| `GET /api/v1/runs/:runId/deliverables/:kind` | The stored run record | `apps/agent-server/src/routes/deliverables.ts:43` |

The last three are the same shape of gap: `runId` and (for deliverables)
`kind` are low-cardinality, guessable strings, and before this change nothing
stopped an authenticated-as-the-portal caller from reading or resuming
**any** client's run by guessing or enumerating its id — the runId-guessing
cross-tenant read/resume gap the same trust boundary AU46 names covers, even
though the ticket text names the write/read split at `/deliverables` only in
passing. `apps/agent-server/__tests__/tenant-assertion.test.ts` proves this
concretely for all three (see "THE GAP THIS TICKET CLOSES" and the two tests
immediately after it): a cross-tenant call gets 403 and never reaches the
underlying store read.

`enforceTenantEntitlement` is a no-op (returns `false`, writes nothing) when
`req.tenantAssertion` is absent — which happens only when
`TenantAssertionConfig.enabled` is `false`
(`apps/agent-server/src/auth/tenant-assertion.ts:160-193`, mirroring
`service-identity.ts`'s own `enabled` axis). This keeps every existing test
and the pre-AU46 behavior unchanged when the feature is off, and is itself
tested (`__tests__/tenant-assertion.test.ts`'s "disabled tenant assertion"
case) — the point being that the off-switch is a real, independently
verified branch, not a check dressed up as one that can never actually run
in test.

### Mount order

`createTenantAssertionMiddleware` is mounted in `apps/agent-server/src/app.ts:91-93`,
after `createServiceIdentityMiddleware` (`app.ts:81`) and before every router
that reads or resolves a `clientSlug`. This layers "which tenant is this
request for" (AU46) directly on top of "who is the caller" (AU1) — the same
ordering AU1's own app.ts comment already established as load-bearing.

### Configuration

`apps/agent-server/src/wiring/tenant-assertion.ts:20`
(`createTenantAssertionConfigFromEnv`) reads:

- `TENANT_ASSERTION_ENABLED` — off unless exactly `"true"` or `"1"`, mirroring
  `AUTH_ENABLED`'s own parsing in `wiring/auth.ts`.
- `TENANT_ASSERTION_SECRET` — the shared HMAC secret. Required whenever
  enabled; its absence with the flag on fails every request closed (500),
  not open — see the guard in
  `apps/agent-server/src/auth/tenant-assertion.ts:166-172`.

Documented in `.env.example` (search `TENANT_ASSERTION_`) and given a
capability-catalogue row
(`packages/core/src/diagnostics/capability-catalogue.ts:360-373`, id
`tenant-assertion`, `security: true`) so its absence shows up in
`GET /api/v1/diagnostics/capabilities` (AU55) rather than degrading silently
— the exact failure mode AU55 exists to catch, applied to this ticket's own
new axis.

## What is NOT done by this ticket, and why

**`TENANT_ASSERTION_ENABLED` is not flipped on in `cloudbuild.yaml` or
`cloudbuild.promote.yaml`.** The portal-side signer
(`signTenantAssertion`'s karosCMO port) does not exist in that repo yet. If
this flag were turned on in either deploy config today, the one real caller
(the portal, calling without an `X-Tenant-Assertion` header) would 401 on
every request. This mirrors exactly how `AUTH_ENABLED` itself is hardcoded
`false` in both cloudbuild files pending SCRUM-331 — see
`cloudbuild.yaml:126-133` and `cloudbuild.promote.yaml:76-79` for that
precedent. Flipping this ticket's flag on is a **follow-up ticket**, gated on:

1. karosCMO implementing `signTenantAssertion` (or an equivalent producing
   byte-identical output) and attaching the header to every
   `/api/v1/runs/*` and `/api/v1/runs/*/deliverables/*` call.
2. `TENANT_ASSERTION_SECRET` provisioned in Secret Manager in both the prep
   and prod projects, with an accessor binding for both the portal's and the
   engine's runtime service accounts — a new row for AU50/SCRUM-333's
   production-parity ledger, not something this ticket's code change alone
   satisfies.
3. `TENANT_ASSERTION_ENABLED=true` added to both cloudbuild files, prep
   first with a soak, matching the ladder AU50 documents for `AUTH_ENABLED`
   (decision 8/SCRUM-331's own precedent).

**The Pub/Sub push route (`routes/queue.ts`) is out of scope for this
assertion.** It authenticates via its own OIDC audience check against
Pub/Sub's own push identity, not the portal's; Pub/Sub itself sets the
request's headers, so there is no portal-controlled header slot to carry a
tenant assertion on that path without a design change to what the portal
publishes into the message body/attributes instead — a decision this ticket
was not asked to make and does not make. `run-job.ts`'s `RunJobRequestSchema`
already carries `clientSlug` in the message body for that path; if push-route
tenant enforcement is wanted later, that is where the claim would need to
live, and it is a distinct design question from the one AU46 asked (which
concerns the portal's direct HTTP calls).

**Shlomi's S3 (SCRUM-215) role vocabulary is unrelated and left alone**,
consistent with AU46's own "dependency worth watching" note — this ticket
adds a tenant claim, not a role claim, and does not touch
`service-identity.ts`'s `CallerIdentity` shape.

## Evidence this is implemented, not just designed

`apps/agent-server/__tests__/tenant-assertion.test.ts` — 24 tests, all
passing against the code in this branch, including a full-app integration
suite that:

- signs and verifies real assertions (round trip, tamper, wrong secret,
  expiry, malformed);
- proves the middleware's `enabled: false` branch is a genuine no-op and its
  `enabled: true` branch actually rejects (missing header → 401, forged
  token → 401, no secret configured → 500 fail-closed);
- proves `enforceTenantEntitlement` 403s a mismatched tenant and passes a
  matching one; and
- reproduces the exact cross-tenant runId-guessing read against
  `/deliverables/:kind`, `/status`, and `/resume` and shows each now returns
  403 instead of another tenant's data.

Temporarily reverting the `enforceTenantEntitlement` call in
`routes/deliverables.ts` and re-running the "THE GAP THIS TICKET CLOSES" test
fails it (`expected 200 to be 403` — the cross-tenant read succeeds and
leaks the victim's deliverable content); restoring the call passes it. See
the ticket's closing report for both outputs verbatim.
