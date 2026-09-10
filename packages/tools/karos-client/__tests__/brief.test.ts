import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { BRIEF_TTL_DAYS, ClientBriefSchema, briefAgeDays, briefSegments, createKarosClientTools, type ClientBrief } from "../src/index.js";

/**
 * `client.getBrief` — the read side of the persisted Client Brief (Instagram
 * Phase 0 grounding gate). Phase 1's `client.writeBrief` is the writer; until
 * it lands, the fixture is written straight into the workspace store at the
 * path `briefSegments` names, which is also how a human-authored brief would
 * arrive.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

const DAY_MS = 86_400_000;

function validBrief(overrides: Partial<ClientBrief> = {}): ClientBrief {
  return {
    version: 1,
    channel: "instagram",
    generatedAt: new Date().toISOString(),
    generatedBy: "agent",
    agentSkillRef: "instagram-brief@1",
    sources: [{ kind: "profile", ref: "client.getProfile" }],
    positioning: {
      oneLiner: "Karos Labs runs AI-driven marketing for B2B founders.",
      whatWeSell: "An AI marketing agency service: research, drafting and publishing across channels for B2B founders.",
      differentiators: ["engine-native content pipeline"],
    },
    icp: { summary: "B2B founders and heads of marketing at seed-to-series-B companies", roles: ["founder", "head of marketing"], pains: [], industries: ["B2B SaaS"], geos: [] },
    offers: [],
    coreTerms: ["marketing", "agency", "founders", "b2b"],
    referenceAccounts: [{ platform: "x", handle: "lennysan", why: "the product-growth newsletter the ICP reads" }],
    forbidden: { topics: ["politics"], claims: ["guaranteed results"] },
    language: { target: "English", register: "direct, practitioner" },
    evergreenAngles: ["why intake automation beats headcount"],
    ownAssets: [],
    confidence: "medium",
    gaps: [],
    ...overrides,
  };
}

describe("client.getBrief", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosClientTools>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-client-brief-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosClientTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("is registered on the tool registry", () => {
    expect(tools["client.getBrief"]).toBeDefined();
  });

  it("reports not_available, naming the channel, when no brief has been written", async () => {
    const outcome = await tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toBe("no instagram brief for this client");
  });

  it("returns the brief plus its age in days when one is present at clients/<slug>/brief/<channel>-brief.json", async () => {
    const brief = validBrief({ generatedAt: new Date(Date.now() - 3 * DAY_MS - 60_000).toISOString() });
    await store.writeJson("acme", briefSegments("instagram"), brief);
    expect(briefSegments("instagram")).toEqual(["brief", "instagram-brief"]);

    const outcome = await tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { brief: ClientBrief; ageDays: number } }).result;
    expect(result.brief).toEqual(brief);
    expect(result.ageDays).toBe(3);
  });

  it("is channel-scoped: an instagram brief is not an x brief", async () => {
    await store.writeJson("acme", briefSegments("instagram"), validBrief());
    const outcome = await tools["client.getBrief"]!.execute({ channel: "x" }, { ctx });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toBe("no x brief for this client");
  });

  it("refuses (not_available, with a schema reason) a stored brief that no longer parses, rather than handing a consumer half a document", async () => {
    const broken = { ...validBrief(), coreTerms: [] };
    await store.writeJson("acme", briefSegments("instagram"), broken);

    const outcome = await tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toMatch(/does not match ClientBriefSchema/);
    expect((outcome as { reason: string }).reason).toMatch(/coreTerms/);
  });

  it("rejects an unknown channel at the input schema (tooling_error from defineTool)", async () => {
    const outcome = await tools["client.getBrief"]!.execute({ channel: "youtube" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});

describe("client.writeBrief", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  let tools: ReturnType<typeof createKarosClientTools>;

  /** The payload shape the tool takes: a whole brief minus `generatedAt`, which it stamps itself. */
  function payload(overrides: Partial<ClientBrief> = {}): Record<string, unknown> {
    const { generatedAt: _stamped, ...rest } = validBrief(overrides);
    return rest;
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-client-write-brief-"));
    store = new WorkspaceStore(rootDir);
    tools = createKarosClientTools(store);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("is registered on the tool registry", () => {
    expect(tools["client.writeBrief"]).toBeDefined();
  });

  it("writes at clients/<slug>/brief/instagram-brief.json, stamps generatedAt, and client.getBrief reads it straight back", async () => {
    const before = Date.now();
    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { created: boolean; path: string; previousGeneratedAt?: string } }).result;
    expect(result.created).toBe(true);
    expect(result.previousGeneratedAt).toBeUndefined();
    expect(result.path.replace(/\\/g, "/")).toContain("clients/acme/brief/instagram-brief.json");

    const stored = await store.readJson<ClientBrief>("acme", briefSegments("instagram"));
    expect(stored).toBeDefined();
    // Stamped by the tool, not supplied: within the window this test spans.
    const stampedAt = Date.parse(stored!.generatedAt);
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(Date.now());

    const read = await tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(read.status).toBe("success");
    expect((read as { result: { brief: ClientBrief; ageDays: number } }).result.brief).toEqual(stored);
    expect((read as { result: { ageDays: number } }).result.ageDays).toBe(0);
  });

  it("ignores a caller-supplied generatedAt entirely: the schema omits the field, so a future date cannot make a brief permanently fresh", async () => {
    const future = new Date(Date.now() + 400 * DAY_MS).toISOString();
    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: { ...payload(), generatedAt: future } }, { ctx });
    expect(outcome.status).toBe("success");
    const stored = await store.readJson<ClientBrief>("acme", briefSegments("instagram"));
    expect(stored!.generatedAt).not.toBe(future);
    expect(briefAgeDays(stored!)).toBe(0);
  });

  it("rejects an invalid brief (empty coreTerms) with content_fail and writes nothing", async () => {
    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload({ coreTerms: [] }) }, { ctx });
    // The input schema itself refuses it, before the tool body runs: either
    // outcome is a refusal, and neither may leave a file behind.
    expect(["content_fail", "tooling_error"]).toContain(outcome.status);
    expect(await store.readJson("acme", briefSegments("instagram"))).toBeUndefined();
  });

  it("refuses a payload whose own channel disagrees with the requested one, rather than filing an x brief under instagram", async () => {
    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload({ channel: "x" }) }, { ctx });
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toMatch(/disagree/);
    expect(await store.readJson("acme", briefSegments("instagram"))).toBeUndefined();
  });

  it("never overwrites a human-authored brief: content_fail, and the stored document is untouched", async () => {
    const human = validBrief({ generatedBy: "human", positioning: { oneLiner: "The line the client's own marketer wrote.", whatWeSell: "What they say they sell.", differentiators: [] } });
    await store.writeJson("acme", briefSegments("instagram"), human);

    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toMatch(/authored by a human/);
    expect((outcome as { reason: string }).reason).toContain(human.generatedAt.slice(0, 10));
    expect(await store.readJson<ClientBrief>("acme", briefSegments("instagram"))).toEqual(human);
  });

  it("still recognises a human brief whose SHAPE has drifted: authorship outranks a schema client.getBrief would decline to serve", async () => {
    // `client.getBrief` reports not_available for this document (no
    // `coreTerms`), which must not make it overwritable — that would turn
    // "your edit was refused" into "your edit was silently replaced".
    await store.writeJson("acme", briefSegments("instagram"), { ...validBrief({ generatedBy: "human" }), coreTerms: [] });

    const read = await tools["client.getBrief"]!.execute({ channel: "instagram" }, { ctx });
    expect(read.status).toBe("not_available");

    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toMatch(/authored by a human/);
  });

  it("a refresh over an agent brief reports created: false with what it replaced", async () => {
    const first = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    expect(first.status).toBe("success");
    const firstStamp = (await store.readJson<ClientBrief>("acme", briefSegments("instagram")))!.generatedAt;

    const second = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload({ confidence: "high" }) }, { ctx });
    expect(second.status).toBe("success");
    const result = (second as { result: { created: boolean; previousGeneratedAt?: string; previousGeneratedBy?: string } }).result;
    expect(result.created).toBe(false);
    expect(result.previousGeneratedAt).toBe(firstStamp);
    expect(result.previousGeneratedBy).toBe("agent");
    expect((await store.readJson<ClientBrief>("acme", briefSegments("instagram")))!.confidence).toBe("high");
  });

  it("replaces a deterministic brief without complaint — that is the whole point of the refresh", async () => {
    await store.writeJson("acme", briefSegments("instagram"), validBrief({ generatedBy: "deterministic", confidence: "low" }));
    const outcome = await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    expect(outcome.status).toBe("success");
    expect((outcome as { result: { previousGeneratedBy?: string } }).result.previousGeneratedBy).toBe("deterministic");
    expect((await store.readJson<ClientBrief>("acme", briefSegments("instagram")))!.generatedBy).toBe("agent");
  });

  it("is channel-scoped: writing an x brief leaves the instagram one alone", async () => {
    await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx });
    await tools["client.writeBrief"]!.execute({ channel: "x", brief: payload({ channel: "x", coreTerms: ["threads"] }) }, { ctx });

    const instagram = await store.readJson<ClientBrief>("acme", briefSegments("instagram"));
    const x = await store.readJson<ClientBrief>("acme", briefSegments("x"));
    expect(instagram!.coreTerms).toEqual(validBrief().coreTerms);
    expect(x!.coreTerms).toEqual(["threads"]);
  });

  it("is tenant-scoped: another client's brief is written under its own slug", async () => {
    await tools["client.writeBrief"]!.execute({ channel: "instagram", brief: payload() }, { ctx: { ...ctx, clientSlug: "geektime" } });
    expect(await store.readJson("acme", briefSegments("instagram"))).toBeUndefined();
    expect(await store.readJson("geektime", briefSegments("instagram"))).toBeDefined();
  });
});

describe("ClientBriefSchema", () => {
  it("accepts a fully populated brief and fills the array defaults on a minimal one", () => {
    expect(ClientBriefSchema.safeParse(validBrief()).success).toBe(true);

    const minimal = {
      version: 1,
      channel: "instagram",
      generatedAt: new Date().toISOString(),
      generatedBy: "deterministic",
      positioning: { oneLiner: "x", whatWeSell: "y" },
      icp: { summary: "z" },
      coreTerms: ["widgets"],
      forbidden: {},
      language: {},
      confidence: "low",
    };
    const parsed = ClientBriefSchema.parse(minimal);
    expect(parsed.sources).toEqual([]);
    expect(parsed.offers).toEqual([]);
    expect(parsed.referenceAccounts).toEqual([]);
    expect(parsed.forbidden).toEqual({ topics: [], claims: [] });
    expect(parsed.evergreenAngles).toEqual([]);
    expect(parsed.ownAssets).toEqual([]);
    expect(parsed.gaps).toEqual([]);
  });

  it("rejects an empty coreTerms list: a brief with no vocabulary cannot ground a query", () => {
    const result = ClientBriefSchema.safeParse(validBrief({ coreTerms: [] }));
    expect(result.success).toBe(false);
  });

  it("rejects a referenceAccounts platform research.socialHistory cannot read (linkedin)", () => {
    const result = ClientBriefSchema.safeParse({
      ...validBrief(),
      referenceAccounts: [{ platform: "linkedin", handle: "someone", why: "peers" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a version other than 1 and a non-ISO generatedAt", () => {
    expect(ClientBriefSchema.safeParse({ ...validBrief(), version: 2 }).success).toBe(false);
    expect(ClientBriefSchema.safeParse({ ...validBrief(), generatedAt: "yesterday" }).success).toBe(false);
  });

  it("caps referenceAccounts at 7 and coreTerms at 20", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ platform: "x" as const, handle: `h${i}`, why: "peer" }));
    expect(ClientBriefSchema.safeParse(validBrief({ referenceAccounts: eight })).success).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `term${i}`);
    expect(ClientBriefSchema.safeParse(validBrief({ coreTerms: twentyOne })).success).toBe(false);
  });
});

describe("briefAgeDays", () => {
  it("floors to whole days and never goes negative", () => {
    const now = new Date("2026-09-09T12:00:00.000Z");
    expect(briefAgeDays({ generatedAt: "2026-08-09T11:00:00.000Z" }, now)).toBe(31);
    expect(briefAgeDays({ generatedAt: "2026-09-09T11:59:00.000Z" }, now)).toBe(0);
    // A writer whose clock is ahead of the reader's: "written today", not "-1 days".
    expect(briefAgeDays({ generatedAt: "2026-09-10T12:00:00.000Z" }, now)).toBe(0);
  });

  it("is NaN for an unparseable timestamp, so a TTL comparison reads as stale", () => {
    const age = briefAgeDays({ generatedAt: "not a date" });
    expect(Number.isNaN(age)).toBe(true);
    expect(age <= BRIEF_TTL_DAYS).toBe(false);
  });
});
