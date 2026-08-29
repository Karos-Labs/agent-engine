import { describe, expect, it } from "vitest";
import { checkLength, truncateAtFold, truncateToLimit } from "../src/index.js";

describe("checkLength", () => {
  it("reports withinLimit true at exactly the ceiling", () => {
    expect(checkLength("abc", 3)).toEqual({ characterCount: 3, withinLimit: true });
  });

  it("reports withinLimit false one character past the ceiling", () => {
    expect(checkLength("abcd", 3)).toEqual({ characterCount: 4, withinLimit: false });
  });
});

describe("truncateToLimit", () => {
  it("returns text untouched at or under the limit", () => {
    expect(truncateToLimit("abc", 3)).toBe("abc");
    expect(truncateToLimit("ab", 3)).toBe("ab");
  });

  it("truncates so the total length (including the ellipsis) never exceeds the limit", () => {
    const result = truncateToLimit("abcdef", 3);
    expect(result).toBe("ab…");
    expect(result.length).toBe(3);
  });
});

describe("truncateAtFold", () => {
  it("returns text untouched at or under the fold", () => {
    expect(truncateAtFold("abc", 3)).toBe("abc");
  });

  it("keeps the first foldCharacters verbatim and appends an ellipsis, one char past fold", () => {
    const result = truncateAtFold("abcdef", 3);
    expect(result).toBe("abc…");
    // Deliberately foldCharacters + 1 long (the fold preview, unlike truncateToLimit,
    // previews where a reader stops scrolling rather than enforcing a hard ceiling).
    expect(result.length).toBe(4);
  });
});
