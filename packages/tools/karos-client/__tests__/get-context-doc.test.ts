import { describe, expect, it } from "vitest";
import { createKarosClientTools } from "../src/index.js";
import type { ClientContextDoc, ClientContextDocSource } from "../src/get-context-doc.js";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

/**
 * `client.getContextDoc` — C1 (SCRUM-209)'s projected context documents.
 *
 * Built against a hand-placed fixture in the workspace store, exactly as
 * SCRUM-238's own description says to: "the tool can be built and tested
 * against a hand-placed fixture in the workspace before S-A14 lands."
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

const FULL_SOURCE: ClientContextDocSource = {
  firestoreDocId: "doc_abc123",
  docVersion: 4,
  tier: "client",
  projectedAt: "2026-08-30T12:00:00.000Z",
  projectedBy: "s-a14-projector",
  contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",
};

describe("client.getContextDoc", () => {
  it("is registered on the tool registry", () => {
    const tools = createKarosClientTools(storeWith({}));
    expect(tools["client.getContextDoc"]).toBeDefined();
  });

  it("returns markdown plus full provenance for a present document", async () => {
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/context/brand-voice": {
          markdown: "# Voice\nConfident, never boastful.",
          source: FULL_SOURCE,
        },
      }),
    );

    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "brand-voice" }, { ctx: CTX });

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: ClientContextDoc }).result;
    expect(result.docType).toBe("brand-voice");
    expect(result.markdown).toBe("# Voice\nConfident, never boastful.");
    expect(result.source).toEqual(FULL_SOURCE);
    // The idempotency key rides through unchanged — never recomputed here.
    expect(result.source.contentHash).toBe(FULL_SOURCE.contentHash);
  });

  it("reports not_available for a missing document, naming the path it looked at", async () => {
    const tools = createKarosClientTools(storeWith({}));

    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "market-strategy" }, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("clients/karoslabs/context/market-strategy.json");
  });

  it("reports not_available (with a different reason) for a present-but-empty-markdown document", async () => {
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/context/target-audience": { markdown: "   ", source: FULL_SOURCE },
      }),
    );

    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "target-audience" }, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain('no "markdown" content');
    expect((outcome as { reason: string }).reason).not.toContain("clients/karoslabs/context/target-audience.json");
  });

  it("none of the three fixture cases throw", async () => {
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/context/brand-voice": { markdown: "content", source: FULL_SOURCE },
        "karoslabs/context/target-audience": { markdown: "", source: FULL_SOURCE },
      }),
    );

    await expect(
      tools["client.getContextDoc"]!.execute({ docType: "brand-voice" }, { ctx: CTX }),
    ).resolves.toBeDefined();
    await expect(
      tools["client.getContextDoc"]!.execute({ docType: "target-audience" }, { ctx: CTX }),
    ).resolves.toBeDefined();
    await expect(
      tools["client.getContextDoc"]!.execute({ docType: "competitor-analysis" }, { ctx: CTX }),
    ).resolves.toBeDefined();
  });

  it("reads each of C1's three agent-profile doc types from its own path", async () => {
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/context/x": { markdown: "x profile charter", source: FULL_SOURCE },
        "karoslabs/context/linkedin": { markdown: "linkedin profile charter", source: FULL_SOURCE },
        "karoslabs/context/reddit": { markdown: "reddit profile charter", source: FULL_SOURCE },
      }),
    );

    const x = await tools["client.getContextDoc"]!.execute({ docType: "x" }, { ctx: CTX });
    const linkedin = await tools["client.getContextDoc"]!.execute({ docType: "linkedin" }, { ctx: CTX });
    const reddit = await tools["client.getContextDoc"]!.execute({ docType: "reddit" }, { ctx: CTX });

    expect((x as { result: ClientContextDoc }).result.markdown).toBe("x profile charter");
    expect((linkedin as { result: ClientContextDoc }).result.markdown).toBe("linkedin profile charter");
    expect((reddit as { result: ClientContextDoc }).result.markdown).toBe("reddit profile charter");
  });

  it("rejects the three doc types C1 deliberately excludes from v1", async () => {
    const tools = createKarosClientTools(storeWith({}));

    for (const excluded of ["meeting-notes", "client-guidelines", "action-plan"]) {
      const outcome = await tools["client.getContextDoc"]!.execute({ docType: excluded } as never, { ctx: CTX });
      expect(outcome.status).toBe("tooling_error");
    }
  });

  it("is tenant-bound — another client's document does not leak in", async () => {
    const tools = createKarosClientTools(
      storeWith({ "other-client/context/brand-voice": { markdown: "someone else's voice", source: FULL_SOURCE } }),
    );

    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "brand-voice" }, { ctx: CTX });

    expect(outcome.status).toBe("not_available");
  });
});

describe("client.getContextDoc — knowledge-mirror fallback (2026-09-05)", () => {
  const MIRROR = {
    syncedAt: "2026-09-05T13:00:00.000Z",
    docs: [
      { docType: "target-audience", tier: "client", version: 3, content: "# Target Audience\nSenior CMOs at mid-market B2B." },
      { docType: "market-strategy", tier: "internal", version: 1, content: "   " },
    ],
  };

  it("serves the portal's mirrored document when no C1 projection exists", async () => {
    // The prep failure: no `context/<docType>.json` anywhere, because S-A14 never
    // shipped — yet the client had written the document and the portal had
    // mirrored it. Answering not_available here is what left every intel
    // report ungrounded in its own client's audience.
    const tools = createKarosClientTools(storeWith({ "karoslabs/knowledge/context-docs": MIRROR }));
    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "target-audience" }, { ctx: CTX });

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: ClientContextDoc }).result;
    expect(result.markdown).toBe("# Target Audience\nSenior CMOs at mid-market B2B.");
    expect(result.source.projectedBy).toBe("knowledge-mirror");
    expect(result.source.tier).toBe("client");
    expect(result.source.docVersion).toBe(3);
    expect(result.source.projectedAt).toBe("2026-09-05T13:00:00.000Z");
    expect(result.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers a present projection over the mirror", async () => {
    // A fallback, not a replacement — S-A14 can land without touching this.
    const tools = createKarosClientTools(
      storeWith({
        "karoslabs/context/target-audience": { markdown: "# From the projection", source: FULL_SOURCE },
        "karoslabs/knowledge/context-docs": MIRROR,
      }),
    );
    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "target-audience" }, { ctx: CTX });
    expect((outcome as { result: ClientContextDoc }).result.markdown).toBe("# From the projection");
    expect((outcome as { result: ClientContextDoc }).result.source.projectedBy).toBe(FULL_SOURCE.projectedBy);
  });

  it("treats a blank mirrored row as absent rather than as an empty document", async () => {
    const tools = createKarosClientTools(storeWith({ "karoslabs/knowledge/context-docs": MIRROR }));
    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "market-strategy" }, { ctx: CTX });
    expect(outcome.status).toBe("not_available");
  });

  it("still reports not_available, naming both places it looked, when neither exists", async () => {
    const tools = createKarosClientTools(storeWith({}));
    const outcome = await tools["client.getContextDoc"]!.execute({ docType: "brand-voice" }, { ctx: CTX });
    expect(outcome.status).toBe("not_available");
    expect((outcome as { reason: string }).reason).toContain("knowledge mirror");
  });
});
