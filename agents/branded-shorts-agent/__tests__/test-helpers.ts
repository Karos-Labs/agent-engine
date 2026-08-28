import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import type { AgentToolRegistry, CompletionResult, ModelRouter } from "@agent-engine/core";
import { FilePromptStore } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import { createKarosVideoTools, type ProcessResult, type ProcessRunner } from "@agent-engine/tool-karos-video";
import type { StyleCandidate } from "../src/workflow/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/**
 * A `ModelRouter` that serves every bounded agent from one shared instance by
 * matching the requested schema against a pool of candidates — mirrors
 * `seo-geo-agent`'s `smartFakeRouter` exactly, since this agent's bounded
 * steps (highlights, graphics, style exploration) run in varying orders
 * depending on the workflow under test, the same reason a strict
 * call-order queue isn't reliable here either.
 */
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

/** A router whose `.complete()` replays a fixed sequence of turns in order — for tests exercising the graphics remedy loop, where call ORDER (fail then pass) matters and `smartFakeRouter`'s pool-matching can't express it. */
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

export function finalTurn(output: unknown, opts: { model?: string } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: 100 },
    outputTokens: 30,
  });
}

export function goodHighlights() {
  return { highlightStarts: [0.6] };
}

export function goodGraphicsPlan() {
  return { overlays: [], cutaways: [] };
}

/** Matches the `#FF6B2C` accent seeded onto `client/brand` by every test that writes one — keeps `gate.styleTokenFidelity` passing by construction. */
export function goodStyleCandidates(): { candidates: StyleCandidate[] } {
  const base = {
    paletteUsage: "background/foreground/accent from the client's palette",
    captionTreatment: "body + emphasis",
    graphicsDirection: "rimmed strokes",
    endcardTreatment: "mark + wordmark",
    paletteTokensUsed: ["#FF6B2C"],
  };
  return {
    candidates: [
      { name: "Bold Editorial", description: "High-contrast, accent-forward.", ...base },
      { name: "Quiet Restraint", description: "Negative space, minimal accent.", ...base },
      { name: "Signature Device", description: "Built around the client's own mark.", ...base },
    ],
  };
}

/** A candidate whose `paletteTokensUsed` cites a color that never appears in the client's real brand kit — for exercising `gate.styleTokenFidelity`'s content_fail path. */
export function offPaletteStyleCandidates(): { candidates: StyleCandidate[] } {
  const good = goodStyleCandidates().candidates;
  return { candidates: [{ ...good[0]!, paletteTokensUsed: ["#123456"] }, good[1]!, good[2]!] };
}

/** A canned ffprobe stream reporting exactly `build_short.py`'s SDR tags — the self-eval gate's happy path. */
export function goodFfprobeStreamJson(): string {
  return JSON.stringify({ streams: [{ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }] });
}

/** Routes a canned `ProcessResult` by script basename (Python scripts) or by `ffprobe` in the command itself. */
export function scriptedRunner(byKey: Record<string, ProcessResult>): { runner: ProcessRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    const key = command.toLowerCase().includes("ffprobe") ? "ffprobe" : path.basename(args[0] ?? "");
    const entry = byKey[key];
    if (!entry) {
      throw new Error(`scriptedRunner: no canned response for "${key}" (command=${command}, args=${JSON.stringify(args)})`);
    }
    return entry;
  };
  return { runner, calls };
}

export function happyPathResponses(finalMp4Path: string): Record<string, ProcessResult> {
  return {
    "brand_assets_check.py": { stdout: "3/3 asset paths resolve and open\nBRAND ASSETS: PASS", stderr: "", exitCode: 0 },
    "cut_check.py": { stdout: "CUT GATE: PASS (1 segments, 0 cuts, 5.00s from a 5.00s window)", stderr: "", exitCode: 0 },
    "graphic_qa.py": { stdout: "", stderr: "", exitCode: 0 },
    "cutaway_check.py": { stdout: "CUTAWAY GATE: PASS (0 cutaways, 0 graphics, no conflicts)", stderr: "", exitCode: 0 },
    "build_short.py": { stdout: `done: ${finalMp4Path}  duration=12.34s  (side-data clean)\n`, stderr: "", exitCode: 0 },
    ffprobe: { stdout: goodFfprobeStreamJson(), stderr: "", exitCode: 0 },
  };
}

/** A fake ElevenLabs `fetch` returning a small but real word-level transcript — enough for `deriveCutSegments` to produce at least one kept segment. */
export function fakeElevenLabsFetch(): typeof fetch {
  const words = [
    { text: "Hello", start: 0.5, end: 0.9, type: "word" },
    { text: "world", start: 1.0, end: 1.4, type: "word" },
    { text: "this", start: 1.5, end: 1.7, type: "word" },
    { text: "works", start: 1.8, end: 2.2, type: "word" },
  ];
  return vi.fn(async () => new Response(JSON.stringify({ words }), { status: 200 })) as unknown as typeof fetch;
}

const CLIENT_SLUG = "acme";

export interface TestEnvironment {
  rootDir: string;
  workDir: string;
  profilePath: string;
  clientSlug: string;
  store: WorkspaceStore;
  tools: AgentToolRegistry;
  runnerCalls: Array<{ command: string; args: string[] }>;
  cleanup: () => Promise<void>;
}

/** The client's approved archetype repertoire used across tests — "Growth Chart" matches the graphics-plan fixtures used by the E2E remedy-loop tests. */
export const DEFAULT_APPROVED_ARCHETYPES = ["Growth Chart", "Clock", "Browser Wireframe"];

export interface SetupOptions {
  /** Overrides the default happy-path scripted engine responses (keyed by script basename, or "ffprobe"). */
  responses?: (finalMp4Path: string) => Record<string, ProcessResult>;
  withLockedStyle?: boolean;
  withIntake?: boolean;
  withProfileAndGraphicsLanguage?: boolean;
  approvedArchetypes?: string[];
}

export async function setupTestEnvironment(opts: SetupOptions = {}): Promise<TestEnvironment> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "branded-shorts-agent-test-"));
  const workDir = path.join(rootDir, "work");
  const profilePath = path.join(rootDir, "brand-profile.json");
  const finalMp4Path = path.join(workDir, "edit", "final.mp4");

  await fs.writeFile(profilePath, JSON.stringify({ color: { background: "#141414", foreground: "#F5F0E8", accent: "#FF6B2C" } }), "utf8");

  const store = new WorkspaceStore(rootDir);

  if (opts.withLockedStyle ?? true) {
    await store.writeJson(CLIENT_SLUG, ["memory", "beliefs"], { brandedShortsLockedStyle: goodStyleCandidates().candidates[0] });
  }

  const config: Record<string, unknown> = {};
  if (opts.withProfileAndGraphicsLanguage ?? true) {
    config["brandedShortsProfilePath"] = profilePath;
    config["brandedShortsGraphicsLanguage"] = "## Vocabulary\n- rimmed stroke\n- alpha glow\n";
    config["brandedShortsApprovedArchetypes"] = opts.approvedArchetypes ?? DEFAULT_APPROVED_ARCHETYPES;
    config["brandedShortsWorkDir"] = workDir;
  }
  if (opts.withIntake ?? true) {
    const videoPath = path.join(rootDir, "clip.mov");
    await fs.writeFile(videoPath, "fake video bytes", "utf8");
    config["brandedShortsIntake"] = {
      videoPath,
      targetLength: "20-30s",
      shortCount: 1,
      takeaway: "Founders should ship faster.",
      exclusions: [],
      names: [],
    };
  }
  await store.writeJson(CLIENT_SLUG, ["client", "config"], config);

  const { runner, calls } = scriptedRunner((opts.responses ?? happyPathResponses)(finalMp4Path));
  const videoTools = createKarosVideoTools({
    runner,
    engineDir: "/engine",
    transcribe: { fetchImpl: fakeElevenLabsFetch(), env: { ELEVENLABS_API_KEY: "test-key" } },
  });

  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools: AgentToolRegistry = { ...createAllKarosTools(store, undefined, { scraper: createOfflineScraper() }), ...videoTools };

  return {
    rootDir,
    workDir,
    profilePath,
    clientSlug: CLIENT_SLUG,
    store,
    tools,
    runnerCalls: calls,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
