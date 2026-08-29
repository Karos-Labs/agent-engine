import type { NextFunction, Request, RequestHandler, Response } from "express";
import { withHttpRequestSpan } from "@agent-engine/telemetry";

/**
 * Express middleware opening the top-of-trace HTTP request span (AU42/
 * SCRUM-326) — the "HTTP request" half of "a full trace from HTTP request →
 * run → steps → tool calls → model calls" this ticket exists to complete.
 *
 * All the actual span/context logic lives in `@agent-engine/telemetry`'s
 * `withHttpRequestSpan`, which is Express-agnostic (a structurally-typed
 * request/response shape, no `express` dependency of its own) — this is just
 * the one-line adapter that lets `createApp` mount it as an ordinary
 * `RequestHandler`.
 *
 * Mounted FIRST in `app.ts`, before the health check and every router: every
 * request this service handles — including ones that never reach an
 * authenticated route — gets a span, so a 401/404 shows up in traces exactly
 * as it shows up to a caller.
 */
export function httpTracingMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    withHttpRequestSpan(req, res, next);
  };
}
