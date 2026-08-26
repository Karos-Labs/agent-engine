import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");
const CLOUDBUILDS = ["cloudbuild.yaml", "cloudbuild.promote.yaml"] as const;

/**
 * AU2 reopened (SCRUM-288): an audience check that cannot fail.
 *
 * `PUBSUB_PUSH_AUDIENCE_URL` was wired to the BARE SERVICE URL. Cloud Run only
 * admits a token whose `aud` is the service URL, so every request that reached
 * the handler already carried exactly the audience the handler verified — the
 * check could not reject anything IAM had admitted. Probed against deployed
 * prep: a plain invoker token passed straight through to payload validation.
 *
 * Nothing caught it. The code was correct, the YAML parsed, the deploy was
 * green, and `auth/service-identity.ts` states the correct value in a doc
 * comment beside the middleware. The value was written down and not read.
 * So it is asserted here instead.
 */
describe("AU2: the push audience must be the endpoint, not the service", () => {
  it.each(CLOUDBUILDS)("%s pins the full push endpoint path", (file) => {
    const yaml = read(file);
    const match = /_PUBSUB_PUSH_AUDIENCE_URL:\s*"([^"]+)"/.exec(yaml);
    expect(match, `${file} must define _PUBSUB_PUSH_AUDIENCE_URL`).not.toBeNull();

    const value = match![1]!;
    expect(value, "a bare service URL is the audience every invoker token already carries — the check would be inert").toMatch(
      /\/api\/v1\/queue\/pubsub-push$/,
    );
  });

  it.each(CLOUDBUILDS)("%s keeps the push audience DISTINCT from the service audience", (file) => {
    const yaml = read(file);
    const push = /_PUBSUB_PUSH_AUDIENCE_URL:\s*"([^"]+)"/.exec(yaml)?.[1];
    const service = /_AUTH_AUDIENCE:\s*"([^"]+)"/.exec(yaml)?.[1];

    // The bug in one line: if these are ever equal again, the push check is
    // verifying the same audience Cloud Run already required.
    expect(push).not.toBe(service);
  });

  it.each(CLOUDBUILDS)("%s stages a non-empty service-account allowlist", (file) => {
    const yaml = read(file);
    const allowlist = /_AUTH_ALLOWED_SERVICE_ACCOUNTS:\s*"([^"]*)"/.exec(yaml)?.[1];

    // An empty allowlist means "any identity Google vouches for for this
    // audience" (auth/service-identity.ts:77-82). With AUTH_AUDIENCE set to
    // this service's own URL, that is precisely the set Cloud Run IAM already
    // admitted — so flipping AUTH_ENABLED with an empty list would log
    // enforcement while performing none.
    expect(allowlist, `${file} must stage the allowlist before the flag can be flipped`).toBeTruthy();
    expect(allowlist).toContain("@");
  });

  it.each(CLOUDBUILDS)("%s keeps AUTH_ENABLED false — flipping it is SCRUM-331", (file) => {
    // Blocked on SCRUM-330 (the portal's fail-open token fetch): enabling
    // before that lands turns a metadata blip into an intermittent portal 401.
    expect(read(file)).toContain("AUTH_ENABLED=false");
  });
});
