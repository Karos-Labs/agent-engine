import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ImageVettingOutputSchema, type ImageVettingOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 06: "source and vet one picture per slide" — real judgment,
 * not a rubber stamp. This agent is handed a small caller-provided pool of
 * repo-relative candidate image paths, each with a written description, and
 * must judge, per slide, whether any pool candidate actually satisfies that
 * slide's `visualNeed` — does it show what the slide claims, is it the right
 * era, watermark-free, etc.
 *
 * 2026-09: the description is no longer only a provider's alt text. When a
 * vision backend is configured, the workflow's 05c step has a model LOOK at
 * every candidate first and appends what it saw (`[vision: …]`: subjects,
 * legible text, screenshot/AI tells), and drops the ones it graded unusable
 * or watermarked before they ever reach this gate. This agent's judgment is
 * therefore about what is actually in frame, which is what the prompt always
 * asked for and could never have.
 *
 * **The preserved legacy-defect fix (RFC-03 §1/§3, "this exact behavior"):**
 * when no candidate in the pool honestly satisfies a slide, this agent must
 * report that slide's `imagePath` as `null` rather than picking the
 * least-bad option or leaving the slide out of its `selections` array
 * entirely. The workflow checks for exactly this and downgrades the slide to
 * a typographic layout — never a placeholder image, never a silently-dropped
 * slide. This agent's own job is only the honest per-slide verdict; the
 * run-level decision is Layer 1's (RFC-01 §4).
 *
 * **Rights/licence/watermark verification (P0 parity-audit Fix 4) and
 * cross-post reuse (Fix 3):** restored via `ImageSelectionSchema`'s
 * `license`/`rightsUsable`/`watermarkFree` fields, which this agent's output
 * schema requires per selection; the workflow deterministically double-checks
 * both, never trusting the model's verdict alone for a "never ship this"
 * guarantee.
 *
 * ## Model (2026-09)
 *
 * Gemini 2.5 Flash on Vertex, `pinned`. This is a QA/classification step over
 * text the workflow assembled — a per-slide verdict with a reason — not
 * client-facing copy. Flash's structured output is reliable for this shape
 * and it costs a fraction of Sonnet on a step that runs up to three times per
 * attempt across the rescue tiers. Retargetable per deployment
 * (`MODEL_STEP_INSTAGRAM_IMAGE_VET_VENDOR/_MODEL`) and per run in Studio.
 */
export class InstagramImageVettingAgent extends BaseAgent<ImageVettingOutput> {
  protected readonly config: AgentStepConfig<ImageVettingOutput> = {
    id: "instagram-image-vet",
    description:
      "Judge, per slide, whether any candidate in the supplied image pool actually shows the slide's briefed SUBJECT (subjectMatch 1-5) and what its headline and body CLAIM (claimMatch 1-5) AND is rights-usable, watermark-free, and not already used in a prior post — report null, never a placeholder, when none does.",
    allowedTools: [],
    outputSchema: ImageVettingOutputSchema,
    // ## Model tier, Phase 5.5 (2026-09-16): Flash -> Pro
    //
    // `gemini-2.5-pro`, still `pinned`, still on Vertex, still `costTier:
    // "standard"` (so `no-premium-models.test.ts` is unaffected). ~$0.006 ->
    // ~$0.015 a call; at up to three calls per attempt across the rescue tiers
    // that is about +$0.027 on a three-attempt run.
    //
    // The tier rises because the question got harder, not because the budget
    // got looser. @5 asked one question about a written description; @6 asks
    // two, has to hold a declared subject apart from a declared decoration,
    // and has to reason about a licence class. The step that has to be right
    // for the owner's loudest complaint to be fixed is this one — and on
    // 2026-09-16 Flash got it wrong in the most expensive possible way, with a
    // fluent, confident `reason` explaining that four correct photographs of
    // server racks were unusable because none of them had been taken with a
    // long exposure. Retargetable per deployment
    // (`MODEL_STEP_INSTAGRAM_IMAGE_VET_VENDOR/_MODEL`) and per run in Studio.
    modelPolicy: resolveModelPolicy("instagram-image-vet", { policy: "pinned", model: "gemini-3.1-pro-preview", vendor: "gemini" }),
    /**
     * ── THE 98% THAT WAS NOT THE ANSWER. ──
     *
     * Measured on `pubsub-21905062348134898` (thepitchbydeel, 2026-09-20),
     * where this step billed 9,757, 24,895 and 42,873 output tokens across
     * three attempts. The third call's ANSWER was four selections and 3,232
     * characters of JSON: about 800 tokens. The rest was reasoning, which
     * Gemini bills at the output rate and which `gemini-adapter` folds into
     * `outputTokens` precisely so it shows up here.
     *
     * Image vetting across the whole run came to roughly $1.30 of a $2.17
     * run against a $1.00 target, and the owner asked why.
     *
     * The intuitive answer was the candidate pool, and it is wrong: the input
     * was already cached, at 2,201 and 2,370 UNCACHED tokens on attempts 2
     * and 3. Re-sending every scored candidate costs almost nothing. The
     * money was the model thinking, unbounded, about a four-line answer.
     *
     * 6,000 is chosen against that measurement rather than from taste: it is
     * comfortably more than the ~800 tokens the answer needs and more than
     * the ~2,400 of reasoning the FIRST attempt got by with, and it refuses
     * the 42,000-token third. A vet that genuinely needs more room now
     * truncates visibly (`OutputLimitExceededError`, which `BaseAgent` can
     * re-ask past) instead of quietly costing half a dollar.
     *
     * It does NOT change the model. Downgrading the judge that decides which
     * pictures ship, in the same week its judgement was the defect, would
     * trade a cost problem for the quality problem we just fixed.
     */
    thinkingBudget: 6_000,
    // Pinned to "2": v1 judged every clause of `visualNeed` as an equal hard
    // gate, so a candidate genuinely on-subject was rejected outright over a
    // single decorative mismatch (shot outdoors instead of the requested
    // "warm indoor light"; smiling instead of "concerned") — retrieval had
    // already found reasonable candidates, and v1's literalism threw them
    // away (prep run pubsub-21548537245422013, job 2VFCw79Wu8xfJOKXC7zP:
    // both of that carousel's photo slides rejected every candidate and fell
    // through to generation). v2 adds a CENTRAL-vs-DECORATIVE judgment call:
    // reject on a subject mismatch or a real contradiction of the slide's
    // claim, not on an atmosphere/expression/framing detail that doesn't
    // change what the slide is actually saying. v1 stays frozen.
    //
    // v3 (RFC-13 §F, 2026-09): v2 judged OBJECTS — "person + laptop + dark
    // setting" — against `visualNeed`, and never the slide's claim. The
    // audit's worst defect followed directly: a client's photos of one
    // football club's fans shipped under headlines about two other clubs,
    // because every object the need listed was in frame. v3 receives each
    // slide's `headline` + `body` and must return `claimMatch` (1-5) with a
    // reason per selection; a selection needs 3+, and the workflow re-checks
    // that floor deterministically (`MIN_CLAIM_MATCH`). v3 also lets a
    // `[client upload, slot N]` candidate serve whichever photo slide it
    // honestly fits, instead of being forced onto slot N. Costs ~1k more
    // input tokens per call (≈ $0.0003 on Flash) and no new call. v2 frozen.
    // v4 (Phase 3, item R, 2026-09): the slide arrives as a SCENE BRIEF —
    // `scene` (what is in frame) plus, when the writer authored one, `why`
    // (why the slide is weaker without it) — in place of the old twelve-word
    // `visualNeed`. The rubric is restated around it: judge whether the
    // candidate is EVIDENCE FOR THE CLAIM, not whether it contains the listed
    // objects. The `claimMatch` floor is unchanged and the workflow still
    // re-checks it deterministically. ≈ +250 input tokens per call
    // (≈ $0.0002 on Flash) and no new call. v3 frozen.
    //
    // v5 (RFC-16 §6.1, Phase 4, 2026-09): one slide per carousel, on the
    // minority of runs where the concept mode fires, arrives with a
    // `conceptual` block (`pattern`/`anchor`/`decodesTo`/`restsOn`) and is
    // scored by a new §1c. Metaphor tolerance is DECLARED by the pipeline for
    // that one slide and never inferred by the vet, so every other slide on
    // every other run reads the byte-identical v4 rubric — including the
    // unnamed-subject belt, which §1c suspends for a declared metaphor only
    // and only because `decodesTo` checked against the vision note tests the
    // same thing directly. §1c is STRICTER, not looser: a picture that could
    // illustrate any story is a 2 where the literal rubric would honestly
    // call it a 3, and an assertion in a generated candidate's own
    // description is not evidence — the `[vision: …]` note is. No threshold
    // moves: `MIN_CLAIM_MATCH` is still 3 and the workflow still re-checks it
    // deterministically. §1c is plain markdown in a STATIC system prompt
    // (13,705 → 18,802 chars), and "read this section only when `conceptual`
    // is present" is an instruction to the MODEL, not a conditional include —
    // so the cost is ≈ +1,275 input tokens on EVERY vet call, concept run or
    // not, ≈ +$0.00038 each on Flash, ≈ +$0.0045 a run over nine metered calls.
    // NOT "+600 tokens on a concept run only", which is what this comment said
    // first and which would have sent the next reader past the re-price. No new
    // call. `STEP_COST_ESTIMATES_USD.vetCall` is knowingly left at 0.006 for now
    // and its doc comment carries the measurement and the reason — moving it
    // fires the attempt lever on cold Hebrew runs and produces a budget-caused
    // HOLD, which the owner's rule forbids. v4 frozen.
    //
    // v6 (Phase 5.5, item A3, 2026-09-16): the slide arrives with a SUBJECT —
    // `subject` (the noun phrase a photo library indexes), `mustShow` (at most
    // three central clauses) and, when the run recognised one, `entityRef` —
    // and `scene` is re-declared as DECORATIVE. The rubric gains §1a
    // (`subjectMatch` 1-5, its own reason) and the selection floor moves off
    // the bare `claimMatch >= 3` onto `selectionPasses` in `types.ts`.
    //
    // The defect: prep run pubsub-21868183257380937 (karoslabs, 2026-09-16)
    // briefed its cover as "A server infrastructure corridor photographed with
    // long exposure, near-black tones, warm shadows…" with a `why` that said
    // the long exposure "signals precision and permanence". Retrieval returned
    // six candidates, four of them real photographs of real server racks. @5
    // returned `imagePath: null`, `claimMatch 1`, and wrote its own epitaph:
    // "The other candidates are server infrastructure, but none feature the
    // 'long exposure' effect that the `why` section states is necessary." The
    // rubric could not distinguish the subject from the grade, so the grade
    // was read as central and a correct pool was thrown away. The post shipped
    // with no photographs at all, and that is the complaint this phase exists
    // for.
    //
    // §1a also carries a warn-only `stockCliche` field that gates NOTHING this
    // phase (`ImageSelectionSchema`'s own comment says why), and a licence
    // class including `editorial-only`, which is CARRIED rather than refused
    // so a commentary post may use a press photograph of the public figure it
    // is about. ≈ +400 input tokens and ≈ +60 output tokens per call. v5
    // frozen.
    // Bumped for the release-history move only: the body is byte-identical to
    // the previous version, with the stacked "what changed at vNN" block
    // relocated to CHANGELOG.md beside the prompt. No rule changed.
    skillRef: "instagram-image-vet@9",
  };
}
