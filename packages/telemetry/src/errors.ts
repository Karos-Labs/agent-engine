/**
 * Describes an error for logging/telemetry, preserving `.cause` when present
 * (RFC-01 §16.4) — a network-layer failure at the root of a cause chain must
 * stay distinguishable from the application error that wraps it, not get
 * flattened into one opaque message the way `err.message` alone would. Walks
 * the whole cause chain, not just one level.
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
