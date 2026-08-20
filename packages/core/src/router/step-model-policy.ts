import type { ModelPolicy, ModelVendor } from "../types/model-policy.js";
import { ModelVendorSchema } from "../types/model-policy.js";

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

  return {
    ...defaultPolicy,
    model: modelOverride ?? defaultPolicy.model,
    ...(vendor !== undefined ? { vendor } : {}),
  };
}
