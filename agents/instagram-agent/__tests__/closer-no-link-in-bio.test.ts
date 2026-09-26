import { describe, expect, it } from "vitest";
import { withoutBannedCloserAsk } from "../src/workflow/slides-data.js";

/** Owner decision 16 (2026-09-25): never "link in bio", never a follow line. Prep batch 8's Deel closer still had one. */
describe("withoutBannedCloserAsk", () => {
  it("drops the sentence that sends readers to the bio or asks for a follow, keeps the rest", () => {
    expect(withoutBannedCloserAsk("Which shift is yours? The 2027 waitlist is open at the link in bio.")).toBe("Which shift is yours?");
    expect(withoutBannedCloserAsk("Save this for your next deck. Follow us for more.")).toBe("Save this for your next deck.");
    expect(withoutBannedCloserAsk("Link na bio.")).toBe("");
    expect(withoutBannedCloserAsk("הלינק בביו מחכה לכם. שמרו את הפוסט.").includes("שמרו")).toBe(true);
  });

  it("leaves an ordinary ask exactly as written", () => {
    expect(withoutBannedCloserAsk("Book a teardown of your stack.")).toBe("Book a teardown of your stack.");
    expect(withoutBannedCloserAsk("Where are you building from?")).toBe("Where are you building from?");
  });
});
