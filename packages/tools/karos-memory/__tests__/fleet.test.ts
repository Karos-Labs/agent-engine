import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosMemoryTools, FLEET_ROWS_MAX, type FleetDocument } from "../src/index.js";

const ctxFor = (clientSlug: string): AgentContext => ({ runId: `run_${clientSlug}`, clientSlug, productId: "instagram-agent", runKind: "recurring", metadata: {} });

describe("fleet-scoped memory (2026-09-24)", () => {
  let rootDir: string;
  let tools: ReturnType<typeof createKarosMemoryTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-fleet-"));
    tools = createKarosMemoryTools(new WorkspaceStore(rootDir));
  });
  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const read = async (clientSlug: string): Promise<FleetDocument> => {
    const out = await tools["memory.readFleet"]!.execute({ key: "instagramCrossClientFormats" }, { ctx: ctxFor(clientSlug) });
    if (out.status !== "success") throw new Error(`memory.readFleet: ${out.status}`);
    return (out.result as { document: FleetDocument }).document;
  };

  it("a row one client appends is visible to every other client, which is the whole point", async () => {
    expect((await read("geektime")).entries).toEqual([]);
    await tools["memory.appendFleetRow"]!.execute({ key: "instagramCrossClientFormats", row: { at: "2026-09-24T10:00:00Z", runId: "r1", seriesId: "by_the_numbers", systemId: "s1", skeleton: "cover|stat|closer" } }, { ctx: ctxFor("karoslabs") });
    const seen = await read("geektime");
    expect(seen.entries).toHaveLength(1);
    expect(seen.entries[0]).toMatchObject({ clientSlug: "karoslabs", seriesId: "by_the_numbers", skeleton: "cover|stat|closer" });
  });

  it("stamps the caller's own slug, so no client can write a row as another", async () => {
    await tools["memory.appendFleetRow"]!.execute({ key: "instagramCrossClientFormats", row: { at: "t", runId: "r1", clientSlug: "geektime", seriesId: "x", systemId: "y" } }, { ctx: ctxFor("hankypanky") });
    expect((await read("sitti")).entries[0]!["clientSlug"]).toBe("hankypanky");
  });

  it("replaces a row with the same dedupe key instead of counting it twice, and keeps only the newest rows", async () => {
    const append = (runId: string, clientSlug = "xodigital") =>
      tools["memory.appendFleetRow"]!.execute({ key: "instagramCrossClientFormats", row: { at: runId, runId, seriesId: "s", systemId: "y" }, dedupeOn: ["clientSlug", "runId"] }, { ctx: ctxFor(clientSlug) });
    await append("r1");
    await append("r1");
    expect((await read("x")).entries).toHaveLength(1);
    for (let i = 0; i < FLEET_ROWS_MAX + 5; i++) await append(`n${i}`, "sitti");
    const doc = await read("x");
    expect(doc.entries).toHaveLength(FLEET_ROWS_MAX);
    expect(doc.entries.at(-1)!["runId"]).toBe(`n${FLEET_ROWS_MAX + 4}`);
  });

  it("refuses any key that is not on the allowlist", async () => {
    const out = await tools["memory.appendFleetRow"]!.execute({ key: "somethingElse" as never, row: { a: "b" } }, { ctx: ctxFor("acme") });
    expect(out.status).not.toBe("success");
  });
});
