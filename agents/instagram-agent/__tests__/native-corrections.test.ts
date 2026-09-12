import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tools";
import { checkCraftHygiene } from "../src/workflow/craft-hygiene.js";
import type { NativeCorrection } from "../src/workflow/language-gate.js";
import { applyNativeCorrections, type NativeCorrectionDeps } from "../src/workflow/native-corrections.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * RFC-15 §6.5 — `applyNativeCorrections`: the free, in-place patch that stops
 * a sentence-level language finding from costing a $0.240 redraft.
 *
 * Every test here is about a REFUSAL. The happy path is one case; the other
 * eight are the patcher declining to guess, because an ambiguous patch ships a
 * sentence nobody wrote and nobody reviewed.
 *
 * `checkHygiene` is wired to the REAL `gate.lintPost` (`createKarosGatesTools`,
 * no workspace, no network, no model) rather than to a stub. The whole point
 * of the re-check is that a judge's proposal must clear the gates the draft
 * already cleared, and a stubbed gate proves nothing about that.
 */

const ctx: AgentContext = { runId: "run_native_corrections", clientSlug: "geektime", productId: "instagram-agent", runKind: "recurring", metadata: {} };

function hebrewDeps(): NativeCorrectionDeps {
  const tools = createKarosGatesTools();
  return { language: "Hebrew", checkHygiene: (copy) => checkCraftHygiene(tools, ctx, copy) };
}

function slide(n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy {
  return {
    n,
    headline: `ממצא מספר ${n}`,
    body: "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע ארבע שעות בכל שבוע.",
    visualNeed: "a photograph of an operations dashboard",
    sourceRef: "Teams that automated weekly reporting saved four hours a week",
    layout: "text_only",
    ...over,
  };
}

/**
 * A fluent Hebrew carousel carrying one calque on slide 2 — the exact shape
 * the native editor returns a correction for.
 */
function hebrewCopy(overrides: { slides?: InstagramSlideCopy[]; caption?: string } = {}): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: overrides.caption ?? "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה.",
    slides: overrides.slides ?? [
      slide(1, { kicker: "רבעון שלישי" }),
      slide(2, { body: "בסוף היום, הצוות סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך החדש." }),
      slide(3),
    ],
  };
}

function correction(over: Partial<NativeCorrection> = {}): NativeCorrection {
  return {
    target: "slide:2",
    field: "body",
    span: "בסוף היום",
    replacement: "בסופו של דבר",
    axis: "translationese",
    severity: "minor",
    why: "calque of 'at the end of the day'",
    ...over,
  };
}

describe("applyNativeCorrections — the happy path", () => {
  it("replaces the anchored span and leaves everything else byte-identical", async () => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(copy, [correction()], hebrewDeps());

    expect(out.applied).toBe(1);
    expect(out.dropped).toBe(0);
    expect(out.discardReason).toBeUndefined();
    expect(out.copy.slides[1]!.body).toBe("בסופו של דבר, הצוות סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך החדש.");
    // Only that one field moved.
    expect({ ...out.copy, slides: out.copy.slides.map((s, i) => (i === 1 ? { ...s, body: copy.slides[1]!.body } : s)) }).toEqual(copy);
  });

  /**
   * The replacement is written LITERALLY, `$` and all.
   *
   * `String.prototype.replace` expands `$$`, `$&`, `` $` `` and `$'` inside
   * the replacement even when the search value is a plain string, so a
   * proposal containing one of them used to ship text nobody wrote — and
   * since the corruption stays in Hebrew script, neither the hygiene re-check
   * nor the script re-check notices. Break the splice back to
   * `resolved.text.replace(span, replacement)` and the first case below
   * returns `"…הצוות סגר…"` spliced in where `$&` was.
   */
  it("writes a replacement containing $-patterns literally, instead of expanding them", async () => {
    const cases: Array<[string, string]> = [
      ["$& ואחריו", "$& ואחריו"],
      ["$$ ואחריו", "$$ ואחריו"],
      ["$` ואחריו", "$` ואחריו"],
      ["$' ואחריו", "$' ואחריו"],
    ];
    for (const [replacement, expected] of cases) {
      const copy = hebrewCopy();
      const out = await applyNativeCorrections(copy, [correction({ replacement })], hebrewDeps());
      expect(out.applied, replacement).toBe(1);
      expect(out.copy.slides[1]!.body, replacement).toBe(`${expected}, הצוות סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך החדש.`);
    }
  });

  it("never touches sourceRef, visualNeed or a slide's number while patching its prose", async () => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(copy, [correction()], hebrewDeps());
    for (const [i, patched] of out.copy.slides.entries()) {
      expect(patched.sourceRef).toBe(copy.slides[i]!.sourceRef);
      expect(patched.visualNeed).toBe(copy.slides[i]!.visualNeed);
      expect(patched.n).toBe(copy.slides[i]!.n);
    }
  });

  it("applies several corrections in one pass and reports the count", async () => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(
      copy,
      [correction(), correction({ target: "slide:1", field: "kicker", span: "רבעון שלישי", replacement: "הרבעון השלישי", axis: "convention" })],
      hebrewDeps(),
    );
    expect(out.applied).toBe(2);
    expect(out.copy.slides[0]!.kicker).toBe("הרבעון השלישי");
  });

  it("patches the caption", async () => {
    const copy = hebrewCopy({ caption: "יישומון חדש לניהול משימות שינה את קצב העבודה של הצוות ברבעון האחרון." });
    const out = await applyNativeCorrections(
      copy,
      [correction({ target: "caption", field: "caption", span: "יישומון", replacement: "אפליקציה", axis: "terminology" })],
      hebrewDeps(),
    );
    expect(out.applied).toBe(1);
    expect(out.copy.caption.startsWith("אפליקציה חדש")).toBe(true);
  });

  it("patches a device label", async () => {
    const copy = hebrewCopy({
      slides: [
        slide(1, {
          device: {
            kind: "bars",
            rows: [
              { label: "יישומון התמיכה", value: 30, display: "30%" },
              { label: "צוות המכירות", value: 18, display: "18%" },
            ],
            source: "internal survey",
          },
        }),
      ],
    });
    const out = await applyNativeCorrections(
      copy,
      [correction({ target: "slide:1", field: "device", span: "יישומון", replacement: "אפליקציית", axis: "terminology" })],
      hebrewDeps(),
    );
    expect(out.applied).toBe(1);
    const device = out.copy.slides[0]!.device;
    expect(device?.kind === "bars" && device.rows[0]!.label).toBe("אפליקציית התמיכה");
    // The numerals a device carries are not language and are never rewritten.
    expect(device?.kind === "bars" && device.rows[0]!.display).toBe("30%");
  });
});

/**
 * The judge now READS the archetype copy blocks, so the patcher has to be
 * able to WRITE them in the same commit. Widening the gate alone would
 * produce corrections that are always dropped — and would inflate the
 * proposed-vs-applied gap the deliverable reports, which is the number a
 * reviewer uses to decide whether the judge is working.
 */
describe("applyNativeCorrections — the archetype copy blocks", () => {
  const quoteSlide = (): InstagramSlideCopy =>
    slide(2, { layout: "quote_card", quote: { text: "בסוף היום, בנינו את הכל מחדש סביב מודל אחד.", attribution: "מנכ״לית אקמה" } });

  it("patches a pull-quote — the only prose a quote card renders", async () => {
    const copy = hebrewCopy({ slides: [slide(1), quoteSlide(), slide(3)] });
    const out = await applyNativeCorrections(copy, [correction({ field: "archetype" })], hebrewDeps());
    expect(out.applied).toBe(1);
    expect(out.dropped).toBe(0);
    expect(out.copy.slides[1]!.quote!.text).toBe("בסופו של דבר, בנינו את הכל מחדש סביב מודל אחד.");
    // The attribution and everything else are byte-identical.
    expect(out.copy.slides[1]!.quote!.attribution).toBe("מנכ״לית אקמה");
  });

  it("patches a comparison column and a list row", async () => {
    const copy = hebrewCopy({
      slides: [
        slide(1, { layout: "comparison_card", comparison: { leftLabel: "לפני", leftBody: "בסוף היום שלושה ימים", rightLabel: "אחרי", rightBody: "ארבע שעות" } }),
        slide(2, { layout: "list_takeaway", items: [{ title: "מדדו את הזמן", note: "בואו נצלול לנתונים" }, { title: "בחרו מודל" }] }),
      ],
    });
    const out = await applyNativeCorrections(
      copy,
      [
        correction({ target: "slide:1", field: "archetype", span: "בסוף היום", replacement: "בסופו של דבר" }),
        correction({ target: "slide:2", field: "archetype", span: "בואו נצלול", replacement: "נתחיל" }),
      ],
      hebrewDeps(),
    );
    expect(out.applied).toBe(2);
    expect(out.copy.slides[0]!.comparison!.leftBody).toBe("בסופו של דבר שלושה ימים");
    expect(out.copy.slides[1]!.items![0]!.note).toBe("נתחיל לנתונים");
  });

  it("drops an archetype correction whose span appears in TWO of the block's slots", async () => {
    // Rule 2 applies ACROSS the block's slots, exactly as it does across a
    // device's labels: two candidate slots is as ambiguous as two hits in one.
    const copy = hebrewCopy({
      slides: [slide(1, { layout: "comparison_card", comparison: { leftLabel: "בסוף היום", leftBody: "שלושה ימים", rightLabel: "בסוף היום", rightBody: "ארבע שעות" } })],
    });
    const out = await applyNativeCorrections(copy, [correction({ target: "slide:1", field: "archetype" })], hebrewDeps());
    expect(out.applied).toBe(0);
    expect(out.drops[0]!.reason).toMatch(/appears in 2 of slide 1's archetype copy fields/);
    expect(out.copy).toEqual(copy);
  });

  it("drops an archetype correction on a slide that has no archetype block at all", async () => {
    const out = await applyNativeCorrections(hebrewCopy(), [correction({ target: "slide:2", field: "archetype" })], hebrewDeps());
    expect(out.applied).toBe(0);
    expect(out.drops[0]!.reason).toMatch(/has no archetype copy block/);
  });

  it("cannot reach a stat's figure or its source — a language correction never changes a number or a claim", async () => {
    const copy = hebrewCopy({ slides: [slide(1, { layout: "stat_callout", stat: { figure: "47%", subLabel: "מהצוותים עברו", source: "Reuters, 2026" } })] });
    for (const span of ["47%", "Reuters, 2026"]) {
      const out = await applyNativeCorrections(copy, [correction({ target: "slide:1", field: "archetype", span, replacement: "שונה" })], hebrewDeps());
      expect(out.applied, span).toBe(0);
      expect(out.copy.slides[0]!.stat, span).toEqual(copy.slides[0]!.stat);
    }
    // …but the sub-label, which IS prose, is reachable.
    const ok = await applyNativeCorrections(
      copy,
      [correction({ target: "slide:1", field: "archetype", span: "מהצוותים עברו", replacement: "מהצוותים כבר עברו" })],
      hebrewDeps(),
    );
    expect(ok.applied).toBe(1);
    expect(ok.copy.slides[0]!.stat!.subLabel).toBe("מהצוותים כבר עברו");
  });
});

describe("applyNativeCorrections — rule 2: the span must occur EXACTLY ONCE", () => {
  it("drops a span that occurs TWICE and leaves the copy byte-identical", async () => {
    const copy = hebrewCopy({
      slides: [slide(1, { body: "בסוף היום הצוות סגר יותר פניות, ובסוף היום זה מה שנמדד ברבעון הזה כולו." })],
    });
    const out = await applyNativeCorrections(copy, [correction({ target: "slide:1" })], hebrewDeps());

    expect(out.applied).toBe(0);
    expect(out.dropped).toBe(1);
    expect(out.copy).toEqual(copy);
    expect(out.drops[0]!.reason).toContain("appears 2 times");
  });

  it("drops a span the judge paraphrased instead of quoting", async () => {
    const out = await applyNativeCorrections(hebrewCopy(), [correction({ span: "בסופו של יום" })], hebrewDeps());
    expect(out.applied).toBe(0);
    expect(out.drops[0]!.reason).toContain("does not appear");
  });

  it("drops a device correction whose span appears in two labels at once", async () => {
    const copy = hebrewCopy({
      slides: [
        slide(1, {
          device: {
            kind: "versus",
            left: { label: "יישומון הצוות", body: "מה שהיה קודם" },
            right: { label: "יישומון הלקוח", body: "מה שיש עכשיו" },
            winner: "right",
          },
        }),
      ],
    });
    const out = await applyNativeCorrections(copy, [correction({ target: "slide:1", field: "device", span: "יישומון", replacement: "אפליקציית" })], hebrewDeps());
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
    expect(out.drops[0]!.reason).toContain("2 of slide 1's device labels");
  });
});

describe("applyNativeCorrections — rule 3: schema caps", () => {
  it("drops a replacement that pushes a kicker past its 48-character cap", async () => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(
      copy,
      [
        correction({
          target: "slide:1",
          field: "kicker",
          span: "רבעון שלישי",
          // 60 characters of perfectly good Hebrew, which the kicker schema
          // still refuses — and which would cost the whole attempt if it were
          // discovered at the next parse instead of here.
          replacement: "הרבעון השלישי של השנה הנוכחית לפי הדוח הפנימי של החברה כולה",
          axis: "register",
        }),
      ],
      hebrewDeps(),
    );
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
    expect(out.drops[0]!.reason).toContain("48-character schema cap");
  });

  it("drops a device-label replacement past ITS cap, which is not the kicker's", async () => {
    const copy = hebrewCopy({
      slides: [
        slide(1, {
          device: { kind: "figure", value: "30%", label: "יישומון", source: "internal survey" },
        }),
      ],
    });
    const out = await applyNativeCorrections(
      copy,
      [correction({ target: "slide:1", field: "device", span: "יישומון", replacement: "א".repeat(90), axis: "terminology" })],
      hebrewDeps(),
    );
    expect(out.applied).toBe(0);
    expect(out.drops[0]!.reason).toContain("80-character schema cap");
  });
});

describe("applyNativeCorrections — the replacement must stay in the client's script", () => {
  it("drops a replacement that rewrites a Hebrew field into Latin", async () => {
    // A Latin PRODUCT NAME inside a Hebrew sentence is normal and survives
    // this check (the next case). A Latin SENTENCE replacing the Hebrew one is
    // the judge proposing the defect the gate exists to catch.
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(
      copy,
      [
        correction({
          span: "בסוף היום, הצוות סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך החדש.",
          replacement: "At the end of the day the support team closed thirty percent more tickets.",
        }),
      ],
      hebrewDeps(),
    );
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
    expect(out.drops[0]!.reason).toContain("outside the client's script");
  });

  it("KEEPS a Latin product name inside an otherwise Hebrew field", async () => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(
      copy,
      [correction({ span: "בסוף היום", replacement: "אחרי המעבר ל Gemini 3" })],
      hebrewDeps(),
    );
    expect(out.applied).toBe(1);
    expect(out.copy.slides[1]!.body).toContain("Gemini 3");
  });
});

describe("applyNativeCorrections — rule 1: the target must resolve", () => {
  const cases: Array<[string, NativeCorrection, string]> = [
    ["a slide that does not exist", correction({ target: "slide:8" }), "slide 8 does not exist"],
    ["a kicker on a slide that has none", correction({ target: "slide:2", field: "kicker", span: "בסוף היום" }), "has no kicker"],
    ["a device on a slide that has none", correction({ target: "slide:2", field: "device" }), "has no device"],
    ["a custom field with no key", correction({ target: "slide:2", field: "custom" }), "named no customKey"],
    ["a custom field the archetype does not declare", correction({ target: "slide:2", field: "custom", customKey: "leftLabel" }), 'has no custom field "leftLabel"'],
    ["layout metadata dressed as a custom field", correction({ target: "slide:2", field: "custom", customKey: "dir" }), "is layout metadata, not prose"],
    ["a caption correction aimed at a slide field", correction({ target: "caption", field: "body" }), 'named the field "body"'],
    ["a slide correction aimed at the caption field", correction({ target: "slide:2", field: "caption" }), 'named the field "caption"'],
  ];

  it.each(cases)("drops %s", async (_label, bad, reason) => {
    const copy = hebrewCopy();
    const out = await applyNativeCorrections(copy, [bad], hebrewDeps());
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
    expect(out.drops[0]!.reason).toContain(reason);
  });
});

describe("applyNativeCorrections — the free checks run again, on the state that ships", () => {
  it("discards THE WHOLE PATCH when a correction smuggles an em dash past gate.lintPost", async () => {
    // `07b` ran before these corrections existed. A proposal carrying an em
    // dash would otherwise ship through a gate that said yes to different text.
    const copy = hebrewCopy();
    const clean = correction({ target: "slide:3", field: "headline", span: "ממצא מספר 3", replacement: "הממצא השלישי", axis: "register" });
    const dashed = correction({ span: "בסוף היום", replacement: "בסופו של דבר — וזה העיקר" });

    const out = await applyNativeCorrections(copy, [clean, dashed], hebrewDeps());

    expect(out.discardReason).toContain("craft-hygiene");
    expect(out.applied).toBe(0);
    expect(out.dropped).toBe(2);
    // The clean correction is thrown away with it: the re-check reads the
    // assembled copy, not one field, so it cannot say which one broke it, and
    // a patcher that guessed would be back to the ambiguity problem.
    expect(out.copy).toEqual(copy);
  });

  it("discards the whole patch when short Latin replacements together take the post below the script floor", async () => {
    // Each patched field is under `MIN_LETTERS_TO_JUDGE`, so the PER-FIELD
    // script check has no opinion on any of them individually. Together they
    // are the English carousel the gate exists to stop. This is the case the
    // aggregate re-check is for, and it is why the aggregate check is not
    // redundant with the per-field one.
    const short = (n: number): InstagramSlideCopy => slide(n, { headline: "ממצא", body: `שורה מספר ${n}` });
    const bodies = ["The team ships", "The group works", "The build runs", "The queue drains", "The docs land", "The tests pass", "The page loads", "The job ends"];
    const copy = hebrewCopy({ caption: "מבט קצר", slides: bodies.map((_, i) => short(i + 1)) });
    const corrections = bodies.map((replacement, i) =>
      correction({ target: `slide:${i + 1}`, field: "body", span: `שורה מספר ${i + 1}`, replacement, axis: "terminology" }),
    );

    const out = await applyNativeCorrections(copy, corrections, hebrewDeps());

    expect(out.discardReason).toContain("script gate");
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
  });

  it("does not run the free checks at all when nothing applied", async () => {
    // Nothing changed, so the copy already approved is the copy returned —
    // and a hygiene check that threw would be a tooling failure charged to a
    // patch that never happened.
    const copy = hebrewCopy();
    const deps: NativeCorrectionDeps = {
      language: "Hebrew",
      checkHygiene: () => {
        throw new Error("the free re-check must not run when no correction applied");
      },
    };
    const out = await applyNativeCorrections(copy, [correction({ span: "not in the text at all" })], deps);
    expect(out.applied).toBe(0);
    expect(out.copy).toEqual(copy);
  });

  it("records every correction, applied or dropped, with its reason", async () => {
    const copy = hebrewCopy();
    const good = correction();
    const bad = correction({ target: "slide:8" });
    const out = await applyNativeCorrections(copy, [good, bad], hebrewDeps());

    expect(out.appliedCorrections).toEqual([good]);
    expect(out.drops).toHaveLength(1);
    expect(out.drops[0]!.correction).toEqual(bad);
    expect(out.drops[0]!.reason.length).toBeGreaterThan(10);
  });
});
