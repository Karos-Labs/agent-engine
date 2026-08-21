import { describeError } from "./errors.js";

/**
 * Cloud Logging's own structured-log convention (https://cloud.google.com/
 * logging/docs/structured-logging#special-payload-fields): a single JSON
 * object written to stdout/stderr, with `severity` and `message` as the two
 * fields the Cloud Logging agent promotes out of the payload into the log
 * entry's own top-level `severity` and displayed text — everything else
 * rides along as `jsonPayload`, filterable in Cloud Logging / usable as the
 * source for a log-based metric.
 *
 * Cloud Run already assigns `severity: ERROR` to anything written to stderr
 * even as plain text, so a bare `console.error(string)` was never
 * unfindable — but a log-based metric that needs to distinguish "invalid
 * run-job payload" from "fatal startup error" (or search on `runId`/
 * `messageId`) needs actual structured fields, which plain text can't give
 * it. This is the one place that JSON shape gets produced, so every error
 * path in this codebase's Cloud Run services can log through it instead of
 * inventing its own ad-hoc shape.
 */
export interface StructuredLogFields {
  [key: string]: unknown;
}

function emit(severity: "ERROR" | "WARNING" | "INFO", message: string, err: unknown, fields?: StructuredLogFields): void {
  const payload: Record<string, unknown> = {
    severity,
    message,
    ...(err !== undefined ? { error: describeError(err) } : {}),
    ...fields,
  };
  // Cloud Run forwards stdout as severity DEFAULT/INFO and stderr as ERROR
  // regardless of payload content — matching that split here (rather than
  // writing every severity to the same stream) keeps the two consistent
  // instead of relying on the JSON `severity` field to override a stream
  // that already says otherwise.
  if (severity === "ERROR") {
    console.error(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}

/** Structured `severity: "ERROR"` log entry — the shape a log-based metric counting worker failures filters on. */
export function logError(message: string, err?: unknown, fields?: StructuredLogFields): void {
  emit("ERROR", message, err, fields);
}

/** Structured `severity: "WARNING"` log entry. */
export function logWarning(message: string, fields?: StructuredLogFields): void {
  emit("WARNING", message, undefined, fields);
}

/** Structured `severity: "INFO"` log entry — for parity with logError/logWarning; plain `console.log` remains fine for anything that doesn't need to be a filterable field set. */
export function logInfo(message: string, fields?: StructuredLogFields): void {
  emit("INFO", message, undefined, fields);
}
