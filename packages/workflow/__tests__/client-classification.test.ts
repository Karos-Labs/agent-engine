import { describe, expect, it } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import {
  CLASSIFICATION_BELIEF_KEY,
  classificationFromModel,
  classifierEvidence,
  readClassification,
  researchClassificationFor,
  resolveClientClassification,
  type ClientClassification,
} from "../src/index.js";
import type { WorkflowContext } from "../src/primitives/context.js";

const NOW = new Date("2026-09-25T12:00:00Z");

function tool(name: string, execute: (args: unknown) => unknown) {
  return { name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v }, execute: async (args: unknown) => execute(args) } as never;
}

function harness(options: { slug: string; profile?: Record<string, unknown>; beliefs?: Record<string, unknown>; model?: unknown; modelStatus?: string }) {
  const writes: Array<Record<string, unknown>> = [];
  const steps: string[] = [];
  const tools: AgentToolRegistry = {
    "client.getProfile": tool("client.getProfile", () => (options.profile !== undefined ? { status: "success", result: options.profile } : { status: "not_available", reason: "none" })),
    "client.getConfig": tool("client.getConfig", () => ({ status: "success", result: {} })),
    "client.getBrand": tool("client.getBrand", () => ({ status: "success", result: {} })),
    "memory.read": tool("memory.read", () => ({ status: "success", result: { beliefs: options.beliefs ?? {} } })),
    ...(options.model !== undefined
      ? { "media.classifyClient": tool("media.classifyClient", () => (options.modelStatus === "tooling_error" ? { status: "tooling_error", reason: "down" } : { status: "success", result: options.model })) }
      : {}),
    "memory.updateBeliefs": tool("memory.updateBeliefs", (args) => {
      writes.push((args as { diff: Record<string, unknown> }).diff);
      return { status: "success", result: {} };
    }),
  };
  const wf = {
    runId: "r1",
    clientSlug: options.slug,
    productId: "instagram-agent",
    runKind: "recurring",
    step: {
      code: async (id: string, fn: () => unknown) => {
        steps.push(id);
        return fn();
      },
      agent: async () => {
        throw new Error("the classification never runs an agent turn");
      },
    },
  } as unknown as WorkflowContext;
  return { wf, tools, writes, steps, deps: { tools } };
}

const record = (over: Partial<ClientClassification> = {}): ClientClassification => ({
  archetype: "brand",
  category: "fashion-intimates",
  involvement: "low",
  audience: "B2C",
  locale: "en",
  rationale: {},
  source: "staff",
  classifiedAt: NOW.toISOString(),
  version: 1,
  ...over,
});

describe("resolveClientClassification", () => {
  it("a staff record on the profile wins, and nothing is paid or written", async () => {
    const h = harness({ slug: "acme", profile: { classification: record({ archetype: "place" }) }, beliefs: { [CLASSIFICATION_BELIEF_KEY]: record() } });
    const out = await resolveClientClassification(h.wf, h.deps, { now: () => NOW });
    expect(out.origin).toBe("profile");
    expect(out.classification?.archetype).toBe("place");
    expect(h.steps).toEqual(["00a2-read-client-classification"]);
    expect(h.writes).toEqual([]);
  });

  it("a stored belief is reused without a model call", async () => {
    const h = harness({ slug: "acme", profile: { name: "Acme" }, beliefs: { [CLASSIFICATION_BELIEF_KEY]: record({ source: "classifier" }) } });
    const out = await resolveClientClassification(h.wf, h.deps, { now: () => NOW });
    expect(out.origin).toBe("belief");
    expect(h.steps).not.toContain("00a21-classify-client");
  });

  it("the approved research record seeds the nine studied clients, once, as a belief", async () => {
    const h = harness({ slug: "xodigital", profile: { name: "XO" } });
    const out = await resolveClientClassification(h.wf, h.deps, { now: () => NOW });
    expect(out.origin).toBe("research");
    expect(out.classification).toMatchObject({ archetype: "platform", category: "personal-finance-investing", involvement: "high", locale: "pt-BR" });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.[CLASSIFICATION_BELIEF_KEY]).toMatchObject({ source: "research-2026-09-25" });
  });

  it("a new client is classified automatically by one model call and the answer is stored", async () => {
    const h = harness({
      slug: "newclient",
      profile: { name: "Trattoria Uno", industry: "Restaurant", description: "A family trattoria in Lisbon" },
      model: { archetype: "place", category: "Food & Restaurants", involvement: "low", audience: "B2C", locale: "en", archetypeReason: "a venue" },
    });
    const out = await resolveClientClassification(h.wf, h.deps, { now: () => NOW });
    expect(out.origin).toBe("classifier");
    expect(out.classification).toMatchObject({ archetype: "place", category: "food-restaurants", source: "classifier", rationale: { archetype: "a venue" } });
    expect(h.steps).toEqual(["00a2-read-client-classification", "00a21-classify-client", "00a22-persist-client-classification"]);
    expect(h.writes).toHaveLength(1);
  });

  it("a deployment without the classifier tool is unconfigured: unclassified, nothing written", async () => {
    const h = harness({ slug: "newclient", profile: { name: "Trattoria Uno", industry: "Restaurant" } });
    const out = await resolveClientClassification(h.wf, h.deps, { now: () => NOW });
    expect(out.classification).toBeUndefined();
    expect(out.notes.join(" ")).toContain("not registered");
    expect(h.steps).toEqual(["00a2-read-client-classification"]);
  });

  it("fails open: a client with nothing on file, or an unusable answer, runs unclassified", async () => {
    const empty = harness({ slug: "blank" });
    expect((await resolveClientClassification(empty.wf, empty.deps, { now: () => NOW })).classification).toBeUndefined();
    const bad = harness({ slug: "bad", profile: { name: "Bad" }, model: { archetype: "robot", category: "x", involvement: "low", audience: "B2C", locale: "en" } });
    const out = await resolveClientClassification(bad.wf, bad.deps, { now: () => NOW });
    expect(out.classification).toBeUndefined();
    expect(bad.writes).toEqual([]);
  });
});

describe("the record itself", () => {
  it("never accepts 'other' as a category", () => {
    expect(classificationFromModel({ archetype: "brand", category: "Other", involvement: "low", audience: "B2C", locale: "en" }, NOW)).toBeUndefined();
    expect(readClassification({ ...record(), category: "other" })).toBeUndefined();
  });

  it("covers exactly the nine clients the study classified", () => {
    for (const slug of ["karoslabs", "geektime", "thepitchbydeel", "hankypanky", "kindlyyours", "sitti", "xodigital", "dontechno", "n3"]) expect(researchClassificationFor(slug, NOW)).toBeDefined();
    expect(researchClassificationFor("acme", NOW)).toBeUndefined();
  });

  it("reads only what the client says about itself, capped", () => {
    const text = classifierEvidence({ profile: { name: "A", description: "x".repeat(10_000) } });
    expect(text.startsWith("name: A")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});
