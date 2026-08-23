import { z } from "zod";

/**
 * Onboarding payloads for the two setup agents.
 *
 * These arrive as the run's own input (`WorkflowContext.input`), not as client
 * configuration, because that is what they are: one person filling one form,
 * once. Writing them into client config first and reading them back would put
 * a form submission somewhere every other run for that client also reads.
 *
 * Everything is validated here rather than trusted, because the source is a
 * portal form. A malformed seat name becomes a path segment; a missing profile
 * URL becomes a charter that claims to describe someone it cannot identify.
 */

/** "Daniel Herbert" -> "daniel-herbert", matching the lab repo's seat filenames. */
export function slugifySeat(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One LinkedIn seat's intake.
 *
 * Mirrors the lab repo's `seat-intake-template.md` field for field, because
 * the document this produces has to be readable next to the ones migrated from
 * there — a drafting run cannot tell which way a charter arrived, and should
 * not have to.
 */
export const LinkedInSeatIntakeSchema = z.object({
  fullName: z.string().min(1, "a seat needs the person's name"),
  role: z.string().min(1).optional(),
  profileUrl: z.string().min(1).optional(),
  /**
   * The 2-4 topics this person wants to be known for, and anything they do
   * NOT want posted. The second half is the one that matters at draft time.
   */
  focusTopics: z.array(z.string().min(1)).default([]),
  offLimitsTopics: z.array(z.string().min(1)).default([]),
  /**
   * A real sample of how they write. The template's own note explains the
   * ranking: a spoken sample beats their posts, which beat the edit loop.
   */
  voiceSample: z.string().optional(),
  /** Where the CV was uploaded, when one was. The engine never reads the file itself. */
  cvPath: z.string().optional(),
});
export type LinkedInSeatIntake = z.infer<typeof LinkedInSeatIntakeSchema>;

export const LinkedInSetupInputSchema = z.object({
  /** Standing direction for the company page, which is a seat in every way that matters here. */
  companyUpdates: z.string().optional(),
  seats: z.array(LinkedInSeatIntakeSchema).default([]),
});
export type LinkedInSetupInput = z.infer<typeof LinkedInSetupInputSchema>;

export const RedditSetupInputSchema = z.object({
  /**
   * The communities this client may post into. Normalised to bare names so a
   * caller can pass "r/marketing" or "marketing" and the stored document reads
   * the same either way.
   */
  targetSubreddits: z.array(z.string().min(1)).min(1, "reddit setup needs at least one subreddit"),
  /** The account replies are drafted for. */
  accountName: z.string().min(1).optional(),
  /** How this account is expected to sound in a community that did not ask for it. */
  voiceNotes: z.string().optional(),
  /** Subjects this client will not engage on, whatever the thread says. */
  offLimitsTopics: z.array(z.string().min(1)).default([]),
});
export type RedditSetupInput = z.infer<typeof RedditSetupInputSchema>;

export interface SetupWorkflowResult {
  /** Strategy documents written, by their store path. */
  written: string[];
  /** Documents skipped, and why — never silently dropped. */
  skipped: { key: string; reason: string }[];
}

/** `r/Marketing` and `Marketing` are the same community; the stored form is `r/marketing`. */
export function normalizeSubreddit(raw: string): string {
  const bare = raw.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return bare ? `r/${bare.toLowerCase()}` : "";
}
