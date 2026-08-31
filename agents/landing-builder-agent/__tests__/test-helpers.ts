import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createKarosLandingTools, type LandingEngineConfig } from "@agent-engine/tool-karos-landing";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

/**
 * The REAL, ported FORGE fixture site — `packages/tools/karos-landing`'s own
 * copy of `karos-agents/products/live/landing-page/engine/fixtures/forge/site`
 * (real component prop names, real `content-schema.ts`, real `globals.css`
 * token contract, real `layout.tsx`). The Deep Parity Audit found the
 * previous test environment used a synthetic stub template hand-shaped to
 * match the generator's own (incorrect) assumptions, which meant every test
 * passed while hiding real breakage against the actual kit. Pointing
 * `templateRoot` directly at this real fixture (read-only — `landing.
 * copyTemplate` never writes into it) means these tests only stay green if
 * the generator's output is genuinely compatible with the real kit's
 * component signatures and content contract.
 */
export const REAL_FORGE_FIXTURE_SITE = path.join(HERE, "..", "..", "..", "packages", "tools", "karos-landing", "__tests__", "fixtures", "forge", "site");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A `ModelRouter` that serves every bounded agent from one shared instance by matching the requested schema against a pool of candidate final outputs — mirrors `seo-geo-agent`'s `smartFakeRouter`. */
export function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }
      }
      throw new Error("smartFakeRouter: no candidate output matches the requested schema");
    },
    async completeAlias() {
      throw new Error("smartFakeRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

export function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

/** Matches the real FORGE fixture's own `brand.json` (colors, roles derived from its real `globals.css`/ENGINE-SPEC §12 ratio) closely enough that generated output can be gated/compiled against the real kit meaningfully. */
export function forgeBrand(overrides: Record<string, unknown> = {}) {
  return {
    client: "forge",
    company: "FORGE",
    identity: { sector: "fitness", audience: "lifters", positioning: "train like an athlete", personality: "confident coach", mood: "bold/dark" },
    tokens: {
      colors: { ink: "#0B0B0C", "ink-2": "#15151A", bone: "#F2F0EC", "bone-2": "#C7C5BE", ember: "#FF4D00", "ember-2": "#FF7A33", steel: "#3A3D44", line: "#26262C" },
      roles: { ground: "ink", ground2: "ink-2", fg: "bone", fg2: "bone-2", accent: "ember", accent2: "ember-2", muted: "steel", edge: "line" },
    },
    fonts: { display: "Clash Display", body: "Inter", mono: "JetBrains Mono" },
    brandLaw: ["Second person, present tense."],
    voice: { lang: "en-US", tone: "confident coach" },
    carryForward: [{ type: "chatbot", what: "Coaching assistant (Coach), bottom-right launcher" }],
    references: ["linear.app", "stripe.com/billing"],
    ...overrides,
  };
}

/**
 * A copy draft realistic enough to clear the real FORGE kit's structural
 * checks: required sections' fields match `content-schema.ts`'s real
 * interfaces closely, and the placed carry-forward item (`footer.assistant`)
 * genuinely embeds a `type: "chatbot"` tag — proving the gate's
 * placement-scoped completeness check passes when the capability really was
 * written into its claimed section, not merely claimed.
 */
export function goodCopy() {
  return {
    lang: "en-US",
    meta: { title: "FORGE · Train like an athlete, not a tourist", description: "An adaptive strength program built around you." },
    sections: {
      nav: { links: [{ label: "Pricing", href: "#pricing" }], primaryCta: { label: "Start free", href: "#pricing" } },
      hero: {
        eyebrow: "Strength & conditioning",
        headline: "Train like an athlete, not a tourist",
        sub: "FORGE builds your program from what you actually lifted.",
        primaryCta: { label: "Start free", href: "#pricing" },
        secondaryCta: { label: "See how it works", href: "#how" },
      },
      offering: {
        eyebrow: "Pricing",
        heading: "Start free.",
        sub: "No card required.",
        plans: [{ name: "Pro", price: "$29", cadence: "/mo", features: ["Adaptive programming"], cta: { label: "Go Pro", href: "#" } }],
      },
      footer: {
        tagline: "Train like an athlete, not a tourist.",
        primaryCta: { label: "Start free", href: "#pricing" },
        columns: [{ heading: "Product", links: [{ label: "Pricing", href: "#pricing" }] }],
        legal: "© 2026 FORGE.",
        // The carry-forward placement's genuine evidence — a real sub-object, not a blind claim.
        assistant: { type: "chatbot", label: "Coach" },
      },
    },
    assumptions: [] as string[],
  };
}

export function goodCompose() {
  return {
    manifest: ["nav", "hero", "offering", "footer"],
    carryForwardPlacement: [{ what: "Coaching assistant (Coach), bottom-right launcher", section: "footer" }],
  };
}

export function goodCraftVerdict() {
  return { verdict: "pass", evidence: ["clears the craft floor"], toolVersion: "1.0.0" };
}

export interface TestEnvironment {
  tmpRoot: string;
  landingConfig: LandingEngineConfig;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

// `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
// reports `not_available` without a real scraper rather than returning a
// placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
// placeholder is what let every content agent draft from nothing for months.
// Tests still need deterministic offline data, so they opt in here; nothing in
// `apps/` does.
/**
 * Sets up the real FORGE fixture as `templateRoot` (read-only) + an isolated
 * bundle for one client, and merges karos-landing's tools into the full
 * Layer 3 registry — the same pattern `agents/branded-shorts-agent` uses for
 * `createKarosVideoTools()` (both are excluded from
 * `createAllKarosTools(undefined, undefined, { scraper: createOfflineScraper() })`'s
 * own default bundle).
 *
 * `opts.withContextDocs` (default `true`, SCRUM-242/T-A10): landing-builder-agent's
 * row in the shared CONTEXT_DOC_POLICY table is BLOCK, so every pre-existing
 * test in this suite that doesn't care about grounding specifically (feedback
 * rounds, gate behavior, rebuild mode) needs SOME product-information content
 * on file or it now resolves to `blocked_intake` before ever drafting.
 * `context-doc-grounding.test.ts`'s own BLOCK case passes `withContextDocs: false`
 * to get genuine, total absence.
 */
export async function setupTestEnvironment(clientSlug: string, opts: { withContextDocs?: boolean } = {}): Promise<TestEnvironment> {
  const withContextDocs = opts.withContextDocs ?? true;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-builder-agent-test-"));
  const engineClientsRoot = path.join(tmpRoot, "clients");
  const bundlesRoot = path.join(tmpRoot, "bundles");
  const workspaceRoot = path.join(tmpRoot, "workspace");

  await fs.mkdir(path.join(bundlesRoot, clientSlug), { recursive: true });
  await fs.writeFile(path.join(bundlesRoot, clientSlug, "brand.json"), JSON.stringify(forgeBrand({ client: clientSlug })));
  await fs.writeFile(path.join(bundlesRoot, clientSlug, "intake.md"), "# Intake\nFORGE is a strength training app.\n");

  const landingConfig: LandingEngineConfig = { templateRoot: REAL_FORGE_FIXTURE_SITE, engineClientsRoot, bundlesRoot };
  const store = new WorkspaceStore(workspaceRoot);
  const tools = { ...createAllKarosTools(store, undefined, { scraper: createOfflineScraper() }), ...createKarosLandingTools(landingConfig) };
  if (withContextDocs) {
    await store.writeJson(clientSlug, ["context", "product-information"], { markdown: "Default test fixture: general product description for test coverage." });
  }

  return { tmpRoot, landingConfig, store, tools, cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }) };
}
