import { describe, expect, it } from "vitest";
import { createKarosClientTools } from "../src/index.js";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

/**
 * `client.getStrategy` — the per-client, per-agent setup document.
 *
 * Before this, a run saw profile/brand/voice-rules: how the client SOUNDS.
 * The filled-in account intake — what an account is chartered to be known
 * for, and what it must never post — lived only in the karos-agents lab repo
 * and nothing in agent-engine could read it.
 */
function storeWith(records: Record<string, unknown>): WorkspaceStoreLike {
  return {
    async readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined> {
      return records[`${clientSlug}/${segments.join("/")}`] as T | undefined;
    },
    async writeJson() {
      throw new Error("not used");
    },
    async listJson() {
      return [];
    },
    async exists() {
      return false;
    },
  } as unknown as WorkspaceStoreLike;
}

const CTX = { runId: "r1", clientSlug: "karoslabs", productId: "x-agent", runKind: "recurring" } as never;

describe("client.getStrategy", () => {
  it("reads the account-level document for an agent", async () => {
    const tools = createKarosClientTools(
      storeWith({ "karoslabs/strategy/x-agent": { markdown: "# charter\nnever post financials" } }),
    );

    const outcome = await tools["client.getStrategy"]!.execute({ agent: "x-agent" }, { ctx: CTX });

    expect(outcome.status).toBe("success");
    expect((outcome as { result: { markdown: string } }).result.markdown).toContain("never post financials");
  });

  it("reads a per-account document when a key is given", async () => {
    // A brand page and a founder's seat share a voice and have opposite
    // charters, which is why the intake is per account and never merged.
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/strategy/x-agent": { markdown: "company page charter" },
        "karoslabs/strategy/x-agent/albert-kattan": { markdown: "albert's seat charter" },
      }),
    );

    const seat = await tools["client.getStrategy"]!.execute({ agent: "x-agent", key: "albert-kattan" }, { ctx: CTX });

    expect((seat as { result: { markdown: string } }).result.markdown).toBe("albert's seat charter");
  });

  it("reports not_available for a client with no document, naming the path it looked at", async () => {
    const tools = createKarosClientTools(storeWith({}));

    const outcome = await tools["client.getStrategy"]!.execute({ agent: "x-agent" }, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    // The operator fixing this needs to know where to put the file.
    expect((outcome as { reason: string }).reason).toContain("clients/karoslabs/strategy/x-agent.json");
  });

  it("treats an empty document as absent rather than as a configured blank charter", async () => {
    // Worse than missing: it looks set up while handing the model nothing.
    const tools = createKarosClientTools(storeWith({ "karoslabs/strategy/x-agent": { markdown: "   " } }));

    const outcome = await tools["client.getStrategy"]!.execute({ agent: "x-agent" }, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain('no "markdown" content');
  });

  it("carries provenance through when the migration recorded it", async () => {
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/strategy/x-agent": {
          markdown: "charter",
          source: { repo: "karos-agents", path: "clients/karoslabs/internal/x-agent/account-intake/karos-labs.md" },
        },
      }),
    );

    const outcome = await tools["client.getStrategy"]!.execute({ agent: "x-agent" }, { ctx: CTX });

    expect((outcome as { result: { source?: Record<string, unknown> } }).result.source).toMatchObject({
      repo: "karos-agents",
    });
  });

  it("is tenant-bound — it takes no client argument", async () => {
    const tools = createKarosClientTools(
      storeWith({ "other-client/strategy/x-agent": { markdown: "someone else's charter" } }),
    );

    const outcome = await tools["client.getStrategy"]!.execute({ agent: "x-agent" }, { ctx: CTX });

    // ctx.clientSlug is karoslabs; another tenant's document must not leak in.
    expect(outcome.status).toBe("not_available");
  });
});
