import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createReadJsonFile } from "../src/tools/read-json-file.js";
import { ctx } from "./test-helpers.js";

describe("video.readJsonFile", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads and parses an on-disk JSON file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-read-"));
    const target = path.join(dir, "brand-profile.json");
    await writeFile(target, JSON.stringify({ color: { background: "#000000" } }), "utf8");

    const tool = createReadJsonFile();
    const outcome = await tool.execute({ path: target }, { ctx });

    expect(outcome).toEqual({ status: "success", result: { path: target, data: { color: { background: "#000000" } } } });
  });

  it("is a tooling_error when the file does not exist", async () => {
    const tool = createReadJsonFile();
    const outcome = await tool.execute({ path: "/does/not/exist.json" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("is a tooling_error on malformed JSON, never a silent partial parse", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "karos-video-read-"));
    const target = path.join(dir, "broken.json");
    await writeFile(target, "{not valid json", "utf8");

    const tool = createReadJsonFile();
    const outcome = await tool.execute({ path: target }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  describe("with a configured workRoot", () => {
    it("reads from inside the caller's own tenant directory", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "karos-video-read-"));
      const tenantDir = path.join(dir, "acme");
      await mkdir(tenantDir, { recursive: true });
      const target = path.join(tenantDir, "brand-profile.json");
      await writeFile(target, JSON.stringify({ ok: true }), "utf8");

      const tool = createReadJsonFile({ workRoot: dir });
      const outcome = await tool.execute({ path: target }, { ctx });
      expect(outcome.status).toBe("success");
    });

    it("rejects a read from a different client's tenant directory", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "karos-video-read-"));
      const otherDir = path.join(dir, "someone-elses-company");
      await mkdir(otherDir, { recursive: true });
      const target = path.join(otherDir, "brand-profile.json");
      await writeFile(target, JSON.stringify({ secret: true }), "utf8");

      const tool = createReadJsonFile({ workRoot: dir });
      const outcome = await tool.execute({ path: target }, { ctx });
      expect(outcome.status).toBe("tooling_error");
    });
  });
});
