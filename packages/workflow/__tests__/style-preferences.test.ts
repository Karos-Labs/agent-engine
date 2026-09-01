import { describe, expect, it } from "vitest";
import { distillStylePreferences, DEFAULT_HALF_LIFE_DAYS, type FeedbackEntryLike } from "../src/primitives/style-preferences.js";

/**
 * IGSTYLE-4 — durable style memory: distillation. Unit coverage for
 * `distillStylePreferences` in isolation, one named test per voting rule
 * (§3's own acceptance line: "one named test per rule"), independent of the
 * `memory.appendFeedback` schema round-trip (covered in
 * `packages/tools/karos-memory/__tests__/memory.test.ts`) and of any one
 * agent's workflow.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");

function row(overrides: Partial<FeedbackEntryLike> = {}): FeedbackEntryLike {
  return {
    decision: "approve",
    productId: "instagram-agent",
    at: NOW,
    ...overrides,
  };
}

describe("distillStylePreferences (IGSTYLE-4)", () => {
  it("is empty for no entries at all", () => {
    expect(distillStylePreferences([])).toEqual({ overrides: {}, strength: {}, intents: [], evidence: [] });
  });

  it("distills empty without throwing when every entry carries no style data at all", () => {
    const entries: FeedbackEntryLike[] = [row(), row({ decision: "reject" })];
    expect(() => distillStylePreferences(entries, { now: NOW })).not.toThrow();
    expect(distillStylePreferences(entries, { now: NOW })).toEqual({ overrides: {}, strength: {}, intents: [], evidence: [] });
  });

  // Rule 1
  it("rule 1 — never learns from a reject row, even when it is the only evidence for a hex", () => {
    const entries: FeedbackEntryLike[] = [
      row({ decision: "reject", style: { overrides: { ground: "#111111" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.ground).toBeUndefined();
  });

  // Rule 2
  it("rule 2 — ground and fg vote independently, each promoting its own winner", () => {
    const entries: FeedbackEntryLike[] = [
      row({ style: { overrides: { ground: "#111111" }, source: "structured" } }),
      row({ style: { overrides: { fg: "#EEEEEE" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides).toEqual({ ground: "#111111", fg: "#EEEEEE" });
  });

  // Rule 3
  it("rule 3 — a pick exactly one half-life old carries half the weight of one made now", () => {
    const oldEnough: FeedbackEntryLike[] = [
      row({ at: NOW - DEFAULT_HALF_LIFE_DAYS * DAY, style: { overrides: { accent: "#FF0000" }, source: "model" } }),
    ];
    // A lone `model` row (0.5 base weight) at exactly one half-life old has
    // weight 0.5 * 0.5 = 0.25 — well under the 1.0 threshold, so it alone
    // must not promote.
    expect(distillStylePreferences(oldEnough, { now: NOW }).overrides.accent).toBeUndefined();

    // Two structured rows (1.0 base weight each) at one half-life old:
    // combined weight 2 * (1.0 * 0.5) = 1.0 — exactly at the threshold.
    const twoStructuredOld: FeedbackEntryLike[] = [
      row({ at: NOW - DEFAULT_HALF_LIFE_DAYS * DAY, style: { overrides: { accent: "#FF0000" }, source: "structured" } }),
      row({ at: NOW - DEFAULT_HALF_LIFE_DAYS * DAY, style: { overrides: { accent: "#FF0000" }, source: "structured" } }),
    ];
    expect(distillStylePreferences(twoStructuredOld, { now: NOW }).overrides.accent).toBe("#FF0000");
  });

  // Rule 4
  it("rule 4 — one deliberate (structured) pick suffices; one parsed sentence alone does not", () => {
    const oneStructured: FeedbackEntryLike[] = [row({ style: { overrides: { ground: "#202020" }, source: "structured" } })];
    expect(distillStylePreferences(oneStructured, { now: NOW }).overrides.ground).toBe("#202020");

    const oneParsed: FeedbackEntryLike[] = [row({ style: { overrides: { ground: "#202020" }, source: "parsed" } })];
    expect(distillStylePreferences(oneParsed, { now: NOW }).overrides.ground).toBeUndefined();
  });

  // Rule 5
  it("rule 5 — filters by productId before voting, so one product's picks never promote for another's", () => {
    const entries: FeedbackEntryLike[] = [
      row({ productId: "instagram-agent", style: { overrides: { ground: "#111111" }, source: "structured" } }),
      row({ productId: "linkedin-agent", style: { overrides: { ground: "#999999" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW, productId: "instagram-agent" });
    expect(result.overrides.ground).toBe("#111111");
  });

  // Rule 6
  it("rule 6 — bounded to the 50 most-recent qualifying rows even when handed more, decisively changing the winner", () => {
    // "#222222": 60 rows, 10 days old each — individually still weighty
    // (recency ~0.86), and if ALL 60 counted their summed weight (~51) would
    // beat "#111111" outright. "#111111": 45 FRESH rows (weight 45).
    // Sorted newest-first across ALL qualifying rows, the 45 fresh "#111111"
    // rows sort ahead of every "#222222" row, so the 50-row cap keeps all 45
    // of them plus only the 5 newest "#222222" rows (weight ~4.3) — "#111111"
    // wins. If the cap were NOT applied (or applied per-hex instead of
    // globally), "#222222"'s full weight (~51) would win instead.
    const entries: FeedbackEntryLike[] = [
      ...Array.from({ length: 45 }, () => row({ at: NOW, style: { overrides: { ground: "#111111" }, source: "structured" } })),
      ...Array.from({ length: 60 }, () => row({ at: NOW - 10 * DAY, style: { overrides: { ground: "#222222" }, source: "structured" } })),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.ground).toBe("#111111");
  });

  // Rule 7
  it("rule 7 — deterministic: the same now/entries always resolve the same way, ties break newer-first then smaller hex", () => {
    // Two hexes with EQUAL weight (one structured row each, same age) — tie
    // breaks on recency first. Make "#BBBBBB" strictly newer.
    const entries: FeedbackEntryLike[] = [
      row({ at: NOW - DAY, style: { overrides: { ground: "#AAAAAA" }, source: "structured" } }),
      row({ at: NOW, style: { overrides: { ground: "#BBBBBB" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.ground).toBe("#BBBBBB");

    // Fully tied (same age too) — falls through to "smaller hex" (lexicographic).
    const tied: FeedbackEntryLike[] = [
      row({ at: NOW, style: { overrides: { ground: "#BBBBBB" }, source: "structured" } }),
      row({ at: NOW, style: { overrides: { ground: "#AAAAAA" }, source: "structured" } }),
    ];
    expect(distillStylePreferences(tied, { now: NOW }).overrides.ground).toBe("#AAAAAA");

    // Repeatable: calling it again with the same inputs gives the same answer.
    expect(distillStylePreferences(tied, { now: NOW }).overrides.ground).toBe("#AAAAAA");
  });

  // Rule 8
  it("rule 8 — reports strength as winningWeight / totalWeightForRole, not just the winner", () => {
    const entries: FeedbackEntryLike[] = [
      // Winner: two structured picks, weight 2.0.
      row({ style: { overrides: { ground: "#111111" }, source: "structured" } }),
      row({ style: { overrides: { ground: "#111111" }, source: "structured" } }),
      // Runner-up: one structured pick, weight 1.0.
      row({ style: { overrides: { ground: "#222222" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.ground).toBe("#111111");
    // 2.0 / (2.0 + 1.0) = 0.666...
    expect(result.strength.ground).toBeCloseTo(2 / 3, 5);
  });

  // Rule 9
  it("rule 9 — five recent structured rows naming an off-kit colour do not promote it, and evidence says why", () => {
    const entries: FeedbackEntryLike[] = Array.from({ length: 5 }, () =>
      row({
        style: {
          overrides: { fg: "#00FF00" },
          source: "structured",
          applied: ["lime: no kit colour matched, used #00FF00 (not a brand colour)"],
        },
      }),
    );
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.fg).toBeUndefined();
    expect(result.evidence.some((line) => line.includes("fg") && line.toLowerCase().includes("not promoted"))).toBe(true);
    expect(result.evidence.some((line) => line.includes("#00FF00") && line.toLowerCase().includes("not a brand colour"))).toBe(true);
  });

  it("rule 9 — a legal runner-up still promotes once the off-kit leader is discarded", () => {
    const entries: FeedbackEntryLike[] = [
      ...Array.from({ length: 5 }, () =>
        row({
          style: {
            overrides: { fg: "#00FF00" },
            source: "structured",
            applied: ["lime: no kit colour matched, used #00FF00 (not a brand colour)"],
          },
        }),
      ),
      row({ style: { overrides: { fg: "#FFA500" }, source: "structured" } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.fg).toBe("#FFA500");
  });

  // Rule 10
  it("rule 10 — a voted-in intent is returned even when every one of its hexes individually loses", () => {
    // Each row proposes a DIFFERENT literal hex for ground (as `shade()`
    // would against a drifting baseline across runs) but the SAME intent —
    // splitting the hex vote so no single hex clears the threshold on its
    // own (each is a lone `parsed` pick, weight 0.5 < 1.0), while the intent
    // vote (independent, summed across all three) clears it: 3 * 0.5 = 1.5.
    const entries: FeedbackEntryLike[] = [
      row({ style: { overrides: { ground: "#111111" }, source: "parsed", intents: [{ role: "ground", direction: "darker" }] } }),
      row({ style: { overrides: { ground: "#121212" }, source: "parsed", intents: [{ role: "ground", direction: "darker" }] } }),
      row({ style: { overrides: { ground: "#131313" }, source: "parsed", intents: [{ role: "ground", direction: "darker" }] } }),
    ];
    const result = distillStylePreferences(entries, { now: NOW });
    expect(result.overrides.ground).toBeUndefined();
    expect(result.intents).toEqual([{ role: "ground", direction: "darker" }]);
  });

  it("is deterministic given an injected now — no reliance on the system clock", () => {
    const entries: FeedbackEntryLike[] = [row({ style: { overrides: { ground: "#111111" }, source: "structured" } })];
    const first = distillStylePreferences(entries, { now: NOW });
    const second = distillStylePreferences(entries, { now: NOW });
    expect(second).toEqual(first);
  });
});
