import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import { assertModelCatalogued } from "@agent-engine/core";
import { InstagramNativeEditorAgent } from "../src/agent/instagram-native-editor-agent.js";
import {
  buildNativeEditorPayload,
  decideNative,
  languageGateFields,
  languageGateText,
  nativeSteerFor,
  normaliseNativeEditorVerdict,
  okAxes,
  NativeCorrectionSchema,
  NativeEditorVerdictSchema,
  NATIVE_EDITOR_AXES,
  NATIVE_EDITOR_FEW_SHOT_CAP,
  NATIVE_EDITOR_FEW_SHOT_CHARS,
  NATIVE_EDITOR_MINOR_FAIL_COUNT,
  NATIVE_EDITOR_RUBRIC_VERSION,
  type NativeAxis,
  type NativeAxisVerdict,
  type NativeCorrection,
  type NativeEditorVerdict,
} from "../src/workflow/language-gate.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * RFC-15 §6 — the native editor: the rubric on disk, the verdict rule, and the
 * parser that makes "report without correcting" unrepresentable.
 *
 * ## Why a test pins a prompt file at all
 *
 * `language-gate.ts`'s Phase 0 comment argued for an INLINE judge prompt:
 * "a check whose wording lives in the same editable store as the drafting
 * prompts is one that can be edited to agree with them." Phase 4 overrides
 * that (a six-axis rubric with worked examples is exactly the artefact that
 * must be versioned and reviewable, and `instagram-image-vet` /
 * `instagram-visual-qa` are both judges with versioned prompts already) — but
 * it only gets to override it by answering the risk with a guard instead of by
 * hiding the file. THIS is that guard. An edit that softens the rubric into
 * agreement with the writer fails here.
 *
 * Nothing in this file calls a model.
 */

const PROMPT_DIR = new URL("../prompts/instagram-native-editor/", import.meta.url);

async function readPrompt(name: string): Promise<string> {
  return fsp.readFile(new URL(name, PROMPT_DIR), "utf8");
}

interface EditorConfig {
  id: string;
  allowedTools: string[];
  maxSteps?: number;
  skillRef: string;
  modelPolicy: { policy: string; model: string; vendor?: string; contentLanguageSensitive?: boolean };
}

/** The agent's own pinned configuration, reached the way every other agent-config test in this package reaches it. */
function editorConfig(): EditorConfig {
  const agent = new InstagramNativeEditorAgent({ router: {} as never, tools: {}, promptStore: {} as never });
  return (agent as unknown as { config: EditorConfig }).config;
}

function axesWith(overrides: Partial<Record<NativeAxis, NativeAxisVerdict>>): Record<NativeAxis, NativeAxisVerdict> {
  return { ...okAxes(), ...overrides };
}

function correction(over: Partial<NativeCorrection> = {}): NativeCorrection {
  return {
    target: "slide:3",
    field: "body",
    span: "בסוף היום",
    replacement: "בסופו של דבר",
    axis: "translationese",
    severity: "minor",
    why: "calque of 'at the end of the day'",
    ...over,
  };
}

function verdict(over: Partial<NativeEditorVerdict> = {}): NativeEditorVerdict {
  return { native: true, axes: okAxes(), corrections: [], rubricVersion: NATIVE_EDITOR_RUBRIC_VERSION, ...over };
}

describe("RFC-15 §6.2 — the rubric on disk", () => {
  it("ships `1.md` and a byte-identical `latest.md` (prompt-bump checklist step 2)", async () => {
    const [pinned, latest] = await Promise.all([readPrompt("1.md"), readPrompt("latest.md")]);
    expect(latest).toBe(pinned);
    expect(latest.length).toBeGreaterThan(2_000);
  });

  it("names all six axes, spelled exactly as the output schema keys", async () => {
    const latest = await readPrompt("latest.md");
    expect([...NATIVE_EDITOR_AXES]).toEqual(["translationese", "grammar", "register", "terminology", "convention", "idiom"]);
    for (const axis of NATIVE_EDITOR_AXES) {
      // Backticked as a heading AND quoted in the worked output example: the
      // model has to see the key it must emit, not a prose paraphrase of it.
      expect(latest, `axis "${axis}" is missing from the rubric`).toContain(`\`${axis}\``);
      expect(latest, `axis "${axis}" is missing from the output example`).toContain(`"${axis}":`);
    }
  });

  it("agrees with the zod output schema about which axes exist", () => {
    const parsed = NativeEditorVerdictSchema.parse(verdict());
    expect(Object.keys(parsed.axes).sort()).toEqual([...NATIVE_EDITOR_AXES].sort());
  });

  it("states the verdict rule: any major, or three or more minors, and two minors pass", async () => {
    const latest = await readPrompt("latest.md");
    expect(latest).toContain("ANY axis is `major`");
    expect(latest).toContain("THREE OR MORE axes are `minor`");
    expect(latest).toContain("Two minors pass");
  });

  it("states that a finding without a correction is discarded", async () => {
    const latest = await readPrompt("latest.md");
    expect(latest).toContain("An axis flagged with no correction on it is **discarded**");
    expect(latest).toContain("A span that appears zero times or twice is dropped");
  });

  it("keeps the Phase 0 'judge only the language' framing verbatim", async () => {
    const latest = await readPrompt("latest.md");
    // Both sentences are lifted character for character from
    // `buildLanguageFluencySystemPrompt`. They are what stop a language judge
    // from failing drafts for reasons a redraft cannot address, and they were
    // not re-derived for Phase 4 on purpose.
    // Compared with runs of whitespace collapsed: the prompt is hard-wrapped
    // at 80 columns and a re-wrap must not be able to fail this guard, while a
    // reworded sentence still does.
    const flat = latest.replace(/\s+/g, " ");
    expect(flat).toContain("Judge ONLY the language. Not the topic, not the tone, not the marketing quality, not whether you agree with it.");
    expect(flat).toContain(
      "Proper nouns, brand names, product names and technical terms left in their original language are NORMAL and are NOT a failure. Neither is informal register, fragments, or headline style",
    );
    expect(latest).toContain("`07g`");
  });

  it("carries a worked Hebrew example on each of the six axes", async () => {
    const latest = await readPrompt("latest.md");
    const examples: Record<NativeAxis, readonly string[]> = {
      // A: a calque, with the phrase a native writer uses instead.
      translationese: ["בסוף היום", "בסופו של דבר"],
      // B: numeral/gender agreement, and a של chain resolved to a construct.
      grammar: ["שלושה חברות", "שלוש חברות", "מנהל הפרויקט"],
      // C: BOTH directions — literary hypercorrection and unearned slang.
      register: ["הינו", "הוא הכלי הכי משמעותי", "קורע"],
      // D: Academy purism, and a term that should have stayed in Latin.
      terminology: ["יישומון", "אפליקציה", "AI גנרטיבי"],
      // E: curly quotes, and a dash range written out with עד.
      convention: ["“המודל החדש”", '"המודל החדש"', "עד"],
      // F: grammatical, conventional, and nothing anybody says aloud.
      idiom: ["הפלטפורמה מאפשרת ייעול תהליכים", "הפלטפורמה חוסכת לצוות זמן"],
    };
    for (const axis of NATIVE_EDITOR_AXES) {
      for (const example of examples[axis]) {
        expect(latest, `axis "${axis}" lost its worked example "${example}"`).toContain(example);
      }
    }
  });

  it("hands the judge the client's own posts, labelled as voice and not as topic", async () => {
    const latest = await readPrompt("latest.md");
    expect(latest).toContain("this client's real published voice");
    expect(latest).toContain("It is not a topic list");
    // The fairness clause: a judge holding the writer to a register the writer
    // was never shown generates redrafts that cannot converge.
    expect(latest).toContain("The same `clientPublishedVoice` posts were shown to the writer.");
  });

  it("forbids changing a number, a date, a name or a claim, and forbids proposing a dash", async () => {
    const latest = await readPrompt("latest.md");
    expect(latest).toContain("Never change a number, a date, a name, a claim or a source.");
    expect(latest).toContain("Never propose an em dash, an en dash or a double hyphen");
    expect(latest).toContain("gate.lintPost");
  });

  it("tells the judge to confirm or reject the deterministic gate's soft tells rather than repeat them", async () => {
    const latest = await readPrompt("latest.md");
    expect(latest).toContain("gate.nativeLanguage");
    expect(latest).toContain("Confirm or reject each one, with the corrected string.");
  });
});

describe("the verdict rule is a threshold with a real other side", () => {
  it("pins the minor count at three", () => {
    // The break-the-code check for this file: set this to 4, re-run, and the
    // three-minor case below goes green. If it does not, this suite is not
    // reading the constant the parser uses.
    expect(NATIVE_EDITOR_MINOR_FAIL_COUNT).toBe(3);
  });

  it("passes a clean draft", () => {
    expect(decideNative(okAxes())).toBe(true);
  });

  it("passes TWO minors", () => {
    expect(decideNative(axesWith({ translationese: "minor", convention: "minor" }))).toBe(true);
  });

  it("fails THREE minors", () => {
    expect(decideNative(axesWith({ translationese: "minor", convention: "minor", idiom: "minor" }))).toBe(false);
  });

  it("fails a single major on its own", () => {
    expect(decideNative(axesWith({ grammar: "major" }))).toBe(false);
  });

  it("fails a major even when it is the only non-ok axis and every other is clean", () => {
    for (const axis of NATIVE_EDITOR_AXES) {
      expect(decideNative(axesWith({ [axis]: "major" } as Partial<Record<NativeAxis, NativeAxisVerdict>>)), axis).toBe(false);
    }
  });
});

describe("normaliseNativeEditorVerdict — 'report without correcting' is unrepresentable", () => {
  it("discards a non-ok axis that carries no correction", () => {
    const out = normaliseNativeEditorVerdict(verdict({ native: false, axes: axesWith({ register: "major" }), corrections: [] }));
    expect(out.axes.register).toBe("ok");
    expect(out.native).toBe(true);
  });

  it("discards only the axes with no corrections, and keeps the ones that have them", () => {
    const out = normaliseNativeEditorVerdict(
      verdict({
        native: false,
        axes: axesWith({ translationese: "minor", grammar: "major", idiom: "minor" }),
        corrections: [correction({ axis: "grammar", severity: "major" })],
      }),
    );
    expect(out.axes).toEqual(axesWith({ grammar: "major" }));
    expect(out.native).toBe(false);
    expect(out.corrections).toHaveLength(1);
  });

  it("turns a three-minor flag with only one correction into a PASS, because two of the three were never actionable", () => {
    const out = normaliseNativeEditorVerdict(
      verdict({
        native: false,
        axes: axesWith({ translationese: "minor", convention: "minor", idiom: "minor" }),
        corrections: [correction({ axis: "idiom" })],
      }),
    );
    expect(out.axes).toEqual(axesWith({ idiom: "minor" }));
    expect(out.native).toBe(true);
  });

  it("recomputes `native` rather than trusting the model's own boolean", () => {
    const out = normaliseNativeEditorVerdict(
      verdict({ native: true, axes: axesWith({ grammar: "major" }), corrections: [correction({ axis: "grammar", severity: "major" })] }),
    );
    expect(out.native).toBe(false);
  });

  it("drops a correction whose span or replacement is blank", () => {
    const out = normaliseNativeEditorVerdict(
      verdict({ native: false, axes: axesWith({ idiom: "minor" }), corrections: [correction({ axis: "idiom", replacement: "   " })] }),
    );
    expect(out.corrections).toHaveLength(0);
    expect(out.axes.idiom).toBe("ok");
  });

  it("refuses a correction whose field is not one of the rewritable ones", () => {
    // `sourceRef`, `visualNeed` and `stat.figure` are not reachable from the
    // correction schema at all — the cheapest possible guarantee that a
    // language correction never changes a claim or a numeral.
    expect(NativeCorrectionSchema.safeParse(correction({ field: "sourceRef" as never })).success).toBe(false);
    expect(NativeCorrectionSchema.safeParse(correction({ target: "slide:9" })).success).toBe(false);
    expect(NativeCorrectionSchema.safeParse(correction({ target: "slide:1" })).success).toBe(true);
  });
});

describe("languageGateFields — what the judge is shown", () => {
  const hebrewSlide = (n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy => ({
    n,
    headline: `ממצא מספר ${n}`,
    body: "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע ארבע שעות בכל שבוע.",
    visualNeed: "a photograph of an operations dashboard",
    sourceRef: "Teams that automated weekly reporting saved four hours a week",
    layout: "text_only",
    ...over,
  });

  const copy: InstagramCopyOutput = {
    format: "carousel",
    caption: "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה.",
    slides: [
      hebrewSlide(1, { kicker: "רבעון שלישי" }),
      hebrewSlide(2, {
        device: { kind: "bars", rows: [{ label: "צוות התמיכה", value: 30, display: "30%" }, { label: "צוות המכירות", value: 18, display: "18%" }], source: "internal" },
      }),
      hebrewSlide(3, {
        customArchetype: {
          archetypeId: "custom_split_note",
          name: "Split note",
          rationale: "none of the six fit",
          bodyHtml: "<div>{{leftLabel}}</div>",
          css: "",
          slots: ["leftLabel"],
          fields: { leftLabel: "לפני המעבר" },
        },
      }),
    ],
  };

  const ids = () => languageGateFields(copy).map((f) => f.id);

  it("covers the caption, every headline, every body and a kicker", () => {
    expect(ids()).toEqual(expect.arrayContaining(["caption", "slide-1.headline", "slide-1.body", "slide-1.kicker", "slide-3.body"]));
  });

  it("covers a custom archetype's field VALUES", () => {
    const field = languageGateFields(copy).find((f) => f.id === "slide-3.fields.leftLabel");
    expect(field?.text).toBe("לפני המעבר");
  });

  it("covers DEVICE LABELS — rendered copy that no gate had ever read", () => {
    const labels = languageGateFields(copy).filter((f) => f.id.startsWith("slide-2.device."));
    expect(labels.map((f) => f.text)).toEqual(["צוות התמיכה", "צוות המכירות"]);
    expect(labels.map((f) => f.id)).toEqual(["slide-2.device.rows.0.label", "slide-2.device.rows.1.label"]);
  });

  it("excludes a device's numerals and its source, which are not language", () => {
    const text = languageGateFields(copy).map((f) => f.text);
    expect(text).not.toContain("30%");
    expect(text).not.toContain("internal");
  });

  it("excludes sourceRef and visualNeed, for the unchanged reason", () => {
    // A verbatim source claim and a stock-photo search query. Gating on either
    // fails every correct Hebrew draft whose sources happen to be English.
    const text = languageGateFields(copy).map((f) => f.text).join("\n");
    expect(text).not.toContain("Teams that automated weekly reporting");
    expect(text).not.toContain("a photograph of an operations dashboard");
    expect(ids().some((id) => id.includes("sourceRef") || id.includes("visualNeed"))).toBe(false);
  });

  it("skips an empty field rather than asking the judge to rule on nothing", () => {
    const withBlank: InstagramCopyOutput = { ...copy, slides: [hebrewSlide(1, { kicker: "   " })] };
    expect(languageGateFields(withBlank).map((f) => f.id)).not.toContain("slide-1.kicker");
  });

  // ── THE ARCHETYPE COPY BLOCKS ──
  //
  // Four of the eight archetypes do not render `headline`/`body` at all
  // (`contentFor` in `slides-data.ts` is the authority; `quote-card.html` has
  // no `{{headline}}` and no `{{body}}`). Until these were emitted, a Hebrew
  // carousel whose pull-quote and comparison columns were written in ENGLISH
  // passed 07e's script check, `gate.nativeLanguage` rule 1 and the native
  // editor — all three read two strings the reader never sees.
  //
  // Break it by deleting the `archetypeTextSlots` loop from
  // `languageGateFields` and every case below fails.
  describe("the archetype copy blocks — the prose four archetypes actually paint", () => {
    const archetypeCopy: InstagramCopyOutput = {
      format: "carousel",
      caption: "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה.",
      slides: [
        hebrewSlide(1, { layout: "quote_card", quote: { text: "בנינו את הכל מחדש סביב מודל אחד.", attribution: "מנכ״לית אקמה" } }),
        hebrewSlide(2, { layout: "stat_callout", stat: { figure: "47%", subLabel: "מהצוותים עברו לתהליך החדש", source: "Reuters, 2026" } }),
        hebrewSlide(3, {
          layout: "comparison_card",
          comparison: { leftLabel: "לפני", leftBody: "שלושה ימים לכל דיפלוי", rightLabel: "אחרי", rightBody: "ארבע שעות בממוצע" },
        }),
        hebrewSlide(4, { layout: "list_takeaway", items: [{ title: "מדדו את זמן הדיפלוי", note: "בכל שבוע" }, { title: "בחרו מודל אחד" }] }),
      ],
    };
    const archetypeIds = (): string[] => languageGateFields(archetypeCopy).map((f) => f.id);
    const byId = (id: string): string | undefined => languageGateFields(archetypeCopy).find((f) => f.id === id)?.text;

    it("judges a quote card's pull-quote and attribution — the ONLY prose that slide renders", () => {
      expect(byId("slide-1.quote.text")).toBe("בנינו את הכל מחדש סביב מודל אחד.");
      expect(byId("slide-1.quote.attribution")).toBe("מנכ״לית אקמה");
    });

    it("judges a stat callout's sub-label", () => {
      expect(byId("slide-2.stat.subLabel")).toBe("מהצוותים עברו לתהליך החדש");
    });

    it("judges all four comparison columns", () => {
      expect(byId("slide-3.comparison.leftLabel")).toBe("לפני");
      expect(byId("slide-3.comparison.leftBody")).toBe("שלושה ימים לכל דיפלוי");
      expect(byId("slide-3.comparison.rightLabel")).toBe("אחרי");
      expect(byId("slide-3.comparison.rightBody")).toBe("ארבע שעות בממוצע");
    });

    it("judges a list's rows, and omits a row's absent note rather than inventing one", () => {
      expect(byId("slide-4.items.0.title")).toBe("מדדו את זמן הדיפלוי");
      expect(byId("slide-4.items.0.note")).toBe("בכל שבוע");
      expect(byId("slide-4.items.1.title")).toBe("בחרו מודל אחד");
      expect(archetypeIds()).not.toContain("slide-4.items.1.note");
    });

    it("still excludes stat.figure and stat.source — a numeral and a citation, not language", () => {
      // `stat.source` RENDERS (as `sourceLine`) and is excluded anyway, on the
      // same grounds as a device's `source` and `sourceRef`: research runs in
      // whatever language the sources are in, so gating on it fails every
      // correct Hebrew draft whose sources happen to be English.
      expect(archetypeIds()).not.toContain("slide-2.stat.figure");
      expect(archetypeIds()).not.toContain("slide-2.stat.source");
      const text = languageGateFields(archetypeCopy).map((f) => f.text);
      expect(text).not.toContain("47%");
      expect(text).not.toContain("Reuters, 2026");
    });

    it("the AGGREGATE corpus sees them too, so an English pull-quote cannot pass the script check", () => {
      // `languageGateText` feeds 07e's `checkExpectedScript`. It had the same
      // blind spot, so widening only the per-field list would have left the
      // aggregate ratio computed without the one string a quote slide shows.
      const english: InstagramCopyOutput = {
        ...archetypeCopy,
        slides: [hebrewSlide(1, { layout: "quote_card", quote: { text: "We rebuilt everything around a single model.", attribution: "Acme CEO" } })],
      };
      expect(languageGateText(english)).toContain("We rebuilt everything around a single model.");
      expect(languageGateText(archetypeCopy)).toContain("בנינו את הכל מחדש סביב מודל אחד.");
      expect(languageGateText(archetypeCopy)).not.toContain("Reuters, 2026");
    });
  });
});

describe("nativeSteerFor — the corrections as a redraft steer", () => {
  it("renders one anchored line per correction", () => {
    const steer = nativeSteerFor([
      correction(),
      correction({ target: "caption", field: "caption", span: "יישומון", replacement: "אפליקציה", axis: "terminology", why: "Academy purism" }),
    ]);
    expect(steer.split("\n")).toEqual([
      'slide 3 · body · "בסוף היום" → "בסופו של דבר" (calque of \'at the end of the day\')',
      'caption · "יישומון" → "אפליקציה" (Academy purism)',
    ]);
  });

  it("names the custom field key, so 'apply it' stays a mechanical instruction", () => {
    const steer = nativeSteerFor([correction({ field: "custom", customKey: "leftLabel", span: "הינו", replacement: "הוא", axis: "register" })]);
    expect(steer).toContain("slide 3 · fields.leftLabel · ");
  });

  it("is empty for an empty verdict, so the caller never sets a steer made of nothing", () => {
    expect(nativeSteerFor([])).toBe("");
  });
});

describe("buildNativeEditorPayload", () => {
  const fields = [{ id: "caption", text: "מבט קצר" }];

  it("caps the few-shot at four posts and trims each one", () => {
    const payload = buildNativeEditorPayload({
      language: "Hebrew",
      fields,
      fewShot: ["א".repeat(900), "ב", "ג", "ד", "ה", "ו"],
    }) as { clientPublishedVoice: string[] };
    expect(NATIVE_EDITOR_FEW_SHOT_CAP).toBe(4);
    expect(payload.clientPublishedVoice).toHaveLength(4);
    expect(payload.clientPublishedVoice[0]!).toHaveLength(NATIVE_EDITOR_FEW_SHOT_CHARS);
  });

  it("omits every optional block that is absent rather than sending an empty one", () => {
    const payload = buildNativeEditorPayload({ language: "Hebrew", fields });
    expect(Object.keys(payload).sort()).toEqual(["fields", "language", "rubricVersion"]);
    expect(payload["rubricVersion"]).toBe(NATIVE_EDITOR_RUBRIC_VERSION);
  });

  it("carries the register card, the script and the gate's soft tells when they exist", () => {
    const payload = buildNativeEditorPayload({
      language: "Hebrew",
      script: "Hebrew",
      registerCard: "journalistic mid-register",
      softTells: ["mixed maqaf and ASCII hyphen"],
      fields,
    });
    expect(payload["script"]).toBe("Hebrew");
    expect(payload["registerCard"]).toBe("journalistic mid-register");
    expect(payload["softTells"]).toEqual(["mixed maqaf and ASCII hyphen"]);
  });
});

describe("the judge's own configuration", () => {
  it("is pinned, tool-free and one turn", () => {
    const config = editorConfig();
    expect(config.id).toBe("instagram-native-editor");
    expect(config.allowedTools).toEqual([]);
    expect(config.maxSteps).toBe(1);
    expect(config.skillRef).toBe("instagram-native-editor@1");
    expect(config.modelPolicy.policy).toBe("pinned");
  });

  it("retires the `instagram-language-fluency` class id, so no Studio override survives the vendor move", () => {
    // RFC-15 decision 9: the step moves vendor anthropic -> gemini, and a
    // stale `stageModels` override under the OLD id holding a Claude model
    // would make `assertModelCatalogued` throw on vendor mismatch. A new class
    // id inherits no override.
    expect(editorConfig().id).not.toBe("instagram-language-fluency");
  });

  it("runs on gemini-2.5-pro and on no Opus, at any tier", () => {
    const config = editorConfig();
    expect(config.modelPolicy.vendor).toBe("gemini");
    expect(config.modelPolicy.model).toBe("gemini-2.5-pro");
    expect(JSON.stringify(config.modelPolicy)).not.toContain("opus");
  });

  it("is accepted by assertModelCatalogued, and the catalog agrees it is the right tier", () => {
    const config = editorConfig();
    const capabilities = assertModelCatalogued(config.modelPolicy.model, "gemini", "native-editor-rubric.test.ts");
    // The plan asks for "a strong model"; the owner bans Opus. This row is the
    // catalog's own answer to both at once.
    expect(capabilities.languageStrength).toBe("multilingual-strong");
    expect(capabilities.rtlSupport).toBe("strong");
    expect(capabilities.costTier).not.toBe("premium");
  });

  it("is NOT contentLanguageSensitive, because it is already pinned to the model that policy would pick", () => {
    // `applyClientLanguagePolicy` re-points such a step to the cheapest
    // same-vendor `multilingual-strong` row. This step is already on it, so
    // letting the policy move it could only move it somewhere worse.
    expect(editorConfig().modelPolicy.contentLanguageSensitive ?? false).toBe(false);
  });
});
