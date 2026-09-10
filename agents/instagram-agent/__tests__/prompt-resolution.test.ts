import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { z } from "zod";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { InstagramAngleAgent } from "../src/agent/instagram-angle-agent.js";
import { fakeRouterSequence, finalTurn, goodCopyOutput, goodImageVettingOutput, goodResearchOutput, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { TURN_ORDER, standardTurns } from "./turns.js";

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

    // The file is derived from the agent's OWN `skillRef` rather than named
    // here: what this test is about is that the system prompt is the resolved
    // content of the prompt the step is pinned to, and hardcoding a version
    // turned that into a second, weaker copy of the version pin every prompt
    // bump then had to remember to update (it broke on `instagram-research@2`).
    // The version itself is pinned by the tests that own each bump.
    const [researchSkill, researchVersion] = (agent as unknown as { config: { skillRef: string } }).config.skillRef.split("@");
    expect(researchVersion).toMatch(/^\d+$/);
    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, researchSkill!, `${researchVersion}.md`), "utf8");
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
    // 13.md: the copy agent is pinned to `instagram-copy@13` (Phase 1 item K:
    // §17 the angle and §18 the fact-card kinds, on top of v12's Phase 0
    // grounding sections). v1 to v12 stay on disk frozen.
    const expectedCopyPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "13.md"), "utf8");
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

  it("instagram-copy@12 stays frozen and complete: the H1 finally says v12, and every earlier section survives", async () => {
    const promptStore = makePromptStore();
    const v12 = await promptStore.getPrompt("instagram-copy", "12");

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
  });

  it("instagram-copy@13 resolves, latest.md is byte-identical to 13.md, the H1 says v13, and v13 is v12 plus the angle sections", async () => {
    const promptStore = makePromptStore();
    const v12 = await promptStore.getPrompt("instagram-copy", "12");
    const v13 = await promptStore.getPrompt("instagram-copy", "13");
    const latest = await promptStore.getPrompt("instagram-copy");
    expect(v13).toBe(latest);
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "13.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "latest.md"), "utf8"));

    expect(v13.split(/\r?\n/)[0]).toBe("# Instagram Copy Craft Guide, v13");

    // v13 keeps every byte of v12 except the ONE section it deliberately
    // rewrites (§14, below), so no Phase 0 rule (§15's brief, §16's
    // selfCheckSteer, §7's render rules) can be lost to a prompt bump.
    const afterH1 = (text: string) => text.slice(text.indexOf("\n"));
    const upToTrend = (text: string) => text.slice(text.indexOf("\n"), text.indexOf("## 14. "));
    const fromBrief = (text: string) => text.slice(text.indexOf("## 15. "));
    expect(upToTrend(v12).length).toBeGreaterThan(1000);
    expect(afterH1(v13).startsWith(upToTrend(v12))).toBe(true);
    expect(fromBrief(v13).startsWith(fromBrief(v12))).toBe(true);

    // §14 is rewritten for item I's five topic engines: `trendCandidate` now
    // carries `engine`, and only a `niche-news` subject is a live story. v12
    // told the writer the scout "found a live story" for every engine, so an
    // evergreen angle or a client document heading arrived with a `whyNow`
    // the writer was told to build on.
    expect(v12).toContain("the workflow's scout found a live story");
    expect(v13).not.toContain("the workflow's scout found a live story");
    expect(v13).toMatch(/\*\*`engine` says where the subject came from, and only one of the five is\s+news\.\*\*/);
    for (const engine of ["niche-news", "reference-accounts", "audience-questions", "own-assets", "evergreen"]) {
      expect(v13).toContain(`- \`${engine}\``);
    }
    expect(v13).toContain("**Only a `niche-news` subject may be written as news.**");
    expect(v13).toMatch(/nothing in the caption or on any slide may say or imply "this/);
    expect(v13).toMatch(/unless a research\s+fact card carries that date itself/);

    // All 16 prior sections kept, plus §17 (the angle) and §18 (fact-card kinds).
    for (let n = 1; n <= 18; n++) expect(v13).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    expect(v13).toContain("## 17. The angle: what this carousel argues");
    expect(v13).toContain("## 18. Fact-card kinds: what each card is FOR");

    // §17: the carousel argues `chosen`, the remember line is quoted where a
    // reader meets it, the rejected two are context only, and a run with no
    // angle at all (the fail-open path) writes exactly as v12 did.
    expect(v13).toContain("`chosen.rememberLine` appears on the cover or on the closer");
    expect(v13).toMatch(/verbatim\s+or near-verbatim, in the run's target language/);
    expect(v13).toContain("The two `rejected` angles are context only");
    expect(v13).toContain("Do not blend them in");
    expect(v13).toContain("**No `angle` in your input means no angle was selected for this run.**");

    // §18: item J's kinds route to the archetypes §5/§7 already govern.
    expect(v13).toMatch(/\*\*`stat`\*\* is a candidate for a `stat_callout`/);
    expect(v13).toMatch(/\*\*`quote`\*\* is a candidate for a `quote_card`/);
    expect(v13).toContain("The attribution comes from");
    expect(v13).toMatch(/\*\*`event`\*\* carries a date, so date it/);
    expect(v13).toMatch(/one `stat_callout` and one `comparison_card` per\s+carousel still binds/);

    // The additions obey the prompt's own dash ban (the editor's note in §5).
    const added = v13.slice(v13.indexOf("## 17. "));
    expect(added.length).toBeGreaterThan(1000);
    expect(added).not.toMatch(/[—–]|--/);

    // The agent is pinned to it.
    const agent = new InstagramCopyAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((agent as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-copy@13");
  });

  it("instagram-angle@1 resolves, latest.md is byte-identical to 1.md, and the agent that reads it is pinned to Sonnet", async () => {
    const promptStore = makePromptStore();
    const v1 = await promptStore.getPrompt("instagram-angle", "1");
    expect(v1).toBe(await promptStore.getPrompt("instagram-angle"));
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-angle", "1.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, "instagram-angle", "latest.md"), "utf8"));
    expect(v1.split(/\r?\n/)[0]).toBe("# Instagram Angle Proposal Guide, v1");

    // The four rules `selectAngle` enforces mechanically must also be the
    // rules the proposer was told, or the deterministic pick silently
    // discards proposals the prompt invited.
    expect(v1).toContain("Return exactly three angles, one per `id`");
    expect(v1).toContain("MUST rest on at least one card whose `kind` is `stat`");
    expect(v1).toContain("copied character for character");
    expect(v1).toContain("Never restate a line from `pastAngles`");
    expect(v1).toContain("in the run's `targetLanguage`");
    expect(v1).toContain("When `revisionRequest` is present");
    expect(v1).not.toMatch(/[—–]/);

    const agent = new InstagramAngleAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    const config = (agent as unknown as { config: { skillRef: string; allowedTools: string[]; maxSteps?: number; modelPolicy: { policy: string; model: string } } }).config;
    expect(config.skillRef).toBe("instagram-angle@1");
    expect(config.allowedTools).toEqual([]);
    expect(config.maxSteps).toBe(1);
    // The brief's cost rule: the angle IS the editorial judgment, so it stays
    // on the drafting tier; no Opus anywhere in this run.
    expect(config.modelPolicy.policy).toBe("pinned");
    expect(config.modelPolicy.model).toBe("claude-sonnet-4-6");
  });

  it("instagram-brief@1 resolves and its latest.md is byte-identical to 1.md (the Phase 1 setup agent's prompt)", async () => {
    const promptStore = makePromptStore();
    const v1 = await promptStore.getPrompt("instagram-brief", "1");
    expect(v1).toBe(await promptStore.getPrompt("instagram-brief"));
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-brief", "1.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, "instagram-brief", "latest.md"), "utf8"));
    expect(v1.length).toBeGreaterThan(0);
  });

  it("the angle agent actually sends the resolved prompt as its system prompt", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodAngleProposal())]);
    const agent = new InstagramAngleAgent({ router, tools: {}, promptStore });

    const result = await agent.run(ctx, { topicDecision: { topic: "x", source: "trend" }, mode: "deep-value", facts: [], targetLanguage: "English" });
    expect(result.status).toBe("completed");
    expect(result.finalOutput?.angles).toHaveLength(3);

    const expected = readFileSync(path.join(PROMPTS_ROOT, "instagram-angle", "1.md"), "utf8");
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect((call[3] as { system?: string }).system?.startsWith(`${expected}\n\n`)).toBe(true);
  });

  it("standardTurns queues the workflow's model calls in execution order", () => {
    // The order is the contract every workflow-level fixture depends on: a
    // new unconditional model step that lands anywhere but its own slot here
    // shifts thirty files' turn lists at once.
    expect([...TURN_ORDER]).toEqual(["brief", "scout", "research", "angle", "copy", "vet", "relevance", "fluency", "qa"]);

    const labelled = standardTurns({ qa: "qa", copy: "copy", brief: "brief", angle: "angle", research: "research", scout: "scout", vet: "vet", relevance: "relevance", fluency: "fluency" });
    const outputs = labelled.map((turn) => (turn().output as { output: unknown }).output);
    expect(outputs).toEqual(["brief", "scout", "research", "angle", "copy", "vet", "relevance", "fluency", "qa"]);

    // Omitted keys are skipped, not defaulted: a run that stops before the
    // renderer queues no QA turn.
    expect(standardTurns({ copy: "copy", vet: "vet" })).toHaveLength(2);
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
