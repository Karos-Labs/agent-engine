import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { FSI, PDI, isolateForeignRuns, stripIsolates } from "../src/workflow/bidi-isolate.js";
import { checkExpectedScript, languageGateFields, languageGateText } from "../src/workflow/language-gate.js";
import { buildScriptFontHeadForLanguage } from "../src/workflow/script-fonts.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import { LAYOUT_FIELD_KEYS } from "../src/workflow/visual-qa-pre-checks.js";
import { buildStudioSampleContent, studioSampleSeedFromBrief } from "../src/workflow/template-studio.js";
import { bcp47For } from "../src/workflow/target-language.js";
import type { ImageSelection, InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";
import { goodClientBrief, isChromiumInstalled } from "./test-helpers.js";

/** The same minimal kit `template-studio.test.ts` uses; the studio seed only reads its tokens. */
const STUDIO_KIT = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC", "--accent": "#C8FF4D" }, palette: ["#C8FF4D"] };
import { syntheticPhotograph } from "./synthetic-photograph.js";

/**
 * Phase 4, RFC-15 §7.3 — bidi isolates for Latin runs embedded in Hebrew.
 *
 * Two claims, and both of them have a real other side:
 *
 *  1. Every RENDERED slide string of an RTL carousel carries the isolates.
 *  2. NOTHING a gate reads, and nothing that is published as text, carries
 *     them — because the isolates are composed on the way into the document
 *     and the copy object itself is never touched.
 *
 * Claim 2 is the one that matters for correctness and the one this file is
 * built around: an invisible U+2068 in Instagram's caption field, in the
 * dedupe corpus, in `checkCraftHygiene`'s banned-word scan or in the native
 * judge's input would each be a different kind of silent damage.
 */

const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 };
const ISOLATE = /[⁨⁩]/u;

/** A Hebrew carousel with a Latin term, an acronym, a percentage and a year range in every field shape the archetypes read. */
function hebrewCopy(): InstagramCopyOutput {
  const slides: InstagramSlideCopy[] = [
    {
      n: 1,
      headline: "גוגל השיקה את Gemini 3 לכל המפתחים",
      body: "הדיפלוי של API v2 ירד ב-38% בין 2020-2024.",
      kicker: "חדשות AI",
      visualNeed: "a developer at a laptop",
      sourceRef: "claim 1",
      layout: "cover",
      device: { kind: "figure", value: "38%", label: "ירידה בזמן הדיפלוי של API v2", source: "internal data, 2026" },
    },
    {
      n: 2,
      headline: "מה זה אומר על SaaS ישראלי",
      body: "שלוש מסקנות על api.stripe.com ועל gpt-4o.",
      visualNeed: "a chart",
      sourceRef: "claim 2",
      layout: "stat_callout",
      stat: { figure: "47%", subLabel: "מהצוותים עברו ל-GPT-4", source: "S&P 500 survey, 2026" },
    },
    {
      n: 3,
      headline: "השוואה",
      body: "לפני ואחרי המעבר.",
      visualNeed: "a split",
      sourceRef: "claim 3",
      layout: "comparison_card",
      comparison: { leftLabel: "לפני GPT-4", leftBody: "שלושה ימים לכל דיפלוי", rightLabel: "אחרי GPT-4", rightBody: "ארבע שעות בממוצע" },
    },
    {
      n: 4,
      headline: "ציטוט",
      body: "מתוך הראיון.",
      visualNeed: "a portrait",
      sourceRef: "claim 4",
      layout: "quote_card",
      quote: { text: "בנינו את הכל מחדש סביב LLM אחד.", attribution: "מנכ״לית Acme Labs" },
    },
    {
      n: 5,
      headline: "שלוש נקודות",
      body: "מה שלמדנו.",
      visualNeed: "a list",
      sourceRef: "claim 5",
      layout: "list_takeaway",
      items: [
        { title: "מדדו את זמן הדיפלוי", note: "עם API v2" },
        { title: "בחרו מודל אחד", note: "gpt-4o לרוב המקרים" },
        { title: "כתבו הכל מחדש", note: "בין 2020-2024" },
      ],
    },
  ];
  return { format: "carousel", caption: "הפוסט המלא על Gemini 3 ועל API v2, כולל 38% ו-2020-2024.", slides };
}

function selectionsFor(copy: InstagramCopyOutput): ImageSelection[] {
  return copy.slides.map((s) => ({
    n: s.n,
    imagePath: `photos/n${s.n}.jpg`,
    reason: "matches",
    license: "CC0",
    rightsUsable: true,
    watermarkFree: true,
    claimMatch: 5,
    claimMatchReason: "shows the claimed subject",
  }));
}

function assemble(copy: InstagramCopyOutput, extra: { bcp47?: string } = {}): ReturnType<typeof assembleSlidesData> {
  return assembleSlidesData({
    clientSlug: "geektime",
    postId: "post_1",
    repoRoot: "/repo",
    brandTokens: { templateDir: "assets/templates/default", slideTemplate: "slide.html" },
    copy,
    selections: selectionsFor(copy),
    canvas: CANVAS,
    availableTemplates: new Set(["slide.html", "cover.html", "closer.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html", "headline-focus.html"]),
    targetLanguage: "Hebrew",
    ...extra,
  });
}

/** Every string a rendered slide carries: the escaped fields plus the raw html fragments. */
function renderedStrings(data: ReturnType<typeof assembleSlidesData>): string[] {
  return data.slides.flatMap((slide) => [...Object.values(slide.fields ?? {}), ...Object.values(slide.htmlFragments ?? {})]);
}

describe("isolateForeignRuns: which runs are wrapped, and which are deliberately not", () => {
  it("is a NO-OP for an ltr carousel — an English post gains no invisible characters at all", () => {
    const text = "Gemini 3 shipped, and api.stripe.com went to 99.9% uptime in 2020-2024.";
    expect(isolateForeignRuns(text, "ltr")).toBe(text);
    expect(isolateForeignRuns("גוגל השיקה את Gemini 3.", "ltr")).toBe("גוגל השיקה את Gemini 3.");
  });

  it("wraps a Latin run in FSI…PDI and leaves the Hebrew around it byte-identical", () => {
    expect(isolateForeignRuns("גוגל השיקה את Gemini", "rtl")).toBe(`גוגל השיקה את ${FSI}Gemini${PDI}`);
  });

  it("leaves the sentence's full stop OUTSIDE the isolate — the whole point, since that is the character that lands on the wrong side", () => {
    const out = isolateForeignRuns("גוגל השיקה את Gemini.", "rtl");
    expect(out).toBe(`גוגל השיקה את ${FSI}Gemini${PDI}.`);
    expect(out.endsWith(".")).toBe(true);
  });

  it("keeps a joined technical token as ONE unit — splitting it would reorder its own pieces", () => {
    for (const token of ["gpt-4o", "api.stripe.com", "50%", "GPT-4", "B2B", "iOS", "S&P"]) {
      expect(isolateForeignRuns(`הצוות בחר ${token} השנה`, "rtl"), token).toContain(`${FSI}${token}${PDI}`);
    }
  });

  /**
   * THE REGRESSION PIN. A run of Latin/digit tokens separated by spaces gets
   * ONE isolate, never one per token.
   *
   * Per-token isolation is not a smaller version of the fix, it is strictly
   * worse than doing nothing: UAX#9 rule X6a makes each FSI…PDI opaque to the
   * surrounding isolating run sequence, so `⁨API⁩ ⁨v2⁩` between two Hebrew
   * runs is three neutrals, N1 resolves them all to R, and L2 displays
   * `v2 API`. Every phrase below renders CORRECTLY with no isolation at all
   * and reversed under per-token isolation, so this assertion is the whole
   * reason `foreignRunPattern` admits a single inner space.
   *
   * Break it by restoring the token-only pattern
   * (`/[A-Za-z0-9][A-Za-z0-9.@/&+#'’_-]*[A-Za-z0-9%]|[A-Za-z0-9]{2,}/g`) and
   * every one of these fails.
   */
  it("gives a multi-token Latin phrase ONE isolate, not one per token", () => {
    for (const phrase of ["API v2", "Gemini 3", "iPhone 17 Pro Max", "S&P 500"]) {
      const out = isolateForeignRuns(`הדיפלוי של ${phrase} ירד`, "rtl");
      expect(out, phrase).toBe(`הדיפלוי של ${FSI}${phrase}${PDI} ירד`);
      // Exactly one isolate opened and one closed — the per-token bug shows up
      // here as a count, whatever the phrase happens to be.
      expect((out.match(/⁨/gu) ?? []).length, phrase).toBe(1);
      expect((out.match(/⁩/gu) ?? []).length, phrase).toBe(1);
    }
  });

  it("absorbs a single-character token INSIDE a run, while still leaving a standalone one bare", () => {
    // `3` is absorbed: it is part of the phrase and must not be left at the
    // paragraph level beside an isolate.
    expect(isolateForeignRuns("גוגל השיקה את Gemini 3 היום", "rtl")).toBe(`גוגל השיקה את ${FSI}Gemini 3${PDI} היום`);
    // The same `3` standing alone between Hebrew words is still left bare.
    expect(isolateForeignRuns("גרסה 3 שוחררה", "rtl")).toBe("גרסה 3 שוחררה");
  });

  it("leaves a lone Latin letter and a lone digit alone — nothing to reorder, and wrapping them doubles a numeral-heavy line for nothing", () => {
    expect(isolateForeignRuns("דירוג a בלבד", "rtl")).toBe("דירוג a בלבד");
    expect(isolateForeignRuns("רק 5 מהם", "rtl")).toBe("רק 5 מהם");
    // …but a two-character run IS wrapped, which is the other side of that rule.
    expect(isolateForeignRuns("רק 50 מהם", "rtl")).toBe(`רק ${FSI}50${PDI} מהם`);
  });

  it("leaves pure Hebrew byte-identical — no Latin run, no change", () => {
    const hebrew = "שלושה ממצאים מסקר המנהלים החדש, ומה הם אומרים על השנה הקרובה.";
    expect(isolateForeignRuns(hebrew, "rtl")).toBe(hebrew);
  });

  it("stripIsolates is its inverse on the characters it inserts", () => {
    const text = "הדיפלוי של API v2 ירד ב-38% בין 2020-2024.";
    expect(stripIsolates(isolateForeignRuns(text, "rtl"))).toBe(text);
  });

  /**
   * CASE (g). The isolates are `\p{Cf}` format characters, not `\p{L}`, so
   * `checkExpectedScript` counts exactly the same letters with them present
   * as without. That is the property that lets this run on composed slide
   * text while every gate keeps its own numbers — if it ever stopped holding,
   * a Hebrew carousel's measured script ratio would drift for a reason that
   * has nothing to do with its language.
   */
  it("does not move checkExpectedScript's ratio by a single letter", () => {
    const raw = "גוגל השיקה את Gemini 3 ואת API v2 בשנת 2026 למפתחים בישראל ובעולם כולו היום";
    const isolated = isolateForeignRuns(raw, "rtl");
    expect(isolated).not.toBe(raw);
    expect((isolated.match(/\p{L}/gu) ?? []).length).toBe((raw.match(/\p{L}/gu) ?? []).length);
    expect(checkExpectedScript(isolated, "Hebrew")).toEqual(checkExpectedScript(raw, "Hebrew"));
  });
});

describe("assembleSlidesData: the isolates reach rendered slide text and NOTHING else", () => {
  /** CASE (d). */
  it("isolates every rendered prose field of an RTL carousel — headline, body, kicker, stat sub-label and source, quote, comparison, list rows, device labels", () => {
    const data = assemble(hebrewCopy());
    const byN = new Map(data.slides.map((s) => [s.n, s]));

    const cover = byN.get(1)!;
    // `Gemini 3` and `API v2` are ONE isolate each, not two — see the
    // regression pin above.
    expect(cover.fields!["title"]).toContain(`${FSI}Gemini 3${PDI}`);
    expect(cover.fields!["subtitle"]).toContain(`${FSI}API v2${PDI}`);
    expect(cover.fields!["eyebrow"]).toContain(`${FSI}AI${PDI}`);
    expect(cover.fields!["kicker"]).toContain(`${FSI}AI${PDI}`);
    // The device fragment is raw markup, and its LABEL is rendered text.
    expect(cover.htmlFragments!["device"]).toContain(`${FSI}API v2${PDI}`);

    const stat = byN.get(2)!;
    expect(stat.fields!["subLabel"]).toContain(`${FSI}GPT-4${PDI}`);
    expect(stat.fields!["body"]).toContain(`${FSI}api.stripe.com${PDI}`);
    expect(stat.fields!["body"]).toContain(`${FSI}gpt-4o${PDI}`);
    expect(stat.fields!["sourceLine"]).toContain(`${FSI}S&P 500 survey${PDI}`);

    const comparison = byN.get(3)!;
    expect(comparison.fields!["leftLabel"]).toContain(`${FSI}GPT-4${PDI}`);
    expect(comparison.fields!["rightLabel"]).toContain(`${FSI}GPT-4${PDI}`);

    const quote = byN.get(4)!;
    expect(quote.fields!["quoteText"]).toContain(`${FSI}LLM${PDI}`);
    expect(quote.fields!["attribution"]).toContain(`${FSI}Acme Labs${PDI}`);

    const list = byN.get(5)!;
    expect(list.htmlFragments!["itemRows"]).toContain(`${FSI}API v2${PDI}`);
    expect(list.htmlFragments!["itemRows"]).toContain(`${FSI}gpt-4o${PDI}`);
    expect(list.htmlFragments!["itemRows"]).toContain(`${FSI}2020-2024${PDI}`);
  });

  it("an LTR carousel's rendered strings are byte-identical to the copy — the English regression pin", () => {
    const copy = hebrewCopy();
    const english: InstagramCopyOutput = {
      ...copy,
      caption: "The whole post about Gemini 3 and API v2.",
      slides: copy.slides.map((s) => ({ ...s, headline: `Headline ${s.n} about Gemini 3`, body: `Body ${s.n} with api.stripe.com and 38%.` })),
    };
    for (const value of renderedStrings(assemble(english))) {
      expect(value, value).not.toMatch(ISOLATE);
    }
  });

  /**
   * CASE (f). A figure is a bare numeral inside a `line-height: 0.95` lockup
   * — a designed relationship, and the same reason `.num-figure` is excluded
   * from `DISPLAY_SELECTORS`. `deviceFigures` is worse than cosmetic: it is
   * LAYOUT metadata that `default:numbers-are-devices` matches against the
   * copy, and a control character in it would silently stop that rule firing.
   */
  it("never wraps stat.figure, the device's own figures, or any layout field", () => {
    const data = assemble(hebrewCopy());
    const stat = data.slides.find((s) => s.n === 2)!;
    expect(stat.fields!["figure"]).toBe("47%");

    for (const slide of data.slides) {
      for (const [key, value] of Object.entries(slide.fields ?? {})) {
        if (!LAYOUT_FIELD_KEYS.has(key)) continue;
        expect(value, `layout field ${key} carries a bidi control character`).not.toMatch(ISOLATE);
      }
    }
    const cover = data.slides.find((s) => s.n === 1)!;
    expect(cover.fields!["deviceFigures"]).toBe("38%");
  });

  /**
   * CASE (e), and the reason this whole mechanism is safe: the isolates are
   * composed ON THE WAY INTO THE DOCUMENT and the copy object is never
   * touched, so `checkCraftHygiene`, `07d`'s dedupe corpus, the native
   * judge's fields, `sourceRef` and the published caption all still read the
   * model's own bytes.
   *
   * BREAK-THE-CODE PROOF: apply `isolateForeignRuns` to the caption (or to
   * any field of `copy` in place) and this test fires on the first assertion
   * it reaches.
   */
  it("leaves the copy object untouched, so no gate and no published string ever sees a control character", () => {
    const copy = hebrewCopy();
    const pristine = structuredClone(copy);
    const data = assemble(copy);

    // The composed document DID change — otherwise the rest of this proves nothing.
    expect(renderedStrings(data).some((v) => ISOLATE.test(v))).toBe(true);

    expect(copy).toEqual(pristine);
    expect(copy.caption).not.toMatch(ISOLATE);
    expect(languageGateText(copy)).not.toMatch(ISOLATE);
    for (const field of languageGateFields(copy)) {
      expect(field.text, field.id).not.toMatch(ISOLATE);
    }
    for (const slide of copy.slides) {
      expect(slide.sourceRef).not.toMatch(ISOLATE);
      // `07d`'s dedupe corpus and `checkCraftHygiene`'s input are both built
      // out of exactly these strings, in the workflow, from this same object.
      expect(`${slide.headline} ${slide.body}`).not.toMatch(ISOLATE);
    }
  });
});

describe("the {{lang}} slot", () => {
  it("fills the document language from the injected BCP-47 tag", () => {
    const data = assemble(hebrewCopy(), { bcp47: "he" });
    for (const slide of data.slides) expect(slide.fields!["lang"]).toBe("he");
  });

  it("defaults to 'en' — the literal every template carried before this phase, so a caller that knows nothing renders what it rendered before", () => {
    const data = assemble(hebrewCopy());
    for (const slide of data.slides) expect(slide.fields!["lang"]).toBe("en");
  });

  it("is LAYOUT metadata: it is never counted as prose", () => {
    expect(LAYOUT_FIELD_KEYS.has("lang")).toBe(true);
  });

  it("the Template Studio's sample seed carries the tag too, so gate 8 renders Hebrew in a HEBREW document", () => {
    // The seam this closes: `studioSampleSeedFromBrief` accepted a `bcp47` and
    // the workflow passed `targetLanguage` and `dir` but never the tag, so a
    // Hebrew studio sample rendered inside `<html lang="en">`. Gate 8's whole
    // job is to answer "did a Hebrew face actually paint these glyphs", and a
    // document declared English picks Latin fallback — the question would have
    // been answered against the wrong document on the one path meant to prove
    // the fonts work.
    //
    // Asserted through `bcp47For` + `buildStudioSampleContent` rather than by
    // reading the workflow's source, so it is the BEHAVIOUR that is pinned.
    expect(bcp47For("Hebrew")).toBe("he");
    const seed = studioSampleSeedFromBrief({
      brief: goodClientBrief(),
      kit: STUDIO_KIT,
      clientSlug: "geektime",
      targetLanguage: "Hebrew",
      bcp47: bcp47For("Hebrew")!,
      dir: "rtl",
    });
    expect(seed.lang).toBe("he");
    expect(buildStudioSampleContent({ archetypeId: "headline_focus", slots: ["headline", "body"] }, seed).fields["lang"]).toBe("he");

    // And the honest-undefined half: a multi-language script row yields no tag
    // rather than a wrong one, and the seed falls back to "en" exactly as an
    // English client does. A `bcp47For` that guessed "en" for Spanish would
    // pass the line above and still be wrong.
    expect(bcp47For("Spanish")).toBeUndefined();
    const noTag = studioSampleSeedFromBrief({ brief: goodClientBrief(), kit: STUDIO_KIT, clientSlug: "acme", targetLanguage: "Spanish", dir: "ltr" });
    expect(buildStudioSampleContent({ archetypeId: "headline_focus", slots: ["headline", "body"] }, noTag).fields["lang"]).toBe("en");
  });

  it("every bundled template declares the slot rather than a hardcoded lang='en'", async () => {
    const dir = path.resolve(__dirname, "..", "assets", "templates", "default");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const html = await fs.readFile(path.join(dir, file), "utf8");
      expect(html, `${file} still declares lang="en", so a Hebrew document gets Latin font fallback`).toContain('<html lang="{{lang}}" dir="{{dir}}">');
    }
  });
});

/**
 * A real Chromium, same guard every sibling render test uses — this block is
 * SKIPPED on a machine with no Playwright Chromium, and CI is the
 * authoritative gate.
 *
 * What it proves that no string assertion can: the mixed-direction shape this
 * phase introduces, at the design canvas size, through the production script
 * font sheet, does not clip.
 *
 * BREAK-THE-CODE CHECK, run by hand (2026-09-12) and recorded here because it
 * cannot be automated without shipping a broken table: set Hebrew's
 * `lineHeight.display` in `SCRIPT_TYPOGRAPHY` to `0.9` and this case must
 * fail on `probe.overflow`. If it still passes, the FIXTURE is wrong — the
 * canvas size, the hero, or the copy length — and the fixture is what to fix,
 * never the assertion.
 */
describe.skipIf(!isChromiumInstalled())("a mixed Hebrew/Latin cover renders at 1080x1440 without clipping", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("no overflow, real text pixels, a Hebrew face actually used, and lang='he' on the document element", async () => {
    scratch = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-bidi-render-"));
    const templateDir = path.join(scratch, "templates");
    const imageDir = path.join(scratch, "images");
    await fs.mkdir(templateDir, { recursive: true });
    await fs.mkdir(imageDir, { recursive: true });

    // The SHARED fixture, at the design canvas size. A small image upscaled by
    // `object-fit: cover` measures as a flat graphic, not a photograph — see
    // `synthetic-photograph.ts`'s own header for the numbers.
    const heroPath = path.join(imageDir, "hero.png");
    await fs.writeFile(heroPath, syntheticPhotograph(1080, 1440));

    const raw = await fs.readFile(path.resolve(__dirname, "..", "assets", "templates", "default", "cover.html"), "utf8");
    const head = buildScriptFontHeadForLanguage("he", undefined)!;
    await fs.writeFile(path.join(templateDir, "cover.html"), composeRawDocument(raw, head), "utf8");

    const iso = (text: string): string => isolateForeignRuns(text, "rtl");
    const fields: Record<string, string> = {
      lang: "he",
      dir: "rtl",
      accentColor: "#A5E82B",
      fontScale: "m",
      textAlign: "start",
      eyebrow: iso("חדשות AI"),
      title: iso("גוגל השיקה את Gemini 3 לכל המפתחים בישראל"),
      subtitle: iso("הדיפלוי של API v2 (GPT-4) ירד ב-38% בין 2020-2024, והצוות ממשיך למדוד."),
      brandHandle: "@geektime",
      seriesBadge: "מדריך",
    };
    // The isolates are really in the bytes the browser receives; if this ever
    // stopped holding, everything below would be measuring the easy case.
    expect(fields["title"]).toMatch(ISOLATE);

    const outcome = await createRenderCarousel().execute(
      {
        client: "bidi-test",
        postId: "hebrew-mixed",
        templateDir: path.relative(REPO_ROOT, templateDir).split(path.sep).join("/"),
        outDir: path.relative(REPO_ROOT, path.join(scratch, "out")).split(path.sep).join("/"),
        repoRoot: REPO_ROOT,
        slides: [{ n: 1, template: "cover.html", fields, images: { hero: path.relative(REPO_ROOT, heroPath).split(path.sep).join("/") }, htmlFragments: {} }],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
        measure: true,
        probe: true,
      } as never,
      { ctx: { runId: "r", clientSlug: "bidi-test", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );

    // Folded into the asserted value so a CI-only failure names its own cause.
    expect(outcome.status === "success" ? "success" : `${outcome.status}: ${"reason" in outcome ? outcome.reason : "(no reason)"}`).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");

    const first = (outcome.result as unknown as { rendered: Array<Record<string, unknown>> }).rendered[0]!;
    const probe = first["probe"] as { overflow: boolean; overflowing: string[]; fontFamiliesUsed: string[] } | undefined;
    const metrics = first["metrics"] as { textShare: number } | undefined;

    // NOT an early return. `publish.renderCarousel` has carried `measure` and
    // `probe` since 1.1.0 (its own header note), the input above asks for
    // both, and this test is the ONLY body that exercises RFC-15 §11's
    // break-the-code check — `lineHeight.display: 0.9` must fail on
    // `probe.overflow`. It is Chromium-gated and self-skips off CI, so a
    // branch that returns early here would turn the one place the guard ever
    // runs into a green no-op. If the probe is missing, the guard has proven
    // nothing and must say so.
    expect(probe, "publish.renderCarousel returned no probe — this guard proves nothing without it").toBeDefined();
    expect(metrics, "publish.renderCarousel returned no metrics — this guard proves nothing without it").toBeDefined();
    if (probe === undefined || metrics === undefined) throw new Error("unreachable");

    expect(probe.overflow ? probe.overflowing.join(", ") : "").toBe("");
    expect(probe.overflow).toBe(false);
    expect(metrics.textShare).toBeGreaterThan(0);
    expect(probe.fontFamiliesUsed.join(" ")).toMatch(/Heebo|Assistant|Rubik/);

    // `documentElement.lang`: asserted on the bytes the renderer fills, using
    // the same escaped `{{key}}` substitution it performs. The probe reports
    // no attributes, so this is the closest observable to the DOM fact — and
    // the slot, the field and the template are all real.
    const composed = await fs.readFile(path.join(templateDir, "cover.html"), "utf8");
    expect(composed.replace(/\{\{lang\}\}/g, fields["lang"]!)).toContain('<html lang="he" dir="{{dir}}">');
  }, 120_000);
});
