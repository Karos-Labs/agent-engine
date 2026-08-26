import { Router } from "express";
import { buildCapabilityReport } from "@agent-engine/core";

/**
 * `GET /api/v1/diagnostics/capabilities` (AU55 / SCRUM-354).
 *
 * One row per capability: what it is, whether it is ACTIVE / DEGRADED /
 * DISABLED in THIS environment, which variable decides that, what happens
 * instead, and whether anyone decided it on purpose.
 *
 * UNEXPLAINED rows sort first. That ordering is the entire point: a key absent
 * with no recorded reason is a question nobody has been asked yet, and the
 * report exists so it can be answered — issue a key, or delete the feature —
 * without opening the codebase.
 *
 * Reads only the process environment, so it is safe to call at any time and
 * reports the environment as it actually is rather than as configuration files
 * claim it should be.
 *
 * Mounted BEHIND the authentication middleware: the report names every
 * variable this deployment does and does not have, which is a useful map for
 * anyone deciding what to attack.
 */
export function createDiagnosticsRouter(env: Record<string, string | undefined> = process.env): Router {
  const router = Router();

  router.get("/api/v1/diagnostics/capabilities", (_req, res) => {
    res.status(200).json(buildCapabilityReport(env));
  });

  return router;
}
