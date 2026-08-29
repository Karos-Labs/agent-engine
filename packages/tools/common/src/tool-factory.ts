import type { AgentTool, AgentToolCallContext, AgentToolOutcome, ZodSchema } from "@agent-engine/core";
import { describeError, recordToolCallMetric, withToolCallSpan } from "@agent-engine/telemetry";
import { toolingError } from "./errors.js";

export interface DefineToolOptions<TArgs, TResult> {
  name: string;
  /**
   * What the tool does and when to call it — the only prose about this tool
   * the model ever sees (SCRUM-293 / AU7). Required so a new tool can't ship
   * silently blank; source it from the tool's existing TSDoc rather than
   * writing new copy.
   */
  description: string;
  /** Travels into every telemetry record (RFC-01 §9.1 rule 5). Bump on any behavior change. */
  version: string;
  inputSchema: ZodSchema<TArgs>;
  execute(args: TArgs, context: AgentToolCallContext): Promise<AgentToolOutcome<TResult>>;
}

/**
 * Builds an `AgentTool` with two guarantees applied uniformly, so individual
 * tools don't reimplement either:
 *
 * 1. Arguments are parsed against `inputSchema` before `execute` ever runs.
 *    Because no `inputSchema` in this codebase declares a tenant field
 *    (`clientSlug`/`client_id`/etc — RFC-01 §9.1 rule 1), Zod's default
 *    "strip unknown keys" behavior silently drops any tenant override a
 *    model tries to sneak into its arguments — tenant only ever reaches a
 *    tool via `context.ctx.clientSlug`, structurally, not by convention.
 * 2. Anything `execute` throws is caught and reported as `tooling_error`
 *    rather than propagating an unhandled rejection — a broken tool call
 *    must never be mistaken for a content judgment (RFC-01 §6).
 */
export function defineTool<TArgs, TResult>(options: DefineToolOptions<TArgs, TResult>): AgentTool<TArgs, TResult> {
  return {
    name: options.name,
    description: options.description,
    version: options.version,
    inputSchema: options.inputSchema,
    async execute(rawArgs, context) {
      const parsed = options.inputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return toolingError(`"${options.name}": arguments failed the tool's input schema — ${parsed.error.message}`);
      }
      try {
        return await withToolCallSpan(
          {
            runId: context.ctx.runId,
            clientSlug: context.ctx.clientSlug,
            productId: context.ctx.productId,
            ...(context.ctx.slotId !== undefined ? { slotId: context.ctx.slotId } : {}),
            toolName: options.name,
            toolVersion: options.version,
          },
          async (span, markOutcome) => {
            const outcome = await options.execute(parsed.data, context);
            span.setAttribute("outcome_status", outcome.status);
            recordToolCallMetric({ toolName: options.name, status: outcome.status });
            // AU42/SCRUM-326 — same defect as `runStepCode`/`runStepAgent`: a
            // tool reports `tooling_error` by RETURNING it (RFC-01 §6), so
            // without this the span stayed `OK` for the exact case
            // `tooling_error` exists to distinguish from a content judgment.
            // `content_fail`/`not_available` stay `OK`-status — both are real,
            // designed outcomes, not something that broke.
            if (outcome.status === "tooling_error") {
              markOutcome(true, outcome.reason);
            }
            return outcome;
          },
        );
      } catch (err) {
        // describeError walks the whole `.cause` chain (RFC-01 §16.4) — a network-layer
        // failure at the root must stay legible, not flatten into one opaque message.
        recordToolCallMetric({ toolName: options.name, status: "threw" });
        return toolingError(`"${options.name}" threw: ${describeError(err)}`);
      }
    },
  };
}
