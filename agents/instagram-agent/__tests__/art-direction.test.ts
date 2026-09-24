import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ART_DIRECTOR_SKILL_REF, InstagramArtDirectorAgent } from "../src/agent/instagram-art-director-agent.js";
import type { BrandTokens } from "../src/workflow/types.js";
import { GenerateImageInputSchema } from "@agent-engine/tool-karos-media";
import { buildArtDirection, checkVisualDirection, CLICHE_SCENE_FORBID, IMAGE_FORBID_MAX, mergeForbid, prescribesClicheScene, VISUAL_DIRECTION_BELIEF_KEY, type VisualDirection } from "../src/workflow/visual-direction.js";

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

    // 2026-09-23: the direction's SUBJECT never reaches generation (the slide's
    // brief carries the subject); the brand token is the aesthetic.
    expect(art["aesthetic"]).toBe("minimal product photography");
    expect(art["lighting"]).toBe("soft window light from one side, no fill");
    expect(art["palette"]).toEqual(["warm charcoal", "paper white"]);
    expect(art["mood"]).toBe("35mm, shallow depth of field, fine grain");
    // Every line, joined: `notes` is the field `buildBrief` appends verbatim,
    // and the lines ARE the direction.
    // "at the desk where it happens" names the cliché scene (2026-09-23) and is dropped.
    expect(art["notes"]).not.toContain("Photograph the work itself");
    expect(art["notes"]).toContain("Soft window light");
    expect(art["notes"]).toContain("One subject per frame");
    expect(art["forbid"]).toEqual(["stock handshakes", "glass-tower skylines", ...CLICHE_SCENE_FORBID]);
    expect(art["styleLock"]).toBe("Warm documentary photography, one subject, soft single-source light, no composite.");
  });

  it("drops every line, light and style lock that prescribes the feed's cliché scene (the karoslabs direction of 2026-09-18)", () => {
    const karos = direction({
      light: ["Cool blue-grey screen glow from front-left as the primary source", "Deep falloff into the ground colour"],
      lines: [
        { line: "Scene ground is near-black; all imagery sits inside this tone.", basis: "brand kit", confidence: "high" },
        { line: "Show one person at work alone, a founder mid-task at a laptop in a dim room.", basis: "https://instagram.com/p/x", confidence: "medium" },
        { line: "Wide aperture: the subject (person or hands on keyboard) is sharp.", basis: "https://instagram.com/p/y", confidence: "medium" },
        { line: "Fine grain, moderate contrast, selective desaturation.", basis: "brand kit", confidence: "high" },
      ],
      styleLock: { id: "night-operator-35mm", line: "Cinematic 35 mm, near-black ground, cool screen-glow primary with one warm practical, fine grain." },
    });
    const art = buildArtDirection(KIT, karos)!;
    expect(art["lighting"]).toBe("Deep falloff into the ground colour");
    expect(String(art["notes"])).toContain("near-black");
    expect(String(art["notes"])).toContain("Fine grain");
    expect(String(art["notes"])).not.toMatch(/laptop|keyboard/iu);
    expect(art["styleLock"]).toBeUndefined();
    // The premise: every dropped string does name the scene, and the kept ones do not.
    expect(prescribesClicheScene(karos.lines[1]!.line)).toBe(true);
    expect(prescribesClicheScene(karos.lines[2]!.line)).toBe(true);
    expect(prescribesClicheScene(karos.styleLock.line)).toBe(true);
    expect(prescribesClicheScene(karos.lines[0]!.line)).toBe(false);
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
    // "at the desk where it happens" names the cliché scene (2026-09-23) and is dropped.
    expect(art["notes"]).not.toContain("Photograph the work itself");
    expect(art["notes"]).toContain("Soft window light");
    expect(art["forbid"]).toHaveLength(2 + CLICHE_SCENE_FORBID.length);
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

    // Every CALL SITE of the tool: the rescue tier's `tool:` literal and, since
    // 2026-09-24, the product campaign's `.execute(` (stage 4). A presence
    // check (`=== undefined`) builds no arguments and is not a call site.
    const sites: number[] = [];
    for (let at = source.indexOf('tools["image.generate"]'); at !== -1; at = source.indexOf('tools["image.generate"]', at + 1)) {
      const after = source.slice(at + 'tools["image.generate"]'.length, at + 'tools["image.generate"]'.length + 24);
      if (/^\s*===\s*undefined/.test(after)) continue;
      sites.push(at);
    }
    expect(sites.length).toBeGreaterThan(0);
    for (const at of sites) {
      // The literal that follows the tool lookup. Scanned rather than
      // executed because the alternative — driving the whole rescue path — is
      // a Chromium-gated end-to-end run, and what is actually at risk here is
      // someone deleting one property from an object literal.
      const call = source.slice(at, at + 1_200);
      // Integrated form (Phase 3): the direction builds the object and the
      // run's FROZEN style lock (item S) is spread over it, so a later attempt
      // cannot hand the generator a different style from the first one. The
      // old `art: artDirectionFor(` / `art: buildArtDirection(` shapes still
      // match — what this pin is actually protecting is that SOME art object
      // reaches every `image.generate` call, never that it is built one
      // particular way.
      expect(call).toMatch(/art:\s*(\{\s*\.\.\.)?(artDirectionFor|buildArtDirection)\(/);
    }

    // And the call sites are exactly the two known ones, so a third cannot
    // arrive without this scan being extended to see it.
    expect(sites).toHaveLength(2);
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
    // 16_384, not the 3_000 this asserted until 2026-09-16: that ceiling
    // truncated the direction on both prep runs of that morning and sent both
    // clients to `fallbackVisualDirection` for a quarter, because the marker
    // each failure wrote then suppressed the retry for seven days.
    // `setup-ceilings.test.ts` measures the maximal instance the schema permits
    // (~10,100 characters, ~2,795 tokens = 93% of the old ceiling).
    expect(config.maxTokens).toBe(16_384);
    // PHASE 5.5 (item C/D): @1 -> @2. The director now also derives the six
    // frozen axes of `ClientVisualSystem` — the per-client half of the visual
    // system, which is what stops two clients' posts reading as one machine's
    // output. The ceiling does NOT move with it: the axes are six enums and
    // six short sentences, about 900 characters at their maximum, inside the
    // headroom the ten lines already bought.
    expect(config.skillRef).toBe("instagram-art-director@3");
    // No Opus in a run or a setup, per the owner's standing rule.
    expect(JSON.stringify(config.modelPolicy)).toContain("claude-sonnet-4-6");
    expect(JSON.stringify(config.modelPolicy)).not.toContain("opus");
  });

  it("is NOT contentLanguageSensitive — its output is an English brief for an image model, never client-facing copy", () => {
    const source = readFileSync(path.join(HERE, "..", "src", "agent", "instagram-art-director-agent.ts"), "utf8");

    expect(source).toContain("contentLanguageSensitive: false");
  });
});


describe("a stored direction that prescribes the cliché heals itself (2026-09-23)", () => {
  const NOW = new Date("2026-09-23T22:00:00.000Z");
  const fresh = "2026-09-18T11:24:45.766Z";
  const cliche = direction({ generatedAt: fresh, generatedBy: "instagram-art-director@2", subject: ["A founder alone at a cluttered desk, focused on a laptop screen"] });
  const beliefs = (d: VisualDirection) => ({ [VISUAL_DIRECTION_BELIEF_KEY]: d });

  it("re-derives a pre-v3 direction that prescribes the scene, however fresh", () => {
    expect(checkVisualDirection(beliefs(cliche), { now: NOW, allowDerive: true }).action).toBe("derive");
  });

  it("never re-derives a v3 direction for this reason, so it cannot loop", () => {
    expect(checkVisualDirection(beliefs({ ...cliche, generatedBy: "instagram-art-director@3" }), { now: NOW, allowDerive: true }).action).toBe("reuse");
  });

  it("reuses a clean pre-v3 direction inside its TTL (the premise), and respects allowDerive", () => {
    const clean = direction({ generatedAt: fresh, generatedBy: "instagram-art-director@2", subject: ["practitioners at work in a clinic"], lines: [{ line: "Photograph the work where it happens, never posed.", basis: "https://instagram.com/p/abc", confidence: "high" }, ...direction().lines.slice(1)] });
    expect(checkVisualDirection(beliefs(clean), { now: NOW, allowDerive: true }).action).toBe("reuse");
    expect(checkVisualDirection(beliefs(cliche), { now: NOW, allowDerive: false }).action).toBe("reuse");
  });
});

describe("the cliché scrubber reads negation, and a direction records who wrote it (2026-09-23)", () => {
  it("keeps lines that BAN the scene, and still drops the ones that ask for it", () => {
    // The first v3 direction for karoslabs, verbatim where it matters.
    expect(prescribesClicheScene("One warm directional source off-axis; no fill, no ring, no screen glow.")).toBe(false);
    expect(prescribesClicheScene("Close detail of hands mid-gesture, turning a page, pausing, never touching a keyboard")).toBe(false);
    expect(prescribesClicheScene("Available light only, no studio flash, no ring light, no illuminated screen as a source")).toBe(false);
    expect(prescribesClicheScene("Show one person at work alone, a founder mid-task at a laptop in a dim room.")).toBe(true);
    expect(prescribesClicheScene("Cool blue-grey screen glow from front-left as the primary source")).toBe(true);
  });

  it("records the art director version that wrote a direction, the same one its agent pins", () => {
    const agent = new InstagramArtDirectorAgent({ router: {} as never, tools: {}, promptStore: {} as never });
    expect((agent as unknown as { config: { skillRef: string } }).config.skillRef).toBe(ART_DIRECTOR_SKILL_REF);
    expect(readFileSync(WORKFLOW_SOURCE, "utf8")).toContain("generatedBy: ART_DIRECTOR_SKILL_REF");
    expect(readFileSync(WORKFLOW_SOURCE, "utf8")).not.toContain('generatedBy: "instagram-art-director@1"');
  });
});

describe("the forbid list always fits image.generate (2026-09-24)", () => {
  it("a direction with a full forbid list still produces an art block the tool accepts, with nothing dropped", () => {
    const own = Array.from({ length: 10 }, (_, i) => `client negative ${i + 1}`);
    const merged = mergeForbid(own);
    expect(merged.length).toBeLessThanOrEqual(IMAGE_FORBID_MAX);
    for (const scene of CLICHE_SCENE_FORBID) expect(merged.join(" | ")).toContain(scene);
    const parsed = GenerateImageInputSchema.shape.art.safeParse({ forbid: merged });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("leaves a short list exactly as before", () => {
    expect(mergeForbid(["logos"])).toEqual(["logos", ...CLICHE_SCENE_FORBID]);
  });
});
