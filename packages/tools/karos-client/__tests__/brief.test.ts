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
