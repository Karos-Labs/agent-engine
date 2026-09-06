import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMaterializeInputs, type MaterializeObjectReader } from "../src/tools/materialize-inputs.js";
import { ctx, fakeRunner } from "./test-helpers.js";

function fakeReader(objects: Record<string, string>, bucketName = "karos-media"): MaterializeObjectReader & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    bucketName,
    downloads,
    async download(objectPath) {
      downloads.push(objectPath);
      const body = objects[objectPath];
      if (body === undefined) throw new Error(`no such object: ${objectPath}`);
      return Buffer.from(body, "utf8");
    },
  };
}

describe("video.materializeInputs", () => {
  let workDir: string;
  afterEach(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("passes local paths straight through, touching nothing and spawning nothing", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ workDir, videoPath: "/uploads/clip.mov" }, { ctx });

    expect(outcome).toEqual({ status: "success", result: { videoPath: "/uploads/clip.mov", fetched: [] } });
    expect(calls).toHaveLength(0);
  });

  it("downloads a gs:// source video into <workDir>/source/ through the bound media store", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const reader = fakeReader({ "uploads/acme/clip.mov": "fake video bytes" });
    const { runner } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", objectReader: reader });
    const outcome = await tool.execute({ workDir, videoPath: "gs://karos-media/uploads/acme/clip.mov" }, { ctx });

    if (outcome.status !== "success") throw new Error(`unexpected ${outcome.status}: ${(outcome as { reason?: string }).reason}`);
    expect(outcome.result.videoPath).toBe(path.join(workDir, "source", "clip.mov"));
    expect(await fs.readFile(outcome.result.videoPath, "utf8")).toBe("fake video bytes");
    expect(reader.downloads).toEqual(["uploads/acme/clip.mov"]);
    expect(outcome.result.fetched).toEqual(["gs://karos-media/uploads/acme/clip.mov"]);
  });

  it("refuses a gs:// URI naming a bucket the media store is not bound to — never a mis-read from the wrong bucket", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const reader = fakeReader({});
    const { runner } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", objectReader: reader });
    const outcome = await tool.execute({ workDir, videoPath: "gs://someone-elses-bucket/clip.mov" }, { ctx });

    expect(outcome.status).toBe("tooling_error");
    expect(reader.downloads).toEqual([]);
  });

  it("reports not_available for a gs:// input when no media store is configured — the caller learns why, nothing is guessed", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const { runner } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ workDir, videoPath: "gs://karos-media/clip.mov" }, { ctx });
    expect(outcome.status).toBe("not_available");
  });

  it("downloads the asset bundle, unpacks it through unpack_bundle.py into <workDir>/brand, and returns the profile inside it", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const reader = fakeReader({ "clients/acme/branded-shorts.zip": "PK fake zip" });
    // The fake "unpack" writes what a real unpack would: the profile at the bundle root.
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      const dest = args[args.indexOf("--dest") + 1]!;
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "brand-profile.json"), "{}", "utf8");
      return { stdout: `unpacked 1 files -> ${dest}`, stderr: "", exitCode: 0 };
    };
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", objectReader: reader });
    const outcome = await tool.execute({ workDir, videoPath: "/local/clip.mov", assetBundle: "gs://karos-media/clients/acme/branded-shorts.zip" }, { ctx });

    if (outcome.status !== "success") throw new Error(`unexpected ${outcome.status}: ${(outcome as { reason?: string }).reason}`);
    expect(calls[0]!.args).toEqual(["/engine/unpack_bundle.py", "--archive", path.join(workDir, "bundle", "branded-shorts.zip"), "--dest", path.join(workDir, "brand")]);
    expect(outcome.result.profilePath).toBe(path.join(workDir, "brand", "brand-profile.json"));
    expect(outcome.result.brandDir).toBe(path.join(workDir, "brand"));
    expect(outcome.result.videoPath).toBe("/local/clip.mov");
  });

  it("is a tooling_error when the bundle unpacks but holds no brand-profile.json at its root", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const runner = async (_command: string, args: string[]) => {
      const dest = args[args.indexOf("--dest") + 1]!;
      await fs.mkdir(dest, { recursive: true });
      return { stdout: `unpacked 0 files -> ${dest}`, stderr: "", exitCode: 0 };
    };
    const bundle = path.join(workDir, "bundle.zip");
    await fs.writeFile(bundle, "PK", "utf8");
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ workDir, videoPath: "/local/clip.mov", assetBundle: bundle }, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("brand-profile.json");
  });

  it("rejects a bundle that is not an archive before downloading or spawning anything", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialize-"));
    const reader = fakeReader({});
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createMaterializeInputs({ runner, engineDir: "/engine", objectReader: reader });
    const outcome = await tool.execute({ workDir, videoPath: "/local/clip.mov", assetBundle: "gs://karos-media/clients/acme/brand-profile.json" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect(calls).toHaveLength(0);
    expect(reader.downloads).toEqual([]);
  });
});
