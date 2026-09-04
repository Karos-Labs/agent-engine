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

  it("re-captures once an adapter exists, instead of serving a cached 'no_adapter_wired'", async () => {
    // 2026-09-04, prep: a working Gemini adapter was deployed and changed
    // nothing, because the previous day's run had cached 25
    // `no_adapter_wired` cells and the freshness window is 30 days. The client
    // saw the same coverage as before and the adapter sat unused for a month.
    //
    // A `no_adapter_wired` cell is a statement about THIS DEPLOYMENT'S
    // CONFIGURATION, not about what an engine said. The freeze rule it was
    // riding on ("capture_tier set at capture per cell and frozen; never
    // silently upgraded") is about measurement conditions — and an engine that
    // was never wired was never measured at all.
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-capture-test-"));
    const store = new WorkspaceStore(rootDir);

    // Day one: nothing wired for gemini.
    const unwired = createCaptureVisibility(store, {});
    const first = await unwired.execute({ ...BASE_INPUT, engine: "gemini" }, { ctx });
    if (first.status !== "success") throw new Error("unreachable");
    expect(first.result.cell.captureTier).toBe("UNAVAILABLE");
    expect(first.result.cell.unavailableReason).toBe("no_adapter_wired");

    // Day two, same 30-day window: the adapter now exists.
    const geminiAdapter: EngineCaptureAdapter = async () => ({
      captureTier: "MEASURED_grounded",
      brandMentioned: true,
      brandCited: false,
      competitorsNamed: [],
      citations: [],
      mentionCounts: { client: 1 },
      sentimentPerMention: [],
      rawPayload: { real: true },
    });
    const wired = createCaptureVisibility(store, { adapters: { gemini: geminiAdapter } });
    const second = await wired.execute({ ...BASE_INPUT, engine: "gemini" }, { ctx });
    if (second.status !== "success") throw new Error("unreachable");

    expect(second.result.fromCache).toBe(false);
    expect(second.result.cell.captureTier).toBe("MEASURED_grounded");

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("still serves a cached REAL measurement from cache — the freeze rule is untouched", async () => {
    // The narrow fix must not become "ignore the cache": a genuine measurement
    // stays frozen per cell, which is what makes a run reproducible.
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

    await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    const second = await tool.execute({ ...BASE_INPUT, engine: "perplexity" }, { ctx });
    if (second.status !== "success") throw new Error("unreachable");

    expect(second.result.fromCache).toBe(true);
    expect(calls).toBe(1);

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
    const adapters = createDefaultCaptureAdapters({ env: { PERPLEXITY_API_KEY: "pplx-1", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: undefined, OPENAI_API_KEY: "sk-1" } });
    expect(Object.keys(adapters).sort()).toEqual(["chatgpt", "perplexity"]);
  });

  it("wires nothing when no credentials are present", () => {
    const adapters = createDefaultCaptureAdapters({ env: {} });
    expect(Object.keys(adapters)).toEqual([]);
  });

  it("wires every routable engine when each credential is present", () => {
    // Four, not five. `copilot` has no first-party API and no working vendor
    // route, so nothing wires it — see the ChatGPT block in capture-adapters.
    const adapters = createDefaultCaptureAdapters({
      env: { PERPLEXITY_API_KEY: "p", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" },
    });
    expect(Object.keys(adapters).sort()).toEqual(["chatgpt", "claude", "gemini", "perplexity"]);
  });

  it("never wires ScrappyCoco for an answer engine, whatever the env says", () => {
    // The route it used did not exist: ScrappyCoco's live /scrapers catalogue
    // lists 52 web/social/filings capabilities and no `chatgpt`/`copilot`
    // source, so every capture slot for those two threw and the workflow's
    // `completedOutputs` dropped them — the engines silently vanished from the
    // report rather than reporting UNAVAILABLE. The key stays in the
    // environment for `research.pull`'s scraper, which is a real capability.
    const adapters = createDefaultCaptureAdapters({ env: { SCRAPPYCOCO_API_KEY: "sc-1" } });
    expect(Object.keys(adapters)).toEqual([]);
  });

  it("falls back to the Vertex route for Gemini when there is no GEMINI_API_KEY", () => {
    // Prep's exact situation: no Gemini key, but a configured Vertex project
    // and ADC on the service account. 25 of 125 cells reported
    // `no_adapter_wired` every run for want of this.
    const adapters = createDefaultCaptureAdapters({
      env: { GEMINI_VERTEX_PROJECT_ID: "karoscmo-prep", VERTEX_AI_LOCATION: "us-central1" },
      vertexAuthorize: async () => "Bearer test",
    });
    expect(Object.keys(adapters)).toEqual(["gemini"]);
  });

  it("prefers the direct key over the Vertex route when both are available", async () => {
    // Both produce a `gemini` entry, so the key set proves nothing — assert on
    // the host the adapter actually calls.
    const calls: string[] = [];
    const stub = stubFetch(calls);
    const adapters = createDefaultCaptureAdapters({
      env: { GEMINI_API_KEY: "g", GEMINI_VERTEX_PROJECT_ID: "karoscmo-prep" },
      vertexAuthorize: async () => "Bearer test",
      fetchImpl: stub,
    });
    await adapters.gemini!({ promptId: "p1", promptText: "who?", engine: "gemini" as const, clientDomains: ["x.com"], competitorRoster: [] });

    expect(calls[0]).toContain("generativelanguage.googleapis.com");
  });

  it("calls the regional Vertex host, with the model in the path, when it falls back", async () => {
    const calls: string[] = [];
    const adapters = createDefaultCaptureAdapters({
      env: { GEMINI_VERTEX_PROJECT_ID: "karoscmo-prep", VERTEX_AI_LOCATION: "us-central1" },
      vertexAuthorize: async () => "Bearer test",
      fetchImpl: stubFetch(calls),
    });
    await adapters.gemini!({ promptId: "p1", promptText: "who?", engine: "gemini" as const, clientDomains: ["x.com"], competitorRoster: [] });

    expect(calls[0]).toContain("us-central1-aiplatform.googleapis.com");
    expect(calls[0]).toContain("/projects/karoscmo-prep/locations/us-central1/publishers/google/models/");
    expect(calls[0]).not.toContain("key=");
  });

  it("does not wire the Vertex route without an authorizer, however configured", () => {
    const adapters = createDefaultCaptureAdapters({ env: { GEMINI_VERTEX_PROJECT_ID: "p" } });
    expect(Object.keys(adapters)).toEqual([]);
  });
});

/** A fetch that records the URLs it was called with and answers emptily. */
function stubFetch(calls: string[]): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
