import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COPY_MAX_TOKENS } from "../src/agent/instagram-copy-agent.js";
import { InstagramCopyDraftSchema, MAX_CUSTOM_ARCHETYPE_SLOTS } from "../src/workflow/types.js";
// Phase 5.5 (spec §2 A3) — the three scene-subject ceilings. IMPORTED rather
// than written, so this measurement cannot drift from the clamp that enforces
// them (`normaliseVisualNeed`). See `unboundedByDesign` below.
import { ENTITY_REF_MAX_CHARS, SUBJECT_MUST_SHOW_MAX, SUBJECT_MUST_SHOW_MAX_CHARS, SUBJECT_NOUN_MAX_CHARS } from "../src/workflow/scene-brief.js";

/**
 * ══ THE TEST CI NEVER HAD (Phase 5.5, brief item B / spec §3 B4) ══
 *
 * ## What went wrong, and why no existing test could see it
 *
 * `05-write-copy` declared no `maxTokens`, inherited `DEFAULT_MAX_TOKENS =
 * 16384`, and on 2026-09-16 five of six redraft attempts across three prep runs
 * died at that ceiling mid-JSON. The run then re-judged an EARLIER draft,
 * failed the same gates with the same words, and shipped `degraded`. Every
 * "findings return to the draft" mechanism in this workflow was inert in
 * production for as long as the mechanism has existed.
 *
 * CI never saw it because every fixture returns a short fake output. Nothing
 * anywhere measured what this schema is ALLOWED to produce against what the
 * step is allowed to produce, and until Phase 5.5 nothing could: `headline`,
 * `body`, `sourceRef`, `caption` and every string on the four archetype content
 * blocks were `z.string().min(1)` with no maximum, and `customArchetype.fields`
 * was an uncapped `z.record()`. **The schema's maximum serialised output was
 * infinite.** There was no number to assert. This test and the bounds in
 * `types.ts` ship together because neither is a guard without the other.
 *
 * ## What it asserts, and what each assertion is for
 *
 * 1. **Every leaf of the draft schema is bounded.** `maximiseZod` throws on an
 *    unbounded string, an unbounded array, an uncapped record or a type it does
 *    not know. That is the assertion that catches the NEXT `z.string().min(1)`,
 *    and it catches it at the moment the field is added rather than on a prep
 *    run four weeks later.
 * 2. **The maximal draft fits in 60% of the step's ceiling.** The spec's
 *    contract. Measured in Latin script, deliberately: a Latin measure is a
 *    measure of the SCHEMA and of nothing else, so it moves when and only when
 *    the schema does.
 * 3. **The ceiling clears the worst demand ever measured, with margin.** The
 *    other direction: assertion 2 fails when the schema grows, this one fails
 *    when someone lowers `COPY_MAX_TOKENS` back toward the wall the runs hit.
 *
 * ## WHERE THE 16,384 TOKENS ACTUALLY WENT, which is not where the brief assumed
 *
 * Read off the archived turns of the eight attempts that completed:
 *
 * | run / attempt | out tokens | `thought` chars | `output` chars |
 * |---|---|---|---|
 * | karoslabs 21868183257380937 a1 | 16,305 | 50,520 | 8,109 |
 * | karoslabs 21868183257380937 a2 | 16,120 | 52,159 | 7,721 |
 * | geektime 21868533047825082 a3 | 16,323 | 37,814 | 5,256 |
 * | karoslabs 21850131523417857 a1 | 13,869 | 41,697 | 8,803 |
 *
 * **84% to 88% of the budget is `thought`**, the optional free-text field on
 * `buildTurnSchema`'s bare-final envelope, which is unbounded by construction
 * and is not this schema's to bound. The copy itself is 1,500 to 2,400 tokens.
 * So bounding the schema was never going to be the fix on its own, and the
 * 40% this test leaves unclaimed is not slack: it is the writer's plan, and it
 * is bigger than the copy. Assertion 3 is where that number is actually held.
 */

// ── The token model, MEASURED rather than assumed ────────────────────────────
//
// 45 single-turn model steps across the six prep runs of 2026-09-16, fitted by
// least squares with no intercept over (Latin characters, Hebrew characters) ->
// reported output tokens. Worst relative error 35%, on steps under 600 tokens;
// on the four `05-write-copy` turns above the fit is within 2%.
//
// The two rates are 3.4x apart and that is the whole reason this file does not
// use one divisor. A `.max()` is counted in CHARACTERS and a ceiling is counted
// in TOKENS, and for this agent's non-Latin clients those two units are almost
// three and a half times further apart than they are for its English ones.

/** Characters per output token for Latin script and JSON structure. Measured. */
const LATIN_CHARS_PER_OUTPUT_TOKEN = 3.66;

/** Characters per output token for Hebrew. Measured, and it is about one. */
const HEBREW_CHARS_PER_OUTPUT_TOKEN = 1.08;

/** Hebrew, Yiddish and Judeo-Aramaic: the Unicode block this agent's one non-Latin client publishes in. */
const HEBREW_BLOCK = /[֐-׿]/g;

function estimateOutputTokens(serialised: string): number {
  const hebrew = (serialised.match(HEBREW_BLOCK) ?? []).length;
  const latin = serialised.length - hebrew;
  return Math.round(latin / LATIN_CHARS_PER_OUTPUT_TOKEN + hebrew / HEBREW_CHARS_PER_OUTPUT_TOKEN);
}

/**
 * How the turn reaches the wire: `{"type":"final","thought":…,"output":{…}}`
 * (`BaseAgent.buildTurnSchema`, the `allowedTools: []` branch). `thought` is
 * excluded from the maximal object on purpose and held separately in assertion
 * 3, because it is not part of this schema and cannot be bounded by it.
 */
const serialiseTurn = (output: unknown): string => JSON.stringify({ type: "final", output });

// ── The maximiser ────────────────────────────────────────────────────────────

/**
 * How many characters a serialised JSON number is allowed to be worth.
 *
 * Numbers are the one leaf this walker does not derive from the schema, and
 * saying so is better than pretending. `n`, a device's `value` and a `bars`
 * `max` are all `z.number()` with no upper bound, and bounding them in the
 * schema would refuse a draft over an axis value, which is exactly the kind of
 * trade the `.max()` table in `types.ts` exists to avoid. 12 characters is
 * `-1234567.8901`, and eight numbers a slide at 12 characters is 0.3% of the
 * maximal draft: a number cannot be the field that overruns an output budget.
 */
const NUMBER_SERIALISED_CHARS = 12;

/** A string whose length a regex implies and `.max()` does not state needs one of these, by path, or the walk fails. */
type PatternFiller = (max: number) => string;

interface MaximiseOptions {
  /** The character maximal strings are made of. `"a"` measures the schema; a Hebrew letter measures a Hebrew run. */
  readonly fill: string;
  /** Keyed by dotted path with `[]` for array elements. A record with no entry here is a walk failure, not a guess. */
  readonly recordEntries: Readonly<Record<string, number>>;
  /** Keyed the same way. A `string_format` check with no filler here is a walk failure. */
  readonly patternFillers: Readonly<Record<string, PatternFiller>>;
  /** A character budget for a string this package does not own and cannot bound. One entry, justified at its definition. */
  readonly unboundedByDesign: Readonly<Record<string, number>>;
}

/** zod 4 keeps the shape under `_zod.def`; there is no public introspection API, so this is the one place that reaches for it. */
interface ZodDef {
  type: string;
  checks?: ReadonlyArray<{ _zod: { def: { check?: string; format?: string; maximum?: number; minimum?: number } } }>;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: readonly z.ZodType[];
  entries?: Record<string, string>;
  values?: readonly unknown[];
  keyType?: z.ZodType;
  valueType?: z.ZodType;
}

const defOf = (schema: z.ZodType): ZodDef => (schema as unknown as { _zod: { def: ZodDef } })._zod.def;

const checkValue = (def: ZodDef, check: string, key: "maximum" | "minimum"): number | undefined =>
  def.checks?.find((c) => c._zod.def.check === check)?._zod.def[key];

const hasPatternCheck = (def: ZodDef): boolean => def.checks?.some((c) => c._zod.def.check === "string_format") === true;

/**
 * The largest value this schema permits.
 *
 * **It throws rather than guesses**, and that is the point of it. An unbounded
 * string, an unbounded array, a record with no declared entry count and a zod
 * type it has never met are all failures naming the path, so a future field
 * that cannot be measured fails CI at the moment it is written. The alternative
 * — a hand-written maximal literal — would pass forever while measuring a
 * schema that had moved underneath it, which is the "guard that cannot fail"
 * failure this repo keeps catching.
 */
function maximiseZod(schema: z.ZodType, opts: MaximiseOptions, path = "$"): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      // Maximal means PRESENT: an optional block is one the model may emit.
      return maximiseZod(def.innerType!, opts, path);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(def.shape!)) out[key] = maximiseZod(child, opts, `${path}.${key}`);
      return out;
    }
    case "array": {
      // Same fallback the string branch takes, and the same rule governs it:
      // an entry in `unboundedByDesign` is not an exemption, it is a length
      // this package enforces by CLAMPING rather than by refusing. A path with
      // no `.max()` and no entry is still a walk failure naming the path.
      const max = checkValue(def, "max_length", "maximum") ?? opts.unboundedByDesign[path];
      if (max === undefined) throw new Error(`${path}: array has no .max() — its maximal length cannot be determined`);
      return Array.from({ length: max }, () => maximiseZod(def.element!, opts, `${path}[]`));
    }
    case "string": {
      if (hasPatternCheck(def)) {
        const filler = opts.patternFillers[path];
        if (filler === undefined) throw new Error(`${path}: string is regex-constrained and has no pattern filler`);
        const max = checkValue(def, "max_length", "maximum");
        if (max === undefined) throw new Error(`${path}: regex-constrained string has no .max() — add one, a regex is not a readable bound`);
        return filler(max);
      }
      const max = checkValue(def, "max_length", "maximum") ?? opts.unboundedByDesign[path];
      if (max === undefined) throw new Error(`${path}: string has no .max() — the maximal draft is unbounded`);
      return opts.fill.repeat(max);
    }
    case "number":
      // See NUMBER_SERIALISED_CHARS. A string of digits serialises as a number
      // would; `JSON.stringify` of a real number of this width is the same cost.
      return Number("1".repeat(Math.min(NUMBER_SERIALISED_CHARS, 15)));
    case "boolean":
      return false;
    case "enum":
      return Object.keys(def.entries!).reduce((a, b) => (b.length > a.length ? b : a));
    case "literal":
      return def.values![0];
    case "union": {
      // Both plain and discriminated unions report `type: "union"`. The maximal
      // branch is whichever serialises longest, measured rather than assumed:
      // `visualNeed`'s legacy bare-string branch and its object branch are not
      // orderable by inspection.
      const built = def.options!.map((opt, i) => maximiseZod(opt, opts, `${path}|${i}`));
      return built.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    }
    case "record": {
      const entries = opts.recordEntries[path];
      if (entries === undefined) throw new Error(`${path}: record has no declared entry count — a .refine() cap is not machine readable`);
      const out: Record<string, unknown> = {};
      const keyMax = checkValue(defOf(def.keyType!), "max_length", "maximum");
      if (keyMax === undefined) throw new Error(`${path}: record key has no .max()`);
      for (let i = 0; i < entries; i++) {
        // Distinct keys at the key type's own maximum: a record's keys are on
        // the wire too, and they are the half a `.max()` on the value misses.
        out[`${String(i).padStart(2, "0")}${"k".repeat(keyMax - 2)}`] = maximiseZod(def.valueType!, opts, `${path}{}`);
      }
      return out;
    }
    default:
      throw new Error(`${path}: maximiseZod does not know zod type "${def.type}" — teach it, do not skip it`);
  }
}

/**
 * The two regex-constrained strings in the draft schema, and the ONE record.
 *
 * Both fillers produce a value the regex actually accepts, so the maximal draft
 * can be re-parsed against the schema it came from. A maximiser whose output
 * does not parse is measuring something other than the schema.
 */
const COPY_DRAFT_OPTIONS = {
  /**
   * FOUR entries, and every one of them is a string whose ceiling is REAL,
   * EXPORTED and ENFORCED — just not by a `.max()` on the wire. This is not an
   * exemption list; it is the list of fields whose bound is a clamp instead of
   * a refusal, and each entry names the constant that clamps it.
   *
   * ## Why `visualNeed`'s legacy branch is here
   *
   * `visualNeed` is `z.union([z.string().min(1), SlideVisualNeedSchema])`
   * (`scene-brief.ts`), and the bare-string branch is the pre-Phase-3 form that
   * ~30 fixtures, every in-flight checkpoint and a model that regresses
   * mid-run still write. 240 is `SlideVisualNeedSchema.scene`'s own cap, which
   * is what the legacy string WAS: a scene in one sentence, before the field
   * split into keys. Any other number would be invented.
   *
   * ## Why `subject`'s three strings are here (Phase 5.5, spec §2 A3)
   *
   * **A `max()` on a model output is a coin flip that loses the whole step.**
   * `visualNeed` lives INSIDE `InstagramSlideCopySchema`, so a violated `max()`
   * there does not cost a field — it fails the parse of an eight-slide draft
   * that cost ~$0.31 and burns an attempt, and the union cannot save it because
   * an object that failed the object branch does not match the string branch
   * either. That is exactly how `altText.max(125)` cost two of three live runs
   * their hashtags on 2026-09-16, and how `formatLabel.max(80)` cost a whole
   * client its template set.
   *
   * So the ceiling is kept and the coin flip is not: the numbers below ARE
   * `SUBJECT_NOUN_MAX_CHARS`, `ENTITY_REF_MAX_CHARS` and
   * `SUBJECT_MUST_SHOW_MAX_CHARS`, imported rather than written, the prompt
   * states them, and `normaliseVisualNeed` TRUNCATES at a word boundary. This
   * file's measurement is therefore still exact — the maximal draft is the
   * maximal draft a run can actually carry — and `scene-subject.test.ts` is
   * what proves the clamp, by parsing a 400-character noun and reading it back
   * short.
   */
  unboundedByDesign: {
    "$.slides[].visualNeed|0": 240,
    "$.slides[].visualNeed|1.subject.noun": SUBJECT_NOUN_MAX_CHARS,
    "$.slides[].visualNeed|1.subject.entityRef": ENTITY_REF_MAX_CHARS,
    "$.slides[].visualNeed|1.subject.mustShow[]": SUBJECT_MUST_SHOW_MAX_CHARS,
    // The ARRAY, clamped by `normaliseVisualNeed`'s `.slice(0, SUBJECT_MUST_SHOW_MAX)`
    // for the same reason its elements are: a fourth entry is DROPPED, never a
    // refused draft.
    "$.slides[].visualNeed|1.subject.mustShow": SUBJECT_MUST_SHOW_MAX,
  },
  recordEntries: { "$.slides[].customArchetypeBrief": MAX_CUSTOM_ARCHETYPE_SLOTS },
  patternFillers: {
    "$.slides[].customArchetypeBrief.archetypeId": (max: number) => `custom_${"x".repeat(max - "custom_".length)}`,
    "$.slides[].customArchetypeBrief.slots[]": (max: number) => "s".repeat(max),
  },
} as const;

const maximalDraft = (fill: string): unknown => maximiseZod(InstagramCopyDraftSchema, { ...COPY_DRAFT_OPTIONS, fill }, "$");

// ── What the six prep runs of 2026-09-16 actually demanded ───────────────────

/**
 * The largest `thought` any completed copy turn produced, in tokens.
 *
 * 52,159 Latin-leaning characters on karoslabs `pubsub-21868183257380937`
 * attempt 2, at the measured blended rate of that turn. It is a floor on the
 * real demand rather than the demand itself: the five attempts that were CUT
 * OFF wanted more than this and we will never know how much.
 */
const MEASURED_WORST_THOUGHT_TOKENS = 14_300;

/** The largest `output` any completed copy turn produced, in tokens: 8,803 characters on karoslabs `pubsub-21850131523417857` attempt 1. */
const MEASURED_WORST_DRAFT_TOKENS = 2_450;

describe("the copy output schema is bounded, and bounded well inside the step's ceiling", () => {
  it("assertion 1: every leaf of the draft schema declares its own maximum", () => {
    // The walk IS the assertion: it throws, by path, on the first leaf whose
    // maximum it cannot read. Reverting any one `.max()` added in Phase 5.5
    // fails here with that field's path in the message, which is how this was
    // verified before it was trusted.
    expect(() => maximalDraft("a")).not.toThrow();
  });

  it("assertion 1b: the maximal draft is a draft — it re-parses against the schema it was built from", () => {
    const parsed = InstagramCopyDraftSchema.safeParse(maximalDraft("a"));
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it("assertion 2: the maximal draft fits in 60% of COPY_MAX_TOKENS", () => {
    const tokens = estimateOutputTokens(serialiseTurn(maximalDraft("a")));
    const ceiling = COPY_MAX_TOKENS * 0.6;
    // Reported unconditionally: the number is the point, and a reviewer reading
    // a green run should be able to see how much room a schema change has left.
    expect(
      tokens,
      `maximal draft is ~${tokens} output tokens against a ${ceiling} budget (60% of COPY_MAX_TOKENS = ${COPY_MAX_TOKENS})`,
    ).toBeLessThan(ceiling);
  });

  it("assertion 3: COPY_MAX_TOKENS clears the worst turn ever measured, plan included, with at least 40% spare", () => {
    const worstMeasuredTurn = MEASURED_WORST_THOUGHT_TOKENS + MEASURED_WORST_DRAFT_TOKENS;
    expect(worstMeasuredTurn).toBeLessThan(COPY_MAX_TOKENS * 0.6);
    // And the thing that actually broke: the old default could not hold it.
    expect(worstMeasuredTurn, "the 16,384 default was BELOW the worst measured turn, which is the defect").toBeGreaterThan(16_384 * 0.95);
  });

  /**
   * The number this file cannot assert, and says so instead of hiding it.
   *
   * A schema-maximal draft written entirely in Hebrew does not fit under any
   * ceiling worth setting: at 1.08 characters a token it is roughly 3.4x the
   * Latin figure, which puts it past 32,000 on its own. That is NOT a reason to
   * raise the ceiling, because the shape is a fiction — it fills all four
   * archetype content blocks on all eight slides, and `assembleSlidesData`
   * renders exactly one of them per slide. The real Hebrew draft measured on
   * 2026-09-16 was 5,256 characters.
   *
   * It is printed rather than asserted so the ratio stays visible to whoever
   * next proposes a generous `.max()` on a field a Hebrew client fills.
   */
  it("reports the Hebrew multiple, which is real even though the shape it is measured on is not", () => {
    const latin = estimateOutputTokens(serialiseTurn(maximalDraft("a")));
    const hebrew = estimateOutputTokens(serialiseTurn(maximalDraft("א")));
    const ratio = hebrew / latin;
    expect(ratio).toBeGreaterThan(2);
    console.info(
      `copy schema maximum: ~${latin} output tokens in Latin, ~${hebrew} in Hebrew (${ratio.toFixed(1)}x), ceiling ${COPY_MAX_TOKENS}`,
    );
  });

  it("the markup that used to live in the draft is gone from it, and stripped rather than refused if a model sends it anyway", () => {
    const draft = maximalDraft("a") as { slides: Array<Record<string, unknown>> };
    expect(draft.slides[0]).not.toHaveProperty("customArchetype");
    expect(draft.slides[0]).toHaveProperty("customArchetypeBrief");

    // Fail-open, for the same reason `SlideEmphasisSchema` states at length:
    // furniture must never be able to reject a draft. A model still writing to
    // @20's contract loses the block and keeps the post.
    const withMarkup = {
      format: "carousel" as const,
      caption: "a caption",
      slides: [
        {
          n: 1,
          headline: "h",
          body: "b",
          visualNeed: "a photograph of a server rack",
          sourceRef: "a claim",
          layout: "custom" as const,
          customArchetype: { archetypeId: "custom_diag", name: "n", rationale: "r", bodyHtml: "<div></div>", css: "", slots: ["a"], fields: { a: "v" } },
        },
      ],
    };
    const parsed = InstagramCopyDraftSchema.safeParse(withMarkup);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.slides[0]).not.toHaveProperty("customArchetype");
  });
});
