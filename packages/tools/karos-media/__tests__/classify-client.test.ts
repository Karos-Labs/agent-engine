import { describe, expect, it } from "vitest";
import { createClassifyClient } from "../src/classify-client.js";
import type { VisionAnalysisClient } from "../src/visual-patterns.js";

const ctx = { runId: "r1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as never;

function fakeClient(replies: Array<string | Error>): VisionAnalysisClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    models: {
      async generateContent(request: { contents: Array<{ parts: Array<Record<string, unknown>> }> }) {
        prompts.push(request.contents[0]?.parts.map((p: Record<string, unknown>) => (typeof p["text"] === "string" ? p["text"] : "")).join("") ?? "");
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return { candidates: [{ content: { parts: [{ text: next ?? "" }] } }] };
      },
    },
  } as never;
}

describe("media.classifyClient", () => {
  it("returns the five cards from one text call, with the evidence in the prompt", async () => {
    const client = fakeClient([JSON.stringify({ archetype: "place", category: "food-restaurants", involvement: "low", audience: "B2C", locale: "en", archetypeReason: "a venue" })]);
    const out = await createClassifyClient({ client }).execute({ evidence: "name: Trattoria Uno" }, { ctx });
    expect(out.status).toBe("success");
    expect(out.status === "success" && out.result).toMatchObject({ archetype: "place", category: "food-restaurants", archetypeReason: "a venue" });
    expect(client.prompts[0]).toContain("name: Trattoria Uno");
    expect(client.prompts[0]).toContain('Never "other"');
  });

  it("retries a shared-quota 429 and then answers", async () => {
    const client = fakeClient([new Error("429 RESOURCE_EXHAUSTED"), JSON.stringify({ archetype: "brand" })]);
    const out = await createClassifyClient({ client, backoffMs: 1 }).execute({ evidence: "x" }, { ctx });
    expect(out.status).toBe("success");
  });

  it("is not available without a credential, and a non-JSON reply is a tooling error", async () => {
    expect((await createClassifyClient({}).execute({ evidence: "x" }, { ctx })).status).toBe("not_available");
    expect((await createClassifyClient({ client: fakeClient(["not json"]) }).execute({ evidence: "x" }, { ctx })).status).toBe("tooling_error");
  });
});
