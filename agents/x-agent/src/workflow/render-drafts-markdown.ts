import type { XPostOutput } from "../agent/x-draft-agent.js";

/**
 * Renders this run's single draft into the exact `DRAFTS.md` shape karosCMO's
 * `x-drafts.ts` parser expects (`# Account N · <name>` / `## Avenue N ·
 * <lane>` / a `> ` blockquote / a `` `NNN chars` `` line / `- **` meta
 * bullets — docs/x-agent-portal.md in karosCMO, pinned by
 * `src/lib/__tests__/x-drafts.test.ts` there). One post, one run (RFC-01
 * §16.2), so this is always exactly one account section with one avenue
 * block — no thread markers, since `XPostOutputSchema` never splits a post
 * into parts.
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
}): string {
  const { targetHandle, lane, angle, draft } = input;
  const laneTitle = lane.charAt(0).toUpperCase() + lane.slice(1);
  const quoted = draft.mainPostText
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  const metaBullets: string[] = [`**Hook:** ${draft.hook}`];
  // Only an "engagement" lane reply/quote names a target — see x-drafts.ts's
  // own metaTarget() rule: an unlabelled URL is never treated as a target.
  if (draft.lane === "engagement" && draft.targetPostUrl) {
    metaBullets.push(`**In reply to:** ${draft.targetPostUrl}`);
  }
  if (draft.firstReplyUrl) {
    metaBullets.push(`**First reply:** ${draft.firstReplyUrl}`);
  }

  return [
    `# Account 1 · ${targetHandle}`,
    "",
    `## Avenue 1 · ${laneTitle}`,
    `*${angle}*`,
    "",
    quoted,
    "",
    `\`${draft.mainPostText.length} chars\``,
    "",
    ...metaBullets.map((bullet) => `- ${bullet}`),
    "",
  ].join("\n");
}
