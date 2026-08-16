import { Router } from "express";

/** `GET /healthz` — Cloud Run's readiness/liveness probe target. No dependency checks: this only proves the process is up and serving requests. */
export function createHealthRouter(): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: (Date.now() - startedAt) / 1000 });
  });

  return router;
}
