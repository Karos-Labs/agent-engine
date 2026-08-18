import { describe, expect, it } from "vitest";
import { guardText, publishGbpReply, type PublishGbpReplyInput } from "../src/workflow/publish-gbp-reply.js";

/**
 * RFC-08 §9: "the tool exists, the door stays locked." `publishGbpReply` is
 * never wired into `createReputationPulseWorkflow` (see that file's own
 * header comment and the grep-proof in `happy-path.test.ts`) — this suite
 * proves the function itself refuses to publish regardless of a future
 * accidental call site, not just that nothing calls it today.
 */
describe("publishGbpReply: the permanent RFC-08 §9 lock ('the tool exists, the door stays locked')", () => {
  it("refuses a maximally valid-looking call exactly the same as an invalid one", async () => {
    const maximallyValid: PublishGbpReplyInput = {
      account: "accounts/123456789",
      location: "locations/987654321",
      reviewId: "reviews/abcdef",
      text: "Thank you for the feedback, we appreciate you taking the time to share it.",
    };

    await expect(publishGbpReply(maximallyValid)).rejects.toThrow(/permanently locked/i);
    await expect(publishGbpReply(maximallyValid)).rejects.toThrow(/RFC-08/);
  });

  it("refuses an obviously invalid call with the exact same lock error, never reaching guardText's own validation", async () => {
    const obviouslyInvalid: PublishGbpReplyInput = { account: "", location: "", reviewId: "", text: "" };
    await expect(publishGbpReply(obviouslyInvalid)).rejects.toThrow(/permanently locked/i);
  });

  it("never legally permits publishing at any autonomy level today (RFC-08 §6), regardless of input shape", async () => {
    const inputs: PublishGbpReplyInput[] = [
      { account: "a", location: "l", reviewId: "r", text: "fine text" },
      { account: "a", location: "l", reviewId: "r", text: "" },
      { account: "a", location: "l", reviewId: "r", text: "x".repeat(10_000) },
    ];
    for (const input of inputs) {
      await expect(publishGbpReply(input)).rejects.toThrow(/permanently locked/i);
    }
  });
});

describe("guardText: publish.py's guard_text rule, ported (exercised in isolation from the lock above)", () => {
  it("rejects empty text", () => {
    expect(guardText("   ")).toEqual({ ok: false, reason: "reply text is empty" });
  });

  it("rejects an unfilled {{template}} token", () => {
    const result = guardText("Hi {{first_name}}, thanks for the feedback.");
    expect(result.ok).toBe(false);
  });

  it("rejects text over the GBP reply character limit", () => {
    const result = guardText("x".repeat(4097));
    expect(result.ok).toBe(false);
  });

  it("passes clean, filled, in-limit text", () => {
    expect(guardText("Thanks for the feedback, we appreciate it.")).toEqual({ ok: true });
  });
});
