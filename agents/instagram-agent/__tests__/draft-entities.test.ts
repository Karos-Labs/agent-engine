import { describe, expect, it } from "vitest";
import { entitiesInDraft, entityPictureBrief } from "../src/workflow/draft-entities.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * `04b3-extract-entities` runs BEFORE the copy step and reads the topic, the
 * angle and the research cards. A name the WRITER introduced is invisible to
 * it, because the writer had not written yet.
 *
 * The Karos carousel of 2026-09-19 is the case: slide 4's first item read
 * *"A buyer hears your name from ChatGPT"*, and nothing ever asked for a
 * picture of it. The owner: *"the example of the post that says CHATGPT is a
 * classic one to put Sam Altman, who is identified with them, or their logo."*
 */

const slide = (n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy =>
  ({ n, headline: `Headline ${n}`, body: `Body ${n}.`, sourceRef: "a claim", layout: "photo", visualNeed: "a desk", ...over }) as InstagramSlideCopy;

const copyOf = (slides: InstagramSlideCopy[]): InstagramCopyOutput =>
  ({ caption: "a caption", slides, format: "carousel" }) as unknown as InstagramCopyOutput;

describe("entitiesInDraft", () => {
  it("finds the name the shipped carousel buried in a list note", () => {
    const found = entitiesInDraft(
      copyOf([
        slide(4, {
          headline: "What attribution misses by design",
          items: [{ title: "AI assistant recommendations", note: "A buyer hears your name from ChatGPT. No click is logged." }],
        }),
      ]),
    );
    expect(found.map((e) => e.name)).toContain("ChatGPT");
    expect(found.find((e) => e.name === "ChatGPT")!.slides).toEqual([4]);
  });

  it("reads a Latin name inside HEBREW prose, which is where the signal is strongest", () => {
    // Hebrew has no case, so a capitalised Latin token mid-sentence in a
    // right-to-left paragraph is a foreign proper noun and nothing else.
    const found = entitiesInDraft(copyOf([slide(2, { body: "כל סוכן שרץ על OpenAI צריך בדיקה לפני deploy." })]));
    expect(found.map((e) => e.name)).toContain("OpenAI");
  });

  it("keeps a two-word person's name together", () => {
    const found = entitiesInDraft(copyOf([slide(3, { body: "That is what Sam Altman said about the funding round." })]));
    expect(found.map((e) => e.name)).toContain("Sam Altman");
  });

  it("ranks a name in a HEADLINE above one in a note, and a repeated one above a single mention", () => {
    const found = entitiesInDraft(
      copyOf([
        // The second mention is NOT sentence-initial on purpose: a name that only
        // ever opens a sentence is skipped by design, and a fixture that leaned on
        // one would be testing the skip rather than the ranking.
        slide(1, { headline: "Why LinkedIn changed the rules", body: "Last week LinkedIn did it again." }),
        slide(2, { headline: "A quiet change", body: "It also touched Notion once." }),
      ]),
    );
    expect(found[0]!.name).toBe("LinkedIn");
    expect(found[0]!.inHeadline).toBe(true);
    expect(found[0]!.mentions).toBe(2);
  });

  it("does NOT read the first word of a sentence as a name", () => {
    // "Buyers open their window when they are ready" would otherwise
    // contribute "Buyers", which is how a capitalisation counter fails.
    const found = entitiesInDraft(copyOf([slide(1, { headline: "Buyers open their window", body: "Teams miss it. Sorting tickets helps." })]));
    expect(found.map((e) => e.name)).toEqual([]);
  });

  it("drops the acronyms and calendar words that are capitalised and are not things", () => {
    const found = entitiesInDraft(copyOf([slide(1, { body: "We reviewed the MTA model on Monday, then the ROI in Q3 and the GDPR position." })]));
    expect(found.map((e) => e.name)).toEqual([]);
  });

  it("excludes the client's own name, because their own logo on their own post is a different feature", () => {
    const found = entitiesInDraft(
      copyOf([slide(1, { body: "Before Karos Labs deployed an agent we ran Karos on our own brand." })]),
      ["Karos Labs"],
    );
    expect(found.map((e) => e.name)).toEqual([]);
  });

  it("records every slide a name appears on, so the caller can pick which one gets the picture", () => {
    const found = entitiesInDraft(
      copyOf([slide(2, { body: "It started with Figma." }), slide(5, { body: "Then Figma shipped it." }), slide(6, { body: "Nothing here." })]),
    );
    expect(found[0]!.slides).toEqual([2, 5]);
    expect(found[0]!.mentions).toBe(2);
  });
});

describe("entityPictureBrief", () => {
  it("asks for the thing itself and names the three shapes a tier can actually find", () => {
    const brief = entityPictureBrief({ name: "OpenAI", slides: [4], mentions: 1, inHeadline: false });
    expect(brief).toContain("OpenAI");
    expect(brief).toMatch(/mark/);
    expect(brief).toMatch(/product surface/);
    expect(brief).toMatch(/press photograph/);
    // And the refusal that matters: not a stock photo of the category.
    expect(brief).toContain("not a generic scene");
  });
});
