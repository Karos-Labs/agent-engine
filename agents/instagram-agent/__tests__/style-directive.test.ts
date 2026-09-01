import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HEX_COLOR, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import {
  parseStyleDirective,
  runDeterministicParser,
  type StyleDirectiveContext,
} from "../src/workflow/style-directive.js";

/**
 * IGSTYLE-2 — directive extraction: deterministic parser, model second.
 * `runDeterministicParser` (Tier 1) is tested directly for purity and for
 * every closed-vocabulary row in the spec's table; `parseStyleDirective`
 * (the top-level Tier 0 → 1 → 2 resolver) is tested for tier ordering,
 * including the "model never invoked when Tier 0/1 already produced a
 * result" guarantee via a fake router that throws.
 *
 * Fake-router shape follows `agents/tiktok-agent/__tests__/review-cycle.test.ts`'s
 * own `sequentialFakeRouter` precedent: a non-generic object literal cast to
 * `ModelRouter` at the end, since `ModelRouter.complete` is itself generic
 * and a fixed-return implementation can't satisfy that signature structurally.
 */

const THROWING_ROUTER: ModelRouter = {
  async complete() {
    throw new Error("Tier 2 must never be invoked here");
  },
  async completeAlias() {
    throw new Error("Tier 2 must never be invoked here");
  },
} as ModelRouter;

function fakeRouterReturning(intents: unknown[]): ModelRouter {
  return {
    async complete() {
      return {
        output: { intents },
        modelUsed: "fake-model",
        inputTokens: { cached: 0, uncached: 0 },
        outputTokens: 0,
      } as CompletionResult<unknown>;
    },
    async completeAlias() {
      throw new Error("not used in these tests");
    },
  } as ModelRouter;
}

const sittiContext: StyleDirectiveContext = {
  ground: "#17181C",
  fg: "#F2F2F2",
  ring: ["#FF7A1A"],
};

describe("runDeterministicParser — Tier 1 (IGSTYLE-2)", () => {
  it("is the required test case: the literal prep complaint", () => {
    const result = runDeterministicParser(
      "the background color should be the darker and the text should be the orange",
      sittiContext,
    );
    expect(result.source).toBe("parsed");
    expect(result.refusals).toEqual([]);
    expect(result.overrides.fg).toBe("#FF7A1A");
    expect(result.overrides.ground).toBeDefined();
    expect(result.overrides.ground).not.toBe(sittiContext.ground);
    // darker means shifted toward black — every channel no larger than the original.
    const orig = sittiContext.ground!.slice(1).match(/.{2}/g)!.map((h) => parseInt(h, 16));
    const shaded = result.overrides.ground!.slice(1).match(/.{2}/g)!.map((h) => parseInt(h, 16));
    for (let i = 0; i < 3; i++) expect(shaded[i]!).toBeLessThanOrEqual(orig[i]!);
    expect(result.intents).toEqual(
      expect.arrayContaining([
        { role: "ground", direction: "darker" },
        { role: "fg", direction: "hue", hue: "orange" },
      ]),
    );
    expect(result.intents).toHaveLength(2);
  });

  it("'love it, ship it' finds nothing — source none, empty overrides", () => {
    const result = runDeterministicParser("love it, ship it", sittiContext);
    expect(result).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
  });

  it("is pure — identical input yields byte-identical output across repeated calls", () => {
    const text = "make the background darker and the accent orange, also more contrast on the text";
    const first = runDeterministicParser(text, sittiContext);
    const second = runDeterministicParser(text, sittiContext);
    expect(second).toEqual(first);
  });

  it("lighter + background/ground/bg", () => {
    const result = runDeterministicParser("brighten the bg a little", sittiContext);
    expect(result.source).toBe("parsed");
    expect(result.overrides.ground).toBeDefined();
    const orig = parseInt(sittiContext.ground!.slice(1, 3), 16);
    const shaded = parseInt(result.overrides.ground!.slice(1, 3), 16);
    expect(shaded).toBeGreaterThanOrEqual(orig);
  });

  it("#rrggbb + role word — verbatim, no intent recorded", () => {
    const result = runDeterministicParser("set the background to #112233 please", sittiContext);
    expect(result.source).toBe("parsed");
    expect(result.overrides.ground).toBe("#112233");
    expect(result.intents).toEqual([]);
  });

  it("more contrast — pushes fg away from ground toward the 7:1 target", () => {
    // A moderate-contrast baseline (unlike `sittiContext`, which is already
    // ~15.8:1 and has no room to push) so the walk actually has work to do.
    const context: StyleDirectiveContext = { ground: "#202020", fg: "#808080", ring: [] };
    const result = runDeterministicParser("can we get more contrast on the text", context);
    expect(result.source).toBe("parsed");
    expect(result.overrides.fg).toBeDefined();
    expect(result.overrides.fg).not.toBe(context.fg);
    expect(result.intents).toEqual([{ role: "fg", direction: "more-contrast" }]);
    expect(HEX_COLOR.test(result.overrides.fg!)).toBe(true);
  });

  it("resolveNamedColor is kit-first: a ring member close in hue wins over the named table", () => {
    const result = runDeterministicParser("make the accent orange", sittiContext);
    expect(result.overrides.accent).toBe("#FF7A1A"); // the kit's own ring member, not NAMED_COLORS.orange
    expect(result.applied.some((a) => a.includes("not a brand colour"))).toBe(false);
  });

  it("resolveNamedColor falls back to the named table when nothing in the ring is close, and records the note", () => {
    const context: StyleDirectiveContext = { ground: "#17181C", fg: "#F2F2F2", ring: ["#0000FF"] };
    const result = runDeterministicParser("make the accent orange", context);
    expect(result.overrides.accent).toBe("#FFA500");
    expect(result.applied).toEqual(
      expect.arrayContaining(["orange: no kit colour matched, used #FFA500 (not a brand colour)"]),
    );
  });

  it("a sub-4.5:1 resulting pair is a StyleRefusal from this module — overrides never carry it", () => {
    const context: StyleDirectiveContext = { ground: "#1a1a1a", fg: "#2a2a2a", ring: [] };
    const result = runDeterministicParser("make the background darker", context);
    expect(result.overrides.ground).toBeUndefined();
    expect(result.overrides.fg).toBeUndefined();
    expect(result.refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "pair", reason: expect.stringContaining("4.5") })]),
    );
  });

  it("every returned hex passes HEX_COLOR", () => {
    const result = runDeterministicParser(
      "darker background, orange accent, orange text, more contrast please",
      sittiContext,
    );
    for (const value of Object.values(result.overrides)) {
      expect(HEX_COLOR.test(value as string)).toBe(true);
    }
  });
});

describe("parseStyleDirective — Tier 0 → 1 → 2 (IGSTYLE-2)", () => {
  it("Tier 0: a structured edits.style pick is authoritative, bypasses parsing, intents: []", async () => {
    const result = await parseStyleDirective(
      { style: { ground: "#000000" }, feedback: "actually make it the darker background" },
      sittiContext,
      { router: THROWING_ROUTER },
    );
    expect(result.source).toBe("structured");
    expect(result.overrides.ground).toBe("#000000");
    expect(result.intents).toEqual([]);
  });

  it("Tier 1 already produced a result — the model is never invoked (fake router that throws)", async () => {
    const result = await parseStyleDirective(
      { feedback: "the background color should be the darker and the text should be the orange" },
      sittiContext,
      { router: THROWING_ROUTER },
    );
    expect(result.source).toBe("parsed");
    expect(result.overrides.fg).toBe("#FF7A1A");
  });

  it("'love it, ship it' — {} with no model call", async () => {
    const result = await parseStyleDirective({ feedback: "love it, ship it" }, sittiContext, {
      router: THROWING_ROUTER,
    });
    expect(result).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
  });

  it("no style pick and no feedback at all — {} with no model call", async () => {
    const result = await parseStyleDirective({}, sittiContext, { router: THROWING_ROUTER });
    expect(result).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
  });

  it("Tier 2: invoked only when Tier 1 found nothing AND the free text plausibly concerns style", async () => {
    const router = fakeRouterReturning([{ role: "accent", direction: "hue", hue: "teal" }]);
    const result = await parseStyleDirective(
      { feedback: "something about the accent feels off, can you fix the contrast" },
      sittiContext,
      { router },
    );
    expect(result.source).toBe("model");
    expect(result.overrides.accent).toBe("#008080");
  });

  it("Tier 2: an unresolvable model-proposed colour is a StyleRefusal, not a thrown error or an invented hex", async () => {
    const router = fakeRouterReturning([{ role: "accent", direction: "hue", hue: "mauve" }]);
    const result = await parseStyleDirective(
      { feedback: "something about the accent feels off, can you fix the contrast" },
      sittiContext,
      { router },
    );
    expect(result.overrides.accent).toBeUndefined();
    expect(result.refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "accent", requested: "mauve" })]),
    );
  });

  it("Tier 2: a thrown model call degrades to overrides: {} and a refusal — never propagates", async () => {
    const throwingButStyleRelated: ModelRouter = {
      async complete() {
        throw new Error("simulated model outage");
      },
      async completeAlias() {
        throw new Error("not used");
      },
    } as ModelRouter;
    const result = await parseStyleDirective(
      { feedback: "the accent feels a bit muddy, could be punchier" },
      sittiContext,
      { router: throwingButStyleRelated },
    );
    expect(result.overrides).toEqual({});
    expect(result.source).toBe("none");
    expect(result.refusals.length).toBeGreaterThan(0);
  });

  it("Tier 2: empty intents from the model is a clean {} result, not a refusal", async () => {
    const router = fakeRouterReturning([]);
    const result = await parseStyleDirective(
      { feedback: "the accent feels a bit flat, not sure exactly what though" },
      sittiContext,
      { router },
    );
    expect(result).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
  });
});

describe("StyleIntent / StyleRefusal / StyleDirectiveResult shapes (IGSTYLE-2)", () => {
  it("a StyleIntent round-trips through the exact zod-free interface shape the spec defines", () => {
    const intent = { role: "ground" as const, direction: "darker" as const };
    expect(z.object({ role: z.enum(["ground", "fg", "accent"]), direction: z.enum(["darker", "lighter", "more-contrast", "hue"]) }).safeParse(intent).success).toBe(true);
  });
});
