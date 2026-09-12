import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BaseAgent,
  CONTENT_LANGUAGE_MAX_COST_TIER,
  applyClientLanguagePolicy,
  loadClientContentLanguage,
  requirementForContentLanguage,
  resolveModelPolicy,
  selectModelForContentLanguage,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelPolicy,
  type ModelRouter,
} from "../src/index.js";
// `model-capabilities.js` is deliberately not on the `router/index.js` barrel (see its note there), and this
// suite reads the REAL catalog rather than a restatement of it — the premise assertion below is only worth
// anything if it is measured against the table the router actually consults.
import { MODEL_CAPABILITIES } from "../src/router/model-capabilities.js";

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

/**
 * RFC-15 §8 — the same copy step, wired to the vendor whose catalog actually HAS a non-premium
 * `multilingual-strong` row. AU34's two-clients-one-process property is demonstrated here rather than on the
 * Anthropic policy above, because `CONTENT_LANGUAGE_MAX_COST_TIER` now (correctly) refuses to answer
 * "which Anthropic model writes Hebrew" with "Opus, at $5/$25". The property AU34 exists to prove — that the
 * re-point is per-client and per-run, not per-deployment — is unchanged and is still proven below.
 */
const GEMINI_COPY_POLICY: ModelPolicy = resolveModelPolicy(
  "instagram-copy",
  { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini", contentLanguageSensitive: true },
  { env: {} },
);

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
    expect(GEMINI_COPY_POLICY.model).toBe("gemini-2.5-flash");

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
    const agent = new CopyStepAgent({ router, tools: {} }, "instagram-copy", GEMINI_COPY_POLICY);

    await agent.run(ctxFor("geektime", geektimeLanguage), { topic: "t" });
    await agent.run(ctxFor("acme", acmeLanguage), { topic: "t" });

    expect(policies).toHaveLength(2);
    // The Hebrew client's copy step went out on a model AU33's catalog rates
    // `multilingual-strong` + `rtlSupport: "strong"`; the English client's
    // stayed on the compiled default.
    expect(policies[0]?.model).toBe("gemini-2.5-pro");
    expect(policies[1]?.model).toBe("gemini-2.5-flash");
    expect(policies[0]?.model).not.toBe(policies[1]?.model);
    // Same compiled config object served both — the difference came from the
    // client record, not from two different step configurations.
    expect(GEMINI_COPY_POLICY.model).toBe("gemini-2.5-flash");
  });

  it("reads the client's language from the workspace store's client records, not from the environment", async () => {
    const store = fakeStore({ geektime: { "client/brand": { language: "he-IL" } } });
    const language = await loadClientContentLanguage(store, "geektime");
    expect(language).toBe("he-IL");
    // The same tenant-scoped access path `client.getBrand`/`client.getConfig`
    // use — `readJson(clientSlug, segments)`, never a process-global read.
    expect(store.reads).toEqual([{ clientSlug: "geektime", segments: ["client", "brand"] }]);
    expect(applyClientLanguagePolicy("instagram-copy", GEMINI_COPY_POLICY, language).model).toBe("gemini-2.5-pro");
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
    const geminiProCopy: ModelPolicy = { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini", contentLanguageSensitive: true };
    expect(applyClientLanguagePolicy("instagram-copy", geminiProCopy, "Hebrew")).toBe(geminiProCopy);
  });

  it("leaves a step a human deliberately pinned to a premium model on that model — the cap never downgrades, it only declines to upgrade", () => {
    const opusCopy: ModelPolicy = { policy: "pinned", model: "claude-opus-4-7", contentLanguageSensitive: true };
    // Identical object reference: under the cap `satisfies` rejects the premium row, so selection finds no
    // eligible alternative and takes the documented `selected === undefined` path, which returns `policy` as
    // it stands. A deployment that has chosen Opus keeps Opus; what it does NOT get is Opus by accident.
    expect(applyClientLanguagePolicy("instagram-copy", opusCopy, "Hebrew")).toBe(opusCopy);
    expect(applyClientLanguagePolicy("instagram-copy", opusCopy, "Hebrew").model).toBe("claude-opus-4-7");
  });

  it("still lets Studio's per-run stageModels have the last word over the per-client rule", async () => {
    const { router, policies } = recordingRouter();
    const agent = new CopyStepAgent({ router, tools: {} }, "instagram-copy", COPY_POLICY);
    await agent.run({ ...ctxFor("geektime", "Hebrew"), stageModels: { "instagram-copy": "claude-opus-4-7" } }, { topic: "t" });
    expect(policies[0]?.model).toBe("claude-opus-4-7");
  });

  it("recognizes a language written in its own script, and a non-RTL non-English language", () => {
    // Recognition is the property under test, and it is still observable: both strings produce a
    // `ContentLanguageRequirement`, and on a vendor with a non-premium capable row both re-point.
    expect(requirementForContentLanguage("עברית")).toEqual({ multilingualStrong: true, rtlStrong: true, maxCostTier: "standard" });
    expect(requirementForContentLanguage("Japanese")).toEqual({ multilingualStrong: true, rtlStrong: false, maxCostTier: "standard" });
    expect(applyClientLanguagePolicy("instagram-copy", GEMINI_COPY_POLICY, "עברית").model).toBe("gemini-2.5-pro");
    expect(applyClientLanguagePolicy("instagram-copy", GEMINI_COPY_POLICY, "Japanese").model).toBe("gemini-2.5-pro");
  });
});

/**
 * RFC-15 §8 — the content-language re-point's cost cap.
 *
 * The trap this closes was live and silent: `selectModelForContentLanguage` picks the CHEAPEST same-vendor
 * `multilingual-strong` row, and in the Anthropic catalog the ONLY such rows are `claude-opus-4-8` and
 * `claude-opus-4-7`, both `premium`. Five Instagram steps carry `contentLanguageSensitive` on a pinned
 * Sonnet. Nothing had fired only because `loadClientContentLanguage` reads `client/brand.json`'s `language`
 * and that field is null for exactly the clients Phase 4 targets — so the trap was armed by a portal field
 * edit, not by a code change.
 *
 * The premise is asserted first, against the real catalog, so this suite fails loudly if a future cheap
 * Anthropic multilingual-strong row lands and quietly makes the whole block vacuous.
 */
describe("the content-language re-point is capped below premium (RFC-15 §8)", () => {
  it("the premise: Anthropic's ONLY multilingual-strong rows are premium, which is why 'cheapest capable' meant Opus", () => {
    const anthropicCapable = Object.entries(MODEL_CAPABILITIES)
      .filter(([, c]) => c.vendor === "anthropic" && c.languageStrength === "multilingual-strong")
      .map(([id, c]) => [id, c.costTier]);
    expect(anthropicCapable.length).toBeGreaterThan(0);
    expect(anthropicCapable.every(([, tier]) => tier === "premium")).toBe(true);
    expect(MODEL_CAPABILITIES["claude-sonnet-4-6"]?.languageStrength).toBe("strong");
  });

  it("a Hebrew Anthropic-vendor contentLanguageSensitive step keeps claude-sonnet-4-6 and logs", () => {
    // `logWarning` emits `severity: "WARNING"` on stdout (structured-log.ts:38-41) — stderr is reserved for
    // ERROR because Cloud Run maps the streams, not the payload. So the spy is on `console.log`.
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const language of ["Hebrew", "he-IL"]) {
        const resolved = applyClientLanguagePolicy("instagram-copy", COPY_POLICY, language);
        expect(resolved.model).toBe("claude-sonnet-4-6");
        expect(MODEL_CAPABILITIES[resolved.model ?? ""]?.costTier).not.toBe("premium");
      }
      // The degradation is visible, not silent — that is the whole difference between this and the old
      // behaviour, which was also "no warning" but cost ~2x the hard max.
      const lines = logged.mock.calls.map((c) => String(c[0]));
      const warnings = lines.filter((l) => l.includes('"severity":"WARNING"') && l.includes("instagram-copy"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("standard");
    } finally {
      logged.mockRestore();
    }
  });

  it("a Gemini-vendor contentLanguageSensitive step still selects gemini-2.5-pro — the cap is a ceiling, not an off switch", () => {
    expect(MODEL_CAPABILITIES["gemini-2.5-pro"]?.costTier).toBe("standard");
    expect(applyClientLanguagePolicy("instagram-copy", GEMINI_COPY_POLICY, "Hebrew").model).toBe("gemini-2.5-pro");
    expect(applyClientLanguagePolicy("instagram-copy", GEMINI_COPY_POLICY, "he-IL").model).toBe("gemini-2.5-pro");
  });

  it("ANTI-TAUTOLOGY: lift the cap to premium and the very same call DOES select claude-opus-4-8", () => {
    // Without this case the assertions above prove nothing — they would pass just as well against a
    // `selectModelForContentLanguage` that had stopped selecting anything at all.
    const uncapped = { multilingualStrong: true, rtlStrong: true, maxCostTier: "premium" as const };
    expect(selectModelForContentLanguage("anthropic", uncapped)).toBe("claude-opus-4-8");
    expect(selectModelForContentLanguage("anthropic", { multilingualStrong: true, rtlStrong: true })).toBeUndefined();
    expect(CONTENT_LANGUAGE_MAX_COST_TIER).toBe("standard");
  });

  it("the default is the constant, not a literal duplicated at the call site", () => {
    // Omitting `maxCostTier` must behave identically to passing the constant, or a future caller
    // constructing a requirement by hand silently re-opens the trap.
    const withConstant = selectModelForContentLanguage("anthropic", {
      multilingualStrong: true,
      rtlStrong: true,
      maxCostTier: CONTENT_LANGUAGE_MAX_COST_TIER,
    });
    const omitted = selectModelForContentLanguage("anthropic", { multilingualStrong: true, rtlStrong: true });
    expect(omitted).toBe(withConstant);
    expect(requirementForContentLanguage("Hebrew")?.maxCostTier).toBe(CONTENT_LANGUAGE_MAX_COST_TIER);
  });
});
