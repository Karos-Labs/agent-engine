import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosIntakeTools } from "@agent-engine/tool-karos-intake";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInSetupWorkflow, createRedditSetupWorkflow } from "../src/index.js";

/**
 * The setup agents record a filled form as the charter a drafting run later
 * reads. The properties worth pinning are about not losing what a person said:
 * the never-post list survives, one bad seat does not discard the good ones,
 * and the document lands exactly where `client.getStrategy` looks.
 */
let rootDir: string;
let store: WorkspaceStore;

const PARAMS = { clientSlug: "acme", runKind: "setup" as const };

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-agents-"));
  store = new WorkspaceStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

/** What `client.getStrategy` would read back for a given key. */
async function readStrategy(agent: string, key?: string): Promise<{ markdown: string } | undefined> {
  const segments = key ? ["strategy", agent, key] : ["strategy", agent];
  return store.readJson<{ markdown: string }>("acme", segments);
}

function runLinkedIn(input: Record<string, unknown>, runId: string) {
  return new WorkflowEngine(new MemoryDurableStepStore()).run(
    createLinkedInSetupWorkflow({ tools: createKarosIntakeTools(store) }),
    { ...PARAMS, productId: "linkedin-setup-agent", runId, input },
  );
}

function runReddit(input: Record<string, unknown>, runId: string) {
  return new WorkflowEngine(new MemoryDurableStepStore()).run(
    createRedditSetupWorkflow({ tools: createKarosIntakeTools(store) }),
    { ...PARAMS, productId: "reddit-setup-agent", runId, input },
  );
}

describe("linkedin setup", () => {
  it("writes a seat where the drafting agent looks for it", async () => {
    // linkedin-agent keys by the seat's kebab-cased name, which is also what
    // the lab-repo migration produced. Both have to agree or a charter exists
    // and is never read.
    const result = await runLinkedIn(
      { seats: [{ fullName: "Daniel Herbert", role: "CTO", focusTopics: ["platform engineering"] }] },
      "run-li-1",
    );

    expect(result.status).toBe("completed");
    const doc = await readStrategy("linkedin-agent", "daniel-herbert");
    expect(doc?.markdown).toContain("Daniel Herbert");
    expect(doc?.markdown).toContain("platform engineering");
  });

  it("keeps the never-post list verbatim", async () => {
    // The half a drafting run must honour rather than draw on. A setup agent
    // that paraphrased this would be the way the constraint goes missing.
    await runLinkedIn(
      {
        seats: [
          {
            fullName: "Tomer Erel",
            offLimitsTopics: ["client names", "unpublished revenue figures"],
          },
        ],
      },
      "run-li-2",
    );

    const doc = await readStrategy("linkedin-agent", "tomer-erel");
    expect(doc?.markdown).toContain("Never post");
    expect(doc?.markdown).toContain("unpublished revenue figures");
  });

  it("writes company direction to the agent-level document", async () => {
    // Company scope is what linkedin-agent falls back to when no seat is
    // named, so this has to be the unkeyed document.
    await runLinkedIn({ companyUpdates: "Ship notes and hiring, never pricing." }, "run-li-3");

    const doc = await readStrategy("linkedin-agent");
    expect(doc?.markdown).toContain("never pricing");
  });

  it("stores the good seats when one is malformed", async () => {
    // Six submitted and one broken should store five. A run that stored zero
    // would make a typo cost the whole onboarding session.
    const result = await runLinkedIn(
      { seats: [{ fullName: "Ines Martinez" }, { fullName: "!!!" }, { fullName: "Yair Hazan" }] },
      "run-li-4",
    );

    expect(result.status).toBe("completed");
    expect(await readStrategy("linkedin-agent", "ines-martinez")).toBeDefined();
    expect(await readStrategy("linkedin-agent", "yair-hazan")).toBeDefined();
    const output = result.status === "completed" ? result.output : undefined;
    expect((output as { skipped: { key: string }[] }).skipped.map((s) => s.key)).toEqual(["!!!"]);
  });

  it("blocks intake rather than succeeding on an empty form", async () => {
    const result = await runLinkedIn({ seats: [] }, "run-li-5");

    // Not a tooling failure: nobody filled the form, and the person who
    // dispatched it is the one who can fix that.
    expect(result.status).toBe("blocked_intake");
  });

  it("refuses a name that would escape the agent's own folder", async () => {
    // The key becomes a path segment. A name slugifying to nothing would write
    // the agent-level document and silently replace the company page.
    await runLinkedIn({ seats: [{ fullName: "../../etc" }] }, "run-li-6");

    expect(await readStrategy("linkedin-agent")).toBeUndefined();
  });
});

describe("reddit setup", () => {
  it("writes the config where the drafting agent looks", async () => {
    const result = await runReddit({ targetSubreddits: ["r/marketing", "SaaS"] }, "run-rd-1");

    expect(result.status).toBe("completed");
    const doc = await readStrategy("reddit-agent", "config");
    expect(doc?.markdown).toContain("r/marketing");
  });

  it("normalises subreddit names to one stored form", async () => {
    // "r/Marketing", "/r/marketing" and "marketing" are the same community.
    // Normalising at write time means every later reader sees one spelling.
    await runReddit({ targetSubreddits: ["r/Marketing", "/r/marketing", "marketing"] }, "run-rd-2");

    const markdown = (await readStrategy("reddit-agent", "config"))!.markdown;
    expect(markdown.match(/r\/marketing/g)).toHaveLength(1);
  });

  it("keeps the off-limits list", async () => {
    await runReddit(
      { targetSubreddits: ["r/test"], offLimitsTopics: ["competitor comparisons"] },
      "run-rd-3",
    );

    expect((await readStrategy("reddit-agent", "config"))!.markdown).toContain("competitor comparisons");
  });

  it("blocks intake when no usable subreddit was given", async () => {
    const result = await runReddit({ targetSubreddits: ["r/", "  "] }, "run-rd-4");

    expect(result.status).toBe("blocked_intake");
  });

  it("does not overwrite the account voice document the migration wrote", async () => {
    // The lab-repo migration puts the account voice at the agent-level
    // document; setup writes the keyed "config" one. Two different facts.
    await store.writeJson("acme", ["strategy", "reddit-agent"], { markdown: "migrated account voice" });

    await runReddit({ targetSubreddits: ["r/test"] }, "run-rd-5");

    expect((await readStrategy("reddit-agent"))!.markdown).toBe("migrated account voice");
  });
});
