import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";
import { logError } from "./structured-log.js";
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

/**
 * Returns a `Meter` via the OpenTelemetry API (AU42/SCRUM-326) — the metrics
 * counterpart of `getTracer()` above, with the identical no-op guarantee:
 * `metrics.getMeter()` returns the API's own no-op `Meter` until
 * `initTelemetry()` registers a real `MeterProvider`, so every counter and
 * histogram created against it before that is a cheap no-op, not a crash or
 * a buffered leak. Called fresh on every use (see `metrics.ts`) rather than
 * memoized at module scope, for the same reason `getTracer()` is: a Meter
 * fetched before `initTelemetry()` runs must not stay bound to the no-op
 * implementation for the life of the process.
 */
export function getMeter(): Meter {
  return metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
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
 * Same OTLP ingest host as traces above, `/v1/metrics` instead of
 * `/v1/traces` — Google's documented OTLP endpoint pair for Cloud
 * Trace/Cloud Monitoring (both under `telemetry.googleapis.com`), so the
 * counters and histograms `metrics.ts` records (AU42/SCRUM-326) reach Cloud
 * Monitoring the same direct-no-Collector way traces reach Cloud Trace.
 */
const TELEMETRY_OTLP_METRICS_ENDPOINT = "https://telemetry.googleapis.com/v1/metrics";

/**
 * Starts real OpenTelemetry tracing (and metrics — AU42/SCRUM-326), exporting
 * directly to Cloud Trace/Cloud Monitoring via the standard OTLP exporters —
 * no Collector, mirroring karosCMO's Phase 2 topology
 * (src/instrumentation.node.ts). No-ops without `GOOGLE_CLOUD_PROJECT` set.
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
/**
 * The resource every span and every metric point from this process is tagged
 * with.
 *
 * Exported and pure so the one attribute that is a BACKEND CONTRACT rather
 * than a nicety can be asserted by a test. `initTelemetry` itself starts a
 * real SDK against a real endpoint and cannot be exercised, which is exactly
 * how `gcp.project_id` came to be missing for months.
 *
 * `environment`: the same prep/prod signal agent-engine's own cloudbuild.yaml
 * already sets (`FIRESTORE_DATABASE_ID`), reused rather than inventing a
 * second variable, matching karosCMO's instrumentation.node.ts convention.
 */
export function telemetryResourceAttributes(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "service.name": INSTRUMENTATION_NAME,
    "deployment.environment.name": env["FIRESTORE_DATABASE_ID"] === "prep" ? "prep" : "prod",
    // REQUIRED BY GOOGLE'S OTLP **METRICS** INGEST, AND BY NOTHING ELSE.
    //
    // `telemetry.googleapis.com/v1/metrics` rejects any payload whose resource
    // lacks it, verbatim:
    //
    //   HTTP 400 — Resource is missing required attribute "gcp.project_id"
    //
    // `/v1/traces` has no such requirement, and `gcpDetector` does not supply
    // the attribute — it sets `cloud.account.id`, `cloud.platform`,
    // `faas.name`, `faas.instance` and friends, never `gcp.project_id`. So
    // traces arrived and metrics did not, in every service, in both projects,
    // for as long as this has existed: measured 2026-09-22, Cloud Monitoring
    // held ZERO descriptors matching `agent_engine` out of 1,992 in each
    // project, while Cloud Trace held traces from the same minute.
    //
    // Not a semantic-convention constant because it is not a semantic
    // convention — it is Google's own ingest contract, and a literal is the
    // honest spelling.
    "gcp.project_id": env["GOOGLE_CLOUD_PROJECT"] ?? "",
  };
}

/**
 * Makes a rejected metrics export say what the SERVER said.
 *
 * `DiagConsoleLogger` (set above) reports the exporter's own message, and for
 * an HTTP failure that message is the bare status text — `Forbidden`, and
 * nothing else. Which is progress over the silence it replaced, and still not
 * an answer: 403 does not say WHICH permission, and the response body that
 * does say is carried on the error as `data` and thrown away.
 *
 * Measured 2026-09-22: every metrics export from both prep services was
 * failing 403 while traces from the same process, on the same credentials, to
 * the same host, succeeded. Two plausible roles were granted on the strength
 * of that message and neither changed anything, because a status text cannot
 * tell you which grant you are missing. The body can.
 *
 * Wrapping `export` rather than raising the diag level to DEBUG, deliberately:
 * DEBUG turns on every internal OTel message on every tick, which is a lot of
 * noise to carry permanently for one line that matters. This logs on failure
 * only, under a stable `event` a log-based metric can count.
 */
function explainExportFailures<TExporter extends { export(batch: never, done: (result: { code: number; error?: Error }) => void): void }>(
  exporter: TExporter,
): TExporter {
  const original = exporter.export.bind(exporter);
  exporter.export = (batch: never, done: (result: { code: number; error?: Error }) => void): void => {
    original(batch, (result) => {
      if (result.error) {
        // `data` and `code` are `OTLPExporterError`'s own fields; typed
        // loosely because this must never be the thing that throws.
        const err = result.error as Error & { data?: unknown; code?: unknown };
        const body = typeof err.data === "string" ? err.data.slice(0, 600) : undefined;
        logError("telemetry: metrics export was rejected — these counters are LOST, not delayed", undefined, {
          event: "telemetry.metrics_export_failed",
          reason: err.message,
          ...(err.code !== undefined ? { status: err.code } : {}),
          ...(body !== undefined ? { body } : {}),
        });
      }
      done(result);
    });
  };
  return exporter;
}

export async function initTelemetry(): Promise<void> {
  if (started || !process.env.GOOGLE_CLOUD_PROJECT) return;
  started = true;

  const [
    { NodeSDK },
    { BatchSpanProcessor },
    { resourceFromAttributes },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { gcpDetector },
    { GoogleAuth },
    { diag, DiagConsoleLogger, DiagLogLevel },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resource-detector-gcp"),
    import("google-auth-library"),
    import("@opentelemetry/api"),
  ]);

  // AN EXPORT THAT IS REJECTED MUST SAY SO (2026-09-22).
  //
  // OpenTelemetry swallows exporter failures by design: the SDK's own
  // diagnostics go to a no-op logger unless one is set, so a backend that
  // refuses every single export looks exactly like a backend receiving them.
  // That is how the defect below survived: `telemetry.googleapis.com` was
  // answering 400 on every metrics export, for months, in both environments,
  // in complete silence.
  //
  // ERROR only — a WARNING level here is noisy on every transient retry, and
  // the thing worth waking up for is "the backend is refusing us".
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const authClient = await auth.getClient();
  // Shared by both exporters below — a fresh bearer token per export either way
  // (`getRequestHeaders()` handles the ADC cache/refresh internally), so one
  // client is enough for both.
  const authHeaders = async (): Promise<Record<string, string>> => {
    const rawHeaders = await authClient.getRequestHeaders();
    return Object.fromEntries(rawHeaders.entries());
  };

  const sdk = new NodeSDK({
    resourceDetectors: [gcpDetector],
    // `ATTR_SERVICE_NAME`/`ATTR_DEPLOYMENT_ENVIRONMENT_NAME` are asserted
    // against the constants in `telemetryResourceAttributes`' own test, so the
    // literal keys there cannot drift from the semantic conventions here.
    resource: resourceFromAttributes(telemetryResourceAttributes()),
    spanProcessor: new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: TELEMETRY_OTLP_TRACES_ENDPOINT,
        headers: authHeaders,
      }),
    ),
    // AU42/SCRUM-326: metrics alongside traces, same direct-to-Google-Cloud,
    // no-Collector topology. `PeriodicExportingMetricReader`'s default 60s
    // export interval is fine here — unlike a span (whose value is tied to one
    // request), a counter/histogram data point is meaningful as a periodic
    // aggregate, not something that needs per-event flushing.
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: explainExportFailures(
          new OTLPMetricExporter({
            url: TELEMETRY_OTLP_METRICS_ENDPOINT,
            headers: authHeaders,
          }),
        ),
      }),
    ],
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
