import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramPostPackagerAgent } from "../src/agent/instagram-post-packager-agent.js";
import { fakeRouterSequence, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

/**
 * **THE FILENAME IS HISTORICAL. This suite tracks the copy prompt's LATEST version, not v17.** It was written
 * for @17 and now guards @20; renaming it is a deliberate act someone should do when nothing else is in
 * flight, not a drive-by rename in a file other work is open in. Whoever touches it next: rename it then.
 *
 * Phase 5 (RFC-18 §3 and §6.1) — THE FIVE-STEP PROMPT BUMP, for BOTH prompts this phase ships, asserted as
 * five separate facts rather than as one.
 *
 * A prompt bump in this repo is not "write the file". It is five things, and the failure mode every previous
 * bump has actually hit is that four of them land and one does not: a `17.md` that no `skillRef` points at, a
 * `latest.md` frozen at the previous version so every run silently reads the OLD prompt while the version pin
 * says otherwise, or a registry row that never gets written — which is exactly what the WIP commit this
 * branch inherited had done. Both prompt files and the agent edit were committed; `scripts/prompt-registry.ts`
 * was never touched, so `npm run check:prompts` would have failed on a version present on disk with no row.
 *
 * `npm run check-prompts` is the real cross-check (registry against disk, both directions). This suite is the
 * local, fast copy of the half a package author can get wrong, plus the two facts `check-prompts` cannot know:
 * which `skillRef` the agent class reads, and the dash ban.
 *
 * ## Why the dash assertion is here and not in a lint rule
 *
 * The copy prompt BANS em dashes, en dashes and double hyphens in the copy it asks for (§10), and v1 and v2
 * used all three while doing it — nine and eleven times. A prompt that breaks its own rule teaches the model
 * the rule is decorative, and prep run pubsub-21066191524607951 failed the mechanical craft-hygiene gate on
 * exactly that character on two of three attempts. @17 removed the last of them from the INHERITED sections
 * too, so the assertion is now over the whole file rather than over the new sections.
 *
 * ## The break-the-guard proof
 *
 * Every assertion below was run against a deliberately broken tree before it was trusted:
 * `latestVersion: "16"` in the registry fails the registry case; `skillRef: "instagram-copy@16"` fails the
 * skillRef case; a one-byte edit to `latest.md` fails the byte-identity case; deleting the registry row fails
 * the packager case; and a single em dash pasted into either prompt fails the dash case. Reverting P2 whole
 * fails every one of them, which is this suite's stated acceptance criterion.
 */

const REGISTRY_PATH = path.join(PROMPTS_ROOT, "..", "..", "..", "scripts", "prompt-registry.ts");

/** The five facts, one row per prompt this phase bumps. `h1` is step 4's version line. */
const BUMPED = [
  {
    // FOLLOWS THE LIVE VERSION. Pinned at @17 these five steps would keep passing forever while guarding a
    // file no run loads any more — a guard that cannot fail in the way that matters, which is the failure
    // mode this repo keeps catching. @22 (Phase 5.5, spec §2 A2/A3) is @21 plus the scene brief's SUBJECT in
    // §22, the `namedEntities` input in §6 and the non-blocking `sceneSteer` in §16; it inherits every other
    // section unchanged, so following costs this suite no coverage and keeps it pointed at the prompt a run
    // actually reads. The Phase 5 sections the second block below asserts by name are all still present at
    // @22, which is what makes following safe rather than merely cheap.
    promptId: "instagram-copy",
    version: "31",
    h1: "# Instagram Copy Craft Guide, v31",
    skillRef: "instagram-copy@31",
    agent: () => new InstagramCopyAgent({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() }),
  },
  {
    // FOLLOWS THE LIVE VERSION, for the same reason the copy row above does.
    // Phase 5.5 (spec §6 G2): @2 states the 125-CHARACTER alt-text limit the
    // wire had always enforced and the prompt had never mentioned, which is
    // what cost two of three live runs on 2026-09-16 their hashtags AND their
    // alt text on one over-long `alt`.
    promptId: "instagram-post-package",
    version: "2",
    h1: "# Instagram Post Package Guide, v2",
    skillRef: "instagram-post-package@2",
    agent: () => new InstagramPostPackagerAgent({ router: fakeRouterSequence([]), tools: {}, promptStore: makePromptStore() }),
  },
] as const;

const readPrompt = (promptId: string, file: string): string => readFileSync(path.join(PROMPTS_ROOT, promptId, file), "utf8");

const skillRefOf = (agent: unknown): string => (agent as { config: { skillRef: string } }).config.skillRef;

describe("the copy prompt bump: instagram-copy@23 (live) and instagram-post-package@2 (live)", () => {
  for (const { promptId, version, h1, skillRef, agent } of BUMPED) {
    describe(`${promptId}@${version}`, () => {
      it(`step 1: prompts/${promptId}/${version}.md exists and is not a stub`, () => {
        const file = path.join(PROMPTS_ROOT, promptId, `${version}.md`);
        expect(existsSync(file), `${file} does not exist`).toBe(true);
        // A version file that resolves but says nothing is the same defect as one that is missing, and it is
        // the shape a half-finished bump leaves behind.
        expect(readFileSync(file, "utf8").length).toBeGreaterThan(2_000);
      });

      it(`step 2: latest.md is BYTE-IDENTICAL to ${version}.md`, () => {
        // Not "resolves to the same thing" — the same bytes. A drifted `latest.md` is the failure where a run
        // reads a DIFFERENT prompt from the one its version pin names, and it survived three commits in
        // `blog-craft` before the registry existed.
        expect(readPrompt(promptId, "latest.md")).toBe(readPrompt(promptId, `${version}.md`));
      });

      it(`step 3: the agent class's skillRef reads ${skillRef}`, () => {
        // The last line of a bump and the one most often forgotten: a new prompt file that no `skillRef`
        // points at exists, resolves, and is read by nothing.
        expect(skillRefOf(agent())).toBe(skillRef);
      });

      it(`step 4: the H1 carries the version, and a ledger states the INPUT and OUTPUT deltas separately`, () => {
        const text = readPrompt(promptId, `${version}.md`);
        expect(text.split(/\r?\n/)[0]).toBe(h1);

        // The house rule the @14 to @15 note exists to enforce: an output-heavy bump priced on its input
        // alone under-counted by nine tenths, so BOTH sides are stated every time, including the times one
        // side is nearly zero. Asserted as two separate labelled statements, because a ledger that says
        // "costs a bit more" satisfies no reader and no future re-pricing.
        //
        // READ FROM WHEREVER THE LEDGER LIVES. It used to sit inline in the
        // prompt's first 4,000 characters, which meant the model paid on every
        // call to read an accounting note written for a human — and, stacked
        // five versions deep, that was 11% of `instagram-copy`. Prompts that
        // have moved their history to a CHANGELOG.md are checked there; ones
        // that have not are checked in place, so this does not force a
        // migration on a prompt nobody has touched.
        //
        // The RULE is unchanged either way, and it is the rule that matters:
        // every bump is priced, on both sides, in writing.
        const changelogPath = path.join(PROMPTS_ROOT, promptId, "CHANGELOG.md");
        const hasChangelog = existsSync(changelogPath);
        const ledger = hasChangelog
          ? readFileSync(changelogPath, "utf8").slice(0, 8_000)
          : text.slice(0, 4_000);
        expect(ledger).toMatch(/\bINPUT\b[:.]/);
        expect(ledger).toMatch(/\bOUTPUT\b[:.]/);
        expect(ledger).toMatch(/\$0\.\d+/);

        // Once a prompt HAS a changelog, the prompt itself must not keep one
        // too, or the move was cosmetic and the model still pays for it.
        if (hasChangelog) expect(text).not.toMatch(/^\*\*What changed at v/m);
      });

      it(`step 5: scripts/prompt-registry.ts carries ${promptId} with "${version}" in versions and latestVersion "${version}"`, () => {
        // Read as TEXT rather than imported: `scripts/*.ts` compiles as CommonJS and uses `__dirname`, so
        // importing it into an ESM test fails for a reason that has nothing to do with the registry.
        const registry = readFileSync(REGISTRY_PATH, "utf8");
        const entry = registry.slice(registry.indexOf(`promptId: "${promptId}"`));
        expect(entry.length, `no registry row for ${promptId}`).toBeGreaterThan(0);
        expect(registry).toContain(`promptId: "${promptId}"`);
        // Scoped to this prompt's own row, so a `latestVersion: "1"` belonging to some other prompt cannot
        // satisfy it: the first `latestVersion:` after this `promptId:` is this row's.
        const window = entry.slice(0, entry.indexOf("latestVersion:") + 40);
        expect(window).toMatch(new RegExp(`versions: \\[[^\\]]*"${version}"[^\\]]*\\]`));
        expect(window).toContain(`latestVersion: "${version}"`);
      });

      it("contains no em dash, no en dash and no literal double hyphen, anywhere in the file", () => {
        const text = readPrompt(promptId, `${version}.md`);
        // Written as escapes so the assertion survives a future editor's encoding, and reported with an
        // excerpt so a failure names the line rather than the count.
        for (const [name, needle] of [
          ["em dash (U+2014)", "—"],
          ["en dash (U+2013)", "–"],
          ["double hyphen", "--"],
        ] as const) {
          const at = text.indexOf(needle);
          expect(at, `${promptId}@${version} contains a ${name}: ...${text.slice(Math.max(0, at - 60), at + 60)}...`).toBe(-1);
        }
        // And latest.md too, which step 2 already implies but which is the file a run without a version pin
        // actually reads.
        expect(readPrompt(promptId, "latest.md")).not.toMatch(/[—–]|--/);
      });
    });
  }

  /**
   * THE ANTI-TAUTOLOGY. Without this, every assertion above would pass against a repo where the dash
   * characters simply never appear in any prompt — which would make the dash guard a test of nothing.
   * `instagram-copy@1` used all three while instructing the model not to, and it is frozen on disk, so the
   * guard is provably able to see the thing it is looking for.
   */
  it("the premise: an OLDER instagram-copy version really does contain the characters @17 is asserted not to", () => {
    const v1 = readPrompt("instagram-copy", "1.md");
    expect(v1).toMatch(/[—–]/);
  });

  it("the two prompts carry the Phase 5 sections they exist for, so a file that resolves but says nothing cannot pass", () => {
    const copy = readPrompt("instagram-copy", "19.md");
    // §24 to §27, the four sections RFC-18 §3.1 adds, by heading rather than by body text.
    for (const heading of [
      "## 24. Value: the payload, the named specific, and the ask",
      "## 25. Take a position",
      "## 26. Rhythm",
      "## 27. The source's prose is not yours",
    ]) {
      expect(copy, `instagram-copy@17 is missing "${heading}"`).toContain(heading);
    }
    // §12's new output field, §16's fifth steer, and §16's anti-regression sentence, each named by RFC-18
    // §3.1 as a specific deliverable of this bump.
    expect(copy).toContain("`payloadKind`");
    expect(copy).toContain("`valueSteer`");
    // Whitespace-normalised: the file is hard-wrapped and CRLF, so the sentence spans a line break, and an
    // assertion that depended on WHERE it wrapped would fail the next time anyone reflowed the paragraph.
    expect(copy.replace(/\s+/g, " ")).toContain("Text quoted under KEEP AS WRITTEN has already been accepted. Reproduce it unchanged.");

    // Follows the live version with the row above: @2 inherits every one of
    // @1's three field sections and adds the alt-text limit.
    const pkg = readPrompt("instagram-post-package", "2.md");
    for (const field of ["`hashtags`", "`altText`", "`firstCommentText`"]) {
      expect(pkg, `instagram-post-package@2 never names ${field}`).toContain(field);
    }
  });

  /**
   * The ground-truth discipline, in BOTH places RFC-18 requires it.
   *
   * The original audit failure was a client inheriting a reference account's SUBJECT. The sentence that
   * prevents it is written into §15 (where the client's own identity is established) and again into §24
   * (where the borrowed craft is introduced), deliberately and redundantly, so an editor tightening one
   * section cannot drop it and leave a file that still looks complete. Delete it from either section and this
   * fails.
   */
  it("the EXECUTION-transfers / SUBJECT-MATTER-never sentence appears in BOTH §15 and §24 of instagram-copy@17", () => {
    const copy = readPrompt("instagram-copy", "19.md");
    const sentence = "THE EXECUTION\nTRANSFERS. THE SUBJECT MATTER NEVER DOES.";
    const normalised = copy.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
    const occurrences = normalised.split(sentence.replace(/\s+/g, " ")).length - 1;
    expect(occurrences, "the discipline sentence must appear twice, once in §15 and once in §24").toBe(2);

    // And they really are in those two sections, not twice in one of them.
    const s15 = normalised.indexOf("## 15.");
    const s16 = normalised.indexOf("## 16.");
    const s24 = normalised.indexOf("## 24.");
    const s25 = normalised.indexOf("## 25.");
    expect(s15).toBeGreaterThan(-1);
    expect(s24).toBeGreaterThan(s16);
    const inSection = (from: number, to: number): boolean =>
      normalised.slice(from, to).includes(sentence.replace(/\s+/g, " "));
    expect(inSection(s15, s16), "§15 must carry it").toBe(true);
    expect(inSection(s24, s25), "§24 must carry it").toBe(true);
  });

  /**
   * §24.3 quotes `gate.lintPost`'s banned-CTA bank VERBATIM, as the wordings that fail the draft on contact.
   *
   * The point of quoting it rather than paraphrasing it is that the model is told the exact strings a free
   * mechanical check will reject, so it never spends an attempt discovering them. The point of asserting it
   * HERE is that the bank lives in another package (`packages/tools/karos-gates/src/lint-post.ts`) and can
   * change without this prompt knowing: add a phrase there and this test says the prompt is now stale.
   *
   * Deliberately a subset check on the engagement-bait and sales halves rather than the whole bank: the bank's
   * first half is generic AI-slop vocabulary ("delve into", "supercharge") that §10 already bans by other
   * means, and RFC-18 §3.4 names exactly the CTA wordings this section is about.
   */
  it("§24.3 carries gate.lintPost's banned-CTA wordings verbatim, so a stale copy of the bank is visible", () => {
    const copy = readPrompt("instagram-copy", "19.md");
    for (const phrase of [
      "unpopular opinion:",
      "hot take:",
      "nobody talks about",
      "agree?",
      "thoughts?",
      "rt if",
      "drop a 🔥",
      "comment below",
      "let me know your thoughts",
      "feel free to dm",
      "check out our",
      "check out my",
      "we offer",
      "our platform helps",
      "link in my bio",
      "don't miss out",
      "limited time",
      "act now",
    ]) {
      expect(copy, `§24.3 does not quote "${phrase}"`).toContain(phrase);
    }
    // And it says WHY they are banned, which is the craft point: they are the lazy forms of an ask, not
    // evidence that asking is wrong. Without this line a writer reads the list as "do not ask for anything"
    // and the `action` axis then fails every draft.
    expect(copy).toMatch(/LAZY forms of an ask/);
  });
});
