import type { CompletionResult } from "@agent-engine/core";
import { finalTurn, goodCopyOutput, goodImageVettingOutput, goodRelevanceVerdict, goodResearchOutput, goodTrendScoutOutput, goodVisualQaOutput } from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * The fake router's turn list, in the order the workflow consumes model
 * calls (RFC-13, Phase 0 + Phase 1, 2026-09).
 *
 * Every workflow-level test used to queue its turns positionally — research,
 * copy, vet, visual QA — and every unconditional new model step (the trend
 * scout at `03c`, the relevance judge at `07g`, the angle proposal at `04i`)
 * shifts that order for thirty files at once. Naming the turns here means a
 * fixture says WHICH call it is answering, and a new step is one key added in
 * one place.
 *
 * Execution order (omitted keys are skipped — a test that stops before a step,
 * or a run whose pool is empty and so skips `06`, simply leaves the key out):
 *
 *   brief          00b2-write-client-brief    (Phase 1; only when the client has no fresh brief — `setupTestEnvironment` seeds one, so most fixtures omit it)
 *   designBrief    00c3-write-design-brief    (Phase 2 item N, SETUP budget; only when `00c` resolved `generate`)
 *   templateDesign 00c4-design-template-<id>  (Phase 2 item N; ONE PER TEMPLATE, so this key takes an ARRAY)
 *   setReview      00c6-review-template-set   (Phase 2 item N; skipped when the setup budget turned the set review off)
 *   templateRepair 00c7-repair-template-<id>  (Phase 2 item N; at most two per setup, so this key takes an ARRAY too)
 *   artDirection   00d2-derive-visual-direction (Phase 3 item Q, SETUP budget; only when `00d` resolved `derive` — `setupTestEnvironment` seeds a fresh direction, so most fixtures omit it)
 *   scout          03c-trend-scout            (every run; skipped by the workflow only when 03b fetched no documents)
 *   research   04b-research-extract-facts
 *   angle      04i-propose-angles         (Phase 1; once per REVISION, not per attempt)
 *   concept    04n-design-concept         (Phase 4; once per REVISION, and ONLY when `04l` found the story eligible — most fixtures omit it)
 *   copy       05-write-copy-attempt-N
 *   vet        06-vet-images-attempt-N    (skipped by the workflow when the candidate pool is empty)
 *   relevance  07g-relevance-attempt-N
 *   valueJudge 07j-value-judge-attempt-N  (Phase 5; EVERY attempt that gets past 07g, in every language — defaulted, see `DEFAULT_VALUE_TURN`)
 *   nativeEditor 07f-language-fluency-attempt-N (+ `-round-2`) (non-English targets only; ARRAY — one entry per judge round)
 *   qa         08b-visual-qa-attempt-N
 *   postPackager 08c-package-post         (Phase 5; ONCE PER REVISION, after the attempt loop breaks — defaulted, see `DEFAULT_PACKAGE_TURN`)
 *   packageNative 08c2-package-native-round (Phase 5; non-English targets only, ONE round, never defaulted)
 *
 * Phase 4 (RFC-15 §6.5) RENAMED `fluency` to `nativeEditor` IN PLACE and made
 * it variadic. The position in `TURN_ORDER` is unchanged and no key was
 * inserted, which is the whole point: the ~30 files this module's warning is
 * about queue their turns through `standardTurns`, and a reorder or an
 * insertion shifts every one of them by a turn. A rename is a compile error in
 * the files that used the old key and a no-op everywhere else.
 *
 * It is an ARRAY because `07f` now runs up to twice inside one attempt: round
 * 1 judges the draft, and when it proposes corrections they are applied in
 * place and round 2 judges the patched copy under
 * `07f-language-fluency-attempt-N-round-2`. `[verdict]` is a one-round
 * fixture; `[round1, round2]` is a two-round one.
 *
 * Phase 5 (RFC-18 §12) INSERTS two keys rather than renaming one, which is the
 * expensive kind of change this module's warning is about — so both of them
 * are DEFAULTED (`DEFAULT_VALUE_TURN`, `DEFAULT_PACKAGE_TURN`). The workflow
 * buys a value turn on every attempt that gets past `07g` and a packager turn
 * on every run that delivers, so an absent key cannot mean "no turn" the way
 * it does everywhere else here: it means "it passed", and `standardTurns`
 * queues the default. A fixture that cares about either says so by key.
 *
 * A test that needs a SECOND attempt appends another `standardTurns({ copy, vet, … })`
 * without `scout`/`research`/`angle` — those run once per run (or, for the
 * angle, once per revision), not once per attempt. A test that needs a second
 * REVISION round appends `standardTurns({ angle, copy, vet, … })`.
 */
export interface StandardTurnFixtures {
  brief?: unknown;
  /** RFC-14 item N, `00c3`. */
  designBrief?: unknown;
  /** RFC-14 item N, `00c4` — one turn PER TEMPLATE (4-6 of them), so the fixture is an array and `standardTurns` emits one turn per entry. */
  templateDesign?: readonly unknown[];
  /** RFC-14 item N, `00c6`. */
  setReview?: unknown;
  /** RFC-14 item N, `00c7` — at most two repairs per setup, one turn each. */
  templateRepair?: readonly unknown[];
  /** RFC-14 item Q, `00d2` — one turn per client per 90 days, on the SETUP budget. */
  artDirection?: unknown;
  scout?: unknown;
  research?: unknown;
  angle?: unknown;
  /**
   * RFC-16 Phase 4, `04m` — the concept direction, once per REVISION.
   *
   * Deliberately NOT in `happyTurns`: `04m-concept-eligibility` declines on
   * the canonical story (no rivalry, no reversal, no recognised entity), so
   * the workflow buys no turn and a queued one would desynchronise every
   * later fixture. A test that wants the concept path must both make its
   * story eligible AND pass this key.
   */
  concept?: unknown;
  copy?: unknown;
  vet?: unknown;
  relevance?: unknown;
  /**
   * RFC-18 §5, `07j-value-judge-attempt-N` — the value judge's raw output.
   *
   * DEFAULTED. The workflow buys this turn on every attempt that gets past
   * `07g`, in every language, so leaving the key out does NOT mean "skipped"
   * the way it does for `concept` or `nativeEditor`: it means "the value judge
   * passed", and `standardTurns` emits `DEFAULT_VALUE_TURN` for it. See that
   * constant for why a silent omission could not be allowed to mean "no
   * turn".
   */
  valueJudge?: unknown;
  /** RFC-15 §6.5, `07f` — ONE ENTRY PER JUDGE ROUND (round 1, optionally round 2 on the corrected copy). */
  nativeEditor?: readonly unknown[];
  qa?: unknown;
  /**
   * RFC-18 §6.1, `08c-package-post` — hashtags, alt text and the first
   * comment's prose, authored ONCE PER REVISION after the attempt loop breaks.
   *
   * DEFAULTED, for the same reason `valueJudge` is: a delivering run always
   * buys this turn. It sits after `qa` because `08c*` runs after the loop,
   * not inside it.
   */
  postPackager?: unknown;
  /**
   * RFC-18 §6.5, `08c2-package-native-round` — one native-editor round over
   * the PACKAGE's prose, on non-English targets only.
   *
   * NOT defaulted and NOT variadic: it is one round with no round 2 (§6.5),
   * and it is skipped outright on an English run, exactly as `nativeEditor`
   * is. Its OWN key rather than a second entry in `nativeEditor`'s array
   * precisely because it is consumed at a different position — after `qa`,
   * after the packager — and a shared variadic slot would put it two turns
   * too early.
   */
  packageNative?: unknown;
}

/**
 * The order `standardTurns` emits its fixtures in — the order the workflow
 * consumes them.
 *
 * The four Template Studio keys sit immediately AFTER `brief` and before
 * `scout`, because that is where they actually run: the studio steps are
 * `00c*`, which the workflow places after `00b3-persist-client-brief` (so the
 * studio reads a fresh brief and the frozen brand kit) and before
 * `03-claim-topic`. Putting them at the front would be wrong in exactly the
 * way this module exists to prevent — a fixture whose turn list is off by one
 * because a new step was assumed to run first.
 */
export const TURN_ORDER = [
  "brief",
  "designBrief",
  "templateDesign",
  "setReview",
  "templateRepair",
  // Phase 3 item Q's `00d2` runs immediately after the studio block and
  // before `03-claim-topic`, on the same setup meter — so its turn sits here,
  // after `templateRepair` and before `scout`.
  "artDirection",
  "scout",
  "research",
  "angle",
  // Phase 4's `04n-design-concept` sits between the angle and the copy
  // because that is where the workflow places it: `04l` scores the story off
  // the CHOSEN angle, and `04n` applies the result after copy is accepted.
  "concept",
  "copy",
  "vet",
  "relevance",
  // Phase 5 (RFC-18 §2): `07j` sits between the relevance judge and the native
  // editor because that is where it runs, and the ordering is load-bearing on
  // both sides. AFTER `07g`, because a post that is not this client's business
  // is dead anyway and relevance is cheaper. BEFORE `07f`, because the native
  // editor's corrections are anchored SPANS into headline/body/caption, so a
  // value-driven rewrite after `07f` would invalidate every applied correction
  // and every span round 2 rests on. Language is the last word on the
  // sentences.
  "valueJudge",
  // Phase 4 renamed this slot `fluency` -> `nativeEditor` and made it variadic. It did NOT move, and nothing
  // was inserted around it: `07f` still runs where it ran, between the relevance judge and the visual QA.
  "nativeEditor",
  "qa",
  // Phase 5 (RFC-18 §6.1): the `08c*` family runs AFTER THE ATTEMPT LOOP
  // BREAKS — alt text for a slide a redraft is about to throw away is money
  // burned, and none of these fields is an input to any gate inside the loop.
  // So both keys sit after `qa`, which is the last turn an attempt buys.
  "postPackager",
  "packageNative",
] as const satisfies ReadonlyArray<keyof StandardTurnFixtures>;

/** Which keys carry a LIST of turns rather than one. Named explicitly rather than sniffed with `Array.isArray`, so a fixture whose model output happens to be an array is never silently spread into several turns. */
const VARIADIC_TURN_KEYS: ReadonlySet<keyof StandardTurnFixtures> = new Set(["templateDesign", "templateRepair", "nativeEditor"]);

/**
 * Keys the workflow consumes on EVERY run that gets that far, so an absent key
 * means "it passed", not "it was skipped" (RFC-18 §12).
 *
 * Every other key in `TURN_ORDER` is conditional on something a fixture
 * controls — a candidate pool, a non-English target, an eligible story — and
 * its absence honestly means no turn. These two are not: without a default,
 * every one of the ~30 files that queue turns positionally would desynchronise
 * by two the moment Phase 5 merged, and the failure would surface as a
 * completely unrelated agent reading another agent's fixture.
 */
const DEFAULTED_TURN_KEYS: ReadonlySet<keyof StandardTurnFixtures> = new Set(["valueJudge", "postPackager"]);

/**
 * The `07j-value-judge` turn for a HAND-QUEUED router sequence: a verdict that
 * clears the bar for any draft, whatever its words.
 *
 * ## Why it is four `weak`s and not four `pass`es
 *
 * Looks backwards, and is not. `normaliseValueVerdict`'s rule 2 (RFC-18 §5.4,
 * and Phase 4's `language-gate.ts:723-736` before it) sets a `weak` or `fail`
 * axis with NO SURVIVING FIX back to `pass`: "report without proposing" is
 * structurally unrepresentable, because a judge that flags an axis and
 * proposes nothing has produced a hold generator. So an all-`weak` verdict
 * with three empty fix arrays normalises to four passes and `keepable: true`.
 *
 * Four `pass`es would NOT be safe here. Rule 1 re-checks every claimed `pass`
 * against the draft IN CODE and downgrades the axis when its quote does not
 * occur, so a constant carrying quotes would silently refuse any fixture whose
 * copy is a mutation of `goodCopyOutput()` — which is most of them. **This
 * constant is copy-independent by construction**, and that is exactly what a
 * hand-queued list needs: a turn that answers `07j` and cannot accidentally
 * become "the value gate sent this draft back".
 *
 * `standardTurns` does NOT use this. A block that queues by key already knows
 * which draft the judge will read, so it gets `defaultValueTurnFor(copy)` —
 * real quotes, drawn from that block's own copy fixture, exercising rule 1
 * rather than stepping around it. Use this only where turns are pushed
 * positionally by hand, and pass an explicit verdict wherever the test is
 * ABOUT the value gate.
 */
export const VALUE_TURN_NO_FINDINGS: Record<string, unknown> = {
  newFact: "weak",
  position: "weak",
  payload: "weak",
  action: "weak",
  fixAxes: [],
  fixTargets: [],
  fixInstructions: [],
  keepLine: "The value judge had nothing to propose, so this fixture says so and the bar is computed from that.",
};

/** A fixture that reads like `InstagramCopyOutput`, for deriving the two defaults' quotes and alt-text count from the copy this block actually queued. */
type CopyLike = { caption: string; slides: Array<{ n: number; headline: string; body: string }> };

function asCopyLike(value: unknown): CopyLike | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<CopyLike>;
  if (typeof candidate.caption !== "string" || !Array.isArray(candidate.slides) || candidate.slides.length === 0) return undefined;
  return candidate.slides.every((s) => typeof s?.headline === "string" && typeof s?.body === "string" && typeof s?.n === "number")
    ? (candidate as CopyLike)
    : undefined;
}

/**
 * The value verdict a fixture that says nothing about value means: **four
 * passes, quoted out of the draft the same block queued.**
 *
 * ## Why the quotes are not decorative
 *
 * `normaliseValueVerdict` (RFC-18 §5.4 rule 1) re-checks every `pass` axis's
 * quote against the draft IN CODE and downgrades `pass -> weak` when the quote
 * does not occur. A default that passed four axes with no quotes would
 * therefore normalise to four WEAKS, which is below the bar, which sends the
 * draft back to `05` — so the "nothing to say about value" fixture would have
 * silently become "the value gate refused this draft" in thirty files at once.
 * Each quote here is a whole field (`slides[0].headline`, `slides[1].body`,
 * `slides[2].body`, `caption`), so it is an exact substring of the judged
 * draft under any assembly and any whitespace normalisation.
 */
export function defaultValueTurnFor(copy: CopyLike): Record<string, unknown> {
  const slide = (i: number) => copy.slides[Math.min(i, copy.slides.length - 1)]!;
  return {
    newFact: "pass",
    position: "pass",
    payload: "pass",
    action: "pass",
    newFactQuote: slide(1).body,
    positionQuote: slide(0).headline,
    payloadQuote: slide(2).body,
    actionQuote: copy.caption,
    fixAxes: [],
    fixTargets: [],
    fixInstructions: [],
    keepLine: "A reader in this field would keep this for the one figure on slide 2.",
  };
}

/**
 * What `standardTurns` queues for `07j` when the `valueJudge` key is absent:
 * **absent means the value judge passed.**
 *
 * Built from `goodCopyOutput()` — the copy fixture the overwhelming majority
 * of these files queue — and used verbatim when a block has no `copy` fixture
 * of its own to quote from. A block that DOES carry a copy fixture gets
 * `defaultValueTurnFor(thatCopy)` instead, so the quotes are always drawn from
 * the draft the judge will actually be shown.
 */
export const DEFAULT_VALUE_TURN: Record<string, unknown> = defaultValueTurnFor(goodCopyOutput());

/**
 * The post package a fixture that says nothing about the whole post means:
 * **five hashtags off the seeded brief's `coreTerms`, one alt text per slide,
 * and a sourced first comment.**
 *
 * The hashtags are `goodClientBrief()`'s own `coreTerms`, because `08c1`
 * enforces (rather than requests) that at least one tag is a core term, and a
 * default that failed that free check would buy the `08c-package-post-retry`
 * turn — one more turn than the fixture queued, which is the same
 * desynchronisation this whole module exists to prevent.
 *
 * **English-target by construction.** `08c1` also holds the tags to the target
 * language's script, so a non-English fixture must pass `postPackager`
 * explicitly rather than inherit these. That is not a limitation of the
 * default so much as a statement about it: there is no script-neutral hashtag.
 */
export function defaultPackageTurnFor(copy: CopyLike): Record<string, unknown> {
  return {
    hashtags: ["content", "founders", "pipeline", "editorial", "cadence"],
    altText: copy.slides.map((s) => ({ n: s.n, alt: `Slide ${s.n}: ${s.headline}`.slice(0, 125) })),
    firstCommentText: "Sources for the figures on these slides, in the order they appear.",
  };
}

/** What `standardTurns` queues for `08c` when the `postPackager` key is absent: **absent means the packager wrote a clean package.** Derived per block when the block carries a copy fixture; this constant is the no-copy fallback. */
export const DEFAULT_PACKAGE_TURN: Record<string, unknown> = defaultPackageTurnFor(goodCopyOutput());

/**
 * Whether this block's attempt actually REACHES `07j`.
 *
 * The value judge runs immediately after `07g` passes, so a block whose
 * relevance fixture is an off-brief verdict never buys a value turn — queuing
 * one for it would leave an unconsumed turn in front of the NEXT attempt's
 * copy call. `score` is read because that is the only field `07g`'s decision
 * turns on; a fixture with no score at all is a judge error, which fails open
 * and does reach `07j`.
 */
function reachesValueJudge(fixtures: StandardTurnFixtures): boolean {
  // Keyed on `relevance` ALONE, deliberately: `07j` runs the moment `07g`
  // passes, so the block that queues a relevance turn is the block whose next
  // turn the value judge takes. Requiring `copy` in the same block looked
  // safer and was wrong - `concept-workflow.test.ts` splices its `04n` turn in
  // by calling `standardTurns` THREE times, with `copy` in the second block and
  // `relevance` in the third, so a copy-gated rule emitted no value turn at all
  // and `07j` ate the QA fixture instead.
  if (!("relevance" in fixtures) || fixtures.relevance === undefined) return false;
  const score = (fixtures.relevance as { score?: unknown }).score;
  return typeof score !== "number" || score >= 3;
}

/**
 * Whether this block's attempt WINS — the only state in which `08c` is bought.
 *
 * A failing visual QA verdict returns the draft to `05`, so the packager is
 * never reached on that attempt; a block with no `qa` fixture never got that
 * far either.
 */
function reachesPackager(fixtures: StandardTurnFixtures): boolean {
  if (!("qa" in fixtures) || fixtures.qa === undefined) return false;
  return (fixtures.qa as { pass?: unknown }).pass !== false;
}

/** `finalTurn(...)` entries for the supplied fixtures, in execution order. */
export function standardTurns(fixtures: StandardTurnFixtures): Array<() => CompletionResult<unknown>> {
  const turns: Array<() => CompletionResult<unknown>> = [];
  const copyLike = asCopyLike(fixtures.copy);
  for (const key of TURN_ORDER) {
    if (!(key in fixtures) || fixtures[key] === undefined) {
      // The two defaulted keys: absent means "it passed", so the turn is still
      // queued. Only when the workflow would actually have bought it.
      if (!DEFAULTED_TURN_KEYS.has(key)) continue;
      if (key === "valueJudge" && reachesValueJudge(fixtures)) {
        turns.push(finalTurn(copyLike !== undefined ? defaultValueTurnFor(copyLike) : DEFAULT_VALUE_TURN));
      } else if (key === "postPackager" && reachesPackager(fixtures)) {
        turns.push(finalTurn(copyLike !== undefined ? defaultPackageTurnFor(copyLike) : DEFAULT_PACKAGE_TURN));
      }
      continue;
    }
    const value = fixtures[key];
    if (VARIADIC_TURN_KEYS.has(key)) {
      for (const entry of value as readonly unknown[]) turns.push(finalTurn(entry));
      continue;
    }
    turns.push(finalTurn(value));
  }
  return turns;
}

/**
 * The canonical happy path for an English-language client with a candidate
 * pool: scout, research, angle, copy, vet, relevance, QA. `overrides`
 * replaces a fixture by key (`{ vet: myVetting }`); set a key to `undefined`
 * to drop it.
 *
 * No `brief` turn by default: `setupTestEnvironment` seeds a fresh persisted
 * brief, so `00b-check-client-brief` resolves to `reuse` and `00b2` never
 * runs. A fixture that wants the create path passes `seedBrief: false` there
 * AND a `brief` fixture here.
 *
 * No Template Studio turns by default either, for the same reason and the
 * same shape: `setupTestEnvironment` seeds a fresh APPROVED studio set, so
 * `00c-check-template-studio` resolves to `reuse` and `00c3`-`00c7` never
 * run. A fixture that wants the generate path passes `seedStudio: false`
 * there AND `designBrief`/`templateDesign`/`setReview` fixtures here.
 *
 * The `angle` IS in the default, because `04i-propose-angles` runs on every
 * revision of every run (once per revision, never per attempt).
 */
export function happyTurns(overrides: StandardTurnFixtures = {}): Array<() => CompletionResult<unknown>> {
  return standardTurns({
    scout: goodTrendScoutOutput(),
    research: goodResearchOutput(),
    angle: goodAngleProposal(),
    // Phase 5 — `goodCopyOutput()`, which now CLEARS `07i`'s free value floor.
    //
    // For a few hours of this cycle this line read `valueFloorSafeCopy()`, a
    // local stand-in written here because the shared fixture's every body was
    // its fact card's own sentence and `checkSourceProse` refused it. That
    // stand-in's own comment named the real fix — lift its copy into
    // `goodCopyOutput()` and delete it — and that fix has now landed in
    // `test-helpers.ts`, together with a `weakCopyOutput()` twin that is
    // deliberately still refused so the suite exercises the gate saying no.
    // A canonical happy path has to actually clear the gates: a "happy" draft
    // sent back to `05` on attempt 1 desynchronises every positional turn list
    // downstream and fails in a place that has nothing to do with the test.
    copy: goodCopyOutput(),
    vet: goodImageVettingOutput(),
    relevance: goodRelevanceVerdict(),
    qa: goodVisualQaOutput(),
    ...overrides,
  });
}
