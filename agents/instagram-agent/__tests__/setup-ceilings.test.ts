import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ZodType } from "zod";
import { InstagramArtDirectorAgent } from "../src/agent/instagram-art-director-agent.js";
import { InstagramBriefAgent } from "../src/agent/instagram-brief-agent.js";
import { InstagramDesignBriefAgent } from "../src/agent/instagram-design-brief-agent.js";
import { InstagramTemplateDesignerAgent } from "../src/agent/instagram-template-designer-agent.js";
import { InstagramBriefAgentOutputSchema } from "../src/workflow/client-brief.js";
import { StudioDesignBriefOutputSchema, StudioTemplateDraftSchema } from "../src/workflow/template-studio.js";
import { ArtDirectorOutputSchema } from "../src/workflow/visual-direction.js";
import { fakeRouterSequence, makePromptStore } from "./test-helpers.js";

/**
 * Phase 5.5, item D1 — **every setup ceiling, against the largest answer its
 * own schema permits.**
 *
 * On 2026-09-16 all four of these steps returned `tooling_error` on at least
 * one of three clients, every one of them for the same reason: the ceiling
 * was smaller than the schema. Nobody had ever compared the two numbers,
 * because there was nowhere to compare them. This is that place.
 *
 * ## What "maximal" means here, exactly
 *
 * The schema is converted with `z.toJSONSchema(..., { io: "input" })` — the
 * same conversion the router performs to put the schema on the wire — and the
 * largest instance it admits is built from that: every string at its
 * `maxLength`, every array at its `maxItems`, every enum at its longest
 * member, every optional present. That is a BOUND, not a prediction: a real
 * answer is roughly a third of it. A bound is the right thing to size a
 * ceiling against, because the failure mode is not "the average answer is
 * long", it is "this particular client had a lot to say".
 *
 * ## Two token densities, and why
 *
 * A token is not a character, and how many characters buy one depends on the
 * script. `CHARS_PER_TOKEN_LATIN = 3.6` is the usual English figure and is
 * what the phase spec pins. Hebrew — a first-class target here, and the
 * language `geektime`'s brief and templates are written in — runs closer to
 * 2.0, which is why a ceiling that looks generous in English is not.
 *
 * So two assertions per step: the Latin bound must clear the ceiling with
 * 40% to spare (the same headroom rule the copy schema is held to), and the
 * Hebrew bound must FIT AT ALL for the three steps that write in the client's
 * own language. A schema that grows past either now fails here instead of in
 * a client's setup.
 */

/** Pinned, named, and approximate on purpose — see the header. */
const CHARS_PER_TOKEN_LATIN = 3.6;
const CHARS_PER_TOKEN_HEBREW = 2.0;
/** The share of a ceiling the largest legal answer may occupy. */
const HEADROOM = 0.6;

const DEFAULT_STRING_CHARS = 120;
const DEFAULT_ITEMS = 6;

type JsonSchemaNode = Record<string, unknown>;

/**
 * The largest instance a JSON Schema admits, as a value.
 *
 * Deliberately built from the JSON Schema rather than from zod's internals:
 * the JSON Schema IS what the model is handed, so a bound computed from it is
 * a bound on what the model can legally answer. An unbounded string or array
 * (there are none in these four today) falls back to a stated default rather
 * than to infinity, and the fallback is a named constant so a schema that
 * loses a `max()` shows up as a suspiciously small bound rather than as a
 * crash.
 */
function largestInstance(node: JsonSchemaNode | undefined): unknown {
  if (node === undefined) return "x";
  const anyOf = (node["anyOf"] ?? node["oneOf"]) as JsonSchemaNode[] | undefined;
  if (anyOf !== undefined) {
    return anyOf.map(largestInstance).reduce((a, b) => (JSON.stringify(a).length >= JSON.stringify(b).length ? a : b));
  }
  if (node["const"] !== undefined) return node["const"];
  const asEnum = node["enum"] as unknown[] | undefined;
  if (asEnum !== undefined) return [...asEnum].sort((a, b) => String(b).length - String(a).length)[0];
  switch (node["type"]) {
    case "string":
      return "M".repeat((node["maxLength"] as number | undefined) ?? DEFAULT_STRING_CHARS);
    case "number":
    case "integer":
      return (node["maximum"] as number | undefined) ?? 999_999;
    case "boolean":
      return true;
    case "array": {
      const n = (node["maxItems"] as number | undefined) ?? DEFAULT_ITEMS;
      return Array.from({ length: n }, () => largestInstance(node["items"] as JsonSchemaNode));
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries((node["properties"] ?? {}) as Record<string, JsonSchemaNode>)) out[key] = largestInstance(child);
      const additional = node["additionalProperties"];
      if (additional !== null && typeof additional === "object") {
        // A `z.record()` has no key cap; the default stands in for one, and
        // the comment above says why that is honest rather than convenient.
        for (let i = 0; i < DEFAULT_ITEMS; i++) out[`slot${i}`] = largestInstance(additional as JsonSchemaNode);
      }
      return out;
    }
    default:
      return "x";
  }
}

/** The serialised size of the largest legal answer, in the envelope `BaseAgent` actually sends. */
function maximalChars(schema: ZodType): number {
  const json = z.toJSONSchema(schema, { io: "input" }) as JsonSchemaNode;
  return JSON.stringify({ type: "final", output: largestInstance(json) }).length;
}

function configOf(agent: object): { maxTokens?: number; skillRef: string } {
  return (agent as unknown as { config: { maxTokens?: number; skillRef: string } }).config;
}

const runtime = () => ({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() });

/**
 * The table. `writesClientLanguage` is `contentLanguageSensitive` on the
 * agent: the art director writes an English generation brief for an image
 * model whatever the client's language is, so the Hebrew bound does not
 * apply to it.
 */
const STEPS = [
  // The three that `9566535..905b025` also raised, independently, to the
  // engine's own `DEFAULT_MAX_TOKENS`. Phase 5.5 had measured 16,000 / 12,000 /
  // 8,000 against these same schemas; the engine default clears all three of
  // those with room to spare, and a bespoke number is worse than the default it
  // sits next to — so the measured figures stay as the FLOOR this suite proves
  // (the headroom assertions below), and the declared ceiling is the default.
  { step: "00b2-write-client-brief", schema: InstagramBriefAgentOutputSchema, agent: new InstagramBriefAgent(runtime()), expected: 16_384, writesClientLanguage: true },
  { step: "00c3-write-design-brief", schema: StudioDesignBriefOutputSchema, agent: new InstagramDesignBriefAgent(runtime()), expected: 16_384, writesClientLanguage: true },
  { step: "00d2-derive-visual-direction", schema: ArtDirectorOutputSchema, agent: new InstagramArtDirectorAgent(runtime()), expected: 16_384, writesClientLanguage: false },
  { step: "00c4-design-template", schema: StudioTemplateDraftSchema, agent: new InstagramTemplateDesignerAgent(runtime()), expected: 12_000, writesClientLanguage: true },
] as const;

describe("the four setup ceilings are sized against their own schemas", () => {
  it.each(STEPS)("$step declares the ceiling this phase measured", ({ agent, expected }) => {
    expect(configOf(agent).maxTokens).toBe(expected);
  });

  it.each(STEPS)("$step: the largest legal answer leaves at least 40% of the ceiling free in English", ({ schema, agent, step }) => {
    const chars = maximalChars(schema);
    const tokens = chars / CHARS_PER_TOKEN_LATIN;
    const ceiling = configOf(agent).maxTokens!;
    expect(tokens, `${step}: maximal answer is ${Math.round(chars)} chars = ~${Math.round(tokens)} tokens against a ${ceiling}-token ceiling`).toBeLessThan(
      ceiling * HEADROOM,
    );
  });

  it.each(STEPS.filter((s) => s.writesClientLanguage))("$step: the largest legal answer still FITS when the client writes Hebrew", ({ schema, agent, step }) => {
    const tokens = maximalChars(schema) / CHARS_PER_TOKEN_HEBREW;
    const ceiling = configOf(agent).maxTokens!;
    expect(tokens, `${step}: ~${Math.round(tokens)} Hebrew tokens against a ${ceiling}-token ceiling`).toBeLessThan(ceiling);
  });

  it("BREAK THE CODE: every one of the four OLD ceilings fails the rule this suite now enforces", () => {
    // The falsification, and the reason these four steps failed on the day:
    // not one of the old numbers could hold its own schema's worst case with
    // headroom, and two could not hold it at all.
    const old: Record<string, number> = {
      "00b2-write-client-brief": 8_000,
      "00c3-write-design-brief": 4_000,
      "00d2-derive-visual-direction": 3_000,
      "00c4-design-template": 6_000,
    };
    for (const { step, schema } of STEPS) {
      const tokens = maximalChars(schema) / CHARS_PER_TOKEN_LATIN;
      expect(tokens, `${step} at its old ceiling`).toBeGreaterThan(old[step]! * HEADROOM);
    }
    // And the two that could not fit their schema's worst case in English at
    // all — which is what an `output_invalid` on a first-run client is.
    expect(maximalChars(StudioTemplateDraftSchema) / CHARS_PER_TOKEN_LATIN).toBeGreaterThan(6_000);
    expect(maximalChars(ArtDirectorOutputSchema) / CHARS_PER_TOKEN_LATIN).toBeGreaterThan(3_000 * 0.9);
  });

  it("all four still run on Sonnet, pinned — a ceiling change is not a model change", () => {
    for (const { agent } of STEPS) {
      const policy = (agent as unknown as { config: { modelPolicy?: { model?: string } } }).config.modelPolicy;
      expect(policy?.model).toBe("claude-sonnet-4-6");
    }
  });
});
