import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKarosMediaTools, type ImageGenerationClient, type ReferenceContent } from "../src/index.js";
import { realPngBase64 } from "./image-fixtures.js";

/**
 * `image.generate` with `references` (2026-09-23, stage 2 of the owner's
 * reference-looks plan). The riverflow reference carousel is one bottle in
 * nine scenes with the same label every time; that is only possible when the
 * model is SHOWN the product rather than told about it.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;
const PNG_B64 = realPngBase64();

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-gen-ref-"));
  await fs.mkdir(path.join(repoRoot, "client-media"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "client-media", "bottle.png"), Buffer.from(PNG_B64, "base64"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const imageResponse = () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: PNG_B64, mimeType: "image/png" } }] } }] });

function capture(): { client: ImageGenerationClient; seen: Array<Parameters<ImageGenerationClient["models"]["generateContent"]>[0]> } {
  const seen: Array<Parameters<ImageGenerationClient["models"]["generateContent"]>[0]> = [];
  return {
    seen,
    client: {
      models: {
        async generateContent(req) {
          seen.push(req);
          return imageResponse() as never;
        },
      },
    },
  };
}

const tool = (client: ImageGenerationClient) => createKarosMediaTools({ env: {}, generationClient: client })["image.generate"]!;

describe("image.generate with references", () => {
  it("sends the reference as inline data BEFORE the brief, and the brief tells the model to keep the product exactly", async () => {
    const { client, seen } = capture();
    const outcome = await tool(client).execute(
      { repoRoot, runId: "run_1", needs: [{ n: 2, prompt: "the bottle on a giant billboard on a brick building at golden hour", references: [{ path: "client-media/bottle.png", role: "product" }] }] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("success");
    const contents = seen[0]!.contents as ReferenceContent[];
    expect(Array.isArray(contents)).toBe(true);
    expect(contents[0]!.parts[0]).toEqual({ inlineData: { data: PNG_B64, mimeType: "image/png" } });
    const brief = (contents[0]!.parts[1] as { text: string }).text;
    expect(brief).toContain("Image 1 is the client's own product");
    expect(brief).toContain("the same shape, proportions, colours, label and printed text");
    // Its printed label must survive; every other word and mark stays banned.
    expect(brief).toContain("other than what is printed on the reference product or logo itself");
    expect(brief).not.toContain("no logos,");
  });

  it("never asks the model to invent the product: an unreadable or escaping reference is that need's named failure, and no call is made for it", async () => {
    const { client, seen } = capture();
    const outcome = await tool(client).execute(
      {
        repoRoot,
        runId: "run_1",
        needs: [
          { n: 1, prompt: "x", references: [{ path: "client-media/missing.png", role: "product" }] },
          { n: 2, prompt: "y", references: [{ path: "../outside.png", role: "product" }] },
          { n: 3, prompt: "z", references: [{ path: "client-media/bottle.gif", role: "product" }] },
        ],
      },
      { ctx: CTX },
    );
    expect(seen).toHaveLength(0);
    // Nothing produced at all is a content failure naming every slide's reason.
    expect(outcome.status).toBe("content_fail");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("slide 1 (reference 1 (client-media/missing.png) could not be read");
    expect(reason).toContain("slide 2 (reference 1 (../outside.png) is outside repoRoot)");
    expect(reason).toContain("slide 3 (reference 1 (client-media/bottle.gif) is not a PNG, JPEG or WebP)");
  });

  it("a need without references sends the same plain string brief it always did", async () => {
    const { client, seen } = capture();
    await tool(client).execute({ repoRoot, runId: "run_1", needs: [{ n: 1, prompt: "a quiet desk at dawn" }] }, { ctx: CTX });
    expect(typeof seen[0]!.contents).toBe("string");
    expect(seen[0]!.contents).toContain("no logos,");
  });
});
