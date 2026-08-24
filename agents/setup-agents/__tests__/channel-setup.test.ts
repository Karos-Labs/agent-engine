import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createKarosClientTools } from "@agent-engine/tool-karos-client";
import { createKarosIntakeTools } from "@agent-engine/tool-karos-intake";
import { runLinkedInChannelSetup, runRedditChannelSetup } from "../src/index.js";

/**
 * Channel setup, now a pre-flight the drafting agents run for themselves.
 *
 * The properties worth pinning are the same ones the standalone setup agents
 * had — the never-post list survives verbatim, one bad seat does not discard
 * the good ones, and the document lands exactly where `client.getStrategy`
 * looks — plus the three the inlining introduced: an already-configured channel
 * writes nothing, a run with no form is not a failure, and a recorded Reddit
 * charter actually reaches the intake check that needs it.
 */

let rootDir: string;
let store: WorkspaceStore;

const CTX: AgentContext = {
  runId: "run-1",
  clientSlug: "acme",
  productId: "linkedin-agent",
  runKind: "recurring",
  metadata: {},
};

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-setup-"));
  store = new WorkspaceStore(rootDir);
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

/** The registry a drafting agent brings: the read side plus the one write tool setup needs. */
function tools(): AgentToolRegistry {
  return { ...createKarosClientTools(store), ...createKarosIntakeTools(store) };
}

/** What `client.getStrategy` would read back for a given key. */
async function readStrategy(agent: string, key?: string) {
  const segments = key ? ["strategy", agent, key] : ["strategy", agent];
  return store.readJson<{ markdown: string; data?: Record<string, unknown> }>("acme", segments);
}

function linkedIn(input: Record<string, unknown>, registry: AgentToolRegistry = tools()) {
  return runLinkedInChannelSetup({ tools: registry, ctx: CTX, runId: "run-1", clientSlug: "acme", input });
}

function reddit(input: Record<string, unknown>, registry: AgentToolRegistry = tools()) {
  return runRedditChannelSetup({
    tools: registry,
    ctx: { ...CTX, productId: "reddit-agent" },
    runId: "run-1",
    clientSlug: "acme",
    input,
  });
}

describe("linkedin channel setup", () => {
  it("writes a seat where the drafting agent looks for it", async () => {
    // linkedin-agent keys by the seat's kebab-cased name, which is also what
    // the lab-repo migration produced. Both have to agree or a charter exists
    // and is never read.
    const outcome = await linkedIn({
      seats: [{ fullName: "Daniel Herbert", role: "CTO", focusTopics: ["platform engineering"] }],
    });

    expect(outcome.status).toBe("recorded");
    const doc = await readStrategy("linkedin-agent", "daniel-herbert");
    expect(doc?.markdown).toContain("Daniel Herbert");
    expect(doc?.markdown).toContain("platform engineering");
  });

  it("keeps the never-post list verbatim", async () => {
    // The half a drafting run must honour rather than draw on. Setup that
    // paraphrased this would be the way the constraint goes missing.
    await linkedIn({
      seats: [{ fullName: "Tomer Erel", offLimitsTopics: ["client names", "unpublished revenue figures"] }],
    });

    const doc = await readStrategy("linkedin-agent", "tomer-erel");
    expect(doc?.markdown).toContain("Never post");
    expect(doc?.markdown).toContain("unpublished revenue figures");
  });

  it("writes company direction to the agent-level document", async () => {
    // Company scope is what linkedin-agent falls back to when no seat is
    // named, so this has to be the unkeyed document.
    await linkedIn({ companyUpdates: "Ship notes and hiring, never pricing." });

    expect((await readStrategy("linkedin-agent"))?.markdown).toContain("never pricing");
  });

  it("stores the good seats when one is malformed", async () => {
    // Three submitted and one broken should store two. A run that stored zero
    // would make a typo cost the whole onboarding session.
    const outcome = await linkedIn({
      seats: [{ fullName: "Ines Martinez" }, { fullName: "!!!" }, { fullName: "Yair Hazan" }],
    });

    expect(outcome.status).toBe("recorded");
    expect(await readStrategy("linkedin-agent", "ines-martinez")).toBeDefined();
    expect(await readStrategy("linkedin-agent", "yair-hazan")).toBeDefined();
    expect(outcome.skipped.map((s) => s.key)).toEqual(["!!!"]);
  });

  it("refuses a name that would escape the agent's own folder", async () => {
    // The key becomes a path segment. A name slugifying to nothing would write
    // the agent-level document and silently replace the company page.
    await linkedIn({ seats: [{ fullName: "../../etc" }] });

    expect(await readStrategy("linkedin-agent")).toBeUndefined();
  });

  it("reports not-supplied for an empty form instead of failing the run", async () => {
    // The standalone agent raised blocked_intake here, and that was right when
    // recording the form WAS the run. Inline, the drafting half is still
    // perfectly able to proceed, so an unfilled form must not cost a post.
    const outcome = await linkedIn({ seats: [] });

    expect(outcome.status).toBe("not-supplied");
    expect(outcome.written).toEqual([]);
    expect(outcome.note).toContain("no setup form");
  });

  it("writes nothing when the client already has a charter", async () => {
    await store.writeJson("acme", ["strategy", "linkedin-agent"], { markdown: "the existing company charter" });

    const outcome = await linkedIn({ companyUpdates: "something completely different" });

    // The skip is the point: a drafting run must never be able to overwrite a
    // charter somebody set up, whatever its payload happens to carry.
    expect(outcome.status).toBe("already-configured");
    expect(outcome.written).toEqual([]);
    expect((await readStrategy("linkedin-agent"))?.markdown).toBe("the existing company charter");
  });

  it("probes the agent-level document, not a seat's", async () => {
    // A client with a company charter but no document for THIS seat is a
    // normal, fully-set-up state. Treating it as unconfigured would re-run
    // setup on every run for every seat the form never covered.
    await store.writeJson("acme", ["strategy", "linkedin-agent"], { markdown: "company charter" });

    expect((await linkedIn({ seats: [{ fullName: "Someone New" }] })).status).toBe("already-configured");
    expect(await readStrategy("linkedin-agent", "someone-new")).toBeUndefined();
  });

  it("records the form when the client has no charter yet", async () => {
    // The whole point of the pre-flight: onboarding and the first draft in one
    // run, with no separate product to remember to launch first.
    const outcome = await linkedIn({ companyUpdates: "Ship notes and hiring." });

    expect(outcome.status).toBe("recorded");
    expect(outcome.written).toEqual(["strategy/linkedin-agent"]);
  });

  it("carries on without the write tool rather than failing the run", async () => {
    // `intake.saveStrategy` is optional in some compositions. A form that
    // cannot be recorded is a worse post, not no post.
    const outcome = await linkedIn({ companyUpdates: "x" }, createKarosClientTools(store));

    expect(outcome.status).toBe("not-supplied");
    expect(outcome.note).toContain("intake.saveStrategy is not registered");
  });
});

describe("reddit channel setup", () => {
  it("writes the config where the drafting agent looks", async () => {
    const outcome = await reddit({ targetSubreddits: ["r/marketing", "SaaS"] });

    expect(outcome.status).toBe("recorded");
    expect((await readStrategy("reddit-agent", "config"))?.markdown).toContain("r/marketing");
  });

  it("hands the intake check a list, not prose to re-parse", async () => {
    // THE GAP THE INLINING CLOSED. Setup wrote markdown; `00-intake-check`
    // reads `client.getConfig`. So a client could run setup, watch it succeed,
    // and still have every Reddit run block on "has not configured any target
    // subreddits yet". The allowlist now travels as data on the charter.
    const outcome = await reddit({ targetSubreddits: ["r/Marketing", "SaaS"] });

    expect(outcome.targetSubreddits).toEqual(["r/marketing", "r/saas"]);
    expect((await readStrategy("reddit-agent", "config"))?.data?.["targetSubreddits"]).toEqual([
      "r/marketing",
      "r/saas",
    ]);
  });

  it("returns the stored list on a later run without writing again", async () => {
    await reddit({ targetSubreddits: ["r/marketing"] });
    const second = await reddit({ targetSubreddits: ["r/somewhere-else"] });

    expect(second.status).toBe("already-configured");
    expect(second.written).toEqual([]);
    // The stored charter wins over a payload on a later run, for the same
    // reason the LinkedIn probe refuses to overwrite: a drafting run is not
    // where a client's community allowlist gets rewritten.
    expect(second.targetSubreddits).toEqual(["r/marketing"]);
  });

  it("normalises subreddit names to one stored form", async () => {
    // "r/Marketing", "/r/marketing" and "marketing" are the same community.
    // Normalising at write time means every later reader sees one spelling.
    await reddit({ targetSubreddits: ["r/Marketing", "/r/marketing", "marketing"] });

    const markdown = (await readStrategy("reddit-agent", "config"))!.markdown;
    expect(markdown.match(/r\/marketing/g)).toHaveLength(1);
  });

  it("keeps the off-limits list", async () => {
    await reddit({ targetSubreddits: ["r/test"], offLimitsTopics: ["competitor comparisons"] });

    expect((await readStrategy("reddit-agent", "config"))!.markdown).toContain("competitor comparisons");
  });

  it("reports not-supplied when no usable subreddit was given", async () => {
    const outcome = await reddit({ targetSubreddits: ["r/", "  "] });

    expect(outcome.status).toBe("not-supplied");
    expect(outcome.targetSubreddits).toEqual([]);
    // The caller decides whether that is fatal — for reddit-agent it is, and
    // this note is what its blocked_intake message quotes.
    expect(outcome.note).toContain("subreddit names were usable");
  });

  it("treats a charter written before `data` existed as configured", async () => {
    // Documents the migration and the old setup agent wrote have markdown and
    // no data. They are still a configured channel; they just cannot hand the
    // intake check a list, which is what its `client.getConfig` read is for.
    await store.writeJson("acme", ["strategy", "reddit-agent", "config"], { markdown: "- r/legacy" });

    const outcome = await reddit({ targetSubreddits: ["r/new"] });

    expect(outcome.status).toBe("already-configured");
    expect(outcome.targetSubreddits).toEqual([]);
  });

  it("does not overwrite the account voice document the migration wrote", async () => {
    // The lab-repo migration puts the account voice at the agent-level
    // document; setup writes the keyed "config" one. Two different facts.
    await store.writeJson("acme", ["strategy", "reddit-agent"], { markdown: "migrated account voice" });

    await reddit({ targetSubreddits: ["r/test"] });

    expect((await readStrategy("reddit-agent"))!.markdown).toBe("migrated account voice");
  });
});
