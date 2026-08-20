import type { MessagesApiClient } from "./types.js";
import { MessagesApiAdapter, type ModelIdCodec } from "./messages-api-adapter.js";
import type { RetryOptions } from "./retry.js";
import { toAgentPlatformModelId, toCanonicalModelId } from "./agent-platform-model-ids.js";

/** Canonical Claude API ids in, Agent Platform's `@YYYYMMDD` spelling out — and back again on the response. */
export const AGENT_PLATFORM_MODEL_ID_CODEC: ModelIdCodec = {
  toProvider: toAgentPlatformModelId,
  toCanonical: toCanonicalModelId,
};

export interface AgentPlatformAdapterOptions {
  /**
   * One client per region. Agent Platform bakes the region into the client's
   * base URL (`https://<region>-aiplatform.googleapis.com`, or the
   * `global`/`eu`/`us` endpoints), so serving a model that the configured
   * endpoint doesn't carry means constructing a second client — not passing a
   * different argument. Memoize inside the factory; it is called per request.
   */
  clientForRegion: (region: string) => MessagesApiClient;
  /** `CLOUD_ML_REGION` — `global` unless a deployment pins otherwise. */
  defaultRegion: string;
  /**
   * Per-model region pin, for models the default endpoint doesn't serve.
   * Returning `undefined` means "use `defaultRegion`". Wired from the
   * `VERTEX_REGION_*` variables in `../create-model-router-from-env.ts`.
   */
  regionForModel?: (canonicalModelId: string) => string | undefined;
  retryOptions?: RetryOptions;
  promptCaching?: boolean;
}

/**
 * Google Cloud's Agent Platform (formerly Vertex AI) route to the same Claude
 * models — the default `pinned`-tier route for this engine.
 *
 * Why this is the default rather than a redundancy option (RFC-01 §11 framed
 * it as the latter): authentication moves from a long-lived API key to
 * Application Default Credentials — the attached service account on Cloud
 * Run, `gcloud` locally. That means **no model credential is ever passed to a
 * container as an environment variable value**, which is precisely the rule
 * RFC-01 §16.3 added after `ANTHROPIC_API_KEY` was found in plaintext in
 * `karoscmo-prep`'s Cloud Run audit logs. The route change deletes that class
 * of exposure rather than mitigating it. Billing also consolidates onto the
 * GCP project the rest of the stack already runs on.
 *
 * The wire protocol is the same Messages API, so everything except the
 * client, the model-id spelling, and the region resolution is inherited from
 * `MessagesApiAdapter` unchanged — including the structured-output tool call,
 * the retry policy, and the prompt-cache breakpoint.
 */
export class AgentPlatformAdapter extends MessagesApiAdapter {
  constructor(options: AgentPlatformAdapterOptions) {
    const { clientForRegion, defaultRegion, regionForModel } = options;
    super({
      providerId: "google-agent-platform",
      client: (canonicalModelId) => clientForRegion(regionForModel?.(canonicalModelId) ?? defaultRegion),
      modelIds: AGENT_PLATFORM_MODEL_ID_CODEC,
      ...(options.retryOptions !== undefined ? { retryOptions: options.retryOptions } : {}),
      ...(options.promptCaching !== undefined ? { promptCaching: options.promptCaching } : {}),
    });
  }
}
