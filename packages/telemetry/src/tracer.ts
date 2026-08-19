import { trace, type Tracer } from "@opentelemetry/api";

const INSTRUMENTATION_NAME = "agent-engine";
const INSTRUMENTATION_VERSION = "0.0.1";

/**
 * Returns a `Tracer` via the OpenTelemetry API. When no `TracerProvider` has
 * been registered (the default until `initTelemetry()` below is explicitly
 * called), `trace.getTracer()` returns the API's own no-op tracer — a real
 * object satisfying the full `Span` interface, but every method on it is a
 * cheap no-op. This is what makes every helper in this package "zero-overhead
 * no-op tracing when a tracer is not configured" (RFC-01 §11) without any
 * conditional logic of our own — the OTel API guarantees it structurally.
 */
export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

// NodeSDK is loaded lazily (require, not a static import) so importing this
// module — which every workspace using getTracer()/span-helpers does — never
// pulls in the OTel SDK/Cloud Trace exporter dependency graph unless
// initTelemetry() actually runs. Keeps `tsc`/vitest fast and side-effect-free
// for every package that doesn't call it.
let started = false;

/**
 * Starts real OpenTelemetry tracing, exporting directly to Cloud Trace — no
 * Collector, mirroring karosCMO's Phase 2 topology
 * (src/instrumentation.node.ts). No-ops without `GOOGLE_CLOUD_PROJECT` set.
 *
 * Must be called explicitly by a real entrypoint (apps/agent-server's
 * `main()`) — NEVER at module-import time. Every span-helpers test and every
 * `tsc`/vitest run in this workspace relies on `getTracer()` returning the
 * API's no-op tracer by default; auto-starting here on import would silently
 * break that "zero-overhead when unconfigured" guarantee for build/test
 * tooling, and — worse — attempt real Cloud Trace network calls under test.
 */
export async function initTelemetry(): Promise<void> {
  if (started || !process.env.GOOGLE_CLOUD_PROJECT) return;
  started = true;

  const [{ NodeSDK }, { BatchSpanProcessor }, { resourceFromAttributes }, { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME }, { TraceExporter }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@google-cloud/opentelemetry-cloud-trace-exporter"),
    ]);

  // Same prep/prod signal agent-engine's own cloudbuild.yaml already sets
  // (FIRESTORE_DATABASE_ID: "(default)" for prod, "prep" for prep) — reused
  // rather than inventing a second environment variable, matching karosCMO's
  // instrumentation.node.ts convention.
  const environment = process.env.FIRESTORE_DATABASE_ID === "prep" ? "prep" : "prod";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: INSTRUMENTATION_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }),
    spanProcessor: new BatchSpanProcessor(new TraceExporter({ projectId: process.env.GOOGLE_CLOUD_PROJECT })),
  });
  sdk.start();
}
