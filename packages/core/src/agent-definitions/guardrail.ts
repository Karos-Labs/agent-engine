import { z } from "zod";
import type { AgentDefinitionField } from "./types.js";

/**
 * Topic guardrails for dynamic agents — ported from agent-service's
 * `runner/src/dynamic/guardrail-verify.ts`.
 *
 * One extra model call made by the ENGINE after the admin's pipeline has
 * produced a deliverable: it receives the finished text plus the client's
 * forbidden topics and names any the output actually engages with.
 *
 * ## Why this is not a stage
 *
 * It is appended by the workflow builder, never read from
 * `AgentDefinition.stages`, for the same reason it lives outside `spec.steps`
 * in the system it came from: a check an admin can remove with a bin icon is
 * a convention, not a guarantee. No Studio edit reaches it.
 *
 * ## Why the topic list is not taken from the dispatch
 *
 * It is read from the client's own stored configuration rather than from the
 * job payload. A payload-supplied list is a list a caller can omit, which is
 * the deletable-check problem wearing different clothes.
 *
 * ## Fail open, loudly
 *
 * Any failure — the model call erroring, a reply that does not satisfy the
 * schema — is `status: "error"`, never `"violation"`. A verifier that cannot
 * do its job must not manufacture findings against good output. The error is
 * surfaced so a human knows the check did not run, rather than seeing a green
 * tick it did not earn.
 */

/** Bounded so a long deliverable cannot push the topic list out of the verifier's attention. */
export const GUARDRAIL_MAX_OUTPUT_CHARS = 24_000;

export const GUARDRAIL_STEP_ID = "guardrail-verify";

export interface GuardrailVerification {
  status: "clean" | "violation" | "error";
  violatedTopics: string[];
  evidence?: string;
  /** Why the check could not run, when `status` is `"error"`. */
  error?: string;
}

/**
 * The verifier's output contract, expressed in the same flat field DSL every
 * dynamic stage uses — so `BaseAgent` enforces it and an unparseable reply is
 * a `content_fail` the caller reports as `error`, rather than something this
 * module has to hand-parse out of prose.
 */
export const GUARDRAIL_OUTPUT_FIELDS: readonly AgentDefinitionField[] = [
  {
    name: "violatedTopics",
    type: "string[]",
    description:
      "Every listed topic the draft actually engages with, copied verbatim from the list. Empty when it engages with none.",
    optional: false,
  },
  {
    name: "evidence",
    type: "string",
    description: "A short quote from the draft supporting the first violation. Omit when there are none.",
    optional: true,
  },
];

export const GuardrailOutputSchema = z.object({
  violatedTopics: z.array(z.string()),
  evidence: z.string().optional(),
});
export type GuardrailOutput = z.infer<typeof GuardrailOutputSchema>;

/**
 * The verifier's system prompt.
 *
 * Inline rather than resolved through `PromptStore`, matching how every other
 * part of a dynamic agent carries its own prompt — and deliberately so here:
 * a guardrail whose wording lives in an editable store is editable, which is
 * the thing this is built to avoid.
 */
export function buildGuardrailSystemPrompt(forbiddenTopics: readonly string[]): string {
  const list = forbiddenTopics.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    "You are a compliance checker. You are given a list of topics a company does not engage with, and a draft produced for that company. Decide whether the draft actually engages with any listed topic.",
    "",
    "Engaging means: writing about it, recommending it, speculating about it, or taking a position on it. A passing mention that explicitly declines to cover the topic is NOT engaging with it, and neither is a word that merely resembles a listed topic in a different sense.",
    "",
    "TOPICS THIS COMPANY DOES NOT ENGAGE WITH:",
    list,
    "",
    "Report every listed topic the draft engages with, copied verbatim from the list above. Report none when it engages with none. Be strict about what counts as engaging, and never invent a violation to seem thorough.",
  ].join("\n");
}

/** What the verifier is asked to judge. Truncated, per `GUARDRAIL_MAX_OUTPUT_CHARS`. */
export function buildGuardrailInput(deliverable: string): { draft: string } {
  return { draft: deliverable.slice(0, GUARDRAIL_MAX_OUTPUT_CHARS) };
}

/**
 * Turns the verifier's structured output into a verdict.
 *
 * A reported topic that is not on the client's list is dropped: the model was
 * told to copy verbatim, and honouring an invented topic would block a run
 * over something the client never forbade. Matching is case-insensitive and
 * whitespace-tolerant, because "copied verbatim" is a request rather than a
 * guarantee.
 */
export function toVerdict(
  output: GuardrailOutput,
  forbiddenTopics: readonly string[],
): GuardrailVerification {
  const allowed = new Map(forbiddenTopics.map((t) => [t.trim().toLowerCase(), t]));
  const matched: string[] = [];
  for (const reported of output.violatedTopics) {
    const canonical = allowed.get(reported.trim().toLowerCase());
    if (canonical && !matched.includes(canonical)) matched.push(canonical);
  }

  if (matched.length === 0) return { status: "clean", violatedTopics: [] };
  return {
    status: "violation",
    violatedTopics: matched,
    ...(output.evidence ? { evidence: output.evidence } : {}),
  };
}

/**
 * Reads a client's forbidden topics out of their stored configuration.
 *
 * Absent or empty is a real, common state meaning "this client forbids
 * nothing" — not a misconfiguration, and not a reason to fail. The caller
 * skips the check entirely, because there is nothing to check against.
 */
export function readForbiddenTopics(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const raw = (config as { forbiddenTopics?: unknown }).forbiddenTopics;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
}

/** Thrown when a finished deliverable engages with a topic the client forbids. */
export class GuardrailViolationError extends Error {
  readonly violatedTopics: string[];
  readonly evidence: string | undefined;

  constructor(verification: GuardrailVerification) {
    const topics = verification.violatedTopics.join(", ") || "a forbidden topic";
    super(`Blocked by topic guardrail: draft engaged with ${topics}`);
    this.name = "GuardrailViolationError";
    this.violatedTopics = verification.violatedTopics;
    this.evidence = verification.evidence;
  }
}
