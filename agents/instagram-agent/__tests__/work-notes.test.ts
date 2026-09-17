import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import {
  checkCraftHygiene,
  checkWorkNotes,
  findWorkNote,
  HEBREW_WORK_NOTE_PATTERNS,
  UNIVERSAL_WORK_NOTE_KEY,
  UNIVERSAL_WORK_NOTE_PATTERNS,
  WORK_NOTE_PACKS,
  workNotePackFor,
} from "../src/workflow/craft-hygiene.js";
import { scriptTableEntries } from "../src/workflow/language-gate.js";
import { seriesDirective, selectSeries } from "../src/workflow/editorial-series.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import { goodCopyOutput, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * PHASE 5.5, BRIEF ITEM G — the model's work notes stop reaching the reader.
 *
 * ## What shipped
 *
 * geektime, 2026-09-16, run `pubsub-21868533047825082`, slide 4's `body`, on
 * the plate, approved by a human:
 *
 *   `היא חלק ממנו. ההבדל הזה לא שיווקי, הוא מבני. לא נמצא ציטוט משתתף ישיר
 *    בחומרים; השקף נושא את הטענה בכותרת ובגוף.`
 *
 * The second half is a note to the pipeline: *"no direct participant quote was
 * found in the materials; the slide carries the claim in the headline and the
 * body."*
 *
 * ## Why the writer wrote it
 *
 * Because it was told to. `editorial-series.ts`'s directive ended *"If a
 * required object genuinely cannot be written from the cards you were given,
 * say so in that slide's content and leave the object out"*, `field_notes`
 * puts a `quote_card` at slide 4, and geektime's cards held no quote. A
 * downstream regex alone would have been treating the symptom, so the
 * instruction is fixed at source (asserted below) AND guarded here.
 */

/** The string that shipped, byte for byte. */
const GEEKTIME_WORK_NOTE = "היא חלק ממנו. ההבדל הזה לא שיווקי, הוא מבני. לא נמצא ציטוט משתתף ישיר בחומרים; השקף נושא את הטענה בכותרת ובגוף.";

/**
 * THE CONTROL, from the same run's slide 6: *"it is not found in market
 * surveys, but in the reading patterns geektime has measured over 17 years."*
 *
 * Good copy, and it opens on the same two words as the work note. It is the
 * reason `לא נמצא` is not a pattern and `לא נמצא …בחומרים` is: a guard that
 * refused this line would cost a redraft attempt on a correct draft, which is
 * the fail-dangerous shape `ACRONYM_ALLOWLIST` already paid for twice.
 */
const GEEKTIME_GOOD_LINE = "לא נמצא בשאלוני שוק, הוא בדפוסי הקריאה שגיקטיים מדדה ב-17 שנה.";

function copyWith(overrides: Partial<InstagramCopyOutput["slides"][number]>[], caption = "A caption a reader can read."): InstagramCopyOutput {
  return {
    format: "carousel",
    caption,
    slides: overrides.map((o, i) => ({
      n: i + 1,
      headline: `Headline ${i + 1}`,
      body: `Body copy ${i + 1}, written for the reader.`,
      visualNeed: `need ${i + 1}`,
      sourceRef: `claim ${i + 1}`,
      layout: "photo" as const,
      ...o,
    })),
  };
}

function reasonOf(result: { ok: boolean; reason?: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.reason ?? "";
}

describe("the work-note clause refuses the text that shipped", () => {
  it("refuses the geektime body verbatim, and names the slide", () => {
    const result = checkWorkNotes(copyWith([{}, {}, {}, { body: GEEKTIME_WORK_NOTE }]), "Hebrew");
    expect(result.ok).toBe(false);
    const reason = reasonOf(result);
    expect(reason).toMatch(/^slide 4 /);
    expect(reason).toContain("materials-absent-he");
    // The steer quotes the offending SENTENCE, not the perfectly good opening
    // of the body it sits at the end of.
    expect(reason).toContain("לא נמצא ציטוט משתתף ישיר בחומרים");
    expect(reason).not.toContain("היא חלק ממנו");
    // The steer names the channel the note belongs in, so the redraft has
    // somewhere to put it rather than only something to avoid.
    expect(reason).toContain("`unfillable`");
  });

  it("refuses each half of it on its own — the absence AND the slide talking about itself", () => {
    expect(findWorkNote("לא נמצא ציטוט משתתף ישיר בחומרים")?.key).toBe("materials-absent-he");
    expect(findWorkNote("השקף נושא את הטענה בכותרת ובגוף")?.key).toBe("slide-self-reference-he");
  });

  /**
   * THE NEGATIVE CONTROL, and the one this file exists to keep. Widen
   * `materials-absent-he` to a bare `לא נמצא` and this test refuses the
   * change.
   */
  it("passes the good Hebrew line that opens on the same two words", () => {
    expect(findWorkNote(GEEKTIME_GOOD_LINE)).toBeUndefined();
    expect(checkWorkNotes(copyWith([{ body: GEEKTIME_GOOD_LINE }]), "Hebrew").ok).toBe(true);
  });

  it.each([
    ["No direct participant quote was available, so the headline carries the claim.", "object-not-found"],
    ["Nothing in the source materials supports a second figure here.", "materials-absent"],
    ["The fact cards do not name a customer, so the headline stands alone.", "cards-do-not"],
    ["This slide carries the argument in the headline instead.", "slide-self-reference"],
    ["Per the brief, the closer repeats the cover's figure.", "per-the-brief"],
    ["As instructed, the quote is left out.", "as-instructed"],
    ["A comparison cannot be written from what we have.", "cannot-be-written"],
    ["The layout requires a figure that the research never produced.", "archetype-self-reference"],
  ])("refuses the English work note %j", (text, key) => {
    expect(findWorkNote(text)?.key).toBe(key);
  });

  it.each([
    "Nothing found here will surprise a founder who has shipped before.",
    "No two markets rank the same, and the gap is widening.",
    "Save this slide deck for your next planning cycle.",
    "The cards are on the table: budgets move in March.",
    "We could not be prouder of what the team built this quarter.",
  ])("passes the ordinary sentence %j", (text) => {
    expect(findWorkNote(text)).toBeUndefined();
  });

  it("reads a custom archetype's own slot values and the caption, because a reader sees those too", () => {
    const inCustom = copyWith([
      {
        layout: "custom",
        customArchetype: {
          archetypeId: "split-figure",
          name: "Split figure",
          rationale: "The claim is one figure against one sentence.",
          bodyHtml: "<section>{{lede}}</section>",
          css: ".x{color:red}",
          slots: ["lede"],
          fields: { lede: "No usable quote was found in the cards." },
        },
      },
    ]);
    expect(checkWorkNotes(inCustom).ok).toBe(false);

    const inCaption = copyWith([{}], "As instructed, the caption closes on the question.");
    const captionResult = checkWorkNotes(inCaption);
    expect(captionResult.ok).toBe(false);
    expect(reasonOf(captionResult)).toMatch(/^the caption /);
  });

  /**
   * THE ESCAPE HATCH IS NOT SCANNED. `unfillable` is where a writer that
   * cannot fill a required object reports it (copy schema, Phase 5.5 item B),
   * and a guard that refused the honest channel too would leave silence as
   * the only compliant answer.
   *
   * The field is typed onto the slide by W1-B; this cast is what lets the
   * guard's contract be pinned on either side of that landing, and it is a
   * real control either way — the same sentence in `body` fails one line
   * below.
   */
  it("passes the same sentence when it is reported in `unfillable` instead of on the plate", () => {
    const note = "No direct participant quote was found in the materials.";
    const reported = copyWith([{}, {}, {}, { ...({ unfillable: note } as Record<string, unknown>) }]);
    expect(checkWorkNotes(reported, "Hebrew").ok).toBe(true);
    expect(checkWorkNotes(copyWith([{}, {}, {}, { body: note }]), "Hebrew").ok).toBe(false);
  });
});

describe("the vocabulary is keyed to the shared language table", () => {
  /**
   * The keying is what stops a new target language from silently losing the
   * guard: a pack key is a `SCRIPT_TABLE` script name, so a pack for a
   * language the fleet cannot resolve is impossible to write, and a language
   * with no pack is reported as `universalOnly` rather than as covered.
   */
  it("every pack key is a script the shared table knows", () => {
    const known = new Set(scriptTableEntries().map((entry) => entry.script.name));
    for (const key of Object.keys(WORK_NOTE_PACKS)) expect(known, key).toContain(key);
  });

  it("resolves a pack through the table's own aliases and tags", () => {
    for (const target of ["Hebrew", "hebrew", "he", "he-IL", "עברית"]) {
      const pack = workNotePackFor(target);
      expect(pack.key, target).toBe("Hebrew");
      expect(pack.universalOnly, target).toBe(false);
      expect(pack.patterns.length, target).toBe(UNIVERSAL_WORK_NOTE_PATTERNS.length + HEBREW_WORK_NOTE_PATTERNS.length);
    }
  });

  it("a language with no pack still gets the universal rows, and says so", () => {
    const pack = workNotePackFor("Greek");
    expect(pack.key).toBe(UNIVERSAL_WORK_NOTE_KEY);
    expect(pack.universalOnly).toBe(true);
    expect(pack.patterns).toEqual(UNIVERSAL_WORK_NOTE_PATTERNS);

    // ...and the finding SAYS the guard is thin there, rather than implying a
    // cover it does not have.
    const thin = checkWorkNotes(copyWith([{ body: "As instructed, the quote is left out." }]), "Greek");
    expect(reasonOf(thin)).toContain("no work-note vocabulary is registered for Greek");
  });

  it("does not print the coverage caveat for English, or for a language with a pack", () => {
    const english = checkWorkNotes(copyWith([{ body: "As instructed, the quote is left out." }]), "en-US");
    expect(reasonOf(english)).not.toContain("no work-note vocabulary");
    const hebrew = checkWorkNotes(copyWith([{ body: GEEKTIME_WORK_NOTE }]), "Hebrew");
    expect(reasonOf(hebrew)).not.toContain("no work-note vocabulary");
  });

  /**
   * Scanned unconditionally, for the reason `HEBREW_BANNED_PHRASES` is passed
   * unconditionally: the run this guard is for is the one whose language
   * resolution says one thing and whose writer does another. A Hebrew work
   * note cannot occur in an English draft, so keying the scan to the resolved
   * language would only ever lose catches.
   */
  it("catches the Hebrew note on a run that resolved no language at all", () => {
    expect(checkWorkNotes(copyWith([{ body: GEEKTIME_WORK_NOTE }])).ok).toBe(false);
    expect(checkWorkNotes(copyWith([{ body: GEEKTIME_WORK_NOTE }]), "English").ok).toBe(false);
  });

  it("is not defeated by a stray bidi or zero-width mark between the words", () => {
    // Model output arrives with these; `\s+` would otherwise walk straight
    // past the note.
    const withMarks = "לא נמצא‏ ציטוט משתתף ישיר⁦ בחומרים";
    expect(findWorkNote(withMarks)?.key).toBe("materials-absent-he");
  });
});

describe("the instruction that produced it", () => {
  /**
   * LAYER 1. The guard above is the backstop; this is the cause. A directive
   * that still asked for the note would keep buying redrafts of a draft the
   * model was told to write.
   */
  it("no longer tells the writer to put an unfillable object in the slide's content", () => {
    const choice = selectSeries({ restsOnKinds: ["event", "event"] });
    const directive = seriesDirective(choice, 8);
    expect(directive).not.toMatch(/say so in that slide's content/);
    expect(directive).toContain("`unfillable`");
    expect(directive).toMatch(/never in `headline`/);
  });
});

describe("checkCraftHygiene routes it", () => {
  let env: TestEnvironment;
  const ctx: AgentContext = { runId: "run_worknotes", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * A refusal here is `07b`'s existing ladder: attempts 1..n−1 redraft, the
   * final attempt records the sentence and SHIPS. Never a hold — a work note
   * on a plate is a bad slide, and a held run is no slides at all.
   */
  it("fails a draft carrying the geektime note, through the real gate", async () => {
    const copy = goodCopyOutput();
    const withNote = { ...copy, slides: copy.slides.map((s, i) => (i === 3 ? { ...s, body: GEEKTIME_WORK_NOTE } : s)) };
    const result = await checkCraftHygiene(env.tools, ctx, withNote, "Hebrew");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain("narrates the work");
  });

  it("leaves an ordinary draft alone", async () => {
    expect((await checkCraftHygiene(env.tools, ctx, goodCopyOutput(), "Hebrew")).ok).toBe(true);
  });
});
