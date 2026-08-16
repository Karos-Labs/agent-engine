import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "../openapi.js";

/** `GET /openapi.json` (the raw spec) and `GET /docs` (Swagger UI rendering it) — RFC-01 §7/§8's HTTP surface, documented for local/manual exploration. */
export function createDocsRouter(): Router {
  const router = Router();

  router.get("/openapi.json", (_req, res) => {
    res.status(200).json(openApiDocument);
  });

  router.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  return router;
}
