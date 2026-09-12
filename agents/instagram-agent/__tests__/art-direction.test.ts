import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { InstagramArtDirectorAgent } from "../src/agent/instagram-art-director-agent.js";
import type { BrandTokens } from "../src/workflow/types.js";
import { buildArtDirection, type VisualDirection } from "../src/workflow/visual-direction.js";

/**
 * RFC-13 Phase 3, item Q — the half that finally reads the direction.
 *
 * `artDirectionFor(tokens)` built the `art` object `image.generate` takes out
 * of four optional `BrandTokens` fields, all of which are unset for every
 * client in the fleet — so it returned `undefined`, and `buildBrief` fell
 * through to `"Style: realistic photography, natural lighting, clean
 * composition."` for every generated image of every client. `buildArtDirection`
 * is that function widened by one argument and lifted out of the 6800-line
 * workflow file so it can be tested at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_SOURCE = path.join(HERE, "..", "src", "workflow", "create-instagram-agent-workflow.ts");

const KIT: BrandTokens = {
  templateDir: "agents/instagram-agent/assets/templates/default",
  slideTemplate: "slide.html",
  accentColor: "#ff6b2c",
  aesthetic: "minimal product photography",
  lighting: "hard directional studio light",
  palette: ["slate", "bone"],
  visualMood: "urgent",
};

const BARE_KIT: BrandTokens = { templateDir: "agents/instagram-agent/assets/templates/default", slideTemplate: "slide.html" };

function direction(overrides: Partial<VisualDirection> = {}): VisualDirection {
  return {
    version: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    generatedBy: "instagram-art-director@1",
    subject: ["a laptop on a kitchen table before the office opens", "hands on a keyboard"],
    light: ["soft window light from one side, no fill"],
    palette: ["warm charcoal", "paper white"],
    treatment: ["35mm, shallow depth of field, fine grain"],
    forbid: ["stock handshakes", "glass-tower skylines"],
    lines: [
      { line: "Photograph the work itself, at the desk where it happens.", basis: "https://instagram.com/p/abc", confidence: "high" },
      { line: "Soft window light from one side, never a ring light.", basis: "https://instagram.com/p/def", confidence: "high" },
      { line: "Keep the frame inside warm charcoal and paper white.", basis: "brand kit: palette", confidence: "medium" },
      { line: "One subject per frame, shallow depth of field.", basis: "https://karoslabs.com/work", confidence: "medium" },
    ],
    styleLock: { id: "warm-documentary", line: "Warm documentary photography, one subject, soft single-source light, no composite." },
    source: "patterns+brand",
    gaps: [],
    ...overrides,
  };
}

describe("buildArtDirection", () => {
  it("returns the direction's own lines, forbid list and style lock", () => {
    const art = buildArtDirection(KIT, direction())!;

    expect(art["aesthetic"]).toBe("a laptop on a kitchen table before the office opens");
    expect(art["lighting"]).toBe("soft window light from one side, no fill");
    expect(art["palette"]).toEqual(["warm charcoal", "paper white"]);
    expect(art["mood"]).toBe("35mm, shallow depth of field, fine grain");
    // Every line, joined: `notes` is the field `buildBrief` appends verbatim,
    // and the lines ARE the direction.
    expect(art["notes"]).toContain("Photograph the work itself");
    expect(art["notes"]).toContain("One subject per frame");
    expect(art["forbid"]).toEqual(["stock handshakes", "glass-tower skylines"]);
    expect(art["styleLock"]).toBe("Warm documentary photography, one subject, soft single-source light, no composite.");
  });

  it("keeps the BRAND's accent colour even when a direction exists — that is a fact, not an opinion", () => {
    // The accent is the hex the slide's own chrome is drawn in. A generated
    // image whose accent object is a different orange from the template's
    // accent rule reads as a mistake rather than as a choice.
    expect(buildArtDirection(KIT, direction())!["accentColor"]).toBe("#ff6b2c");
    expect(buildArtDirection(BARE_KIT, direction())!["accentColor"]).toBeUndefined();
  });

  it("falls back to the brand token per field, so a direction that is silent on one axis does not erase it", () => {
    const art = buildArtDirection(KIT, direction({ subject: [], light: [], palette: [], treatment: [] }))!;

    expect(art["aesthetic"]).toBe("minimal product photography");
    expect(art["lighting"]).toBe("hard directional studio light");
    expect(art["palette"]).toEqual(["slate", "bone"]);
    expect(art["mood"]).toBe("urgent");
    // The lines and the forbid list survive regardless — they are not an axis.
    expect(art["notes"]).toContain("Photograph the work itself");
    expect(art["forbid"]).toHaveLength(2);
  });

  it("is byte-identical to the old artDirectionFor(tokens) when no direction exists", () => {
    // The regression that matters for every non-Instagram consumer and for a
    // resumed run checkpointed before this change.
    expect(buildArtDirection(KIT)).toEqual({
      aesthetic: "minimal product photography",
      lighting: "hard directional studio light",
      palette: ["slate", "bone"],
      accentColor: "#ff6b2c",
      mood: "urgent",
    });
  });

  it("returns undefined only when neither the direction nor the kit has anything to say", () => {
    expect(buildArtDirection(BARE_KIT)).toBeUndefined();
    expect(buildArtDirection(undefined)).toBeUndefined();
    // One token is enough to stop being undefined, exactly as before.
    expect(buildArtDirection({ ...BARE_KIT, lighting: "overcast" })).toEqual({ lighting: "overcast" });
  });
});

describe("the workflow never calls image.generate without art direction", () => {
  it("source-pins the generate rescue tier's buildArgs to an art object", () => {
    const source = readFileSync(WORKFLOW_SOURCE, "utf8");

    const at = source.indexOf('tools["image.generate"]');
    expect(at).toBeGreaterThan(-1);
    // The tier literal that follows the tool lookup. Scanned rather than
    // executed because the alternative — driving the whole rescue path — is a
    // Chromium-gated end-to-end run, and what is actually at risk here is
    // someone deleting one property from an object literal.
    const tier = source.slice(at, at + 1_200);
    // Integrated form (Phase 3): the direction builds the object and the run's
    // FROZEN style lock (item S) is spread over it, so a later attempt cannot
    // hand the generator a different style from the first one. The old
    // `art: artDirectionFor(` / `art: buildArtDirection(` shapes still match —
    // what this pin is actually protecting is that SOME art object reaches
    // every `image.generate` call, never that it is built one particular way.
    expect(tier).toMatch(/art:\s*(\{\s*\.\.\.)?(artDirectionFor|buildArtDirection)\(/);

    // And there is exactly one place that builds generation arguments, so the
    // scan above cannot be passing while a second call site goes unchecked.
    expect(source.split('tools["image.generate"]')).toHaveLength(2);
  });
});

describe("InstagramArtDirectorAgent", () => {
  it("is a pinned Sonnet one-call step with no tools, on the setup budget", () => {
    const config = (new InstagramArtDirectorAgent({ router: {} as never, tools: {}, promptStore: {} as never }) as unknown as {
      config: { id: string; allowedTools: string[]; maxSteps: number; maxTokens: number; skillRef: string; modelPolicy: unknown };
    }).config;

    expect(config.id).toBe("instagram-art-director");
    // Every source is hand-assembled by `buildVisualDirectionInput`, which is
    // what makes this a fixed one-call bill rather than a research loop.
    expect(config.allowedTools).toEqual([]);
    expect(config.maxSteps).toBe(1);
    expect(config.maxTokens).toBe(3_000);
    expect(config.skillRef).toBe("instagram-art-director@1");
    // No Opus in a run or a setup, per the owner's standing rule.
    expect(JSON.stringify(config.modelPolicy)).toContain("claude-sonnet-4-6");
    expect(JSON.stringify(config.modelPolicy)).not.toContain("opus");
  });

  it("is NOT contentLanguageSensitive — its output is an English brief for an image model, never client-facing copy", () => {
    const source = readFileSync(path.join(HERE, "..", "src", "agent", "instagram-art-director-agent.ts"), "utf8");

    expect(source).toContain("contentLanguageSensitive: false");
  });
});
