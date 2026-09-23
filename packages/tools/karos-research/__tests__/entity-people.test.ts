import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { WorkspaceStore } from "@agent-engine/tool-common";
import { createEntityPeople } from "../src/entity-people.js";

/**
 * `research.entityPeople` (2026-09-23): the face a story about a company can
 * carry when its evidence never names one. The owner: a post about ChatGPT can
 * show ChatGPT, or Sam Altman.
 */

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

const item = (id: string, name: string, claims: Record<string, unknown[]> = {}) => ({ id, labels: { en: { value: name } }, claims });
const ref = (qid: string, extra: Record<string, unknown> = {}) => ({ mainsnak: { datavalue: { value: { id: qid } } }, rank: "normal", ...extra });
const human = { P31: [ref("Q5")] };

// A small Wikidata: a band called OpenAI (no statements this tool follows),
// the company, its product, and three people, one of them a former CEO.
const WIKIDATA: Record<string, ReturnType<typeof item>> = {
  Q900: item("Q900", "OpenAI (band)"),
  Q1: item("Q1", "OpenAI", {
    P856: [{ mainsnak: { datavalue: { value: "https://openai.com/" } } }],
    P169: [ref("Q20", { qualifiers: { P582: [{}] } }), ref("Q10")],
    P112: [ref("Q10"), ref("Q11"), ref("Q30")],
  }),
  Q2: item("Q2", "ChatGPT", { P178: [ref("Q1")] }),
  Q10: item("Q10", "Sam Altman", human),
  Q11: item("Q11", "Elon Musk", human),
  Q20: item("Q20", "A Former Chief", human),
  Q30: item("Q30", "Some Holding Company", { P31: [ref("Q4830453")] }),
};
const SEARCH: Record<string, string[]> = { openai: ["Q900", "Q1"], chatgpt: ["Q2"], nobody: [] };

function fakeWikidata(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const action = url.searchParams.get("action")!;
    calls.push(action);
    let body: unknown;
    if (action === "wbsearchentities") {
      body = { search: (SEARCH[url.searchParams.get("search")!.toLowerCase()] ?? []).map((id) => ({ id })) };
    } else {
      const ids = url.searchParams.get("ids")!.split("|");
      body = { entities: Object.fromEntries(ids.filter((id) => WIKIDATA[id]).map((id) => [id, WIKIDATA[id]])) };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("research.entityPeople", () => {
  let rootDir: string;
  let store: WorkspaceStore;
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-entity-people-"));
    store = new WorkspaceStore(rootDir);
  });
  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("finds the company's CURRENT CEO first, then a founder, skipping the same-named band, a former CEO and a founding company", async () => {
    const { fetchImpl } = fakeWikidata();
    const out = await createEntityPeople(store, { fetchImpl }).execute({ name: "OpenAI", kind: "company" }, { ctx });
    expect(out.status).toBe("success");
    const result = (out as { result: { company?: { label: string }; people: Array<{ name: string; role: string }> } }).result;
    expect(result.company?.label).toBe("OpenAI");
    expect(result.people).toEqual([
      { name: "Sam Altman", role: "ceo", qid: "Q10" },
      { name: "Elon Musk", role: "founder", qid: "Q11" },
    ]);
  });

  it("follows a product one hop to its developer, and serves the second read from the cache", async () => {
    const { fetchImpl, calls } = fakeWikidata();
    const tool = createEntityPeople(store, { fetchImpl });
    const first = await tool.execute({ name: "ChatGPT", kind: "product" }, { ctx });
    const result = (first as { result: { company?: { label: string }; via?: string; people: Array<{ name: string }> } }).result;
    expect(result.company?.label).toBe("OpenAI");
    expect(result.via).toBe("developer");
    expect(result.people[0]!.name).toBe("Sam Altman");
    const before = calls.length;
    const second = await tool.execute({ name: "ChatGPT", kind: "product" }, { ctx });
    expect((second as { result: { fromCache: boolean } }).result.fromCache).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("returns no people, never a guess, for a name Wikidata cannot place; a Wikidata outage is a tooling_error", async () => {
    const { fetchImpl } = fakeWikidata();
    const none = await createEntityPeople(store, { fetchImpl }).execute({ name: "Nobody", kind: "company" }, { ctx });
    expect((none as { result: { people: unknown[] } }).result.people).toEqual([]);

    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect((await createEntityPeople(store, { fetchImpl: down }).execute({ name: "Acme", kind: "company" }, { ctx })).status).toBe("tooling_error");
  });
});
