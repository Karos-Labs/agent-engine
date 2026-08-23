import {
  DynamicAgent,
  GUARDRAIL_OUTPUT_FIELDS,
  GUARDRAIL_STEP_ID,
  GuardrailViolationError,
  buildGuardrailInput,
  buildGuardrailSystemPrompt,
  buildOutputSchema,
  readForbiddenTopics,
  toVerdict,
  type AgentContext,
  type AgentToolRegistry,
  type GuardrailOutput,
  type GuardrailVerification,
  type ModelRouter,
  type PromptStore,
} from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * The terminal topic guardrail, as one call any workflow can append.
 *
 * ## Why this is not `gate.brandCompliance`
 *
 * They look adjacent and are not. `gate.brandCompliance` matches
 * `forbiddenTerms` as case-insensitive substrings — it catches the WORD. This
 * catches the SUBJECT: a draft that discusses a client's forbidden topic
 * fluently without ever using the banned term passes the substring gate and
 * fails this one. A client who said "we do not talk about cryptocurrency"
 * meant the subject, and the term list cannot express that.
 *
 * ## Why it lives here
 *
 * It was written twice — once inside the dynamic runner, once inside
 * tiktok-agent — before it was written once. Two copies of a check whose
 * whole value is that no definition can opt out of it is the beginning of a
 * third that quietly differs.
 *
 * ## Its two rules
 *
 * It is appended by the workflow author rather than read from any editable
 * list, so nothing an admin can delete removes it. And a verifier that could
 * not do its job never blocks good output: an incomplete verification returns
 * `status: "error"` and is recorded, so a human can see the check did not
 * run, rather than throwing and failing a run whose deliverable is fine.
 *
 * A violation is the one case that throws. `GuardrailViolationError` fails the
 * run, which is deliberate and different from `held`: `held` means nothing
 * cleared the gates and a human might publish the empty result anyway, while
 * this output exists and must not ship.
 */
export interface TopicGuardrailDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

/**
 * Runs the guardrail over `deliverableText` and throws on a violation.
 *
 * Returns `undefined` when the client forbids no topics — a real and common
 * state, not a misconfiguration, and one that costs no model call.
 */
export async function runTopicGuardrail(
  wf: WorkflowContext,
  deps: TopicGuardrailDeps,
  deliverableText: string,
  /**
   * The client's forbidden topics, when the caller already has them.
   *
   * Most workflows read `client.getConfig` during their own intake, and making
   * them read it a second time here would add a step to every run's trace —
   * including the majority of runs, for clients who forbid nothing, where the
   * guardrail then does not run at all. Passing what you already loaded keeps
   * the trace showing only steps that did something.
   */
  preloadedForbiddenTopics?: readonly string[],
): Promise<GuardrailVerification | undefined> {
  const ctx: AgentContext = {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };

  // From the client's own stored configuration, never the job payload: a
  // payload-supplied topic list is one a caller can omit.
  let forbiddenTopics: readonly string[];
  if (preloadedForbiddenTopics !== undefined) {
    forbiddenTopics = preloadedForbiddenTopics;
  } else {
    const configTool = deps.tools["client.getConfig"];
    if (!configTool) return undefined;
    const outcome = await wf.step.code(`${GUARDRAIL_STEP_ID}-load-topics`, async () => configTool.execute({}, { ctx }));
    forbiddenTopics = outcome.status === "success" ? readForbiddenTopics(outcome.result) : [];
  }
  if (forbiddenTopics.length === 0) return undefined;

  const verifier = new DynamicAgent(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: GUARDRAIL_STEP_ID,
      description: "Check the finished draft against the topics this client does not engage with.",
      // No tools: this is a judgment over text already in hand, and a verifier
      // that can call tools is a verifier that can be steered.
      allowedTools: [],
      outputSchema: buildOutputSchema([...GUARDRAIL_OUTPUT_FIELDS]),
      // "commodity" is this codebase's own tier for classification work, which
      // is what checking a draft against a fixed list is. It also keeps the
      // cost of having guardrails on at all close to nothing.
      modelPolicy: { policy: "commodity", model: "claude-haiku-4-5-20251001" },
      maxSteps: 1,
    },
    buildGuardrailSystemPrompt([...forbiddenTopics]),
  );

  const exec = await wf.step.agent(GUARDRAIL_STEP_ID, verifier, buildGuardrailInput(deliverableText));
  if (exec.status !== "completed" || !exec.finalOutput) {
    return { status: "error", violatedTopics: [], error: `guardrail verification did not complete (${exec.status})` };
  }

  const verdict = toVerdict(exec.finalOutput as GuardrailOutput, [...forbiddenTopics]);
  if (verdict.status === "violation") throw new GuardrailViolationError(verdict);
  return verdict;
}
