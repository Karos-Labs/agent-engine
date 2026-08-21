import type { LinkedInPostOutput } from "../agent/linkedin-draft-agent.js";
import type { LinkedInIdentity } from "./types.js";

/**
 * Renders this run's single draft into the exact `# LinkedIn drafts` shape
 * karosCMO's `li-drafts.ts` parser expects (`# LinkedIn drafts` title / `##
 * Account N · <name>` / `### Post N · <archetype>` / a `> ` blockquote / a
 * `` `NNN chars` `` line / `- **` meta bullets — docs/linkedin-agent-portal.md
 * in karosCMO). One post, one run (RFC-02 §5), so this is always exactly one
 * account section with one post block.
 *
 * Persisted alongside the existing structured `draft` object (additive, see
 * step 16's own call site), not in place of it.
 */
export function renderLinkedInDraftsMarkdown(input: {
  identity: LinkedInIdentity;
  companyName?: string;
  archetype: string;
  topic: string;
  draft: LinkedInPostOutput;
}): string {
  const { identity, companyName, archetype, topic, draft } = input;
  const accountTitle =
    identity.scope === "executive"
      ? `${identity.executiveName}${identity.executiveTitle ? ` (${identity.executiveTitle})` : ""}`
      : companyName
        ? `${companyName} — Company page`
        : "Company page";
  const archetypeLabel = archetype.charAt(0).toUpperCase() + archetype.slice(1).replace(/-/g, " ");
  const quoted = draft.text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  return [
    "# LinkedIn drafts",
    "",
    `## Account 1 · ${accountTitle}`,
    "",
    `### Post 1 · ${archetypeLabel}`,
    "",
    quoted,
    "",
    `\`${draft.text.length} chars\``,
    "",
    `- **Topic:** ${topic}`,
  ].join("\n");
}
