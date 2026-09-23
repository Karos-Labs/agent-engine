import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { decodePngPixels } from "@agent-engine/tool-common";
import { createCutout, createKarosMediaTools, removeUniformBackground } from "../src/index.js";

/**
 * `media.cutout` (2026-09-23, stage 2 of the reference-looks plan): the
 * Karos Labs reference sets a Liquid Death can on its own ground. A product
 * shot on a seamless background is lifted off it; anything else is refused
 * with the measured reason rather than cut badly.
 */

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

/** A frame of `bg` with a `fg` rectangle, optionally with a noisy border. */
function frame(w: number, h: number, bg: number[], fg: number[], rect: [number, number, number, number], noisyBorder = false): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
      let c = inside ? fg : bg;
      if (noisyBorder && !inside && (x + y) % 3 === 0) c = [(x * 37) % 255, (y * 53) % 255, ((x + y) * 11) % 255];
      data.set([c[0]!, c[1]!, c[2]!, 255], i);
    }
  }
  return data;
}

/** A minimal RGBA PNG encoder, so the real-browser case has a real file. */
function encodePng(data: Uint8ClampedArray, w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("removeUniformBackground", () => {
  it("lifts a red can off white: the ground goes transparent, the can stays opaque, and the box is the can", () => {
    const out = removeUniformBackground(frame(100, 120, [250, 250, 250], [200, 30, 40], [30, 20, 40, 80]), 100, 120);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bbox).toEqual({ x: 30, y: 20, w: 40, h: 80 });
    expect(out.data[3]).toBe(0);
    expect(out.data[(60 * 100 + 50) * 4 + 3]).toBe(255);
    expect(out.coverage).toBeCloseTo((40 * 80) / (100 * 120), 3);
  });

  it("keeps a white label INSIDE the product, because the product's outline separates it from the edge", () => {
    const data = frame(100, 120, [250, 250, 250], [200, 30, 40], [30, 20, 40, 80]);
    for (let y = 50; y < 60; y++) for (let x = 40; x < 60; x++) data.set([250, 250, 250, 255], (y * 100 + x) * 4);
    const out = removeUniformBackground(data, 100, 120);
    expect(out.ok && out.data[(55 * 100 + 50) * 4 + 3]).toBe(255);
  });

  it("refuses a busy background with the measured reason, and a frame with nothing on it", () => {
    const busy = removeUniformBackground(frame(100, 120, [250, 250, 250], [200, 30, 40], [30, 20, 40, 80], true), 100, 120);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toContain("not one colour");
    const empty = removeUniformBackground(frame(100, 120, [250, 250, 250], [250, 250, 250], [0, 0, 1, 1]), 100, 120);
    expect(empty.ok).toBe(false);
  });
});

describe("media.cutout", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-cutout-"));
    await fs.mkdir(path.join(repoRoot, "client-media"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "client-media", "can.png"), encodePng(frame(100, 120, [250, 250, 250], [200, 30, 40], [30, 20, 40, 80]), 100, 120));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("is registered, refuses an escaping path, and turns a refusal into a content_fail with the reason", async () => {
    expect(createKarosMediaTools({ env: {} })["media.cutout"]).toBeDefined();
    const refusing = createCutout({ runner: async () => ({ ok: false, reason: "the background is not one colour" }) });
    expect((await refusing.execute({ repoRoot, runId: "r1", image: "../x.png" }, { ctx: CTX })).status).toBe("tooling_error");
    const refused = await refusing.execute({ repoRoot, runId: "r1", image: "client-media/can.png" }, { ctx: CTX });
    expect(refused.status).toBe("content_fail");
    expect((refused as { reason: string }).reason).toContain("not one colour");
  });

  it("cuts a real PNG out in real Chromium and writes a transparent PNG trimmed to the can", async () => {
    const out = await createCutout().execute({ repoRoot, runId: "r1", image: "client-media/can.png" }, { ctx: CTX });
    expect(out.status).toBe("success");
    const result = (out as { result: { path: string; width: number; height: number } }).result;
    expect([result.width, result.height]).toEqual([40, 80]);
    // The written file really is a transparent PNG of the can: RGBA, the can's
    // own size, a see-through corner pixel's worth of ground trimmed away.
    const decoded = decodePngPixels(await fs.readFile(path.join(repoRoot, result.path)));
    expect(decoded?.header.width).toBe(40);
    expect(decoded?.header.height).toBe(80);
    expect(decoded?.header.colorType).toBe(6);
  }, 60_000);
});
