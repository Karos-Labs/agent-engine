import { describe, expect, it } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { runAutoSetup } from "../src/index.js";

/**
 * `runAutoSetup` — inline onboarding.
 *
 * The behaviour under test is mostly about restraint. Setup improves the
 * conditions a run executes under; it is never a precondition for executing,
 * so every failure mode here has to degrade to a note rather than throw.
 */

const ctx = { runId: "r1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as AgentContext;

interface Calls {
  topUp: Array<{ topics: string[]; lane?: string }>;
  research: Array<Record<string, unknown>>;
}

function harness(options: {
  catalogSize?: number;
  researchOutcome?: unknown;
  omitTopUp?: boolean;
  omitResearch?: boolean;
  topUpFails?: boolean;
}) {
  const calls: Calls = { topUp: [], research: [] };
  let catalogSize = options.catalogSize ?? 0;

  const tools: AgentToolRegistry = {};

  if (!options.omitTopUp) {
    tools["topics.topUp"] = {
      name: "topics.topUp",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        const { topics, lane } = args as { topics: string[]; lane?: string };
        calls.topUp.push({ topics, ...(lane ? { lane } : {}) });
        if (options.topUpFails) return { status: "tooling_error", reason: "store down" };
        const added = topics.length;
        catalogSize += added;
        return { status: "success", result: { added, catalogSize } };
      },
    } as never;
  }

  if (!options.omitResearch) {
    tools["research.pull"] = {
      name: "research.pull",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        calls.research.push(args as Record<string, unknown>);
        return (
          options.researchOutcome ?? {
            status: "success",
            result: {
              result: {
                documents: [
                  { title: "Why AI pilots stall after month one", url: "https://a.test/1" },
                  { title: "The decision bottleneck in marketing", url: "https://b.test/2" },
                ],
              },
            },
          }
        );
      },
    } as never;
  }

  return { tools, calls };
}

describe("runAutoSetup", () => {
  it("seeds the catalog from researched titles when it is below the floor", async () => {
    const { tools, calls } = harness({ catalogSize: 0 });

    const result = await runAutoSetup({ tools, ctx, lane: "educational", researchQuery: "fintech content topics" });

    expect(result.ran).toBe(true);
    expect(result.topicsAdded).toBe(2);
    expect(result.catalogSizeBefore).toBe(0);
    // Real headlines, not invented subjects: that is what makes seeding from a
    // deterministic code step honest rather than fabrication.
    expect(calls.topUp[1]!.topics).toEqual([
      "Why AI pilots stall after month one",
      "The decision bottleneck in marketing",
    ]);
    // Seeded into the lane step 03 will reserve from, or the seeding is wasted.
    expect(calls.topUp[1]!.lane).toBe("educational");
    expect(calls.research[0]).toMatchObject({ query: "fintech content topics", job: "auto-setup-topic-seed" });
  });

  it("does nothing, and spends no research call, when the catalog is already healthy", async () => {
    const { tools, calls } = harness({ catalogSize: 12 });

    const result = await runAutoSetup({ tools, ctx, researchQuery: "q" });

    expect(result.ran).toBe(false);
    expect(result.notes.join(" ")).toContain("already holds 12");
    // The inspect call happens; the seeding call and the billed research do not.
    expect(calls.topUp).toHaveLength(1);
    expect(calls.research).toHaveLength(0);
  });

  it("inspects the catalog with an empty top-up, which writes nothing", async () => {
    const { tools, calls } = harness({ catalogSize: 5 });
    await runAutoSetup({ tools, ctx, researchQuery: "q" });
    expect(calls.topUp[0]!.topics).toEqual([]);
  });

  const degradations: Array<[string, Parameters<typeof harness>[0], RegExp]> = [
    ["research is unavailable (no scraper)", { researchOutcome: { status: "not_available", reason: "no SCRAPPYCOCO_API_KEY" } }, /unusable \(not_available/],
    ["research is an outage", { researchOutcome: { status: "tooling_error", reason: "402" } }, /unusable \(tooling_error/],
    ["research returns no titles", { researchOutcome: { status: "success", result: { result: { documents: [] } } } }, /no usable titles/],
    ["research.pull is not registered", { omitResearch: true }, /research\.pull is not registered/],
    ["topics.topUp is not registered", { omitTopUp: true }, /topics\.topUp is not registered/],
    ["the seeding write fails", { topUpFails: true }, /could not inspect the topic catalog/],
  ];

  for (const [label, opts, expected] of degradations) {
    it(`degrades to a note, never a throw, when ${label}`, async () => {
      const { tools } = harness({ catalogSize: 0, ...opts });

      // The contract that matters: a client whose catalog cannot be seeded
      // still gets their post through the caller's own fallback.
      const result = await runAutoSetup({ tools, ctx, researchQuery: "q" });

      expect(result.ran).toBe(false);
      expect(result.notes.join(" ")).toMatch(expected);
    });
  }

  it("drops a title too long to be a topic", async () => {
    const { tools, calls } = harness({
      catalogSize: 0,
      researchOutcome: {
        status: "success",
        result: { result: { documents: [{ title: "x".repeat(200) }, { title: "A usable topic" }] } },
      },
    });

    await runAutoSetup({ tools, ctx, researchQuery: "q" });

    expect(calls.topUp[1]!.topics).toEqual(["A usable topic"]);
  });

  it("honours a caller's own minimum, so a stricter agent can demand a deeper catalog", async () => {
    const { tools, calls } = harness({ catalogSize: 4 });

    const result = await runAutoSetup({ tools, ctx, researchQuery: "q", minimumCatalogSize: 10 });

    expect(result.ran).toBe(true);
    expect(calls.research).toHaveLength(1);
  });
});
