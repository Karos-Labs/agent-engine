import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildCapabilityReport, describeRunCapabilities, CAPABILITY_CATALOGUE, PRODUCT_CAPABILITIES } from "@agent-engine/core";
import { KNOWN_PRODUCT_IDS } from "../src/wiring/workflows.js";
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
  ANTHROPIC_API_KEY: "sk-x",
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

/**
 * AU65 (SCRUM-363): the report rolled up to the altitude decisions are made at.
 *
 * The failure this closes was not a wrong row. It was four correct rows that
 * never added up, on the page, to "the whole video line is dead".
 */
describe("AU65: the report answers at product level", () => {
  const productsOf = (env: Record<string, string>) => new Map(buildCapabilityReport(env).products.map((p) => [p.productId, p]));

  it("covers every dispatchable product, in both directions", () => {
    // The blind spot this file closes is a product nobody mapped, so the
    // mapping itself has to be the thing that fails — not a reader noticing.
    const mapped = new Set(PRODUCT_CAPABILITIES.map((p) => p.productId));
    const dispatchable = new Set<string>(KNOWN_PRODUCT_IDS);
    expect([...dispatchable].filter((id) => !mapped.has(id)), "dispatchable but unmapped").toEqual([]);
    expect([...mapped].filter((id) => !dispatchable.has(id)), "mapped but not dispatchable").toEqual([]);
  });

  it("gives every capability a product names a shortfall phrase, so no headline says '<id> unavailable'", () => {
    const named = new Set(PRODUCT_CAPABILITIES.flatMap((p) => [...p.requires, ...p.enhances]));
    for (const capability of CAPABILITY_CATALOGUE) {
      if (!named.has(capability.id)) continue;
      const phrase = capability.pendingBuild?.summary ?? capability.shortfall;
      expect(phrase, `${capability.id} is named by a product and must say what it LACKS`).toBeDefined();
      expect(phrase!.length).toBeLessThan(45);
    }
  });

  it("says the sentence, in one line, for the case that prompted this", () => {
    const shorts = productsOf(PROD_ENV).get("branded-shorts-agent")!;
    expect(shorts.status).toBe("UNRUNNABLE");
    expect(shorts.headline).toContain("render engine pending development");
    expect(shorts.headline).toContain("SCRUM-362");
  });

  it("keeps the per-key detail underneath rather than replacing it", () => {
    // The rows are correct. They are just not the level anyone decides at.
    const shorts = productsOf(PROD_ENV).get("branded-shorts-agent")!;
    expect(shorts.capabilities.map((c) => c.id)).toContain("video-engine");
    expect(shorts.capabilities.map((c) => c.id)).toContain("video-transcription");
    expect(shorts.blockedBy).toContain("video-engine");
  });

  it("distinguishes 'nobody can configure this' from 'somebody must issue a key'", () => {
    // The distinction that decides WHO acts. Sending someone to buy an
    // ElevenLabs key to fix branded-shorts would be wasted money and a wasted
    // week, which is exactly what the old report invited.
    const products = productsOf(PROD_ENV);
    expect(products.get("branded-shorts-agent")!.blockedReason).toBe("PENDING_DEVELOPMENT");
    expect(products.get("landing-builder-agent")!.blockedReason ?? "NOT_BLOCKED").not.toBe("PENDING_DEVELOPMENT");
  });

  it("stays PENDING_DEVELOPMENT even when a key is ALSO missing", () => {
    // branded-shorts is blocked by BOTH an unbuilt engine and an absent
    // transcription key. Reporting NOT_CONFIGURED would send someone to issue
    // a key that changes nothing — the exact confusion 2c exists to prevent.
    const shorts = productsOf(PROD_ENV).get("branded-shorts-agent")!;
    expect(shorts.blockedBy).toEqual(expect.arrayContaining(["video-engine", "video-transcription"]));
    expect(shorts.blockedReason).toBe("PENDING_DEVELOPMENT");
    expect(shorts.headline, "the headline must not mention the key, which is not the blocker that matters").not.toContain(
      "transcription",
    );
  });

  it("REFUSES to call branded-shorts runnable even with every key it names present", () => {
    // The load-bearing assertion, and the one PENDING_BUILD exists for. Under
    // the old three-status model this env produced ACTIVE rows and a runnable
    // product, because status only ever described configuration.
    const products = productsOf({ ...PROD_ENV, ELEVENLABS_API_KEY: "el-x", BRANDED_SHORTS_ENGINE_DIR: "/opt/engine" });
    expect(products.get("branded-shorts-agent")!.status).toBe("UNRUNNABLE");
    expect(products.get("branded-shorts-agent")!.blockedReason).toBe("PENDING_DEVELOPMENT");
  });

  it("reports a product RUNNABLE when everything it requires is satisfied", () => {
    // Guards the other direction: a rollup that called everything UNRUNNABLE
    // would pass every assertion above and be worthless.
    expect(productsOf(PROD_ENV).get("linkedin-agent")!.status).not.toBe("UNRUNNABLE");
  });

  it("does not let a video gap degrade a product that has nothing to do with video", () => {
    const blog = productsOf(PROD_ENV).get("blog-agent")!;
    expect(blog.blockedBy).not.toContain("video-engine");
    expect(blog.degradedBy).not.toContain("video-engine");
  });

  it("keeps ENGINE-WIDE gaps out of product headlines", () => {
    // The first cut of capability-products.ts put cost-accounting and tracing
    // on every product. Twelve of thirteen headlines came out identical —
    // "DEGRADED — cost-accounting unavailable" — burying the two products that
    // were genuinely dead. A rollup that says the same thing about everything
    // is the failure this layer exists to fix, inverted.
    //
    // Asserted against an environment where those capabilities are ACTUALLY
    // degraded, not against PROD_ENV. A first attempt at this test used
    // PROD_ENV and passed even with the regression reintroduced, because
    // cost-accounting happens to be satisfied there — a guard that cannot fail
    // on the thing it exists for.
    const noObservability = { ...PROD_ENV, GOOGLE_CLOUD_PROJECT: "", BQ_PROJECT_ID: "", BQ_DATASET_ID: "" };
    const report = buildCapabilityReport(noObservability);
    expect(report.capabilities.find((c) => c.id === "cost-accounting")?.status, "the premise: this env must actually degrade it").not.toBe(
      "ACTIVE",
    );

    for (const product of report.products) {
      expect(product.degradedBy, `${product.productId} must not be degraded by engine-wide observability`).not.toContain("cost-accounting");
      expect(product.degradedBy).not.toContain("tracing");
    }
  });

  it("never emits the '<id> unavailable' fallback phrase in a headline", () => {
    for (const product of buildCapabilityReport(PROD_ENV).products) {
      expect(product.headline, `${product.productId} fell back to an id`).not.toMatch(/[a-z-]+ unavailable/);
    }
  });

  it("sorts what a person can fix above what is already on a board", () => {
    const products = buildCapabilityReport({ ...PROD_ENV, PROMPT_STORE_DRIVER: "" }).products;
    const notConfigured = products.findIndex((p) => p.blockedReason === "NOT_CONFIGURED");
    const pending = products.findIndex((p) => p.blockedReason === "PENDING_DEVELOPMENT");
    expect(notConfigured).toBeGreaterThanOrEqual(0);
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(notConfigured, "a missing key outranks scheduled work — one of them can be fixed today").toBeLessThan(pending);
  });
});

describe("AU65: UNEXPLAINED keeps meaning exactly one thing", () => {
  it("never contains a row that is merely unbuilt", () => {
    // If scheduled work leaks into this list it reads as an oversight, and the
    // one list that is supposed to mean "a question nobody has been asked"
    // stops meaning anything.
    for (const row of buildCapabilityReport(PROD_ENV).capabilities) {
      if (row.status !== "PENDING_BUILD") continue;
      expect(row.decision, `${row.id} is scheduled work, not an unanswered question`).toBe("EXPECTED");
    }
  });

  it("requires a ticket before anything may claim PENDING_BUILD", () => {
    // The side door. Without this, "not built yet" becomes a way to launder an
    // undecided row into EXPECTED without recording a decision anywhere.
    for (const capability of CAPABILITY_CATALOGUE) {
      if (!capability.pendingBuild) continue;
      expect(capability.pendingBuild.ticket, `${capability.id} must name the ticket that scheduled it`).toMatch(/^SCRUM-\d+$/);
    }
  });

  it("says outright that wiring transcription alone fixes nothing", () => {
    const transcription = CAPABILITY_CATALOGUE.find((c) => c.id === "video-transcription")!;
    expect(transcription.whenAbsent).toMatch(/renderer that does not exist|Fixing this is not fixing video/i);
  });
});
