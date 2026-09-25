import { goalLineBullets, type ResolvedGoalLine, type SocialMediaPlan } from "@agent-engine/workflow";
import type { XPostOutput } from "../agent/x-draft-agent.js";
import { readEngagementTarget } from "./engagement-target.js";

/**
 * Renders this run's single draft into the exact `DRAFTS.md` shape karosCMO's
 * `x-drafts.ts` parser expects (`# Account N · <name>` / `## Avenue N ·
 * <lane>` / a `> ` blockquote / a `` `NNN chars` `` line / `- **` meta
 * bullets — docs/x-agent-portal.md in karosCMO, pinned by
 * `src/lib/__tests__/x-drafts.test.ts` there). One post, one run (RFC-01
 * §16.2), so this is always exactly one account section with one avenue
 * block.
 *
 * 2026-09 (C3 / SCRUM-457): the goal line leads the meta bullets — what the
 * post is for, who for, and why now, in D11's three words. The parser pushes
 * every `- **Label:** value` line onto the card's meta list, so these need no
 * portal change to appear; without them the space the card reserves for the
 * goal was simply empty.
 *
 * A THREAD (x-craft@5) renders as the parser's own thread shape: a
 * `**1/N**` marker line before each blockquote, one blockquote per part,
 * each with its own chars line. A single post keeps the marker-free shape it
 * always had, byte for byte.
 *
 * Persisted alongside the existing structured `draft` object (additive, see
 * step 18's own call site) rather than replacing it — `text`/`hook`/`lane`
 * etc. stay available to any consumer that wants the raw fields, while this
 * string is what a karosCMO asset's `content` needs to be for the parser
 * (and the reply/quote deep-link machinery riding on it) to work at all.
 */
export function renderXDraftsMarkdown(input: {
  targetHandle: string;
  lane: string;
  angle: string;
  draft: XPostOutput;
  /** The run's resolved goal line (D11). Rendered as the first meta bullets. */
  goalLine: ResolvedGoalLine;
  media?: SocialMediaPlan | undefined;
}): string {
  const { targetHandle, lane, angle, draft, goalLine, media } = input;
  const laneTitle = lane.charAt(0).toUpperCase() + lane.slice(1);
  const quote = (text: string) =>
    text
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : ">"))
      .join("\n");

  const parts = [draft.mainPostText, ...draft.thread];
  const body: string[] = [];
  if (parts.length === 1) {
    body.push(quote(draft.mainPostText), "", `\`${draft.mainPostText.length} chars\``, "");
  } else {
    parts.forEach((part, index) => {
      body.push(`**${index + 1}/${parts.length}**`, quote(part), "", `\`${part.length} chars\``, "");
    });
  }

  const metaBullets: string[] = [...goalLineBullets(goalLine), `**Hook:** ${draft.hook}`];
  // Only an "engagement" lane reply/quote names a target — see x-drafts.ts's
  // own metaTarget() rule: an unlabelled URL is never treated as a target.
  //
  // THE LABEL IS A CONTRACT, so it is unchanged: karosCMO's `x-drafts.ts`
  // matches `^(?:in\s+)?repl(?:y|ying)(?:\s+(?:to|target|post))?$` on the
  // label, anchored, and that is what decides whether a client's reply gets
  // ADDRESSED at this URL. Rewording it here to carry a warning would be a
  // cross-repo break dressed as an improvement.
  //
  // What DID change is when the line is printed at all. No tool in this agent
  // fetches a post; this URL came out of the drafting model and passed a
  // `z.string().url()` that accepts `https://example.com`. A target that
  // cannot even be shaped like an X post is now dropped instead of printed
  // as a citation — a missing line is a gap a reviewer notices, a fabricated
  // one is a gap they cannot. The gate payload carries the honest wording,
  // on a surface with no parser contract.
  const target = readEngagementTarget(draft);
  if (target.kind === "usable") {
    metaBullets.push(`**In reply to:** ${target.target.url}`);
  }
  if (draft.firstReplyUrl) {
    metaBullets.push(`**First reply:** ${draft.firstReplyUrl}`);
  }
  if (media?.asset !== undefined) {
    const credit = media.asset.requiresCredit && media.asset.creditUrl ? ` · credit ${media.asset.creditUrl}` : "";
    metaBullets.push(`**Media:** ${media.asset.url ?? media.asset.path} (${media.status}, ${media.asset.provider}${credit})`);
  } else if (media !== undefined) {
    metaBullets.push(`**Media:** none — ${media.rationale}`);
  }

  return [`# Account 1 · ${targetHandle}`, "", `## Avenue 1 · ${laneTitle}`, `*${angle}*`, "", ...body, ...metaBullets.map((bullet) => `- ${bullet}`), ""].join("\n");
}
