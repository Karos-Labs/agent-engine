/**
 * The client's own profile description plus voice-rules guidelines, joined
 * into one block for a drafting prompt to read.
 *
 * Exists because a client's outlet-level facts — most concretely, what
 * LANGUAGE it publishes in — get stated in plain prose ("Israel's largest
 * Hebrew-language technology... site") rather than a dedicated field, since
 * nobody writing a profile blurb expects a machine to need it separated out.
 * Before this helper existed, no channel agent forwarded `profile.description`
 * to its drafting prompt at all — only `voiceRules` (tone/forbiddenTerms) —
 * so a client's own stated language never reached the model regardless of
 * what channel it was posting to (prep job hcf9ymPGJC7mDS5pcEQ4, Geektime,
 * shipped an entirely English carousel for a Hebrew-only outlet).
 *
 * One shared builder rather than six near-identical inline joins, so every
 * channel reads this exactly the same way and a future fix to the join logic
 * lands everywhere at once instead of five-out-of-six times.
 */
export function buildClientVoiceContext(
  profile: Record<string, unknown> | undefined,
  voiceRules: Record<string, unknown> | undefined,
): string | undefined {
  const parts: string[] = [];
  const description = profile?.["description"];
  if (typeof description === "string" && description.trim().length > 0) parts.push(description.trim());
  const guidelines = voiceRules?.["guidelines"];
  if (typeof guidelines === "string" && guidelines.trim().length > 0) parts.push(guidelines.trim());
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
