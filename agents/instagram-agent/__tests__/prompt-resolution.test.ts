import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { z } from "zod";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { fakeRouterSequence, finalTurn, goodCopyOutput, goodImageVettingOutput, goodResearchOutput, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

describe("PromptStore resolution (RFC-01 §16.1) — nothing here is a hardcoded prompt literal", () => {
  it("resolves each craft skillRef to its real prompts/<id>/1.md file content", async () => {
    const promptStore = makePromptStore();
    expect(await promptStore.getPrompt("instagram-research", "1")).toContain("Extract, don't invent");
    expect(await promptStore.getPrompt("instagram-copy", "1")).toContain("Six to eight slides, one idea each");
    // v2 keeps everything v1 said and adds the photographability rules.
    expect(await promptStore.getPrompt("instagram-copy", "2")).toContain("single photographable scene");
    // v3 keeps all of that and, unlike v1/v2, obeys its own dash ban.
    const v3 = await promptStore.getPrompt("instagram-copy", "3");
    expect(v3).toContain("Six to eight slides, one idea each");
    expect(v3).toContain("single photographable scene");
    expect(v3).not.toMatch(/[—–]/);
    expect(await promptStore.getPrompt("instagram-image-vet", "1")).toContain("No viable candidate is a real, valid answer");
  });

  it("resolves each skillRef with no version to prompts/<id>/latest.md", async () => {
    const promptStore = makePromptStore();
    for (const id of ["instagram-research", "instagram-copy", "instagram-image-vet"]) {
      const resolved = await promptStore.getPrompt(id);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("InstagramResearchAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new InstagramResearchAgent(runtime);

    await agent.run(ctx, { topic: "x", rawPayload: {}, rawPayloadRef: "r1" });

    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-research", "1.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = call[3] as { system?: string };
    expect(opts.system?.startsWith(`${expectedPrompt}\n\n`)).toBe(true);
  });

  it("InstagramCopyAgent and InstagramImageVettingAgent likewise resolve their own skillRefs, not an inline string", async () => {
    const promptStore = makePromptStore();

    const copyRouter = fakeRouterSequence([finalTurn(goodCopyOutput())]);
    const copyAgent = new InstagramCopyAgent({ router: copyRouter, tools: {}, promptStore });
    await copyAgent.run(ctx, { topic: "x", facts: [], styleConfig: {}, brandTokens: {} });
    // 12.md: the copy agent is pinned to `instagram-copy@12` (Phase 0
    // grounding gate: §15 clientBrief/relevanceSteer and §7's default render
    // rules, on top of v11's format/attachedMedia/trendCandidate sections).
    // v1 to v11 stay on disk frozen.
    const expectedCopyPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "12.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const copyCall = (copyRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const copyOpts = copyCall[3] as { system?: string };
    expect(copyOpts.system?.startsWith(`${expectedCopyPrompt}\n\n`)).toBe(true);

    const vetRouter = fakeRouterSequence([finalTurn(goodImageVettingOutput())]);
    const vetAgent = new InstagramImageVettingAgent({ router: vetRouter, tools: {}, promptStore });
    await vetAgent.run(ctx, { slides: [], candidatePool: [] });
    // 3.md: the vetting agent is pinned to `instagram-image-vet@3` (Phase 0
    // semantic vetting: §1b claimMatch and §6 client photos). v1/v2 stay
    // frozen. `semantic-image-vetting.test.ts` pins the skillRef and
    // `3.md === latest.md`; this test only asserts the resolved prompt is
    // the one the agent actually sends.
    const expectedVetPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "3.md"), "utf8");
    const vetCall = (vetRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const vetOpts = vetCall[3] as { system?: string };
    expect(vetOpts.system?.startsWith(`${expectedVetPrompt}\n\n`)).toBe(true);
  });

  it("instagram-copy@12 resolves, latest.md is byte-identical to 12.md, the H1 finally says v12, and every earlier section survives", async () => {
    const promptStore = makePromptStore();
    const v12 = await promptStore.getPrompt("instagram-copy", "12");
    const latest = await promptStore.getPrompt("instagram-copy");
    expect(v12).toBe(latest);
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "12.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "latest.md"), "utf8"));

    // v10 and v11 both carried "v10" in the H1 (audit finding 10).
    expect(v12.split(/\r?\n/)[0]).toBe("# Instagram Copy Craft Guide, v12");

    // All 14 prior sections kept, plus §15 (clientBrief + relevanceSteer) and
    // §16 (selfCheckSteer: the previous attempt's gate finding, fixed not restated).
    for (let n = 1; n <= 16; n++) expect(v12).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    expect(v12).toContain("## 15. Who this client is (read before the facts)");
    expect(v12).toContain("`clientBrief`");
    expect(v12).toContain("`relevanceSteer`");
    expect(v12).toContain("## 16. `selfCheckSteer`");
    expect(v12).toContain("fix the named finding");
    // §7 and `checkDefaultRenderRules` agree about the cover: the check fails
    // EVERY `headline_focus` cover (it can never carry `images.hero` and it is
    // not one of the four figure devices), so the prompt must not teach the
    // writer that a `kicker` legalises one — that steer used to send a
    // prompt-compliant carousel into a second attempt with the same failure.
    expect(v12).toContain("Optional everywhere.");
    expect(v12).toContain("it does not make a slide a cover");
    expect(v12).toContain("`headline_focus` and `text_only` are never slide 1");
    expect(v12).toMatch(/A turn in the middle of the\s+carousel, and only there/);
    expect(v12).not.toMatch(/`kicker` on a `headline_focus` cover/);
    expect(v12).not.toMatch(/if slide 1 is `headline_focus`, give it a `kicker`/);
    expect(v12).not.toMatch(/Good for a hook cover/);
    expect(v12).toContain("Fix it, do not argue with it");

    // §7 gains D's three default render rules, verbatim from the spec.
    expect(v12).toContain("**Cover.** Slide 1 carries a photograph or a figure device (stat, comparison, quote, list).");
    expect(v12).toContain("**Numbers are devices.** One `stat_callout` and one `comparison_card` exist per carousel.");
    expect(v12).toContain("**Closer.** The last slide carries a call to action or a question the reader can answer, in the client's language.");
    // ... and the additions sit inside §7, before §8.
    expect(v12.indexOf("### Cover, numbers, closer")).toBeGreaterThan(v12.indexOf("## 7. "));
    expect(v12.indexOf("### Cover, numbers, closer")).toBeLessThan(v12.indexOf("## 8. "));

    // The new text obeys the prompt's own dash ban (the editor's note in §5).
    // Only the v12 additions are held to it: v8's "Rare case" subsection,
    // which follows the new §7 block, already carries em dashes and is frozen.
    const added = v12.slice(v12.indexOf("### Cover, numbers, closer"), v12.indexOf("### Rare case")) + v12.slice(v12.indexOf("## 15. "));
    expect(added.length).toBeGreaterThan(500);
    expect(added).not.toMatch(/[—–]|--/);

    // The agent is pinned to it.
    const agent = new InstagramCopyAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((agent as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-copy@12");
  });

  it("produces tooling_error, not a crash, when skillRef names a prompt the store doesn't have", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, {
      id: "broken-skill-probe",
      description: "probe",
      allowedTools: [],
      outputSchema: z.object({ text: z.string() }),
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      skillRef: "does-not-exist@99",
    });
    const result = await agent.run(ctx, {});
    expect(result.status).toBe("tooling_error");
  });
});
