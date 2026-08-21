import { Router } from "express";
import { AgentDefinitionInputSchema, type AgentDefinitionStore } from "@agent-engine/core";

export interface AgentsRouterDeps {
  agentDefinitionStore: AgentDefinitionStore;
}

/**
 * `/api/agents` — dynamic agent definition CRUD (Task 2). Persists to
 * `agentDefinitions/{agentId}` (via whichever `AgentDefinitionStore` the
 * composition root configured — `wiring/agent-definitions-store.ts`) and,
 * once created, `agentId` is immediately dispatchable as a `productId` on
 * `/runs/start` (or a Pub/Sub-published run) exactly like the 12
 * hand-written products — `run-job.ts`'s `resolveWorkflowFn` checks this
 * store as its fallback for any `productId` that isn't one of those 12.
 */
export function createAgentsRouter(deps: AgentsRouterDeps): Router {
  const router = Router();

  router.get("/api/agents", async (_req, res) => {
    const agents = await deps.agentDefinitionStore.list();
    res.status(200).json({ agents });
  });

  router.get("/api/agents/:agentId", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const definition = await deps.agentDefinitionStore.get(agentId);
    if (!definition) {
      res.status(404).json({ error: `no agent definition found for "${agentId}"` });
      return;
    }
    res.status(200).json(definition);
  });

  router.post("/api/agents", async (req, res) => {
    const parsed = AgentDefinitionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid agent definition", details: parsed.error.issues });
      return;
    }
    const result = await deps.agentDefinitionStore.upsert(parsed.data.agentId, parsed.data, { expectExisting: false });
    if (result.outcome === "created") {
      res.status(201).json(result.definition);
      return;
    }
    res.status(409).json({ error: `an agent definition already exists for "${parsed.data.agentId}" — use PUT to update it` });
  });

  // Full-document replace, not a partial patch — the URL's :agentId always wins over
  // whatever (if anything) the body itself names, matching PUT's own "replace this
  // resource" semantics rather than PATCH's merge semantics.
  router.put("/api/agents/:agentId", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const parsed = AgentDefinitionInputSchema.safeParse({ ...(req.body as Record<string, unknown>), agentId });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid agent definition", details: parsed.error.issues });
      return;
    }
    const result = await deps.agentDefinitionStore.upsert(agentId, parsed.data, { expectExisting: true });
    if (result.outcome === "updated") {
      res.status(200).json(result.definition);
      return;
    }
    res.status(404).json({ error: `no agent definition found for "${agentId}" — use POST to create it` });
  });

  return router;
}
