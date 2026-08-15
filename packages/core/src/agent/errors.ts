/**
 * Describes an error for logging/telemetry, preserving `.cause` when present
 * (RFC-01 §16.4) — a network-layer failure at the root of a cause chain must
 * stay distinguishable from the application error that wraps it, not get
 * flattened into one opaque message the way `err.message` alone would. Walks
 * the whole cause chain, not just one level.
 *
 * Duplicated (not imported) from `@agent-engine/telemetry`'s identical
 * helper — `packages/core` stays dependency-free of the telemetry package on
 * purpose, so this tiny formatting utility doesn't become the reason a
 * foundational package points "up" at an observability concern.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (err.cause === undefined) {
    return err.message;
  }
  return `${err.message} (cause: ${describeError(err.cause)})`;
}
