import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { boxFrom2d, createLocateInImage } from "../src/locate-in-image.js";
import type { VisionAnalysisClient } from "../src/visual-patterns.js";

/** 2026-09-26: where named things sit in a picture, for labels with arrows (the owner's grapes reference). */
const fakeClient = (reply: unknown): VisionAnalysisClient => ({
  models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) },
});
const ctx = { ctx: { runId: "r", clientSlug: "c", productId: "instagram-agent", runKind: "recurring" as const, metadata: {} } };

describe("media.locateInImage", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "locate-"));
  writeFileSync(path.join(root, "grapes.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  it("returns a 0..1 box per target, in order, and found:false where the model is not sure", async () => {
    const tool = createLocateInImage({ client: fakeClient({ items: [
      { target: "the green stem", found: true, confidence: 0.9, box_2d: [100, 50, 700, 450] },
      { target: "a price tag", found: false, confidence: 0.1 },
    ] }) });
    const out = await tool.execute({ repoRoot: root, image: "grapes.jpg", targets: ["the green stem", "a price tag"] }, ctx);
    expect(out.status).toBe("success");
    if (out.status !== "success") throw new Error("unreachable");
    expect(out.result.located[0]).toEqual({ target: "the green stem", found: true, confidence: 0.9, box: { x0: 0.05, y0: 0.1, x1: 0.45, y1: 0.7 } });
    expect(out.result.located[1]!.found).toBe(false);
  });

  it("refuses a degenerate box and a path outside the root, and is not_available without a credential", async () => {
    expect(boxFrom2d([100, 100, 105, 900])).toBeUndefined();
    expect(boxFrom2d("nope")).toBeUndefined();
    const escape = await createLocateInImage({ client: fakeClient({ items: [] }) }).execute({ repoRoot: root, image: "../x.jpg", targets: ["a"] }, ctx);
    expect(escape.status).toBe("tooling_error");
    const none = await createLocateInImage().execute({ repoRoot: root, image: "grapes.jpg", targets: ["a"] }, ctx);
    expect(none.status).toBe("not_available");
  });
});
