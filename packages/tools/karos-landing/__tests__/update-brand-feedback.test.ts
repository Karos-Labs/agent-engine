import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createUpdateBrandFeedback } from "../src/update-brand-feedback/update-brand-feedback-tool.js";
import { testCtx } from "./test-helpers.js";

function baseEntry(round: number) {
  return {
    round,
    reviewedBuild: "v1",
    submittedAt: "2026-06-26T14:00:00Z",
    source: "portal",
    applied: [{ section: "hero", op: "edit" }],
    kept: [],
    outOfScope: [],
  };
}

describe("landing.updateBrandFeedback", () => {
  let tmpRoot: string;
  let bundlesRoot: string;
  let brandPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "landing-update-feedback-"));
    bundlesRoot = path.join(tmpRoot, "bundles");
    await fs.mkdir(path.join(bundlesRoot, "forge"), { recursive: true });
    brandPath = path.join(bundlesRoot, "forge", "brand.json");
    await fs.writeFile(brandPath, JSON.stringify({ client: "forge", tokens: { colors: {} }, fonts: { display: "A", body: "B" } }));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeTool() {
    return createUpdateBrandFeedback({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
  }

  it("appends round 1 and sets lastRound when no feedback field exists yet", async () => {
    const tool = makeTool();
    const outcome = await tool.execute({ entry: baseEntry(1) }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.result.lastRound).toBe(1);

    const written = JSON.parse(await fs.readFile(brandPath, "utf8"));
    expect(written.feedback.lastRound).toBe(1);
    expect(written.feedback.rounds).toHaveLength(1);
    expect(written.feedback.rounds[0].applied).toEqual([{ section: "hero", op: "edit" }]);
  });

  it("rejects a round number that isn't exactly the next expected one — never silently re-applies or skips", async () => {
    const tool = makeTool();
    await tool.execute({ entry: baseEntry(1) }, { ctx: testCtx({ clientSlug: "forge" }) });

    const reapply = await tool.execute({ entry: baseEntry(1) }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(reapply.status).toBe("content_fail");

    const skip = await tool.execute({ entry: baseEntry(3) }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(skip.status).toBe("content_fail");
  });

  it("accepts round 2 after round 1 has been recorded — append-only history", async () => {
    const tool = makeTool();
    await tool.execute({ entry: baseEntry(1) }, { ctx: testCtx({ clientSlug: "forge" }) });
    const second = await tool.execute({ entry: baseEntry(2) }, { ctx: testCtx({ clientSlug: "forge" }) });
    expect(second.status).toBe("success");

    const written = JSON.parse(await fs.readFile(brandPath, "utf8"));
    expect(written.feedback.lastRound).toBe(2);
    expect(written.feedback.rounds).toHaveLength(2);
  });

  it("returns tooling_error when brand.json doesn't exist", async () => {
    const tool = createUpdateBrandFeedback({ templateRoot: path.join(tmpRoot, "template"), engineClientsRoot: path.join(tmpRoot, "clients"), bundlesRoot });
    const outcome = await tool.execute({ entry: baseEntry(1) }, { ctx: testCtx({ clientSlug: "nobody" }) });
    expect(outcome.status).toBe("tooling_error");
  });
});
