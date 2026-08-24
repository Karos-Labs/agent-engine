import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKarosMediaTools, type ImageSearchProvider } from "../src/index.js";

/**
 * `media.ingestAssets` — Tier 0's downloader.
 *
 * ## What this tool exists to prevent
 *
 * A `gs://` URI in the candidate pool passes every gate and dies at the render
 * step, because `assertInside` in karos-publish refuses URL-shaped strings by
 * design. So the failure lands several steps after the mistake, blaming the
 * renderer, and only after the run has paid for copy, vetting and every other
 * tier. Everything below is about the attachment arriving as a real file inside
 * the bounds root, or being reported as unmet.
 *
 * ## Why `kind` exists
 *
 * `tiktok-agent` attaches the episode it cuts from. The image path would refuse
 * it twice over — on content type and on the 12 MB ceiling — so the two kinds
 * carry their own tables and their own ceilings rather than one set of values
 * that has to be wrong for one of them.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-ingest-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

/** A reader standing in for GCS. Records what was asked for. */
function stubReader(bytesByPath: Record<string, Buffer>, seen: string[] = []) {
  return {
    seen,
    async download(objectPath: string): Promise<Buffer> {
      seen.push(objectPath);
      const found = bytesByPath[objectPath];
      if (found === undefined) throw new Error(`no such object: ${objectPath}`);
      return found;
    },
  };
}

function respond(body: Buffer, contentType: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

/** A harvester that finds nothing. Present only so the registry gets built. */
const NO_HITS: ImageSearchProvider = { name: "none", async search() { return []; } };

/**
 * The tool under test.
 *
 * `createKarosMediaTools` returns a registry holding ONLY `media.findImages`
 * when no image source is available, so a harvester has to exist for the
 * ingester to be registered at all — worth knowing, because it means a
 * deployment with no harvester also has no Tier 0.
 */
function ingester(options: { reader?: { download(p: string): Promise<Buffer> }; fetchImpl?: typeof fetch }) {
  const tools = createKarosMediaTools({
    provider: NO_HITS,
    generationClient: null,
    ...(options.reader ? { objectReader: options.reader } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const tool = tools["media.ingestAssets"];
  if (!tool) throw new Error("media.ingestAssets was not registered");
  return tool;
}

describe("media.ingestAssets", () => {
  it("writes a gs:// image inside the bounds root and returns a repo-relative path", async () => {
    const reader = stubReader({ "clients/c1/run-attachments/hero.jpg": Buffer.alloc(64, 7) });
    const outcome = await ingester({ reader }).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "gs://bucket/clients/c1/run-attachments/hero.jpg", slot: 1, label: "hero shot" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    const result = outcome.status === "success" ? (outcome.result as { candidates: Array<{ path: string; description: string; licenseConfidence: string }> }) : undefined;
    const candidate = result!.candidates[0]!;
    // Repo-relative, not absolute and not a URI: this is the one form the
    // renderer's bounds check accepts.
    expect(candidate.path).toBe(".media-cache/run_1/n1-client0.jpg");
    expect(path.isAbsolute(candidate.path)).toBe(false);
    // And it is genuinely on disk — the point of the whole tool.
    await expect(fs.readFile(path.join(repoRoot, candidate.path))).resolves.toHaveLength(64);
    // Without a distinct licence tier the vetting agent reads an upload as
    // unknown provenance and refuses the one asset the client actually owns.
    expect(candidate.licenseConfidence).toBe("client-supplied");
    expect(candidate.description).toContain("CLIENT-SUPPLIED");
    expect(candidate.description).toContain("hero shot");
    // The bucket is dropped and the object path passed on — a reader is scoped
    // to its bucket, and sending it "bucket/object" would look for a folder.
    expect(reader.seen).toEqual(["clients/c1/run-attachments/hero.jpg"]);
  });

  it("reports a gs:// attachment as unmet when the deployment has no reader", async () => {
    const outcome = await ingester({}).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "gs://bucket/a.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    // content_fail, not tooling_error: nothing is broken, this deployment
    // simply cannot read the thing it was handed, and the caller's job is to
    // let the tiers below cover the slide.
    expect(outcome.status).toBe("content_fail");
    expect(outcome.status === "content_fail" ? outcome.reason : "").toContain("no GCS reader");
  });

  it("keeps the good attachment and reports the bad one, rather than failing both", async () => {
    const reader = stubReader({ "ok.jpg": Buffer.alloc(32, 3) });
    const outcome = await ingester({ reader }).execute(
      {
        repoRoot,
        runId: "run_1",
        assets: [
          { uri: "gs://bucket/missing.jpg", slot: 1 },
          { uri: "gs://bucket/ok.jpg", slot: 2 },
        ],
      },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    const result = outcome.status === "success" ? (outcome.result as { candidates: unknown[]; unmet: Array<{ slot: number; reason: string }> }) : undefined;
    expect(result!.candidates).toHaveLength(1);
    // Never silently dropped: the caller decides which slides the harvesters
    // still have to cover, and it can only do that from this list.
    expect(result!.unmet[0]!.slot).toBe(1);
    expect(result!.unmet[0]!.reason).toContain("could not read the object");
  });

  it("refuses an empty object instead of writing a zero-byte slide", async () => {
    const reader = stubReader({ "empty.jpg": Buffer.alloc(0) });
    const outcome = await ingester({ reader }).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "gs://bucket/empty.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("content_fail");
    expect(outcome.status === "content_fail" ? outcome.reason : "").toContain("empty");
  });

  it("refuses a scheme it cannot resolve rather than guessing at a local path", async () => {
    const outcome = await ingester({ reader: stubReader({}) }).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "/var/data/somebody-elses.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    // Reading an arbitrary filesystem path on the strength of a job payload is
    // exactly the thing not to do here.
    expect(outcome.status).toBe("content_fail");
    expect(outcome.status === "content_fail" ? outcome.reason : "").toContain("unsupported attachment scheme");
  });

  it("fetches an https:// image through the same downloader as every other tier", async () => {
    const outcome = await ingester({ fetchImpl: respond(Buffer.alloc(48, 9), "image/jpeg") }).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "https://cdn.example.com/a.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("success");
    const candidate = outcome.status === "success" ? (outcome.result as { candidates: Array<{ path: string }> }).candidates[0]! : undefined;
    await expect(fs.readFile(path.join(repoRoot, candidate!.path))).resolves.toHaveLength(48);
  });

  it("refuses an https:// image whose content type is not one", async () => {
    // The failure this guards: an HTML error page saved as .jpg, which fails
    // much later and much less clearly.
    const outcome = await ingester({ fetchImpl: respond(Buffer.from("<html>nope</html>"), "text/html") }).execute(
      { repoRoot, runId: "run_1", assets: [{ uri: "https://cdn.example.com/a.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("content_fail");
    expect(outcome.status === "content_fail" ? outcome.reason : "").toContain("usable image");
  });

  describe('kind: "video" — the clip pipeline\'s source', () => {
    it("keeps the video extension and says nothing about slides", async () => {
      const reader = stubReader({ "clients/c1/run-attachments/ep12.mov": Buffer.alloc(128, 4) });
      const outcome = await ingester({ reader }).execute(
        {
          repoRoot,
          runId: "run_1",
          kind: "video",
          assets: [{ uri: "gs://bucket/clients/c1/run-attachments/ep12.mov", slot: 1, label: "episode 12" }],
        },
        { ctx: CTX },
      );

      expect(outcome.status).toBe("success");
      const candidate = outcome.status === "success" ? (outcome.result as { candidates: Array<{ path: string; description: string }> }).candidates[0]! : undefined;
      // .mov preserved, not rewritten to .png by the image table — ffmpeg and
      // the transcriber both key off the extension.
      expect(candidate!.path).toBe(".media-cache/run_1/n1-client0.mov");
      await expect(fs.readFile(path.join(repoRoot, candidate!.path))).resolves.toHaveLength(128);
      // A source video is the footage a clip is cut from, not a candidate
      // competing for a slot, and the only reader of this line is a human.
      expect(candidate!.description).not.toContain("slide");
      expect(candidate!.description).toContain("source video");
      expect(candidate!.description).toContain("episode 12");
    });

    it("accepts a video an image ingest would have refused on type", async () => {
      const big = Buffer.alloc(20 * 1024 * 1024, 1); // over the 12 MB image ceiling
      const outcome = await ingester({ fetchImpl: respond(big, "video/mp4") }).execute(
        { repoRoot, runId: "run_1", kind: "video", assets: [{ uri: "https://cdn.example.com/ep.mp4", slot: 1 }] },
        { ctx: CTX },
      );
      expect(outcome.status).toBe("success");
      const candidate = outcome.status === "success" ? (outcome.result as { candidates: Array<{ path: string }> }).candidates[0]! : undefined;
      expect(candidate!.path).toBe(".media-cache/run_1/n1-client-source.mp4");
    });

    it("still refuses a non-video content type", async () => {
      const outcome = await ingester({ fetchImpl: respond(Buffer.from("<html>"), "text/html") }).execute(
        { repoRoot, runId: "run_1", kind: "video", assets: [{ uri: "https://cdn.example.com/ep.mp4", slot: 1 }] },
        { ctx: CTX },
      );
      expect(outcome.status).toBe("content_fail");
      expect(outcome.status === "content_fail" ? outcome.reason : "").toContain("usable video");
    });

    it("defaults to the image tables when no kind is given, so existing callers are unchanged", async () => {
      const outcome = await ingester({ fetchImpl: respond(Buffer.alloc(16, 2), "image/png") }).execute(
        { repoRoot, runId: "run_1", assets: [{ uri: "https://cdn.example.com/a.png", slot: 1 }] },
        { ctx: CTX },
      );
      expect(outcome.status).toBe("success");
      const candidate = outcome.status === "success" ? (outcome.result as { candidates: Array<{ description: string }> }).candidates[0]! : undefined;
      expect(candidate!.description).toContain("slide 1 candidate");
    });
  });

  it("refuses a runId that would place the cache outside the bounds root", async () => {
    const outcome = await ingester({ reader: stubReader({}) }).execute(
      { repoRoot, runId: "../../etc", assets: [{ uri: "gs://bucket/a.jpg", slot: 1 }] },
      { ctx: CTX },
    );
    // tooling_error, not content_fail: a traversal in a runId is a defect in
    // the caller, never a judgment about the media.
    expect(outcome.status).toBe("tooling_error");
  });
});
