import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import type { AgentContext, AgentTool } from "@agent-engine/core";
import {
  MEDIA_LIBRARY_LIMIT,
  MEDIA_LIBRARY_SCHEMA_ID,
  MEDIA_LIBRARY_SEGMENTS,
  createMediaLibraryTools,
  sceneTagsFor,
  type MediaLibraryAddResult,
  type MediaLibraryDocument,
  type MediaLibraryEntry,
  type MediaLibraryListResult,
} from "../src/media-library.js";
import { createKarosMediaTools } from "../src/index.js";

/**
 * RFC-14 item T — the client media library.
 *
 * The two load-bearing properties here are content addressing and the reuse
 * exclusions. Content addressing is what stops the same photograph being filed
 * once per upload (which would defeat the use history entirely); the
 * exclusions are the enforceable half of "never reuses the same frame twice in
 * a row". Both are asserted on the stored document, not on a return value a
 * bug could fabricate.
 */

const CTX: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
const CTX_RUN_2: AgentContext = { ...CTX, runId: "run_2" };

/** A 1x1 PNG. Real bytes, so the sha256 the tool computes is a real hash of a real file. */
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
/** A different 1x1 PNG (black rather than transparent), so two entries can exist without contriving one. */
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
  "base64",
);

const RIGHTS = { source: "client-upload", licence: "client-supplied — owned by the client, uploaded deliberately for this post" };

describe("media library", () => {
  let rootDir: string;
  let repoRoot: string;
  let store: WorkspaceStore;
  let add: AgentTool;
  let list: AgentTool;
  /** Fixed clock, so `addedAt` ordering in the assertions is the ordering the test wrote rather than whatever the machine was doing. */
  let clock: number;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-media-library-"));
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-media-library-repo-"));
    await fs.mkdir(path.join(repoRoot, ".media-cache", "run_1"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".media-cache", "run_1", "n1-client.png"), PNG_A);
    await fs.writeFile(path.join(repoRoot, ".media-cache", "run_1", "n2-client.png"), PNG_B);
    // The same bytes as n1, under a different name and a different run's
    // directory — the "re-uploaded next week" case content addressing exists for.
    await fs.mkdir(path.join(repoRoot, ".media-cache", "run_2"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".media-cache", "run_2", "n4-client.png"), PNG_A);

    store = new WorkspaceStore(rootDir);
    clock = Date.parse("2026-09-11T09:00:00.000Z");
    const tools = createMediaLibraryTools({ store, now: () => new Date((clock += 1000)) });
    add = tools["media.libraryAdd"] as unknown as AgentTool;
    list = tools["media.libraryList"] as unknown as AgentTool;
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function stored(): Promise<MediaLibraryDocument | undefined> {
    return store.readJson<MediaLibraryDocument>("acme", [...MEDIA_LIBRARY_SEGMENTS]);
  }

  async function fileOne(
    overrides: Record<string, unknown> = {},
    ctx: AgentContext = CTX,
  ): Promise<MediaLibraryAddResult> {
    const outcome = await add.execute(
      {
        repoRoot,
        entries: [
          {
            path: ".media-cache/run_1/n1-client.png",
            gcsUri: "gs://karoscmo-uploads/acme/hero.png",
            rights: RIGHTS,
            description: "The founder on a conference stage, mid-sentence, warm side light.",
            subjects: ["founder", "conference stage"],
            textInImage: ["KAROS 2026"],
            mood: "energetic",
            inspectedByToolVersion: "1.0.0",
            ...overrides,
          },
        ],
      },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(`expected success, got ${outcome.status}: ${"reason" in outcome ? outcome.reason : ""}`);
    return outcome.result as MediaLibraryAddResult;
  }

  // ── Content addressing ──

  it("files the same bytes once, however many times and under whatever name they are offered", async () => {
    const first = await fileOne();
    expect(first.created).toHaveLength(1);

    // Same file, same call shape — a retried 05z.
    const second = await fileOne();
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual(first.created);

    // Same BYTES, different filename, different run — next week's re-upload.
    const third = await fileOne({ path: ".media-cache/run_2/n4-client.png" }, CTX_RUN_2);
    expect(third.created).toEqual([]);
    expect(third.updated).toEqual(first.created);

    const doc = await stored();
    expect(doc?.entries).toHaveLength(1);
    // The first sighting owns the entry's age: the library's ordering (and its
    // eviction) is about when a frame entered the archive.
    expect(doc?.entries[0]!.addedByRunId).toBe("run_1");
    // Both paths are remembered, because ledger.listUsedImages records PATHS
    // and its rules stay authoritative.
    expect(doc?.entries[0]!.knownPaths).toEqual([".media-cache/run_1/n1-client.png", ".media-cache/run_2/n4-client.png"]);
    expect(doc?.entries[0]!.assetId).toHaveLength(16);
    expect(doc?.entries[0]!.assetId).toBe(doc?.entries[0]!.sha256.slice(0, 16));
  });

  it("keeps the stored inspection rather than asking for it again — the whole saving", async () => {
    await fileOne();
    const doc = await stored();
    const entry = doc!.entries[0]!;
    expect(entry.description).toContain("conference stage");
    expect(entry.subjects).toEqual(["founder", "conference stage"]);
    expect(entry.textInImage).toEqual(["KAROS 2026"]);
    expect(entry.inspectedByToolVersion).toBe("1.0.0");
    expect(entry.contentType).toBe("image/png");
    expect(entry.bytes).toBe(PNG_A.byteLength);
  });

  // ── usedIn ──

  it("appends a (run, slide) use idempotently, so a resumed delivery double-counts nothing", async () => {
    await fileOne();
    const firstShip = await fileOne({ usedInSlides: [1, 3] });
    expect(firstShip.usesAppended).toBe(2);

    const retry = await fileOne({ usedInSlides: [1, 3] });
    expect(retry.usesAppended).toBe(0);

    // The same frame on a new slide in a NEW run is a genuinely new use.
    const nextWeek = await fileOne({ path: ".media-cache/run_2/n4-client.png", usedInSlides: [1] }, CTX_RUN_2);
    expect(nextWeek.usesAppended).toBe(1);

    const doc = await stored();
    expect(doc?.entries[0]!.usedIn.map((u) => `${u.runId}#${u.slide}`)).toEqual(["run_1#1", "run_1#3", "run_2#1"]);
  });

  it("records a use against the calling run, never a run id the caller names", async () => {
    await fileOne();
    // `runId` is not an input field at all: the tool reads it from the agent
    // context, which is what keeps tenancy and provenance structural rather
    // than conventional.
    const result = await fileOne({ usedInSlides: [2], runId: "run_999" } as Record<string, unknown>);
    expect(result.usesAppended).toBe(1);
    const doc = await stored();
    expect(doc?.entries[0]!.usedIn.map((u) => u.runId)).toEqual(["run_1"]);
  });

  // ── What a new row must carry ──

  it("refuses to create a row that cannot be re-fetched or read back, and says which field was missing", async () => {
    for (const [field, entry] of [
      ["gcsUri", { path: ".media-cache/run_1/n1-client.png", rights: RIGHTS, description: "a founder on a stage" }],
      ["description", { path: ".media-cache/run_1/n1-client.png", gcsUri: "gs://b/o.png", rights: RIGHTS }],
      ["rights", { path: ".media-cache/run_1/n1-client.png", gcsUri: "gs://b/o.png", description: "a founder on a stage" }],
    ] as const) {
      const outcome = await add.execute({ repoRoot, entries: [entry] }, { ctx: CTX });
      expect(outcome.status).toBe("success");
      const result = (outcome as { result: MediaLibraryAddResult }).result;
      expect(result.created).toEqual([]);
      expect(result.skipped[0]!.reason).toContain(field);
    }
    // Nothing was filed, and in particular no placeholder row was invented.
    expect(await stored()).toBeUndefined();
  });

  it("skips a path outside the media cache or outside the repo root, and files the rest of the batch", async () => {
    const outcome = await add.execute(
      {
        repoRoot,
        entries: [
          { path: "../secrets.png", gcsUri: "gs://b/o.png", rights: RIGHTS, description: "x" },
          { path: "assets/logo.png", gcsUri: "gs://b/o.png", rights: RIGHTS, description: "x" },
          { path: ".media-cache/run_1/n1-client.png", gcsUri: "gs://b/o.png", rights: RIGHTS, description: "a founder on a stage" },
        ],
      },
      { ctx: CTX },
    );
    const result = (outcome as { result: MediaLibraryAddResult }).result;
    expect(result.created).toHaveLength(1);
    expect(result.skipped.map((s) => s.reason)).toEqual([expect.stringContaining("escapes repoRoot"), expect.stringContaining(".media-cache/")]);
  });

  // ── Retrieval ──

  it("matches a scene query case-insensitively and through the marks a script writes optionally", async () => {
    await fileOne({
      description: "A founder on a Conference Stage.",
      subjects: ["Conference Stage", "Café terrace"],
      mood: "Energetic",
    });

    for (const query of ["conference stage", "CONFERENCE", "cafe", "café", "Café"]) {
      const outcome = await list.execute({ sceneTags: [query] }, { ctx: CTX });
      const result = (outcome as { result: MediaLibraryListResult }).result;
      expect(result.entries, `query "${query}" should match`).toHaveLength(1);
    }

    const miss = await list.execute({ sceneTags: ["submarine"] }, { ctx: CTX });
    expect((miss as { result: MediaLibraryListResult }).result.entries).toEqual([]);
  });

  it("matches a Hebrew scene against a Hebrew tag, niqqud or not", async () => {
    // The pointed and unpointed spellings of the same word: `toLowerCase()` is
    // a no-op in Hebrew, so without mark folding these would be two different
    // tags and a real client's library would simply never match.
    await fileOne({ subjects: ["כַּדוּרֶגֶל", "אצטדיון"], mood: "חגיגי", description: "שחקנים על הדשא באצטדיון." });

    for (const query of ["כדורגל", "כַּדוּרֶגֶל", "אצטדיון", "משחק כדורגל בערב"]) {
      const outcome = await list.execute({ sceneTags: [query] }, { ctx: CTX });
      expect((outcome as { result: MediaLibraryListResult }).result.entries, `query "${query}" should match`).toHaveLength(1);
    }
  });

  it("excludes a frame that shipped in a named run — the previous post's frame, which is the whole 'never twice in a row' rule", async () => {
    await fileOne({ usedInSlides: [1] });
    await fileOne({ path: ".media-cache/run_1/n2-client.png", gcsUri: "gs://b/second.png", description: "An empty lecture hall." });

    const all = await list.execute({}, { ctx: CTX });
    expect((all as { result: MediaLibraryListResult }).result.entries).toHaveLength(2);

    const filtered = await list.execute({ excludeUsedInRunIds: ["run_1"] }, { ctx: CTX });
    const result = (filtered as { result: MediaLibraryListResult }).result;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.description).toContain("lecture hall");
    expect(result.total).toBe(2);
    expect(result.matched).toBe(1);
  });

  it("returns the newest first and honours the limit", async () => {
    await fileOne();
    await fileOne({ path: ".media-cache/run_1/n2-client.png", gcsUri: "gs://b/second.png", description: "An empty lecture hall." });

    const outcome = await list.execute({ limit: 1 }, { ctx: CTX });
    const result = (outcome as { result: MediaLibraryListResult }).result;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.description).toContain("lecture hall");
    expect(result.matched).toBe(2);
  });

  it("permits a re-inspection on a version mismatch rather than hiding the frame", async () => {
    await fileOne({ inspectedByToolVersion: "1.0.0" });

    const outcome = await list.execute({ currentInspectionVersion: "1.1.0" }, { ctx: CTX });
    const result = (outcome as { result: MediaLibraryListResult }).result;
    // Still returned, with its stored description intact — a stale sentence
    // about a real photograph is still a true sentence about a real photograph.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.description).toContain("conference stage");
    expect(result.staleInspections).toEqual([result.entries[0]!.assetId]);

    const matching = await list.execute({ currentInspectionVersion: "1.0.0" }, { ctx: CTX });
    expect((matching as { result: MediaLibraryListResult }).result.staleInspections).toEqual([]);
  });

  // ── Cap and eviction ──

  it("drops the oldest entry that never shipped when the cap is reached, and never an object", async () => {
    const seeded: MediaLibraryEntry[] = Array.from({ length: MEDIA_LIBRARY_LIMIT }, (_, i) => ({
      assetId: `seed${String(i).padStart(12, "0")}`,
      sha256: `seed${String(i).padStart(60, "0")}`,
      gcsUri: `gs://karoscmo-uploads/acme/seed-${i}.png`,
      contentType: "image/png",
      bytes: 100,
      addedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(),
      addedByRunId: `seed_${i}`,
      rights: RIGHTS,
      description: `seeded frame ${i}`,
      subjects: [],
      textInImage: [],
      mood: "",
      inspectedByToolVersion: "1.0.0",
      sceneTags: [],
      knownPaths: [],
      // The two OLDEST have shipped, so the eviction must skip past them.
      usedIn: i < 2 ? [{ runId: `seed_${i}`, slide: 1, at: "2026-01-01T00:00:00.000Z" }] : [],
    }));
    await store.writeJson("acme", [...MEDIA_LIBRARY_SEGMENTS], {
      schema: MEDIA_LIBRARY_SCHEMA_ID,
      clientSlug: "acme",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: seeded,
    } satisfies MediaLibraryDocument);

    const result = await fileOne();
    expect(result.created).toHaveLength(1);
    expect(result.evicted.map((e) => e.assetId)).toEqual([seeded[2]!.assetId]);
    expect(result.evicted[0]!.reason).toContain("never shipped");
    expect(result.total).toBe(MEDIA_LIBRARY_LIMIT);

    const doc = await stored();
    expect(doc?.entries).toHaveLength(MEDIA_LIBRARY_LIMIT);
    // The two shipped frames are still on file: they are the evidence about
    // what must not be reused, which is precisely what eviction must not lose.
    expect(doc?.entries[0]!.assetId).toBe(seeded[0]!.assetId);
    expect(doc?.entries[1]!.assetId).toBe(seeded[1]!.assetId);
  });

  // ── Degrading honestly ──

  it("reports not_available with no store configured, and never an empty library that looks real", async () => {
    const tools = createMediaLibraryTools({});
    const listOutcome = await (tools["media.libraryList"] as unknown as AgentTool).execute({}, { ctx: CTX });
    expect(listOutcome.status).toBe("not_available");
    expect("result" in listOutcome).toBe(false);

    const addOutcome = await (tools["media.libraryAdd"] as unknown as AgentTool).execute(
      { repoRoot, entries: [{ path: ".media-cache/run_1/n1-client.png", gcsUri: "gs://b/o.png", rights: RIGHTS, description: "x" }] },
      { ctx: CTX },
    );
    expect(addOutcome.status).toBe("not_available");
  });

  it("refuses to overwrite a library it cannot parse, rather than starting a fresh one over the top", async () => {
    await store.writeJson("acme", [...MEDIA_LIBRARY_SEGMENTS], { schema: "something-else", entries: "not an array" });

    const addOutcome = await add.execute(
      { repoRoot, entries: [{ path: ".media-cache/run_1/n1-client.png", gcsUri: "gs://b/o.png", rights: RIGHTS, description: "x" }] },
      { ctx: CTX },
    );
    expect(addOutcome.status).toBe("tooling_error");
    expect("reason" in addOutcome && addOutcome.reason).toContain("refusing to overwrite");

    const listOutcome = await list.execute({}, { ctx: CTX });
    expect(listOutcome.status).toBe("tooling_error");

    // Untouched: a caller whose library write is best-effort loses a note, not an archive.
    expect(await store.readJson("acme", [...MEDIA_LIBRARY_SEGMENTS])).toMatchObject({ schema: "something-else" });
  });

  it("reads back an empty library as empty, so a first run degrades to the tiers below with nothing special happening", async () => {
    const outcome = await list.execute({}, { ctx: CTX });
    expect(outcome.status).toBe("success");
    expect((outcome as { result: MediaLibraryListResult }).result).toEqual({ entries: [], total: 0, matched: 0, staleInspections: [] });
  });

  // ── Registration ──

  it("registers both tools in the media registry at 1.0.0", () => {
    const tools = createKarosMediaTools({ env: {}, store });
    expect(tools["media.libraryAdd"]?.version).toBe("1.0.0");
    expect(tools["media.libraryList"]?.version).toBe("1.0.0");
  });
});

describe("sceneTagsFor", () => {
  it("indexes the whole phrase AND its words, because a query and a subject rarely agree on granularity", () => {
    expect(sceneTagsFor(["Conference Stage"], "")).toEqual(["conference stage", "conference", "stage"]);
  });

  it("drops one-character noise and de-duplicates across subjects and mood", () => {
    expect(sceneTagsFor(["a laptop", "laptop"], "calm")).toEqual(["a laptop", "laptop", "calm"]);
  });

  it("derives tags in code from what the vision pass already said — never a second model call", () => {
    // `mood` is part of the index, not decoration: "energetic" is how a scene
    // brief actually asks for a picture.
    expect(sceneTagsFor(["founder"], "energetic")).toContain("energetic");
  });
});
