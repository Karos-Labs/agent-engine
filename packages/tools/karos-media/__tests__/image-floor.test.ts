import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assessImageFloor,
  buildImageProvenance,
  createFindImages,
  createKarosMediaTools,
  describeProvenanceForPublisher,
  IMAGE_MODEL_LADDER,
  ImageModelLadder,
  isModelUnavailableError,
  CANVAS_SHORT_SIDE_PX,
  FULL_BLEED_MIN_SHORT_SIDE_PX,
  INSET_MIN_SHORT_SIDE_PX,
  MAX_UPSCALE,
  placementFor,
  type ImageSearchHit,
  type ImageSearchProvider,
} from "../src/index.js";
import { pricingForUnit } from "@agent-engine/core";
import { realJpeg, realPng, realPngBase64, tooSmallPng } from "./image-fixtures.js";

/**
 * Phase 5.6, items A8 / A11 / D2.
 *
 * The owner's complaint that started this was "why are there no images", and
 * the answer in three prep runs was never one thing: a source served a
 * thumbnail, a generation returned a small frame, the model the project could
 * reach was decided by a comment written during an outage.
 *
 * The first of those three was then made WORSE by the fix: a hard 1080 floor
 * turned "the source only had a small one" into "there is no picture", and on
 * the generation path it discarded frames the run had already paid for. The
 * owner's 2026-09-18 ruling removed size as a refusal, and these tests hold
 * the replacement instead: an image always has a placement, and the pool is
 * ORDERED so the picture that can cover the frame is offered first.
 *
 * Each assertion is still written so that removing its fix makes it fail.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-floor-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

function provider(name: string, hits: ImageSearchHit[]): ImageSearchProvider {
  return { name, async search() { return hits; } };
}

const oneHit = (id = "h1"): ImageSearchHit => ({
  id,
  url: `https://example.org/${id}.jpg`,
  description: "a desk",
  license: "CC0",
  licenseConfidence: "blanket",
  credit: "h",
});

function servingBytes(body: Buffer, contentType = "image/png"): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

// ─────────────────────────────────────────────────────────────────────────
// A8 — the measurement itself
// ─────────────────────────────────────────────────────────────────────────

describe("assessImageFloor", () => {
  it("passes an image at the plate's own size, and says what it measured", () => {
    const verdict = assessImageFloor(realPng(1080, 1350));
    expect(verdict.ok).toBe(true);
    expect(verdict.facts).toMatchObject({ width: 1080, height: 1350, shortSide: 1080, format: "png" });
  });

  it("NEVER refuses on size — the owner's ruling, and the case that produced it", () => {
    // 896x1200 is what Gemini returned in both prep runs on 2026-09-18. It
    // was refused six times, each time after the image charge had been paid.
    const generated = assessImageFloor(realPng(896, 1200));
    expect(generated.ok).toBe(true);
    expect(generated.facts?.placement).toBe("full-bleed");

    // …and neither is anything below it, however small.
    for (const shortSide of [640, 320, 120, 16]) {
      expect(assessImageFloor(realPng(shortSide, shortSide * 2)).ok, `${shortSide}px`).toBe(true);
    }
  });

  it("maps a size to the largest job it can hold, and the bounds are inclusive", () => {
    expect(placementFor(FULL_BLEED_MIN_SHORT_SIDE_PX)).toBe("full-bleed");
    expect(placementFor(FULL_BLEED_MIN_SHORT_SIDE_PX - 1)).toBe("inset");
    expect(placementFor(INSET_MIN_SHORT_SIDE_PX)).toBe("inset");
    expect(placementFor(INSET_MIN_SHORT_SIDE_PX - 1)).toBe("accent");
    // Total by construction: there is no size with no answer, which is what
    // makes "a caller can always place what it is handed" true rather than
    // hopeful.
    expect(placementFor(0)).toBe("accent");
  });

  it("derives the placement bounds from the canvas, so moving the canvas moves them", () => {
    // Asserted as arithmetic rather than as the literals 772 / 348: item A1
    // changes the canvas, and a test pinned to today's numbers would then
    // pass while describing the wrong frame.
    expect(FULL_BLEED_MIN_SHORT_SIDE_PX).toBe(Math.ceil(CANVAS_SHORT_SIDE_PX / MAX_UPSCALE));
    expect(INSET_MIN_SHORT_SIDE_PX).toBeLessThan(FULL_BLEED_MIN_SHORT_SIDE_PX);
  });

  it("says what covering the frame would COST, so a soft slide is explained rather than guessed at", () => {
    const verdict = assessImageFloor(realPng(640, 480));
    expect(verdict.ok).toBe(true);
    expect(verdict.facts?.fullBleedUpscale).toBe(2.25);
    expect(verdict.warnings.join(" ")).toContain("640x480");
    expect(verdict.warnings.join(" ")).toContain("2.25x");
  });

  it("charges nothing for a reduction — an oversized picture is not a warning", () => {
    const verdict = assessImageFloor(realPng(2400, 3000));
    expect(verdict.facts?.fullBleedUpscale).toBeLessThan(1);
    expect(verdict.warnings).toEqual([]);
  });

  it("refuses bytes that are not an image at all, rather than placing them unmeasured", () => {
    const verdict = assessImageFloor(Buffer.from("<html>not an image</html>"));
    expect(verdict.ok).toBe(false);
    expect(verdict.facts).toBeUndefined();
    expect(verdict.reasons.join(" ")).toContain("not a readable");
  });

  it("warns about a GIF without refusing it — a re-encode is a downgrade, not a defect", () => {
    const gif = Buffer.alloc(14);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(1200, 6);
    gif.writeUInt16LE(1200, 8);
    const verdict = assessImageFloor(gif);
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join(" ")).toContain("GIF");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A8 — the floor where it actually bites
// ─────────────────────────────────────────────────────────────────────────

describe("the resolution floor on the download path", () => {
  it("PLACES a sourced thumbnail and says where it fits, rather than returning an empty slide", async () => {
    const tool = createFindImages({ chainFor: () => [provider("p", [oneHit()])], available: ["p"] }, servingBytes(tooSmallPng()));
    const outcome = await tool.execute(
      { repoRoot, runId: "small", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 2 },
      { ctx: CTX } as never,
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ pixels?: { placement: string }; qualityNotes?: string[]; description: string }> } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pixels?.placement).toBe("inset");
    // The size reaches the vetting agent, which reads only the description.
    expect(result.candidates[0]!.description).toContain("640x480");
    expect(result.candidates[0]!.qualityNotes?.join(" ")).toContain("640x480");
  });

  it("writes NOTHING to disk for an image it DOES refuse — a later path cannot pick it up by scanning the directory", async () => {
    // Bytes that are not an image at all: the refusal that survived the
    // ruling. Placing this would mean inventing its dimensions.
    const tool = createFindImages(
      { chainFor: () => [provider("p", [oneHit()])], available: ["p"] },
      servingBytes(Buffer.from("<html>not an image</html>")),
    );
    await tool.execute(
      { repoRoot, runId: "broken", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 2 },
      { ctx: CTX } as never,
    );
    const written = await fs.readdir(path.join(repoRoot, ".media-cache", "broken")).catch(() => []);
    expect(written).toEqual([]);
  });

  it("OFFERS the picture that covers the frame first, so relaxing the floor did not promote thumbnails", async () => {
    let call = 0;
    const fetchImpl = (async (url: string) => {
      call += 1;
      const body = String(url).includes("small") ? tooSmallPng() : realPng();
      return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    // The thumbnail provider is FIRST in the chain, so chain precedence alone
    // would hand the slide a 640px picture. Deleting the sort makes this fail.
    const tool = createFindImages(
      {
        chainFor: () => [provider("thumbs", [oneHit("small")]), provider("full", [oneHit("big")])],
        available: ["thumbs", "full"],
      },
      fetchImpl,
    );
    const outcome = await tool.execute(
      { repoRoot, runId: "mixed", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 4 },
      { ctx: CTX } as never,
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ provider: string; pixels?: { shortSide: number } }> } }).result;
    // Both are kept — nothing is thrown away any more — but the one that can
    // cover the frame is the one the vetting agent reads first.
    expect(result.candidates.map((c) => c.provider)).toEqual(["full", "thumbs"]);
    expect(result.candidates[0]!.pixels?.shortSide).toBe(1080);
    expect(call).toBe(2);
  });

  it("carries the measured pixels onto every candidate, so a later step never has to guess", async () => {
    const tool = createFindImages({ chainFor: () => [provider("p", [oneHit()])], available: ["p"] }, servingBytes(realJpeg(1440, 1800), "image/jpeg"));
    const outcome = await tool.execute(
      { repoRoot, runId: "facts", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 2 },
      { ctx: CTX } as never,
    );
    const result = (outcome as { result: { candidates: Array<{ pixels?: unknown }> } }).result;
    expect(result.candidates[0]!.pixels).toMatchObject({ format: "jpeg", width: 1440, height: 1800, shortSide: 1440 });
  });
});

describe("client-supplied media is measured, not refused", () => {
  it("places the client's own small photograph and records the shortfall, rather than handing back an empty slide", async () => {
    const tools = createKarosMediaTools({ env: {}, fetchImpl: servingBytes(tooSmallPng()) });
    const outcome = await tools["media.ingestAssets"]!.execute(
      { repoRoot, runId: "tier0", assets: [{ slot: 1, uri: "https://client.example/their-photo.png" }] },
      { ctx: CTX } as never,
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ qualityNotes?: string[]; pixels?: { shortSide: number; placement: string } }> } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pixels?.shortSide).toBe(480);
    expect(result.candidates[0]!.pixels?.placement).toBe("inset");
    expect(result.candidates[0]!.qualityNotes?.join(" ")).toContain("640x480");
  });

  it("still refuses bytes that are not an image — `measure` softens a judgement, not the existence question", async () => {
    const tools = createKarosMediaTools({ env: {}, fetchImpl: servingBytes(Buffer.from("<html>nope</html>"), "image/png") });
    const outcome = await tools["media.ingestAssets"]!.execute(
      { repoRoot, runId: "tier0", assets: [{ slot: 1, uri: "https://client.example/broken.png" }] },
      { ctx: CTX } as never,
    );
    expect(JSON.stringify(outcome)).toContain("not a readable");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// D2 — the model ladder
// ─────────────────────────────────────────────────────────────────────────

describe("ImageModelLadder", () => {
  it("leads with the CURRENT image model and keeps a different family as the last resort", () => {
    // Order is evidence, not taste: 3.1 is the model main moved the default
    // to, 2.5 is the id verified working in prep, and Imagen is last because
    // it is a different family rather than a better model — it earns its
    // place only if both Gemini image ids are out at once.
    expect(IMAGE_MODEL_LADDER[0]).toBe("gemini-3.1-flash-image");
    expect(IMAGE_MODEL_LADDER).toContain("gemini-2.5-flash-image");
    expect(IMAGE_MODEL_LADDER.at(-1)).toMatch(/^imagen-/);
  });

  it("names only models that carry a per-unit price — an unpriced rung kills a run at the cost step", () => {
    for (const model of IMAGE_MODEL_LADDER) {
      expect(() => pricingForUnit(model), model).not.toThrow();
    }
  });

  it("falls to the next rung once a model reports it does not exist here", () => {
    const ladder = new ImageModelLadder();
    const first = ladder.preferred()!;
    ladder.strike(first);
    expect(ladder.preferred()).not.toBe(first);
    expect(ladder.isStruck(first)).toBe(true);
  });

  it("NEVER strikes the last rung — a ladder with nothing on it can only produce no image", () => {
    const ladder = new ImageModelLadder(["only-one"]);
    ladder.strike("only-one");
    expect(ladder.preferred()).toBe("only-one");
    expect(ladder.isStruck("only-one")).toBe(false);
  });

  it("collapses to a single rung when a caller pins a model, so a pinned deployment is unchanged", () => {
    const ladder = new ImageModelLadder(IMAGE_MODEL_LADDER, "gemini-2.5-flash-image");
    expect(ladder.available()).toEqual(["gemini-2.5-flash-image"]);
  });

  it('reads "was not found" for an Imagen id too, which is how the old default came to be chosen', () => {
    expect(isModelUnavailableError("Publisher Model `imagen-4.0-generate-001` was not found")).toBe(true);
  });

  it("reads 404 / NOT_FOUND as 'this model does not exist here'", () => {
    expect(isModelUnavailableError('{"error":{"code":404,"status":"NOT_FOUND"}}')).toBe(true);
    expect(isModelUnavailableError("Publisher Model `imagen-4.0-generate-001` was not found")).toBe(true);
    expect(isModelUnavailableError("model is not supported for generateContent")).toBe(true);
  });

  it("does NOT demote a model over a permission or quota answer — neither says the model is absent", () => {
    expect(isModelUnavailableError('{"error":{"code":403,"status":"PERMISSION_DENIED"}}')).toBe(false);
    expect(isModelUnavailableError('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(false);
    expect(isModelUnavailableError("deadline exceeded")).toBe(false);
  });
});

describe("image.generate walks the ladder", () => {
  const generationResponse = () => ({
    candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: realPngBase64(), mimeType: "image/png" } }] } }],
  });

  it("falls from a 404ing top rung to the one that answers, and says which one served", async () => {
    const asked: string[] = [];
    const client = {
      models: {
        async generateContent(req: { model: string }) {
          asked.push(req.model);
          // 3.1 serves only on the `global` endpoint, so a project pointed
          // anywhere else gets exactly this.
          if (req.model === "gemini-3.1-flash-image") throw new Error('{"error":{"code":404,"status":"NOT_FOUND"}}');
          return generationResponse() as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    const outcome = await tool.execute(
      { repoRoot, runId: "ladder", needs: [{ n: 1, prompt: "a desk" }], perNeed: 1 },
      { ctx: CTX } as never,
    );

    expect(outcome.status).toBe("success");
    expect(asked[0]).toBe("gemini-3.1-flash-image");
    expect(asked.at(-1)).toBe("gemini-2.5-flash-image");
    const result = (outcome as { result: { model: string } }).result;
    expect(result.model).toBe("gemini-2.5-flash-image");
  });

  it("remembers the fall: a second need does not re-ask a model that already said it is absent", async () => {
    const asked: string[] = [];
    const client = {
      models: {
        async generateContent(req: { model: string }) {
          asked.push(req.model);
          if (req.model === "gemini-3.1-flash-image") throw new Error("NOT_FOUND");
          return generationResponse() as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    await tool.execute(
      { repoRoot, runId: "ladder2", needs: [{ n: 1, prompt: "a" }, { n: 2, prompt: "b" }], perNeed: 1 },
      { ctx: CTX } as never,
    );
    // Exactly ONE probe of the absent rung across BOTH needs, not one per need.
    expect(asked.filter((m) => m === "gemini-3.1-flash-image")).toHaveLength(1);
  });

  it("PLACES a small generated frame — this path has already paid for it, and both prep runs threw one away", async () => {
    // The regression this replaces: on 2026-09-18 a 896x1200 frame was
    // refused six times across two runs, each refusal after the image charge
    // had been booked, and the retries in one run ended on a 429. A 640px
    // frame is the sharper version of the same case.
    const client = {
      models: {
        async generateContent() {
          return {
            candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: tooSmallPng().toString("base64"), mimeType: "image/png" } }] } }],
          } as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    const outcome = await tool.execute(
      { repoRoot, runId: "smallgen", needs: [{ n: 1, prompt: "a desk" }], perNeed: 1 },
      { ctx: CTX } as never,
    );
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ pixels?: { placement: string }; qualityNotes?: string[] }> } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pixels?.placement).toBe("inset");
    // The shortfall is still REPORTED. Relaxing the refusal did not relax
    // the measurement, which is the whole of what A8 was for.
    expect(result.candidates[0]!.qualityNotes?.join(" ")).toContain("640x480");
  });

  it("still refuses a generated frame that is not a readable image, rather than writing it to the cache", async () => {
    const client = {
      models: {
        async generateContent() {
          return {
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ inlineData: { data: Buffer.from("<html>nope</html>").toString("base64"), mimeType: "image/png" } }] },
              },
            ],
          } as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    const outcome = await tool.execute(
      { repoRoot, runId: "brokengen", needs: [{ n: 1, prompt: "a desk" }], perNeed: 1 },
      { ctx: CTX } as never,
    );
    expect(outcome.status).toBe("content_fail");
    expect(JSON.stringify(outcome)).toContain("not a readable");
  });

  it("accepts 4:5 — the platform's own portrait ratio, which the schema did not offer until now", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      models: {
        async generateContent(req: { config?: Record<string, unknown> }) {
          seen.push(req.config ?? {});
          return generationResponse() as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    const outcome = await tool.execute(
      { repoRoot, runId: "ratio", needs: [{ n: 1, prompt: "a desk" }], perNeed: 1, aspectRatio: "4:5" },
      { ctx: CTX } as never,
    );
    expect(outcome.status).toBe("success");
    expect(seen[0]!.imageConfig).toMatchObject({ aspectRatio: "4:5" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A11 — provenance
// ─────────────────────────────────────────────────────────────────────────

describe("buildImageProvenance", () => {
  const now = () => new Date("2026-09-17T00:00:00.000Z");

  it("declares a generation photoreal by default, because the brief asks for a photograph", () => {
    const p = buildImageProvenance({ model: "imagen-4.0-generate-001", brief: "a desk", now });
    expect(p).toMatchObject({ origin: "generated", model: "imagen-4.0-generate-001", photoreal: true });
    expect(describeProvenanceForPublisher(p)).toContain("set Instagram's AI-info toggle");
  });

  it("does not declare an ILLUSTRATION photoreal, and says on what evidence", () => {
    const p = buildImageProvenance({ model: "m", brief: "a desk", styleLock: "flat vector illustration, two colours", now });
    expect(p.photoreal).toBe(false);
    expect(p.photorealBasis).toContain("illustration");
  });

  it("errs toward declaring: an unclassifiable treatment stays photoreal", () => {
    const p = buildImageProvenance({ model: "m", brief: "a desk", styleLock: "moody and cinematic", now });
    expect(p.photoreal).toBe(true);
  });

  it("hashes the brief rather than carrying it, and the same brief hashes the same", () => {
    const a = buildImageProvenance({ model: "m", brief: "the long brief", now });
    const b = buildImageProvenance({ model: "m", brief: "the long brief", now });
    const c = buildImageProvenance({ model: "m", brief: "a different brief", now });
    expect(a.briefHash).toBe(b.briefHash);
    expect(a.briefHash).not.toBe(c.briefHash);
    expect(a.briefHash).toHaveLength(16);
  });

  it("rides on the candidate a real generation produces, so the deliverable can read it", async () => {
    const client = {
      models: {
        async generateContent() {
          return { candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: realPngBase64(), mimeType: "image/png" } }] } }] } as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    const outcome = await tool.execute(
      { repoRoot, runId: "prov", needs: [{ n: 1, prompt: "a desk" }], perNeed: 1 },
      { ctx: CTX } as never,
    );
    const result = (outcome as { result: { candidates: Array<{ provenance?: { photoreal: boolean; model: string } }> } }).result;
    expect(result.candidates[0]!.provenance).toMatchObject({ origin: "generated", photoreal: true });
    expect(result.candidates[0]!.provenance!.model).toBe(IMAGE_MODEL_LADDER[0]);
  });
});
