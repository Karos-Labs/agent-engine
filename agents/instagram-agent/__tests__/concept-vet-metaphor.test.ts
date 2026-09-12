import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentContext, CompletionResult, ModelRouter, PromptStore } from "@agent-engine/core";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { MIN_CLAIM_MATCH, type ImageVettingOutput } from "../src/workflow/types.js";
import { PROMPTS_ROOT } from "./test-helpers.js";

/**
 * RFC-16 §6.1 and §6.5 — the image vet and a DECLARED metaphor.
 *
 * The sharpest risk in the concept mode: before `instagram-image-vet@5`, a
 * good metaphor was MECHANICALLY REJECTED (the unnamed-subject belt at
 * `4.md:110-118` scores a slide 2 when it names a company and the picture
 * names none — which is true of every concept image by construction) and a
 * wrong metaphor was MECHANICALLY ACCEPTED (a generated candidate's
 * `description` restates the prompt it was generated from, so it always
 * "shows" whatever the brief asked for). §1c fixes both, and only for a slide
 * the pipeline explicitly declared `conceptual`.
 *
 * ## How this is tested without a model
 *
 * `judgeUnderRubric` is a deterministic READER of the rubric, wired into the
 * real `InstagramImageVettingAgent` as its router. It is not a model and does
 * not pretend to be one: it is the rubric's branch structure written out, and
 * **every rule it applies is gated on the clause that authorises it being
 * present in the prompt text the agent actually sent** (`opts.system`, which
 * is `loadSystemPrompt`'s resolved `instagram-image-vet@5` body). Serve a
 * prompt with one clause deleted and that rule stops existing, which is what
 * each `mutation` case below does — the standing rule here is that a test you
 * have not watched fail is not a test, and the failure each case watches for
 * is the clause going missing from the shipped prompt.
 *
 * What it therefore proves: that §1c's clauses are present, that they are
 * reachable ONLY through the pipeline's declaration, and that each one is
 * load-bearing — a different fixture outcome follows from deleting it. What
 * it cannot prove: that Gemini Flash reads them the way this reader does.
 * That is what a prep run measures, and `MIN_CLAIM_MATCH` is unchanged at 3
 * so the deterministic floor still catches a vet that scores generously.
 */

const ctx: AgentContext = { runId: "ig_concept_vet", clientSlug: "meridian", productId: "instagram-agent", runKind: "recurring", metadata: {} };

// ─────────────────────────────────────────────────────────────────────────────
// The rubric reader
// ─────────────────────────────────────────────────────────────────────────────

interface ConceptualBlock {
  readonly pattern: string;
  readonly anchor: string;
  readonly decodesTo: string;
  readonly restsOn: string;
}

interface VetSlide {
  readonly n: number;
  readonly headline: string;
  readonly body: string;
  readonly scene: string;
  readonly why: string;
  /** What a reader recognises the slide as being ABOUT. The belt at `4.md:110-118` turns on this. */
  readonly namedSubjects: readonly string[];
  readonly conceptual?: ConceptualBlock;
}

interface VetCandidate {
  readonly path: string;
  readonly description: string;
}

const STOPWORDS = new Set(["the", "and", "with", "that", "this", "from", "into", "over", "under", "one", "two", "its", "for", "onto", "than", "then", "them", "they", "what", "when", "while", "still", "other", "another", "there", "here", "some", "none", "about"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}

/** Prefix-tolerant, so "scorched" in the anchor matches "scorch marks" in a vision note — the rubric asks whether the thing is in frame, not whether the words match. */
function overlap(wanted: readonly string[], evidence: string): number {
  const seen = tokens(evidence);
  return wanted.filter((want) => seen.some((word) => word.startsWith(want.slice(0, 5)) || want.startsWith(word.slice(0, 5)))).length;
}

/** The `[vision: …]` note: what a model that actually LOOKED at the file reported. */
function visionNote(description: string): string {
  return /\[vision:\s*([^\]]*)\]/u.exec(description)?.[1] ?? "";
}

/** Everything the description asserts WITHOUT having looked — for a generated candidate, a restatement of its own prompt. */
function assertedText(description: string): string {
  return description.replace(/\[vision:[^\]]*\]/gu, " ");
}

interface Verdict {
  readonly claimMatch: number;
  readonly claimMatchReason: string;
}

function judgeUnderRubric(rubricRaw: string, slide: VetSlide, candidate: VetCandidate): Verdict {
  const rubric = rubricRaw.replace(/\r\n/gu, "\n");
  const has = {
    // §1c exists, and it is reachable only when the PIPELINE declared the slide conceptual.
    conceptualSection: rubric.includes("## 1c. A DECLARED metaphor"),
    declaredOnly: rubric.includes("Read this section only when `conceptual` is present on the slide you"),
    couldIllustrateAnyStory: rubric.includes("A picture that could illustrate any story is a 2 on a conceptual slide,"),
    assertionIsNotEvidence: rubric.includes("An assertion in the description is not evidence; the vision note is."),
    beltSuspendedOnConceptual: rubric.includes("The unnamed-subject rule in section 1b is suspended for a `conceptual`"),
    // §1b's belt, which every non-conceptual slide still reads.
    unnamedSubjectBelt: rubric.includes("An unnamed subject is not a match for a slide that names one."),
  };

  const vision = visionNote(candidate.description);
  const wholeDescription = candidate.description;
  const namesItsSubject = (text: string): boolean => slide.namedSubjects.some((subject) => text.toLowerCase().includes(subject.toLowerCase()));

  const conceptual = slide.conceptual !== undefined && has.conceptualSection && has.declaredOnly ? slide.conceptual : undefined;

  if (conceptual !== undefined) {
    // The belt would kill every concept image there is, because a metaphor
    // names no company ON PURPOSE. §1c suspends it — and only here.
    if (has.unnamedSubjectBelt && !has.beltSuspendedOnConceptual && slide.namedSubjects.length > 0 && !namesItsSubject(wholeDescription)) {
      return { claimMatch: 2, claimMatchReason: `the slide names ${slide.namedSubjects.join(" and ")}; the description names no company at all` };
    }
    // On a conceptual slide the evidence is what was SEEN, not what the
    // description claims about an image it generated from the same brief.
    const evidence = has.assertionIsNotEvidence ? vision : `${assertedText(wholeDescription)} ${vision}`;
    const anchorTokens = tokens(conceptual.anchor);
    if (overlap(anchorTokens, evidence) >= 2) {
      return { claimMatch: 4, claimMatchReason: `the declared anchor (${conceptual.anchor}) is what is in frame; the decode to "${conceptual.decodesTo}" takes a beat` };
    }
    // The tautology, named for what it is: the description says the anchor is
    // there because it was generated from the same brief, and the vision note
    // does not back it up.
    if (has.assertionIsNotEvidence && overlap(anchorTokens, assertedText(wholeDescription)) >= 2) {
      return { claimMatch: 2, claimMatchReason: `the description asserts the declared anchor but the vision note shows "${vision.trim()}" — an assertion is not evidence` };
    }
    if (has.couldIllustrateAnyStory) {
      return { claimMatch: 2, claimMatchReason: `nothing of the declared anchor (${conceptual.anchor}) is in frame; this picture could illustrate any story` };
    }
    return { claimMatch: 3, claimMatchReason: "compatible and generic: nothing in the picture contradicts the claim" };
  }

  // The literal rubric, byte-identical since v4.
  if (has.unnamedSubjectBelt && slide.namedSubjects.length > 0 && !namesItsSubject(wholeDescription)) {
    return { claimMatch: 2, claimMatchReason: `the slide names ${slide.namedSubjects.join(" and ")}; the description names no company at all` };
  }
  return { claimMatch: 3, claimMatchReason: "compatible and generic: nothing in the picture contradicts the claim" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: the real agent, the real prompt file, a router that reads the rubric
// ─────────────────────────────────────────────────────────────────────────────

/** Serves the agent's own pinned prompt off disk, optionally with one clause cut out of it. */
function rubricStore(mutate: (text: string) => string = (t) => t): PromptStore {
  return {
    async getPrompt(promptId: string, version?: string): Promise<string> {
      return mutate(readFileSync(path.join(PROMPTS_ROOT, promptId, `${version ?? "latest"}.md`), "utf8"));
    },
  };
}

/** Deletes one clause from the served rubric, and refuses to be a no-op — a renamed clause must fail loudly, not silently pass the mutation case. */
function withoutClause(marker: string): (text: string) => string {
  return (text) => {
    const normalised = text.replace(/\r\n/gu, "\n");
    const at = normalised.indexOf(marker);
    if (at === -1) throw new Error(`withoutClause: the rubric no longer contains "${marker}" — the mutation case is vacuous, fix the marker`);
    return normalised.slice(0, at) + normalised.slice(at + marker.length);
  };
}

function rubricRouter(seen: { system?: string; slides?: unknown }): ModelRouter {
  return {
    complete: vi.fn(async (prompt: string, _schema: unknown, _policy: unknown, opts: { system?: string }): Promise<CompletionResult<unknown>> => {
      const input = (JSON.parse(prompt) as { input: { slides: VetSlide[]; candidatePool: VetCandidate[] } }).input;
      seen.system = opts.system ?? "";
      seen.slides = input.slides;
      const selections = input.slides.map((slide) => {
        const candidate = input.candidatePool[0]!;
        const verdict = judgeUnderRubric(opts.system ?? "", slide, candidate);
        const selected = verdict.claimMatch >= MIN_CLAIM_MATCH;
        return {
          n: slide.n,
          imagePath: selected ? candidate.path : null,
          reason: selected ? "the candidate does the work the slide needs" : "nothing in the pool qualified",
          license: selected ? "CC0, test fixture" : "n/a — no candidate qualified",
          rightsUsable: selected,
          watermarkFree: selected,
          claimMatch: verdict.claimMatch,
          claimMatchReason: verdict.claimMatchReason,
        };
      });
      return { output: { type: "final", output: { selections } }, modelUsed: "gemini-2.5-flash", inputTokens: { cached: 0, uncached: 100 }, outputTokens: 30 };
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("completeAlias is not used by the vet");
    }),
  } as unknown as ModelRouter;
}

async function vet(slide: VetSlide, candidate: VetCandidate, mutate?: (text: string) => string): Promise<{ selection: ImageVettingOutput["selections"][number]; system: string; slides: unknown }> {
  const seen: { system?: string; slides?: unknown } = {};
  const agent = new InstagramImageVettingAgent({ router: rubricRouter(seen), tools: {}, promptStore: rubricStore(mutate) });
  const exec = await agent.run(ctx, { slides: [slide], candidatePool: [candidate], usedImages: [] });
  expect(exec.status).toBe("completed");
  const output = exec.finalOutput as ImageVettingOutput | null;
  expect(output, "the vet returned no output").not.toBeNull();
  return { selection: output!.selections[0]!, system: seen.system ?? "", slides: seen.slides };
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixtures. One slide, one declared concept, three different pictures.
// ─────────────────────────────────────────────────────────────────────────────

const RIVALRY_SLIDE: VetSlide = {
  n: 1,
  headline: "Meridian Freight and Halberd Logistics both bid for the same overnight contract. Neither won it.",
  body: "The shipper took the route in-house after eleven weeks of undercutting.",
  scene: "two identical high-backed chairs at the head of one long table, one seat scorched",
  why: "the slide claims a contest that ended with nobody in the seat",
  namedSubjects: ["Meridian Freight", "Halberd Logistics"],
  conceptual: {
    pattern: "rivalry",
    anchor: "two identical high-backed chairs at the head of one long table, one seat scorched",
    decodesTo: "Meridian Freight and Halberd Logistics fought over a contract that went to neither of them",
    restsOn: "the overnight route was brought in-house after an eleven-week bidding contest",
  },
};

/** The metaphor, drawn. Chairs, a table, scorch marks — and NO company named, by design. */
const GOOD_METAPHOR: VetCandidate = {
  path: ".media-cache/run/n1-concept.png",
  description: "generated image for slide 1 [vision: two identical high-backed chairs at the head of one long table, the left seat scorched and smoking, embers on an unlit floor, no signage, no lettering, no people]",
};

/** The metaphor, not drawn. A picture that could sit above any story in the category. */
const WRONG_METAPHOR: VetCandidate = {
  path: ".media-cache/run/n1-generic.png",
  description: "generated image for slide 1 [vision: a laptop on a desk, soft daylight through a window, a person out of focus in the background]",
};

/** The assertion, decorated. The description restates the brief it was generated from; the vision note shows something else entirely. */
const DECORATED_ASSERTION: VetCandidate = {
  path: ".media-cache/run/n1-asserted.png",
  description:
    "an image of two identical high-backed chairs at the head of one long table with one seat scorched, dramatising how Meridian Freight and Halberd Logistics lost the contract " +
    "[vision: a single potted plant on a windowsill, soft daylight, no people, no furniture]",
};

describe("instagram-concept@1 — the prompt that authors the metaphor", () => {
  const raw = readFileSync(path.join(PROMPTS_ROOT, "instagram-concept", "1.md"), "utf8");
  const v1 = raw.replace(/\r\n/gu, "\n");

  it("carries its own version in the H1 and is byte-identical to its own latest.md", () => {
    expect(v1.split("\n")[0]).toBe("# Instagram Concept Direction Guide — v1");
    expect(readFileSync(path.join(PROMPTS_ROOT, "instagram-concept", "latest.md"))).toEqual(readFileSync(path.join(PROMPTS_ROOT, "instagram-concept", "1.md")));
  });

  it("names every field of ConceptSchema, and the pattern vocabulary is closed and partly withheld", () => {
    for (const field of ["`pattern`", "`anchor`", "`situation`", "`scene`", "`readsAs`", "`decodesTo`", "`restsOn`", "`paletteRole`", "`productionNote`", "`usesPermittedMarks`", "`typeZone`"]) {
      expect(v1, `the prompt must name ${field}`).toContain(field);
    }
    for (const pattern of ["`rivalry`", "`reversal`", "`scale`", "`before-after`", "`the-outsider`", "`the-crown`", "`the-race`"]) expect(v1).toContain(pattern);
    // The model is handed the ELIGIBLE subset, not the vocabulary — the same
    // discipline `selectAngle` applies to `restsOn`.
    expect(v1).toContain("You are given only the\nsubset whose preconditions this story actually satisfies");
  });

  it("keeps the client's world and the client's colours load-bearing, which is the owner's absolute constraint", () => {
    expect(v1).toContain("It must name a token from `subjectPalette` verbatim.");
    expect(v1).toContain("`restsOn` is a fact-card claim copied character for character");
    // The audit's headline failure, named in the prompt so the rule has a reason.
    expect(v1).toContain("a carousel about real estate was\ngenerated for an AI marketing agency");
    expect(v1).toContain("**the light, fire or atmosphere in this frame takes its\ncolour from the palette above, not from a generic warm orange.**");
  });

  it("ships the safety default conservative: a rival by role, position and object, never by mark or likeness", () => {
    expect(v1).toContain("> Represent a rival, a competitor or a public figure by **role, position and\n> object** — never by mark, face or likeness.");
    expect(v1).toContain("Two identical chairs at the head\n> of one table, not two logos.");
    expect(v1).toContain("No named public figure, no third-party logo, brand mark, packaged product or\nrecognisable real person.");
    // The positive palette, so the default is somewhere to go rather than only a refusal.
    expect(v1).toContain("generic archetypes from the client's own ICP");
    expect(v1).toContain("`usesPermittedMarks` is `[]` unless `permit` names the mark");
  });

  it("hands the style lock the shot and keeps the production note RELATIVE", () => {
    expect(v1).toContain("## 5. You choose what is in the frame. You do not choose how it is shot — the run's style lock does.");
    expect(v1).toContain("**relative, never a style of its own**");
    expect(v1).toContain("push the locked style to its\nmost dramatic end");
    // The one honest limit: a subject-matter line is superseded for this image,
    // a LOOK line is not. This is an instruction, not an enforcement, and the
    // prompt is the only place it can live.
    expect(v1).toContain("SUBJECT-MATTER POLICY");
    expect(v1).toContain("is superseded for\nthis one image");
    expect(v1).toContain("A direction line\ndescribing LOOK");
  });

  it("keeps the type zone as item 4 of the observed recipe, and makes it hold in RTL", () => {
    expect(v1).toContain("4. **Composed around the type zone.**");
    expect(v1).toContain("## 8. `typeZone`: the lower third belongs to the headline");
    expect(v1).toContain("keep the cleared zone a horizontal band, never a corner or one side");
  });
});

describe("instagram-image-vet@5 §1c — a declared metaphor is judged on what was drawn", () => {
  it("a good metaphor is not rejected", async () => {
    const { selection, system, slides } = await vet(RIVALRY_SLIDE, GOOD_METAPHOR);

    // The premise of the whole case: the agent really did send @5, and the
    // declaration really did reach it.
    expect(system.startsWith(readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "5.md"), "utf8"))).toBe(true);
    expect((slides as Array<{ conceptual?: ConceptualBlock }>)[0]!.conceptual?.pattern).toBe("rivalry");

    expect(selection.claimMatch).toBeGreaterThanOrEqual(MIN_CLAIM_MATCH);
    expect(selection.imagePath).toBe(GOOD_METAPHOR.path);
    expect(selection.claimMatchReason).toContain("chairs");
  });

  it("premise: the SAME picture scores 2 as a literal slide — without §1c the good metaphor genuinely dies", async () => {
    // `4.md:110-118`: the slide names two companies, the description names
    // none, so the score is 2 and the slide downgrades to typographic. That is
    // not a bug in the belt — it is why §1c has to exist, and why it is
    // reachable only through the pipeline's own declaration.
    const { conceptual: _dropped, ...literal } = RIVALRY_SLIDE;
    void _dropped;
    const { selection } = await vet(literal, GOOD_METAPHOR);
    expect(selection.claimMatch).toBe(2);
    expect(selection.claimMatch).toBeLessThan(MIN_CLAIM_MATCH);
    expect(selection.imagePath).toBeNull();
    expect(selection.claimMatchReason).toContain("names no company");
  });

  it("premise: deleting §1c's suspension sentence kills the same metaphor even when it IS declared", async () => {
    const { selection } = await vet(RIVALRY_SLIDE, GOOD_METAPHOR, withoutClause("The unnamed-subject rule in section 1b is suspended for a `conceptual`"));
    expect(selection.claimMatch).toBe(2);
    expect(selection.imagePath).toBeNull();
  });

  it("a wrong metaphor is not waved through", async () => {
    const { selection } = await vet(RIVALRY_SLIDE, WRONG_METAPHOR);
    expect(selection.claimMatch).toBeLessThanOrEqual(2);
    expect(selection.imagePath).toBeNull();
    expect(selection.claimMatchReason).toContain("could illustrate any story");
  });

  it("mutation: delete the could-illustrate-any-story clause and the wrong metaphor becomes a 3 and ships", async () => {
    // §1b's 3 is "compatible and generic: nothing contradicts the claim", and
    // on a literal slide a desk and a laptop honestly earn it. §1c's clause is
    // the only thing standing between that honest 3 and a concept image that
    // says nothing shipping as the cover.
    const { selection } = await vet(RIVALRY_SLIDE, WRONG_METAPHOR, withoutClause("A picture that could illustrate any story is a 2 on a conceptual slide,"));
    expect(selection.claimMatch).toBe(3);
    expect(selection.imagePath).toBe(WRONG_METAPHOR.path);
  });

  it("a decorated assertion is not waved through", async () => {
    const { selection } = await vet(RIVALRY_SLIDE, DECORATED_ASSERTION);
    expect(selection.claimMatch).toBeLessThanOrEqual(2);
    expect(selection.imagePath).toBeNull();
    // And it fails for the RIGHT reason: not "the anchor is missing" but "you
    // are quoting yourself". That distinction is what §6.3's vision
    // inspection buys, and a verdict that blurred it would let the tautology
    // back in wearing the other failure's name.
    expect(selection.claimMatchReason).toContain("an assertion is not evidence");
  });

  it("mutation: delete the assertion-is-not-evidence clause and the decorated assertion scores on its own words", async () => {
    // This is the `describeGenerated` tautology (§6.3) in one fixture: the
    // candidate description restates the brief, so without the clause the vet
    // scores the image against a description of itself and finds it perfect.
    const { selection } = await vet(RIVALRY_SLIDE, DECORATED_ASSERTION, withoutClause("An assertion in the description is not evidence; the vision note is."));
    expect(selection.claimMatch).toBeGreaterThanOrEqual(MIN_CLAIM_MATCH);
    expect(selection.imagePath).toBe(DECORATED_ASSERTION.path);
  });

  it("the three fixtures disagree — a fixture set that scores the same everywhere is measuring nothing", async () => {
    const good = (await vet(RIVALRY_SLIDE, GOOD_METAPHOR)).selection;
    const wrong = (await vet(RIVALRY_SLIDE, WRONG_METAPHOR)).selection;
    const decorated = (await vet(RIVALRY_SLIDE, DECORATED_ASSERTION)).selection;

    expect(good.claimMatch).toBeGreaterThan(wrong.claimMatch);
    expect(good.claimMatch).toBeGreaterThan(decorated.claimMatch);
    // The two failures fail for DIFFERENT reasons — one drew the wrong thing,
    // one claimed to have drawn the right thing — and a rubric that collapsed
    // them into one verdict would hide the tautology.
    expect(wrong.claimMatchReason).not.toBe(decorated.claimMatchReason);
    expect(new Set([GOOD_METAPHOR, WRONG_METAPHOR, DECORATED_ASSERTION].map((c) => visionNote(c.description))).size).toBe(3);
    // And no threshold moved to make any of this true.
    expect(MIN_CLAIM_MATCH).toBe(3);
  });
});
