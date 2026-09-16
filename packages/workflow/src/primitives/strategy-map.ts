import { z } from "zod";
import { DynamicAgent, resolveModelPolicy, type AgentContext, type AgentToolRegistry, type ModelRouter, type PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";
import { readContextDoc } from "./context-doc.js";
import type { LearningContextLike, LearningStrategyMap } from "./learning-context.js";

/**
 * The strategy map — build plan item C1 (SCRUM-464), the topic pool with
 * goals: `problem × stage → post ideas`, every row carrying a funnel stage.
 *
 * ## Who builds it, and when
 *
 * The middleware projects a client's map into
 * `context/learning/<platform>/strategy-map.json` (C7 §2.6) when it has one.
 * A client nobody has planned for has none, and the first drafting run on a
 * platform is the moment that shows: it has the client's profile, charter and
 * knowledge in hand and is about to choose a topic with no plan to choose
 * from. So the run builds the map right there — one model call, checkpointed
 * — writes it to `state/<platform>/strategy-map.json` for the middleware to
 * collect, and uses it for its own selection. The run after it finds the map
 * (projected, or still in `state/` — `client.getLearningContext` reads both)
 * and pays nothing.
 *
 * ## Why a shared primitive
 *
 * The builder is one judgment, the same on every platform: who the client
 * sells to, what those buyers struggle with, and which of those problems earn
 * a post at which stage. Only the post-type vocabulary differs, and that is a
 * note in the prompt. Like the trend scout it is a `DynamicAgent` with an
 * inline system prompt — shared by three agents, owned by none — on Gemini
 * Flash by default, because this step reads documents and structures them,
 * and it runs once per client × platform, not once per post.
 *
 * Everything degrades: no profile and no charter means no call and no map; a
 * builder that fails or returns nothing leaves the run exactly where it was —
 * choosing from the catalog, the scout and the research, as before C1.
 */

export const STRATEGY_MAP_BUILDER_STEP_ID = "strategy-map-builder";

export const StrategyMapStageSchema = z.enum(["attention", "expertise", "decide"]);

export const StrategyMapBuilderOutputSchema = z.object({
  audience: z
    .array(z.object({ role: z.string().min(1), problems: z.array(z.string().min(1)).min(1) }))
    .min(1)
    .describe("Who the client sells to, and the two to five problems each role actually has — in their words, not the client's."),
  rows: z
    .array(
      z.object({
        problem: z.string().min(1).describe("The buyer problem this row speaks to, from `audience`."),
        stage: StrategyMapStageSchema.describe("attention | expertise | decide — what a post on this row is FOR."),
        idea: z.string().min(1).describe("The post idea in one line: a specific claim, question or how-to, never a theme."),
        type: z.string().optional().describe("The platform's own post-type word, when one fits."),
        evidence: z.string().min(1).describe("What in the client's material this row rests on — a product fact, a stated position, a customer story."),
      }),
    )
    .min(6)
    .max(24),
  skipped: z.array(z.string()).default([]).describe("Problems you saw but could not honestly cut a row from, with why."),
});
export type StrategyMapBuilderOutput = z.infer<typeof StrategyMapBuilderOutputSchema>;

export type StrategyMapPlatform = "x" | "linkedin" | "reddit" | "instagram" | "tiktok";

const PLATFORM_NOTE: Record<StrategyMapPlatform, string> = {
  x: "The platform is X. `type` is the lane: knowledge, opinion, engagement, promotion. Ideas are one sharp claim or one open question each; a thread is still one idea.",
  linkedin: "The platform is LinkedIn. `type` is the archetype (industry-reaction, teardown-framework, lesson, build-in-public, community-question, …). Ideas carry a takeaway a reader can use at work.",
  reddit: "The platform is Reddit, reply-only. Rows are the QUESTIONS the client's buyers ask in public — the question pool — and most rows are expertise or decide by nature; `type` is reddit-reply.",
  instagram: "The platform is Instagram. Ideas must be picturable or settable as bold type; `type` is the format (carousel, single, reel).",
  tiktok: "The platform is TikTok. Ideas are one spoken point each, sayable in under a minute; `type` is the format (talking-head, screen, montage).",
};

/** The builder's system prompt. Inline for the same reason the trend scout's is — shared, owned by no one agent. */
export function buildStrategyMapSystemPrompt(platform: StrategyMapPlatform): string {
  return [
    "You are a content strategist building ONE client's strategy map for ONE platform: the pool of post ideas the account will draw from over the coming weeks, each cut from a real buyer problem and written for one stage of the funnel.",
    "You are given the client's profile, their account charter (what the account is FOR) when one exists, their knowledge and intel when it exists, the platform's own profile document when one exists, and the topics they never touch.",
    "",
    PLATFORM_NOTE[platform],
    "",
    "AUDIENCE first. Name the two to four buyer roles the client actually sells to, and for each the problems that role has — in the buyer's words, specific enough that a post could answer one. A role with no real problem stated is not an audience; leave it out.",
    "",
    "Then the ROWS: 12 to 18 ideas, each on one problem, each for one stage:",
    "  attention — earns it: the industry's open questions, live tensions, the counter-intuitive observation. What a stranger in this audience stops for.",
    "  expertise — shows it: why and how something works or fails, what practitioners get wrong, the mechanism behind a result.",
    "  decide — helps a buyer evaluate: how to pilot, what to measure, how to compare, what a first month looks like.",
    "Aim for the default mix of roughly 3 attention : 2 expertise : 1 decide (D32) — around 7-9 attention, 4-6 expertise, 2-3 decide — unless the client's material honestly supports a different balance.",
    "",
    "Every idea must rest on something in the client's material — a product fact, a stated position, a customer story, a number they own — and `evidence` names it. Never invent a fact, a number, a customer or a result. An idea the material cannot support goes under `skipped` with the reason, not into the rows.",
    "An idea is a specific claim, question or how-to a post could be written from in one sitting. \"Thought leadership about AI\" is a theme, not an idea; \"Why intake queues break in month two, and the one number that predicts it\" is an idea.",
    "Never propose anything under `forbiddenTopics`. Prefer variety across problems and roles: two rows on the same problem must take different stages or different angles.",
    "Answer with the structured output only.",
  ].join("\n");
}

export interface StrategyMapBuilderInput {
  platform: StrategyMapPlatform;
  today: string;
  clientProfile: Record<string, unknown>;
  /** The account charter (`client.getStrategy`), when one exists. */
  accountCharter?: string | undefined;
  /** The client intel report + knowledge base, distilled (`readClientIntelContext`). */
  clientIntelContext?: string | undefined;
  /** The platform's own C1 profile document (`<platform>-agent-profile`), when projected. */
  platformProfile?: string | undefined;
  forbiddenTopics: readonly string[];
}

export interface StrategyMapBuilderDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

/** One builder call, checkpointed under `stepId`. `undefined` when the model step did not complete. */
export async function runStrategyMapBuilder(
  wf: WorkflowContext,
  deps: StrategyMapBuilderDeps,
  stepId: string,
  input: StrategyMapBuilderInput,
): Promise<StrategyMapBuilderOutput | undefined> {
  const builder = new DynamicAgent<StrategyMapBuilderOutput>(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: STRATEGY_MAP_BUILDER_STEP_ID,
      description: "Build the client's strategy map for one platform: buyer roles and their problems, and 12-18 post ideas each cut from one problem for one funnel stage, grounded in the client's own material.",
      allowedTools: [],
      outputSchema: StrategyMapBuilderOutputSchema,
      // Reads documents and structures them, once per client × platform:
      // Gemini Flash by default, retargetable with
      // MODEL_STEP_STRATEGY_MAP_BUILDER_VENDOR/_MODEL like the trend scout.
      modelPolicy: resolveModelPolicy(STRATEGY_MAP_BUILDER_STEP_ID, { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
      maxSteps: 1,
    },
    buildStrategyMapSystemPrompt(input.platform),
  );
  const exec = await wf.step.agent(stepId, builder, {
    platform: input.platform,
    today: input.today,
    clientProfile: input.clientProfile,
    ...(input.accountCharter !== undefined ? { accountCharter: input.accountCharter } : {}),
    ...(input.clientIntelContext !== undefined ? { clientIntelContext: input.clientIntelContext } : {}),
    ...(input.platformProfile !== undefined ? { platformProfile: input.platformProfile } : {}),
    forbiddenTopics: [...input.forbiddenTopics],
  });
  if (exec.status !== "completed" || !exec.finalOutput) return undefined;
  return exec.finalOutput;
}

/** `sm-<platform>-001` … — stable within one build; the middleware keeps them as the row's primary key. */
export function strategyRowId(platform: StrategyMapPlatform, index: number): string {
  return `sm-${platform}-${String(index + 1).padStart(3, "0")}`;
}

export interface EnsureStrategyMapOptions {
  platform: StrategyMapPlatform;
  learning: LearningContextLike;
  /** The step id prefix; the builder runs under `<prefix>` and the write under `<prefix>-write`. */
  stepId: string;
  input: Omit<StrategyMapBuilderInput, "platform" | "platformProfile">;
}

export interface EnsureStrategyMapResult {
  map: LearningStrategyMap | undefined;
  /** `projected`: the middleware's; `engine`: built or found in `state/` by a previous run; `built`: built by THIS run; `none`: no map and nothing to build one from. */
  source: "projected" | "engine" | "built" | "none";
}

/**
 * The map this run selects from: the one it was handed, or — on a client
 * that has none — the one it builds now (C1, first-run path). Never throws:
 * a client with no profile and no charter has nothing to build from and
 * simply has no map; a builder that fails leaves `map` undefined and the run
 * chooses as it did before C1.
 */
export async function ensureStrategyMap(
  wf: WorkflowContext,
  deps: StrategyMapBuilderDeps,
  ctx: AgentContext,
  options: EnsureStrategyMapOptions,
): Promise<EnsureStrategyMapResult> {
  const { platform, learning } = options;
  const existing = learning.strategyMap;
  if (existing !== undefined && existing.rows.length > 0) {
    const projectedBy = learning.sources?.["strategy-map"]?.projectedBy;
    return { map: existing, source: projectedBy === "engine-run" ? "engine" : "projected" };
  }
  // C7 §4.1: a client with NOTHING projected behaves exactly as before the
  // contract — so the first-run build waits for the loop to be live for this
  // client (the middleware has projected at least one learning file). Until
  // then a run selects from the catalog, the scout and the research as it
  // always did, and no model call is spent on a plan nobody will collect.
  if (learning.readiness.present.length === 0) return { map: undefined, source: "none" };
  const hasMaterial = Object.keys(options.input.clientProfile).length > 0 || options.input.accountCharter !== undefined || options.input.clientIntelContext !== undefined;
  if (!hasMaterial) return { map: undefined, source: "none" };

  // The platform's own C1 profile document, read only now that a build is
  // actually going to happen — so a run that builds nothing adds no step.
  const platformProfile = await readPlatformProfileDoc(wf, deps.tools, ctx, platform, `${options.stepId}-read-platform-profile`);

  let output: StrategyMapBuilderOutput | undefined;
  try {
    output = await runStrategyMapBuilder(wf, deps, options.stepId, { platform, ...options.input, ...(platformProfile !== undefined ? { platformProfile } : {}) });
  } catch (error) {
    console.error(`${options.stepId}: the strategy-map builder failed; continuing without a map`, error);
    output = undefined;
  }
  if (!output || output.rows.length === 0) return { map: undefined, source: "none" };

  const rows = output.rows.map((r, i) => ({ id: strategyRowId(platform, i), problem: r.problem, stage: r.stage, idea: r.idea, ...(r.type ? { type: r.type } : {}), evidence: r.evidence, status: "open" as const }));
  const map: LearningStrategyMap = {
    platform,
    builtAt: new Date().toISOString(),
    source: "first-run",
    audience: output.audience,
    rows,
    defaultMix: { attention: 3, expertise: 2, decide: 1 },
  };

  const written = await wf.step.code(`${options.stepId}-write`, async () => {
    const tool = deps.tools["ledger.writeStrategyMap"];
    if (!tool) return { written: false, reason: "ledger.writeStrategyMap is not in this registry" };
    try {
      const outcome = await tool.execute({ platform, source: "first-run", audience: output!.audience, rows, defaultMix: map.defaultMix }, { ctx });
      return outcome.status === "success" ? { written: true, rows: rows.length } : { written: false, reason: `ledger.writeStrategyMap resolved to ${outcome.status}` };
    } catch (error) {
      return { written: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  if (!written.written) console.error(`${options.stepId}-write: ${written.reason} — the map is used for this run but will not reach the middleware`);
  return { map, source: "built" };
}

/** The platform's C1 profile document, for the builder's `platformProfile` input. */
export async function readPlatformProfileDoc(wf: WorkflowContext, tools: AgentToolRegistry, ctx: AgentContext, platform: StrategyMapPlatform, stepId: string): Promise<string | undefined> {
  return readContextDoc(wf, tools, ctx, `${platform}-agent-profile`, stepId);
}
