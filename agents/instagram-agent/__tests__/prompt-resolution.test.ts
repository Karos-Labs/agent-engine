import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { z } from "zod";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramPostPackagerAgent } from "../src/agent/instagram-post-packager-agent.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
// Phase 5.5, item A2. Imported by PATH: the `src/agent/index.ts` export belongs
// to the hunk that wires `04b3-extract-entities`, and this suite has to see the
// class the moment it exists.
import { InstagramEntityAgent } from "../src/agent/instagram-entity-agent.js";
import { InstagramAngleAgent } from "../src/agent/instagram-angle-agent.js";
import { InstagramVisualQaAgent } from "../src/agent/instagram-visual-qa-agent.js";
import { InstagramArtDirectorAgent } from "../src/agent/instagram-art-director-agent.js";
import { InstagramConceptAgent } from "../src/agent/instagram-concept-agent.js";
import { SKELETON_RULE_SENTENCE } from "../src/workflow/skeleton-memory.js";
import { fakeRouterSequence, finalTurn, goodCopyOutput, goodImageVettingOutput, goodResearchOutput, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";
import { DEFAULT_ENTITIES_TURN, TURN_ORDER, standardTurns } from "./turns.js";

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

  it("instagram-copy@14 still resolves frozen, the H1 says v14, and v14 is v13 plus items L/M/O/P", async () => {
    // Phase 3 bumped the pointer: `latest.md` now carries @15's bytes (the
    // test two below asserts that), so this one no longer compares against
    // it. v14 itself must keep resolving unchanged — an in-flight checkpoint
    // pinned to it still reads this exact file.
    const promptStore = makePromptStore();
    const v13 = await promptStore.getPrompt("instagram-copy", "13");
    const v14 = await promptStore.getPrompt("instagram-copy", "14");
    expect(v14.split(/\r?\n/)[0]).toBe("# Instagram Copy Craft Guide, v14");

    // v14 changes exactly three regions of v13: §7 (the menu, the degrade
    // target, the two hard placements, the numbers rule) and §16 (the
    // `interest:` finding), plus §19-21 appended. Everything else is
    // byte-identical, so no Phase 0/1 rule can be lost to a prompt bump.
    const between = (text: string, from: string, to?: string) => text.slice(text.indexOf(from), to === undefined ? undefined : text.indexOf(to));
    // Every assertion below that spans a line break compares against `lf(...)`.
    // The prompt files are CRLF in a Windows working tree and LF in the repo
    // blob (so LF on a Linux CI checkout), which means a literal "\r\n" in an
    // expectation is a guard that only holds on the machine it was written on:
    // it passed locally and failed in CI on the first push of this PR.
    // Normalising the haystack asserts the wording, which is what these are
    // about, on either checkout.
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
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
    expect(lf(v14)).toContain("the last\nslide's closing rule is graded");

    // ── §7: the degrade target is no longer the blanket `text_only` ──────
    // The grey screen the owner complained about IS `text_only` routed to
    // the client's own image-less base template, so a prompt that still
    // teaches "the automatic fallback" is teaching the defect.
    expect(lf(v13)).toContain("it is also the automatic\n  fallback when a photo cannot be sourced");
    expect(v14).not.toContain("it is also the automatic");
    expect(lf(v14)).toContain("falls back\n  to the archetype the content actually is");

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
    expect(lf(s19)).not.toContain("any slide\nof any archetype may carry one");
    expect(s19).toContain("**The post's key figure MUST get a device, which means putting it on a slide");
    expect(s19).toContain("**Every value is 12 characters at most.**");
    expect(s19).toContain("**`figure`, `figure_pair` and `bars` REQUIRE a `source`.**");
    expect(s19).toContain('"illustrative, not measured"');
    expect(s19).toContain("never invent one to earn a");

    // ── §20: the licence, the shape-gap criterion, the two-per-carousel cap
    const s20 = between(v14, "## 20. ", "## 21. ");
    expect(lf(s20)).toContain("**At most two\nper carousel.**");
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

  /**
   * ── @5: THE JUDGE IS ASKED WHAT THE OWNER ASKED (Phase 5.5 §4.8). ──
   *
   * On 2026-09-16 the Flash judge returned `pass: false` on geektime with
   * three correct findings, while the post it was judging carried a badge that
   * rendered as `{ FIELD` on all eight plates and three plates that said
   * nothing but words — and the owner found both in seconds, because he was
   * looking at all eight plates at once. @5 re-centres the rubric on five
   * POST-LEVEL questions, takes a CONTACT SHEET as its primary evidence, and
   * emits `publishable`: the CMO verdict `pass` could never carry, because
   * `pass` is compliance and this is judgement.
   */
  it("instagram-visual-qa@5 resolves, latest.md is byte-identical to 5.md, and v5 asks the five post-level questions", async () => {
    const promptStore = makePromptStore();
    const v4 = await promptStore.getPrompt("instagram-visual-qa", "4");
    const v5 = await promptStore.getPrompt("instagram-visual-qa", "5");
    expect(v5).toBe(await promptStore.getPrompt("instagram-visual-qa"));
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-visual-qa", "5.md"), "utf8")).toBe(
      readFileSync(path.join(PROMPTS_ROOT, "instagram-visual-qa", "latest.md"), "utf8"),
    );
    expect(v5.split(/\r?\n/)[0]).toBe("# Instagram Visual QA Craft Guide — v5");
    // @4 stays frozen and resolvable: a version bump replaces nothing.
    expect(v4.split(/\r?\n/)[0]).toBe("# Instagram Visual QA Craft Guide — v4");

    // The five questions, each with the reserved `ruleId` the judge reports it
    // under — a question with no id is a finding nothing downstream can group.
    const s6 = v5.slice(v5.indexOf("## 6. "), v5.indexOf("## 7. "));
    for (const id of [
      "cmo:stop-and-swipe",
      "cmo:pulls-forward",
      "cmo:one-system",
      "cmo:every-slide-earns-its-place",
      "cmo:would-you-publish",
    ]) {
      expect(s6).toContain(`\`${id}\``);
    }
    // Whitespace-flattened: the prompt is hard-wrapped, so a question can
    // straddle a line break, and a literal substring would be asserting the
    // wrapping rather than the words.
    const flat = (text: string): string => text.replace(/\s+/gu, " ");
    for (const question of [
      "would a reader stop on slide 1 and swipe?",
      "furniture sprinkled on eight plates?",
      "does any slide carry nothing but words?",
      "would you publish this for a paying client?",
    ]) {
      expect(flat(s6)).toContain(question);
    }
    // The two standing rules that keep it from becoming taste: be specific,
    // and judge the post you were given.
    expect(flat(s6)).toContain("Be specific");
    expect(flat(s6)).toContain("not the post you would have made");

    // `publishable` is separate from `pass`, and the prompt says why.
    const s3 = v5.slice(v5.indexOf("## 3. "), v5.indexOf("## 4. "));
    expect(s3).toContain("`publishable`");
    expect(flat(s3)).toContain("a post can satisfy every rule and still be one nobody would publish");

    // The contact sheet is read FIRST and is the evidence for the two
    // questions that are properties of the sequence.
    const s7 = v5.slice(v5.indexOf("## 7. "), v5.indexOf("## 8. "));
    expect(s7).toContain("Read it FIRST");
    expect(flat(s7)).toContain("rhythm and repetition are properties of the sequence");

    // @4's per-slide rule sections survive: they catch real defects, and the
    // workflow still routes `renderRules` findings by their own ids.
    for (const heading of ["## 1. ", "## 2. ", "## 5. "]) expect(v5).toContain(heading);
    expect(v5).toContain("`thisSkeleton` and `previousSkeleton`");
    expect(flat(v5)).toContain("never re-derive or dispute them");
  });

  it("the three Template Studio prompts resolve, each latest.md is byte-identical to its newest version, and each v1 H1 carries v1", async () => {
    const promptStore = makePromptStore();
    // 2026-09-24: the designer is at @2 (it builds on the shell's design system).
    const LATEST: Record<string, string> = { "instagram-design-brief": "1", "instagram-template-designer": "2", "instagram-template-set-review": "1" };
    for (const id of ["instagram-design-brief", "instagram-template-designer", "instagram-template-set-review"]) {
      const v1 = await promptStore.getPrompt(id, "1");
      const newest = LATEST[id]!;
      expect(await promptStore.getPrompt(id, newest)).toBe(await promptStore.getPrompt(id));
      expect(readFileSync(path.join(PROMPTS_ROOT, id, `${newest}.md`), "utf8")).toBe(readFileSync(path.join(PROMPTS_ROOT, id, "latest.md"), "utf8"));
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

    // v2 (2026-09-24): builds on the shell's design system. The six studio
    // templates of the 2026-09-23 refresh all failed gate 6 on web-sized type.
    const designer2 = (await promptStore.getPrompt("instagram-template-designer", "2")).replace(/\r\n/g, "\n");
    expect(designer2.split("\n")[0]).toBe("# Instagram Template Designer Guide, v2");
    for (const needle of ['`<div class="plate">`', "`r-display`", "`r-label`", '`data-fitted="primary"`', "never a\n`font-size` of your own", "You never write a document.", "has to survive being MEASURED"]) {
      expect(designer2).toContain(needle);
    }

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
    expect(registry).toContain(`"14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28"`);
    expect(registry).toMatch(/promptId: "instagram-copy"[\s\S]{0,700}latestVersion: "38"/);
    // Phase 5 (RFC-18 §6.1). The packager's prompt is the one THIS phase added,
    // and the WIP commit this branch inherited had shipped both prompt files
    // with no registry row at all — which `check:prompts` fails on and which
    // this line is the cheap local copy of.
    // Phase 5.5 (spec §6 G2) bumped it to @2: `ALT_TEXT_MAX_CHARS = 125` was
    // enforced on the wire and stated nowhere the model could read it, and one
    // over-long `alt` cost two of three live runs their whole package.
    expect(registry).toContain(`{ promptId: "instagram-post-package", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" }`);
    // Phase 4 (RFC-15 §6). The native editor's prompt is the one this phase
    // added; a row that never lands is exactly what this test exists to catch.
    // Phase 5 bumped it to @2 (RFC-18 §6.5): `@1` documented only the CAROUSEL round's
    // `"caption"`/`"slide:N"` targets, so on `08c2-package-native-round` the judge had no legal target to
    // write and every correction it returned was dropped as cross-context by `resolveField`'s guard.
    expect(registry).toContain(`{ promptId: "instagram-native-editor", agent: "instagram-agent", versions: ["1", "2", "3", "4"], latestVersion: "4" }`);
    // Phase 3 (items Q and R). Phase 5.5 item A3 bumps the vet to @6: the
    // SUBJECT is separated from the scene, and `scene` is declared decorative.
    expect(registry).toContain(`{ promptId: "instagram-image-vet", agent: "instagram-agent", versions: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], latestVersion: "10" }`);
    // Phase 5.5 item A2: `04b3-extract-entities`, the prompt this package added.
    expect(registry).toContain(`{ promptId: "instagram-entities", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
    // Phase 5.5 items C/D bump the director to @2: it now also derives the six
    // frozen axes of `ClientVisualSystem` — the per-client half of the visual
    // system, and the reason two clients' posts stop looking like one machine's.
    expect(registry).toContain(`{ promptId: "instagram-art-director", agent: "instagram-agent", versions: ["1", "2", "3"], latestVersion: "3" }`);
    expect(registry).toContain(`{ promptId: "instagram-visual-qa", agent: "instagram-agent", versions: ["1", "2", "3", "4", "5"], latestVersion: "5" }`);
    expect(registry).toContain(`{ promptId: "instagram-design-brief", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
    expect(registry).toContain(`{ promptId: "instagram-template-designer", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" }`);
    expect(registry).toContain(`{ promptId: "instagram-template-set-review", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
    // Phase 4 (RFC-16): the concept direction prompt.
    expect(registry).toContain(`{ promptId: "instagram-concept", agent: "instagram-agent", versions: ["1"], latestVersion: "1" }`);
  });

  it("every agent reads the version this phase shipped: copy @24, post package @2, visual QA @5, image vet @7, entities @1, art director @2, concept @1", async () => {
    // The last line of a prompt bump, and the one most often forgotten: a new
    // prompt file that no `skillRef` points at exists, resolves, and is read
    // by nothing.
    const promptStore = makePromptStore();
    const copy = new InstagramCopyAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((copy as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-copy@38");
    const packager = new InstagramPostPackagerAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((packager as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-post-package@2");
    const qa = new InstagramVisualQaAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((qa as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-visual-qa@5");
    const vet = new InstagramImageVettingAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((vet as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-image-vet@10");
    const entities = new InstagramEntityAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((entities as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-entities@1");
    const director = new InstagramArtDirectorAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((director as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-art-director@3");
    const concept = new InstagramConceptAgent({ router: fakeRouterSequence([]), tools: {}, promptStore });
    expect((concept as unknown as { config: { skillRef: string } }).config.skillRef).toBe("instagram-concept@1");
  });

  it("every pinned instagram prompt resolves, each byte-identical to its own latest.md", async () => {
    // Phase 3 (items Q and R). The byte comparison is the one `check:prompts`
    // makes too, and it is here as well because a drifted `latest.md` is the
    // failure mode where a run silently reads a DIFFERENT prompt from the one
    // its version pin names.
    const promptStore = makePromptStore();
    for (const [promptId, version, h1] of [
      ["instagram-copy", "38", "# Instagram Copy Craft Guide, v38"],
      ["instagram-post-package", "2", "# Instagram Post Package Guide, v2"],
      ["instagram-image-vet", "10", "# Instagram Image Vetting Craft Guide — v10"],
      ["instagram-entities", "1", "# Instagram Entity Extraction — v1"],
      ["instagram-art-director", "3", "# Instagram Art Direction Guide — v3"],
      ["instagram-concept", "1", "# Instagram Concept Direction Guide — v1"],
    ] as const) {
      const pinned = await promptStore.getPrompt(promptId, version);
      expect(pinned, `${promptId}@${version} must be what "latest" resolves to`).toBe(await promptStore.getPrompt(promptId));
      expect(readFileSync(path.join(PROMPTS_ROOT, promptId, `${version}.md`), "utf8")).toBe(
        readFileSync(path.join(PROMPTS_ROOT, promptId, "latest.md"), "utf8"),
      );
      expect(pinned.split(/\r?\n/)[0]).toBe(h1);
    }
  });

  it("instagram-copy/latest.md is BYTE-identical to 23.md, and 19.md is still exactly 18.md plus §29", () => {
    // The design system (RFC-17 §5.7), step 2 of the five-step checklist.
    //
    // The title and the section numbers below were `17.md`/`§24` until the
    // Phase 5 merge, and the assertions underneath always read 18.md/§28 —
    // this branch's bump was renumbered when main's own @17 arrived first. A
    // test whose NAME describes a different file from the one it opens is how
    // a reader comes to trust the wrong guard, so the name is corrected here
    // rather than left as merge residue.
    //
    // A Buffer comparison, not a decoded-string one. `readFileSync(..., "utf8")`
    // above is what `check:prompts` does and it is the right check for DRIFT,
    // but it cannot see a BOM, a lone CR, or an invalid sequence that decodes
    // to the same replacement character on both sides — and this repo's files
    // are CRLF, so a tool that normalises line endings on one of the two would
    // pass a decoded comparison while shipping a different file to the model.
    // ── @20 IS LIVE, AND IT REVISES A SECTION RATHER THAN APPENDING ONE. ──
    //
    // Every bump before this one added a section, so this case could assert
    // "the new file is the old file plus §N". @20 cannot be checked that way:
    // it REWRITES §6's scene brief, because the defect it fixes was a rule
    // inside that section ("no named real people, brands, products or logos"
    // applied to every sourcing path) which is why a slide about ChatGPT asked
    // for a stock office.
    //
    // **That does not weaken the immutability rule, and the assertions below
    // are what show it.** The rule is that a PUBLISHED version never changes:
    // @19 shipped, so 19.md is frozen and is asserted byte-for-byte against
    // @18 exactly as before. A revision lands as a NEW number, which is what a
    // version is for.
    const v19 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "19.md"));
    const v20 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "20.md"));
    const v21 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "21.md"));
    // Phase 5.6. @24 is the live file: it rewrites §22's `"none"` clause,
    // which named a cost and then exempted every archetype in the set from
    // it, and it names the bounded band for the first time. @23 is published
    // and is therefore frozen, and the assertions below are what prove it:
    // the rule that a published version never changes is the reason a
    // revision lands as a new number rather than as an edit.
    const v22 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "22.md"));
    const v23 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "23.md"));
    const v24 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "24.md"));
    const v25 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "25.md"));
    const v26 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "27.md"));
    const v28 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "28.md"));
    const v29 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "29.md"));
    const v30 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "30.md"));
    const v31 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "31.md"));
    const v32 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "32.md"));
    const v33 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "33.md"));
    const v34 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "34.md"));
    const v35 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "35.md"));
    const v36 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "36.md"));
    const v37 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "37.md"));
    const v38 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "38.md"));
    const latest = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "latest.md"));
    expect(latest.equals(v38), "latest.md must be byte-identical to 38.md, not merely equivalent").toBe(true);
    // v38 (2026-09-26) changes section 28 only: emphasis comes from the display line, never the body.
    const before28 = (b: Buffer) => b.toString("utf8").replace(/^# [^\n]*\n/u, "").split("## 28.")[0];
    expect(before28(v38)).toBe(before28(v37));
    expect(v38.toString("utf8")).toContain("**Mark the DISPLAY line, never the body.**");
    // v37 rolls the diet back: v35's text with only the header changed (batch 5 measured v36 longer).
    expect(v37.toString("utf8").replace("Guide, v37", "Guide, v35")).toBe(v35.toString("utf8"));
    expect(v35.equals(v36), "@35 and @36 are the same file, so the bump changed nothing").toBe(false);
    // v36, the prompt diet: under half the words, every section heading and every identifier kept.
    const words = (b: Buffer) => b.toString("utf8").split(/\s+/u).filter(Boolean).length;
    expect(words(v36)).toBeLessThan(words(v35) * 0.6);
    const headings = (b: Buffer) => b.toString("utf8").split(/\r?\n/u).filter((l) => l.startsWith("## "));
    expect(headings(v36)).toEqual(headings(v35));
    const idents = (b: Buffer) => new Set([...b.toString("utf8").matchAll(/`([^`\s](?:[^`\n]{0,58}[^`\s])?)`/gu)].map((m) => m[1]!.replace(/\s+/gu, " ")));
    const kept = idents(v36);
    const lost = [...idents(v35)].filter((id) => !kept.has(id) && !v36.toString("utf8").replace(/\s+/gu, " ").includes(id));
    expect(lost, "v36 dropped backticked identifiers").toEqual([]);
    expect(v34.equals(v35), "@34 and @35 are the same file, so the bump changed nothing").toBe(false);
    // v35 (decision 20): the 35-word plate and the 16-word photo cover.
    expect(v35.toString("utf8").replace(/\s+/gu, " ")).toContain("A whole plate has a budget, not only its parts.** 35 words");
    expect(v33.equals(v34), "@33 and @34 are the same file, so the bump changed nothing").toBe(false);
    // v34 (owner rulings 2026-09-25): a poster cover by default, and no link-in-bio or follow closer.
    const v34Text = v34.toString("utf8").replace(/\s+/gu, " ");
    expect(v34Text).toContain("Slide 1 carries a photograph of the story's subject by default");
    expect(v34Text).toContain('Never "link in bio" and never a "follow us" line or card');
    expect(v32.equals(v33), "@32 and @33 are the same file, so the bump changed nothing").toBe(false);
    expect(v33.toString("utf8")).toContain("## 32. What breaks out in this niche");
    expect(v31.equals(v32), "@31 and @32 are the same file, so the bump changed nothing").toBe(false);
    // What @32 adds (2026-09-25, owner feedback WS-10): complete sentences, no
    // negation habit, and the guide no longer models "X is not Y. It is Z.".
    const v32Text = v32.toString("utf8");
    expect(v32Text).toContain("## 31. Sentences a person would say");
    // Compared with line breaks folded to spaces, so a habit wrapped across two prompt lines still counts.
    const flat = v32Text.replace(/\s+/gu, " ");
    for (const habit of ["X is not the reason Y happens. Z is.", "(\"not this. that.\")", "is not dying of old age", "\u05dc\u05d0 \u05de\u05ea \u05de\u05d6\u05e7\u05e0\u05d4"]) {
      expect(flat).not.toContain(habit);
    }
    expect(v30.equals(v31), "@30 and @31 are the same file, so the bump changed nothing").toBe(false);
    // What @31 adds (2026-09-23): a news cover always briefs a photograph.
    expect(((t: string) => t.slice(t.indexOf("## 12. "), t.indexOf("## 13. ")))(v31.toString("utf8"))).toContain("**When your input carries `newsFlash: true`, the one slide is a news cover**");
    expect(v29.equals(v30), "@29 and @30 are the same file, so the bump changed nothing").toBe(false);
    // What @30 adds (2026-09-23): named before anonymous, real before drawn,
    // and none of section 22's examples is the feed's laptop cliché any more.
    const v30Text = v30.toString("utf8");
    expect(v30Text).toContain("**Named before anonymous, real before drawn.**");
    for (const cliche of ["a laptop in a dark room with a cursor", '["a laptop", "a dark room"]', '["laptop", "wooden desk", "morning light"]', "someone at a desk with two tabs open"]) {
      expect(v30Text, cliche).not.toContain(cliche);
      expect(v29.toString("utf8"), `the premise: @29 taught ${cliche}`).toContain(cliche);
    }
    expect(v28.equals(v29), "@28 and @29 are the same file, so the bump changed nothing").toBe(false);
    // What @29 adds (2026-09-23): the two new device shapes in section 19, and
    // the photo-first band in sections 7 and 22. Asserted on the live file.
    const v29Text = v29.toString("utf8");
    const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));
    const s19v29 = between(v29Text, "## 19. ", "## 20. ");
    for (const kind of ["position_map", "spec_table"]) expect(s19v29).toContain(`- **\`${kind}\`**`);
    expect(s19v29).toContain("Eight shapes:");
    expect(between(v29Text, "## 7. ", "## 8. ")).toContain("**Unless `pictureDensity` is `photo-first`.**");
    expect(v26.equals(v28), "@27 and @28 are the same file, so the bump changed nothing").toBe(false);
    expect(v25.equals(v26), "@25 and @26 are the same file, so the bump changed nothing").toBe(false);
    expect(v24.equals(v25), "@24 and @25 are the same file, so the bump changed nothing").toBe(false);
    expect(v23.equals(v24), "@23 and @24 are the same file, so the bump changed nothing").toBe(false);
    expect(v22.equals(v23), "@22 and @23 are the same file, so the bump changed nothing").toBe(false);
    expect(v21.equals(v22), "@21 and @22 are the same file, so the bump changed nothing").toBe(false);
    expect(v20.equals(v21), "@20 and @21 are the same file, so the bump changed nothing").toBe(false);
    expect(v19.equals(v20), "@19 and @20 are the same file, so that bump changed nothing").toBe(false);
    const v21Text = v21.toString("utf8");
    const v22Text = v22.toString("utf8");
    expect((v21Text.split(String.fromCharCode(10))[0] ?? "").replace(String.fromCharCode(13), "")).toBe("# Instagram Copy Craft Guide, v21");
    expect((v22Text.split(String.fromCharCode(10))[0] ?? "").replace(String.fromCharCode(13), "")).toBe("# Instagram Copy Craft Guide, v22");
    // What @22 itself adds, asserted against the LIVE file so a later revision
    // that dropped any of them fails here rather than in a prep run.
    expect(v22Text, "@22 must document the scene brief's subject").toContain("WHAT IS ACTUALLY IN FRONT OF THE CAMERA");
    expect(v22Text, "@22 must document the entity list the run corroborated").toContain("`namedEntities`: the things this run can actually prove it is about");
    expect(v22Text, "@22 must document the non-blocking scene steer").toContain("`sceneSteer` is a FOURTH separate field");
    expect(v22Text, "@22 must refuse an abstract subject noun").toContain("Never an abstract");
    expect(v22Text, "@22 must keep technique words out of the search terms").toContain("No technique words");
    // @21's own additions are INHERITED by @22, which is the other half of the
    // immutability claim: a bump that quietly dropped a shipped rule would pass
    // every assertion about @21 and ship a worse prompt.
    for (const inherited of ["customArchetypeBrief", "`unfillable`", "Where the hard wall is", "The cover has one subject and no furniture"]) {
      expect(v22Text, `@22 must inherit ${inherited}`).toContain(inherited);
    }
    for (const heading of ["## 24. Value:", "## 25. Take a position", "## 26. Rhythm", "## 27. The source's prose is not yours", "## 28. Marking", "## 29."]) {
      expect(v21Text, `@21 must inherit ${heading}`).toContain(heading);
    }
    // @20 revised �6 and @21 inherits every byte of it, so its two markers are
    // asserted against the LIVE file rather than against the frozen one: a
    // revision that dropped them would otherwise pass.
    expect(v21Text, "@21 must inherit the rule that unblocked interesting imagery").toContain("Name the actual subject");
    expect(v21Text, "@21 must inherit the identity rule split by sourcing path").toContain("The identity rule depends on where the picture comes from");
    // And what @21 itself ADDS (Phase 5.5, brief item B): the markup hoist, the
    // field for an object an archetype cannot fill, the schema length wall and
    // the one-subject cover.
    expect(v21Text, "@21 must hand the markup to 05f rather than asking the writer for it").toContain("customArchetypeBrief");
    expect(v21Text, "@21 must give the writer somewhere other than the copy to report an unfillable object").toContain("`unfillable`");
    expect(v21Text, "@21 must state where the schema length wall is").toContain("Where the hard wall is");
    expect(v21Text, "@21 must carry the one-subject cover rule").toContain("The cover has one subject and no furniture");
    // Published versions are immutable, and this is the half that proves the
    // hoist really moved: @20 asked the writer for markup and still does.
    const v20Text = v20.toString("utf8");
    expect(v20Text, "@20 is frozen and it is the version that asked for bodyHtml").toContain("**`bodyHtml`**");
    expect(v21Text, "@21 must not ask the writer for markup any more").not.toContain("**`bodyHtml`**");

    // Published versions are IMMUTABLE: @18 shipped on main and is what every
    // in-flight run and every pinned fixture still resolves, so the bump must
    // be additive. This reconstructs 19.md from 18.md and fails if any earlier
    // section was edited in passing.
    const v18 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "18.md"), "utf8");
    expect(v18, "@18 is published and frozen; §29 belongs to @19 alone").not.toContain("## 29.");
    const v19Text = v19.toString("utf8");
    // @19 = @18 with the h1 bumped, a v19 changelog note inserted under it, and
    // §29 appended. Everything from §1 to §28 is inherited character for
    // character, which is what this slice asserts.
    const inherited = v18.slice(v18.indexOf("**What changed at v18.**")).trimEnd();
    expect(v19Text, "@19 must inherit every byte of @18 from its changelog note onward").toContain(inherited);
    expect(v19Text.split(/\r?\n/)[0]).toBe("# Instagram Copy Craft Guide, v19");
    // Phase 5's value sections and @18's marking section survive the bump;
    // losing one is the defect this whole reconciliation exists to prevent.
    for (const heading of ["## 24. Value:", "## 25. Take a position", "## 26. Rhythm", "## 27. The source's prose is not yours", "## 28. Marking"]) {
      expect(v19Text, `@19 must inherit ${heading}`).toContain(heading);
    }
    const section29 = v19Text.slice(v19Text.indexOf("## 29."));
    // ≈3,290 characters for the section, and the FILE grows 3,715 once the
    // v19 changelog note above it is counted — which is the figure
    // `run-budget.ts` prices the input half of the 0.181 -> 0.185 re-price
    // on. A section that quietly doubled would make that re-price wrong,
    // which is the only reason this bound exists.
    expect(section29.length).toBeGreaterThan(3000);
    expect(section29.length).toBeLessThan(3800);
    expect(v19Text.length - v18.length).toBeGreaterThan(3400);
    expect(v19Text.length - v18.length).toBeLessThan(4100);
  });

  it("§28 carries the TOPIC RULE, the verbatim contract, and its own interaction with checkSentenceCase", () => {
    // The design system (RFC-17 Part 1). THE ONE RULE THAT OVERRIDES EVERY OTHER RULE IN
    // THIS PHASE. §28 teaches the model an EXECUTION borrowed from reference
    // accounts that post about AI and marketing, and the failure it could
    // cause is not a broken render — it is a beautiful, well-marked slide
    // about a subject the client does not do, which is the original audit
    // failure repeating with better typography. The sentence is load-bearing
    // enough that its absence must be a red build, not a review comment.
    const v18 = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "18.md"), "utf8");
    const section28 = v18.slice(v18.indexOf("## 28."));
    expect(section28.startsWith("## 28."), "§28 must exist in 18.md").toBe(true);

    expect(section28).toContain("Do not reach for a subject the client's brief and topic engines did not give");
    expect(section28).toContain("Reference EXECUTION transfers; reference SUBJECT MATTER never");

    // The span contract. A span is located by exact match and DROPPED when it
    // does not occur (RFC-17 finding 6: character offsets cannot survive
    // `iso()` or the Phase 4 native editor), so the prompt has to say both
    // halves — copy verbatim, and what silently happens when you do not.
    expect(section28).toContain("VERBATIM");
    expect(section28).toContain("DROPPED");

    // The split RFC-17 finding 2 turns on: the model cannot see the ground, so
    // it never chooses how a mark is painted.
    expect(section28).toContain("You choose WHICH words. You never choose the colour, the weight, or how the");
    // Part 4 obs. 5 — rf-05 S3 marks `Handwritten notes` and leaves `2-` bare.
    expect(section28).toContain("Never the numeral");
    // The floor's own complaint, restated for copy: a mark over everything
    // marks nothing, and an invented phrase is a fabricated reason to mark.
    expect(section28).toContain("Never a whole line");
    expect(section28).toContain("Do not invent a phrase in order to have something to mark");

    // §10 vs §28. Before this phase the system had a rule AGAINST emphasis
    // (`checkSentenceCase` + `EMPHASIS_DENYLIST`) and no rule FOR it, so a
    // model that wanted to stress a word had only shouting available and got
    // the whole draft returned for it. §28 has to name the mechanism it does
    // not replace, or it reads as permission to shout.
    expect(section28).toContain("checkSentenceCase");
    expect(section28).toContain("Shouting is still refused");
    expect(section28).toContain("sanctioned way to emphasise");

    // §28 obeys the prompt's own craft rules (§10): no em/en dashes, no
    // double hyphens, no exclamation marks. A section that breaks the rules it
    // sits beside teaches the model that they are negotiable.
    expect(section28).not.toMatch(/[—–]/);
    expect(section28).not.toContain("--");
    expect(section28).not.toContain("!");

    // THE READING ORDER, which replaced the field names (RFC-17 §6.4).
    //
    // Until the compact re-encode, §28 named a `field` and an `itemIndex` per
    // mark and this loop pinned those six literals. The wire shape is now a
    // bare string and CODE locates it, so the model no longer names a field at
    // all — but the order it is searched in is now part of the contract the
    // writer has to reason about, because a repeated word is marked at its
    // FIRST unmarked occurrence and nowhere else. That order is the thing a
    // reader of the prompt can get wrong, so it is what gets pinned.
    expect(section28).toContain("`emphasis`");
    // `\r?\n` because these files are CRLF and the sentence wraps: a literal
    // "\n" here would never match and the guard would be decoration.
    expect(section28, "§28 must state the search order, or a repeated word's mark lands somewhere the writer did not intend").toMatch(
      /searching the headline, then the body, then\r?\nthe quote, then the list rows in order/,
    );
    expect(section28, "§28 must say a string is marked once, or the writer will name a repeated word twice").toContain("marked once per slide");

    // The model must never be told a TEMPLATE SLOT name (RFC-17 §5.1):
    // `contentFor` routes `headline` to `title` on a cover and to `takeaway`
    // on a closer, and a prompt that leaked those would couple copy to layout.
    expect(section28, "§28 must not name a template slot").not.toContain("Runs`");
    for (const slot of ["`title`", "`takeaway`", "`itemIndex`"]) {
      expect(section28, `§28 must not name ${slot}: code locates marks now, the writer does not`).not.toContain(slot);
    }
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
    const router = fakeRouterSequence([finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN)]);
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
    // they belong there and nowhere else in this list. Phase 3 item Q's art
    // director (`00d2`) follows them, on the same setup meter, still before
    // `03-claim-topic`. Phase 4 (RFC-16) put `concept` (`04m`) between `angle`
    // and `copy`, which is where the workflow buys it: `04l` scores the story
    // off the CHOSEN angle, so it cannot precede `04j`, and `04n` applies the
    // result only after copy is accepted. Unlike every other key here it is
    // CONDITIONAL — the selector declines most stories — so it is absent from
    // `happyTurns` and a fixture must opt in.
    expect([...TURN_ORDER]).toEqual([
      "brief",
      "designBrief",
      "templateDesign",
      "setReview",
      "templateRepair",
      "artDirection",
      "scout",
      "research",
      "angle",
      // Phase 5.5 (spec A2). `04b3-extract-entities` sits immediately after
      // `04j-select-angle` — it reads the chosen angle's own words as half its
      // grounding evidence — and before `04i2-select-series`. UNCONDITIONAL:
      // the workflow buys it on EVERY revision, which is why it is DEFAULTED in
      // `standardTurns` rather than opt-in like `concept` and
      // `customArchetype`. An absent key means `{ entities: [] }`, which is the
      // answer a story naming nothing picturable actually has.
      "entities",
      "concept",
      "copy",
      // Phase 5.5 (spec §3 B3). `05f-author-custom-archetype` sits between the
      // copy step and anything that asks for a picture, because it is the
      // second half of the DRAFT: the markup for a layout the writer chose and
      // no longer authors itself. CONDITIONAL, like `concept` — the workflow
      // buys it only when a draft emits a `customArchetypeBrief`, and none of
      // the six 2026-09-16 prep runs did — so it is absent from `happyTurns`
      // and a fixture must opt in.
      "customArchetype",
      "vet",
      // Phase 5.5 (spec §2 A1b). `06h2-vet-floor-images` is the SECOND
      // vetting turn, and it exists because `06h-imagery-floor-check` reads
      // what actually LANDED rather than what was planned: a post short of
      // both `MIN_PICTURE_SLIDES` and `MIN_GENERATED_IMAGES_PER_RUN`
      // re-enters generation REGARDLESS OF THE BUDGET PLAN, and those
      // pictures are vetted like any others. `06h` itself is `wf.step.code`
      // at $0 and buys no turn, which is why only the vet appears here.
      // CONDITIONAL and rare — a fixture whose ordinary vetting turn fills
      // three slides never reaches it — so it is absent from `happyTurns`
      // and a fixture must opt in.
      "imageryFloorVet",
      "relevance",
      // Phase 5 (RFC-18 §2 and §12). `07j-value-judge` sits HERE, between
      // relevance and the native editor, and nowhere else. AFTER relevance
      // because a post that is not this client's business is dead anyway and
      // relevance is the cheaper refusal. BEFORE the native editor because the
      // editor's corrections are ANCHORED SPANS into headline/body/caption, so
      // a value-driven rewrite landing after `07f` would invalidate every
      // applied correction and every span a second round rests on. Language is
      // the last word on the sentences, and this line is where that decision is
      // actually enforced against thirty files' worth of positional fixtures.
      "valueJudge",
      // Phase 4 (RFC-15 §6.5) renamed this slot `fluency` -> `nativeEditor`
      // and made it VARIADIC (one entry per judge round). It did not move:
      // the native editor runs at the same point in the run the fluency judge
      // did, which is what keeps every existing workflow fixture's turn order
      // valid.
      "nativeEditor",
      "qa",
      // The packager pair sits AFTER `qa`, because `08c*` runs once the attempt
      // loop has broken: alt text written for a slide a redraft is about to
      // throw away is money burned, and none of the package's fields is an
      // input to any gate inside the loop. `packageNative` is its own key
      // rather than one more entry in `nativeEditor`'s variadic slot precisely
      // because it is consumed at a DIFFERENT position; folding it in would
      // desynchronise every fixture that queues a carousel round.
      "postPackager",
      "packageNative",
    ]);

    const labelled = standardTurns({
      // `valueJudge` and `postPackager` are passed explicitly here even though
      // `standardTurns` would default them, so this assertion stays about ORDER
      // rather than about what the defaults happen to contain. The defaulting
      // itself is `turns.ts`'s own contract and is tested where it lives.
      valueJudge: "valueJudge",
      postPackager: "postPackager",
      qa: "qa",
      copy: "copy",
      brief: "brief",
      angle: "angle",
      entities: "entities",
      concept: "concept",
      customArchetype: "customArchetype",
      research: "research",
      scout: "scout",
      vet: "vet",
      imageryFloorVet: "imageryFloorVet",
      relevance: "relevance",
      nativeEditor: ["nativeEditor"],
      designBrief: "designBrief",
      templateDesign: ["design1", "design2"],
      setReview: "setReview",
      templateRepair: ["repair1"],
      artDirection: "artDirection",
    });
    const outputs = labelled.map((turn) => (turn().output as { output: unknown }).output);
    expect(outputs).toEqual([
      "brief",
      "designBrief",
      "design1",
      "design2",
      "setReview",
      "repair1",
      "artDirection",
      "scout",
      "research",
      "angle",
      "entities",
      "concept",
      "copy",
      "customArchetype",
      "vet",
      "imageryFloorVet",
      "relevance",
      "valueJudge",
      "nativeEditor",
      "qa",
      "postPackager",
    ]);

    // Omitted keys are skipped, not defaulted: a run that stops before the
    // renderer queues no QA turn.
    expect(standardTurns({ copy: "copy", vet: "vet" })).toHaveLength(2);
    // And `concept` in particular is skipped when omitted — the case every
    // existing fixture is in, since `04l` declines the canonical story. If it
    // ever defaulted, every workflow fixture in the package would consume its
    // turns one out of step.
    // `entities` is DEFAULTED and rides the angle, so a block that carries an
    // angle queues an empty entity set behind it. That is the whole point of
    // defaulting it: `04b3` runs on every revision, so an absent key cannot
    // honestly mean "no turn" the way it does for `concept`.
    expect(standardTurns({ angle: "angle", copy: "copy" }).map((t) => (t().output as { output: unknown }).output)).toEqual([
      "angle",
      { entities: [] },
      "copy",
    ]);
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
