import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildCapabilityReport, describeRunCapabilities, CAPABILITY_CATALOGUE } from "@agent-engine/core";
import { createApp } from "../src/app.js";
import { setupTestEnvironment } from "./test-helpers.js";

/**
 * AU55 (SCRUM-354): the report has to be decidable without the codebase.
 *
 * "Tomer can answer 'issue a key' or 'remove it' for every line" is not a
 * property a test can assert directly, so these assert the two things that
 * make it possible: every row carries a consequence in plain words, and rows
 * needing a decision sort to the top.
 */

/** What prod actually has today, per cloudbuild.promote.yaml. */
const PROD_ENV: Record<string, string> = {
  FIRESTORE_DATABASE_ID: "(default)",
  GOOGLE_CLOUD_PROJECT: "karoscmo",
  GCS_WORKSPACE_BUCKET: "karoscmo-prod-agent-artifacts",
  GCS_MEDIA_BUCKET: "karoscmo-prod-media-assets",
  GCS_ARTIFACTS_BUCKET: "karoscmo-prod-agent-artifacts",
  PROMPT_STORE_DRIVER: "firestore",
  LANDING_ENGINE_TEMPLATE_ROOT: "/app/packages/tools/karos-landing/assets/template",
  LANDING_ENGINE_ROOT: "/tmp/landing-engine",
  PUBSUB_PUSH_AUDIENCE_URL: "https://agent-engine-prod.example.run.app",
  AUTH_ENABLED: "false",
  AUTH_AUDIENCE: "https://agent-engine-prod.example.run.app",
  SCRAPPYCOCO_API_KEY: "sc-x",
};

describe("AU55: the capability report", () => {
  it("every catalogue row states a consequence, in capability words rather than variable words", () => {
    for (const capability of CAPABILITY_CATALOGUE) {
      expect(capability.whenAbsent.length, `${capability.id} must say what happens instead`).toBeGreaterThan(40);
      expect(capability.requires.length, `${capability.id} must name at least one variable`).toBeGreaterThan(0);
      // A title that merely names the variable is unactionable — the whole
      // failure mode this ticket exists to fix.
      for (const requirement of capability.requires) {
        expect(capability.title, `${capability.id}'s title must not just be its variable name`).not.toBe(requirement.name);
      }
    }
  });

  it("sorts rows needing a decision to the top", () => {
    const report = buildCapabilityReport(PROD_ENV);
    const firstUnexplained = report.capabilities.findIndex((c) => c.decision === "UNEXPLAINED");
    const firstExpected = report.capabilities.findIndex((c) => c.decision === "EXPECTED");
    if (firstUnexplained !== -1) {
      expect(firstUnexplained, "UNEXPLAINED rows must precede EXPECTED ones").toBeLessThan(firstExpected);
    }
  });

  it("still reports venue photography DISABLED in prod, where the key does not exist yet", () => {
    // AU56 decided to issue the key (option A) and wired PREP. Prod's key has
    // not been created, so prod must still show the capability off — a
    // decision about prep is not a decision about prod, and the report has to
    // keep saying so until prod is actually wired.
    const report = buildCapabilityReport(PROD_ENV);
    const venue = report.capabilities.find((c) => c.id === "venue-photography");
    expect(venue?.status).toBe("DISABLED");
    expect(venue?.missing).toContain("GOOGLE_PLACES_KEY");
    // EXPECTED now, because a written decision exists — this row is where the
    // AU56 finding came from, and it sat UNEXPLAINED until that decision.
    expect(venue?.decision).toBe("EXPECTED");
  });

  it("reports venue photography ACTIVE once the key is present, as prep now is", () => {
    const report = buildCapabilityReport({ ...PROD_ENV, GOOGLE_PLACES_KEY: "places-key" });
    const venue = report.capabilities.find((c) => c.id === "venue-photography");
    expect(venue?.status).toBe("ACTIVE");
    expect(venue?.missing).toEqual([]);
  });

  it("does not report an explicitly-disabled capability as ACTIVE", () => {
    // AUTH_ENABLED=false is a real value, not an absence. Treating it as
    // satisfied would report authentication as ACTIVE while it is off.
    const auth = buildCapabilityReport(PROD_ENV).capabilities.find((c) => c.id === "service-identity-auth");
    expect(auth?.status).toBe("DISABLED");
    expect(auth?.security).toBe(true);
    expect(auth?.decision, "this one IS decided — SCRUM-331 blocked on SCRUM-330").toBe("EXPECTED");
  });

  it("flags the workspace store's silent local-disk fallback when the bucket is absent", () => {
    const report = buildCapabilityReport({ ...PROD_ENV, GCS_WORKSPACE_BUCKET: "" });
    const workspace = report.capabilities.find((c) => c.id === "durable-workspace");
    expect(workspace?.status).toBe("DISABLED");
    expect(workspace?.whenAbsent).toMatch(/local disk/i);
  });

  describe("per-run recording", () => {
    it("marks a run MEASURED when everything it depended on was configured", () => {
      const note = describeRunCapabilities(["external-research", "durable-workspace"], buildCapabilityReport(PROD_ENV));
      expect(note.tier).toBe("MEASURED");
      expect(note.degraded).toEqual([]);
    });

    it("marks a run ESTIMATED when it ran on fallbacks, and says which", () => {
      const note = describeRunCapabilities(["image-search-curated"], buildCapabilityReport(PROD_ENV));
      expect(note.tier).toBe("ESTIMATED");
      expect(note.degraded).toContain("image-search-curated");
      expect(note.notes[0]).toMatch(/UNSPLASH_ACCESS_KEY/);
    });

    it("does not penalise a run for a capability it never depended on", () => {
      // A blog run must not read as degraded because the video engine is off.
      const note = describeRunCapabilities(["external-research"], buildCapabilityReport(PROD_ENV));
      expect(note.tier).toBe("MEASURED");
    });
  });

  it("serves the report over HTTP", async () => {
    const env = await setupTestEnvironment();
    try {
      const app = createApp({ durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, workspaceStore: env.store } });
      const res = await request(app).get("/api/v1/diagnostics/capabilities");
      expect(res.status).toBe(200);
      expect(res.body.capabilities.length).toBe(CAPABILITY_CATALOGUE.length);
      expect(res.body.summary).toHaveProperty("unexplained");
    } finally {
      await env.cleanup();
    }
  });
});
