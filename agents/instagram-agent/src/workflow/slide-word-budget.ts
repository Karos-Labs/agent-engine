import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import { LAYOUT_FIELD_KEYS, templateBasename } from "./visual-qa-pre-checks.js";
import type { InstagramCopyOutput } from "./types.js";

/**
 * # THE WORD BUDGET — "short and readable", measured
 *
 * ## The owner's rule, 2026-09-15
 *
 * > *"קצר וקריא: מגבלת מילים של עד 20-30 מילים לשקופית (הפירוט המלא שייך
 * > לקפשן)."*
 * >
 * > Short and readable: a word limit of up to 20-30 words per slide. The full
 * > detail belongs to the caption.
 *
 * ## Why nothing enforced this before
 *
 * The copy prompt has always asked for it in prose — §5, verbatim: *"Keep both
 * tight; a carousel slide is not a paragraph."* No number, and nothing counted.
 * An instruction with no measurement behind it is the shape this repository
 * keeps finding at the bottom of a defect, and this one had a second, worse
 * consequence than long copy.
 *
 * **The system's automatic remedy for too much copy was to make the type
 * smaller.** Three separate mechanisms, all downstream of the writer:
 *
 * 1. `slide.html`'s own fit script steps a heroless headline from 96px to 84px
 *    at 36 characters and to 74px at 66 (`ts-l`: 30 and 56).
 * 2. `interest-relayout.ts`'s ladder answers a `text-wall` or `clipped`
 *    finding by dropping the slide's `fontScale` one step, which multiplies
 *    every size on the plate by 0.85.
 * 3. On a Hebrew run `scriptTypographyFor` multiplies again, so `ts-s` in
 *    Hebrew is `0.85 × 0.94 = 0.799`.
 *
 * Compounded, a 31px body becomes 24.8 design px, and the 19px mono line
 * becomes 15.2. The canvas is 1080 wide and an Instagram feed image is drawn
 * at roughly 400 CSS px on a phone, so that mono line reaches the reader at
 * about **5.6 px**. That is the owner's complaint from the same day, on the
 * same runs: *"הכתב הקטן שלא קריא"* — the small text that is not readable.
 *
 * So the long-copy defect and the tiny-type defect are ONE defect seen at two
 * ends of the pipeline, and shrinking type is the wrong end to fix it at. This
 * module fixes it at the writer's end, where the words are.
 *
 * ## Where the count is taken, and why not on the copy object
 *
 * On the **ASSEMBLED** slides, through the same `proseFieldsOf` filter the
 * two-elements rule uses — never on `copy.slides[].headline`/`body`.
 *
 * That is not a detail. `contentFor` emits a DIFFERENT set of text fields per
 * archetype, and two of them do not render the copy's `headline`/`body` pair
 * at all: a `quote_card` renders `quoteText` + `attribution`, and a
 * `list_takeaway` renders `headline` + its rows and drops `body` on the floor.
 * The schema still REQUIRES a headline and a body on every slide, so a quote
 * card carries copy nobody ever sees. Counting the copy object would charge
 * those slides for words that are not on the plate — which is exactly the bug
 * `default:numbers-are-devices` carries a paragraph about having had
 * ("Read off the fields the slide ACTUALLY RENDERS, not a fixed
 * `headline`/`body` pair... the archetypes moved, the rule did not").
 *
 * A list's rows are the one rendered text that is not in `fields` — they are
 * built into `htmlFragments.itemRows` — so they are read from the paired copy
 * slide's `items`, which is where `checkNoImageMeansDevice` already reads
 * from for the same reason.
 *
 * ## Two numbers, because a reader reads two different things
 *
 * `MAX_WORDS_PER_SLIDE` is the owner's 30 and it governs a slide's
 * STATEMENT — the continuous prose a reader takes in as one sentence or two.
 * `MAX_WORDS_PER_BLOCK` is the owner's 20 and it governs one structured
 * block — a list row, a comparison column. A four-row list is not a wall of
 * text because a reader reads one row at a time; a four-row list with a
 * 25-word row is, and only the second number can tell them apart. Charging a
 * list the SUM would fail every prompt-compliant `list_takeaway` (§7 invites
 * two to four items, each with a supporting note), which is a threshold moved
 * to catch something it was not measuring.
 *
 * ## Why these numbers and not ones that happened to fit
 *
 * RFC-20 §5.7's posture applies: the number is not moved to make something
 * pass. 30 and 20 are the owner's, and the measurements bracket them rather
 * than choosing them:
 *
 * ```
 * canonical good copy (test-helpers GOOD_SLIDE_COPY, 6 slides)   27 - 33 words
 * the two calibration fixtures built to TRIP clause F            62 and 69
 * ```
 *
 * The boundary between copy this system considers exemplary and copy it
 * measures as a wall of text sits between 33 and 62, and 30 sits just inside
 * the good end of it. Four of the six canonical fixtures were 1 to 3 words
 * over when this landed and were trimmed to comply, because a fixture that
 * violates a new rule is the fixture that is wrong.
 *
 * ## It refuses, and that costs nothing
 *
 * A finding here returns to step 05 with **no render spent**, the same road
 * `checkDefaultRenderRules`'s failures take. It is checked UNCONDITIONALLY
 * rather than only when `renderRuleSource === "default"`: a client's own
 * render rules replace the four house layout rules, but "short and readable"
 * is not a layout preference any more than `checkCraftHygiene` is, and that
 * gate is unconditional for the same reason ("outranks client rules").
 *
 * And like every other gate in this workflow it never holds a run: on the
 * final attempt the caller moves the finding to the judge, exactly as it does
 * for a house render rule.
 */

/**
 * A slide's whole statement, in words. The owner's upper bound.
 *
 * His range was 20-30, and the LOW end is deliberately not enforced: a
 * six-word headline over a photograph is a good slide, not an underfilled
 * one, and the thing that refuses an empty plate is the interest floor, which
 * measures pixels rather than counting words. `TARGET_WORDS_PER_SLIDE` below
 * carries the 20 into the steer so the writer is told where to aim, without a
 * gate that would refuse the best slides in the set.
 */
export const MAX_WORDS_PER_SLIDE = 30;

/** The low end of the owner's range. Reported in the steer, never gated — see `MAX_WORDS_PER_SLIDE`. */
export const TARGET_WORDS_PER_SLIDE = 20;

/**
 * One structured block: a list row, a comparison column.
 *
 * The owner's lower number, applied to the unit a reader actually reads in one
 * go.
 */
export const MAX_WORDS_PER_BLOCK = 20;

/**
 * What the whole plate may carry, blocks included.
 *
 * ## The delegation that was tried and did not hold
 *
 * This file used to say, in the comment above: *"a `list_takeaway` with four
 * 20-word rows is 80 words on the plate and passes here; that is intentional
 * and it is the pixel gates' question, not this one's"*, and pointed at clause
 * F's `TEXT_SHARE_CEILING` to refuse a plate that is genuinely a wall.
 *
 * The delegation was reasonable and it did not hold. Slide 4 of the Karos
 * carousel of 2026-09-19 carried a headline and FOUR items each with a two or
 * three line note: about 100 words. Every block was under 20, the statement
 * was under 30, clause F passed it, and the owner read the shipped plate and
 * said what a reader sees: *"there are slides with too much copy for one
 * slide"*, and then, when type size was raised separately, *"a lot of copy on
 * one page is not good either, regardless of small type"*.
 *
 * Text share cannot see this. A hundred words set small covers the same share
 * of the frame as fifty words set large, and the second is a slide while the
 * first is a page.
 *
 * ## Why 60
 *
 * A good three-item list plate is a six-word headline and three rows of a
 * five-word title and a twelve-word note: 57. Four rows of the same is 74 and
 * the shipped plate was 100. 60 admits the first and refuses both others,
 * which is the line the owner drew.
 *
 * It does NOT cap the number of rows, deliberately. Four SHORT rows read
 * perfectly well and come in around 46; the defect is the volume, not the
 * count, and a count rule would refuse the good version of the same plate.
 */
export const MAX_WORDS_PER_SLIDE_TOTAL = 60;

/**
 * Rendered slide fields that are a CITATION or a bare figure rather than prose
 * a reader reads as a sentence.
 *
 * Each one is excluded for the same reason the value gate excludes it
 * (`value-signals.ts`'s own list): `sourceLine` is an attribution the reader
 * scans rather than reads, `figure` is a numeral set at 200px and is one
 * glyph-group however many characters it has, and `attribution` names a
 * speaker. Charging a `stat_callout` for its own source line would push the
 * archetype toward dropping the citation, which is the opposite of what §7
 * requires of it ("a large unattributed number is exactly the kind of claim a
 * reader should distrust").
 */
export const WORD_BUDGET_EXEMPT_FIELDS: ReadonlySet<string> = new Set(["sourceLine", "figure", "attribution", "handle", "seriesBadge"]);

/** Structured rendered fields counted PER BLOCK against `MAX_WORDS_PER_BLOCK`, never summed into the statement. */
const BLOCK_FIELD_PAIRS: ReadonlyArray<readonly [label: string, fields: readonly string[]]> = [
  ["left column", ["leftLabel", "leftBody"]],
  ["right column", ["rightLabel", "rightBody"]],
];

/** One finding. Shaped like `DefaultRenderRuleFailure` so the caller's formatter and its return-to-copy path need no new vocabulary. */
export interface WordBudgetFinding {
  ruleId: string;
  slide: number;
  reason: string;
  /** What was counted and against what, for the ledger — a finding whose numbers a reviewer cannot see is a finding they cannot check. */
  measured: { words: number; limit: number; scope: string };
}

export const WORD_BUDGET_RULE_ID = "default:slide-word-budget";

/**
 * Words in a run of text, script-agnostic.
 *
 * `\p{L}\p{N}`-anchored rather than split on whitespace, so Hebrew counts the
 * same as Latin (both are space-separated), a trailing full stop is not a word,
 * and `30%`, `B2B` and `state-of-the-art` each count once. The `ְ-ׇ`
 * range keeps a pointed Hebrew word whole: nikud are combining marks, which are
 * `\p{M}` and not `\p{L}`, so without it every vowel split a word in two.
 *
 * A `.` or a `,` belongs to the word only when a DIGIT follows it, and that
 * lookahead is the whole of the decimal rule: `4.2x` and `1,200` are one word
 * each because a reader reads one figure, while the comma in `faster, cheaper`
 * still ends its word. Without it `4.2x` counted as two and every slide
 * carrying a decimal was charged for a word nobody reads.
 *
 * Every language this agent publishes in is space-separated; a CJK client would
 * need a character count instead, and there is none.
 */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’ְ-ׇ-]|[.,](?=\d))*/gu) ?? []).length;
}

/** The rows a `list_takeaway` renders, read from the paired copy slide because they live in `htmlFragments`, not `fields`. */
function rowsOf(copySlide: InstagramCopyOutput["slides"][number] | undefined): ReadonlyArray<{ label: string; words: number }> {
  return (copySlide?.items ?? []).map((item, i) => ({
    label: `list row ${i + 1}`,
    words: countWords(`${item.title} ${item.note ?? ""}`),
  }));
}

/**
 * What one assembled slide asks a reader to read: its statement, in words, and
 * its structured blocks, each in words.
 *
 * Exported because a number a gate refuses on is a number the ledger should be
 * able to print, and because the sweep in the test file reads it directly
 * rather than inferring it from the findings.
 */
export function slideWordLoad(
  slide: Slide,
  copySlide?: InstagramCopyOutput["slides"][number],
): { statement: number; blocks: ReadonlyArray<{ label: string; words: number }>; total: number } {
  const entries = Object.entries(slide.fields ?? {}).filter(
    ([key, value]) => !LAYOUT_FIELD_KEYS.has(key) && !WORD_BUDGET_EXEMPT_FIELDS.has(key) && value.trim().length > 0,
  );
  const blockKeys = new Set(BLOCK_FIELD_PAIRS.flatMap(([, fields]) => fields));
  const statement = entries.filter(([key]) => !blockKeys.has(key)).reduce((sum, [, value]) => sum + countWords(value), 0);

  const fieldBlocks = BLOCK_FIELD_PAIRS.map(([label, fields]) => ({
    label,
    words: fields.reduce((sum, key) => sum + countWords(slide.fields?.[key] ?? ""), 0),
  })).filter((b) => b.words > 0);

  const blocks = [...fieldBlocks, ...rowsOf(copySlide)];
  return { statement, blocks, total: statement + blocks.reduce((sum, b) => sum + b.words, 0) };
}

/**
 * Every slide over its budget, with the steer that tells the writer where the
 * words go instead.
 *
 * The remedy in every reason is the owner's own: the full detail belongs to
 * the caption. That is not a throwaway — it is the one remedy that keeps the
 * information in the post, and it is the same one `interest-relayout.ts`
 * already reaches for on a `text-wall` finding ("move the body's last sentence
 * to the caption"). The difference is that this happens before a render is
 * spent and before anything has shrunk the type to fit.
 */
export function checkSlideWordBudget(slidesData: RenderCarouselInput, copy: InstagramCopyOutput): WordBudgetFinding[] {
  const findings: WordBudgetFinding[] = [];
  const byN = new Map(copy.slides.map((s) => [s.n, s]));

  for (const slide of slidesData.slides) {
    const load = slideWordLoad(slide, byN.get(slide.n));
    const where = `slide ${slide.n} ("${templateBasename(slide.template)}")`;

    if (load.statement > MAX_WORDS_PER_SLIDE) {
      findings.push({
        ruleId: WORD_BUDGET_RULE_ID,
        slide: slide.n,
        measured: { words: load.statement, limit: MAX_WORDS_PER_SLIDE, scope: "statement" },
        reason:
          `${where} reads ${load.statement} words, over the ${MAX_WORDS_PER_SLIDE}-word limit — aim for about ${TARGET_WORDS_PER_SLIDE}. ` +
          `Cut it to one claim and its consequence and move the rest of the detail into the caption, which is where the full version belongs. ` +
          `Copy this long is set smaller to fit, and at feed size smaller is unreadable`,
      });
      continue; // one finding per slide is enough to send it back
    }

    // The whole plate, blocks included. See `MAX_WORDS_PER_SLIDE_TOTAL`: every
    // block can be legal and the slide still be a page rather than a slide.
    if (load.total > MAX_WORDS_PER_SLIDE_TOTAL) {
      findings.push({
        ruleId: WORD_BUDGET_RULE_ID,
        slide: slide.n,
        measured: { words: load.total, limit: MAX_WORDS_PER_SLIDE_TOTAL, scope: "slide-total" },
        reason:
          `${where} carries ${load.total} words in total, over the ${MAX_WORDS_PER_SLIDE_TOTAL}-word limit for a whole plate. ` +
          `Each part is short enough on its own; together they are a page. Cut a row, or cut the notes to one line each, ` +
          `and move the detail into the caption. A reader gives a slide a second and a half`,
      });
      continue;
    }

    const over = load.blocks.find((b) => b.words > MAX_WORDS_PER_BLOCK);
    if (over !== undefined) {
      findings.push({
        ruleId: WORD_BUDGET_RULE_ID,
        slide: slide.n,
        measured: { words: over.words, limit: MAX_WORDS_PER_BLOCK, scope: over.label },
        reason:
          `${where}'s ${over.label} reads ${over.words} words, over the ${MAX_WORDS_PER_BLOCK}-word limit for one block — ` +
          `a reader takes a row or a column in at a glance, so each one is a phrase, not a sentence. Shorten it or move the explanation to the caption`,
      });
    }
  }

  return findings;
}

/** The `lastSelfCheckReason` body — one line per finding, so the next draft names every slide that sent it back. */
export function formatWordBudgetFindings(findings: readonly WordBudgetFinding[]): string {
  return findings.map((f) => `${f.ruleId} (slide ${f.slide}): ${f.reason}`).join("; ");
}
