import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GcsArtifactStoreLike, ArtifactUploadResult } from "@agent-engine/tool-common";
import { assertInside, validateRenderInputs, persistRenderedSlide, RenderCarouselInputSchema, type RenderCarouselInput } from "../src/render-carousel.js";

/**
 * These tests exercise only the Chromium-free half of `publish.renderCarousel`
 * (path guards + missing-file classification) — the legacy `render.mjs`
 * `--self-test` equivalent (RFC-03 §4). Actually launching Chromium is
 * intentionally out of scope for unit tests; that's an integration/e2e concern.
 */
describe("assertInside (legacy render.mjs path guard, ported verbatim)", () => {
  it("resolves a well-formed repo-relative path", () => {
    expect(assertInside("/repo", "templates/a.html", "template")).toBe(path.resolve("/repo", "templates/a.html"));
  });

  it("refuses an absolute path", () => {
    expect(() => assertInside("/repo", "/etc/passwd", "template")).toThrow(/repo-relative/);
  });

  it("refuses a URL-shaped string", () => {
    expect(() => assertInside("/repo", "https://evil.example/x", "image")).toThrow(/repo-relative/);
  });

  it("refuses a path that escapes the repo root via ..", () => {
    expect(() => assertInside("/repo", "../../etc/passwd", "template")).toThrow(/escapes the repo root/);
  });
});

describe("validateRenderInputs (the three-way tooling/content/ok classification)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "carousel-render-"));
    await fs.mkdir(path.join(repoRoot, "templates"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "templates", "slide.html"), "<html>{{title}}</html>");
    await fs.mkdir(path.join(repoRoot, "images"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "images", "photo.png"), "fake-png-bytes");
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  function baseInput(overrides: Partial<RenderCarouselInput> = {}): RenderCarouselInput {
    return RenderCarouselInputSchema.parse({
      client: "acme",
      postId: "post_1",
      templateDir: "templates",
      outDir: "out",
      repoRoot,
      slides: [{ n: 1, template: "slide.html", fields: { title: "Hello" }, images: { hero: "images/photo.png" } }],
      ...overrides,
    });
  }

  it("passes validation for well-formed paths pointing at real files", async () => {
    const result = await validateRenderInputs(baseInput());
    expect(result.ok).toBe(true);
  });

  it("rejects canvas.scale !== 2 as a TOOLING failure — the QA PNG floor depends on it", async () => {
    const input = baseInput({ canvas: { w: 1080, h: 1440, scale: 1, slides_min: 6, slides_max: 8 } });
    const result = await validateRenderInputs(input);
    expect(result).toMatchObject({ ok: false, kind: "tooling" });
  });

  it("classifies a missing template file as TOOLING, not content", async () => {
    const input = baseInput({ slides: [{ n: 1, template: "does-not-exist.html", fields: {}, images: {} }] });
    const result = await validateRenderInputs(input);
    expect(result).toMatchObject({ ok: false, kind: "tooling" });
  });

  it("classifies a missing image file as CONTENT, not tooling — a real content problem, not a renderer bug", async () => {
    const input = baseInput({ slides: [{ n: 1, template: "slide.html", fields: {}, images: { hero: "images/missing.png" } }] });
    const result = await validateRenderInputs(input);
    expect(result).toMatchObject({ ok: false, kind: "content" });
  });

  it("classifies an absolute image path as TOOLING, distinct from a merely-missing file", async () => {
    const input = baseInput({ slides: [{ n: 1, template: "slide.html", fields: {}, images: { hero: "/etc/passwd" } }] });
    const result = await validateRenderInputs(input);
    expect(result).toMatchObject({ ok: false, kind: "tooling" });
  });

  it("classifies a template path escaping the repo root as TOOLING", async () => {
    const input = baseInput({ templateDir: "../outside" });
    const result = await validateRenderInputs(input);
    expect(result).toMatchObject({ ok: false, kind: "tooling" });
  });

  it("defaults canvas to {w:1080,h:1440,scale:2,slides_min:6,slides_max:8} when omitted", () => {
    const parsed = RenderCarouselInputSchema.parse({
      client: "acme",
      postId: "post_1",
      templateDir: "templates",
      outDir: "out",
      repoRoot,
      slides: [{ n: 1, template: "slide.html" }],
    });
    expect(parsed.canvas).toEqual({ w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 });
    expect(parsed.readyFlag).toBe("__CAROUSEL_READY__");
  });
});

function fakeMediaStore(overrides: Partial<GcsArtifactStoreLike> = {}): GcsArtifactStoreLike {
  return {
    bucketName: "karoscmo-prep-media-assets",
    async upload(objectPath, _data, _options): Promise<ArtifactUploadResult> {
      return { objectPath, gcsUri: `gs://karoscmo-prep-media-assets/${objectPath}`, signedUrl: `https://storage.googleapis.com/${objectPath}?signed=1` };
    },
    async download() {
      throw new Error("not used in these tests");
    },
    async exists() {
      return true;
    },
    ...overrides,
  };
}

describe("persistRenderedSlide", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "carousel-persist-"));
  });

  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("writes to local disk and returns the local path when no mediaStore is configured", async () => {
    const outPath = path.join(outDir, "slide-1.png");
    const result = await persistRenderedSlide(Buffer.from("fake-png"), outPath, "instagram/acme/post_1/slide-1.png", undefined);

    expect(result.path).toBe(outPath);
    expect(result.gcsUri).toBeUndefined();
    expect(await fs.readFile(outPath)).toEqual(Buffer.from("fake-png"));
  });

  it("uploads to the media store and returns a signed URL as `path`, with `gcsUri` alongside it, when one is configured", async () => {
    const outPath = path.join(outDir, "slide-1.png");
    const result = await persistRenderedSlide(Buffer.from("fake-png"), outPath, "instagram/acme/post_1/slide-1.png", fakeMediaStore());

    expect(result.path).toBe("https://storage.googleapis.com/instagram/acme/post_1/slide-1.png?signed=1");
    expect(result.gcsUri).toBe("gs://karoscmo-prep-media-assets/instagram/acme/post_1/slide-1.png");
    await expect(fs.access(outPath)).rejects.toThrow(); // never touched local disk
  });

  it("falls back to the gs:// URI as `path` when the media store can't produce a signed URL", async () => {
    const noSignStore = fakeMediaStore({
      async upload(objectPath) {
        return { objectPath, gcsUri: `gs://karoscmo-prep-media-assets/${objectPath}` }; // no signedUrl
      },
    });
    const result = await persistRenderedSlide(Buffer.from("fake-png"), path.join(outDir, "slide-1.png"), "instagram/acme/post_1/slide-1.png", noSignStore);

    expect(result.path).toBe("gs://karoscmo-prep-media-assets/instagram/acme/post_1/slide-1.png");
    expect(result.gcsUri).toBe(result.path);
  });
});
