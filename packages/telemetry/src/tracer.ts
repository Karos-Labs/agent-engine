import { trace, type Tracer } from "@opentelemetry/api";

const INSTRUMENTATION_NAME = "agent-engine";
const INSTRUMENTATION_VERSION = "0.0.1";

/**
 * Returns a `Tracer` via the OpenTelemetry API. When no `TracerProvider` has
 * been registered (the default until a real OTel SDK is wired up, e.g. in
 * `infra/`), `trace.getTracer()` returns the API's own no-op tracer — a real
 * object satisfying the full `Span` interface, but every method on it is a
 * cheap no-op. This is what makes every helper in this package "zero-overhead
 * no-op tracing when a tracer is not configured" (RFC-01 §11) without any
 * conditional logic of our own — the OTel API guarantees it structurally.
 */
export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}
