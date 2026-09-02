import type { AgentContext, AgentToolRegistry, GateResponse, TemplateFeedback } from "@agent-engine/core";
import type { GateDefinition, WorkflowContext } from "./context.js";
import { WorkflowHeld } from "./signals.js";

/**
 * One accumulated revision request, in the order a person made them.
 *
 * Carried into the next attempt so the drafting step can act on all of them
 * rather than only the most recent — a reviewer who asked for a shorter hook
 * on round one and a different closer on round two expects both, and
 * forgetting the first is how a revision loop feels broken.
 */
export interface RevisionNote {
  revision: number;
  actor: string;
  at: string;
  feedback: string;
}

export interface ReviewCycleResult<T> {
  output: T;
  /** Which revision was approved. 0 means it was approved first time. */
  revision: number;
  /** Every revision request that shaped it, oldest first. */
  notes: RevisionNote[];
  response: GateResponse;
}

export interface ReviewCycleOptions<T> {
  /**
   * Base gate id. Each round registers `${gateId}-r${revision}` — one gate
   * record per round, because a gate record holds exactly one response and a
   * second round needs somewhere to put a second one.
   */
  gateId: string;
  /**
   * Rounds of revision allowed after the first attempt. 2 means: draft, then
   * up to two revises, then the third `revise` is treated as a hold.
   *
   * Bounded on purpose. An unbounded revision loop is an unbounded spend: a
   * reviewer who keeps clicking revise would keep re-running paid drafting
   * steps forever, and there is no point at which the run would notice.
   */
  maxRevisions: number;
  /**
   * Produces the thing being reviewed.
   *
   * `revision` MUST be folded into every checkpointed step id inside this
   * callback (`05-write-copy-r1-attempt-1`), or the second round short-circuits
   * on the first round's checkpoints and returns the identical output — the
   * loop would spin without ever changing anything. Anything deliberately
   * NOT re-run on a revision (research, a topic claim) simply keeps its id
   * and short-circuits, which is how a revision reuses expensive work.
   */
  attempt: (revision: number, notes: readonly RevisionNote[]) => Promise<T>;
  /** The gate to register for this round, given what `attempt` produced. */
  buildGate: (output: T, revision: number) => GateDefinition;
  /**
   * Skips the gate and synthesizes an approval. The same `autoApprove` escape
   * hatch every agent here already has.
   *
   * No longer only "for tests and evals": `seo-geo-agent` and
   * `intel-report-agent` pass it in production, because neither publishes
   * under a client's name and so neither has anything for a reviewer to
   * approve (`buildWorkflowForProduct`). Worth knowing when reading the
   * `actor: "system"` this writes — that actor now appears on real runs, and
   * `step-gate.ts` keeps it distinct from `"system:gate-timeout"` for exactly
   * that reason.
   */
  autoApprove?: boolean;
  /**
   * Called once per decision, whatever it was, before the cycle acts on it.
   *
   * This is where feedback reaches durable memory. Deliberately a callback
   * rather than a store dependency: this package is Layer 1 and owns no
   * tools, so the agent supplies the write. Failures inside it are the
   * agent's problem to swallow — this primitive does not catch, because
   * silently losing a reviewer's note is worse than a loud failure.
   */
  onDecision?: (decision: {
    revision: number;
    response: GateResponse;
    /** Template notes, already split out for the caller's convenience. */
    templateFeedback: readonly TemplateFeedback[];
    /**
     * The output `attempt` produced THIS round — added SCRUM-306 (AU23) so a
     * caller's `onDecision` can persist the actual drafted content a
     * rejection (or any other decision) was made about, not only the
     * reviewer's verdict on it. Safe to read here without any staleness risk:
     * the cycle is a strict, single-threaded loop (attempt -> buildGate ->
     * gate -> onDecision, one round fully resolves before the next begins),
     * so `output` is always the SAME draft `response` just judged.
     */
    output: T;
  }) => Promise<void>;
}

/**
 * The universal approve / revise / reject cycle.
 *
 * Generic across agents by construction: it knows nothing about carousels,
 * posts or templates — only that something is produced, a human judges it,
 * and a `revise` verdict re-produces it with the feedback in hand.
 *
 * ## Why the revision is in-run rather than a fresh run
 *
 * A new run would be simpler, and it is what the portal's existing retry does.
 * It also throws away the run's research, its reserved topic and its cost
 * accounting, and it starts from a blank slate that has to be re-told what the
 * feedback was. Because every step here is checkpointed by id, an in-run
 * revision gets the reuse for free: steps outside `attempt` short-circuit on
 * their existing checkpoints, and only the revision-scoped drafting steps
 * actually re-execute.
 *
 * ## What it does NOT do
 *
 * It does not judge the output, and it does not decide what "revise" means for
 * a given product — the agent's own `attempt` callback does both. Layer 1
 * makes no content judgments (RFC-01 §4), and that holds here.
 */
export async function runReviewCycle<T>(wf: WorkflowContext, options: ReviewCycleOptions<T>): Promise<ReviewCycleResult<T>> {
  const notes: RevisionNote[] = [];

  for (let revision = 0; revision <= options.maxRevisions; revision++) {
    const output = await options.attempt(revision, notes);

    const response: GateResponse = options.autoApprove
      ? await wf.step.code(`${options.gateId}-r${revision}`, () => ({
          decision: "approve" as const,
          actor: "system",
          at: new Date().toISOString(),
        }))
      : await wf.step.gate(`${options.gateId}-r${revision}`, options.buildGate(output, revision));

    const templateFeedback = response.templateFeedback ?? [];
    if (options.onDecision) {
      await options.onDecision({ revision, response, templateFeedback, output });
    }

    if (response.decision === "approve") {
      return { output, revision, notes, response };
    }

    if (response.decision === "revise") {
      // `feedback` is schema-mandatory on `revise`, so the `?? ""` is only a
      // type narrowing — an empty note would be a schema violation upstream.
      notes.push({ revision, actor: response.actor, at: response.at, feedback: response.feedback ?? "" });
      if (revision === options.maxRevisions) {
        throw new WorkflowHeld(
          `review requested another revision after ${options.maxRevisions} round(s), which is this gate's ceiling — ` +
            `holding rather than re-drafting indefinitely. Requests so far: ${notes.map((n) => `r${n.revision}: ${n.feedback}`).join(" | ")}`,
        );
      }
      continue;
    }

    // `reject`: a human said no. Never converted into a delivery.
    throw new WorkflowHeld(`review rejected: ${response.reason ?? "no reason given"}`);
  }

  // Unreachable: the loop either returns, continues, or throws.
  throw new WorkflowHeld("review cycle ended without a decision");
}

/**
 * Rounds of revision a reviewer may request before the run holds instead.
 *
 * Two, plus the original draft. It has to be bounded: every round re-runs the
 * paid drafting steps, and a reviewer who keeps clicking "revise" would
 * otherwise keep spending with nothing in the system noticing. Shared across
 * agents so the ceiling is one number rather than five that can drift.
 */
export const MAX_REVISION_ROUNDS = 2;

/**
 * Writes one review decision to durable client memory.
 *
 * Takes the tool registry as a parameter rather than importing anything: this
 * package is Layer 1 and owns no tools, exactly as `runTopicGuardrail` takes
 * its own `deps.tools`. Agents that also route TEMPLATE feedback somewhere
 * (instagram) wrap this and add their own handling on top.
 *
 * Written for EVERY decision including approvals, deliberately: an approving
 * reviewer who says "the shorter hooks are working" is teaching the system
 * something, and a store that only remembers complaints learns a distorted
 * version of what a client wants.
 *
 * Idempotent by construction — `feedbackId` is `${runId}-r${revision}`, so a
 * replayed run appends one row rather than one per replay.
 *
 * Failures are swallowed and logged, narrowly: losing a note is bad, but
 * failing an already-APPROVED run because a memory write timed out would
 * discard a finished deliverable the client is waiting for. The gate record
 * still holds the decision verbatim, so nothing is unrecoverable.
 *
 * ## `content` (SCRUM-306 / AU23)
 *
 * Optional and caller-supplied, deliberately: this function stays generic
 * across agents (Layer 1 makes no content judgments, RFC-01 §4), so it does
 * not know how to turn a `DraftResult` or a `ClipDraft` into text — the
 * caller does that, typically `JSON.stringify(output)` on the `output` its
 * own `onDecision` now receives from `runReviewCycle`. Passed straight
 * through to `memory.appendFeedback`'s `content` field: stored and read back
 * byte-identical, no trimming, no truncation. The caller also decides WHEN
 * to attach it — most call sites only do so on `reject`, since that is the
 * one decision whose content previously had nowhere durable to go (an
 * approval's content already lands in `ledger.writeDeliverable`; a `revise`
 * round's content is superseded by the next attempt, which sees the
 * reviewer's `feedback` text via `notes`/`revisionDirective`).
 *
 * ## `style`/`scope`/`slide` (IGSTYLE-4)
 *
 * Optional and additive, exactly like `content` above — every existing call
 * site across every agent stays valid, unchanged, with `scope` defaulting to
 * `"post"` at `memory.appendFeedback` itself. Structurally typed rather than
 * imported from either `@agent-engine/tool-karos-memory` or an agent's own
 * `style-directive.ts` (this package is Layer 1 and owns no tools — see this
 * file's own header comment on why `persistReviewFeedbackToMemory` takes the
 * tool registry as a parameter instead of importing anything). This ticket
 * only extends the plumbing; wiring a REAL style pick through this parameter
 * (rather than leaving it always `undefined`) is IGSTYLE-5's job, once
 * `02h-learned-style-preferences` has a real prior to persist evidence for.
 */
export interface PersistedStylePreference {
  overrides: Readonly<Record<string, string>>;
  source: "structured" | "parsed" | "model";
  intents?: readonly { role: "ground" | "fg" | "accent"; direction: "darker" | "lighter" | "more-contrast" | "hue"; hue?: string }[];
  applied?: readonly string[];
}

export async function persistReviewFeedbackToMemory(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  revision: number,
  response: GateResponse,
  content?: string,
  extra?: {
    style?: PersistedStylePreference;
    scope?: "post" | "slide" | "template" | "style";
    slide?: number;
  },
): Promise<void> {
  const note = response.feedback ?? response.reason;
  const append = tools["memory.appendFeedback"];
  if (note === undefined || append === undefined) return;
  try {
    await wf.step.code(`review-feedback-r${revision}`, async () =>
      append.execute(
        {
          feedbackId: `${wf.runId}-r${revision}`,
          productId: wf.productId,
          decision: response.decision,
          actor: response.actor,
          note,
          revision,
          runId: wf.runId,
          ...(content !== undefined ? { content } : {}),
          ...(extra?.style !== undefined ? { style: extra.style } : {}),
          ...(extra?.scope !== undefined ? { scope: extra.scope } : {}),
          ...(extra?.slide !== undefined ? { slide: extra.slide } : {}),
        },
        { ctx },
      ),
    );
  } catch (error) {
    console.error(`persistReviewFeedbackToMemory: could not record review feedback for run ${wf.runId}`, error);
  }
}

/**
 * Reads what this client asked for on previous runs, for injection into a
 * drafting prompt.
 *
 * Bounded and best-effort for the same two reasons everywhere it is used: an
 * unbounded history would push the actual brief out of the context window,
 * and a memory read failing must not stop a run that can draft without it.
 *
 * SCRUM-306 (AU23): when an entry carries `content` (typically a past
 * `reject`'s drafted content — see `persistReviewFeedbackToMemory`), it is
 * appended after the note verbatim, so a drafting prompt built from this list
 * can show a reviser both WHY something was rejected and WHAT was rejected,
 * instead of asking it to learn from half a sentence.
 */
export async function readPastFeedback(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  stepId = "read-past-feedback",
): Promise<string[]> {
  return wf.step.code(stepId, async () => {
    const read = tools["memory.readFeedback"];
    if (!read) return [] as string[];
    try {
      const outcome = await read.execute({ productId: wf.productId, limit: 10 }, { ctx });
      if (outcome.status !== "success") return [] as string[];
      return (outcome.result as { entries: Array<{ decision: string; note: string; content?: string }> }).entries.map(
        (e) => (e.content !== undefined ? `(${e.decision}) ${e.note}\nContent: ${e.content}` : `(${e.decision}) ${e.note}`),
      );
    } catch (error) {
      console.error(`${stepId}: could not read client feedback history, drafting without it`, error);
      return [] as string[];
    }
  });
}

/**
 * Formats accumulated revision requests for injection into a drafting agent's
 * input.
 *
 * Numbered and oldest-first, because a model given an unordered blob of
 * feedback tends to act on whichever it read last. Returns undefined for an
 * empty list so a caller can spread it conditionally and a first draft's
 * prompt is byte-identical to what it was before revisions existed.
 */
export function revisionDirective(notes: readonly RevisionNote[]): string | undefined {
  if (notes.length === 0) return undefined;
  const lines = notes.map((n, i) => `${i + 1}. (round ${n.revision + 1}, ${n.actor}) ${n.feedback}`);
  return [
    "A reviewer has asked for changes to your previous draft. Address EVERY point below, not only the most recent one:",
    ...lines,
    "Keep everything they did not ask you to change.",
  ].join("\n");
}
