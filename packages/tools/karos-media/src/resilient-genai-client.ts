import { extractHttpStatus } from "@agent-engine/core";
import { addSpanEvent, logWarning } from "@agent-engine/telemetry";

/**
 * ── THE VISION AND GENERATION CLIENTS GET THE SAME TWO TRANSPORTS THE ROUTER
 *    HAS, AND UNTIL NOW THEY HAD ONE. ──
 *
 * `ResilientGeminiAdapter` (`packages/core/src/router/adapters/`) was written
 * for the 2026-09-13/14 incident in which a Vertex 403 —
 * `Lightning dunning decision is deny for consumer` — killed both
 * `04b-research-extract-facts` and `05c-inspect-candidates` in the same run and
 * the post shipped all-typographic and was approved.
 *
 * It only ever covered the first of those two. A `CompletionRequest` carries no
 * images (`packages/core/src/router/adapters/types.ts`), so the vision work does
 * not go through the router at all: `media.inspectImages`, `image.generate` and
 * the video QA gate resolve their client from
 * `createImageGenerationClientFromEnv`, which was a bare
 * `new GoogleGenAI({ vertexai: true, … })` with no second transport and no
 * retry. So the steps the incident actually killed — `05c`, `06d`,
 * `08a4-inspect-rendered` — were left exactly as single-sourced as before,
 * behind an adapter whose header said otherwise.
 *
 * This is the missing half, at the one seam both capabilities share: the
 * `models.generateContent` call. Vertex first, and on a transport failure the
 * **Gemini Developer API** with `GEMINI_API_KEY` — the same second endpoint the
 * router hops to, the same vendor, the same pricing, no new credential beyond
 * the one `.env.example` already documents.
 *
 * ## What this deliberately does NOT do
 *
 * There is no text substitution and no third hop. `ResilientGeminiAdapter`'s
 * `textSubstitution: "refuse"` exists because a text model asked to judge a
 * picture it cannot see answers fluently and about nothing; the same reasoning
 * applies here with more force, since every caller of this client is a step
 * whose whole job is to LOOK at something. When both transports are gone the
 * error propagates, and each tool's own `not_available` path reports it — which
 * is the honest outcome and never a hold.
 *
 * ## What is recorded, and what is not
 *
 * A hop emits the same `model.failover` log event and span event the router's
 * adapters emit, so one log-based metric counts hops across the router and the
 * media package alike. It is NOT threaded onto the workflow's per-step failure
 * record: `stepFailures[].why` cannot yet say "vertex 403 -> direct key" for a
 * tool call, because a tool has no channel to the step's own telemetry. The log
 * event is the instrument that exists; the step-level record is not claimed.
 */

/** The narrow slice of `@google/genai` every caller in this package uses. */
export interface GenerateContentClient {
  models: {
    generateContent(request: { model: string; contents: unknown; config?: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Whether an error is worth another transport.
 *
 * The same set `ResilientGeminiAdapter.isFailoverWorthy` uses, and it is
 * restated rather than imported because that function is module-private in
 * `packages/core` and hoisting a shared classifier is a refactor that belongs
 * in a commit that owns both files. **403** is the one this exists for: it is
 * what Vertex returned, in both projects, for a billing state that has nothing
 * to do with the request. 429 and 5xx come along because a second endpoint
 * genuinely answers them; 404 because a model served in one place and not the
 * other is the other half of the same fault.
 */
export function isMediaFailoverWorthy(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (status === undefined) return false;
  if (status === 403 || status === 404 || status === 429) return true;
  return status >= 500 && status < 600;
}

/** The hop's reason, in the words an operator reading a log needs. */
export function classifyMediaFailover(err: unknown): { errorClass: string; status?: number } {
  const status = extractHttpStatus(err);
  if (status === undefined) return { errorClass: "other" };
  if (status === 429) return { errorClass: "rate_limited", status };
  if (status === 404) return { errorClass: "not_served", status };
  if (status === 403) {
    // Named so an operator sees "pay the bill" rather than a generic forbidden
    // — this is the exact string Vertex returned on 13/14.9.
    return { errorClass: /dunning|billing/i.test(err instanceof Error ? err.message : String(err)) ? "billing_denied" : "forbidden", status };
  }
  if (status >= 500 && status < 600) return { errorClass: "backend_error", status };
  return { errorClass: "http_error", status };
}

/**
 * Wraps a primary client so a transport failure re-runs the SAME request on a
 * fallback client.
 *
 * Returns the primary unchanged when there is no fallback, so a deployment with
 * only one credential behaves exactly as it did.
 *
 * The retry is a single hop, not a loop: two transports, one attempt each. A
 * generation call costs real money and a vision call costs a real image read,
 * and neither is worth spending twice against an endpoint that has already said
 * no for a reason that will not change inside one run.
 */
export function withGenAiFailover(primary: GenerateContentClient, fallback: GenerateContentClient | undefined, labels: { from: string; to: string }): GenerateContentClient {
  if (fallback === undefined) return primary;
  return {
    models: {
      async generateContent(request) {
        try {
          return await primary.models.generateContent(request);
        } catch (error) {
          if (!isMediaFailoverWorthy(error)) throw error;
          const { errorClass, status } = classifyMediaFailover(error);
          const fields = {
            event: "model.failover",
            from: labels.from,
            to: labels.to,
            model: request.model,
            errorClass,
            ...(status !== undefined ? { status } : {}),
          };
          // Best-effort by construction: instrumentation must never turn a
          // successful failover into a failure.
          try {
            logWarning(`model failover: ${labels.from} -> ${labels.to} (${errorClass}${status !== undefined ? ` ${status}` : ""}) for ${request.model}`, fields);
            addSpanEvent("model.failover", fields);
          } catch {
            /* ignore */
          }
          return await fallback.models.generateContent(request);
        }
      },
    },
  };
}
