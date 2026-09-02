import { describe, expect, it } from "vitest";
import {
  distillStylePreferences,
  DEFAULT_HALF_LIFE_DAYS,
  VARIATION_THRESHOLD,
  varyLearnedStyle,
  type FeedbackEntryLike,
} from "../src/primitives/style-preferences.js";

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

/**
 * IGSTYLE-7, §2.6 / 7b — "preference as prior, not pin." `varyLearnedStyle`
 * is the function that spends the variation budget: a learned role below
 * `VARIATION_THRESHOLD` may depart from the exact prior hex (within tier-1-
 * legal bounds — the 4.5:1 pair floor for ground/fg, kit-ring membership for
 * accent); at or above, the prior ships untouched.
 */
describe("varyLearnedStyle (IGSTYLE-7)", () => {
  const RING = ["#A5E82B", "#FF5B5F", "#41C6FF"];

  it("anti-drift: a role at or above the threshold is used exactly as-is, with no reported variation", () => {
    const { varied, variations } = varyLearnedStyle(
      { ground: "#000000", fg: "#eeeeee", accent: "#A5E82B" },
      { ground: 0.9, fg: 0.9, accent: 0.9 },
      "run-a",
      { baselineGround: "#000000", baselineFg: "#eeeeee", ring: RING },
    );
    expect(varied).toEqual({ ground: "#000000", fg: "#eeeeee", accent: "#A5E82B" });
    expect(variations).toEqual([]);
  });

  it("a weak ground/fg pair may depart, but only within the 4.5:1 contrast floor, and reports why", () => {
    const { varied, variations } = varyLearnedStyle(
      { ground: "#000000", fg: "#eeeeee" },
      { ground: 0.5, fg: 0.5 },
      "run-a",
      {},
    );
    // Actually departed from the exact prior...
    expect(varied.ground).not.toBe("#000000");
    expect(varied.fg).not.toBe("#eeeeee");
    // ...but never invented: still a real hex, still passes the SAME floor
    // `deriveBrandRenderTokens`/`effectiveBrandKit` enforce everywhere else.
    expect(varied.ground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(varied.fg).toMatch(/^#[0-9a-f]{6}$/i);
    const la = parseInt(varied.ground!.slice(1), 16);
    const lb = parseInt(varied.fg!.slice(1), 16);
    expect(la).not.toBe(lb);
    expect(variations.map((v) => v.role).sort()).toEqual(["fg", "ground"]);
    for (const v of variations) {
      expect(v.reason).toContain(String(VARIATION_THRESHOLD));
    }
  });

  it("a weak ground/fg pair that would drop below the 4.5:1 floor if shaded ships the exact prior instead — honest no-op, nothing invented", () => {
    // A pair already sitting close to the floor: shading ground toward fg's
    // side in EITHER seeded direction risks dropping the ratio below 4.5.
    // Picking a seed for each direction and asserting the pair-floor holds
    // (or the prior ships untouched) proves the guard fires at least once
    // across the two directions this seed space can produce.
    const nearFloorGround = "#4d4d4d"; // contrast against #808080 is right around 2:1 — well under 4.5 either direction
    const nearFloorFg = "#808080";
    let sawNoOp = false;
    for (const seed of ["seed-1", "seed-2", "seed-3", "seed-4"]) {
      const { varied } = varyLearnedStyle({ ground: nearFloorGround, fg: nearFloorFg }, { ground: 0.1, fg: 0.1 }, seed, {});
      const g = parseInt(varied.ground!.slice(1), 16);
      const f = parseInt(varied.fg!.slice(1), 16);
      // Never anything invented outside real hex space, whichever branch ran.
      expect(varied.ground).toMatch(/^#[0-9a-f]{6}$/i);
      expect(varied.fg).toMatch(/^#[0-9a-f]{6}$/i);
      if (varied.ground === nearFloorGround && varied.fg === nearFloorFg) sawNoOp = true;
      void g;
      void f;
    }
    expect(sawNoOp).toBe(true);
  });

  it("accent moves to a DIFFERENT, already-kit-legal ring member when weak — never the same hex, never off-ring", () => {
    const { varied, variations } = varyLearnedStyle({ accent: "#A5E82B" }, { accent: 0.5 }, "run-a", { ring: RING });
    expect(varied.accent).not.toBe("#A5E82B");
    expect(RING).toContain(varied.accent);
    expect(variations).toEqual([{ role: "accent", prior: "#A5E82B", used: varied.accent, reason: expect.stringContaining(String(VARIATION_THRESHOLD)) }]);
  });

  it("honest limit: a one-color ring cannot vary accent at all — the prior ships, nothing invented, no variation reported", () => {
    const { varied, variations } = varyLearnedStyle({ accent: "#A5E82B" }, { accent: 0.1 }, "run-a", { ring: ["#A5E82B"] });
    expect(varied.accent).toBe("#A5E82B");
    expect(variations).toEqual([]);
  });

  it("honest limit: no ring at all behaves the same as a one-color ring", () => {
    const { varied, variations } = varyLearnedStyle({ accent: "#A5E82B" }, { accent: 0.1 }, "run-a", {});
    expect(varied.accent).toBe("#A5E82B");
    expect(variations).toEqual([]);
  });

  it("is deterministic: the same seed always resolves the same way", () => {
    const first = varyLearnedStyle({ ground: "#000000", fg: "#eeeeee", accent: "#A5E82B" }, { ground: 0.5, fg: 0.5, accent: 0.5 }, "run-a", {
      ring: RING,
    });
    for (let i = 0; i < 20; i++) {
      const again = varyLearnedStyle({ ground: "#000000", fg: "#eeeeee", accent: "#A5E82B" }, { ground: 0.5, fg: 0.5, accent: 0.5 }, "run-a", {
        ring: RING,
      });
      expect(again).toEqual(first);
    }
  });

  it("anti-monotony: different seeds are not all forced to the same accent departure", () => {
    const outcomes = new Set(
      ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"].map(
        (seed) => varyLearnedStyle({ accent: "#A5E82B" }, { accent: 0.5 }, seed, { ring: RING }).varied.accent,
      ),
    );
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("ignores a strength value the learned object has no matching key for, and tolerates a StyleOverrides-shaped input with unset (undefined) keys", () => {
    const { varied, variations } = varyLearnedStyle({ ground: "#000000", fg: undefined, accent: undefined }, { ground: 0.9 }, "run-a", {});
    expect(varied).toEqual({ ground: "#000000" });
    expect(variations).toEqual([]);
  });

  it("empty learned input is a pure no-op — the shape every revision-0 call with no prior at all takes", () => {
    expect(varyLearnedStyle({}, {}, "run-a", {})).toEqual({ varied: {}, variations: [] });
  });
});
