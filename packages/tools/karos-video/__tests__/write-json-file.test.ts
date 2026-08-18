import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createWriteJsonFile } from "../src/tools/write-json-file.js";
import { ctx } from "./test-helpers.js";

describe("video.writeJsonFile", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates parent directories and writes pretty-printed JSON", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-write-"));
    const target = path.join(dir, "nested", "job.json");
    const tool = createWriteJsonFile();

    const outcome = await tool.execute({ path: target, data: { segments: [[0, 1]] } }, { ctx });
    expect(outcome.status).toBe("success");

    const written = JSON.parse(await readFile(target, "utf8"));
    expect(written).toEqual({ segments: [[0, 1]] });
  });

  it("is a tooling_error when the path is unwritable (a NUL byte, invalid on every platform Node targets)", async () => {
    const tool = createWriteJsonFile();
    const outcome = await tool.execute({ path: "/tmp/invalid\0path.json", data: {} }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});
