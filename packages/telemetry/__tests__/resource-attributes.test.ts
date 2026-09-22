import { describe, expect, it } from "vitest";
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { telemetryResourceAttributes } from "../src/index.js";

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
    const attrs = telemetryResourceAttributes({ GOOGLE_CLOUD_PROJECT: "karoscmo-prep" } as NodeJS.ProcessEnv);
    expect(attrs["gcp.project_id"]).toBe("karoscmo-prep");
  });

  it("spells the other two keys exactly as the semantic conventions do", () => {
    // The literals here and the constants the OTel SDK exports have to agree;
    // asserting it is what lets the resource be built from a plain, testable
    // object instead of from imports only reachable inside `initTelemetry`.
    const attrs = telemetryResourceAttributes({} as NodeJS.ProcessEnv);
    expect(Object.keys(attrs).sort()).toEqual([ATTR_DEPLOYMENT_ENVIRONMENT_NAME, "gcp.project_id", ATTR_SERVICE_NAME].sort());
  });

  it("reads prep and prod off the database id the deploy already sets", () => {
    expect(telemetryResourceAttributes({ FIRESTORE_DATABASE_ID: "prep" } as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prep");
    expect(telemetryResourceAttributes({ FIRESTORE_DATABASE_ID: "(default)" } as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prod");
    // Absent is prod, deliberately: an unset variable in a deployed service is
    // production far more often than it is prep.
    expect(telemetryResourceAttributes({} as NodeJS.ProcessEnv)[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("prod");
  });

  it("never omits the key when the project is unset, because an absent attribute and an empty one fail differently", () => {
    // `initTelemetry` already returns early without GOOGLE_CLOUD_PROJECT, so
    // this shape is unreachable in a deployed process. It is pinned anyway:
    // an OMITTED attribute is the 400 this whole file is about, while an empty
    // one is a value the backend can name in its complaint.
    const attrs = telemetryResourceAttributes({} as NodeJS.ProcessEnv);
    expect(Object.keys(attrs)).toContain("gcp.project_id");
    expect(attrs["gcp.project_id"]).toBe("");
  });
});
