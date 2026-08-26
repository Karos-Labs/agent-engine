import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { logError } from "@agent-engine/telemetry";

/**
 * Answers a failed request with a generic message plus a correlation id, and
 * puts the real detail in the server log under that same id (AU1 / SCRUM-287).
 *
 * The detail these paths used to return — `err.message`, often a
 * `describeError` walk of a whole `.cause` chain — is genuinely useful, and
 * genuinely not the caller's. It names internal store paths, upstream vendor
 * responses, and configuration state, and on the authentication paths it tells
 * an unauthenticated caller which part of their token was wrong. The
 * correlation id keeps a support conversation possible ("give me the id in
 * your error") without putting any of that on the wire.
 */
export function respondInternalError(res: Response, context: string, err: unknown): void {
  const correlationId = randomUUID();
  logError(context, err, { correlationId });
  res.status(500).json({ error: "internal error", correlationId });
}

/** Same trade for a non-500: a generic client-safe reason on the wire, the real one in the log. */
export function respondWithLoggedDetail(res: Response, status: number, clientError: string, context: string, err: unknown): void {
  const correlationId = randomUUID();
  logError(context, err, { correlationId });
  res.status(status).json({ error: clientError, correlationId });
}
