import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type CompletionResult, type ModelRouter, type AgentToolRegistry, type ZodSchema } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createKarosLandingTools, type RenderReport } from "@agent-engine/tool-karos-landing";
import { MemoryArtifactStore, fakeHostingFetch, fakeToken, sampleBlueprint, sampleParts } from "../../../packages/tools/karos-landing/__tests__/fixtures.js";

export { sampleBlueprint, sampleParts, MemoryArtifactStore };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/**
 * A router that answers each bounded agent by matching the requested schema
 * against a pool of candidate outputs (the `seo-geo-agent` `smartFakeRouter`
 * pattern), plus an ordered queue for the one schema two steps share: the
 * craft verdict, so a test can make the first verdict fail and the re-check
 * pass. Records every prompt so a test can assert what a step actually saw.
 */
export function landingFakeRouter(options: { blueprint?: unknown; parts?: unknown; fixedParts?: unknown; verdicts?: unknown[] } = {}) {
  const verdicts = [...(options.verdicts ?? [{ verdict: "pass", evidence: ["clears the floor"], toolVersion: "test" }])];
  const prompts: Array<{ stepId: string; prompt: string }> = [];
  let partsServed = 0;
  const router: ModelRouter = {
    async complete(prompt: string, schema: ZodSchema<unknown>, policy) {
      const stepId = /"stepId":"([^"]+)"/.exec(prompt)?.[1] ?? "?";
      prompts.push({ stepId, prompt });
      const serve = (output: unknown): CompletionResult<unknown> => ({
        output: { type: "final", output },
        modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
        inputTokens: { cached: 0, uncached: 1000 },
        outputTokens: 500,
      });
      const candidates: unknown[] = [];
      if (stepId === "landing-blueprint") candidates.push(options.blueprint ?? sampleBlueprint());
      if (stepId === "landing-build") candidates.push(options.parts ?? sampleParts());
      if (stepId === "landing-fix") candidates.push(options.fixedParts ?? options.parts ?? sampleParts());
      if (stepId === "landing-craft-verdict") candidates.push(verdicts.length > 1 ? verdicts.shift() : verdicts[0]);
      if (stepId === "topic-guardrail" || /guardrail/.test(stepId)) candidates.push({ verdict: "pass", evidence: [], toolVersion: "test" });
      for (const candidate of candidates) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          if (stepId === "landing-build") partsServed++;
          return serve(candidate) as CompletionResult<unknown>;
        }
        const first = parsed.error.issues[0];
        throw new Error(`landingFakeRouter: candidate for ${stepId} does not match its schema: ${first?.path.join(".")}: ${first?.message}`);
      }
      throw new Error(`landingFakeRouter: no candidate for step "${stepId}"`);
    },
    async completeAlias() {
      throw new Error("landingFakeRouter: completeAlias not used");
    },
  } as ModelRouter;
  return { router, prompts, get buildsServed() { return partsServed; } };
}

export const OLD_SITE_HTML = `<!doctype html><html lang="en"><head><title>Northwind · Your AI CMO</title><meta name="description" content="The AI-powered marketing team."></head><body>
<header><nav><a href="/agents">Agents</a><a class="btn" href="https://cal.com/northwind">Book a call</a></nav></header>
<main><h1>The AI CMO that moves 1st.</h1>
<p>Twelve agents run in production today. The AI-powered marketing team that runs your strategy, content, and growth end to end, and never stops watching the market for the decisive moment.</p>
<p>Point it at your brand. Give Northwind your site. It reads your brand, your voice, and your market in minutes with no setup and no briefing at all.</p>
<p>It watches every channel and every signal around the clock. The instant something moves in your market, Northwind catches it and drafts the move.</p>
<img src="/art/kairos.jpg" alt="Kairos, Time of Decision. Fresco by Francesco Salviati."></main></body></html>`;

export interface TestEnvironment {
  tmpRoot: string;
  store: WorkspaceStore;
  artifactStore: MemoryArtifactStore;
  tools: AgentToolRegistry;
  hostingCalls: Array<{ method: string; url: string }>;
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  clientSlug?: string;
  withProductInformation?: boolean;
  withWebsite?: boolean;
  withHosting?: boolean;
  /** Replaces the real Chromium render with a canned report (default: a passing one with two screenshots). */
  renderReport?: RenderReport | ((html: string) => RenderReport);
  priorState?: { blueprint: unknown; parts: unknown };
}

export function passingRender(): RenderReport {
  const bp = (label: string, width: number, height: number) => ({
    label,
    width,
    height,
    consoleErrors: [],
    failedRequests: [],
    horizontalOverflow: false,
    openerLuminance: 240,
    pageHeight: 4200,
    fontsLoaded: true,
    missingFonts: [],
    h1Count: 1,
    brokenImages: 0,
    minContrast: 7.2,
    lowContrastSamples: [],
    screenshot: { url: `https://signed.example/render-${label}.png`, gcsUri: `gs://test-bucket/render-${label}.png` },
  });
  return { breakpoints: [bp("mobile", 390, 844), bp("desktop", 1440, 900)], pass: true, violations: [] };
}

export async function setupTestEnvironment(opts: SetupOptions = {}): Promise<TestEnvironment> {
  const clientSlug = opts.clientSlug ?? "northwind";
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-builder-v2-test-"));
  const store = new WorkspaceStore(path.join(tmpRoot, "workspace"));
  const artifactStore = new MemoryArtifactStore();

  await store.writeJson(clientSlug, ["client", "profile"], {
    name: "Northwind",
    slug: clientSlug,
    industry: "AI Digital Marketing",
    description: "AI marketing agency",
    ...(opts.withWebsite === false ? {} : { website: "https://northwind.example/" }),
  });
  await store.writeJson(clientSlug, ["client", "brand"], {
    name: "Northwind",
    accent: "#ff6b2c",
    colors: { primaryAccent: "#ff6b2c", neutralDark: "#1a1a1a", neutralLight: "#f2f1ec" },
    fonts: { heading: "Space Grotesk", body: "Inter" },
    logoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/logo.png?alt=media",
    guidelines: "## Brand voice\nClear, precise, no exclamation marks.",
  });
  await store.writeJson(clientSlug, ["client", "config"], { forbiddenTopics: [] });
  if (opts.withProductInformation !== false) {
    await store.writeJson(clientSlug, ["context", "product-information"], {
      markdown: "## Overview\nNorthwind deploys a system of always-on AI agents. Twelve agents run in production today. Clients approve outputs.",
      source: { firestoreDocId: "d1", docVersion: 1, tier: "internal", projectedAt: "2026-09-01T00:00:00Z", projectedBy: "test", contentHash: "x" },
    });
  }
  if (opts.priorState) {
    await store.writeJson(clientSlug, ["landing", "state"], { runId: "run_prior", publishedAt: "2026-09-01T00:00:00Z", blueprint: opts.priorState.blueprint, parts: opts.priorState.parts, liveUrl: "https://karos-northwind.web.app", versionName: "sites/karos-northwind/versions/v0" });
  }

  const hosting = fakeHostingFetch();
  const captureFetch: typeof fetch = async () => new Response(OLD_SITE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  const noBrowser = async () => null;

  const landingTools = createKarosLandingTools(opts.withHosting === false ? {} : { hosting: { projectId: "karoscmo", sitePrefix: "karos-" } }, {
    workspaceStore: store,
    artifactStore,
    capture: { fetchImpl: captureFetch, loadChromium: noBrowser },
    render: { loadChromium: noBrowser },
    deploy: { tokenProvider: fakeToken, fetchImpl: hosting.fetchImpl },
  });
  const renderReport = opts.renderReport ?? passingRender();
  const fakeRender: AgentToolRegistry[string] = {
    ...landingTools["landing.renderPage"]!,
    async execute(args: unknown) {
      const html = (args as { html: string }).html;
      return { status: "success", result: typeof renderReport === "function" ? renderReport(html) : renderReport };
    },
  } as AgentToolRegistry[string];

  const tools: AgentToolRegistry = {
    ...createAllKarosTools(store, undefined, { scraper: createOfflineScraper() }),
    ...landingTools,
    "landing.renderPage": fakeRender,
  };

  return { tmpRoot, store, artifactStore, tools, hostingCalls: hosting.calls, cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }) };
}
