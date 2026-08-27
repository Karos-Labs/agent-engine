import type { MessagesApiClient } from "./types.js";
import { IDENTITY_MODEL_ID_CODEC, MessagesApiAdapter } from "./messages-api-adapter.js";
import type { RetryOptions } from "./retry.js";

/**
 * Direct-to-Anthropic route for the `pinned` tier (RFC-01 §3, §5.4) —
 * cache-optimized, never routed through a gateway.
 *
 * Since Google Cloud's Agent Platform (formerly Vertex AI) became the
 * default route (see `../create-model-router-from-env.ts`), this is the
 * local-development path and the escape hatch for an Agent Platform incident
 * or a project whose Model Garden access hasn't landed yet — a *second
 * network path to the same models*, per RFC-01 §5.4's note that Vertex "is
 * not a fourth tier — it's a second route to the same pinned models."
 * Selected with `MODEL_PROVIDER=anthropic`.
 *
 * All request/response mechanics live in `MessagesApiAdapter`; this class
 * only fixes the identity model-id codec (canonical Claude API ids are what
 * this route speaks natively) and the `anthropic` provider id.
 */
export class AnthropicAdapter extends MessagesApiAdapter {
  constructor(client: MessagesApiClient, retryOptions: RetryOptions = {}, promptCaching = true) {
    super({ providerId: "anthropic", client, retryOptions, modelIds: IDENTITY_MODEL_ID_CODEC, promptCaching });
  }
}
