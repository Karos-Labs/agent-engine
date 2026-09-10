import {
  DynamicAgent,
  buildOutputSchema,
  resolveModelPolicy,
  type AgentDefinitionField,
  type AgentToolRegistry,
  type ModelRouter,
  type PromptStore,
} from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import type { InstagramCopyOutput } from "./types.js";

/**
 * Instagram Phase 0 grounding gate, stage 2: the post-copy RELEVANCE judge.
 *
 * ## What it asks
 *
 * One question, from the point of view of a reader who follows this
 * account: "given who this business is (the Client Brief), would I see how
 * this post connects to what they sell and to whom?" Scored 1-5; below
 * `MIN_RELEVANCE_SCORE` the draft goes back to step 05 with the judge's
 * reason and the one-sentence bridge it says is missing.
 *
 * ## Why a second stage at all
 *
 * Stage 1 (`buildGroundedQuery` in `client-brief.ts`) grounds the RESEARCH
 * in the client's business, so the facts the writer receives are about the
 * right world. But grounded facts do not force a grounded post: a writer
 * handed facts about marketing automation can still write six slides that
 * any agency could have posted, with the client's own offer, audience and
 * vocabulary nowhere in them. That is the failure the 2026-09-08 audit
 * found approved at the human gate (Karos Labs shipping a real-estate
 * carousel), and a human gate that has already approved one such post is
 * not the belt to rely on. This is the check that reads the finished post
 * against the brief.
 *
 * ## Shape
 *
 * Built exactly like `runLanguageFluency` and `runTopicGuardrail`: a
 * `DynamicAgent` with no tools (a judgment over text already in hand — a
 * judge that can call tools is a judge that can be steered), `maxSteps: 1`,
 * a flat `buildOutputSchema` contract, an inline system prompt (a check
 * whose wording lived in the same editable store as the drafting prompts
 * could be edited to agree with them). Class id `instagram-relevance-judge`
 * is what Studio keys its stage model on.
 *
 * ## Cost
 *
 * One Flash call per attempt (~4k tokens in, ~0.3k out ≈ $0.002) closes the
 * MassHousing class of defect at < 2% of the copy step's cost. Sonnet is not
 * needed: this is a classification over a brief and a post, not writing,
 * and the threshold is deliberately lenient (3 = "the bridge exists but
 * takes a sentence") so Flash's tendency to over-score generic marketing
 * copy costs a redraft only when the bridge is genuinely absent.
 *
 * ## The floor depends on the grounding
 *
 * `MIN_RELEVANCE_SCORE` is 3, except for a brief that has nothing but the
 * industry in it (no product-information and no target-audience document —
 * `isThinlyGrounded`), where it is 2. The rubric's own definition of 2 is "a
 * different business in the same field could have posted this", and that is
 * the CEILING of what any draft can earn from a brief that reads "What we
 * sell: AI marketing / Audience: practitioners in AI marketing": at floor 3
 * such a client fails every attempt on a verdict no redraft can answer and
 * holds. Relaxing the floor is recorded, not silent — the verdict carries a
 * `note`, the gate payload shows it, and the caller writes a ledger warn.
 * A 1 is off-brief at either floor, and 1 is what the audit's real-estate
 * carousel scored, so the defect this gate exists for is still caught.
 *
 * ## Failure posture
 *
 * The judge fails OPEN: an `error` verdict (judge did not complete, or
 * returned a malformed score) is recorded as a ledger warn by the caller and
 * the draft proceeds. Unlike the fluency gate, which fails closed because
 * unverified Hebrew baked into a PNG cannot be fixed at the human gate, an
 * off-brief post CAN be caught by the reviewer — the brief's binding rule
 * is about the score, not about the judge's uptime, and a Flash outage must
 * not hold every Instagram run.
 */

/** Step-id stem; the workflow appends `-attempt-N` and the revision suffix. */
export const RELEVANCE_STEP_ID = "07g-relevance";

/** Scores below this send the draft back to step 05. 3 = "the bridge exists but takes a sentence" — lenient on purpose (see the header). */
export const MIN_RELEVANCE_SCORE = 3;

/**
 * The floor for a client whose brief has nothing but the industry in it
 * (`isThinlyGrounded`): 2 = "a different business in the same field could
 * have posted this".
 *
 * Not a softening of the gate but a correction to it. That score is the
 * CEILING of what a writer can produce from a brief that says "What we sell:
 * AI marketing / Audience: practitioners in AI marketing", so at floor 3
 * every attempt fails, the redraft steer has nothing new to say, and the run
 * holds — for exactly the thin-onboarding client the 2026-09-08 audit was
 * about. A 1 stays off-brief at either floor, and 1 is what the audit's own
 * defect scored: a real-estate carousel for an AI marketing agency is "a
 * different industry, a different customer, a subject the brief never
 * touches". So the MassHousing class is still caught; only the unwinnable
 * verdict is not.
 */
export const THIN_GROUNDING_MIN_RELEVANCE_SCORE = 2;

/** The passing score for one run, plus (when it was lowered) the words the reviewer and the ledger see for why. */
export interface RelevanceFloor {
  minScore: number;
  /** Present only when the floor is below `MIN_RELEVANCE_SCORE`. */
  relaxedReason?: string;
}

export const DEFAULT_RELEVANCE_FLOOR: Readonly<RelevanceFloor> = { minScore: MIN_RELEVANCE_SCORE };

/**
 * The floor this run's grounding earns. Pure; the caller decides what
 * "thinly grounded" means (`isThinlyGrounded` in `client-brief.ts`) so this
 * module stays a judge and not a brief reader.
 */
export function relevanceFloor(thinlyGrounded: boolean): RelevanceFloor {
  if (!thinlyGrounded) return { ...DEFAULT_RELEVANCE_FLOOR };
  return {
    minScore: THIN_GROUNDING_MIN_RELEVANCE_SCORE,
    relaxedReason:
      `the client brief has no product-information or target-audience document, so it grounds this post in an industry rather than a business — ` +
      `a score of ${THIN_GROUNDING_MIN_RELEVANCE_SCORE}/5 is the most any draft could earn against it and was accepted; fill in those documents and the floor returns to ${MIN_RELEVANCE_SCORE}/5`,
  };
}

/** How much of the post the judge reads; a carousel is far smaller than this, the cap guards a runaway single-format caption. */
export const RELEVANCE_JUDGE_MAX_CHARS = 12_000;

export interface RelevanceGateDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

export interface RelevanceJudgeInput {
  /** `briefForPrompt(brief)` — the same rendering the copy agent read. */
  brief: string;
  topic: string;
  caption: string;
  slides: Array<{ n: number; headline: string; body: string }>;
}

export type RelevanceVerdict =
  | {
      status: "relevant";
      score: number;
      reason: string;
      /** Set when the score passed only because the floor was relaxed for a thinly-grounded brief — carried onto the gate payload and a ledger warn, never silent. */
      note?: string;
    }
  | { status: "off-brief"; score: number; reason: string; missingBridge?: string }
  | { status: "error"; reason: string };

/** Output contract — flat, so `buildOutputSchema` can express it (the same constraint every other inline judge here lives with). */
export const RELEVANCE_OUTPUT_FIELDS: readonly AgentDefinitionField[] = [
  {
    name: "score",
    type: "number",
    description: "1 to 5. 5 = unmistakably this business speaking to its audience; 4 = clearly theirs, one detail could be sharper; 3 = the connection exists but a reader needs a sentence to see it; 2 = a different business in the same field could have posted this; 1 = no honest connection to what this business sells or to whom.",
    optional: false,
  },
  {
    name: "reason",
    type: "string",
    description: "One or two sentences naming what in the post does (or does not) connect it to this business: the offer, the audience, the vocabulary, the stance. Quote the post where useful.",
    optional: false,
  },
  {
    name: "missingBridge",
    type: "string",
    description: "Required when score is below 3: the ONE sentence the post lacks that would make the connection to this business obvious to a stranger, written so the writer can act on it. Omit when the score is 3 or higher.",
    optional: true,
  },
];

interface RelevanceJudgeOutput {
  score: unknown;
  reason: unknown;
  missingBridge?: unknown;
}

/**
 * The judge's system prompt. The "judge only the connection" framing is
 * load-bearing: this gate runs alongside a fluency judge, a craft-hygiene
 * gate and a topic guardrail, each with its own remedy, and a relevance
 * judge that also volunteered opinions on tone or accuracy would fail
 * drafts for reasons the redraft steer cannot address.
 */
export function buildRelevanceSystemPrompt(): string {
  return [
    "You are a reader who follows this account. You are handed the account owner's Client Brief (who they are, what they sell, to whom, in which words) and one finished Instagram post: its caption and every slide's headline and body.",
    "",
    "Answer one question: given the brief, would you see how this post connects to what THIS business sells and to whom it sells it?",
    "",
    "Score it 1 to 5:",
    "- 5 = unmistakably this business. The offer, the audience or the stance is on the page; nobody else could have posted it.",
    "- 4 = clearly theirs; one slide or the caption could name the audience or the offer more sharply.",
    "- 3 = the bridge exists but takes a sentence: a reader who knows the business can connect it, a stranger might not.",
    "- 2 = a different business in the same field could have posted this word for word.",
    "- 1 = no honest connection to what this business sells or to whom (a different industry, a different customer, a subject the brief never touches).",
    "",
    "When the score is below 3, state the missing bridge: the ONE sentence the post lacks that would make the connection obvious to a stranger. Write it so the writer can act on it, not as a complaint.",
    "",
    "Judge ONLY the connection to the business. Not fluency, not grammar, not whether the facts are true, not whether you like the post. Those have their own checks.",
    "A post about a live story or a general trend is fine when the caption or a slide makes the bridge to this business explicit; the subject does not have to be the business itself.",
    "The post may be written in a language other than the brief's (Hebrew, Arabic, Japanese); judge the connection in whatever language it is written.",
    "Never invent a connection the post does not make, and never mark a post down for omitting something the brief itself says is a gap.",
  ].join("\n");
}

/** The slides as the judge reads them — headline and body only, never `visualNeed` or `sourceRef` (those are for other steps). */
export function relevanceSlidesFor(copy: InstagramCopyOutput): RelevanceJudgeInput["slides"] {
  return copy.slides.map((s) => ({ n: s.n, headline: s.headline, body: s.body }));
}

/**
 * One Flash call: does this post read as this client's? Never throws; a
 * judge that could not complete, or answered with a score that is not a
 * number in 1-5, returns `status: "error"` and the caller fails open with a
 * ledger warn.
 */
export async function runRelevanceJudge(
  wf: WorkflowContext,
  deps: RelevanceGateDeps,
  stepId: string,
  input: RelevanceJudgeInput,
  floor: RelevanceFloor = DEFAULT_RELEVANCE_FLOOR,
): Promise<RelevanceVerdict> {
  const judge = new DynamicAgent(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: "instagram-relevance-judge",
      description: "Judge whether a drafted Instagram post reads as THIS client's business speaking to THIS client's audience, given the Client Brief.",
      // No tools: a judgment over text already in hand.
      allowedTools: [],
      outputSchema: buildOutputSchema([...RELEVANCE_OUTPUT_FIELDS]),
      // Pinned Flash on the Gemini vendor, same as the vetting and visual-QA
      // judges in this agent — the commodity tier the brief mandates for new
      // judges. `resolveModelPolicy` keeps the per-step env override path.
      modelPolicy: resolveModelPolicy("instagram-relevance-judge", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
      maxSteps: 1,
    },
    buildRelevanceSystemPrompt(),
  );

  const post = {
    topic: input.topic,
    caption: input.caption.slice(0, RELEVANCE_JUDGE_MAX_CHARS),
    slides: input.slides,
  };
  const exec = await wf.step.agent(stepId, judge, { clientBrief: input.brief, post });
  if (exec.status !== "completed" || !exec.finalOutput) {
    return { status: "error", reason: `relevance judge did not complete (${exec.status})` };
  }

  const output = exec.finalOutput as unknown as RelevanceJudgeOutput;
  const rawScore = typeof output.score === "number" ? output.score : Number.NaN;
  if (!Number.isFinite(rawScore)) {
    return { status: "error", reason: "relevance judge returned a score that is not a number" };
  }
  // Round, then refuse anything outside the rubric rather than clamping: a
  // "7" or a "0" is a judge that did not follow the rubric, and a verdict
  // built on it would be a guess dressed as a score.
  const score = Math.round(rawScore);
  if (score < 1 || score > 5) {
    return { status: "error", reason: `relevance judge returned a score outside 1-5 (${rawScore})` };
  }
  const reason = typeof output.reason === "string" && output.reason.trim().length > 0 ? output.reason.trim() : "no reason given";
  // The floor, not the constant: a thinly-grounded brief passes at 2 (see
  // `THIN_GROUNDING_MIN_RELEVANCE_SCORE`), and when that is why a draft
  // passed, the verdict SAYS so — a relaxed floor that leaves no trace is a
  // gate the reviewer thinks is stricter than it is.
  const minScore = Number.isFinite(floor.minScore) ? floor.minScore : MIN_RELEVANCE_SCORE;
  if (score >= minScore) {
    const relaxed = score < MIN_RELEVANCE_SCORE && floor.relaxedReason !== undefined;
    return { status: "relevant", score, reason, ...(relaxed ? { note: floor.relaxedReason! } : {}) };
  }
  const missingBridge = typeof output.missingBridge === "string" && output.missingBridge.trim().length > 0 ? output.missingBridge.trim() : undefined;
  return { status: "off-brief", score, reason, ...(missingBridge !== undefined ? { missingBridge } : {}) };
}

/** The `lastSelfCheckReason` wording for an off-brief verdict — one place, so the hold message and the trace agree. */
export function relevanceFailureReason(verdict: Extract<RelevanceVerdict, { status: "off-brief" }>): string {
  return `post does not read as this client's (relevance ${verdict.score}/5): ${verdict.reason}`;
}

/** What the next attempt's `relevanceSteer` carries: the bridge the judge asked for, else its reason. */
export function relevanceSteerFor(verdict: Extract<RelevanceVerdict, { status: "off-brief" }>): string {
  return verdict.missingBridge ?? verdict.reason;
}

/**
 * The ledger warn for a draft that passed only because the floor was relaxed
 * for a thinly-grounded brief. Keyed per attempt like the unavailable warn,
 * so a resumed attempt writes the same row rather than a second one.
 *
 * A warn and not an info: the post ships, but the reviewer is being told
 * that the check which would normally have sent it back could not hold this
 * client's grounding to that standard, and that filling in two onboarding
 * documents restores it.
 */
export function relevanceThinGroundingEvent(runId: string, attempt: number, verdict: Extract<RelevanceVerdict, { status: "relevant" }>): { eventId: string; level: "warn"; message: string } {
  return {
    eventId: `${runId}__relevance-thin-grounding-a${attempt}`,
    level: "warn",
    message: `attempt ${attempt}: the relevance judge scored this post ${verdict.score}/5 and it was accepted — ${verdict.note ?? "the brief is grounded in an industry rather than a business"} (${verdict.reason})`,
  };
}

/** The fail-open ledger warn for a judge that could not run, keyed so a resumed attempt writes the same row. */
export function relevanceUnavailableEvent(runId: string, attempt: number, verdict: Extract<RelevanceVerdict, { status: "error" }>): { eventId: string; level: "warn"; message: string } {
  return {
    eventId: `${runId}__relevance-judge-unavailable-a${attempt}`,
    level: "warn",
    message: `attempt ${attempt}: the relevance judge could not run (${verdict.reason}); the draft proceeded unjudged for relevance — the reviewer should check the post reads as this client's`,
  };
}
