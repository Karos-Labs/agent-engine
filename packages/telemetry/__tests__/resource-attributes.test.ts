import { describe, expect, it } from "vitest";
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resolveTelemetryProjectId, telemetryResourceAttributes } from "../src/index.js";

/**
 * `gcp.project_id` is an INGEST CONTRACT, not a nicety (2026-09-22).
 *
 * Google's OTLP metrics endpoint rejects any payload whose resource lacks it,
 * verbatim:
 *
 *   POST https://telemetry.googleapis.com/v1/metrics
 *   HTTP 400 — Resource is missing required attribute "gcp.project_id"
 *
 * `/v1/traces` has no such requirement, and `@opentelemetry/resource-detector-gcp`
 * does not supply the attribute — it sets `cloud.account.id`, `cloud.platform`,
 * `cloud.region`, `faas.name`, `faas.instance` and friends, never
 * `gcp.project_id`.
 *
 * So traces arrived and metrics did not, in every service, in both projects,
 * for as long as metrics have existed here. Measured the day this was written:
 * Cloud Monitoring held ZERO metric descriptors matching `agent_engine` out of
 * 1,992 in each project, while Cloud Trace held traces from the same minute.
 *
 * Nothing caught it because OpenTelemetry swallows exporter failures by
 * design: its diagnostics go to a no-op logger unless one is set, so a backend
 * refusing every export looks exactly like a backend receiving them.
 * `initTelemetry` now sets one — and this file exists because `initTelemetry`
 * itself starts a real SDK against a real endpoint and cannot be exercised,
 * which is precisely how the omission survived.
 */
describe("telemetryResourceAttributes", () => {
  it("carries gcp.project_id, without which every metrics export is refused", () => {
    const attrs = telemetryResourceAttributes("karoscmo-prep", {} as NodeJS.ProcessEnv);
    expect(attrs["gcp.project_id"]).toBe("karoscmo-prep");
  });

  it("takes the project as an argument rather than reading GOOGLE_CLOUD_PROJECT, which names a DIFFERENT project", () => {
    // The defect this pins. `GOOGLE_CLOUD_PROJECT` names where FIRESTORE
    // lives; the prep worker runs in `karoscmo-prep` and sets it to
    // `karoscmo`, because both environments share one Firestore project and
    // are separated by database. Reading it addressed prep's metrics to
    // PRODUCTION's monitoring workspace, which answered:
    //
    //   403 Permission 'monitoring.timeSeries.create' denied on resource
    //       '//logging.googleapis.com/projects/karoscmo'
    //
    // No grant in the prep project could fix that, and three were tried.
    const attrs = telemetryResourceAttributes("karoscmo-prep", { GOOGLE_CLOUD_PROJECT: "karoscmo" } as NodeJS.ProcessEnv);
    expect(attrs["gcp.project_id"]).toBe("karoscmo-prep");
  });

  it("spells the other two keys exactly as the semantic conventions do", () => {
    // The literals here and the constants the OTel SDK exports have to agree;
    // asserting it is what lets the resource be built from a plain, testable
    // object instead of from imports only reachable inside `initTelemetry`.
    const attrs = telemetryResourceAttributes("p", {} as NodeJS.ProcessEnv);
    expect(Object.keys(attrs).sort()).toEqual([ATTR_DEPLOYMENT_ENVIRONMENT_NAME, "gcp.project_id", ATTR_SERVICE_NAME].sort());
  });

  it("reads prep and prod off the database id the deploy already sets", () => {
    expect(telemetryResourceAttributes("p", { FIRESTORE_DATABASE_ID: "prep" } as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prep");
    expect(telemetryResourceAttributes("p", { FIRESTORE_DATABASE_ID: "(default)" } as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prod");
    // Absent is prod, deliberately: an unset variable in a deployed service is
    // production far more often than it is prep.
    expect(telemetryResourceAttributes("p", {} as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prod");
  });

  it("never omits the key when the project is unknown, because an absent attribute and an empty one fail differently", () => {
    // An OMITTED attribute is the 400 this file opens with; an empty one is a
    // value the backend can name in its complaint. The second is far easier to
    // diagnose, which is the entire lesson of this file.
    const attrs = telemetryResourceAttributes("", {} as NodeJS.ProcessEnv);
    expect(Object.keys(attrs)).toContain("gcp.project_id");
    expect(attrs["gcp.project_id"]).toBe("");
  });

  it("prefers an explicit TELEMETRY_PROJECT_ID over anything it could detect", async () => {
    await expect(resolveTelemetryProjectId({ TELEMETRY_PROJECT_ID: "explicit", GOOGLE_CLOUD_PROJECT: "firestore-project" } as NodeJS.ProcessEnv)).resolves.toBe("explicit");
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when there is no metadata server, rather than giving up on telemetry", async () => {
    // Local development and tests: a wrong project beats none, and the export
    // now names the project it was refused on.
    await expect(resolveTelemetryProjectId({ GOOGLE_CLOUD_PROJECT: "karoscmo" } as NodeJS.ProcessEnv)).resolves.toBe("karoscmo");
  });
});
