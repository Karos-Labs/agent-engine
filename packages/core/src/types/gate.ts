import { z } from "zod";

/**
 * The three verdict kinds every gate tool and every tool call resolve to,
 * everywhere in the system (RFC-01 §6): `content_fail` is real signal about
 * wrong/non-compliant content; `tooling_error` means something broke and must
 * never be mistaken for a content judgment.
 */
export const GateVerdictKindSchema = z.enum(["pass", "content_fail", "tooling_error"]);
export type GateVerdictKind = z.infer<typeof GateVerdictKindSchema>;

/**
 * A gate tool's typed return value (RFC-01 §5.6). A gate never silently
 * rewrites its input — on `content_fail` it returns the reason to the
 * producer, which revises (bounded by `maxRevisions`) — and a `tooling_error`
 * is never recorded as a content verdict.
 */
export const GateVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("pass"),
    evidence: z.array(z.string()),
    toolVersion: z.string().min(1),
  }),
  z.object({
    verdict: z.literal("content_fail"),
    evidence: z.array(z.string()),
    reason: z.string().min(1),
    toolVersion: z.string().min(1),
  }),
  z.object({
    verdict: z.literal("tooling_error"),
    reason: z.string().min(1),
    toolVersion: z.string().min(1),
  }),
]);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/** The human-gate kinds a Layer 1 workflow can await (RFC-01 §8.3). */
export const GateKindSchema = z.enum([
  "brand_confirm",
  "batch_review",
  "policy_change",
  "publish_approve",
  "connect_credential",
  // The campaign orchestrator's human review pause before a multi-channel
  // bundle ships (RFC-02 §4) — one review per campaign, not per channel.
  "campaign_review",
  // The SEO & GEO agent's Phase 1 gate (RFC-04 §2/§4): a client/account-manager
  // sign-off on the frozen prompt set + competitor roster before AI-visibility
  // capture spends any budget — the source skill's own "sign-off file in the
  // lab and an approval screen on the platform" made a first-class Gate.
  "prompt_set_review",
  // The SEO & GEO agent's Phase 7 gate (RFC-04 §2): "nothing is generated or
  // shipped past this point without sign-off" — approves which fired
  // recommendations get a drafted fix before the bounded fix-draft agent runs.
  "fix_generation_review",
  // The Reputation Agent's mandatory human gate (RFC-08 §6/§11 item 5): every
  // approved draft reply is held here before anything is considered
  // "published" — today's only legal autonomy state is `approve-all` (no
  // reply-publish credential exists yet, RFC-08 §6), so this gate is never
  // skipped, only auto-approved in tests via `autoApprove`. Approval means
  // "visible to a human to post by hand," never "agent-engine posted it" —
  // the workflow never calls a publish tool on either side of this gate.
  "reputation_approve_all",
  // Landing Builder's Phase 6 human review gate (RFC-07 §4 phase 6 / §5 /
  // AGENT-INVOCATION.md §5): "first ~5-7 clients: route every result through
  // human review before deploy regardless of status" — the gradual-autonomy
  // rollout the source product spec already scoped. Held before the built
  // site is ever considered a deliverable, on both `status: ok` and
  // `status: needs_human` outcomes, exactly like `reputation_approve_all`'s
  // "never skipped, only auto-approved in tests" posture.
  "landing_craft_review",
  // Branded Shorts' one-time per-client onboarding gate (RFC-06 §2's Style
  // Exploration / SKILL.md "per-client onboarding" step 2): three candidate
  // style directions are proposed from the client's brand, a human ("Karos
  // ops or the client" — SKILL.md's own words) locks exactly one, and that
  // locked choice becomes the client's `brand-profile.json`/
  // `graphics-language.md` for every video going forward. The only human
  // touchpoint per client (PORTAL-ONEPAGER.md "One choice, once") — never
  // re-asked once locked.
  "style_exploration_lock",
  // Branded Shorts' per-video delivery gate (RFC-06 §2 stage 7 / SKILL.md
  // `requires_approval: true` / PORTAL-ONEPAGER.md "Nothing is published
  // from here: finished files come to you and you post them"): a finished
  // short clears every deterministic gate (cut/graphics/cutaway/self-eval)
  // before it is even eligible for this gate, but it is never handed to the
  // client as a delivered asset until a human approves it — same
  // never-skipped, only-auto-approved-in-tests posture as
  // `reputation_approve_all`/`landing_craft_review`.
  "branded_shorts_delivery_review",
]);
export type GateKind = z.infer<typeof GateKindSchema>;

export const GateTimeoutSchema = z.object({
  /** e.g. "24h", "3d" — parsed by the Layer 1 adapter, not this package. */
  duration: z.string().min(1),
  onTimeout: z.enum(["hold", "auto_approve", "escalate"]),
});
export type GateTimeout = z.infer<typeof GateTimeoutSchema>;

/**
 * A reviewer's note on one slide's template, for the design-feedback loop.
 *
 * Separate from the gate's own `feedback` because it is about the LAYOUT, not
 * the copy, and it routes somewhere different: `feedback` steers the next
 * draft, this steers the template library
 * (`@agent-engine/tool-karos-templates`' `promoteTemplate`/`reviewTemplate`).
 * A reviewer who likes the words and dislikes the card needs to be able to
 * say exactly that.
 */
export const TemplateFeedbackSchema = z.object({
  /** Which slide the reviewer was looking at. */
  slide: z.number().int().positive(),
  /** The registry row that rendered it, so feedback lands on the right template. */
  templateId: z.string().min(1),
  verdict: z.enum(["approved", "revise"]),
  note: z.string().min(1),
  /**
   * Promote this template into the permanent library on approval.
   *
   * Explicit rather than implied by `verdict: "approved"`: liking one render
   * is not the same as wanting every client's future runs to use it, and only
   * a person can tell those apart.
   */
  promote: z.boolean().default(false),
});
export type TemplateFeedback = z.infer<typeof TemplateFeedbackSchema>;

/**
 * A human's verdict on a gate.
 *
 * ## Three decisions, not two
 *
 * `revise` was added (2026-08) because `reject` conflated two different
 * intentions. "This is wrong, stop" and "this is close, change X and try
 * again" both had to be spelled `reject`, which held the run and threw away
 * everything it had done — so the only way to act on feedback was to dispatch
 * a fresh run that had no idea what the feedback was.
 *
 * - `approve` ships it. `feedback` is optional and, when given, is guidance
 *   for future runs rather than a change request for this one.
 * - `revise` re-enters the drafting loop with `feedback` injected, reusing
 *   everything already checkpointed (research, the topic claim) and
 *   re-running only the drafting steps. `feedback` is MANDATORY: a revision
 *   request with nothing to act on is just a slower rejection.
 * - `reject` holds the run. `reason` is MANDATORY.
 *
 * An agent that does not implement revision treats `revise` as non-approve
 * and holds, which is the safe default — every existing agent tests
 * `decision !== "approve"`, so adding this value cannot silently change any
 * of their behaviour.
 *
 * Every field here is persisted to client memory by the reviewing workflow,
 * whatever the decision, so the NEXT run can read what a person asked for
 * last time. That is the half of the loop that makes it a loop.
 */
export const GateResponseSchema = z
  .object({
    decision: z.enum(["approve", "revise", "reject"]),
    actor: z.string().min(1),
    reason: z.string().min(1).optional(),
    /**
     * Free-text guidance. Required on `revise`, optional (and welcome) on
     * `approve` — an approving reviewer with a preference worth remembering
     * should have somewhere to put it.
     */
    feedback: z.string().min(1).optional(),
    /** Per-slide notes on the templates that rendered this output. */
    templateFeedback: z.array(TemplateFeedbackSchema).optional(),
    /** ISO 8601 timestamp. */
    at: z.string().min(1),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "reject" && !val.reason) {
      ctx.addIssue({
        code: "custom",
        message: "reason is mandatory when decision is 'reject' (RFC-01 §8.3)",
        path: ["reason"],
      });
    }
    if (val.decision === "revise" && !val.feedback) {
      ctx.addIssue({
        code: "custom",
        message: "feedback is mandatory when decision is 'revise' — a revision request with nothing to act on is just a slower rejection",
        path: ["feedback"],
      });
    }
  });
export type GateResponse = z.infer<typeof GateResponseSchema>;

/** One shape for the whole system's human-in-the-loop signal (RFC-01 §8.3). */
export const GateSchema = z.object({
  kind: GateKindSchema,
  runId: z.string().min(1),
  slotId: z.string().min(1).optional(),
  /** Typed per `kind`; the portal renders without special-casing. */
  payload: z.unknown(),
  requiredRole: z.string().min(1),
  timeout: GateTimeoutSchema,
  response: GateResponseSchema.optional(),
});
export type Gate = z.infer<typeof GateSchema>;
