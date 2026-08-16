/**
 * Hand-authored OpenAPI 3.0.3 document for apps/agent-server's HTTP surface
 * (RFC-01 §7, §8). Kept as a plain literal rather than generated from the
 * Zod schemas in routes/*.ts — those schemas are small and stable enough
 * that a generator (e.g. zod-to-openapi) would add a dependency without
 * saving meaningful maintenance, and a literal lets every productId get its
 * own realistic request example (RFC-02's six products) instead of one
 * generic one.
 */

/** Loosely typed on purpose — this is a static JSON document, not domain logic; a full OpenAPI type package isn't worth the dependency for one literal. */
export type OpenApiDocument = Record<string, unknown>;

const dynamicAgentRunStepSchema = {
  type: "object",
  required: ["stepId", "type", "label", "status", "durationMs"],
  properties: {
    stepId: { type: "string" },
    type: { type: "string", enum: ["ai", "code"] },
    label: { type: "string" },
    status: { type: "string", enum: ["done", "failed"], description: "Binary by design (RFC-01 §7.2) — agent-engine's richer taxonomy collapses to this, with detail in `error`." },
    durationMs: { type: "number" },
    model: { type: "string", description: "Concrete model this step ran on (AI steps only)." },
    error: { type: "string", description: "Raw engine diagnostic — never render this directly to an end user." },
    costUsd: { type: "number" },
    tokensIn: {
      type: "object",
      properties: { cached: { type: "number" }, uncached: { type: "number" } },
    },
    tokensOut: { type: "number" },
  },
};

const dynamicAgentRunReportSchema = {
  type: "object",
  required: ["specId", "specVersion", "steps"],
  properties: {
    specId: { type: "string" },
    specVersion: { type: "number" },
    steps: { type: "array", items: { $ref: "#/components/schemas/DynamicAgentRunStep" } },
    failedStepId: { type: "string" },
    failedStepIndex: { type: "number" },
    hasPartialOutput: { type: "boolean" },
    domainOutcome: {
      type: "string",
      enum: ["delivered", "held", "blocked_intake"],
      description: "RFC-01 §16.2 — present only once the run resolves to completed/held/blocked_intake.",
    },
    domainOutcomeReason: { type: "string" },
  },
};

const runResponseSchema = {
  type: "object",
  required: ["runId", "status", "report"],
  properties: {
    runId: { type: "string" },
    status: {
      type: "string",
      enum: ["running", "completed", "failed", "degraded", "awaiting_gate", "held", "blocked_intake"],
    },
    pendingGateId: { type: "string", description: "Present only when status is \"awaiting_gate\"." },
    report: { $ref: "#/components/schemas/DynamicAgentRunReport" },
  },
};

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    details: { type: "array", items: { type: "object" }, description: "Zod issue list, present on 400 validation errors." },
  },
};

const startRunRequestSchema = {
  type: "object",
  required: ["clientSlug", "productId", "runKind"],
  properties: {
    clientSlug: { type: "string", minLength: 1 },
    productId: {
      type: "string",
      enum: ["x-agent", "linkedin-agent", "reddit-agent", "blog-agent", "newsletter-agent", "campaign-orchestrator"],
    },
    runKind: { type: "string", enum: ["setup", "recurring", "manager", "orchestrator"] },
    inputParams: {
      type: "object",
      additionalProperties: true,
      description: "Accepted for forward compatibility with the Portal's request shape; not currently consumed by any of the six workflow factories.",
    },
    specId: { type: "string" },
  },
};

const resumeRunRequestSchema = {
  type: "object",
  required: ["gateId", "resolution"],
  properties: {
    gateId: { type: "string", minLength: 1 },
    resolution: {
      type: "object",
      required: ["decision", "actor"],
      properties: {
        decision: { type: "string", enum: ["approve", "reject"] },
        actor: { type: "string", minLength: 1 },
        notes: { type: "string", description: "Mandatory in practice when decision is \"reject\" (RFC-01 §8.3)." },
      },
    },
  },
};

/** One realistic /api/v1/runs/start request body per RFC-02 product. */
const startRunExamples: Record<string, { summary: string; value: Record<string, unknown> }> = {
  "x-agent": {
    summary: "Start a recurring X (Twitter) draft run",
    value: { clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
  },
  "linkedin-agent": {
    summary: "Start a recurring LinkedIn draft run",
    value: { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" },
  },
  "reddit-agent": {
    summary: "Start a recurring Reddit draft run",
    value: { clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" },
  },
  "blog-agent": {
    summary: "Start a recurring blog draft run",
    value: { clientSlug: "acme", productId: "blog-agent", runKind: "recurring" },
  },
  "newsletter-agent": {
    summary: "Start a recurring newsletter draft run",
    value: { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" },
  },
  "campaign-orchestrator": {
    summary: "Start a campaign run (fans out across all five channels, pauses at a human review gate)",
    value: { clientSlug: "acme", productId: "campaign-orchestrator", runKind: "orchestrator" },
  },
};

export const openApiDocument: OpenApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "agent-engine Agent Server API",
    version: "0.0.1",
    description:
      "Cloud Run HTTP entrypoint (RFC-01 §7, §8; RFC-02): receives run-execution requests from karosCMO/Portal, dispatches to the right agent workflow by productId, and returns run status / DynamicAgentRunReport.",
  },
  servers: [{ url: "/", description: "Current host" }],
  tags: [
    { name: "health", description: "Liveness/readiness" },
    { name: "runs", description: "Start, resume, and check the status of an agent run" },
  ],
  paths: {
    "/healthz": {
      get: {
        tags: ["health"],
        summary: "Liveness/readiness probe",
        description: "Cloud Run's readiness/liveness probe target. Proves only that the process is up and serving requests — no dependency checks.",
        responses: {
          "200": {
            description: "The server is up.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "uptime"],
                  properties: { status: { type: "string", enum: ["ok"] }, uptime: { type: "number", description: "Seconds since process start." } },
                },
                example: { status: "ok", uptime: 12.4 },
              },
            },
          },
        },
      },
    },
    "/api/v1/runs/start": {
      post: {
        tags: ["runs"],
        summary: "Start a new agent run",
        description:
          "Dispatches to the workflow for the given productId and runs it synchronously until it either completes or pauses at a human gate (e.g. the campaign orchestrator's campaign-review gate).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/StartRunRequest" },
              examples: startRunExamples,
            },
          },
        },
        responses: {
          "201": {
            description: "The run was created and executed (possibly pausing at a gate).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RunResponse" } } },
          },
          "400": {
            description: "Invalid request body (bad shape, or an unrecognized productId).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "500": {
            description: "The run failed unexpectedly.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
    "/api/v1/runs/{runId}/resume": {
      post: {
        tags: ["runs"],
        summary: "Resolve a pending human gate and resume a run",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResumeRunRequest" },
              example: { gateId: "13-campaign-review", resolution: { decision: "approve", actor: "jane@karoslabs.com" } },
            },
          },
        },
        responses: {
          "200": {
            description: "The gate was resolved and the run resumed (possibly pausing again at a later gate).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RunResponse" } } },
          },
          "400": {
            description: "Invalid request body, or an invalid gate resolution (e.g. a reject with no reason).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "404": {
            description: "No run found for this runId.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "500": {
            description: "The resume failed unexpectedly.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
    "/api/v1/runs/{runId}/status": {
      get: {
        tags: ["runs"],
        summary: "Get the current status and report for a run",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The run's current status and DynamicAgentRunReport.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/RunResponse" } } },
          },
          "404": {
            description: "No run found for this runId.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      StartRunRequest: startRunRequestSchema,
      ResumeRunRequest: resumeRunRequestSchema,
      RunResponse: runResponseSchema,
      DynamicAgentRunReport: dynamicAgentRunReportSchema,
      DynamicAgentRunStep: dynamicAgentRunStepSchema,
      ErrorResponse: errorResponseSchema,
    },
  },
};
