import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { InstagramCopyOutputSchema, type InstagramCopyOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 05: "write the copy — six to eight slides, one idea each"
 * (enforced directly by `InstagramCopyOutputSchema`'s `.min(6).max(8)`, so
 * an out-of-range draft is a schema-validation `content_fail` at the agent
 * level, not something a later step has to notice). Pinned tier — RFC-03 §1
 * required-reading item 5 calls this "the creative judgment call," matching
 * `LinkedInDraftAgent`'s own pinned pattern exactly.
 *
 * Every claim traces to a step-04 source: `sourceRef` on each slide names a
 * `facts[].claim` from `InstagramResearchAgent`'s output verbatim, which is
 * what step 07's self-check verifies before the post ever reaches the
 * renderer.
 *
 * `allowedTools: []` — everything this step needs (topic, facts, the frozen
 * style config's copy-relevant fields, brand tokens) is hand-assembled by
 * the workflow ahead of time, same reasoning as `InstagramResearchAgent`.
 * On a step-07 self-check failure the workflow re-invokes this same agent
 * with a fresh step id (`WF-05-write-copy-attempt-N`) rather than looping
 * inside the agent itself — RFC-03 §3 step 07's "RETURN: 05" is a Layer 1
 * concern (which checkpointed step to re-run), not a Layer 2 one.
 */
export class InstagramCopyAgent extends BaseAgent<InstagramCopyOutput> {
  protected readonly config: AgentStepConfig<InstagramCopyOutput> = {
    id: "instagram-copy",
    description: "Write 6-8 Instagram carousel slides, one idea each, every claim traced to a sourced research fact.",
    allowedTools: [],
    outputSchema: InstagramCopyOutputSchema,
    // Pinned — RFC-02 §5's rationale applies identically here: drafting/
    // brand-voice judgment is never a fallback-eligible step.
    modelPolicy: resolveModelPolicy("instagram-copy", { policy: "pinned", model: "claude-sonnet-4-6" }),
    // Pinned to "2": v1 stays frozen as the pre-photographability baseline,
    // the same convention every other agent here follows. v2 adds the
    // single-photographable-scene rules to §4 — prep run
    // pubsub-21535110633863323 held on a slide needing "a timeline or roadmap
    // with a clearly labeled 'research' first phase, shot from above", which
    // v1 actively encouraged by asking for precision with no sense of what
    // can be pictured.
    // Pinned to "3": v3 is v2 with every em dash removed. v1 and v2 both
    // banned em dashes in the copy while using nine and eleven of them
    // respectively, and the model imitates the register of its instructions:
    // prep run pubsub-21066191524607951 failed the mechanical craft-hygiene
    // gate on two of three attempts on exactly that character. v1 and v2 stay
    // frozen.
    // Pinned to "4": v4 is v3 plus §5, the layout-archetype menu. Until it,
    // `layout` existed in the schema but nothing ever asked the model to
    // choose one, so every slide defaulted to `photo` and the five ported
    // archetypes were reachable only as a fallback — a carousel could not
    // deliberately set a number large or a quote as a quote. v4 also states
    // the two rules that keep the choice honest: fill the block you named,
    // and never invent a statistic or a quote to justify an archetype. v3
    // stays frozen as the pre-archetype baseline.
    // Pinned to "5": v5 is v4 plus the two rules that stop retrieval failing
    // for reasons the copy step controls. §4 gains a hard constraint budget
    // (one subject, one setting, at most one more constraint, ~12 words),
    // because a long scene description does not return nothing from a keyword
    // index, it returns near-arbitrary matches the gate then pays to reject.
    // §5 gains an explicit routing table: a number, a chart, a comparison or a
    // list is NOT a photo, and writing it as a photo brief is what sent prep
    // run pubsub-21545408480430711's four data slides through retrieval,
    // scrape and into generation. v4 stays frozen.
    // Pinned to "6": v6 adds a required `caption` (the post's own text below
    // the carousel, distinct from any slide's baked-in headline/body) — until
    // it, the schema had no such field at all, so a reviewer approving a post
    // saw either nothing or a raw join of every slide's field values including
    // `accentColor`'s hex code (prep run 2VFCw79Wu8xfJOKXC7zP). v6 also
    // upgrades the archetype-variety guidance from a soft "aim for a mix" to
    // an explicit one-per-carousel rule for the five structured archetypes,
    // matched by a mechanical downgrade in `resolveLayout` — the same run
    // shipped two `stat_callout`s and two `comparison_card`s in one post. v5
    // stays frozen.
    // Pinned to "7": v7 adds §1, a check for the client's own stated
    // language before anything else is written. Nothing before it ever read
    // the client's profile/voice-rules for a language requirement at all —
    // the workflow itself never even called those tools — so an outlet that
    // states its own language in plain prose (Geektime: "Israel's largest
    // Hebrew-language technology... site") got a fluent, well-sourced,
    // entirely English carousel with every other check passing (prep job
    // hcf9ymPGJC7mDS5pcEQ4). v6 stays frozen.
    // Pinned to "8": v8 adds `layout: "custom"` — the rare escape hatch to
    // author a brand-new typographic archetype (`customArchetype`'s
    // `bodyHtml`/`css`/`slots`/`fields`) when none of the six standard ones
    // fit. Machine-validated (`assertSafeMarkup` in
    // `@agent-engine/tool-karos-templates`) before it is ever rendered, and
    // only enrolled into the shared template registry on an explicit
    // reviewer approval (`promoteTemplate`) — never from this step alone.
    // v7 stays frozen.
    // Pinned to "9": v9 adds the client-knowledge-and-recent-posts section
    // — clientIntelContext (the client's own intel report, distilled) is read
    // as authoritative before external facts, and recentPosts (the shipped-
    // output dedup window this agent now writes back into on delivery) is a
    // hard do-not-repeat constraint. v8 stays frozen.
    skillRef: "instagram-copy@9",
  };
}
