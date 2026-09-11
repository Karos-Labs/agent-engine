import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 3, item R — the three prompt files this work package authors, checked
 * for the properties `check:prompts` and `prompt-resolution.test.ts` cannot
 * see: that the version line matches the filename, that the content the item
 * promised is actually in the file, and that the copy prompt honours its own
 * editor's note.
 *
 * Deliberately assertion-stable across integration: nothing here compares a
 * numbered version against `latest.md` for `instagram-copy` or
 * `instagram-image-vet`, because the integrator copies those two in the same
 * change that bumps `scripts/prompt-registry.ts`, and a test that asserted the
 * mid-integration state would have to be edited again the moment it was true.
 * `prompt-resolution.test.ts` owns the byte-identity check for all of them.
 */

const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

function read(promptId: string, file: string): string {
  return readFileSync(path.join(PROMPTS, promptId, file), "utf8").replace(/\r\n/gu, "\n");
}

describe("instagram-copy@15 — the scene brief", () => {
  const v14 = read("instagram-copy", "14.md");
  const v15 = read("instagram-copy", "15.md");

  it("carries its own version in the H1", () => {
    expect(v15.split("\n")[0]).toBe("# Instagram Copy Craft Guide, v15");
  });

  it("documents the scene brief, the four keys and the explicit source choice in a new section 22", () => {
    expect(v15).toContain("## 22. The scene brief, and choosing where the picture comes from");
    for (const key of ["`scene`", "`why`", "`source`", "`searchTerms`"]) expect(v15).toContain(key);
    for (const source of ['`"stock"`', '`"client-upload"`', '`"generate"`', '`"none"`']) expect(v15).toContain(source);
  });

  it("states the bias — photo-driven by default, `none` for what is not photographable", () => {
    expect(v15).toContain("**Photo-driven is the default.**");
    expect(v15).toMatch(/`"none"` is for ideas that are not\nphotographable/u);
  });

  it("states the cost of `none`: that slide must carry a device (where items L, M and R meet)", () => {
    expect(v15).toContain("A slide with no picture\nMUST carry a `device`");
    expect(v15).toContain("`list_takeaway`, `cover` or `closer`");
  });

  it("shrinks section 6 — the keyword budget moved to `searchTerms`, and is stated once", () => {
    // The twelve-word budget was §6's hard rule for the whole field; under the
    // split it governs the search query only, so it must appear exactly once
    // and it must be in §22.
    expect(v14).toContain("Hard budget: one subject, one setting");
    expect(v15).not.toContain("Hard budget: one subject, one setting");
    expect(v15.split("twelve-word budget")).toHaveLength(2);
    const section22 = v15.slice(v15.indexOf("## 22."));
    expect(section22).toContain("twelve-word budget");
    // The Swedish-kiosk evidence survives the move: it is the reason the query
    // is short, and it now sits next to the field it governs.
    expect(section22).toContain("Swedish street kiosk");
  });

  /**
   * The language of the two fields no reader ever sees.
   *
   * §22 defines `scene` as "what a generator draws" and `searchTerms` as "the
   * words the stock libraries are actually searched with", while §14 says
   * `language.target` is the language of "every word you write". Read together
   * that sent a Hebrew run's queries to Unsplash and Pexels in Hebrew (near
   * empty results, then the rescue scrape) and prompted the image model in
   * Hebrew. `language-gate.ts` deliberately exempts `visualNeed`, so nothing
   * downstream would have caught it.
   */
  it("says which language the scene brief is written in, with the reason the art-director prompt gives", () => {
    const section22 = v15.slice(v15.indexOf("## 22."));
    expect(section22).toContain("**Write `scene`, `why` and `searchTerms` in English**");
    expect(section22).toContain("whatever language the\npost is in");
    expect(section22).toContain("image models are trained on English captions");
  });

  it("stops the client-brief section from claiming the target language covers the scene brief too", () => {
    const bullet = v15.slice(v15.indexOf("- **`language.target`**"), v15.indexOf("## 16."));
    // v14 said "every word you write", which includes `visualNeed`, and that
    // is the reading that sent Hebrew queries to a keyword index.
    expect(v14).toContain("the language of every word you\n  write");
    expect(v15).not.toContain("the language of every word you\n  write");
    expect(bullet).toContain("every word a reader");
    expect(bullet).toContain("Not `visualNeed` or `sourceRef`");
    expect(bullet).toContain("section 22");
  });

  it("adds no em dash, en dash or double hyphen — this file's own editor's note bans them and the craft-hygiene gate fails copy on that character", () => {
    const banned = /[—–]|--/gu;
    expect((v15.match(banned) ?? []).length).toBe((v14.match(banned) ?? []).length);
  });

  it("keeps the token growth the cost table priced (+0.4k input per attempt)", () => {
    // ~4 characters per token; the cost table's line for item R is +0.4k in.
    expect((v15.length - v14.length) / 4).toBeLessThan(450);
  });
});

describe("instagram-image-vet@4 — judged as evidence for the claim", () => {
  const v3 = read("instagram-image-vet", "3.md");
  const v4 = read("instagram-image-vet", "4.md");

  it("carries its own version in the H1", () => {
    expect(v4.split("\n")[0]).toBe("# Instagram Image Vetting Craft Guide — v4");
  });

  it("is handed the scene and the why, and is told what they are for", () => {
    expect(v4).toContain("`why`");
    expect(v4).toContain("EVIDENCE FOR THE CLAIM");
    expect(v4).toContain("not whether it contains the listed objects");
  });

  it("still accepts a legacy bare `visualNeed`, because in-flight runs still send one", () => {
    expect(v4).toContain("Older runs may hand you\n`visualNeed` as a single line");
  });

  /**
   * Tier 0.5 exists only if the vet knows what it is looking at.
   *
   * `describeLibraryCandidate` replaces the ingest description wholesale, and
   * §2 tells the vet that an unclear licence is `rightsUsable: false` and an
   * undeterminable watermark state is `watermarkFree: false`. A prefix the
   * prompt has never heard of, with no rights basis behind it, is therefore
   * correctly marked unusable, `isUnfillable` drops the slide, and the whole
   * archive tier is dead on arrival.
   */
  it("knows what a `[client library]` candidate is, and that the client owns it", () => {
    expect(v4).toContain("`[client library, filed YYYY-MM-DD]` is the same client, an earlier post");
    expect(v4).toContain('record `license` as "client-owned asset"');
    expect(v4).toContain("`rightsUsable: true`");
    // Ownership is not relevance, here as for a fresh upload.
    expect(v4).toContain("An archived\nframe that does not show this slide's claim is a `null`, not a saving.");
    // v3 knew nothing about the archive, which is exactly the gap.
    expect(v3).not.toContain("client library");
  });

  it("keeps the claimMatch floor v3 established", () => {
    expect(v4).toContain("**A selection needs `claimMatch` of 3 or more.**");
    expect(v4).toContain("An unnamed subject is not a match for a slide that names one.");
    // The rights/licence/watermark and reuse rules are untouched by item R.
    for (const section of ["## 2. Rights, licence, and watermark", "## 3. No viable candidate is a real, valid answer", "## 4. One candidate can serve at most one slide"]) {
      expect(v3).toContain(section);
      expect(v4).toContain(section);
    }
  });
});

describe("instagram-art-director@1 — every line names its basis", () => {
  const v1 = read("instagram-art-director", "1.md");

  it("is byte-identical to its own latest.md", () => {
    expect(readFileSync(path.join(PROMPTS, "instagram-art-director", "1.md"))).toEqual(readFileSync(path.join(PROMPTS, "instagram-art-director", "latest.md")));
  });

  it("carries its own version in the H1", () => {
    expect(v1.split("\n")[0]).toBe("# Instagram Art Direction Guide — v1");
  });

  it("names every field of ArtDirectorOutputSchema and nothing code owns", () => {
    for (const field of ["`subject`", "`light`", "`palette`", "`treatment`", "`forbid`", "`lines`", "`styleLock`", "`gaps`"]) expect(v1).toContain(field);
    expect(v1).toContain("you do not write those");
  });

  it("makes the basis a hard rule and a missing basis a gap rather than an assertion", () => {
    expect(v1).toContain("**A line you cannot give a basis for is not a line. It is a `gap`.**");
    expect(v1).toContain("`confidence`");
    expect(v1).toMatch(/`high`, `medium` or `low`/u);
  });

  it("asks for the forbid list and exactly one style lock, and says why the lock cannot name a subject", () => {
    expect(v1).toContain("## 4. `forbid`: what must never appear");
    expect(v1).toContain("## 5. The style lock");
    expect(v1).toContain("It must not name a subject");
  });

  it("is written for an image model in English, not for a reader in the client's language", () => {
    expect(v1).toContain("Write in English, whatever language the client publishes in.");
  });

  it("names the hardcoded sentence it exists to replace", () => {
    expect(v1).toContain("Style: realistic\nphotography, natural lighting, clean composition");
  });
});
