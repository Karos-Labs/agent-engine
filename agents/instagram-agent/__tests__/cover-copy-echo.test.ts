import { describe, expect, it } from "vitest";
import { sentencesOf } from "../src/workflow/bounded-object.js";
import { trimToSentenceBudget, withCoverBudget, withoutHeadlineEcho } from "../src/workflow/slides-data.js";

/** The second local re-render of prep batch 8 (2026-09-26). */
describe("a sentence never ends at an initial", () => {
  it("keeps 'J.P. Morgan' and 'U.S.' inside their sentence", () => {
    const body = "Judges from a16z and J.P. Morgan spend more time on it than on any other slide. That is the whole case.";
    expect(sentencesOf(body)).toEqual(["Judges from a16z and J.P. Morgan spend more time on it than on any other slide.", "That is the whole case."]);
    expect(trimToSentenceBudget(body, 16)).toBe("Judges from a16z and J.P. Morgan spend more time on it than on any other slide.");
    expect(withCoverBudget({ headline: "Your 'Why Now' slide wins the room.", body }).body).toMatch(/^Judges from a16z and J\.P\. Morgan spend/u);
    expect(sentencesOf("Sales in the U.S. doubled. Europe did not.")).toHaveLength(2);
  });
});

describe("a body never opens by repeating the headline", () => {
  it("drops the leading sentences the headline already says, and keeps a body it would empty", () => {
    const slide = { headline: "You own twelve. You reach for three.", body: "You own twelve. You reach for three. The ones that earn that reach are not a compromise." };
    expect(withoutHeadlineEcho(slide).body).toBe("The ones that earn that reach are not a compromise.");
    const same = { headline: "Feel is the spec.", body: "Feel is the spec." };
    expect(withoutHeadlineEcho(same).body).toBe("Feel is the spec.");
    const unrelated = { headline: "The drawer doesn't lie", body: "You own twelve." };
    expect(withoutHeadlineEcho(unrelated)).toBe(unrelated);
  });
});
