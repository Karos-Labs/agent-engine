import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentContext } from "@agent-engine/core";
import { defineTool } from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("defineTool", () => {
  it("passes validated args through to execute", async () => {
    const tool = defineTool({
      name: "test.echo",
      description: "Test double: echoes text back.",
      version: "1.0.0",
      inputSchema: z.object({ text: z.string() }),
      async execute(args) {
        return { status: "success", result: { echoed: args.text } };
      },
    });

    const outcome = await tool.execute({ text: "hi" }, { ctx });
    expect(outcome).toEqual({ status: "success", result: { echoed: "hi" } });
  });

  it("returns tooling_error, not a thrown exception, when args fail the input schema", async () => {
    const tool = defineTool({
      name: "test.echo",
      description: "Test double: echoes text back.",
      version: "1.0.0",
      inputSchema: z.object({ text: z.string() }),
      async execute(args) {
        return { status: "success", result: { echoed: args.text } };
      },
    });

    const outcome = await tool.execute({ text: 42 } as never, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("strips a model-supplied tenant field that isn't part of the schema", async () => {
    const tool = defineTool({
      name: "test.echo",
      description: "Test double: echoes text back.",
      version: "1.0.0",
      inputSchema: z.object({ text: z.string() }),
      async execute(args) {
        // `args` is typed from the schema alone — a stray clientSlug can't even compile in, let alone survive at runtime.
        return { status: "success", result: args };
      },
    });

    const outcome = await tool.execute({ text: "hi", clientSlug: "attacker-corp" } as never, { ctx });
    expect(outcome).toEqual({ status: "success", result: { text: "hi" } });
  });

  it("converts a thrown error into tooling_error instead of an unhandled rejection", async () => {
    const tool = defineTool({
      name: "test.boom",
      description: "Test double: always throws.",
      version: "1.0.0",
      inputSchema: z.object({}),
      async execute() {
        throw new Error("disk on fire");
      },
    });

    const outcome = await tool.execute({}, { ctx });
    expect(outcome).toEqual({ status: "tooling_error", reason: expect.stringContaining("disk on fire") });
  });

  it("preserves err.cause in the reported reason, not just the top-level message (RFC-01 §16.4)", async () => {
    const tool = defineTool({
      name: "test.boom",
      description: "Test double: always throws, with a cause.",
      version: "1.0.0",
      inputSchema: z.object({}),
      async execute() {
        const networkError = new Error("ECONNRESET");
        throw new Error("fetch failed", { cause: networkError });
      },
    });

    const outcome = await tool.execute({}, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect(outcome.status === "tooling_error" ? outcome.reason : "").toMatch(/fetch failed \(cause: ECONNRESET\)/);
  });

  it("passes content_fail and not_available outcomes through unchanged", async () => {
    const tool = defineTool({
      name: "test.judge",
      description: "Test double: returns content_fail or not_available depending on input.",
      version: "1.0.0",
      inputSchema: z.object({ verdict: z.enum(["fail", "missing"]) }),
      async execute(args) {
        if (args.verdict === "fail") return { status: "content_fail", reason: "bad content" };
        return { status: "not_available", reason: "not run yet" };
      },
    });

    expect(await tool.execute({ verdict: "fail" }, { ctx })).toEqual({ status: "content_fail", reason: "bad content" });
    expect(await tool.execute({ verdict: "missing" }, { ctx })).toEqual({ status: "not_available", reason: "not run yet" });
  });
});
