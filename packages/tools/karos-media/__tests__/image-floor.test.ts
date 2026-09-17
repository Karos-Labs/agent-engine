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
  MIN_IMAGE_SHORT_SIDE_PX,
  type ImageSearchHit,
  type ImageSearchProvider,
} from "../src/index.js";
import { realJpeg, realPng, realPngBase64, tooSmallPng } from "./image-fixtures.js";

/**
 * Phase 5.6, items A8 / A11 / D2.
 *
 * The owner's complaint that started this was "why are there no images", and
 * the answer in three prep runs was never one thing: a source served a
 * thumbnail, a generation returned a small frame, the model the project could
 * reach was decided by a comment written during an outage. Each of those is a
 * separate assertion below, and each is written so that REMOVING the fix makes
 * it fail — a floor tested only with images that clear it is not a floor.
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

  it("passes an image EXACTLY on the floor — the bound is inclusive, and a test proves which", () => {
    expect(assessImageFloor(realPng(MIN_IMAGE_SHORT_SIDE_PX, 2000)).ok).toBe(true);
    expect(assessImageFloor(realPng(MIN_IMAGE_SHORT_SIDE_PX - 1, 2000)).ok).toBe(false);
  });

  it("names the REAL size in the refusal, because 'too small' is not an actionable reason", () => {
    const verdict = assessImageFloor(realPng(640, 480));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("640x480");
    expect(verdict.reasons.join(" ")).toContain("480px");
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
  it("refuses a sourced thumbnail and reports its size, instead of enlarging it onto a slide", async () => {
    const tool = createFindImages({ chainFor: () => [provider("p", [oneHit()])], available: ["p"] }, servingBytes(tooSmallPng()));
    const outcome = await tool.execute(
      { repoRoot, runId: "small", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 2 },
      { ctx: CTX } as never,
    );

    // Nothing was placed…
    expect(outcome.status).toBe("content_fail");
    // …and the reason is the measurement, not "failed to download".
    expect(JSON.stringify(outcome)).toContain("640x480");
  });

  it("writes NOTHING to disk for a refused image — a later path cannot pick it up by scanning the directory", async () => {
    const tool = createFindImages({ chainFor: () => [provider("p", [oneHit()])], available: ["p"] }, servingBytes(tooSmallPng()));
    await tool.execute(
      { repoRoot, runId: "small", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 2 },
      { ctx: CTX } as never,
    );
    const written = await fs.readdir(path.join(repoRoot, ".media-cache", "small")).catch(() => []);
    expect(written).toEqual([]);
  });

  it("falls THROUGH a small-image provider to a healthy one, rather than giving up on the need", async () => {
    let call = 0;
    const fetchImpl = (async (url: string) => {
      call += 1;
      const body = String(url).includes("small") ? tooSmallPng() : realPng();
      return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

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
    expect(result.candidates.map((c) => c.provider)).toEqual(["full"]);
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
    const result = (outcome as { result: { candidates: Array<{ qualityNotes?: string[]; pixels?: { shortSide: number } }> } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pixels?.shortSide).toBe(480);
    expect(result.candidates[0]!.qualityNotes?.join(" ")).toContain("480px");
  });

  it("still refuses bytes that are not an image — `measure` softens the size question, not the existence one", async () => {
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
  it("prefers Imagen, and keeps the verified-reachable Gemini path as its floor", () => {
    expect(IMAGE_MODEL_LADDER[0]).toMatch(/^imagen-/);
    expect(IMAGE_MODEL_LADDER.at(-1)).toBe("gemini-2.5-flash-image");
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

  it("falls from a 404ing Imagen to the reachable model, and says which one served", async () => {
    const asked: string[] = [];
    const client = {
      models: {
        async generateContent(req: { model: string }) {
          asked.push(req.model);
          if (req.model.startsWith("imagen-")) throw new Error('{"error":{"code":404,"status":"NOT_FOUND"}}');
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
    expect(asked[0]).toMatch(/^imagen-/);
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
          if (req.model.startsWith("imagen-")) throw new Error("NOT_FOUND");
          return generationResponse() as never;
        },
      },
    };
    const tool = createKarosMediaTools({ env: {}, generationClient: client as never })["image.generate"]!;
    await tool.execute(
      { repoRoot, runId: "ladder2", needs: [{ n: 1, prompt: "a" }, { n: 2, prompt: "b" }], perNeed: 1 },
      { ctx: CTX } as never,
    );
    // Exactly one probe per Imagen rung across BOTH needs, not one per need.
    expect(asked.filter((m) => m.startsWith("imagen-")).length).toBe(IMAGE_MODEL_LADDER.filter((m) => m.startsWith("imagen-")).length);
  });

  it("refuses a generated frame that misses the floor — 'we made it' is not a reason to place a small picture", async () => {
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
    expect(outcome.status).toBe("content_fail");
    expect(JSON.stringify(outcome)).toContain("640x480");
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
