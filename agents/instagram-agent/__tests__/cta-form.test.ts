import { describe, expect, it } from "vitest";
import { ctaFormFor } from "../src/workflow/slides-data.js";

// 2026-09-23 (stage 1 of the reference-looks plan): the Deel reference closes
// on a pill reading "Join the 2027 waitlist". A closing sentence is not a
// button, so the form is decided on the words.
describe("ctaFormFor", () => {
  it("sets a short action as a button", () => {
    expect(ctaFormFor("Join the 2027 waitlist")).toBe("pill");
    expect(ctaFormFor("Save this for Friday.")).toBe("pill");
    expect(ctaFormFor("הצטרפו לרשימת ההמתנה")).toBe("pill");
  });

  it("keeps a sentence, a two-clause line or a long line as text", () => {
    expect(ctaFormFor("Before you trust a result, check that the question it answers is the one in front of you.")).toBe("line");
    expect(ctaFormFor("Save this. Share it.")).toBe("line");
    expect(ctaFormFor("Book a call: fifteen minutes")).toBe("line");
    expect(ctaFormFor("")).toBe("line");
  });
});
