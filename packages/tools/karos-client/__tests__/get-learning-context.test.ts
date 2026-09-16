import { describe, expect, it } from "vitest";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createKarosClientTools } from "../src/index.js";
import type { LearningContext } from "../src/get-learning-context.js";

/**
 * `client.getLearningContext` — C7 (`docs/contracts/C7-run-context.md`,
 * SCRUM-458/459)'s read side. Built against hand-placed fixtures in the
 * workspace store, the way `get-context-doc.test.ts` was before its writer
 * shipped: the middleware projector (SCRUM-461) is the writer and lands
 * separately.
 */
function storeWith(records: Record<string, unknown>, opts: { throwOn?: string } = {}): WorkspaceStoreLike {
  return {
    async readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined> {
      const key = `${clientSlug}/${segments.join("/")}`;
      if (opts.throwOn && key.endsWith(opts.throwOn)) throw new Error(`boom on ${key}`);
      return records[key] as T | undefined;
    },
    async writeJson() {
      throw new Error("not used");
    },
    async listJson() {
      return [];
    },
    async exists() {
      return false;
    },
  } as unknown as WorkspaceStoreLike;
}

const CTX = { runId: "r1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" } as never;
const SOURCE = { projectedAt: "2026-09-16T09:00:00.000Z", projectedBy: "middleware-dispatch", contentHash: "sha256:abc", rows: 3 };
const envelope = (kind: string, data: unknown) => ({ kind, platform: "x", data, source: SOURCE });

async function read(store: WorkspaceStoreLike, platform = "x"): Promise<LearningContext> {
  const tools = createKarosClientTools(store);
  const outcome = await tools["client.getLearningContext"]!.execute({ platform }, { ctx: CTX });
  expect(outcome.status).toBe("success");
  if (outcome.status !== "success") throw new Error("unreachable");
  return outcome.result as LearningContext;
}

describe("client.getLearningContext (C7 §2)", () => {
  it("is registered, and an empty workspace is 'everything absent' — a success, never not_available", async () => {
    const ctx = await read(storeWith({}));
    expect(ctx.platform).toBe("x");
    expect(ctx.readiness.present).toEqual([]);
    expect(ctx.readiness.absent).toEqual(["platform-state", "subject-window", "feedback", "what-works", "strategy-map", "craft", "preferences"]);
    expect(ctx.platformState).toBeUndefined();
    expect(ctx.preferences).toBeUndefined();
  });

  it("returns each present file's `data`, keeps its provenance, and reports it present", async () => {
    const store = storeWith({
      "acme/context/learning/x/platform-state": envelope("platform-state", { postsByUs: 14, whatWorks: ["a number first"] }),
      "acme/context/learning/x/subject-window": envelope("subject-window", { windowDays: 30, rows: [{ subject: "AI pricing", stage: "expertise", status: "posted" }, { nope: true }] }),
      "acme/context/learning/x/feedback": envelope("feedback", { rows: [{ action: "skipped", reason: "too salesy" }, { noAction: 1 }] }),
      "acme/context/learning/x/strategy-map": envelope("strategy-map", { rows: [{ id: "sm-1", stage: "attention", idea: "Why intake breaks" }, { id: "broken" }] }),
      "acme/context/learning/x/craft": envelope("craft", { rules: [{ id: "L1-x-001", layer: "L1", kind: "hard", rule: "no link in the post" }, { id: "x" }], overrides: [] }),
      "acme/context/learning/preferences": { kind: "preferences", data: { neverTopics: ["pricing"] }, source: SOURCE },
    });
    const ctx = await read(store);
    expect(ctx.readiness.present).toEqual(["platform-state", "subject-window", "feedback", "strategy-map", "craft", "preferences"]);
    expect(ctx.readiness.absent).toEqual(["what-works"]);
    expect(ctx.platformState?.postsByUs).toBe(14);
    // Rows without the field the contract requires are dropped, not passed through.
    expect(ctx.subjectWindow).toEqual({ windowDays: 30, rows: [{ subject: "AI pricing", stage: "expertise", status: "posted" }] });
    expect(ctx.feedback?.rows).toEqual([{ action: "skipped", reason: "too salesy" }]);
    expect(ctx.strategyMap?.rows).toEqual([{ id: "sm-1", stage: "attention", idea: "Why intake breaks" }]);
    expect(ctx.craft?.rules).toEqual([{ id: "L1-x-001", layer: "L1", kind: "hard", rule: "no link in the post" }]);
    expect(ctx.preferences?.neverTopics).toEqual(["pricing"]);
    expect(ctx.sources["platform-state"]).toEqual(SOURCE);
    expect(ctx.sources.preferences).toEqual(SOURCE);
  });

  it("treats a malformed projection as absent — a bare array, a string, or no `data` object", async () => {
    const store = storeWith({
      "acme/context/learning/x/platform-state": ["not", "an", "envelope"],
      "acme/context/learning/x/subject-window": "just a string",
      "acme/context/learning/x/feedback": { kind: "feedback", data: null },
      "acme/context/learning/x/craft": { kind: "craft", data: [1, 2, 3] },
    });
    const ctx = await read(store);
    expect(ctx.readiness.present).toEqual([]);
    expect(ctx.readiness.absent).toHaveLength(7);
  });

  it("a store error on one file marks that file absent and still returns the others", async () => {
    const store = storeWith(
      { "acme/context/learning/preferences": { kind: "preferences", data: { neverTopics: ["politics"] }, source: SOURCE } },
      { throwOn: "x/what-works" },
    );
    const ctx = await read(store);
    expect(ctx.readiness.absent).toContain("what-works");
    expect(ctx.preferences?.neverTopics).toEqual(["politics"]);
  });

  it("reads under the platform it was asked for, and preferences from the client-wide path", async () => {
    const store = storeWith({
      "acme/context/learning/linkedin/platform-state": envelope("platform-state", { postsByUs: 2 }),
      "acme/context/learning/x/platform-state": envelope("platform-state", { postsByUs: 99 }),
    });
    const ctx = await read(store, "linkedin");
    expect(ctx.platform).toBe("linkedin");
    expect(ctx.platformState?.postsByUs).toBe(2);
  });
});
