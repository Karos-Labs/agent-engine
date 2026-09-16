import { addSpanEvent, logWarning } from "@agent-engine/telemetry";
import { OutputLimitExceededError } from "./structured-output.js";
import { extractHttpStatus } from "./retry.js";
import type { CompletionRequest, CompletionResult, ModelAdapter, ModelProvenance } from "./types.js";

/**
 * One failed hop, in the shape `AgentStepTelemetry.servedBy.failedOver`
 * already carries (`types/agent-step.ts`) — so a Gemini failover reads
 * identically to a Claude one in a run report.
 */
export interface GeminiFailoverHop {
  readonly from: string;
  readonly errorClass: string;
  readonly status?: number;
}

/**
 * Which errors mean "this ROUTE is refusing us" rather than "this REQUEST is
 * wrong". Only the first kind is worth re-issuing somewhere else; the second
 * would fail identically on every transport and re-issuing it just buys the
 * same failure twice, at twice the price.
 *
 * - **403** is the one this adapter exists for. Vertex answered every Gemini
 *   call in both projects with `Lightning dunning decision is deny for
 *   project` on 2026-09-13/14 — a billing hold, not a bad request. The runs
 *   that day lost research extraction AND image vetting, shipped
 *   all-typographic, and were approved at the human gate, because a Gemini
 *   step had nowhere else to go.
 * - **429** is quota. Every `ModelAdapter` here already ran its own
 *   `withRetry` (which retries 429 up to three times with backoff), so a 429
 *   arriving at this layer has already been waited out once and is not going
 *   to clear by being waited out again.
 * - **404** is the model not being served on this backend/region — Gemini
 *   model availability differs between Vertex regions and the Developer API,
 *   which is precisely a case the other transport can answer.
 * - **5xx** likewise survived `withRetry`'s three attempts, so it is the
 *   backend being down rather than a blip.
 *
 * Everything else — a schema the model cannot satisfy, a malformed request,
 * a safety block — propagates untouched.
 *
 * DELIBERATELY NOT LISTED: {@link OutputLimitExceededError}. A cut-off structured
 * output is the most tempting wrong failover in this file: it looks like a
 * transport failure and it is not. The ceiling is a property of the REQUEST
 * (`maxTokens`) and of how much the model wants to say, so the second route
 * truncates at exactly the same place — and unlike a 403, a truncation has
 * already BILLED for a full ceiling's worth of output tokens, so failing it
 * over doubles the most expensive failure mode the engine has. It is caught
 * explicitly below rather than left to fall through the status check, so the
 * day someone gives it a status the rule does not quietly invert.
 *
 * Near-duplicate of `resilient-claude-adapter.ts`'s classifier on purpose,
 * and the sets are NOT the same: Claude's includes the direct Anthropic API's
 * 400 `credit balance is too low` (a message-matched special case that has no
 * Google analogue) and excludes 5xx (its primary is Agent Platform, whose 5xx
 * profile differs). Hoisting one shared classifier is the right end state and
 * is a single-commit refactor once both adapters can be edited together; it
 * was not worth doing from a work package that owns only one of them.
 */
function isFailoverWorthy(err: unknown): boolean {
  if (err instanceof OutputLimitExceededError) return false;
  const status = extractHttpStatus(err);
  if (status === undefined) return false;
  if (status === 403 || status === 404 || status === 429) return true;
  return status >= 500 && status < 600;
}

function classifyFailover(err: unknown): { errorClass: string; status?: number } {
  const status = extractHttpStatus(err);
  if (status === 429) return { errorClass: "rate_limited", status };
  if (status === 404) return { errorClass: "not_served", status };
  // Named so an operator reading the log sees "pay the bill" rather than a
  // generic forbidden — this is the exact string Vertex returned on 13/14.9.
  if (status === 403) {
    return { errorClass: /dunning|billing/i.test(err instanceof Error ? err.message : String(err)) ? "billing_denied" : "forbidden", status };
  }
  if (status !== undefined && status >= 500 && status < 600) return { errorClass: "backend_error", status };
  if (status !== undefined) return { errorClass: "http_error", status };
  const name = err instanceof Error ? err.name : "unknown";
  return { errorClass: /timeout|abort/i.test(name) ? "timeout" : "other" };
}

function describeHop(from: string, err: unknown): GeminiFailoverHop {
  const { errorClass, status } = classifyFailover(err);
  return { from, errorClass, ...(status !== undefined ? { status } : {}) };
}

/**
 * Makes a Gemini failover audible, on the same `model.failover` event name
 * `ResilientClaudeAdapter` emits — one log-based metric counts hops across
 * both families, and an operator does not have to know which vendor broke to
 * find out that something did. `from`/`to` carry the adapter ids, so the two
 * are still separable in a query.
 *
 * Best-effort by construction: instrumentation must never turn a successful
 * failover into a failure.
 */
function recordFailover(details: { from: string; to: string; model: string; toModel?: string; err: unknown }): void {
  const { errorClass, status } = classifyFailover(details.err);
  const fields = {
    event: "model.failover",
    from: details.from,
    to: details.to,
    model: details.model,
    ...(details.toModel !== undefined && details.toModel !== details.model ? { toModel: details.toModel } : {}),
    errorClass,
    ...(status !== undefined ? { status } : {}),
  };
  logWarning(`model failover: ${details.from} -> ${details.to} (${errorClass}${status !== undefined ? ` ${status}` : ""}) for ${details.model}`, fields);
  addSpanEvent("model.failover", fields);
}

/**
 * Thrown when every Google transport for a Gemini step is gone AND no text
 * substitute was authorised for it.
 *
 * This is the honest end of the chain for a step whose job is to LOOK at
 * something. A text model asked to judge a picture it cannot see will answer
 * — fluently, and about nothing — and that answer is worse than an absence,
 * because the absence is visible on the gate payload and the confabulation is
 * not. So the chain stops here and says so.
 *
 * `kind: "not_available"` is the same word `ToolResult` uses for "the
 * requested data legitimately does not exist right now" (`agent/tool.ts`),
 * and it is the outcome a caller should map this to: the step records what
 * could not be done and the run continues with that fact on the record. It is
 * never a hold — budgets and instruments do not hold runs in this engine.
 */
export class GeminiRoutesExhaustedError extends Error {
  readonly kind = "not_available" as const;
  /** Every hop that failed, in order, ready to attach to `servedBy.failedOver` / `stepFailures[].why`. */
  readonly failedOver: readonly GeminiFailoverHop[];
  /** The last transport error, kept so the underlying 403/429 is never lost behind this wrapper. */
  override readonly cause: unknown;

  constructor(message: string, options: { failedOver: readonly GeminiFailoverHop[]; cause: unknown }) {
    super(message);
    this.name = "GeminiRoutesExhaustedError";
    this.failedOver = options.failedOver;
    this.cause = options.cause;
  }
}

/**
 * Whether a Claude text model may stand in for Gemini once both Google
 * transports are gone.
 *
 * There is no way for this adapter to infer it, and pretending otherwise
 * would be the whole defect in miniature. Images never reach
 * `CompletionRequest` in this engine — vision lives inside `karos-media`'s
 * own `GoogleGenAI` clients (`inspect-images.ts`, `generate-image.ts`,
 * `visual-qa-gate.ts`), not in the router — so at this layer a request that
 * judges a photograph and one that judges a sentence are structurally
 * identical. Only the construction site knows which it built, so only the
 * construction site may say, and saying nothing means `refuse`.
 *
 * The vision-free judges (`07g-relevance-gate`, `07j-value-gate`,
 * `08c-package-post`, research extraction) pass `allow`. The steps that read
 * pixels do not.
 */
export type GeminiTextSubstitution =
  | { readonly kind: "refuse" }
  | {
      readonly kind: "allow";
      /** The Claude-family adapter to fall to — a genuinely different model family, hence the model id below. */
      readonly adapter: ModelAdapter;
      /** Sent INSTEAD of `req.model`: asking an Anthropic adapter to serve `gemini-2.5-pro` is a third, differently-shaped failure. */
      readonly model: string;
    };

export interface ResilientGeminiAdapterOptions {
  /** Gemini on Vertex / Agent Platform (ADC) — today's only route, and the primary. */
  primary: ModelAdapter;
  /**
   * The Gemini Developer API (`GEMINI_API_KEY`), built by
   * `createDirectGeminiAdapter`. SAME model ids, different transport — the
   * exact shape of Claude's primary->secondary hop. Optional: a deployment
   * with no key configured gets today's behaviour, a bare Vertex adapter with
   * one extra `catch`, not a wrapper that silently does nothing.
   */
  direct?: ModelAdapter;
  /**
   * What happens when both Google transports are gone. A function form lets
   * ONE adapter instance serve a router whose Gemini steps are a mix of
   * vision and vision-free work, which is what the Instagram agent is.
   *
   * Default `{ kind: "refuse" }`: never a silent substitution, the same rule
   * `ClaudeRoute` and `GeminiRoute` already follow for routes.
   */
  textSubstitution?: GeminiTextSubstitution | ((req: CompletionRequest<unknown>) => GeminiTextSubstitution);
}

/**
 * Gemini's missing failover chain: Vertex -> the Gemini Developer API -> (only
 * where a text answer is honest) a Claude model, and otherwise a typed
 * refusal.
 *
 * ## Why this is core-router work, not Instagram work
 *
 * Seven agents route steps to Gemini. The Instagram carousel is only where
 * the absence was finally paid for: on 2026-09-13/14 a Vertex 403 killed
 * `04b-research-extract-facts` and `05c-inspect-candidates` in the same run,
 * the post shipped with no facts and no pictures, and the human gate approved
 * it because nothing on the payload said a model had failed. Claude got this
 * in AU61/SCRUM-360; Gemini never did.
 *
 * ## WHICH HALF OF THAT INCIDENT THIS FILE COVERS — read this before assuming
 *
 * **The text half only.** `CompletionRequest` carries no images (`types.ts`),
 * so no step that LOOKS at something is routed through here at all:
 * `05c-inspect-candidates`, `06d-generate-images` and `08a4-inspect-rendered`
 * resolve their own client from `karos-media`'s
 * `createImageGenerationClientFromEnv`. `04b` is covered by this adapter;
 * `05c` is covered by `packages/tools/karos-media/src/resilient-genai-client.ts`,
 * which gives that client the same Vertex -> direct-key hop and emits the same
 * `model.failover` event. Two files, one incident, and the sentence above used
 * to imply one file covered both.
 *
 * ## The three hops, and why the third one is conditional
 *
 * `primary` and `direct` are the SAME models on two Google transports — no
 * model identity changes, so RFC-01 §5.4's "a pinned step never silently
 * swaps models" is untouched, exactly as for Claude's Agent-Platform->direct
 * hop. The third hop DOES change model family, and it is the one place this
 * adapter is allowed to refuse: see {@link GeminiTextSubstitution} and
 * {@link GeminiRoutesExhaustedError}.
 *
 * ## What it does not do
 *
 * No new vendor: both Google endpoints are Google's, both model ids already
 * resolve in `MODEL_PRICING`, and the Claude hop uses an adapter the caller
 * already built. And it books cost exactly ONCE — only the hop that returned
 * contributes usage, because only its `CompletionResult` is returned. A hop
 * that threw a 403 burned nothing; a hop that threw a truncation is not
 * failed over at all (see {@link isFailoverWorthy}), so its already-billed
 * tokens are reported by the step that raised it and never double-counted
 * here.
 */
export class ResilientGeminiAdapter implements ModelAdapter {
  readonly providerId = "google-gemini-resilient";

  constructor(private readonly options: ResilientGeminiAdapterOptions) {}

  private substitutionFor(req: CompletionRequest<unknown>): GeminiTextSubstitution {
    const declared = this.options.textSubstitution;
    if (declared === undefined) return { kind: "refuse" };
    return typeof declared === "function" ? declared(req) : declared;
  }

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const failedOver: GeminiFailoverHop[] = [];
    const withProvenance = (result: CompletionResult<TOutput>, hop: ModelProvenance["hop"], servedBy: string): CompletionResult<TOutput> => ({
      ...result,
      provenance: { hop, servedBy, failedOver: [...failedOver] },
    });

    let lastErr: unknown;
    try {
      return withProvenance(await this.options.primary.complete(req), "primary", this.options.primary.providerId);
    } catch (primaryErr) {
      if (!isFailoverWorthy(primaryErr)) throw primaryErr;
      lastErr = primaryErr;
      failedOver.push(describeHop(this.options.primary.providerId, primaryErr));

      if (this.options.direct !== undefined) {
        recordFailover({ from: this.options.primary.providerId, to: this.options.direct.providerId, model: req.model, err: primaryErr });
        try {
          return withProvenance(await this.options.direct.complete(req), "secondary", this.options.direct.providerId);
        } catch (directErr) {
          if (!isFailoverWorthy(directErr)) throw directErr;
          lastErr = directErr;
          failedOver.push(describeHop(this.options.direct.providerId, directErr));
        }
      }
    }

    // Both Google transports are gone (or the only one configured is). The
    // last hop changes model FAMILY, so it happens only where the caller has
    // said a text answer is an honest answer for this step.
    const substitution = this.substitutionFor(req as CompletionRequest<unknown>);
    if (substitution.kind === "refuse") {
      throw new GeminiRoutesExhaustedError(
        `google-gemini: every Google transport refused "${req.model}" (${failedOver.map((h) => `${h.from} ${h.errorClass}${h.status !== undefined ? ` ${h.status}` : ""}`).join(" -> ")}) ` +
          "and no text substitute is authorised for this step — a model that cannot see the image must not be asked to judge it",
        { failedOver, cause: lastErr },
      );
    }

    recordFailover({
      from: failedOver[failedOver.length - 1]?.from ?? this.options.primary.providerId,
      to: substitution.adapter.providerId,
      model: req.model,
      toModel: substitution.model,
      err: lastErr,
    });
    const result = await substitution.adapter.complete({ ...req, model: substitution.model });
    return withProvenance(result, "tertiary", substitution.adapter.providerId);
  }
}
