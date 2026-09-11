import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { z } from "zod";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { InstagramAngleAgent } from "../src/agent/instagram-angle-agent.js";
import { InstagramVisualQaAgent } from "../src/agent/instagram-visual-qa-agent.js";
import { SKELETON_RULE_SENTENCE } from "../src/workflow/skeleton-memory.js";
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
    // The file is derived from the agent's OWN `skillRef`, for the reason the
    // research case above states: hardcoding the version here made this a
    // second, weaker copy of the version pin that every prompt bump then had
    // to remember to update. It broke on `instagram-research@2` and it would
    // have broken again on `instagram-copy@14`. The version itself is pinned
    // by the test that owns each bump, below.
    const [copySkill, copyVersion] = (copyAgent as unknown as { config: { skillRef: string } }).config.skillRef.split("@");
    expect(copyVersion).toMatch(/^\d+$/);
    const expectedCopyPrompt = readFileSync(path.join(PROMPTS_ROOT, copySkill!, `${copyVersion}.md`), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const copyCall = (copyRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const copyOpts = copyCall[3] as { system?: string };
    expect(copyOpts.system?.startsWith(`${expectedCopyPrompt}\n\n`)).toBe(true);

    const vetRouter = fakeRouterSequence([finalTurn(goodImageVettingOutput())]);
    const vetAgent = new InstagramImageVettingAgent({ router: vetRouter, tools: {}, promptStore });
    await vetAgent.run(ctx, { slides: [], candidatePool: [] });
    // Derived from the agent's own `skillRef` for the same reason.
    // `semantic-image-vetting.test.ts` pins that version and its
    // `N.md === latest.md`; this test only asserts the resolved prompt is the
    // one the agent actually sends.
    const [vetSkill, vetVersion] = (vetAgent as unknown as { config: { skillRef: string } }).config.skillRef.split("@");
    expect(vetVersion).toMatch(/^\d+$/);
    const expectedVetPrompt = readFileSync(path.join(PROMPTS_ROOT, vetSkill!, `${vetVersion}.md`), "utf8");
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

  it("instagram-copy@13 stays frozen and complete: the H1 says v13, and v13 is v12 plus the angle sections", async () => {
    const promptStore = makePromptStore();
    const v12 = await promptStore.getPrompt("instagram-copy", "12");
    const v13 = await promptStore.getPrompt("instagram-copy", "13");

    // `latest.md` moved to 14 (Phase 2, items L/M/O/P — see the test below).
    // v13's own `=== latest.md` assertion moved with it; what stays here is
    // that v13 is still on disk, unmodified, as the pre-Phase-2 baseline.
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
  });

  it("instagram-copy@14 resolves, latest.md is byte-identical to 14.md, the H1 says v14, and v14 is v13 plus items L/M/O/P", async () => {
    const promptStore = makePromptStore();
    const v13 = await promptStore.getPrompt("instagram-copy", "13");
    const v14 = await promptStore.getPrompt("instagram-copy", "14");
    expect(v14).toBe(await promptStore.getPrompt("instagram-copy"));
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "14.md"), "utf8")).toBe(
      readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "latest.md"), "utf8"),
    );
    expect(v14.split(/\r?\n/)[0]).toBe("# Instagram Copy Craft Guide, v14");

    // v14 changes exactly three regions of v13: §7 (the menu, the degrade
    // target, the two hard placements, the numbers rule) and §16 (the
    // `interest:` finding), plus §19-21 appended. Everything else is
    // byte-identical, so no Phase 0/1 rule can be lost to a prompt bump.
    const between = (text: string, from: string, to?: string) => text.slice(text.indexOf(from), to === undefined ? undefined : text.indexOf(to));
    expect(between(v14, "## 1. ", "## 7. ")).toBe(between(v13, "## 1. ", "## 7. "));
    expect(between(v14, "## 8. ", "## 16. ")).toBe(between(v13, "## 8. ", "## 16. "));
    // `.trimEnd()` only because the appended §19 introduces one blank
    // separator line after v13's last paragraph.
    expect(between(v14, "## 17. ", "## 19. ").trimEnd()).toBe(between(v13, "## 17. ").trimEnd());

    // Every section 1..21 exists, and 19/20/21 are new.
    for (let n = 1; n <= 21; n++) expect(v14).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    for (const n of [19, 20, 21]) expect(v13).not.toMatch(new RegExp(`^## ${n}\\. `, "m"));

    // ── §7: the menu is EIGHT archetypes, cover and closer included ──────
    expect(v14).toContain("There are eight.");
    expect(v14).toMatch(/- \*\*`cover`\*\* : slide 1, always\./);
    expect(v14).toMatch(/- \*\*`closer`\*\* : the last slide, always\./);
    // ...and the menu additions sit INSIDE §7, before §8.
    expect(v14.indexOf("- **`cover`** : slide 1")).toBeGreaterThan(v14.indexOf("## 7. "));
    expect(v14.indexOf("- **`closer`** : the last slide")).toBeLessThan(v14.indexOf("## 8. "));

    // ── §7: the placement rule says only what is actually enforced ──────
    // v14 shipped a contradiction: the Cover bullet listed six accepted
    // slide-1 archetypes and three paragraphs later "Two hard placements"
    // claimed slide 1 must be `cover` or `photo` and that "nothing else is
    // accepted there and anything else is refused before a render is spent".
    // The second is false: `default:cover-carries-device` passes any of the
    // six (`DEVICE_TEMPLATE_BASENAMES`), and no check refuses a non-`closer`
    // last slide at all. A prompt that claims a refusal that does not happen
    // teaches the model to ignore the claim.
    expect(v14).not.toContain("**Two hard placements.**");
    expect(v14).not.toContain("nothing else is accepted there");
    expect(v14).toContain("Six archetypes are accepted there: `cover`, `photo`");
    expect(v14).toContain("`headline_focus` and `text_only` on slide 1 ARE refused before a render is spent");
    expect(v14).toContain("**Where the two positional archetypes belong.**");
    // The closer half is graded, not refused, and the prompt now says so.
    expect(v14).toContain("the last\nslide's closing rule is graded".replace(/\n/g, "\r\n"));

    // ── §7: the degrade target is no longer the blanket `text_only` ──────
    // The grey screen the owner complained about IS `text_only` routed to
    // the client's own image-less base template, so a prompt that still
    // teaches "the automatic fallback" is teaching the defect.
    expect(v13).toContain("it is also the automatic\n  fallback when a photo cannot be sourced".replace(/\n/g, "\r\n"));
    expect(v14).not.toContain("it is also the automatic");
    expect(v14).toContain("falls back\n  to the archetype the content actually is".replace(/\n/g, "\r\n"));

    // ── §7: a leading figure needs a device on ANY archetype now ─────────
    expect(v13).toContain('Every other numeric fact leads with the noun ("Teams that automated intake cut onboarding 40%"), never with the figure.');
    expect(v14).not.toContain("Every other numeric fact leads with the noun");
    expect(v14).toContain("A slide whose body leads with a figure carries a `device` whose value IS that figure (section 19)");
    // ...on an archetype that renders one. Only `cover`, `headline_focus` and
    // an un-recapped `closer` declare a device slot, so a §19 that promised
    // "any slide of any archetype may carry one" had the writer doing exactly
    // what `withDevice` then dropped, and `default:numbers-are-devices`
    // failing the slide for it.
    expect(v14).toContain("on an archetype that renders one");

    // ── §16: an interest finding is a measurement, with the three moves ──
    const s16 = between(v14, "## 16. ", "## 17. ");
    expect(s16).toContain("An `interest:` finding is not a judgment of your words but a MEASUREMENT of");
    expect(s16).toContain("change what is ON the slide");
    expect(s16).toContain("(section 19)");
    expect(s16).toContain("merge it into its neighbour");

    // ── §19: all six device shapes, the 12-character rule, the source rule
    const s19 = between(v14, "## 19. ", "## 20. ");
    for (const kind of ["figure", "figure_pair", "bars", "timeline", "versus", "unit_grid"]) {
      expect(s19).toContain(`- **\`${kind}\`**`);
    }
    expect(s19).toContain("**Three archetypes render a device, and only those three: `cover`,");
    expect(s19).toContain("`headline_focus`, and `closer` when it has no earlier slides to recap.**");
    expect(s19).not.toContain("any slide\nof any archetype may carry one".replace(/\n/g, "\r\n"));
    expect(s19).toContain("**The post's key figure MUST get a device, which means putting it on a slide");
    expect(s19).toContain("**Every value is 12 characters at most.**");
    expect(s19).toContain("**`figure`, `figure_pair` and `bars` REQUIRE a `source`.**");
    expect(s19).toContain('"illustrative, not measured"');
    expect(s19).toContain("never invent one to earn a");

    // ── §20: the licence, the shape-gap criterion, the two-per-carousel cap
    const s20 = between(v14, "## 20. ", "## 21. ");
    expect(s20).toContain("**At most two\nper carousel.**".replace(/\n/g, "\r\n"));
    expect(s20).toContain("The test is a SHAPE GAP, never novelty.");
    expect(s20).toContain("naming the SHAPE the eight archetypes cannot");
    // The old stance is gone: `custom` is no longer "a rare tool, not a
    // creative default".
    expect(v13).toContain("This is a rare tool, not");
    expect(v14).not.toContain("This is a rare tool, not");
    expect(v14).not.toContain("### Rare case: none of the six fit");
    expect(v14).toContain("### None of the eight fit the shape");
    // Logical properties, because a custom layout has to survive RTL too.
    expect(s20).toContain("Use LOGICAL properties");
    // Item O's promise, corrected: a stored row is only ever picked through
    // the fixed layout enum, so a design that reads its own invented slot
    // names cannot be offered to a later run however many clean ships it
    // earns. v14 shipped "offered to later runs like any other archetype",
    // which nothing in the routing could deliver.
    expect(s20).not.toContain("offered to later runs like any other");
    expect(s20).toContain("A stored design is offered to later");
    expect(s20).toContain("only be offered when its markup reads nothing but the standard fields");
    expect(s20).toContain("`{{railTitle}}`, `{{priceNote}}`");

    // ── §21: the avoid-list rule, verbatim against the code that enforces it
    const s21 = between(v14, "## 21. ");
    expect(s21).toContain("`recentSkeletons`");
    expect(s21).toContain(SKELETON_RULE_SENTENCE.split(". ")[0]);
    for (const sentence of SKELETON_RULE_SENTENCE.split(". ")) {
      expect(s21.replace(/\r?\n/g, " ")).toContain(sentence.replace(/\.$/, ""));
    }

    // The additions obey the prompt's own dash ban (§5's editor's note). The
    // only `--` permitted is a CSS custom property name, which §20 inherited
    // verbatim from v13's own custom-archetype block.
    const added = `${between(v14, "## 19. ")}\n${s16}`;
    expect(added.length).toBeGreaterThan(2000);
    expect(added).not.toMatch(/[—–]/);
    expect(added.replace(/var\(--[a-z-]+\)/g, "")).not.toMatch(/--/);
  });

  it("instagram-visual-qa@4 resolves, latest.md is byte-identical to 4.md, and v4 is v3 plus the rhythm section", async () => {
    const promptStore = makePromptStore();
    const v3 = await promptStore.getPrompt("instagram-visual-qa", "3");
    const v4 = await promptStore.getPrompt("instagram-visual-qa", "4");
    expect(v4).toBe(await promptStore.getPrompt("instagram-visual-qa"));
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-visual-qa", "4.md"), "utf8")).toBe(
      readFileSync(path.join(PROMPTS_ROOT, "instagram-visual-qa", "latest.md"), "utf8"),
    );
    // Not @2: v2 already shipped, and v3 is the `renderedInspections`
    // version this builds on.
    expect(v4.split(/\r?\n/)[0]).toBe("# Instagram Visual QA Craft Guide — v4");

    // v3's five sections survive byte for byte; §6 is the only addition.
    expect(v4.slice(v4.indexOf("## 1. "), v4.indexOf("## 6. ")).trimEnd()).toBe(v3.slice(v3.indexOf("## 1. ")).trimEnd());
    for (let n = 1; n <= 6; n++) expect(v4).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    expect(v3).not.toMatch(/^## 6\. /m);

    // The judgment half only: the pixel facts arrive as input and must not be
    // re-derived, and the two questions are rhythm and difference from the
    // previous post.
    const s6 = v4.slice(v4.indexOf("## 6. "));
    expect(s6).toContain("Does this set have rhythm?");
    expect(s6).toContain("a quiet cover,");
    expect(s6).toContain("N variations of one slide");
    expect(s6).toContain("Does it read as a different post from the previous one?");
    expect(s6).toContain("never re-derive or dispute them");
    expect(s6).toContain("`thisSkeleton` and `previousSkeleton`");
    expect(s6).toContain('`ruleId: "composition-richness"`');
    // Absent inputs make the section inert rather than speculative.
    expect(s6).toContain("With `interest` and both skeletons absent this section is inert.");
    // The header tells the reader the two new inputs exist at all.
    expect(v4).toContain("Since v4 you are also");
  });

  it("the three Template Studio prompts resolve, each latest.md is byte-identical to its 1.md, and each H1 carries v1", async () => {
    const promptStore = makePromptStore();
    for (const id of ["instagram-design-brief", "instagram-template-designer", "instagram-template-set-review"]) {
      const v1 = await promptStore.getPrompt(id, "1");
      expect(v1).toBe(await promptStore.getPrompt(id));
      expect(readFileSync(path.join(PROMPTS_ROOT, id, "1.md"), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, id, "latest.md"), "utf8"));
      expect(v1.split(/\r?\n/)[0]).toMatch(/^# .+, v1$/);
      expect(v1.length).toBeGreaterThan(2000);
      // Every one of the three is a setup-time prompt whose output is read by
      // code, never published: none may name a `gate.*` (there is no gate on
      // this path), and none may carry an em dash into a client's own feed.
      expect(v1).not.toMatch(/gate\.[a-zA-Z]/);
    }

    const brief = await promptStore.getPrompt("instagram-design-brief", "1");
    // The eight routable ids, and WHY a ninth is a routing dead end.
    for (const id of ["cover", "closer", "stat_callout", "quote_card", "comparison_card", "list_takeaway", "headline_focus", "photo"]) {
      expect(brief).toContain(`\`${id}\``);
    }
    expect(brief).toContain("a template proposing a ninth");
    expect(brief).toContain("At most one template per archetype");
    // The honest-signals rule, which is half of what stops an invented metric.
    expect(brief).toContain("**Never invent a metric.**");
    expect(brief).toContain("**Name the absence.**");
    expect(brief).toContain("**Scores are within-account.**");
    expect(brief).toContain("Qualitative is a legitimate answer");
    // Every field `StudioDesignBriefOutputSchema` requires is named in the
    // prompt. A prompt that never mentions a required field produces a schema
    // violation at run time, not a graceful degradation — which is the whole
    // reason `PromptHygiene.structuredOutput` exists.
    for (const field of ["`thesis`", "`templates`", "`archetypeId`", "`role`", "`formatLabel`", "`ground`", "`why`", "`setRules`", "`signalsAvailable`", "`signalsAbsent`", "`gaps`"]) {
      expect(brief).toContain(field);
    }
    // `derivedFrom` belongs to the DESIGNER's output, not the brief's: the
    // brief names the format, the designer cites the evidence for it.
    expect(brief).not.toContain("`derivedFrom`");

    const designer = await promptStore.getPrompt("instagram-template-designer", "1");
    // A fragment and a stylesheet, never a document, never a script.
    expect(designer).toContain("You never write a document.");
    expect(designer).toContain("no `<script>`");
    for (const field of ["`archetypeId`", "`name`", "`role`", "`layoutType`", "`ground`", "`bodyHtml`", "`css`", "`slots`", "`sample`", "`derivedFrom`"]) {
      expect(designer).toContain(field);
    }
    // `layoutType` is load-bearing rather than descriptive: it decides whether
    // a later run pays to source an image for a slide routed here.
    expect(designer).toContain("it decides whether a later");
    // The gated slot forms.
    expect(designer).toContain("`{{image:hero}}`");
    expect(designer).toContain("`{{html:device}}`");
    expect(designer).toContain("Allowed ONLY when your");
    // Tokens, the run-time type scale, logical properties, and the measured floor.
    expect(designer).toContain("calc(Npx * var(--ts, 1))");
    expect(designer).toContain("Logical properties only");
    expect(designer).toContain("has to survive being MEASURED");
    expect(designer).toContain("A large empty rectangle fails.");
    expect(designer).toContain("One archetype, one fragment, one");

    const review = await promptStore.getPrompt("instagram-template-set-review", "1");
    // Residue only: the factual half is already answered by the eight gates.
    expect(review).toContain("What has already been decided without you");
    expect(review).toContain("cleared the interest floor with a");
    for (const field of ["`perTemplate`", "`archetypeId`", "`verdict`", "`reason`", "`setNote`"]) {
      expect(review).toContain(field);
    }
    expect(review).toContain("`keep`, `repair` or `drop`");
    expect(review).toContain("does this set read");
    expect(review).toContain("as one system?");
    expect(review).toContain("`measured` is a fact,");
    expect(review).toContain("Dropping is safe");
  });

  it("every instagram prompt this phase touched has a row in scripts/prompt-registry.ts", () => {
    // Read as TEXT rather than imported: `scripts/*.ts` compiles as CommonJS
    // and `prompt-registry.ts` uses `__dirname`, so importing it into an ESM
    // test would fail for a reason that has nothing to do with the registry.
    // `check:prompts` is what compares the registry against the disk; what
    // this asserts is that the rows exist at all, which is the step a prompt
    // bump most often forgets.
    const registry = readFileSync(path.join(PROMPTS_ROOT, "..", "..", "..", "scripts", "prompt-registry.ts"), "utf8");
    expect(registry).toContain(`"13", "14"`);
    expect(registry).toMatch(/promptId: "instagram-copy"[\s\S]{0,400}latestVersion: "14"/);
    expect(registry).toContain(`{ promptId: "instagram-visual-qa", agent: "instagram-agent", versions: ["1", "2", "3", "4"], latestVersion: "4" }`);
    expect(registry).toContain(`{ promptId: "instagram-design-brief", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
    expect(registry).toContain(`{ promptId: "instagram-template-designer", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
    expect(registry).toContain(`{ promptId: "instagram-template-set-review", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
  });

  it("RED UNTIL WIRED — the copy and visual-QA agents are pinned to @14 and @4 (integrator: WP-C5 notes (b) and (d))", async () => {
    // `instagram-copy-agent.ts` and `instagram-visual-qa-agent.ts` are not
    // WP-C5's files: the prompt versions, the registry rows and this pin are.
    // Until the integrator bumps the two `skillRef` literals, both prompts
    // exist and resolve but no run reads them, so this is the forcing
    // function for the last two lines of the wiring.
    const promptStore = makePromptStore();
    const copy = new InstagramCopyAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((copy as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-copy@14");
    const qa = new InstagramVisualQaAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((qa as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-visual-qa@4");
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
    // Phase 2 item N inserted the four Template Studio turns immediately
    // after `brief` (they run at `00c*`, after `00b2` and before `03c`), so
    // they belong there and nowhere else in this list.
    expect([...TURN_ORDER]).toEqual([
      "brief",
      "designBrief",
      "templateDesign",
      "setReview",
      "templateRepair",
      "scout",
      "research",
      "angle",
      "copy",
      "vet",
      "relevance",
      "fluency",
      "qa",
    ]);

    const labelled = standardTurns({
      qa: "qa",
      copy: "copy",
      brief: "brief",
      angle: "angle",
      research: "research",
      scout: "scout",
      vet: "vet",
      relevance: "relevance",
      fluency: "fluency",
      designBrief: "designBrief",
      templateDesign: ["design1", "design2"],
      setReview: "setReview",
      templateRepair: ["repair1"],
    });
    const outputs = labelled.map((turn) => (turn().output as { output: unknown }).output);
    expect(outputs).toEqual([
      "brief",
      "designBrief",
      "design1",
      "design2",
      "setReview",
      "repair1",
      "scout",
      "research",
      "angle",
      "copy",
      "vet",
      "relevance",
      "fluency",
      "qa",
    ]);

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
