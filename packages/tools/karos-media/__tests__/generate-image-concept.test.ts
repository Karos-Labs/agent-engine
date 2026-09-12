import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKarosMediaTools, type ImageGenerationClient } from "../src/index.js";

/**
 * RFC-16 §5.3 — `image.generate` 1.1.0 → 1.2.0: `art.permittedMarks` and
 * `art.permittedFigures`.
 *
 * ## The assertion this file exists for
 *
 * "buildBrief is BYTE-IDENTICAL to 1.1.0 when no permit names anything." That
 * is not a formality — it is the shipped behaviour of the ENTIRE FLEET. No
 * client has a `generatedLikeness` consent record, so every run of every agent
 * that calls this tool takes the no-permit path, and a drift in that path is a
 * fleet-wide prompt change nobody asked for. It is written as an exact string
 * comparison rather than a set of `toContain`s because "byte-identical" is the
 * claim, following the precedent `generate-image.test.ts` set for 1.1.0.
 *
 * ## And the one that keeps the capability narrow
 *
 * A permitted mark widens exactly one clause — `no logos` — into the badge
 * framing. It must not touch `no text, no words, no lettering, no numbers`: a
 * wordmark IS lettering, and a permission to depict a brand is not a
 * permission to render type into the pixels the template is about to draw the
 * real headline over.
 *
 * Both were written by breaking the code first; see the `// break it` notes.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-gen-concept-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const imageResponse = () => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: PNG_B64, mimeType: "image/png" } }] } }],
});

function recordingTool() {
  const briefs: string[] = [];
  const client: ImageGenerationClient = {
    models: {
      async generateContent(req) {
        briefs.push(req.contents);
        return imageResponse() as never;
      },
    },
  };
  return { briefs, tool: createKarosMediaTools({ env: {}, generationClient: client })["image.generate"]! };
}

const schemaOnly = () => createKarosMediaTools({ env: {}, generationClient: null })["image.generate"]!;

/**
 * The full Phase 3 art block, so the byte-identity claim is tested against a
 * REAL Instagram caller's brief rather than the trivial empty one. Every field
 * `visual-direction.ts` populates is here.
 */
const PHASE3_ART = {
  aesthetic: "editorial documentary",
  lighting: "soft north light",
  palette: ["#0B3D2E", "bone"],
  accentColor: "#F04E23",
  mood: "calm and considered",
  notes: "Shoot the workplace, never a symbol.",
  forbid: ["stock handshakes", "glass-tower skylines"],
  styleLock: "Warm documentary photography, one subject, soft single-source light, no composite.",
} as const;

/**
 * What 1.1.0 composed for `PHASE3_ART`, transcribed from the 1.1.0 source and
 * pinned here as a literal. If a future edit changes this string, the diff has
 * to say so out loud rather than reaching every generated image in the fleet
 * silently.
 */
const BRIEF_1_1_0 = [
  "Create a photographic image for a social media carousel slide: a quiet desk at dawn",
  "",
  "Art direction:",
  "- Aesthetic: editorial documentary.",
  "- Lighting: soft north light.",
  "- Colour palette: #0B3D2E, bone.",
  "- Carry the brand accent colour #F04E23 somewhere in the frame, as an object or surface rather than an overlay.",
  "- Mood: calm and considered.",
  "- Shoot the workplace, never a symbol.",
  "",
  "Style lock (identical for every image in this set, do not vary it): Warm documentary photography, one subject, soft single-source light, no composite.",
  "",
  "Do not include:",
  "- stock handshakes",
  "- glass-tower skylines",
  "",
  "Constraints: no text, no words, no lettering, no numbers rendered in the image, no logos, no watermarks, no borders or frames, no collage or split panels.",
].join("\n");

const DESCRIPTION_1_1_0_TAIL = "no third-party copyright, no watermark, no identifiable real person unless described above.";

describe("image.generate 1.2.0 — the permit is absent for the whole fleet", () => {
  it("declares 1.2.0, because the brief it composes changes shape when a permit names something", () => {
    expect(schemaOnly().version).toBe("1.2.0");
  });

  it("buildBrief is BYTE-IDENTICAL to 1.1.0 when no permit names anything", async () => {
    // Four ways a caller arrives with no permit: the two fields absent (every
    // caller outside the Instagram concept path), explicitly empty arrays (the
    // Instagram path on a client with no consent record — which is every
    // client), and each one empty on its own.
    //
    // break it: make `buildConstraintLine` emit the badge framing
    // unconditionally, or append the figures sentence when the list is empty,
    // and all four fail on the literal. An assertion written as
    // `toContain("no logos")` would NOT fail on the second of those, which is
    // why this one is an exact string.
    const noPermitVariants = [
      {},
      { permittedMarks: [], permittedFigures: [] },
      { permittedMarks: [] },
      { permittedFigures: [] },
    ] as const;

    for (const permit of noPermitVariants) {
      const { briefs, tool } = recordingTool();
      const outcome = await tool.execute(
        {
          repoRoot,
          runId: "run_1",
          needs: [{ n: 1, prompt: "a quiet desk at dawn" }],
          art: { ...PHASE3_ART, ...permit },
        },
        { ctx: CTX },
      );

      expect(outcome.status).toBe("success");
      expect(briefs, JSON.stringify(permit)).toHaveLength(1);
      expect(briefs[0], JSON.stringify(permit)).toBe(BRIEF_1_1_0);

      // The candidate description the rights vet reads is the other half of
      // the fleet-wide default, and it must not drift either.
      const description = (outcome as { result: { candidates: Array<{ description: string }> } }).result.candidates[0]!
        .description;
      expect(description, JSON.stringify(permit)).toContain(DESCRIPTION_1_1_0_TAIL);
    }
  });

  it("a caller supplying no art at all still gets the byte-identical 1.1.0 neutral brief", async () => {
    // The other fleet default: every channel that is not Instagram.
    const { briefs, tool } = recordingTool();
    await tool.execute({ repoRoot, runId: "run_1", needs: [{ n: 1, prompt: "a quiet desk at dawn" }] }, { ctx: CTX });

    expect(briefs[0]).toBe(
      [
        "Create a photographic image for a social media carousel slide: a quiet desk at dawn",
        "",
        "Style: realistic photography, natural lighting, clean composition.",
        "",
        "Constraints: no text, no words, no lettering, no numbers rendered in the image, no logos, no watermarks, no borders or frames, no collage or split panels.",
      ].join("\n"),
    );
  });
});

describe("image.generate 1.2.0 — a permit that names something", () => {
  it("a permitted mark appears only as the badge clause, never widening the no-lettering constraint", async () => {
    const { briefs, tool } = recordingTool();
    await tool.execute(
      {
        repoRoot,
        runId: "run_1",
        // The same need as BRIEF_1_1_0, so the prefix comparison at the end of
        // this test is a like-for-like diff against the 1.1.0 literal.
        needs: [{ n: 1, prompt: "a quiet desk at dawn" }],
        art: { ...PHASE3_ART, permittedMarks: ["Apple", "Samsung"] },
      },
      { ctx: CTX },
    );

    const brief = briefs[0]!;

    // The one clause that changed, in full.
    expect(brief).toContain(
      "no logos or brand marks other than: Apple, Samsung — those may appear only as clean flat circular badges or " +
        "plain wordless silhouettes, never as a photographed product, a packaged good or a person's likeness;",
    );

    // break it: fold the mark names into the text clause (e.g. "no text ...
    // other than Apple, Samsung") and this fails. A wordmark IS lettering, and
    // the template draws the real headline over this image — a permission to
    // depict a brand is not a permission to render type into the pixels.
    expect(brief).toContain("Constraints: no text, no words, no lettering, no numbers rendered in the image,");
    expect(brief).toContain("no watermarks, no borders or frames, no collage or split panels.");

    // The permit is not a licence for anything else either: it must not appear
    // as a positive instruction, must not touch the client's own negative
    // block, and must not add a person clause when no figure is permitted.
    expect(brief).not.toContain("No identifiable real person other than");
    expect(brief).toContain("Do not include:\n- stock handshakes\n- glass-tower skylines");

    // Everything above the constraints is byte-identical to 1.1.0 — the permit
    // reaches exactly one line and no other.
    const marker = "\n\nConstraints:";
    expect(brief.slice(0, brief.indexOf(marker))).toBe(BRIEF_1_1_0.slice(0, BRIEF_1_1_0.indexOf(marker)));
  });

  it("a permitted figure adds its own sentence and leaves the marks clause at its default", async () => {
    // The two permits are independent: a right-of-publicity grant is not a
    // trademark grant, so figures alone must leave "no logos," exactly as it
    // was.
    const { briefs, tool } = recordingTool();
    const outcome = await tool.execute(
      {
        repoRoot,
        runId: "run_1",
        needs: [{ n: 1, prompt: "a founder at a lectern" }],
        art: { ...PHASE3_ART, permittedFigures: ["Tim Cook"] },
      },
      { ctx: CTX },
    );

    const brief = briefs[0]!;
    expect(brief).toContain("no logos, no watermarks, no borders or frames, no collage or split panels.");
    expect(brief).not.toContain("no logos or brand marks other than");
    expect(brief).toContain(
      "No identifiable real person other than: Tim Cook — no other recognisable face, likeness or public figure may appear in the frame.",
    );

    // break it: leave `describeGenerated` at its 1.1.0 single-argument form.
    // The rights vet has no pixels on the generate tier — it believes this
    // sentence — so telling it "no identifiable real person" about an image
    // that deliberately contains one clears the image on a false premise.
    const description = (outcome as { result: { candidates: Array<{ description: string }> } }).result.candidates[0]!
      .description;
    expect(description).not.toContain("no identifiable real person unless described above");
    expect(description).toContain("a deliberate, recorded-permission likeness of Tim Cook and no other identifiable real person");
    // The rest of the provenance line is untouched, so the vet still clears rights.
    expect(description).toContain("AI-generated illustration");
    expect(description).toContain("no third-party copyright, no watermark,");
  });

  it("both permits compose: the badge clause and the person sentence, each once", async () => {
    const { briefs, tool } = recordingTool();
    await tool.execute(
      {
        repoRoot,
        runId: "run_1",
        needs: [{ n: 1, prompt: "two chairs at the head of one table" }],
        art: { ...PHASE3_ART, permittedMarks: ["Apple"], permittedFigures: ["Tim Cook"] },
      },
      { ctx: CTX },
    );

    const brief = briefs[0]!;
    expect(brief.match(/Constraints: no text/g)).toHaveLength(1);
    expect(brief).toContain("no logos or brand marks other than: Apple —");
    expect(brief).toContain("No identifiable real person other than: Tim Cook");
    expect(brief).not.toContain("no logos, no watermarks");
  });
});

describe("image.generate 1.2.0 — the schema keeps the permit small and named", () => {
  const base = { repoRoot: "/tmp/x", runId: "run_1", needs: [{ n: 1, prompt: "x" }] };
  const parse = (art: Record<string, unknown>) => schemaOnly().inputSchema.safeParse({ ...base, art }).success;

  it("caps marks at six and figures at three, and refuses an unnamed entry", () => {
    expect(parse({ permittedMarks: Array.from({ length: 6 }, (_, i) => `m${i}`) })).toBe(true);
    expect(parse({ permittedMarks: Array.from({ length: 7 }, (_, i) => `m${i}`) })).toBe(false);
    expect(parse({ permittedFigures: ["a", "b", "c"] })).toBe(true);
    expect(parse({ permittedFigures: ["a", "b", "c", "d"] })).toBe(false);
    // An empty string is not a name, and a nameless permit is the exact shape
    // `readGeneratedLikenessConsent` refuses to issue in the first place.
    expect(parse({ permittedMarks: [""] })).toBe(false);
    expect(parse({ permittedFigures: [""] })).toBe(false);
  });

  it("both fields are optional and additive — every 1.1.0 input still parses", () => {
    expect(schemaOnly().inputSchema.safeParse({ ...base, art: { forbid: ["no faces"], styleLock: "one look" } }).success).toBe(true);
    expect(schemaOnly().inputSchema.safeParse(base).success).toBe(true);
  });
});
