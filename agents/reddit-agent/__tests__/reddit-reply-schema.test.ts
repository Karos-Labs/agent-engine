import { describe, expect, it } from "vitest";
import { RedditReplyOutputSchema } from "../src/agent/reddit-draft-agent.js";

describe("RedditReplyOutputSchema (Phase 2.5 Batch 2.1 — reply-only restoration)", () => {
  it("accepts a well-formed reply", () => {
    const parsed = RedditReplyOutputSchema.safeParse({
      targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/a_thread/",
      targetThreadTitle: "A thread asking a real question",
      replyBody: "A genuinely useful reply.",
      targetSubreddit: "smallbusiness",
      disclosureIncluded: false,
      text: "A genuinely useful reply.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an optional parentCommentId for a reply to a specific comment rather than the thread root", () => {
    const parsed = RedditReplyOutputSchema.safeParse({
      targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/a_thread/",
      targetThreadTitle: "A thread asking a real question",
      parentCommentId: "t1_abcdef",
      replyBody: "A genuinely useful reply to one specific comment.",
      targetSubreddit: "smallbusiness",
      disclosureIncluded: false,
      text: "A genuinely useful reply to one specific comment.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a submission-shaped draft — no targetThreadUrl, a title/body/targetSubreddit/flair shape instead", () => {
    // This is the exact shape the pre-restoration agent produced: an original
    // Reddit submission. Legacy's non-negotiable rule is "comments only, never
    // original posts" (reddit-agent-v2/SKILL.md line 9) — the new schema must
    // never again accept this shape.
    const submissionShapedDraft = {
      title: "A catchy title for a new post",
      body: "A whole post body, as if this were a submission rather than a reply.",
      targetSubreddit: "smallbusiness",
      flair: "",
      hook: "A catchy hook.",
      text: "A catchy title for a new post\n\nA whole post body, as if this were a submission rather than a reply.",
    };
    const parsed = RedditReplyOutputSchema.safeParse(submissionShapedDraft);
    expect(parsed.success).toBe(false);
  });

  it("rejects a draft missing targetThreadUrl even if every other reply field is present", () => {
    const parsed = RedditReplyOutputSchema.safeParse({
      targetThreadTitle: "A thread asking a real question",
      replyBody: "A genuinely useful reply.",
      targetSubreddit: "smallbusiness",
      disclosureIncluded: false,
      text: "A genuinely useful reply.",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty replyBody", () => {
    const parsed = RedditReplyOutputSchema.safeParse({
      targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/a_thread/",
      targetThreadTitle: "A thread asking a real question",
      replyBody: "",
      targetSubreddit: "smallbusiness",
      disclosureIncluded: false,
      text: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("no longer has a flair field in its shape (dropped, not renamed — flair is submission-only on Reddit)", () => {
    const parsed = RedditReplyOutputSchema.safeParse({
      targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/a_thread/",
      targetThreadTitle: "A thread asking a real question",
      replyBody: "A genuinely useful reply.",
      targetSubreddit: "smallbusiness",
      disclosureIncluded: false,
      text: "A genuinely useful reply.",
      flair: "some flair",
    });
    // Strips unknown keys rather than rejecting (default zod object behavior) —
    // the meaningful assertion is that `flair` is not part of the parsed shape.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("flair" in parsed.data).toBe(false);
    }
  });
});
