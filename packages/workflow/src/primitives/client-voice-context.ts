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
 *
 * SCRUM-309 (AU31): prose is still a REAL signal (a profile can state its
 * language in a sentence nobody structured), but it is not a RELIABLE one —
 * geektime's brand-voice document specified Hebrew nowhere near
 * `profile.description`, so the prior fix above still shipped English copy
 * for that client and passed every check that existed (no language
 * dimension existed anywhere in the QA chain). `brand` is the BrandKit's
 * `client.getBrand()` result; when its structured `language` field is set,
 * an explicit, unconditional directive naming it is placed FIRST in the
 * block, ahead of and independent of whatever profile/voiceRules prose is or
 * isn't present. This is deliberately not folded into the same "description"
 * bucket as the prose above: a structured field must never be
 * indistinguishable, on the page the model reads, from a sentence someone
 * happened to write.
 */
export function buildClientVoiceContext(
  profile: Record<string, unknown> | undefined,
  voiceRules: Record<string, unknown> | undefined,
  brand?: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];

  const language = brand?.["language"];
  if (typeof language === "string" && language.trim().length > 0) {
    parts.push(
      `LANGUAGE REQUIREMENT (structured, from this client's brand kit — not inferred from prose): write entirely in ${language.trim()}. This is a hard requirement, not a stylistic preference, and it holds even if nothing below mentions it.`,
    );
  }

  const description = profile?.["description"];
  if (typeof description === "string" && description.trim().length > 0) parts.push(description.trim());
  const guidelines = voiceRules?.["guidelines"];
  if (typeof guidelines === "string" && guidelines.trim().length > 0) parts.push(guidelines.trim());
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
