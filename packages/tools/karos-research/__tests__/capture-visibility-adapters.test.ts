import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createCaptureVisibility, type EngineCaptureAdapter } from "../src/capture-visibility.js";
import { createDefaultCaptureAdapters } from "../src/capture-adapters/index.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} };

const BASE_INPUT = {
  promptId: "prompt_01",
  promptText: "What are the best B2B SaaS companies to work with?",
  clientDomains: ["acme.example"],
  competitorRoster: ["Rivalco"],
  window: "30d",
};

describe("research.captureVisibility wired with real per-engine adapters (T-A3/SCRUM-237)", () => {
  it("an engine with a configured adapter captures for real — not the UNAVAILABLE stand-in", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);
    const perplexityAdapter: EngineCaptureAdapter = async () => ({
      captureTier: "MEASURED",
      brandMentioned: true,
      brandCited: true,
      brandFirstCitationOrdinal: 1,
      competitorsNamed: [],
      citations: [{ domain: "acme.example", ordinal: 1 }],
      mentionCounts: { client: 1 },
      sentimentPerMention: [],
      rawPayload: { fake: "real-shaped payload" },
    });
    const tool = createCaptureVisibility(store, { adapters: { perplexity: perplexityAdapter } });

    const outcome = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.cell.captureTier).toBe("MEASURED");
    expect(outcome.result.cell.brandMentioned).toBe(true);
    expect(outcome.result.cell.rawSha256).toMatch(/^[0-9a-f]{64}$/);

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("an engine with NO adapter configured still reports the honest UNAVAILABLE stand-in", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);
    const tool = createCaptureVisibility(store, { adapters: { perplexity: async () => { throw new Error("should not be called"); } } });

    const outcome = await tool.execute({ ...BASE_INPUT, engine: "gemini" }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.cell.captureTier).toBe("UNAVAILABLE");
    expect(outcome.result.cell.unavailableReason).toBe("no_adapter_wired");

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("a credit-probe rejection short-circuits BEFORE the adapter is ever called", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);
    let adapterCalled = false;
    const adapter: EngineCaptureAdapter = async () => {
      adapterCalled = true;
      throw new Error("must not be reached");
    };
    const tool = createCaptureVisibility(store, {
      adapters: { perplexity: adapter },
      creditProbe: async () => ({ ok: false, status: 402 }),
    });

    const outcome = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.cell.captureTier).toBe("UNAVAILABLE");
    expect(outcome.result.cell.unavailableReason).toBe("credit_probe_402");
    expect(adapterCalled).toBe(false);

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("a real adapter failure is a tooling_error, never a fabricated cell", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);
    const adapter: EngineCaptureAdapter = async () => {
      throw new Error("simulated provider outage");
    };
    const tool = createCaptureVisibility(store, { adapters: { perplexity: adapter } });

    const outcome = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    expect(outcome.status).toBe("tooling_error");

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("caches a real cell exactly like the stand-in, frozen per cell within the freshness window", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);
    let calls = 0;
    const adapter: EngineCaptureAdapter = async () => {
      calls += 1;
      return {
        captureTier: "MEASURED",
        brandMentioned: true,
        brandCited: false,
        competitorsNamed: [],
        citations: [],
        mentionCounts: { client: 1 },
        sentimentPerMention: [],
        rawPayload: { call: calls },
      };
    };
    const tool = createCaptureVisibility(store, { adapters: { perplexity: adapter } });

    const first = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    const second = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    if (first.status !== "success" || second.status !== "success") throw new Error("unreachable");
    expect(second.result.fromCache).toBe(true);
    expect(calls).toBe(1);

    await fs.rm(rootDir, { recursive: true, force: true });
  });
});

describe("createDefaultCaptureAdapters: env-derived wiring (T-A3/SCRUM-237)", () => {
  it("wires only the engines whose credential is present in env", () => {
    const adapters = createDefaultCaptureAdapters({ env: { PERPLEXITY_API_KEY: "pplx-1", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: undefined, SCRAPPYCOCO_API_KEY: "sc-1" } });
    expect(Object.keys(adapters).sort()).toEqual(["chatgpt", "copilot", "perplexity"]);
  });

  it("wires nothing when no credentials are present", () => {
    const adapters = createDefaultCaptureAdapters({ env: {} });
    expect(Object.keys(adapters)).toEqual([]);
  });

  it("wires all 5 engines when every credential is present", () => {
    const adapters = createDefaultCaptureAdapters({
      env: { PERPLEXITY_API_KEY: "p", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", SCRAPPYCOCO_API_KEY: "s" },
    });
    expect(Object.keys(adapters).sort()).toEqual(["chatgpt", "claude", "copilot", "gemini", "perplexity"]);
  });
});
