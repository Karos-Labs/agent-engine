import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

/**
 * The six content lanes (`references/lanes.md` in x-agent-v2): what this
 * account talks about and how, restored here as a real enum after the
 * migration shipped a two-value `hasNumericInsight ? "data-point" :
 * "trend-observation"` stub with no lane concept at all. `pov` stands in for
 * lanes.md's "POV / hot takes" and `engagement` for its "engagement (reply /
 * quote)" — both renamed to single tokens to fit a zod enum.
 */
export const LANE_VALUES = [
  "build-in-public",
  "knowledge",
  "pov",
  "news-reaction",
  "quote-comment",
  "engagement",
] as const;
export const LaneSchema = z.enum(LANE_VALUES);
export type Lane = z.infer<typeof LaneSchema>;

/**
 * A single X post (RFC-02 §3). `text` and `mainPostText` are required to
 * carry identical content (enforced by prompt instruction, not a schema
 * `.transform`/`.refine` — `BaseAgent`'s self-critique spreads the model's
 * raw, unparsed turn output straight into `gate.lintPost`, which only knows
 * the field name `text`; a schema-level refinement wouldn't be visible to
 * that call, and wrapping this schema in `ZodEffects` risks breaking
 * `AnthropicAdapter`'s `z.toJSONSchema(req.schema)` tool-input conversion).
 * `text` stays for every pre-existing call site (self-critique's own
 * `gate.lintPost` call, `render.preview`, `gate.numbersSourced`,
 * `gate.brandCompliance`) that already depends on a field literally named
 * `text`; `mainPostText` is the spec-named field matching x-agent-v2
 * SKILL.md step 09's draft artifact (`{text, parts?, first_reply?}`) and is
 * what the workflow's link-placement check (x-craft.md §5: "post the idea
 * clean and put the link in the first reply") actually inspects.
 */
export const XPostOutputSchema = z.object({
  text: z.string().min(1),
  mainPostText: z.string().min(1),
  /** Set only when a link is relevant to this post (x-craft.md §5) — the link itself must never appear in `text`/`mainPostText`. */
  firstReplyUrl: z.string().url().optional(),
  hook: z.string().min(1),
  angle: z.string().min(1),
  lane: LaneSchema,
  targetHandle: z.string().min(1),
  /** Only meaningful when `lane === "engagement"`: the roster account this reply/quote is aimed at (x-craft.md §4, lanes.md lane 6). Not roster-validated here — see the workflow's own caps-only gap note. */
  targetPostHandle: z.string().min(1).optional(),
  /** Only meaningful when `lane === "engagement"`: the specific post URL being replied to or quoted. */
  targetPostUrl: z.string().url().optional(),
  mediaRefs: z.array(z.string()).default([]),
});
export type XPostOutput = z.infer<typeof XPostOutputSchema>;

/**
 * X-specific hook/engagement-bait phrases from x-craft.md §1 and §4 that
 * aren't already in `gate.lintPost`'s shared `DEFAULT_BANNED_PHRASES` bank
 * (checked directly against `packages/tools/karos-gates/src/lint-post.ts`:
 * "unpopular opinion:", "hot take:", and "nobody talks about" are already
 * there, so they're deliberately not repeated here). Passed locally via
 * `selfCritique.gateArgs` rather than edited into the shared file, since
 * cross-cutting gate content is another engineer's concern this batch.
 */
const X_SPECIFIC_BANNED_PHRASES = ["i'm going to say it:", "great post", "this 👇", "so true", "🧵"];

/**
 * The RFC-02 §3 pilot agent: drafts exactly one X post per run (RFC-01
 * §16.2's "one post, one run" ruling). `skillRef` resolves the full craft
 * policy (voice, hook construction, formatting, the six lanes, link
 * placement) dynamically through `runtime.promptStore` (RFC-01 §16.1) —
 * nothing here is a hardcoded prompt literal. Pinned to version "2": "1" is
 * kept frozen as the pre-lane-restoration baseline (mirroring x-agent-v2's
 * own "v1 stays in place, untouched" convention for its predecessor).
 * `allowedTools` covers the mechanical render check and the three content
 * gates; `gate.lintPost` also runs as this agent's own self-critique, bounded
 * to one revision. `gateArgs: {platform: "x", bannedPhrases: [...]}` pins the
 * 280-character limit explicitly (the draft object handed to self-critique is
 * the model's raw turn output, before `outputSchema` defaults ever apply, so
 * leaving `platform` for the model to supply would silently fall back to
 * `gate.lintPost`'s generic 5000-character limit) and layers in the
 * X-specific banned-phrase additions on top of the shared bank.
 */
export class XDraftAgent extends BaseAgent<XPostOutput> {
  protected readonly config: AgentStepConfig<XPostOutput> = {
    id: "x-draft",
    description: "Draft a single X post for the selected candidate topic, lane and angle.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: XPostOutputSchema,
    // Pinned — RFC-02 §3: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: resolveModelPolicy("x-draft", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "x-craft@2",
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 1,
      gateArgs: { platform: "x", bannedPhrases: X_SPECIFIC_BANNED_PHRASES },
    },
  };
}
