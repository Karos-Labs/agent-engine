import type { ModelPolicy, ModelVendor } from "../types/model-policy.js";
import { ModelVendorSchema } from "../types/model-policy.js";
import { assertModelPriced } from "../telemetry/pricing.js";

export interface ResolveModelPolicyOptions {
  /** Defaults to `process.env`. Override for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Derives the env-var prefix for one step's override pair from its own
 * `AgentStepConfig.id` — the same id already visible in every telemetry
 * record, transcript, and log line for that step, so there's no second name
 * to keep in sync. `"x-draft"` → `"X_DRAFT"`, `"reputation-extraction"` →
 * `"REPUTATION_EXTRACTION"`.
 */
function stepEnvPrefix(stepId: string): string {
  return stepId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Resolves one step's `modelPolicy`, letting a deployment override the
 * vendor and/or model **per step** — without touching this repo's code —
 * via two env vars derived from the step's own id:
 *
 *   MODEL_STEP_<ID>_VENDOR    one of "anthropic" | "gemini" | "model-garden" | "openai-compatible"
 *   MODEL_STEP_<ID>_MODEL     the model id to send to that vendor
 *
 * This is the single mechanism behind "pick a model from any provider Agent
 * Platform allows, for anything in the code": every one of this system's 25
 * `BaseAgent` steps calls this instead of inlining a literal `modelPolicy`,
 * so every one of them is independently retargetable by an operator who
 * never opens an editor. Called once, at module-evaluation time, in each
 * agent's `config` field — exactly when `create-model-router-from-env.ts`
 * resolves its own env-driven config, so both read a consistent
 * environment.
 *
 * With no override set, this returns `defaultPolicy` completely unchanged —
 * every existing agent's behavior is bit-for-bit identical to before this
 * function existed.
 *
 * Setting `_VENDOR` without also setting `_MODEL` is rejected at resolution
 * time (a deployment-time config error, not a runtime `tooling_error` three
 * layers away from the misconfiguration): the default model id is almost
 * certainly shaped for the *default* vendor, not the one just switched to
 * (`claude-sonnet-4-6` sent to Gemini fails in a way that names Gemini's API,
 * not this misconfiguration).
 */
export function resolveModelPolicy(
  stepId: string,
  defaultPolicy: ModelPolicy,
  options: ResolveModelPolicyOptions = {},
): ModelPolicy {
  const env = options.env ?? process.env;
  const prefix = `MODEL_STEP_${stepEnvPrefix(stepId)}`;

  const vendorRaw = readEnv(env, `${prefix}_VENDOR`);
  const modelOverride = readEnv(env, `${prefix}_MODEL`);

  if (vendorRaw === undefined && modelOverride === undefined) {
    return defaultPolicy;
  }

  let vendor: ModelVendor | undefined = defaultPolicy.vendor;
  if (vendorRaw !== undefined) {
    const parsed = ModelVendorSchema.safeParse(vendorRaw);
    if (!parsed.success) {
      throw new Error(
        `resolveModelPolicy("${stepId}"): ${prefix}_VENDOR="${vendorRaw}" is not a known vendor — ` +
          `use one of ${ModelVendorSchema.options.join(", ")}`,
      );
    }
    vendor = parsed.data;
    if (modelOverride === undefined) {
      throw new Error(
        `resolveModelPolicy("${stepId}"): ${prefix}_VENDOR is set to "${vendor}" but ${prefix}_MODEL is not — ` +
          `the step's default model id ("${defaultPolicy.model}") is shaped for its default vendor and will not resolve against "${vendor}". ` +
          `Set ${prefix}_MODEL to a model id that vendor actually serves.`,
      );
    }
  }

  const model = modelOverride ?? defaultPolicy.model;
  // SCRUM-361. An env-supplied model id is the one thing CI's
  // `check-model-pricing` cannot see — it scans static source, and this value
  // arrives from the environment. Refused here, at deployment wiring, rather
  // than after the first billed call.
  assertModelPriced(model, `resolveModelPolicy("${stepId}")`);

  return {
    ...defaultPolicy,
    model,
    ...(vendor !== undefined ? { vendor } : {}),
  };
}

/**
 * Applies a per-run, per-stage model override on top of an already-resolved
 * policy.
 *
 * The env pair above is a DEPLOYMENT decision — "this installation routes the
 * highlights step at Gemini" — and it is resolved once when an agent's config
 * is built. This is a different question with a different owner: an admin in
 * Agent Studio choosing which catalogued Vertex model one stage of one agent
 * should use, delivered per run in `AgentContext.stageModels`.
 *
 * They compose in the order you would want if you had to explain it to
 * someone: the compiled default is the floor, a deployment override replaces
 * it, and a Studio choice for this specific run replaces that. The operator
 * who set an env var did so about the whole installation; the admin who picked
 * a model in Studio did so about this agent, and is the more specific
 * statement.
 *
 * Only the model id moves. Vendor deliberately does not: the `models`
 * collection that Studio picks from records which vendor serves each id, so
 * changing the vendor here from a bare string would be re-deriving a fact the
 * catalog already holds, and getting it wrong sends a model id to an API that
 * has never heard of it. A model whose vendor differs from the step's default
 * needs the env pair, which refuses that exact mismatch.
 */
export function applyStageModelOverride(
  stepId: string,
  policy: ModelPolicy,
  stageModels: Readonly<Record<string, string>> | undefined,
): ModelPolicy {
  const override = stageModels?.[stepId];
  if (!override) return policy;
  if (override === policy.model) return policy;
  // The other run-time path CI cannot see: an admin picking a model per run in
  // the Studio. Same refusal, same reason — before the run starts, not after
  // it has produced a cost figure nobody can trust.
  assertModelPriced(override, `applyStageModelOverride("${stepId}")`);
  return { ...policy, model: override };
}
