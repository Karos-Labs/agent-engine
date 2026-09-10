import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { InstagramBriefAgentOutputSchema, type InstagramBriefAgentOutput } from "../workflow/client-brief.js";

/**
 * Instagram Phase 1 item H, step `00b2-write-client-brief`: the setup-style
 * agent that writes the client's persisted Client Brief.
 *
 * ## What it is for
 *
 * The 2026-09-08 prep audit: an AI marketing agency shipped a real-estate
 * carousel that cleared every gate, because no step in the pipeline had ever
 * been told what the client sells or to whom. Phase 0 closed that with a
 * DETERMINISTIC brief — first sentence of the profile, first paragraph of the
 * product-information document, top term frequencies — which grounds a query
 * well enough to stop the worst failure but cannot state a positioning, name
 * an ICP's actual pains, or tell a peer account from a competitor. This agent
 * is the writer that can: it reads the same onboarding data PLUS the client's
 * own site (`research.fetchPages`) and their own recent posts
 * (`research.socialHistory`), and answers in one turn with the document every
 * later step reads for the next month — scout, topic engines, research query,
 * angle, copy §15, relevance judge, gate payload.
 *
 * ## Model: Sonnet, and the cost that justifies it
 *
 * `claude-sonnet-4-6`, pinned, `contentLanguageSensitive` — the same choice
 * `InstagramCopyAgent` documents, for a related reason. Two properties make
 * the commodity tier wrong here:
 *
 * - This is the ONE document a month of runs is grounded on. A weak
 *   positioning line is not one bad post; it is every post until the next
 *   refresh, and every downstream judge agreeing with it because the brief is
 *   the authority they are given.
 * - It is written in the CLIENT's language and about their register (Hebrew is
 *   a first-class target, client `geektime`), and `language.register` is a
 *   judgment about how they actually write, read off their own posts.
 *   `contentLanguageSensitive` re-points the step at a model AU33's capability
 *   table rates as able to read and write that language, per client, at run
 *   time.
 *
 * The bill: ~25k in / 2.5k out ≈ **$0.113 per refresh**, at most once per 30
 * days per client, plus ≤ 3 page fetches ($0.021) and ≤ 4 `socialHistory`
 * reads ($0.028, shared with the topic engines' 24h cache) ≈ **$0.16**. At a
 * weekly cadence that is **≈ $0.04 per run amortised**, inside the $1.00
 * target with the rest of the pipeline untouched; a client's first run pays
 * the whole $0.16 once. Flash was rejected on the same grounds the angle step
 * rejects it: proposals that read as restatements of the input.
 *
 * ## Shape
 *
 * `allowedTools: []`, `maxSteps: 1` — every source is hand-assembled into the
 * input by `00b1-gather-brief-sources` (`buildBriefAgentInput`), so the turn
 * goes straight to a `final` output instead of running its own tool loop. Same
 * reasoning as every other agent in this package, and it is what keeps this
 * step's cost a fixed, predictable one-call bill rather than an open-ended
 * research loop.
 *
 * `outputSchema` is `ClientBriefSchema` minus the five fields the engine
 * stamps (`version`, `channel`, `generatedAt`, `generatedBy`,
 * `agentSkillRef` — see `InstagramBriefAgentOutputSchema`). A malformed answer
 * is a `content_fail` at the agent level, which `00b3` records as a warn while
 * `02i` falls through to the deterministic brief: setup never blocks a run
 * (the roster-setup precedent), and the next run retries.
 */
export class InstagramBriefAgent extends BaseAgent<InstagramBriefAgentOutput> {
  protected readonly config: AgentStepConfig<InstagramBriefAgentOutput> = {
    id: "instagram-brief",
    description:
      "Write the client's persisted Client Brief for Instagram — positioning, ICP, current offers, core terms, reference accounts, forbidden topics and claims, language and register — from the client's own onboarding data, site and recent posts, citing which sources each part came from.",
    allowedTools: [],
    outputSchema: InstagramBriefAgentOutputSchema,
    maxSteps: 1,
    // The brief is a wide object (positioning, ICP, up to 5 offers, 20 core
    // terms, 7 reference accounts with reasons, 12 own assets, gaps). A turn
    // that runs out of room does not come back short — it comes back
    // unparseable — and this step runs once a month, so the headroom is
    // effectively free.
    maxTokens: 8_000,
    modelPolicy: resolveModelPolicy("instagram-brief", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "instagram-brief@1",
  };
}
