import { Router } from "express";
import { buildCapabilityReport } from "@agent-engine/core";
import { telemetrySinkHealth } from "@agent-engine/telemetry";

/**
 * `GET /api/v1/diagnostics/capabilities` (AU55 / SCRUM-354, the capability-by-product work — shipped without a Jira ticket).
 *
 * Two levels, and the second one is the one to read first.
 *
 * `products` (the capability-by-product work) answers the question anyone actually has: can this agent
 * produce its deliverable here, and if not, is that something to configure or
 * something to build. One line per product —
 * `branded-shorts-agent: UNRUNNABLE — render engine pending development
 * (SCRUM-362)` — because four individually-correct capability rows never added
 * up, on the page, to "the whole video line is dead".
 *
 * `capabilities` is the per-key detail underneath: what each capability is,
 * whether it is ACTIVE / DEGRADED / DISABLED / PENDING_BUILD in THIS
 * environment, which variable decides that, what happens instead, and whether
 * anyone decided it on purpose. It is correct; it is just not the level anyone
 * decides at.
 *
 * UNEXPLAINED rows sort first. That ordering is the entire point: a key absent
 * with no recorded reason is a question nobody has been asked yet, and the
 * report exists so it can be answered — issue a key, or delete the feature —
 * without opening the codebase. PENDING_BUILD is deliberately NOT in that
 * list: scheduled work is a decision already made, and letting it in would
 * make UNEXPLAINED mean two things instead of one.
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
    // AU72 / SCRUM-372: the capability report answers "what is switched off",
    // and a telemetry sink that is denied at every write is switched off in
    // every sense that matters — it just isn't switched off by a MISSING
    // VARIABLE, so the catalogue could never see it. Production wrote zero
    // rows for its entire life and every deploy reported success.
    //
    // `telemetrySink` is runtime health rather than configuration, so it sits
    // beside the catalogue rather than inside it: a row in `capabilities`
    // would have to claim an env var decides it, and none does.
    res.status(200).json({ ...buildCapabilityReport(env), telemetrySink: telemetrySinkHealth() });
  });

  return router;
}
