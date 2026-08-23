import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { OUTPUT_EXCERPT_MAX_CHARS, OUTPUT_HISTORY_LIMIT, createKarosLedgerTools } from "../src/index.js";

/**
 * The excerpt log de-duplication reads from. The invariants worth pinning are
 * the ones that would make a de-duplication verdict wrong rather than merely
 * imprecise: a run comparing against itself, one agent's output counting as
 * another's, and a failed run displacing real history.
 */
let rootDir: string;
let store: WorkspaceStore;

const CTX = { runId: "run-1", clientSlug: "acme", productId: "essay-agent", runKind: "content" } as never;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-output-history-"));
  store = new WorkspaceStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const tools = () => createKarosLedgerTools(store);
const record = (input: Record<string, unknown>, ctx: unknown = CTX) =>
  tools()["ledger.recordOutputExcerpt"]!.execute(input as never, { ctx: ctx as never });
const list = (input: Record<string, unknown>, ctx: unknown = CTX) =>
  tools()["ledger.listOutputExcerpts"]!.execute(input as never, { ctx: ctx as never });

/** The entries a list call returned, for a successful outcome. */
function entriesOf(outcome: Awaited<ReturnType<typeof list>>): Array<{ runId: string; excerpt: string }> {
  expect(outcome.status).toBe("success");
  return (outcome as { result: { entries: Array<{ runId: string; excerpt: string }> } }).result.entries;
}

describe("ledger output history", () => {
  it("round-trips an excerpt for the next run to read", async () => {
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "the billing dashboard shipped" });

    expect(entriesOf(await list({ agentId: "essay-agent" }))).toMatchObject([
      { runId: "run-1", excerpt: "the billing dashboard shipped" },
    ]);
  });

  it("keeps each agent's history separate", async () => {
    // Comparing a LinkedIn post against a blog article would flag work that is
    // supposed to differ, and miss the repetition that matters.
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "essay text" });
    await record({ agentId: "other-agent", runId: "run-2", excerpt: "other text" });

    expect(entriesOf(await list({ agentId: "essay-agent" }))).toHaveLength(1);
    expect(entriesOf(await list({ agentId: "other-agent" }))[0]?.excerpt).toBe("other text");
  });

  it("is tenant-bound — another client's history is not visible", async () => {
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "acme text" });

    const otherCtx = { ...(CTX as object), clientSlug: "other-co" };
    expect(entriesOf(await list({ agentId: "essay-agent" }, otherCtx))).toEqual([]);
  });

  it("re-recording the same runId replaces its entry instead of adding a second", async () => {
    // A run that resumed after a gate records twice. Without this, history
    // would contain the run twice and a re-run would match itself.
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "first attempt" });
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "after resume" });

    const entries = entriesOf(await list({ agentId: "essay-agent" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.excerpt).toBe("after resume");
  });

  it("excludeRunId hides a run from its own history", async () => {
    // The reason the runner passes it: a run that already recorded, then
    // resumed, must not score 1.0 against itself and report a false repeat.
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "mine" });
    await record({ agentId: "essay-agent", runId: "run-2", excerpt: "theirs" });

    const entries = entriesOf(await list({ agentId: "essay-agent", excludeRunId: "run-1" }));
    expect(entries.map((e) => e.runId)).toEqual(["run-2"]);
  });

  it("does not record an empty deliverable", async () => {
    // A run that produced nothing is not a precedent, and storing it would let
    // one failure push a real deliverable out of the window.
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "real output" });
    const outcome = await record({ agentId: "essay-agent", runId: "run-2", excerpt: "  \n " });

    expect((outcome as { result: { recorded: boolean } }).result.recorded).toBe(false);
    expect(entriesOf(await list({ agentId: "essay-agent" }))).toHaveLength(1);
  });

  it("keeps the most recent entries and drops the oldest past the window", async () => {
    for (let i = 0; i < OUTPUT_HISTORY_LIMIT + 5; i++) {
      await record({ agentId: "essay-agent", runId: `run-${i}`, excerpt: `output number ${i}` });
    }

    const entries = entriesOf(await list({ agentId: "essay-agent" }));
    expect(entries).toHaveLength(OUTPUT_HISTORY_LIMIT);
    expect(entries.at(-1)?.runId).toBe(`run-${OUTPUT_HISTORY_LIMIT + 4}`);
    expect(entries.map((e) => e.runId)).not.toContain("run-0");
  });

  it("truncates a long deliverable rather than storing all of it", async () => {
    await record({ agentId: "essay-agent", runId: "run-1", excerpt: "x".repeat(OUTPUT_EXCERPT_MAX_CHARS * 2) });

    expect(entriesOf(await list({ agentId: "essay-agent" }))[0]?.excerpt).toHaveLength(OUTPUT_EXCERPT_MAX_CHARS);
  });

  it("returns an empty list for an agent that has never run", async () => {
    // The first-run case reaches the store, not just the runner, and must be
    // an empty list rather than an error.
    expect(entriesOf(await list({ agentId: "never-run-agent" }))).toEqual([]);
  });
});
