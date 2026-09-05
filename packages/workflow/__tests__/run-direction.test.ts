import { describe, expect, it } from "vitest";
import { readRunDirection, runDirectionField } from "../src/index.js";

/**
 * `readRunDirection` — one answer, for every agent, to two questions:
 * does a typed instruction outrank the topic catalog, and does the drafting
 * model get to see it?
 */

describe("readRunDirection", () => {
  it("returns nothing to honour when no instruction was typed", () => {
    const d = readRunDirection({});
    expect(d.direction).toBeUndefined();
    expect(d.topicOverride).toBeUndefined();
    expect(d.mediaAssets).toEqual([]);
    // Omitted, not present-and-undefined: an explicit `runDirection: undefined`
    // invites a model to remark on its absence instead of working without one.
    expect(runDirectionField(d)).toEqual({});
  });

  it("treats a subject as both direction and a topic override", () => {
    const d = readRunDirection({ customPrompt: "Focus on the product launch" });
    expect(d.direction).toBe("Focus on the product launch");
    expect(d.topicOverride).toBe("Focus on the product launch");
    expect(runDirectionField(d)).toEqual({ runDirection: "Focus on the product launch" });
  });

  const styleOnly = [
    "Keep it shorter than usual",
    "Avoid the word synergy",
    "no emoji please",
    "Make it more casual",
    "don't mention pricing",
  ];

  for (const instruction of styleOnly) {
    it(`treats "${instruction}" as direction only, never as a topic`, () => {
      // The asymmetry that justifies the conservatism: a style note misread as
      // a topic gets reserved in the catalog and drafted against, producing a
      // post about the instruction itself.
      const d = readRunDirection({ customPrompt: instruction });
      expect(d.direction).toBe(instruction);
      expect(d.topicOverride).toBeUndefined();
    });
  }

  it("treats a whole paragraph as a brief, not a topic line", () => {
    const paragraph = "x".repeat(200);
    const d = readRunDirection({ customPrompt: paragraph });
    expect(d.direction).toBe(paragraph);
    expect(d.topicOverride).toBeUndefined();
  });

  it("normalises whitespace-only direction away rather than honouring an empty string", () => {
    // An empty instruction must read as "use the client's strategy", never as
    // "the client has no direction".
    const d = readRunDirection({ customPrompt: "   " });
    expect(d.direction).toBeUndefined();
  });

  it("carries attached media through, and drops a malformed asset without failing", () => {
    const d = readRunDirection({
      mediaAssets: [
        { uri: "gs://bucket/a.jpg", role: "source", label: "hero" },
        { role: "source" },
        "not an object",
      ],
    });
    // An asset with no uri is not an asset; a bad optional field must not fail
    // a run that would otherwise have worked.
    expect(d.mediaAssets).toHaveLength(1);
    expect(d.mediaAssets[0]).toMatchObject({ uri: "gs://bucket/a.jpg", label: "hero" });
  });

  it("reads direction and media from the same input together", () => {
    const d = readRunDirection({
      customPrompt: "Focus on the product launch",
      mediaAssets: [{ uri: "gs://bucket/1.jpg" }, { uri: "gs://bucket/2.jpg" }],
    });
    expect(d.topicOverride).toBe("Focus on the product launch");
    expect(d.mediaAssets).toHaveLength(2);
  });
});

describe("readRunDirection — the structured brief the portal sends alongside the instruction", () => {
  // Until 2026-09 the portal's run dialogs collected audience, tone, cta,
  // must-include, keywords and X's scope on every engine-routed agent, sent
  // them on the wire, and NO workflow read any of them. They now ride into
  // `direction`, which every drafting agent already hands to its model step.

  it("an explicit requestedTopic is the topic, whatever it looks like", () => {
    const d = readRunDirection({ requestedTopic: "Keep it shorter: why AI pilots fail in media" });
    // A style-hint word inside an explicit topic field is still a topic — the
    // heuristic exists for free text, not for a field that says what it is.
    expect(d.topicOverride).toBe("Keep it shorter: why AI pilots fail in media");
    expect(d.direction).toBe("Requested topic: Keep it shorter: why AI pilots fail in media");
  });

  it("requestedTopic outranks a typed instruction for the topic, and both reach the model", () => {
    const d = readRunDirection({ requestedTopic: "Enterprise AI contract terms", customPrompt: "Focus on the product launch" });
    expect(d.topicOverride).toBe("Enterprise AI contract terms");
    expect(d.direction).toBe("Focus on the product launch\n\nRequested topic: Enterprise AI contract terms");
  });

  it("folds the brief fields into direction as labelled lines, in a fixed order", () => {
    const d = readRunDirection({
      customPrompt: "Focus on the product launch",
      audience: "CFOs at mid-market fintechs",
      tone: "dry, specific",
      cta: "Book a demo",
      mustInclude: ["the Q3 pricing change", "a link to the docs"],
      keywords: ["AI compliance", "audit trail"],
      runScope: "the company page",
    });
    expect(d.brief).toEqual({
      audience: "CFOs at mid-market fintechs",
      tone: "dry, specific",
      cta: "Book a demo",
      mustInclude: ["the Q3 pricing change", "a link to the docs"],
      keywords: ["AI compliance", "audit trail"],
      runScope: "the company page",
    });
    expect(d.direction).toBe(
      [
        "Focus on the product launch",
        "",
        "Audience: CFOs at mid-market fintechs",
        "Tone: dry, specific",
        "Call to action: Book a demo",
        // "Scope of this run", not "Scope": `runScope` (X's company-page /
        // seat selector) and `scope` (seo-geo's audit scope) are two different
        // questions on two different forms, and one label for both would read
        // as a contradiction on a run that carries them together.
        "Scope of this run: the company page",
        "Must include: the Q3 pricing change; a link to the docs",
        "Keywords to work in: AI compliance, audit trail",
      ].join("\n"),
    );
    // Appending the brief must never demote the typed topic: the question was
    // asked of the bare instruction.
    expect(d.topicOverride).toBe("Focus on the product launch");
    expect(runDirectionField(d).runDirection).toBe(d.direction);
  });

  it("a brief with no instruction is still a direction the model sees", () => {
    const d = readRunDirection({ audience: "founders applying to accelerators" });
    expect(d.direction).toBe("Audience: founders applying to accelerators");
    expect(d.topicOverride).toBeUndefined();
  });

  it("ignores malformed brief values rather than failing the run", () => {
    const d = readRunDirection({ audience: 42, mustInclude: "not a list", keywords: ["", "  ", "real"], tone: "   " });
    expect(d.brief).toEqual({ mustInclude: [], keywords: ["real"] });
    expect(d.direction).toBe("Keywords to work in: real");
  });

  it("an empty brief adds nothing — the plain-instruction contract above is unchanged", () => {
    const d = readRunDirection({ customPrompt: "Focus on the product launch", mustInclude: [], keywords: [] });
    expect(d.direction).toBe("Focus on the product launch");
    expect(d.brief).toEqual({ mustInclude: [], keywords: [] });
  });
});

/**
 * THE PORTAL'S SIDE OF THE CONTRACT.
 *
 * `toEngineRunInput` (karosCMO) emits a fixed set of wire keys. Four agents
 * read a handful of them off `wf.input` themselves; every other agent's ONLY
 * channel for anything a client typed is this module. So a key the portal
 * sends that this module neither parses nor labels is a question asked of a
 * client and dropped — which is exactly what had happened to seo-geo's
 * website/scope/market/competitors (four of its six fields), landing's
 * offer/proof, branded-shorts' platform/duration and the run-mode selectors.
 *
 * The list below is the portal's emitted keys, copied deliberately rather than
 * imported: the two repos deploy separately, and a cross-repo import would
 * make this suite unrunnable rather than red when they drift.
 */
const PORTAL_WIRE_KEYS = [
  "audience",
  "competitors",
  "cta",
  "duration",
  "keywords",
  "market",
  "mustInclude",
  "offer",
  "platform",
  "proof",
  "runMode",
  "runScope",
  "scope",
  "tone",
  "website",
] as const;

/** Handled outside the brief, each by a named mechanism rather than by omission. */
const HANDLED_ELSEWHERE: Record<string, string> = {
  customPrompt: "the typed instruction itself — becomes `direction`",
  mediaAssets: "parsed by readRichRunInput into `mediaAssets`",
  requestedTopic: "becomes `topicOverride`, and is rendered by renderRunBrief's own parameter",
  requestedIdentityScope: "read off wf.input by linkedin-agent (RUN_SCOPED_KEYS)",
  requestedExecutiveName: "read off wf.input by linkedin-agent (RUN_SCOPED_KEYS)",
  requestedLane: "read off wf.input by x-agent and instagram-agent",
  requestedArchetype: "read off wf.input by linkedin-agent",
  requestedSubreddit: "read off wf.input by reddit-agent",
  requestedThreadUrl: "read off wf.input by reddit-agent",
  requestedThreadTitle: "read off wf.input by reddit-agent",
  targetDate: "scheduling metadata — the portal schedules the asset, no agent drafts against a date",
};

describe("every field the portal collects reaches the model", () => {
  it("parses and labels each wire key, so none is silently dropped", () => {
    // One probe carrying every key at once, then assert each one's answer is
    // findable in the prose a drafting step receives. Asserting on the RENDERED
    // direction rather than on the parsed object is the point: parsing a field
    // into a struct nobody renders would satisfy a weaker test and still lose
    // the client's answer.
    const probe = Object.fromEntries(
      PORTAL_WIRE_KEYS.map((key) =>
        key === "mustInclude" || key === "keywords" ? [key, [`probe-${key}`]] : [key, `probe-${key}`],
      ),
    );
    const direction = readRunDirection(probe).direction ?? "";
    const missing = PORTAL_WIRE_KEYS.filter((key) => !direction.includes(`probe-${key}`));
    expect(missing, "wire keys the portal sends that no model ever sees").toEqual([]);
  });

  it("names a mechanism for every key it deliberately does not put in the brief", () => {
    // The escape hatch, kept explicit: a key belongs here WITH A REASON or in
    // the brief. Neither is not an option, and this is what fails when someone
    // adds a wire key and wires up neither.
    for (const [key, reason] of Object.entries(HANDLED_ELSEWHERE)) {
      expect(reason.length, `${key} is exempted with no reason given`).toBeGreaterThan(20);
      expect(PORTAL_WIRE_KEYS as readonly string[], `${key} is both in the brief and exempted`).not.toContain(key);
    }
  });
});
