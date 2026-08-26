import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertFirestoreDatabaseId, KNOWN_FIRESTORE_DATABASE_IDS } from "../src/wiring/firestore-database-id.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * AU60 (SCRUM-359): prep and production are one Firestore project with two
 * databases, separated by this variable and nothing else — the same credential
 * reaches both.
 *
 * The behaviours asserted here were OBSERVED against the real credential
 * before being encoded: absent and empty both resolve to "(default)" and are
 * fully reachable (production), while a misspelling fails at first use with
 * NOT_FOUND. So the dangerous direction is absence, not typos.
 */
describe("AU60: FIRESTORE_DATABASE_ID must name a database that exists", () => {
  const PROJECT = { GOOGLE_CLOUD_PROJECT: "karoscmo" };

  it.each(KNOWN_FIRESTORE_DATABASE_IDS)("accepts %s", (id) => {
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: id })).not.toThrow();
  });

  it("REFUSES when absent — the case that silently targets production", () => {
    // Observed: undefined -> "(default)" -> reachable, no error, live data.
    expect(() => assertFirestoreDatabaseId(PROJECT)).toThrow(/not set/);
  });

  it("REFUSES when empty — `??` and `||` both treat \"\" as absent", () => {
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: "" })).toThrow(/empty/);
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: "   " })).toThrow(/empty/);
  });

  it("REFUSES a misspelling at startup rather than at first use", () => {
    // Observed live: "prepp" reaches the SDK and fails with `5 NOT_FOUND` on
    // the first operation — late, and indistinguishable from an outage.
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: "prepp" })).toThrow(/not a database that exists/);
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: "default" })).toThrow(/not a database that exists/);
    expect(() => assertFirestoreDatabaseId({ ...PROJECT, FIRESTORE_DATABASE_ID: "PREP" })).toThrow(/not a database that exists/);
  });

  it("stays out of the way when nothing talks to Firestore", () => {
    // No GCP project => every store falls back to its in-memory implementation,
    // so local development without credentials must keep working.
    expect(() => assertFirestoreDatabaseId({})).not.toThrow();
    expect(() => assertFirestoreDatabaseId({ FIRESTORE_DATABASE_ID: "anything" })).not.toThrow();
  });

  it("honours GCLOUD_PROJECT too, since the stores read either name", () => {
    expect(() => assertFirestoreDatabaseId({ GCLOUD_PROJECT: "karoscmo" })).toThrow(/not set/);
  });

  describe("both deploy configs set a value this assertion accepts", () => {
    it.each(["cloudbuild.yaml", "cloudbuild.promote.yaml"])("%s", (file) => {
      const yaml = readFileSync(path.join(repoRoot, file), "utf8");
      const value = /_FIRESTORE_DATABASE_ID:\s*"?([^"\n]+)"?/.exec(yaml)?.[1]?.trim();
      expect(value, `${file} must define _FIRESTORE_DATABASE_ID`).toBeTruthy();
      // If a deploy ever set a value this assertion rejects, the service would
      // refuse to boot — so the two must agree, and this is where that is checked.
      expect(KNOWN_FIRESTORE_DATABASE_IDS as readonly string[]).toContain(value!);
    });
  });

  it("runs before any store is constructed, in BOTH entry points", () => {
    for (const entry of ["server.ts", "queue-consumer.ts"]) {
      const src = readFileSync(path.join(repoRoot, "apps", "agent-server", "src", entry), "utf8");
      const assertAt = src.indexOf("assertFirestoreDatabaseIdOrExit()");
      const storeAt = src.indexOf("createDurableStoreFromEnv()");
      expect(assertAt, `${entry} must call the assertion`).toBeGreaterThan(-1);
      expect(storeAt, `${entry} must build a durable store`).toBeGreaterThan(-1);
      expect(assertAt, `${entry}: the assertion must precede store construction`).toBeLessThan(storeAt);
    }
  });
});
