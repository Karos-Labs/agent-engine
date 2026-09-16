import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { RUN_STATE_SCHEMA_VERSION, createKarosLedgerTools } from "../src/index.js";

/**
 * `ledger.writeRunState` — C7 §3 (SCRUM-458/460), the learning loop's write
 * side. The invariants worth pinning are the two the contract states: a
 * resumed run is idempotent on `runId` (the platform state never counts one
 * post twice), and the platform-state upsert merges rather than replacing
 * what the projector wrote.
 */
let rootDir: string;
let store: WorkspaceStore;

const CTX = { runId: "pubsub-1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" } as never;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-run-state-"));
  store = new WorkspaceStore(rootDir);
});
afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const write = (input: Record<string, unknown>) => createKarosLedgerTools(store)["ledger.writeRunState"]!.execute(input as never, { ctx: CTX });

const RECORD = {
  runId: "pubsub-1",
  platform: "x",
  deliverable: { kind: "x-post", goal: "expertise", audience: "ops leads drowning in intake", whyNow: "the next planned row", type: "knowledge", sources: ["https://a.test/1"] },
  subjectRow: { subject: "Why intake breaks in month two", angle: "data-point", type: "knowledge", stage: "expertise", goal: "show expertise", assetKind: "x-post", strategyRowId: "sm-x-007" },
  platformStateDelta: { postsByUs: 1, topics: ["Why intake breaks in month two"], voiceNotes: [], account: { handle: "@acmehq" } },
  voiceNotes: [{ lesson: "shorter first line", fromRevision: 1 }],
  rulesApplied: ["L1-x-003"],
  readiness: { present: ["strategy-map"], absent: ["craft"] },
};

describe("ledger.writeRunState (C7 §3)", () => {
  it("writes the record at state/runs/<runId>.json with every C7 §3.1 field, and creates the platform state", async () => {
    const outcome = await write(RECORD);
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toMatchObject({ recordPath: "state/runs/pubsub-1", platformStatePath: "state/x/platform-state", created: true });

    const record = await store.readJson<Record<string, unknown>>("acme", ["state", "runs", "pubsub-1"]);
    expect(record).toMatchObject({
      schemaVersion: RUN_STATE_SCHEMA_VERSION,
      runId: "pubsub-1",
      clientSlug: "acme",
      productId: "x-agent",
      platform: "x",
      deliverable: RECORD.deliverable,
      subjectRow: { ...RECORD.subjectRow, status: "drafted" },
      voiceNotes: RECORD.voiceNotes,
      rulesApplied: ["L1-x-003"],
      readiness: RECORD.readiness,
    });
    expect(typeof record!.writtenAt).toBe("string");

    const state = await store.readJson<Record<string, unknown>>("acme", ["state", "x", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 1, topics: ["Why intake breaks in month two"], account: { handle: "@acmehq" }, contributingRuns: ["pubsub-1"] });
  });

  it("is idempotent on runId: the same run written twice counts one post and one topic", async () => {
    await write(RECORD);
    const second = await write(RECORD);
    expect(second.status).toBe("success");
    if (second.status !== "success") throw new Error("unreachable");
    expect((second.result as { created: boolean }).created).toBe(false);
    const state = await store.readJson<Record<string, unknown>>("acme", ["state", "x", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 1, topics: ["Why intake breaks in month two"], contributingRuns: ["pubsub-1"] });
  });

  it("merges into a platform state the projector wrote: keeps its fields, adds this run's, never replaces", async () => {
    await store.writeJson("acme", ["state", "x", "platform-state"], {
      account: { handle: "@acmehq", url: "https://x.com/acmehq" },
      followers: 4210,
      postsByUs: 14,
      topics: ["remote work"],
      topPosts: [{ url: "https://x.com/acmehq/status/1", why: "a number first" }],
    });
    await write({ ...RECORD, runId: "pubsub-2" });
    const state = await store.readJson<Record<string, unknown>>("acme", ["state", "x", "platform-state"]);
    expect(state).toMatchObject({
      account: { handle: "@acmehq", url: "https://x.com/acmehq" },
      followers: 4210,
      postsByUs: 15,
      topics: ["remote work", "Why intake breaks in month two"],
      topPosts: [{ url: "https://x.com/acmehq/status/1", why: "a number first" }],
      contributingRuns: ["pubsub-2"],
    });
  });

  it("a record with no delta still leaves a platform-state file so the collector finds one", async () => {
    const { platformStateDelta: _drop, ...noDelta } = RECORD;
    await write(noDelta);
    const state = await store.readJson<Record<string, unknown>>("acme", ["state", "x", "platform-state"]);
    expect(state).toMatchObject({ postsByUs: 0, topics: [], contributingRuns: [] });
  });

  it("refuses a record that names no deliverable kind or an unknown stage", async () => {
    const noKind = await write({ ...RECORD, deliverable: { goal: "expertise" } });
    expect(noKind.status).toBe("tooling_error");
    const badStage = await write({ ...RECORD, deliverable: { kind: "x-post", goal: "awareness" } });
    expect(badStage.status).toBe("tooling_error");
  });
});
