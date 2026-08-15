import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentContextSchema,
  AgentStepConfigSchema,
  AgentStepTelemetrySchema,
  agentExecutionResultSchema,
  GateSchema,
  GateVerdictSchema,
  ModelPolicySchema,
} from "../src/index.js";

describe("AgentContextSchema", () => {
  it("accepts a well-formed context, slotId optional", () => {
    const ctx = AgentContextSchema.parse({
      runId: "run_1",
      clientSlug: "acme",
      productId: "linkedin",
      runKind: "recurring",
      metadata: { cadenceDate: "2026-08-15" },
    });
    expect(ctx.slotId).toBeUndefined();
  });

  it("rejects an unknown runKind", () => {
    expect(() =>
      AgentContextSchema.parse({
        runId: "run_1",
        clientSlug: "acme",
        productId: "linkedin",
        runKind: "not_a_real_kind",
        metadata: {},
      }),
    ).toThrow();
  });
});

describe("ModelPolicySchema", () => {
  it("accepts a pinned policy with no fallback", () => {
    expect(() =>
      ModelPolicySchema.parse({ policy: "pinned", model: "claude-sonnet-4-6" }),
    ).not.toThrow();
  });

  it("rejects a pinned policy that declares a fallbackModel", () => {
    expect(() =>
      ModelPolicySchema.parse({
        policy: "pinned",
        model: "claude-sonnet-4-6",
        fallbackModel: "claude-haiku-4-5-20251001",
      }),
    ).toThrow(/fallbackModel is only used for/);
  });

  it("accepts a commodity policy with a fallback", () => {
    expect(() =>
      ModelPolicySchema.parse({
        policy: "commodity",
        model: "claude-haiku-4-5-20251001",
        fallbackModel: "gpt-4o-mini",
      }),
    ).not.toThrow();
  });
});

describe("GateVerdictSchema", () => {
  it("parses all three verdict shapes", () => {
    expect(
      GateVerdictSchema.parse({ verdict: "pass", evidence: ["ok"], toolVersion: "1.0.0" }).verdict,
    ).toBe("pass");
    expect(
      GateVerdictSchema.parse({
        verdict: "content_fail",
        evidence: ["banned word"],
        reason: "contains a banned word",
        toolVersion: "1.0.0",
      }).verdict,
    ).toBe("content_fail");
    expect(
      GateVerdictSchema.parse({ verdict: "tooling_error", reason: "timeout", toolVersion: "1.0.0" }).verdict,
    ).toBe("tooling_error");
  });

  it("rejects a content_fail verdict missing its reason", () => {
    expect(() =>
      GateVerdictSchema.parse({ verdict: "content_fail", evidence: [], toolVersion: "1.0.0" }),
    ).toThrow();
  });
});

describe("GateSchema", () => {
  const baseGate = {
    kind: "batch_review" as const,
    runId: "run_1",
    payload: { batchId: "b1" },
    requiredRole: "account_manager",
    timeout: { duration: "24h", onTimeout: "escalate" as const },
  };

  it("requires a reason when the response is a rejection", () => {
    expect(() =>
      GateSchema.parse({
        ...baseGate,
        response: { decision: "reject", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" },
      }),
    ).toThrow(/reason is mandatory/);
  });

  it("allows an approval with no reason", () => {
    expect(() =>
      GateSchema.parse({
        ...baseGate,
        response: { decision: "approve", actor: "jane@karoslabs.com", at: "2026-08-15T00:00:00Z" },
      }),
    ).not.toThrow();
  });

  it("allows a rejection that includes a reason", () => {
    expect(() =>
      GateSchema.parse({
        ...baseGate,
        response: {
          decision: "reject",
          actor: "jane@karoslabs.com",
          reason: "voice mismatch",
          at: "2026-08-15T00:00:00Z",
        },
      }),
    ).not.toThrow();
  });
});

describe("AgentStepConfigSchema", () => {
  it("validates the static shape and defaults maxSteps to 8", () => {
    const parsed = AgentStepConfigSchema.parse({
      id: "draft-post",
      description: "Draft a LinkedIn post",
      allowedTools: ["research.pull", "gate.brandCompliance"],
      outputSchema: z.object({ body: z.string() }),
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    });
    expect(parsed.maxSteps).toBe(8);
  });

  it("rejects an outputSchema that isn't a Zod schema", () => {
    expect(() =>
      AgentStepConfigSchema.parse({
        id: "draft-post",
        description: "Draft a LinkedIn post",
        allowedTools: ["research.pull"],
        outputSchema: { not: "a schema" },
        modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      }),
    ).toThrow();
  });
});

describe("agentExecutionResultSchema", () => {
  it("validates finalOutput against the step's own output schema", () => {
    const DraftOutput = z.object({ body: z.string() });
    const schema = agentExecutionResultSchema(DraftOutput);

    const telemetry = AgentStepTelemetrySchema.parse({
      stepIndex: 0,
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: 100, uncached: 50 },
      outputTokens: 200,
      durationMs: 1200,
      costUsd: 0.0042,
      status: "success",
    });

    expect(() =>
      schema.parse({
        finalOutput: { body: "hello" },
        steps: [telemetry],
        totalCostUsd: 0.0042,
        totalTokens: { input: 150, output: 200 },
        status: "completed",
      }),
    ).not.toThrow();

    expect(() =>
      schema.parse({
        finalOutput: { body: 42 },
        steps: [telemetry],
        totalCostUsd: 0.0042,
        totalTokens: { input: 150, output: 200 },
        status: "completed",
      }),
    ).toThrow();
  });
});
