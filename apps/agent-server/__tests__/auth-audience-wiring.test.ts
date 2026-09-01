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

  it.each(CLOUDBUILDS)("%s does not put a comma in the allowlist while --set-env-vars is comma-delimited", (file) => {
    const yaml = read(file);
    const allowlist = /_AUTH_ALLOWED_SERVICE_ACCOUNTS:\s*"([^"]*)"/.exec(yaml)![1]!;

    // `AUTH_ALLOWED_SERVICE_ACCOUNTS` is split on "," (wiring/auth.ts:23), so
    // a two-account allowlist is the natural thing to write. It does not work
    // here: the value reaches the container through `--set-env-vars=`, which
    // uses "," as its OWN separator between variables. A comma inside the
    // value is not a second allowed account — it is a malformed env-var list.
    //
    // gcloud's escape hatch is the alternate-delimiter form
    // (see gcloud topic escaping). This asserts the two are consistent rather
    // than banning commas outright: a comma is allowed exactly when EVERY
    // deploy step in the file has been switched to that form.
    //
    // Matched against argument lines only (`- --set-env-vars=…`), never the
    // file's prose. The first version of this check searched the whole file
    // and was satisfied by the comment above, which names the escape form as
    // an example — the guard passed on a file whose deploys were still
    // comma-delimited. Verified by injecting a second account and watching
    // this fail.
    // `.trim()` per line, not a `$` anchor: these two files do not reliably
    // share a line ending (checkout normalisation differs by platform), and
    // `.` does not match `\r`, so an anchored pattern found zero deploy
    // arguments in whichever file was CRLF — the guard would have been vacuous
    // there rather than wrong-and-loud. Hence the length assertion above too.
    const deployArgs = yaml
      .split("\n")
      .map((line) => /^\s*-\s+--set-env-vars=(.*)/.exec(line.trim())?.[1])
      .filter((v): v is string => v !== undefined);
    expect(deployArgs.length, `${file} must have at least one --set-env-vars deploy argument`).toBeGreaterThan(0);
    const usesAltDelimiter = deployArgs.every((v) => /^\^[^^]+\^/.test(v));
    if (!allowlist.includes(",")) return;
    expect(
      usesAltDelimiter,
      `${file} lists more than one allowed service account, so --set-env-vars must use gcloud's ^@^ alternate-delimiter form or the comma will split the env-var list instead of the allowlist`,
    ).toBe(true);
  });

  it.each(CLOUDBUILDS)("%s keeps AUTH_ENABLED false — flipping it is SCRUM-331", (file) => {
    // Blocked on SCRUM-330 (the portal's fail-open token fetch): enabling
    // before that lands turns a metadata blip into an intermittent portal 401.
    expect(read(file)).toContain("AUTH_ENABLED=false");
  });
});
