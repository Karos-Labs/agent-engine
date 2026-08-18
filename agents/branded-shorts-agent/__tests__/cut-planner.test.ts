import { describe, expect, it } from "vitest";
import { deriveCutSegments, totalRetainedDuration } from "../src/workflow/cut-planner.js";
import type { TranscriptWord } from "@agent-engine/tool-karos-video";

function word(text: string, start: number, end: number, type = "word"): TranscriptWord {
  return { type, text, start, end };
}

describe("deriveCutSegments", () => {
  it("crops to the first/last spoken word and returns nothing to cut when there is no filler", () => {
    const words = [word("silence", -1, 0, "spacing"), word("Hello", 0.5, 0.9), word("world", 1.0, 1.5)];
    const { segments, contentCuts } = deriveCutSegments(words);
    expect(segments).toEqual([[0.5, 1.5]]);
    expect(contentCuts).toEqual([]);
  });

  it("removes a padded filler span from the middle, producing two kept segments (each clearing the 1.5s floor)", () => {
    const words = [word("Hello", 0.0, 2.0), word("um", 2.0, 2.3), word("world", 2.3, 5.0)];
    const { segments } = deriveCutSegments(words);
    // The filler is padded 65ms each side (FILLER_PAD_S) — compared with float tolerance.
    expect(segments).toHaveLength(2);
    expect(segments[0]![0]).toBeCloseTo(0, 6);
    expect(segments[0]![1]).toBeCloseTo(1.935, 6);
    expect(segments[1]![0]).toBeCloseTo(2.365, 6);
    expect(segments[1]![1]).toBeCloseTo(5.0, 6);
  });

  it("glues a filler back in rather than minting a sub-1.5s fragment (SKILL.md step 2)", () => {
    // Removing "um" here would leave a 1.0s kept fragment before it — under the 1.5s floor.
    const words = [word("Hi", 0.0, 1.0), word("um", 1.0, 1.2), word("there", 1.2, 3.0)];
    const { segments } = deriveCutSegments(words);
    expect(segments).toHaveLength(1);
    expect(segments[0]![0]).toBe(0);
    expect(segments[0]![1]).toBe(3.0);
  });

  it("never removes a real word that merely sounds like filler ('like', 'you know', 'actually')", () => {
    const words = [word("Honestly", 0.0, 0.6), word("like", 0.6, 1.5), word("wow", 1.5, 3.0)];
    const { segments } = deriveCutSegments(words);
    expect(segments).toEqual([[0.0, 3.0]]);
  });

  it("only applies a caller-declared content cut when it has an explicit span, and records it in contentCuts", () => {
    const words = [word("keep", 0.0, 1.0), word("drop", 2.0, 4.0), word("keep", 5.0, 8.0)];
    const { segments, contentCuts } = deriveCutSegments(words, {
      declaredContentCuts: [{ span: [1.9, 4.1], reason: "client asked to remove this line" }],
    });
    expect(segments).toEqual([
      [0.0, 1.9],
      [4.1, 8.0],
    ]);
    expect(contentCuts).toEqual([{ span: [1.9, 4.1], reason: "client asked to remove this line" }]);
  });

  it("widens a declared cut's reported span to the true merged extent when it abuts a filler span (P1#7)", () => {
    // The declared cut is [2.0, 4.0]; a filler word right after it pads out to
    // [3.935, 4.265] and merges in. cut_check.py's HONESTY check compares the
    // declared span against the ACTUAL removed gap, so under-reporting [2.0, 4.0]
    // here would make the wider real gap look partly undeclared and fail the gate.
    const words = [word("keep1", 0, 1.5), word("um", 4.0, 4.2), word("keep2", 4.5, 6.5)];
    const { segments, contentCuts } = deriveCutSegments(words, {
      declaredContentCuts: [{ span: [2.0, 4.0], reason: "remove middle content" }],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual([0, 2.0]);
    expect(segments[1]![0]).toBeCloseTo(4.265, 6);
    expect(segments[1]![1]).toBe(6.5);

    expect(contentCuts).toHaveLength(1);
    expect(contentCuts[0]!.span[0]).toBe(2.0);
    expect(contentCuts[0]!.span[1]).toBeCloseTo(4.265, 6);
    expect(contentCuts[0]!.reason).toBe("remove middle content");
  });

  it("concatenates both reasons, never dropping one, when two declared cuts merge into a single span", () => {
    const words = [word("keep1", 0, 0.5), word("keep2", 9.5, 10)];
    const { segments, contentCuts } = deriveCutSegments(words, {
      declaredContentCuts: [
        { span: [3.0, 5.0], reason: "reason A" },
        { span: [4.5, 7.0], reason: "reason B" },
      ],
    });
    expect(segments).toEqual([
      [0, 3.0],
      [7.0, 10],
    ]);
    expect(contentCuts).toEqual([{ span: [3.0, 7.0], reason: "reason A; reason B" }]);
  });

  it("returns no segments for a transcript with no spoken words, letting the caller decide the run is unusable", () => {
    const words = [word("um", 0, 0.3, "audio_event"), word(" ", 0.3, 0.4, "spacing")];
    const { segments, contentCuts } = deriveCutSegments(words);
    expect(segments).toEqual([]);
    expect(contentCuts).toEqual([]);
  });
});

describe("totalRetainedDuration", () => {
  it("sums every kept segment's length", () => {
    expect(
      totalRetainedDuration([
        [0, 3],
        [7, 10.5],
      ]),
    ).toBeCloseTo(6.5, 6);
  });

  it("is zero for no segments", () => {
    expect(totalRetainedDuration([])).toBe(0);
  });
});
