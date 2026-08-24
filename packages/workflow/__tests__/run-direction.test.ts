import { describe, expect, it } from "vitest";
import { readRunDirection, runDirectionField } from "../src/index.js";

/**
 * `readRunDirection` — one answer, for every agent, to two questions:
 * does a typed instruction outrank the topic catalog, and does the drafting
 * model get to see it?
 */

describe("readRunDirection", () => {
  it("returns nothing to honour when no instruction was typed", () => {
    const d = readRunDirection({});
    expect(d.direction).toBeUndefined();
    expect(d.topicOverride).toBeUndefined();
    expect(d.mediaAssets).toEqual([]);
    // Omitted, not present-and-undefined: an explicit `runDirection: undefined`
    // invites a model to remark on its absence instead of working without one.
    expect(runDirectionField(d)).toEqual({});
  });

  it("treats a subject as both direction and a topic override", () => {
    const d = readRunDirection({ customPrompt: "Focus on the product launch" });
    expect(d.direction).toBe("Focus on the product launch");
    expect(d.topicOverride).toBe("Focus on the product launch");
    expect(runDirectionField(d)).toEqual({ runDirection: "Focus on the product launch" });
  });

  const styleOnly = [
    "Keep it shorter than usual",
    "Avoid the word synergy",
    "no emoji please",
    "Make it more casual",
    "don't mention pricing",
  ];

  for (const instruction of styleOnly) {
    it(`treats "${instruction}" as direction only, never as a topic`, () => {
      // The asymmetry that justifies the conservatism: a style note misread as
      // a topic gets reserved in the catalog and drafted against, producing a
      // post about the instruction itself.
      const d = readRunDirection({ customPrompt: instruction });
      expect(d.direction).toBe(instruction);
      expect(d.topicOverride).toBeUndefined();
    });
  }

  it("treats a whole paragraph as a brief, not a topic line", () => {
    const paragraph = "x".repeat(200);
    const d = readRunDirection({ customPrompt: paragraph });
    expect(d.direction).toBe(paragraph);
    expect(d.topicOverride).toBeUndefined();
  });

  it("normalises whitespace-only direction away rather than honouring an empty string", () => {
    // An empty instruction must read as "use the client's strategy", never as
    // "the client has no direction".
    const d = readRunDirection({ customPrompt: "   " });
    expect(d.direction).toBeUndefined();
  });

  it("carries attached media through, and drops a malformed asset without failing", () => {
    const d = readRunDirection({
      mediaAssets: [
        { uri: "gs://bucket/a.jpg", role: "source", label: "hero" },
        { role: "source" },
        "not an object",
      ],
    });
    // An asset with no uri is not an asset; a bad optional field must not fail
    // a run that would otherwise have worked.
    expect(d.mediaAssets).toHaveLength(1);
    expect(d.mediaAssets[0]).toMatchObject({ uri: "gs://bucket/a.jpg", label: "hero" });
  });

  it("reads direction and media from the same input together", () => {
    const d = readRunDirection({
      customPrompt: "Focus on the product launch",
      mediaAssets: [{ uri: "gs://bucket/1.jpg" }, { uri: "gs://bucket/2.jpg" }],
    });
    expect(d.topicOverride).toBe("Focus on the product launch");
    expect(d.mediaAssets).toHaveLength(2);
  });
});
