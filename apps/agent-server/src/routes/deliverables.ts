import { Router } from "express";
import type { DurableStepStore } from "@agent-engine/workflow";
import type { WorkspaceStoreLike } from "@agent-engine/tools";

export interface DeliverablesRouterDeps {
  durableStore: DurableStepStore;
  workspaceStore: WorkspaceStoreLike;
}

/**
 * `GET /api/v1/runs/:runId/deliverables/:kind` — the missing retrieval
 * half of `ledger.writeDeliverable` (Task 1's plumbing): today nothing in
 * this server exposes a run's actual deliverable content over HTTP at
 * all — `agentEngineRuns/{runId}` and its `steps` subcollection hold only
 * run/step metadata and cost/usage (`buildRunReport` strips `StepRecord.
 * output` down to a status marker), and the real content lives only in the
 * workspace store at `clients/{clientSlug}/ledger/deliverables/{runId}/_/
 * {kind}.json` (GCS in a real deployment, local disk otherwise) with no
 * HTTP door onto it. `clientSlug` is recovered from the run record itself
 * — a caller only needs to know `runId` and which `kind` it wrote
 * (`ledger.writeDeliverable`'s own `kind` argument, e.g. "seo-geo-report",
 * "intel-report") — so this only ever reads a path implied by data this
 * server already owns, never an arbitrary caller-supplied client/path.
 */
export function createDeliverablesRouter(deps: DeliverablesRouterDeps): Router {
  const router = Router();

  router.get("/api/v1/runs/:runId/deliverables/:kind", async (req, res) => {
    const { runId, kind } = req.params as { runId: string; kind: string };

    const runRecord = await deps.durableStore.getRun(runId);
    if (!runRecord) {
      res.status(404).json({ error: `no run found for "${runId}"` });
      return;
    }

    const record = await deps.workspaceStore.readJson<unknown>(runRecord.clientSlug, ["ledger", "deliverables", runId, "_", kind]);
    if (record === undefined) {
      res.status(404).json({ error: `no deliverable of kind "${kind}" found for run "${runId}"` });
      return;
    }

    res.status(200).json(record);
  });

  return router;
}
