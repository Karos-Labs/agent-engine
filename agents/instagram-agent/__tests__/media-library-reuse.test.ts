import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createMediaLibraryTools, type MediaLibraryEntry, type MediaLibraryListResult } from "@agent-engine/tool-karos-media";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  goodCopyOutput,
  goodResearchOutput,
  goodTrendScoutOutput,
  goodVisualDirection,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import { standardTurns } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { SKELETON_BELIEF_KEY } from "../src/workflow/skeleton-memory.js";
import { buildLibraryEntry, describeLibraryCandidate, groupShippedUses, libraryIngestRequest, selectLibraryCandidates } from "../src/workflow/media-library.js";

/**
 * RFC-14 item T — uploads become an archive.
 *
 * Two properties are worth a test and the rest is plumbing:
 *
 * 1. **A library frame costs no vision call.** That is the entire economic
 *    argument for consulting the archive before stock, and it is only true if
 *    the stored description is what reaches the vetting agent. Asserted by the
 *    ABSENCE of a `media.inspectImages` execution, not by a cheap-looking
 *    result — an empty inspection result is exactly what a broken saving looks
 *    like.
 * 2. **The two reuse rules are different rules.** `ledger.listUsedImages` says
 *    "never twice, ever" and is authoritative and untouched; the previous
 *    post's run id says "never back to back". Both are asserted separately,
 *    because a single combined filter would silently make one of them dead
 *    code.
 */

const params = { runId: "ig_media_library", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==", "base64");

const RIGHTS = { source: "client-upload", licence: "client-supplied — owned by the client, uploaded deliberately for this post" };

/** A stored row, built by hand where the test is about selection rather than about filing. */
function entry(overrides: Partial<MediaLibraryEntry> = {}): MediaLibraryEntry {
  return {
    assetId: "aaaaaaaaaaaaaaaa",
    sha256: `${"a".repeat(64)}`,
    gcsUri: "gs://karoscmo-uploads/acme/hero.png",
    contentType: "image/png",
    bytes: 100,
    addedAt: "2026-08-01T00:00:00.000Z",
    addedByRunId: "ig_old",
    rights: RIGHTS,
    description: "The founder on a conference stage, mid-sentence.",
    subjects: ["founder", "conference stage"],
    textInImage: [],
    mood: "energetic",
    inspectedByToolVersion: "1.0.0",
    sceneTags: ["founder", "conference stage", "conference", "stage", "energetic"],
    knownPaths: [".media-cache/ig_old/n1-client.png"],
    usedIn: [],
    ...overrides,
  };
}

describe("media library — which archived frames may compete for this post", () => {
  it("offers a frame whose scene overlaps the slide's need, best match first", () => {
    const stage = entry({ assetId: "stage00000000000" });
    const desk = entry({
      assetId: "desk000000000000",
      addedAt: "2026-08-02T00:00:00.000Z",
      description: "A tidy desk with a laptop.",
      subjects: ["laptop", "desk"],
      sceneTags: ["laptop", "desk", "calm"],
      knownPaths: [".media-cache/ig_old/n2-client.png"],
    });

    const selection = selectLibraryCandidates([stage, desk], "the founder speaking on a conference stage");
    expect(selection.candidates.map((c) => c.entry.assetId)).toEqual(["stage00000000000"]);
    // A sentence-shaped query matches on its words, so the overlap is three
    // tags rather than the stored `"conference stage"` bigram — and the score
    // is that overlap, which is what ranks a frame about this scene above one
    // that shares a single incidental word.
    expect(selection.candidates[0]!.matchedTags).toEqual(["founder", "conference", "stage"]);
    expect(selection.candidates[0]!.matchScore).toBe(3);
    expect(selection.excluded).toEqual([{ assetId: "desk000000000000", reason: expect.stringContaining("no scene overlap") }]);
  });

  it("offers everything, newest first, when the slide names no scene", () => {
    const older = entry({ assetId: "older00000000000", addedAt: "2026-08-01T00:00:00.000Z" });
    const newer = entry({ assetId: "newer00000000000", addedAt: "2026-08-09T00:00:00.000Z" });
    const selection = selectLibraryCandidates([older, newer], "");
    expect(selection.candidates.map((c) => c.entry.assetId)).toEqual(["newer00000000000", "older00000000000"]);
  });

  it("excludes a frame ledger.listUsedImages already recorded, whoever owns it", () => {
    // A re-ingested frame arrives under a FRESH `.media-cache/<thisRunId>/`
    // path, so matching on the current path alone would let it slip past the
    // one gate that has been preventing cross-post reuse since the parity
    // audit. `knownPaths` is what keeps this matching.
    const harvested = entry({ rights: { source: "pexels", licence: "royalty-free stock" } });
    const selection = selectLibraryCandidates([harvested], "conference stage", { ledgerUsed: [".media-cache/ig_old/n1-client.png"] });
    expect(selection.candidates).toEqual([]);
    expect(selection.excluded[0]!.reason).toContain("ledger.listUsedImages");

    // Item T: the ledger rule "remains authoritative", and it is not relaxed
    // for the client's own uploads. The same history on a client-owned row is
    // refused for the same reason — and THIS is the assertion that would have
    // to be deleted to relax it, which is a decision for a PR body, not for an
    // implementation comment.
    const owned = selectLibraryCandidates([entry()], "conference stage", { ledgerUsed: [".media-cache/ig_old/n1-client.png"] });
    expect(owned.candidates).toEqual([]);
    expect(owned.excluded[0]!.reason).toContain("governs every frame");
  });

  it("excludes a frame that shipped in the immediately previous post — 'never twice in a row'", () => {
    const shipped = entry({ usedIn: [{ runId: "ig_last_week", slide: 2, at: "2026-09-04T00:00:00.000Z" }] });
    const selection = selectLibraryCandidates([shipped], "conference stage", { excludeUsedInRunIds: ["ig_last_week"] });
    expect(selection.candidates).toEqual([]);
    expect(selection.excluded[0]!.reason).toContain("immediately previous post");

    // The SAME frame is offered again once another post has come between:
    // the rule is back-to-back, not permanent.
    const later = selectLibraryCandidates([shipped], "conference stage", { excludeUsedInRunIds: ["ig_this_week"] });
    expect(later.candidates).toHaveLength(1);
  });

  /**
   * The two rules meeting on ONE delivered run, which is the shape the
   * pipeline actually produces.
   *
   * `09b` records every shipped path through `ledger.recordUsedImages`; the
   * same `09g` call that appends `usedIn` appends that identical path to
   * `knownPaths`. So a shipped frame matches the ledger, and item T's "remain
   * authoritative" means it stays matched — for the client's own uploads as
   * much as for harvested stock. The archive's standing value is therefore
   * the uploads that have NOT shipped, and `usedIn` earns its keep on
   * eviction order, provenance, and the case below.
   */
  describe("a frame that has already shipped", () => {
    const delivered = entry({
      // Exactly what one delivered run leaves behind: the ledger holds the
      // path, and the entry remembers it too.
      knownPaths: [".media-cache/ig_old/n1-client.png", ".media-cache/ig_last_week/n3-client0.png"],
      usedIn: [{ runId: "ig_last_week", slide: 3, at: "2026-09-04T00:00:00.000Z" }],
    });
    const ledgerUsed = [".media-cache/ig_last_week/n3-client0.png"];

    it("is refused while it is the immediately previous post's frame", () => {
      const selection = selectLibraryCandidates([delivered], "", { ledgerUsed, excludeUsedInRunIds: ["ig_last_week"] });
      expect(selection.candidates).toEqual([]);
      expect(selection.excluded).toHaveLength(1);
    });

    it("stays refused once another post has come between — the ledger rule is 'never twice, ever'", () => {
      for (const rights of [RIGHTS, { source: "unsplash", licence: "CC0" }]) {
        const selection = selectLibraryCandidates([{ ...delivered, rights }], "", { ledgerUsed, excludeUsedInRunIds: ["ig_this_week"] });
        expect(selection.candidates, `${rights.source} must stay excluded`).toEqual([]);
        expect(selection.excluded[0]!.reason).toContain("ledger.listUsedImages");
      }
    });

    it("is caught by the back-to-back rule when the ledger's path is no longer one the entry remembers", () => {
      // `knownPaths` is capped at MAX_KNOWN_PATHS (12, newest last), so a
      // frame re-ingested more often than that has shipped paths the ledger
      // holds and the entry has forgotten. That is where `excludeUsedInRunIds`
      // is the only rule left, which is why it is not decoration.
      const rolledOver = entry({
        knownPaths: Array.from({ length: 12 }, (_, i) => `.media-cache/ig_r${i + 20}/n1-client.png`),
        usedIn: [{ runId: "ig_last_week", slide: 3, at: "2026-09-04T00:00:00.000Z" }],
      });
      const selection = selectLibraryCandidates([rolledOver], "", { ledgerUsed, excludeUsedInRunIds: ["ig_last_week"] });
      expect(selection.candidates).toEqual([]);
      expect(selection.excluded[0]!.reason).toContain("immediately previous post");
    });
  });

  it("says why the archive did not help, rather than returning an empty list", () => {
    const selection = selectLibraryCandidates([entry()], "a submarine");
    expect(selection.candidates).toEqual([]);
    // "the library had nothing" and "the library had one frame and it was
    // about something else" are different facts about a run.
    expect(selection.excluded).toHaveLength(1);
  });

  it("hands the vet a sentence built from the STORED inspection, with the named subjects intact", () => {
    const description = describeLibraryCandidate(entry());
    expect(description.startsWith("[client library, filed 2026-08-01] ")).toBe(true);
    expect(description).toContain("The founder on a conference stage");
    // `claimMatch`'s identity rubric turns on the named subjects, which is why
    // they travel with the description exactly as they do for a freshly
    // inspected candidate.
    expect(description).toContain("subjects: founder, conference stage");
  });

  it("carries the RIGHTS basis in that same sentence, because it is the only place the vet can read one", () => {
    // This string replaces the description `media.ingestAssets` wrote, and
    // that description is where the licence lived. `instagram-image-vet@4` §2
    // is explicit that an unclear licence means `rightsUsable: false` and an
    // undeterminable watermark state means `watermarkFree: false` — so a
    // library frame described without its basis would be correctly marked
    // unusable, `isUnfillable` would drop it, and tier 0.5 would be silently
    // dead. Same two clauses `ingest-assets` writes for a fresh upload.
    const description = describeLibraryCandidate(entry());
    expect(description).toContain("[licence: client-supplied");
    expect(description).toContain("The client owns this image");
    expect(description).toContain("rights-cleared and unwatermarked unless the picture itself shows otherwise");
  });

  it("does not claim client ownership for a frame the client does not own", () => {
    const description = describeLibraryCandidate(entry({ rights: { source: "unsplash", licence: "CC0" } }));
    expect(description).toContain("[licence: CC0]");
    expect(description).not.toContain("The client owns this image");
  });

  it("re-ingests through the durable URI, never the dead cache path", () => {
    const [candidate] = selectLibraryCandidates([entry()], "").candidates;
    expect(libraryIngestRequest(candidate!, 3)).toEqual({ uri: "gs://karoscmo-uploads/acme/hero.png", label: "client library aaaaaaaaaaaaaaaa", slot: 3 });
  });

  it("groups a delivered post's frames so one frame on two slides is one write", () => {
    expect(
      groupShippedUses([
        { path: ".media-cache/run/n1.png", slide: 1 },
        { path: ".media-cache/run/n1.png", slide: 4 },
        { path: ".media-cache/run/n2.png", slide: 2 },
        // A rendered slide PNG is not library media and is left out rather than sent to be refused.
        { path: "runs/ig/slide-1.png", slide: 1 },
      ]),
    ).toEqual([
      { path: ".media-cache/run/n1.png", usedInSlides: [1, 4] },
      { path: ".media-cache/run/n2.png", usedInSlides: [2] },
    ]);
  });
});

describe("media library — a filed frame, end to end through the real tools", () => {
  let env: TestEnvironment;
  let libraryTools: ReturnType<typeof createMediaLibraryTools>;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "ig_old"), { recursive: true });
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "ig_old", "n1-client.png"), PNG_A);
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "ig_old", "n2-client.png"), PNG_B);
    libraryTools = createMediaLibraryTools({ store: env.store });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("files an inspected upload and reads it back ready to vet, with no second vision call available to make", async () => {
    const add = libraryTools["media.libraryAdd"] as unknown as AgentTool;
    const list = libraryTools["media.libraryList"] as unknown as AgentTool;
    const ctx = { runId: "ig_old", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const, metadata: {} };

    const payload = buildLibraryEntry(
      {
        description: "The founder on a conference stage, mid-sentence, warm side light.",
        subjects: ["founder", "conference stage"],
        textInImage: ["KAROS 2026"],
        mood: "energetic",
        toolVersion: "1.0.0",
      },
      { path: ".media-cache/ig_old/n1-client.png", uri: "gs://karoscmo-uploads/acme/hero.png", label: "hero shot" },
      RIGHTS,
    );
    const added = await add.execute({ repoRoot: env.repoRoot, entries: [payload] }, { ctx });
    expect(added.status).toBe("success");

    const listed = await list.execute({ sceneTags: ["a founder on a conference stage"] }, { ctx: { ...ctx, runId: params.runId } });
    const result = (listed as { result: MediaLibraryListResult }).result;
    expect(result.entries).toHaveLength(1);

    // The whole saving, stated as a property: everything the vet needs is
    // already here. No model was asked anything to produce this sentence.
    const description = describeLibraryCandidate(result.entries[0]!);
    expect(description).toContain("conference stage");
    expect(description).toContain('uploaded as "hero shot"');
    expect(result.entries[0]!.inspectedByToolVersion).toBe("1.0.0");
  });
});

/**
 * The workflow half.
 *
 * These go green when the integrator lands steps 4–5 of the Phase 3 wiring
 * order: `05y-read-media-library` (code, before `05b`) and the library write
 * inside `05z-attach-user-media`. They are written against this work package's
 * own integration notes and assert only what those notes promise — the step
 * exists, it consults `media.libraryList`, the surviving frames are named in
 * its output, and no vision call is made on the way.
 */
describe("media library — 05y-read-media-library (pending the Phase 3 wiring)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
    await fs.mkdir(path.join(env.repoRoot, ".media-cache", "ig_old"), { recursive: true });
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "ig_old", "n1-client.png"), PNG_A);
  });
  afterEach(async () => {
    await env.cleanup();
  });

  /** Wraps a tool so "was it called" is provable, which is the only form of the no-vision-call claim that is observable from outside. */
  function recording(tool: AgentTool, calls: string[]): AgentTool {
    return {
      ...tool,
      async execute(args: unknown, context: never) {
        calls.push(tool.name);
        return tool.execute(args as never, context);
      },
    } as AgentTool;
  }

  async function seedLibrary(usedIn?: { runId: string; slide: number }) {
    const add = createMediaLibraryTools({ store: env.store })["media.libraryAdd"] as unknown as AgentTool;
    const ctx = { runId: usedIn?.runId ?? "ig_old", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const, metadata: {} };
    const outcome = await add.execute(
      {
        repoRoot: env.repoRoot,
        entries: [
          {
            path: ".media-cache/ig_old/n1-client.png",
            gcsUri: "gs://karoscmo-uploads/acme/hero.png",
            rights: RIGHTS,
            description: "The founder on a conference stage, mid-sentence.",
            subjects: ["founder", "conference stage", "automation"],
            mood: "energetic",
            inspectedByToolVersion: "1.0.0",
            ...(usedIn ? { usedInSlides: [usedIn.slide] } : {}),
          },
        ],
      },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(`seeding the library failed: ${outcome.status}`);
    return (outcome.result as { created: string[]; updated: string[] }).created[0] ?? (outcome.result as { updated: string[] }).updated[0]!;
  }

  async function run(extraTools: Record<string, unknown>, calls: string[], input: Record<string, unknown> = {}) {
    const libraryTools = createMediaLibraryTools({ store: env.store });
    const inspect: AgentTool = {
      name: "media.inspectImages",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute() {
        calls.push("media.inspectImages");
        return { status: "content_fail", reason: "no vision backend in this fixture" };
      },
    } as unknown as AgentTool;

    const tools = {
      ...env.tools,
      "media.libraryList": recording(libraryTools["media.libraryList"] as unknown as AgentTool, calls),
      "media.libraryAdd": recording(libraryTools["media.libraryAdd"] as unknown as AgentTool, calls),
      "media.inspectImages": inspect,
      ...extraTools,
    } as unknown as AgentToolRegistry;

    const router = fakeRouterSequence(
      standardTurns({ scout: goodTrendScoutOutput(), research: goodResearchOutput(), angle: goodAngleProposal(), copy: goodCopyOutput() }),
    );
    const store = new MemoryDurableStepStore();
    const workflowFn = createInstagramAgentWorkflow({
      tools: tools as never,
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      autoApprove: true,
    });
    await new WorkflowEngine(store).run(workflowFn, { ...params, input });
    return store.listSteps(params.runId);
  }

  it("offers a matching archived frame before any sourcing tier, and pays for no vision to do it", async () => {
    const assetId = await seedLibrary();
    const calls: string[] = [];
    const steps = await run({}, calls);

    const readLibrary = steps.find((s) => s.stepId === "05y-read-media-library");
    expect(readLibrary, "05y-read-media-library must run before 05b").toBeDefined();
    expect(JSON.stringify(readLibrary?.output)).toContain(assetId);
    expect(calls).toContain("media.libraryList");
    // The saving, asserted as an absence.
    expect(calls).not.toContain("media.inspectImages");

    // Tier 0.5 sits after the client's fresh uploads and before stock.
    const ids = steps.map((s) => s.stepId);
    expect(ids.indexOf("05y-read-media-library")).toBeGreaterThan(ids.indexOf("05z-attach-user-media"));
  });

  it("does not offer a frame that shipped in the immediately previous post", async () => {
    const assetId = await seedLibrary({ runId: "ig_last_week", slide: 2 });
    // The previous post's run id reaches `05y` through item P's skeleton
    // history, which `02k` has already read this run — there is no second
    // source for "which post came last", and inventing one would be a second
    // definition of the same fact.
    await env.store.writeJson("acme", ["memory", "beliefs"], {
      // The seeded visual direction is written back alongside: this is a
      // whole-document write, and dropping that key would send `00d` down the
      // derive path and consume an art-director turn this fixture never
      // queued (see `setupTestEnvironment`'s `seedVisualDirection`).
      instagramVisualDirection: goodVisualDirection(),
      [SKELETON_BELIEF_KEY]: {
        version: 1,
        entries: [
          {
            runId: "ig_last_week",
            at: "2026-09-04T00:00:00.000Z",
            signature: "cover:cover>interior:photo>closer:closer",
            archetypes: ["cover", "photo", "closer"],
            deviceKinds: ["", "", ""],
            roles: ["cover", "interior", "closer"],
            occupancy: [],
            edited: false,
          },
        ],
      },
    });
    const calls: string[] = [];
    const steps = await run({}, calls);

    const readLibrary = steps.find((s) => s.stepId === "05y-read-media-library");
    expect(readLibrary).toBeDefined();
    expect(JSON.stringify(readLibrary?.output)).not.toContain(assetId);
  });

  /**
   * The pairing property, driven through the real step.
   *
   * `media.ingestAssets` returns the frames it could READ, not one per
   * request: a library frame whose object a lifecycle rule has deleted drops
   * out of `candidates` and every later frame shifts up one. Pairing the
   * stored descriptions onto that list by array index therefore hands frame
   * B's pixels frame A's sentence, and `06-vet-images` scores `claimMatch`
   * against a description of a different photograph.
   *
   * Asserted without depending on the archive's own ordering: whatever order
   * `05y` asked in, the surviving file must carry the description of the entry
   * whose durable URI it was fetched from.
   */
  it("pairs each staged file with the entry it came from, even when an earlier frame could not be re-read", async () => {
    await fs.writeFile(path.join(env.repoRoot, ".media-cache", "ig_old", "n2-client.png"), PNG_B);
    const add = createMediaLibraryTools({ store: env.store })["media.libraryAdd"] as unknown as AgentTool;
    const ctx = { runId: "ig_old", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const, metadata: {} };
    const byUri = new Map<string, { assetId: string; description: string }>();
    for (const [file, uri, description] of [
      [".media-cache/ig_old/n1-client.png", "gs://karoscmo-uploads/acme/stage.png", "The founder on a conference stage, mid-sentence."],
      [".media-cache/ig_old/n2-client.png", "gs://karoscmo-uploads/acme/desk.png", "A tidy desk with a laptop and a cold coffee."],
    ] as const) {
      const outcome = await add.execute(
        { repoRoot: env.repoRoot, entries: [{ path: file, gcsUri: uri, rights: RIGHTS, description, subjects: ["founder"], mood: "energetic", inspectedByToolVersion: "1.0.0" }] },
        { ctx },
      );
      if (outcome.status !== "success") throw new Error(`seeding failed: ${outcome.status}`);
      byUri.set(uri, { assetId: (outcome.result as { created: string[] }).created[0]!, description });
    }

    /** The first frame's object is gone; the rest re-ingest normally. Exactly what `ingest-assets` does: `unmet`, `continue`, a SHORTER candidate list. */
    let requested: Array<{ uri: string; slot: number }> = [];
    const partialIngest: AgentTool = {
      name: "media.ingestAssets",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        requested = (args as { assets: Array<{ uri: string; slot: number }> }).assets;
        const [dead, ...alive] = requested;
        return {
          status: "success",
          result: {
            candidates: alive.map((a) => ({
              path: `.media-cache/${params.runId}/n${a.slot}-client0.png`,
              description: "slide candidate, CLIENT-SUPPLIED asset. [licence: client-supplied]",
              provider: "client-upload",
              licenseConfidence: "client-supplied",
            })),
            unmet: [{ slot: dead!.slot, uri: dead!.uri, reason: "could not read the object: No such object" }],
          },
        };
      },
    } as unknown as AgentTool;

    const calls: string[] = [];
    const steps = await run({ "media.ingestAssets": partialIngest }, calls);
    const output = steps.find((s) => s.stepId === "05y-read-media-library")?.output as {
      candidates: Array<{ path: string; description: string }>;
      selected: string[];
      offered: string[];
      note: string;
    };

    expect(requested).toHaveLength(2);
    expect(output.selected).toHaveLength(2);
    const survivor = byUri.get(requested[1]!.uri)!;
    const dropped = byUri.get(requested[0]!.uri)!;
    expect(output.offered).toEqual([survivor.assetId]);
    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0]!.description).toContain(survivor.description);
    // The defect, named: the surviving picture must never be described as the
    // frame that did not survive.
    expect(output.candidates[0]!.description).not.toContain(dropped.description);
    expect(output.note).toContain("could not be re-read");
  });

  it("reads nothing at all on a client-media-only run, because the archive is not media uploaded for THIS job", async () => {
    const assetId = await seedLibrary();
    const stubIngest: AgentTool = {
      name: "media.ingestAssets",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        const assets = (args as { assets: Array<{ slot: number }> }).assets;
        return {
          status: "success",
          result: {
            candidates: assets.map((a) => ({ path: `.media-cache/${params.runId}/n${a.slot}-client0.png`, description: "CLIENT-SUPPLIED", provider: "client-upload", licenseConfidence: "client-supplied" })),
            unmet: [],
          },
        };
      },
    } as unknown as AgentTool;

    const calls: string[] = [];
    const steps = await run({ "media.ingestAssets": stubIngest }, calls, {
      mediaSource: "client",
      mediaAssets: [{ uri: "gs://bucket/fresh.jpg", role: "source" }],
    });

    const output = steps.find((s) => s.stepId === "05y-read-media-library")?.output as { candidates: unknown[]; note: string };
    // "Only media I upload for this job" means tier 0 is the only tier: an
    // uncovered photo slide takes the typographic downgrade the client chose,
    // rather than being filled from an earlier post's pictures.
    expect(output.candidates).toEqual([]);
    expect(output.note).toContain("client-provided media only");
    expect(JSON.stringify(output)).not.toContain(assetId);
    // And nothing was spent looking: no list read, no re-ingest download.
    expect(calls).not.toContain("media.libraryList");
  });

  it("degrades to today's tiers when the library is empty, with nothing else changing", async () => {
    const calls: string[] = [];
    // A harvester that finds nothing: `createAllKarosTools` deliberately
    // excludes every `media.*` tool (it is an egress capability on a
    // credential), so without this stub `05b` would be skipped for want of a
    // tool rather than run and come back empty — which is the behaviour this
    // test is about.
    const findImages: AgentTool = {
      name: "media.findImages",
      version: "1.0.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute() {
        return { status: "success", result: { provider: "fake", candidates: [], unmet: [] } };
      },
    } as unknown as AgentTool;
    const steps = await run({ "media.findImages": findImages }, calls);
    const readLibrary = steps.find((s) => s.stepId === "05y-read-media-library");
    expect(readLibrary).toBeDefined();
    // The step still runs and still says it looked — a run that skipped the
    // read entirely could not tell an empty archive from a broken one.
    expect(JSON.stringify(readLibrary?.output)).toContain("0");
    expect(steps.some((s) => s.stepId.startsWith("05b-source-images"))).toBe(true);
  });
});
