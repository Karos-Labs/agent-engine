import { describe, expect, it } from "vitest";
import { GateResponseSchema, HEX_COLOR, ReviewEditsSchema, StyleEditSchema } from "../src/types/gate.js";

/**
 * IGSTYLE-1 — the `StyleOverrides` contract, end to end. Unit coverage for
 * the schema half; `apps/agent-server/__tests__/runs.test.ts` covers the
 * resume-route half (the same `HEX_COLOR` mirrored inline there).
 */
describe("HEX_COLOR / StyleEditSchema (IGSTYLE-1)", () => {
  it.each(["orange", "#12345", "rgb(0,0,0)", ""])("rejects %j", (bad) => {
    expect(HEX_COLOR.test(bad)).toBe(false);
    expect(StyleEditSchema.safeParse({ ground: bad }).success).toBe(false);
  });

  it.each(["#111", "#1a1a1a", "#1a1a1aff"])("accepts %j", (good) => {
    expect(HEX_COLOR.test(good)).toBe(true);
    expect(StyleEditSchema.safeParse({ ground: good }).success).toBe(true);
  });

  it("accepts all seven roles at once", () => {
    const result = StyleEditSchema.safeParse({
      ground: "#111111",
      fg: "#eeeeee",
      accent: "#ff7a1a",
      surface: "#222222",
      fg2: "#dddddd",
      line: "#333333",
      accentInk: "#000000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object — a patch with no picks is legal, not a no-op error", () => {
    expect(StyleEditSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an unknown role key rather than silently dropping it", () => {
    // zod's default (non-strict) object mode strips unknown keys rather than
    // rejecting them — asserted explicitly so a future `.strict()` add (or
    // removal) is a deliberate choice, not a silent behavior change.
    const result = StyleEditSchema.safeParse({ ground: "#111111", notARole: "#222222" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("notARole");
  });
});

describe("ReviewEditsSchema.style (IGSTYLE-1)", () => {
  it("is optional — an edits object with no style pick is still legal", () => {
    expect(ReviewEditsSchema.safeParse({ caption: "hello" }).success).toBe(true);
  });

  it("carries a style pick alongside caption/slides untouched", () => {
    const result = ReviewEditsSchema.safeParse({
      caption: "hello",
      slides: [{ n: 1, fields: { headline: "hi" } }],
      style: { ground: "#111111" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.style).toEqual({ ground: "#111111" });
  });

  it("rejects a malformed hex inside style even when everything else is valid", () => {
    const result = ReviewEditsSchema.safeParse({ caption: "hello", style: { accent: "not-a-hex" } });
    expect(result.success).toBe(false);
  });
});

describe("GateResponseSchema — superRefine unchanged by IGSTYLE-1", () => {
  it("still requires `reason` on reject", () => {
    const result = GateResponseSchema.safeParse({ decision: "reject", actor: "jane", at: new Date().toISOString() });
    expect(result.success).toBe(false);
  });

  it("still requires `feedback` on revise", () => {
    const result = GateResponseSchema.safeParse({ decision: "revise", actor: "jane", at: new Date().toISOString() });
    expect(result.success).toBe(false);
  });

  it("accepts edits.style on approve", () => {
    const result = GateResponseSchema.safeParse({
      decision: "approve",
      actor: "jane",
      at: new Date().toISOString(),
      edits: { style: { ground: "#111111" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts edits.style on revise (feedback supplied) — the split from §2.5", () => {
    const result = GateResponseSchema.safeParse({
      decision: "revise",
      actor: "jane",
      feedback: "make the background darker",
      at: new Date().toISOString(),
      edits: { style: { ground: "#111111" } },
    });
    expect(result.success).toBe(true);
  });
});
