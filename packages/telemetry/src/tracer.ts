import { trace, type Tracer } from "@opentelemetry/api";
// Type-only: erased at compile time, so this does not pull the OTel SDK
// dependency graph into every workspace that imports this module the way a
// runtime import would — see the `started` comment below for why that matters.
import type { NodeSDK } from "@opentelemetry/sdk-node";

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
/** Set by `initTelemetry()` so `shutdownTelemetry()` has something to flush. */
let sdkInstance: NodeSDK | null = null;

/**
 * Google Cloud's native OTLP endpoint for Cloud Trace — the replacement for
 * the archived `@google-cloud/opentelemetry-cloud-trace-exporter` package
 * (deprecated, archived after 2026-10-30; see
 * https://github.com/GoogleCloudPlatform/opentelemetry-operations-js/blob/main/MIGRATION.md).
 * Still direct-to-Cloud-Trace, no Collector (Phase 2 plan decision).
 */
const TELEMETRY_OTLP_TRACES_ENDPOINT = "https://telemetry.googleapis.com/v1/traces";

/**
 * Starts real OpenTelemetry tracing, exporting directly to Cloud Trace via
 * the standard OTLP exporter — no Collector, mirroring karosCMO's Phase 2
 * topology (src/instrumentation.node.ts). No-ops without
 * `GOOGLE_CLOUD_PROJECT` set.
 *
 * A standard OTLP exporter has no built-in notion of Google credentials
 * (unlike the old TraceExporter) — the migration guide's documented pattern
 * is an async `headers()` callback that re-fetches a fresh bearer token from
 * ADC on every export (tokens expire hourly; `authClient.getRequestHeaders()`
 * handles the caching/refresh internally, so `getClient()` is only called
 * once here).
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

  const [
    { NodeSDK },
    { BatchSpanProcessor },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_DEPLOYMENT_ENVIRONMENT_NAME },
    { OTLPTraceExporter },
    { gcpDetector },
    { GoogleAuth },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/resource-detector-gcp"),
    import("google-auth-library"),
  ]);

  // Same prep/prod signal agent-engine's own cloudbuild.yaml already sets
  // (FIRESTORE_DATABASE_ID: "(default)" for prod, "prep" for prep) — reused
  // rather than inventing a second environment variable, matching karosCMO's
  // instrumentation.node.ts convention.
  const environment = process.env.FIRESTORE_DATABASE_ID === "prep" ? "prep" : "prod";

  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const authClient = await auth.getClient();

  const sdk = new NodeSDK({
    resourceDetectors: [gcpDetector],
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: INSTRUMENTATION_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
    }),
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: TELEMETRY_OTLP_TRACES_ENDPOINT,
        async headers(): Promise<Record<string, string>> {
          const rawHeaders = await authClient.getRequestHeaders();
          return Object.fromEntries(rawHeaders.entries());
        },
      }),
    ),
  });
  sdk.start();
  sdkInstance = sdk;
}

/**
 * Flushes and shuts down the SDK started by `initTelemetry()`, if any.
 * `BatchSpanProcessor` buffers spans for ~5s before exporting — without an
 * explicit shutdown, whatever a Cloud Run/agent-server instance was doing
 * when it received SIGTERM (disproportionately the spans worth having) is
 * still sitting in that buffer and is lost when the process exits. A no-op
 * when telemetry was never started (no `GOOGLE_CLOUD_PROJECT`, or called
 * from a context — tests, tooling — that never called `initTelemetry`).
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdkInstance) return;
  await sdkInstance.shutdown();
}
