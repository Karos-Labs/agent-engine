import { describe, expect, it } from "vitest";
import { CONTENT_MODES, MAX_RECORDED_SUBJECT_CHARS, MAX_STANDING_FEEDBACK_CHARS, MODE_CUES, modeFromDirection, readRunDirection, recordedSubject, runDirectionField, selectContentMode, topicLineFromNote } from "../src/index.js";

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
  mediaSource: "parsed by readRichRunInput into `mediaSource` — a mode switch every media agent reads structurally (client-only media), not prose for a model",
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

describe("readRunDirection — where this run's visuals may come from (mediaSource, 2026-09-06)", () => {
  it("defaults to system-managed media, so every run that predates the field behaves exactly as before", () => {
    expect(readRunDirection({}).mediaSource).toBe("system");
    expect(readRunDirection({ mediaAssets: [{ uri: "gs://b/a.png" }] }).mediaSource).toBe("system");
  });

  it("carries the client's choice through alongside the assets it governs", () => {
    const d = readRunDirection({ mediaSource: "client", mediaAssets: [{ uri: "gs://b/a.png", role: "source" }] });
    expect(d.mediaSource).toBe("client");
    expect(d.mediaAssets).toHaveLength(1);
  });

  it("reads anything but the one non-default word as the default — never a third mode, never a failed run", () => {
    expect(readRunDirection({ mediaSource: "CLIENT" }).mediaSource).toBe("system");
    expect(readRunDirection({ mediaSource: "generate" }).mediaSource).toBe("system");
    expect(readRunDirection({ mediaSource: 7 }).mediaSource).toBe("system");
  });
});

describe("readRunDirection — a typed note that names a kind of post outranks the dialog's pick (SCRUM-430)", () => {
  // Lola picked "Kind of post", typed a note about what this run should
  // actually be, and expected the note to win. linkedin-agent read the two
  // independently, so the chip decided the shape. This is the shared answer,
  // mirroring tiktok's "customPrompt wins over requestedTopic": the typed
  // thing beats the clicked thing, on the axis the typed thing speaks to.

  it("reads a hot-news cue as a mode override, and still hands the sentence to the model", () => {
    const d = readRunDirection({ customPrompt: "React to this week's funding news in our space" });
    expect(d.modeOverride).toBe("hot-news");
    expect(d.direction).toBe("React to this week's funding news in our space");
  });

  it("reads a deep-value cue and an open-discussion cue", () => {
    expect(readRunDirection({ customPrompt: "Lessons from our first enterprise deal" }).modeOverride).toBe("deep-value");
    expect(readRunDirection({ customPrompt: "Ask the audience whether they would ship on a Friday" }).modeOverride).toBe("open-discussion");
  });

  it("leaves the pick standing when the note says nothing about the kind of post", () => {
    // A topic note and a style note both speak to other axes. Forcing a mode
    // off either would override a choice the client made on purpose.
    expect(readRunDirection({ customPrompt: "Focus on the product launch" }).modeOverride).toBeUndefined();
    expect(readRunDirection({ customPrompt: "Keep it shorter than usual" }).modeOverride).toBeUndefined();
    expect(readRunDirection({}).modeOverride).toBeUndefined();
  });

  it("refuses to guess when the note names two kinds of post", () => {
    // "a deep dive reacting to this week's news" is two modes. Picking one
    // silently is exactly the decision this module leaves to a person.
    expect(modeFromDirection("A deep dive reacting to this week's news")).toBeUndefined();
  });

  it("is read off the bare instruction, never off a labelled brief line", () => {
    // "Tone: how-to" is a form field, not a request to change the kind of post.
    const d = readRunDirection({ tone: "how to sound", audience: "founders" });
    expect(d.modeOverride).toBeUndefined();
    expect(d.direction).toContain("Tone: how to sound");
  });

  it("is omitted, not present-and-undefined, when absent", () => {
    expect("modeOverride" in readRunDirection({ customPrompt: "Focus on the product launch" })).toBe(false);
  });

  it("wins over a requested mode once handed to selectContentMode, exactly as a requested mode wins over rotation", () => {
    // The step-07b wiring: `selectContentMode(recent, directed ?? requested)`.
    const directed = readRunDirection({ customPrompt: "Ask the audience: is remote hiring dead?" }).modeOverride;
    expect(selectContentMode(["open-discussion", "open-discussion"], directed ?? "hot-news")).toBe("open-discussion");
    // And with no directed mode the requested one still decides.
    const notDirected = readRunDirection({ customPrompt: "Focus on the product launch" }).modeOverride;
    expect(selectContentMode(["open-discussion"], notDirected ?? "hot-news")).toBe("hot-news");
  });

  it("every content mode has cues, and no cue is a bare word that could appear in any sentence", () => {
    // Record<ContentMode, …> already makes a missing mode a type error; this
    // pins the runtime shape and the asymmetry rule the table's comment states.
    for (const mode of CONTENT_MODES) {
      expect(MODE_CUES[mode].length).toBeGreaterThan(0);
      for (const cue of MODE_CUES[mode]) {
        expect(cue).toBe(cue.toLowerCase());
        // A single common English word is a false-positive machine ("news",
        // "poll", "breaking"). Every cue is a phrase, or a word no one writes
        // by accident.
        expect(cue.includes(" ") || cue.includes("-") || cue.includes(":") || cue.length >= 8).toBe(true);
      }
    }
  });

  it("no cue belongs to two modes, so a single phrase can never be ambiguous by construction", () => {
    const seen = new Map<string, string>();
    for (const mode of CONTENT_MODES) {
      for (const cue of MODE_CUES[mode]) {
        expect(seen.get(cue), `"${cue}" is listed under both ${seen.get(cue)} and ${mode}`).toBeUndefined();
        seen.set(cue, mode);
      }
    }
  });
});

describe("the subject a run records, when its topic came from a typed note (2026-09-24)", () => {
  // The prep row this exists for: a two-clause note, typed in Hebrew, landed
  // in the client's subject table exactly as typed — second thought, colon and all.
  const note = "משהו על סוכני קניות מבוססי AI\nאו משהו על עלויות:";

  it("marks a promoted instruction as a note, and an explicit requestedTopic as not one", () => {
    expect(readRunDirection({ customPrompt: note }).topicFromNote).toBe(true);
    expect(readRunDirection({ requestedTopic: "AI shopping agents" }).topicFromNote).toBeUndefined();
    expect(readRunDirection({ requestedTopic: "AI shopping agents", customPrompt: note }).topicFromNote).toBeUndefined();
    expect(readRunDirection({ customPrompt: "Keep it shorter than usual" }).topicFromNote).toBeUndefined();
    expect(readRunDirection({}).topicFromNote).toBeUndefined();
  });

  it("leaves every topic that did not come from a note exactly as it is", () => {
    expect(recordedSubject("remote work", { fromNote: false, stated: "Something else entirely" })).toBe("remote work");
  });

  it("records the subject the draft named, never the note", () => {
    expect(recordedSubject(note, { fromNote: true, stated: "  AI shopping agents\n and brand discovery " })).toBe("AI shopping agents and brand discovery");
  });

  it("falls back to the note's first line, without its trailing colon, when the draft named nothing", () => {
    expect(recordedSubject(note, { fromNote: true })).toBe("משהו על סוכני קניות מבוססי AI");
    expect(recordedSubject(note, { fromNote: true, stated: "   " })).toBe("משהו על סוכני קניות מבוססי AI");
    expect(topicLineFromNote("\n\n  pricing for agents:  \nmore")).toBe("pricing for agents");
  });

  it("cuts a long line at a word boundary", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const line = topicLineFromNote(long);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(MAX_RECORDED_SUBJECT_CHARS + 1);
    expect(long.startsWith(line.slice(0, -1))).toBe(true);
    expect(line.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("never records an empty subject", () => {
    expect(recordedSubject(":::", { fromNote: true })).toBe(":::");
  });
});

describe("standing feedback — the client's notes about this agent, beside the run's direction", () => {
  const FEEDBACK = "# Client feedback — Instagram Agent\n\n## Applies to everything this agent makes\n- Never use the word synergy.";

  it("reaches the drafting step as clientStandingFeedback, and never enters direction", () => {
    const d = readRunDirection({ customPrompt: "focus on the product launch", standingFeedback: FEEDBACK });
    expect(d.direction).toBe("focus on the product launch");
    expect(d.standingFeedback).toBe(FEEDBACK);
    expect(runDirectionField(d)).toEqual({ runDirection: "focus on the product launch", clientStandingFeedback: FEEDBACK });
  });

  it("travels alone when the run carries no direction, and does not become a topic", () => {
    const d = readRunDirection({ standingFeedback: FEEDBACK });
    expect(d.direction).toBeUndefined();
    expect(d.topicOverride).toBeUndefined();
    expect(runDirectionField(d)).toEqual({ clientStandingFeedback: FEEDBACK });
  });

  it("is absent for a blank or non-string value, and bounded when huge", () => {
    expect(runDirectionField(readRunDirection({ standingFeedback: "   " }))).toEqual({});
    expect(runDirectionField(readRunDirection({ standingFeedback: 42 }))).toEqual({});
    const huge = readRunDirection({ standingFeedback: "x".repeat(MAX_STANDING_FEEDBACK_CHARS + 500) });
    expect(huge.standingFeedback).toHaveLength(MAX_STANDING_FEEDBACK_CHARS);
  });
});
