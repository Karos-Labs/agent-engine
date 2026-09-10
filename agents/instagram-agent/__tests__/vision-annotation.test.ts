import { describe, expect, it } from "vitest";
import { buildVisionAnnotation, describeWithVision } from "../src/workflow/vision-annotation.js";

/**
 * The `[vision: ...]` suffix the vetting gate reads (RFC-13 §F).
 *
 * `instagram-image-vet@3` never sees an image: it judges the candidate's
 * description as text, and its `claimMatch` rubric turns on the identity of
 * what is in frame. `subjects` is the field that carries "Maccabi Tel Aviv
 * supporters", and both places that enrich a candidate used to drop it — so
 * the vet scored "supporters in a floodlit stadium" a 3 (the selection floor)
 * under any club's headline.
 */

const FANS = {
  description: "  supporters with scarves in a floodlit stadium  ",
  subjects: ["Maccabi Tel Aviv supporters", "yellow and blue scarves", "floodlit stadium"],
  textInImage: ["MACCABI"],
  mood: "celebratory",
};

describe("buildVisionAnnotation", () => {
  it("puts the named subjects in front of the vet, after the sentence and before the legible text", () => {
    expect(buildVisionAnnotation(FANS)).toBe(
      " [vision: supporters with scarves in a floodlit stadium; subjects: Maccabi Tel Aviv supporters, yellow and blue scarves, floodlit stadium; text in image: MACCABI]",
    );
  });

  it("omits the flags unless the caller asks for them — a client upload is not judged on being a screenshot", () => {
    const screenshot = { description: "a dashboard", subjects: ["dashboard"], looksLikeScreenshot: true, looksAiGenerated: true };
    expect(buildVisionAnnotation(screenshot)).toBe(" [vision: a dashboard; subjects: dashboard]");
    expect(buildVisionAnnotation(screenshot, { includeFlags: true })).toBe(" [vision: a dashboard; subjects: dashboard; screenshot/document, looks AI-generated]");
  });

  it("appends nothing at all when the inspection carried nothing, and skips the parts it did not carry", () => {
    expect(buildVisionAnnotation({})).toBe("");
    expect(buildVisionAnnotation({ description: "   ", subjects: [], textInImage: [] })).toBe("");
    expect(buildVisionAnnotation({ subjects: ["a crest on the shirt"] })).toBe(" [vision: subjects: a crest on the shirt]");
    expect(buildVisionAnnotation({ description: "a bar chart" })).toBe(" [vision: a bar chart]");
  });

  it("is defensive about what a vision model actually returns: non-strings, blanks, duplicates and runaway lists", () => {
    const messy = {
      description: 42,
      subjects: ["chart", "  chart  ", "CHART", "", null, "laptop", "desk", "window", "mug", "plant", "notebook"],
      textInImage: "31%",
    };
    const annotation = buildVisionAnnotation(messy);
    // One "chart", six subjects at most, and a `textInImage` that is not a
    // list is not printed as one.
    expect(annotation).toBe(" [vision: subjects: chart, laptop, desk, window, mug, plant]");
  });

  it("describeWithVision leaves a description untouched when there is nothing to add", () => {
    expect(describeWithVision("a client upload", {})).toBe("a client upload");
    expect(describeWithVision("a client upload", { subjects: ["a crest"] })).toBe("a client upload [vision: subjects: a crest]");
  });
});
