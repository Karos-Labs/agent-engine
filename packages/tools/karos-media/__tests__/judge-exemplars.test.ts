import { describe, expect, it } from "vitest";
import { createJudgeExemplars, judgeInstructions, JudgeExemplarsInputSchema } from "../src/judge-exemplars.js";
import type { VisionAnalysisClient } from "../src/visual-patterns.js";

/** RFC-26 Phase 2: craft is graded apart from engagement, and frames are archived before the CDN link expires. */

const DNA = {
  coverType: "typographic",
  picturePlacement: "inset",
  elementGroupsPerSlide: 3,
  textDensity: "low",
  typeStyle: "sans",
  emphasis: "highlight-block",
  device: "figure",
  groundStyle: "flat-light",
  palette: ["#111111", "#ff6b2c"],
  hookPattern: "number",
};

function vision(craftByCall: number[]): VisionAnalysisClient & { prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    models: {
      async generateContent(request: { contents: Array<{ parts: Array<Record<string, unknown>> }> }) {
        const text = request.contents[0]!.parts.find((p: Record<string, unknown>) => "text" in p) as unknown as { text: string };
        prompts.push(text.text);
        const craft = craftByCall[call++] ?? 3;
        return {
          candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify({ craft, craftReason: "clear hierarchy", standout: "one highlighted word per headline", dna: DNA }) + "\n```" }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
        };
      },
    },
  } as unknown as VisionAnalysisClient & { prompts: string[] };
}

const jpeg = (async (url: string) =>
  url.includes("expired")
    ? new Response("forbidden", { status: 403 })
    : new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;

function bucket() {
  const uploads: string[] = [];
  return { uploads, store: { bucketName: "media", async upload(p: string) { uploads.push(p); return {} as never; }, async download() { return Buffer.alloc(0); }, async exists() { return false; } } };
}

const ctx = { runId: "r", clientSlug: "hankypanky", productId: "instagram-agent", runKind: "setup", metadata: {} } as never;
const frames = (n: number, stem = "ok") => Array.from({ length: n }, (_, i) => `https://cdn.example/${stem}-${i}.jpg`);

describe("media.judgeExemplars", () => {
  it("keeps an exemplar only when it is BOTH in its account's top quarter and craft 4+", async () => {
    const { store, uploads } = bucket();
    const tool = createJudgeExemplars({ client: vision([5, 2, 4]), fetchImpl: jpeg, mediaStore: store });
    const outcome = await tool.execute(
      {
        posts: [
          { ref: "a", handle: "semrush", role: "reference", format: "carousel", frames: frames(8), percentile: 0.95, likes: 900 },
          { ref: "b", handle: "semrush", role: "reference", format: "carousel", frames: frames(3), percentile: 0.99, likes: 5000 },
          { ref: "c", handle: "hankypanky", role: "client", format: "single", frames: frames(1), percentile: 0.4 },
        ],
        framesPerPost: 5,
        concurrency: 1,
      },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    const byRef = new Map(outcome.result.judged.map((j) => [j.ref, j]));
    expect(byRef.get("a")!.exemplar).toBe(true);
    // Popular and plain: the audience rewards it, but it is not a look to copy.
    expect(byRef.get("b")!.exemplar).toBe(false);
    // Well made, but not among its own account's best performers.
    expect(byRef.get("c")!.exemplar).toBe(false);
    expect(byRef.get("a")!.dna.picturePlacement).toBe("inset");
    // Five frames of the eight-frame carousel, three and one of the others, all archived.
    expect(uploads).toHaveLength(5 + 3 + 1);
    expect(uploads[0]).toMatch(/^clients\/hankypanky\/exemplars\/frames\/semrush-0-1\.jpg$/u);
    expect(byRef.get("a")!.storedFrames[0]).toMatch(/^gs:\/\/media\//u);
    expect(outcome.usage?.[0]?.quantity).toBe(3000);
  });

  it("names a post whose CDN links expired instead of judging nothing", async () => {
    const tool = createJudgeExemplars({ client: vision([4, 4]), fetchImpl: jpeg });
    const outcome = await tool.execute(
      {
        posts: [
          { ref: "gone", handle: "x", role: "competitor", format: "carousel", frames: frames(2, "expired") },
          { ref: "fine", handle: "x", role: "competitor", format: "carousel", frames: frames(2) },
        ],
      },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    expect(outcome.result.failures[0]!.ref).toBe("gone");
    expect(outcome.result.failures[0]!.reason).toMatch(/expire/u);
    expect(outcome.result.judged.map((j) => j.ref)).toEqual(["fine"]);
  });

  it("tells the judge that engagement is not craft, and asks for categories, never a topic", () => {
    const post = JudgeExemplarsInputSchema.parse({ posts: [{ ref: "a", handle: "h", role: "reference", format: "carousel", frames: frames(1), hook: "3 reasons AI isn't mentioning your brand" }] }).posts[0]!;
    const prompt = judgeInstructions(post, 1);
    expect(prompt).toContain("Engagement is NOT craft");
    expect(prompt).toContain("Never a topic");
    expect(prompt).toContain("3 reasons AI");
  });

  it("is not_available without a vision backend", async () => {
    const outcome = await createJudgeExemplars({}).execute({ posts: [{ ref: "a", handle: "h", role: "client", format: "single", frames: frames(1) }] }, { ctx });
    expect(outcome.status).toBe("not_available");
  });
});

describe("the first live judgement (2026-09-24)", () => {
  it("keeps a real answer that used values outside the lists, reading them as other/none", async () => {
    const { DesignDnaSchema } = await import("../src/judge-exemplars.js");
    const dna = DesignDnaSchema.parse({
      coverType: "moodboard",
      picturePlacement: "split",
      elementGroupsPerSlide: 3,
      textDensity: "none",
      typeStyle: "none",
      emphasis: "hero-element",
      device: "none",
      groundStyle: "split",
      palette: ["#0f2e24", "#1a4731", "not-a-colour", "#f9f5f2"],
      hookPattern: "rhetorical",
    });
    expect(dna.coverType).toBe("moodboard");
    expect(dna.textDensity).toBe("none");
    expect(dna.hookPattern).toBe("other");
    expect(dna.palette).toEqual(["#0f2e24", "#1a4731", "#f9f5f2"]);
  });
});

describe("rate limits", () => {
  it("retries a 429 instead of losing the post", async () => {
    let calls = 0;
    const flaky = {
      models: {
        async generateContent() {
          calls += 1;
          if (calls === 1) throw new Error('{"error":{"code":429,"message":"Resource exhausted"}}');
          return { candidates: [{ content: { parts: [{ text: JSON.stringify({ craft: 4, craftReason: "r", standout: "s", dna: DNA }) }] } }] };
        },
      },
    } as unknown as VisionAnalysisClient;
    const outcome = await createJudgeExemplars({ client: flaky, fetchImpl: jpeg, backoffMs: 0 }).execute(
      { posts: [{ ref: "a", handle: "h", role: "client", format: "single", frames: frames(1), percentile: 0.9 }] },
      { ctx },
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    expect(calls).toBe(2);
    expect(outcome.result.judged[0]!.exemplar).toBe(true);
  });
});
