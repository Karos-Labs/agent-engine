import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput } from "@agent-engine/core";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

function validAgentInput(agentId: string): AgentDefinitionInput {
  return {
    agentId,
    name: "Test Agent",
    description: "A dynamic agent used for route tests",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        id: "stage-1",
        description: "first stage",
        allowedTools: [],
        outputSchema: [{ name: "result", type: "string", optional: false }],
      },
    ],
  };
}

describe("/api/agents (Task 2)", () => {
  let env: TestEnvironment;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    app = createApp({ durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, agentDefinitionStore: new MemoryAgentDefinitionStore() });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("POST creates a new agent definition and GET lists/fetches it", async () => {
    const created = await request(app).post("/api/agents").send(validAgentInput("my-agent"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agentId: "my-agent", version: 1 });

    const fetched = await request(app).get("/api/agents/my-agent");
    expect(fetched.status).toBe(200);
    expect(fetched.body.name).toBe("Test Agent");

    const listed = await request(app).get("/api/agents");
    expect(listed.status).toBe(200);
    expect(listed.body.agents.map((a: { agentId: string }) => a.agentId)).toContain("my-agent");
  });

  it("POST rejects a duplicate agentId with 409", async () => {
    await request(app).post("/api/agents").send(validAgentInput("dup-agent"));
    const second = await request(app).post("/api/agents").send(validAgentInput("dup-agent"));
    expect(second.status).toBe(409);
  });

  it("POST rejects an invalid definition with 400", async () => {
    const res = await request(app).post("/api/agents").send({ agentId: "bad-agent" }); // missing required fields
    expect(res.status).toBe(400);
  });

  it("GET /:agentId 404s for an unregistered id", async () => {
    const res = await request(app).get("/api/agents/nope");
    expect(res.status).toBe(404);
  });

  it("PUT updates an existing definition, bumping version, URL id wins over any body agentId", async () => {
    await request(app).post("/api/agents").send(validAgentInput("editable-agent"));
    const updated = await request(app)
      .put("/api/agents/editable-agent")
      .send({ ...validAgentInput("some-other-id"), description: "an updated description" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ agentId: "editable-agent", version: 2, description: "an updated description" });
  });

  it("PUT 404s for an id that was never created", async () => {
    const res = await request(app).put("/api/agents/never-created").send(validAgentInput("never-created"));
    expect(res.status).toBe(404);
  });
});
