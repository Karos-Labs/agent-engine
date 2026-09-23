import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { normaliseVisualNeed, retrievalQueryFor, vetSubjectFor } from "../src/workflow/scene-brief.js";
import { ImageSelectionSchema, MIN_CLAIM_MATCH, MIN_SUBJECT_MATCH, selectionPasses, type ImageSelection } from "../src/workflow/types.js";

/**
 * # THE 2026-09-16 REGRESSION TEST
 *
 * karoslabs, prep run `pubsub-21868183257380937`. The whole pool, the whole
 * brief and the whole verdict below are VERBATIM from the run record.
 *
 * What happened: retrieval returned six candidates for the cover. FIVE of them
 * are photographs of real server infrastructure — the vet says so itself. It returned
 * `imagePath: null` at `claimMatch 1`, the slide lost its picture, `07a`
 * re-laid the cover out without one, and the post the owner then looked at had
 * **no photographs in it at all**.
 *
 * The vet's own words for why, verbatim:
 *
 * > "The other candidates are server infrastructure, but none feature the
 * > 'long exposure' effect that the `why` section states is necessary to
 * > signal 'precision and permanence' for the claim."
 *
 * It was doing exactly what @5 told it to. `scene` was one string, every
 * clause in it was a candidate for CENTRAL, and `why` nominated the grade. So
 * this file asserts three separate things, in the order the fix happens:
 * the QUERY stops carrying the grade, the PAYLOAD stops presenting it as
 * central, and the FLOOR stops being a single number that cannot tell a
 * subject miss from a treatment miss.
 */

/** `05-write-copy-attempt-2`, slide 1. */
const COVER_SCENE =
  "A server infrastructure corridor photographed with long exposure, near-black tones, warm shadows, sharp geometric lines receding into darkness, no people, no legible text in frame";
const COVER_WHY =
  "The cover asserts a structural market shift; long-exposure infrastructure signals precision and permanence without generic AI iconography the brand guidelines forbid";
const COVER_SEARCH_TERMS = ["server corridor", "data center", "long exposure", "dark infrastructure"];

/** `05c-inspect-candidates-attempt-3`, verbatim — descriptions, providers and licence confidences as recorded. */
const POOL = [
  {
    path: ".media-cache/pubsub-21868183257380937/n1-c6f10d53d80a.jpg",
    provider: "unsplash",
    licenseConfidence: "blanket",
    showsServerRacks: true,
    description:
      "slide 1 candidate — cable network (photo by Taylor Vick on Unsplash) [licence: Unsplash License — free for commercial use, no attribution required] [vision: Two server racks with mesh doors are visible, filled with numerous network cables and blinking lights. The overall environment is dark.; subjects: server racks, mesh doors, network cables, lights]",
  },
  {
    path: ".media-cache/pubsub-21868183257380937/n1-5f6dc5326c6b.jpg",
    provider: "pexels",
    licenseConfidence: "blanket",
    showsServerRacks: true,
    description:
      "slide 1 candidate — Close-up of server racks in a data center highlighting modern technology infrastructure. (photo by panumas nikhomkhai on Pexels) [licence: Pexels License — free for commercial use, no attribution required] [vision: A close-up shot focuses on a server blade being inserted into a rack. Green indicator lights are visible on other server components in the background.; subjects: server blade, server rack, lights]",
  },
  {
    path: ".media-cache/pubsub-21868183257380937/n1-642dcf218bfe.jpg",
    provider: "pixabay",
    licenseConfidence: "blanket",
    showsServerRacks: false,
    description:
      "slide 1 candidate — tunnel, underpass, light, long exposure, passage, dark, architecture, road, concrete, building, lighting (photo by domitian on Pixabay) [licence: Pixabay Content License — free for commercial use, no attribution required] [vision: A long exposure shot inside a dark concrete underpass or tunnel, showing red light trails from moving vehicles on the road. Overhead lights illuminate the structure, and some graffiti is visible on the walls.; subjects: underpass, concrete, road, red light trails, overhead lights, graffiti]",
  },
  {
    path: ".media-cache/pubsub-21868183257380937/n1-7a60e4c2e3b1.jpg",
    provider: "openverse",
    licenseConfidence: "attributable",
    showsServerRacks: true,
    description:
      'slide 1 candidate — Server Closet SSL 2 (by THE Holy Hand Grenade! via flickr on Openverse) [licence: CC BY-ND 2.0 — commercial use permitted, credit "THE Holy Hand Grenade!"] [vision: Three tall, busy server racks are shown in a utility room, filled with electronic equipment and a tangle of cables. Orange pipes and blue conduits run along the ceiling.; subjects: server racks, servers, network equipment, cables, monitors, pipes; text in image: NETGEAR / APC / HP]',
  },
  {
    path: ".media-cache/pubsub-21868183257380937/n1-2f0e1928905a.jpg",
    provider: "unsplash",
    licenseConfidence: "blanket",
    showsServerRacks: true,
    description:
      "slide 1 candidate — Electric Control Cabinet Production Factory (photo by İsmail Enes Ayhan on Unsplash) [licence: Unsplash License — free for commercial use, no attribution required] [vision: A long, wide aisle separates rows of empty or partially filled server rack frames within a large industrial building.; subjects: server rack frames, aisle, industrial building, structural beams, light fixtures]",
  },
  {
    path: ".media-cache/pubsub-21868183257380937/n1-83b33fc30a60.jpg",
    provider: "pexels",
    licenseConfidence: "blanket",
    showsServerRacks: true,
    description:
      "slide 1 candidate — From above contemporary server cable trays without wires located in modern data center (photo by Brett Sayles on Pexels) [licence: Pexels License — free for commercial use, no attribution required] [vision: A close-up shot looks down onto rows of server blades, each with multiple illuminated green indicator lights.; subjects: server blades, indicator lights, server components]",
  },
] as const;

/** `06-vet-images-attempt-3`, the whole `finalOutput.selections[0]`, verbatim. */
const V5_VERDICT: ImageSelection = {
  n: 1,
  imagePath: null,
  reason:
    "None of the candidates fully meet the central requirements. The `scene` requires a 'server infrastructure corridor' with 'long exposure' to signal 'precision and permanence' as stated in the `why`. Candidate `n1-642dcf218bfe.jpg` has long exposure but is a road tunnel, not server infrastructure, and contains undesired elements like light trails and graffiti. Other candidates show server infrastructure but lack the crucial 'long exposure' effect and the 'corridor' perspective, which are central to conveying the intended message.",
  license: "n/a — no candidate qualified",
  rightsUsable: false,
  watermarkFree: false,
  claimMatch: 1,
  claimMatchReason:
    "Candidate `n1-642dcf218bfe.jpg` (a long exposure road tunnel) was the only one with the central 'long exposure' effect, but its subject ('road tunnel' with 'red light trails' and 'graffiti') is not 'server infrastructure'. The other candidates are server infrastructure, but none feature the 'long exposure' effect that the `why` section states is necessary.",
};

describe("the pool the vet was given really did hold the subject", () => {
  it("five of the six candidates are photographs of server infrastructure, and the run shipped none of them", () => {
    expect(POOL.filter((c) => c.showsServerRacks)).toHaveLength(5);
    expect(V5_VERDICT.imagePath).toBeNull();
    expect(V5_VERDICT.claimMatchReason).toContain("The other candidates are server infrastructure");
    expect(V5_VERDICT.claimMatchReason).toContain("long exposure");
    // And the sentence that told it to: the `why` nominated the grade as the
    // load-bearing clause, and the vet cites `why` by name in its refusal.
    expect(COVER_WHY).toContain("signals precision and permanence");
    expect(V5_VERDICT.claimMatchReason).toContain("`why` section states is necessary");
  });
});

describe("step 1 — the grade stops reaching the query", () => {
  it("the term that returned the road tunnel is dropped, and the subject leads", () => {
    const tunnel = POOL[2]!;
    // The tunnel's own caption is the proof: it shares exactly one term with
    // the brief, and that term is a treatment.
    expect(tunnel.description).toContain("long exposure");
    expect(tunnel.description).not.toContain("server");

    const at21 = normaliseVisualNeed({
      visualNeed: {
        subject: { noun: "server racks in a data centre", mustShow: ["server racks"] },
        scene: COVER_SCENE,
        why: "the cover claims a structural market shift in where buyers form opinions",
        source: "stock",
        searchTerms: COVER_SEARCH_TERMS,
      },
    });
    const query = retrievalQueryFor(at21);
    expect(query.startsWith("server racks in a data centre")).toBe(true);
    expect(query).not.toContain("long exposure");
  });
});

describe("step 2 — the payload stops presenting the grade as central", () => {
  it("@6 gets `subject` and `mustShow` as the central clauses and `scene` as decoration", () => {
    const payload = vetSubjectFor(
      normaliseVisualNeed({
        visualNeed: { subject: { noun: "server racks in a data centre", mustShow: ["server racks"] }, scene: COVER_SCENE, why: "the cover claims a structural market shift", source: "stock" },
      }),
    );
    expect(payload.subject).toBe("server racks in a data centre");
    expect(payload.mustShow).toEqual(["server racks"]);
    // The long exposure is still THERE — the writer asked for it and the
    // generator should still hear it — it is simply no longer central.
    expect(payload.scene).toContain("long exposure");
    expect(payload.why).not.toContain("signals");
  });

  /**
   * The rubric change is the half a threshold cannot do, so it is asserted
   * against the prompt text itself. If someone rewrites `@6` and loses this
   * sentence, the floor below still passes and the run regresses silently.
   */
  it("the prompt carries the sentence that does the work", () => {
    const prompt = readFileSync(fileURLToPath(new URL("../prompts/instagram-image-vet/latest.md", import.meta.url)), "utf8");
    expect(prompt).toContain("v7");
    expect(prompt).toContain("`scene` is DECORATIVE");
    expect(prompt).toContain("a picture may never be refused for");
    expect(prompt.replace(/\s+/gu, " ")).toContain("a picture may never be refused for lacking a treatment named in `scene`.");
    expect(prompt).toContain("subjectMatch");
    expect(prompt).toContain("Never cite technique in");
    // And the two prompt files are the same file. READ OFF THE AGENT'S OWN
    // PIN rather than a literal, which is what the previous version of this
    // comment promised and did not do: it said "pinned to the version the
    // agent reads, not to a frozen number", and then wrote the number. So the
    // next bump broke it, exactly the way a hard-coded 6 was said to be able
    // to. The assertion is that `latest.md` has not drifted from whatever
    // version the agent actually resolves.
    const pinnedVersion = (
      new InstagramImageVettingAgent({ router: {} as never, tools: {} }) as unknown as {
        config: { skillRef: string };
      }
    ).config.skillRef.split("@")[1];
    expect(pinnedVersion, "the agent must pin an explicit version").toBeTruthy();
    const pinnedFile = readFileSync(
      fileURLToPath(new URL(`../prompts/instagram-image-vet/${pinnedVersion}.md`, import.meta.url)),
      "utf8",
    );
    expect(pinnedFile).toBe(prompt);
  });

  it("the agent is pinned to the latest vetting guide, on the tier the harder question is worth", () => {
    const config = (new InstagramImageVettingAgent({ router: {} as never, tools: {} }) as unknown as { config: { skillRef: string; modelPolicy?: { model?: string } } }).config;
    expect(config.skillRef).toBe("instagram-image-vet@9");
    expect(config.modelPolicy?.model).toBe("gemini-3.1-pro-preview");
  });
});

describe("step 3 — the floor stops being one number", () => {
  const base = { rightsUsable: true, watermarkFree: true };

  it("THE REGRESSION: the same pool that failed the old floor now passes on the subject axis", () => {
    // What @5 returned. Under the pre-5.5 floor this is unfillable, and the
    // cover lost its photograph.
    expect(V5_VERDICT.claimMatch).toBeLessThan(MIN_CLAIM_MATCH);
    expect(selectionPasses(V5_VERDICT).passes).toBe(false);

    // What a vet reading the @6 payload returns for the SAME file: the subject
    // is unmistakably there, and the claim is the honest generic 3 — because
    // "a structural market shift" is not a thing a photograph can be evidence
    // for, which is exactly why `claimMatch` alone could never rescue this.
    const at6 = {
      ...base,
      claimMatch: 3,
      subjectMatch: 5,
      subjectMatchReason: "two server racks with mesh doors, filled with network cables and blinking lights — the briefed subject, and the one mustShow clause",
    };
    const verdict = selectionPasses(at6);
    expect(verdict.passes).toBe(true);
    expect(verdict.basis).toBe("subject");
    expect(verdict.reason).toContain("subjectMatch 5/5");
  });

  it("refuses the generic pairing that shipped every picture of 2026-09-16", () => {
    // Compatible on both axes and of nothing in particular: the stock desk,
    // the anonymous lobby, the yellow gantry.
    const generic = selectionPasses({ ...base, claimMatch: 3, subjectMatch: 3 });
    expect(generic.passes).toBe(false);
    expect(generic.reason).toContain("compatible with the slide rather than of its subject");
  });

  it("keeps the one honest step of abstraction — a company's office under a headline about the company", () => {
    expect(selectionPasses({ ...base, claimMatch: 4, subjectMatch: 3 }).passes).toBe(true);
    expect(MIN_SUBJECT_MATCH).toBe(4);
  });

  it("rights and watermark still refuse before anything else is looked at", () => {
    expect(selectionPasses({ ...base, rightsUsable: false, claimMatch: 5, subjectMatch: 5 }).passes).toBe(false);
    expect(selectionPasses({ ...base, watermarkFree: false, claimMatch: 5, subjectMatch: 5 }).passes).toBe(false);
  });

  /**
   * The fallback is a file-ownership consequence, not a design preference —
   * several `ImageSelection`s are constructed in the workflow and a required
   * field would break them. What must never happen is the old floor coming
   * back SILENTLY, so the basis is reported.
   */
  it("falls back to the claim floor when a vet returns no subjectMatch, and says that it did", () => {
    const fallback = selectionPasses({ ...base, claimMatch: 3 });
    expect(fallback.passes).toBe(true);
    expect(fallback.basis).toBe("claim-fallback");
    expect(fallback.reason).toContain("no subjectMatch");
    expect(selectionPasses({ ...base, claimMatch: 2 }).basis).toBe("claim-fallback");
  });

  it("every new field is optional on the wire, so an @5-shaped verdict and a resumed checkpoint both still parse", () => {
    expect(ImageSelectionSchema.safeParse(V5_VERDICT).success).toBe(true);
    const at6 = ImageSelectionSchema.safeParse({
      ...V5_VERDICT,
      imagePath: POOL[0]!.path,
      license: "Unsplash License",
      rightsUsable: true,
      watermarkFree: true,
      claimMatch: 3,
      subjectMatch: 5,
      subjectMatchReason: "server racks in a data centre",
      licenceClass: "blanket",
      stockCliche: "abstract-network",
    });
    expect(at6.success, JSON.stringify(at6.error?.issues ?? [])).toBe(true);
    // `stockCliche` is collected and gates nothing this phase.
    expect(selectionPasses(at6.data!).passes).toBe(true);
  });
});
