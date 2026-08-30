import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BaseAgent,
  applyClientLanguagePolicy,
  loadClientContentLanguage,
  resolveModelPolicy,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelPolicy,
  type ModelRouter,
} from "../src/index.js";

/**
 * AU34 / SCRUM-312 — per-client model policy.
 *
 * The property under test is deliberately not "a Hebrew client gets opus".
 * That much would pass just as well against AU32's env-var stopgap
 * (`MODEL_STEP_INSTAGRAM_COPY_MODEL=claude-opus-4-8`), which is exactly the
 * mechanism this ticket exists to supersede. What is asserted instead is the
 * thing the env var structurally CANNOT do: two clients with two different
 * content languages, resolved in ONE process, from ONE module-evaluated step
 * config, with the `MODEL_STEP_*` environment empty — landing on two different
 * models. Reintroduce env-var-only resolution and these tests fail, because a
 * global-per-deployment setting has exactly one value for both clients.
 */

const CopyOutput = z.object({ body: z.string() });
type CopyOutput = z.infer<typeof CopyOutput>;

/**
 * `instagram-copy`'s real compiled policy, resolved through the real
 * `resolveModelPolicy` against an EXPLICITLY EMPTY environment — the
 * module-evaluation-time step every agent in this repo performs, with the
 * AU32 override pair provably absent. Resolved ONCE, at module scope, exactly
 * as the real agent does, so both clients below genuinely share one config
 * object and nothing per-client can be hiding in a second resolution.
 */
const COPY_POLICY: ModelPolicy = resolveModelPolicy(
  "instagram-copy",
  { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true },
  { env: {} },
);

/** Same step, NOT marked as producing client-facing copy — the other 26 steps' shape. */
const RESEARCH_POLICY: ModelPolicy = resolveModelPolicy("instagram-research", { policy: "pinned", model: "claude-sonnet-4-6" }, { env: {} });

class CopyStepAgent extends BaseAgent<CopyOutput> {
  protected readonly config: AgentStepConfig<CopyOutput>;
  constructor(runtime: BaseAgentRuntime, id: string, modelPolicy: ModelPolicy) {
    super(runtime);
    this.config = { id, description: "write the copy", allowedTools: [], outputSchema: CopyOutput, modelPolicy };
  }
}

/** Records the `ModelPolicy` each turn actually went out with — the model on the wire, not a re-derivation of it. */
function recordingRouter(): { router: ModelRouter; policies: ModelPolicy[] } {
  const policies: ModelPolicy[] = [];
  const router = {
    complete: vi.fn(async (_prompt: string, _schema: unknown, policy: ModelPolicy): Promise<CompletionResult<unknown>> => {
      policies.push(policy);
      return {
        output: { type: "final", output: { body: "שלום" } },
        modelUsed: policy.model,
        inputTokens: { cached: 0, uncached: 10 },
        outputTokens: 5,
      };
    }),
    completeAlias: vi.fn(),
  } as unknown as ModelRouter;
  return { router, policies };
}

/**
 * A `WorkspaceStoreLike`-shaped fake, addressed exactly as the real store is:
 * `readJson(clientSlug, ["client", "brand"])`. Two tenants, one store, one
 * process — the situation a per-deployment env var cannot describe.
 */
function fakeStore(records: Record<string, Record<string, Record<string, unknown>>>) {
  const reads: Array<{ clientSlug: string; segments: readonly string[] }> = [];
  return {
    reads,
    async readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined> {
      reads.push({ clientSlug, segments });
      return records[clientSlug]?.[segments.join("/")] as T | undefined;
    },
  };
}

function ctxFor(clientSlug: string, contentLanguage: string | undefined): AgentContext {
  return {
    runId: `run_${clientSlug}`,
    clientSlug,
    productId: "instagram-agent",
    runKind: "recurring",
    ...(contentLanguage !== undefined ? { contentLanguage } : {}),
    metadata: {},
  };
}

describe("per-client model policy (AU34 / SCRUM-312)", () => {
  it("resolves two clients with different content languages to different models, in one process, with no env var set", async () => {
    // The discriminating precondition, asserted rather than assumed: nothing in
    // this process's environment names this step. Whatever separates the two
    // clients below cannot be AU32's deployment-global override pair.
    expect(process.env["MODEL_STEP_INSTAGRAM_COPY_MODEL"]).toBeUndefined();
    expect(process.env["MODEL_STEP_INSTAGRAM_COPY_VENDOR"]).toBeUndefined();
    expect(COPY_POLICY.model).toBe("claude-sonnet-4-6");

    const store = fakeStore({
      // AU31/SCRUM-309's BrandKit `language` field — the only language field in
      // this system. Not a second one added here.
      geektime: { "client/brand": { language: "Hebrew" } },
      acme: { "client/brand": { language: "English" } },
    });

    const geektimeLanguage = await loadClientContentLanguage(store, "geektime");
    const acmeLanguage = await loadClientContentLanguage(store, "acme");
    expect(geektimeLanguage).toBe("Hebrew");
    expect(acmeLanguage).toBe("English");

    const { router, policies } = recordingRouter();
    const agent = new CopyStepAgent({ router, tools: {} }, "instagram-copy", COPY_POLICY);

    await agent.run(ctxFor("geektime", geektimeLanguage), { topic: "t" });
    await agent.run(ctxFor("acme", acmeLanguage), { topic: "t" });

    expect(policies).toHaveLength(2);
    // The Hebrew client's copy step went out on a model AU33's catalog rates
    // `multilingual-strong` + `rtlSupport: "strong"`; the English client's
    // stayed on the compiled default.
    expect(policies[0]?.model).toBe("claude-opus-4-8");
    expect(policies[1]?.model).toBe("claude-sonnet-4-6");
    expect(policies[0]?.model).not.toBe(policies[1]?.model);
    // Same compiled config object served both — the difference came from the
    // client record, not from two different step configurations.
    expect(COPY_POLICY.model).toBe("claude-sonnet-4-6");
  });

  it("reads the client's language from the workspace store's client records, not from the environment", async () => {
    const store = fakeStore({ geektime: { "client/brand": { language: "he-IL" } } });
    const language = await loadClientContentLanguage(store, "geektime");
    expect(language).toBe("he-IL");
    // The same tenant-scoped access path `client.getBrand`/`client.getConfig`
    // use — `readJson(clientSlug, segments)`, never a process-global read.
    expect(store.reads).toEqual([{ clientSlug: "geektime", segments: ["client", "brand"] }]);
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, language).model).toBe("claude-opus-4-8");
  });

  it("falls back to the same `language` field on client/config when a tenant has no brand kit yet", async () => {
    const store = fakeStore({ newoutlet: { "client/config": { language: "Arabic" } } });
    expect(await loadClientContentLanguage(store, "newoutlet")).toBe("Arabic");
    expect(store.reads.map((r) => r.segments.join("/"))).toEqual(["client/brand", "client/config"]);
  });

  it("leaves a client who has stated no language, and one who publishes in English, exactly where they were", async () => {
    const store = fakeStore({ silent: {} });
    expect(await loadClientContentLanguage(store, "silent")).toBeUndefined();
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, undefined)).toBe(COPY_POLICY);
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, "English")).toBe(COPY_POLICY);
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, "en-US")).toBe(COPY_POLICY);
  });

  it("moves only steps that declared themselves copy steps — a Hebrew client does not re-tier extraction/research spend", () => {
    expect(RESEARCH_POLICY.contentLanguageSensitive).toBeUndefined();
    expect(applyClientLanguagePolicy("instagram-research", RESEARCH_POLICY, "Hebrew")).toBe(RESEARCH_POLICY);
    expect(applyClientLanguagePolicy("instagram-research", RESEARCH_POLICY, "Hebrew").model).toBe("claude-sonnet-4-6");
  });

  it("never moves the vendor — a gemini-wired copy step gets a gemini model, never an Anthropic one", () => {
    const geminiCopy: ModelPolicy = { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini", contentLanguageSensitive: true };
    const resolved = applyClientLanguagePolicy("instagram-copy", geminiCopy, "Hebrew");
    expect(resolved.vendor).toBe("gemini");
    expect(resolved.model).toBe("gemini-2.5-pro");
  });

  it("keeps a model that is already capable of the client's language rather than upgrading for its own sake", () => {
    const opusCopy: ModelPolicy = { policy: "pinned", model: "claude-opus-4-7", contentLanguageSensitive: true };
    expect(applyClientLanguagePolicy("instagram-copy", opusCopy, "Hebrew")).toBe(opusCopy);
  });

  it("still lets Studio's per-run stageModels have the last word over the per-client rule", async () => {
    const { router, policies } = recordingRouter();
    const agent = new CopyStepAgent({ router, tools: {} }, "instagram-copy", COPY_POLICY);
    await agent.run({ ...ctxFor("geektime", "Hebrew"), stageModels: { "instagram-copy": "claude-opus-4-7" } }, { topic: "t" });
    expect(policies[0]?.model).toBe("claude-opus-4-7");
  });

  it("recognizes a language written in its own script, and a non-RTL non-English language", () => {
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, "עברית").model).toBe("claude-opus-4-8");
    expect(applyClientLanguagePolicy("instagram-copy", COPY_POLICY, "Japanese").model).toBe("claude-opus-4-8");
  });
});
