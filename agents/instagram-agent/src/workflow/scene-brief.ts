import { z } from "zod";

/**
 * Phase 3, brief item R — "a scene brief instead of twelve words."
 *
 * THE TENSION THIS RESOLVES. `visualNeed` is one string read by three steps
 * that want three different things from it:
 *
 *   - `05b-source-images` puts it into a KEYWORD index (Unsplash/Pexels and
 *     the scraper). A keyword index does not degrade gracefully on a long
 *     query: it returns near-arbitrary matches that look plausible in a list
 *     and are wrong on inspection. Prep run pubsub-21545408480430711 asked
 *     for "a bar chart printed on paper lying flat on a desk, a person's hand
 *     pointing at the page, no legible axis labels" and got back a Swedish
 *     street kiosk, a 2013 film poster and "(King) George of the Jungle".
 *   - `image.generate` interpolates it as the generation prompt, where twelve
 *     words is the STARVED end of the trade: a diffusion model given "a busy
 *     open-plan office" invents the rest, which is the "generic stock" failure
 *     `buildBrief`'s own doc comment warns about.
 *   - `06-vet-images` judges a candidate against it, and its hardest question
 *     ("is this picture EVIDENCE FOR THE CLAIM?") is not answerable from a
 *     list of objects at all — it needs to know what work the picture is
 *     doing on that slide.
 *
 * Copy prompt @14 §6 spends ~45 lines managing the first constraint at the
 * expense of the other two, and it is right to, because one string cannot
 * serve all three. So the field splits: `scene` (what is in frame), `why`
 * (why the slide is weaker without it), `source` (the writer's explicit
 * choice of where the picture comes from, INCLUDING "none") and optional
 * `searchTerms` (the keyword query, authored short on purpose). Retrieval
 * reads `searchTerms`, generation reads `scene`, vetting reads `scene` +
 * `why`. Nothing is compromised for anything else.
 *
 * THE UNION IS NON-NEGOTIABLE. `visualNeed` stays `z.union([z.string(),
 * SlideVisualNeedSchema])` and every consumer goes through
 * `normaliseVisualNeed`. Three populations depend on that: ~30 existing
 * workflow fixtures that write a bare string, in-flight checkpoints from runs
 * that started before this shipped (a resumed run re-parses its own
 * checkpointed copy), and a model that regresses to the old shape mid-run —
 * which must cost that slide nothing, not fail the whole draft's schema and
 * burn an attempt.
 *
 * THIS MODULE IMPORTS NOTHING FROM THE WORKFLOW, deliberately. `types.ts`
 * imports `VisualNeedFieldSchema` from here and `visual-qa-pre-checks.ts`
 * imports `checkNoImageMeansDevice` from here, so an import in the other
 * direction would close a runtime cycle through `slides-data.ts`. The two
 * facts that would otherwise be imported (the device-bearing archetype set
 * and the `-inv` suffix) are restated below with their own doc comments and
 * pinned against the originals in `__tests__/scene-brief.test.ts`, so a drift
 * fails a test rather than silently changing what this rule accepts.
 */

/**
 * Where this slide's picture comes from. The writer chooses; the sourcing
 * cascade is not obliged to obey every value, but it never ignores `"none"`.
 *
 * - `"client-upload"` — the client attached a photograph meant for this idea.
 *   It does NOT suppress sourcing: tier 0 already prefers the client's own
 *   files, and a slide left uncovered still needs somewhere to go.
 * - `"stock"` — the default, and the honest default. Most slides are a real
 *   scene a library already holds.
 * - `"generate"` — the scene is real but unlikely to exist in a library.
 * - `"none"` — this idea is not photographable, so nothing is sourced for it
 *   at all. The slide then has to carry a DEVICE instead
 *   (`NO_IMAGE_MEANS_DEVICE_RULE`): opting out of imagery and setting a
 *   headline on bare ground is the empty slide the owner named as the defect,
 *   not a design choice.
 */
export const SCENE_SOURCES = ["client-upload", "stock", "generate", "none"] as const;
export const SceneSourceSchema = z.enum(SCENE_SOURCES);
export type SceneSource = z.infer<typeof SceneSourceSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Phase 5.5, item A3 — THE SUBJECT, which is not the same thing as the scene
// ─────────────────────────────────────────────────────────────────────────

/** `subject.noun` is one noun phrase, not a sentence; a photo library indexes phrases. */
export const SUBJECT_NOUN_MAX_CHARS = 60;
/** Matches `RecognisedEntitySchema.name`'s own ceiling in `entity-imagery.ts`, so a ref always round-trips. */
export const ENTITY_REF_MAX_CHARS = 80;
/** Three, because the vet treats every one of them as CENTRAL and a fourth central clause is how v1 refused whole pools. */
export const SUBJECT_MUST_SHOW_MAX = 3;
export const SUBJECT_MUST_SHOW_MAX_CHARS = 40;

/**
 * WHAT MUST BE IN FRAME, separated from how the frame was made.
 *
 * ## The measurement this exists for
 *
 * Prep run `pubsub-21868183257380937` (karoslabs, 2026-09-16) briefed its
 * cover as *"A server infrastructure corridor photographed with long
 * exposure, near-black tones, warm shadows, sharp geometric lines receding
 * into darkness, no people, no legible text in frame"*, with `why`
 * *"…long-exposure infrastructure signals precision and permanence…"*.
 * Retrieval returned six candidates, FOUR of which are photographs of real
 * server racks in real data centres. The vet returned `imagePath: null` at
 * `claimMatch 1` and said so in its own words:
 *
 * > "The other candidates are server infrastructure, but none feature the
 * > 'long exposure' effect that the `why` section states is necessary"
 *
 * — and the one candidate it did credit with the long exposure was a road
 * tunnel, which it then refused for being a road tunnel. A single `scene`
 * string could not tell the vet which half of it was the subject, so the
 * grade was read as central and a correct pool was thrown away.
 *
 * `subject` is the half that is central. `scene` keeps everything else and is
 * explicitly DECORATIVE from `instagram-image-vet@6` onward.
 */
/**
 * ## Why none of the string fields below carries a `max()`
 *
 * *"A schema max on a model output is a coin flip that loses the whole step."*
 * On 2026-09-16 `08c-package-post` lost two of three live runs their hashtags
 * and their alt text to a single `altText.max(125)`, and `00c3` lost a whole
 * client's template set to `formatLabel.max(80)`. `visualNeed` sits inside
 * `InstagramSlideCopySchema`, so a `max()` violated here does not cost a
 * field — it fails the parse of an eight-slide draft that cost ~$0.31 and
 * burns an attempt, and the union cannot save it because an object that
 * failed the object branch does not match the string branch either.
 *
 * So the ceilings are real, they are exported, the prompt states them, and
 * `normaliseVisualNeed` ENFORCES them by truncating at a word boundary. The
 * constraint is kept and the coin flip is not.
 */
export const SceneSubjectSchema = z.object({
  /**
   * A concrete noun phrase a photo library actually indexes — "server racks
   * in a data centre", never "precision". Clamped to
   * `SUBJECT_NOUN_MAX_CHARS`; checked against `ABSTRACT_NOUN_DENYLIST` by
   * `checkSceneBriefs`, which returns a finding to `05` rather than failing
   * the draft.
   */
  noun: z.string().min(1),
  /**
   * The recognised entity this picture is OF, when there is one. Matched by
   * name against `04b3-extract-entities`' output; an unresolvable ref is
   * DROPPED by `resolveEntityRef`, never fabricated into a search term.
   */
  entityRef: z.string().optional(),
  /**
   * At most three things that must be visible, and the ONLY clauses the vet
   * may treat as central besides `noun` itself. A fourth is dropped by
   * `normaliseVisualNeed`, not refused.
   *
   * Defaulted rather than required for the reason `searchTerms` is optional:
   * a model that omits it costs the run nothing (the vet falls back to `noun`
   * alone, which is still narrower than judging the whole `scene`), while a
   * required field is one more way a whole draft fails its schema.
   */
  mustShow: z.array(z.string().min(1)).default([]),
});
export type SceneSubject = z.infer<typeof SceneSubjectSchema>;

/**
 * The scene brief itself.
 *
 * `why` is REQUIRED and it is not decoration. It is the field the vet reads
 * to decide which clauses of `scene` are central and which are decorative
 * (`instagram-image-vet@5` §1 — @5 is RFC-16's conceptual-slide revision and
 * §1 carries over from @4 byte-identically), and it is the only place the
 * writer states
 * what the picture is FOR. A brief with no stated purpose is a shopping list,
 * and judging a shopping list is exactly the failure mode v3 was written to
 * escape.
 *
 * `scene` is capped at 240 characters rather than left open: a scene brief is
 * still one frame, and past a couple of sentences the writer is describing a
 * sequence no photograph can hold.
 *
 * `searchTerms` is optional because `keywordsFromScene` can always derive a
 * usable query, and OPTIONAL-WITH-A-DERIVATION beats required: a model that
 * omits the field costs the run nothing, while a required field is one more
 * way a whole draft fails its schema.
 */
export const SlideVisualNeedSchema = z.object({
  /**
   * WHAT MUST BE IN FRAME (item A3).
   *
   * OPTIONAL in the union on purpose, and the reason is the same one the
   * union itself exists for: ~30 workflow fixtures and every in-flight
   * checkpoint predate this field, and a resumed run re-parses its own
   * checkpointed copy. `normaliseVisualNeed` derives a subject from `scene`
   * when it is absent (`deriveSubject`), so every consumer downstream sees
   * one either way and nothing has to branch. Copy prompt `@21` requires the
   * model to author it.
   */
  subject: SceneSubjectSchema.optional(),
  scene: z.string().min(1).max(240),
  why: z.string().min(1).max(200),
  source: SceneSourceSchema.default("stock"),
  searchTerms: z.array(z.string().min(1).max(40)).min(1).max(6).optional(),
});
export type SlideVisualNeed = z.infer<typeof SlideVisualNeedSchema>;

/**
 * What `InstagramSlideCopySchema.visualNeed` becomes. The bare string is
 * listed FIRST so a legacy value parses on the cheapest branch, and because
 * a union that tried the object first would report its errors against the
 * object shape for a string input.
 */
export const VisualNeedFieldSchema = z.union([z.string().min(1), SlideVisualNeedSchema]);
export type VisualNeedField = z.infer<typeof VisualNeedFieldSchema>;

/**
 * How many words of `scene` become the fallback keyword query.
 *
 * Eight, because copy prompt @14 §6's own hard budget for the keyword era was
 * "one subject, one setting, at most one more constraint — roughly twelve
 * words", and the failure it documents is a query with THREE stacked
 * constraints. Truncating to eight keeps the subject and the setting (the two
 * things a keyword index actually matches on) and drops the third constraint,
 * which is the term that was returning the Swedish street kiosk. A writer who
 * wants a different query says so in `searchTerms`; this is the floor under a
 * writer who did not.
 */
export const SCENE_KEYWORD_WORD_LIMIT = 8;

/** Mirrors `SlideVisualNeedSchema.searchTerms`' own per-term ceiling, so a derived term can never fail the schema it is standing in for. */
export const SCENE_SEARCH_TERM_MAX_CHARS = 40;

/**
 * `scene` reduced to a keyword query.
 *
 * Punctuation is stripped from both ends of each word with the Unicode
 * property class rather than an ASCII character list: the target languages
 * include Hebrew (client `geektime`), whose maqaf and geresh are `\p{P}` and
 * would otherwise ride along into the index as part of the term.
 */
function keywordsFromScene(scene: string): string[] {
  return scene
    .split(/\s+/u)
    .map((word) => word.replace(/^\p{P}+|\p{P}+$/gu, ""))
    .filter((word) => word.length > 0)
    .slice(0, SCENE_KEYWORD_WORD_LIMIT)
    .map((word) => word.slice(0, SCENE_SEARCH_TERM_MAX_CHARS));
}

// ─────────────────────────────────────────────────────────────────────────
// Technique vs. subject — the vocabulary both the query and the vet read
// ─────────────────────────────────────────────────────────────────────────

/**
 * Head nouns that name HOW a picture was made rather than WHAT it shows.
 *
 * The test is the term's LAST word, which is what makes this both short and
 * explainable: English noun phrases are head-final, so "long exposure",
 * "morning light" and "muted terracotta palette" all end on a word from this
 * list while "server corridor", "wooden desk" and "dark infrastructure" do
 * not. A vocabulary of modifiers ("long", "warm", "dark") would have to
 * decide that "dark infrastructure" is a grade, which it is not.
 *
 * Measured against the karoslabs cover of 2026-09-16: its authored
 * `searchTerms` were `["server corridor", "data center", "long exposure",
 * "dark infrastructure"]`, and "long exposure" is the term that put a
 * Pixabay road tunnel — captioned "tunnel, underpass, light, long exposure,
 * passage, dark, architecture, road" — into a pool of server racks. Dropping
 * technique terms from the QUERY removes that candidate class at source,
 * before the vet has to have an opinion about it.
 */
export const TECHNIQUE_HEAD_NOUNS: ReadonlySet<string> = new Set([
  "light",
  "lighting",
  "exposure",
  "shot",
  "focus",
  "grain",
  "tone",
  "tones",
  "shadow",
  "shadows",
  "highlight",
  "highlights",
  "contrast",
  "lens",
  "bokeh",
  "blur",
  "grade",
  "grading",
  "saturation",
  "vignette",
  "framing",
  "palette",
  "mood",
  "atmosphere",
  "aesthetic",
  "vibe",
  "treatment",
  "closeup",
  "close-up",
  "crop",
  "angle",
  "aperture",
  "colour",
  "color",
]);

/** Whole terms that are technique but are not head-final (or are a single token). */
export const TECHNIQUE_PHRASES: readonly string[] = ["depth of field", "shallow depth of field", "black and white", "35mm", "35 mm", "long exposure", "time lapse", "timelapse", "tilt shift", "golden hour", "blue hour", "wide angle", "macro", "telephoto", "aerial", "overhead", "top-down", "backlit", "monochrome", "desaturated", "cinematic", "filmic"];

function lower(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

function words(text: string): string[] {
  return lower(text)
    .split(/\s+/u)
    .map((word) => word.replace(/^\p{P}+|\p{P}+$/gu, ""))
    .filter((word) => word.length > 0);
}

/** Does this search term describe the making of the picture rather than its subject? */
export function isTechniqueTerm(term: string): boolean {
  const normalised = lower(term);
  if (TECHNIQUE_PHRASES.includes(normalised)) return true;
  const parts = words(normalised);
  const head = parts.at(-1);
  return head !== undefined && TECHNIQUE_HEAD_NOUNS.has(head);
}

/**
 * The verbs that join a subject to its treatment: everything after one of
 * these is how the picture was made. "A server infrastructure corridor
 * PHOTOGRAPHED WITH long exposure…" is the exact shape.
 */
const TREATMENT_JOINERS = /\b(photographed|shot|captured|taken|rendered|lit|framed|composed)\b/u;

/**
 * The subject, cut out of a `scene` that was never asked for one.
 *
 * Three steps, in order, each removing a thing that is not the subject: the
 * clause (a scene is a list; the subject is its first item), the article, and
 * the treatment clause. On the karoslabs cover this turns
 *
 *   "A server infrastructure corridor photographed with long exposure,
 *    near-black tones, warm shadows, sharp geometric lines receding into
 *    darkness, no people, no legible text in frame"
 *
 * into `"server infrastructure corridor"` — which is what the pool actually
 * held four photographs of.
 *
 * A derived subject carries `origin: "derived"` and is never blamed on the
 * writer: `checkSceneBriefs` runs the abstract-noun guard on AUTHORED nouns
 * only, because a finding returned to `05` over a phrase this function cut
 * would be the pipeline complaining to the model about its own arithmetic.
 */
export function deriveSubject(scene: string): SceneSubject {
  const firstClause = scene.split(/[,;.—–:]/u)[0] ?? scene;
  const withoutArticle = firstClause.replace(/^\s*(an?|the)\s+/iu, "");
  const joiner = TREATMENT_JOINERS.exec(withoutArticle);
  const subjectOnly = joiner !== null ? withoutArticle.slice(0, joiner.index) : withoutArticle;
  const capped = clampPhrase(subjectOnly, SUBJECT_NOUN_MAX_CHARS);
  // An empty derivation is possible (a scene of pure punctuation, or one that
  // opens on a joiner). Falling back to the raw scene keeps the invariant the
  // whole module rests on — every need has a subject — and a bad subject is
  // still strictly better for retrieval than no subject at all.
  return { noun: capped.length > 0 ? capped : clampPhrase(scene, SUBJECT_NOUN_MAX_CHARS), mustShow: [] };
}

/**
 * Truncate at a word boundary, or at the hard limit when the first word is
 * already longer than it — which is what a URL, a hash or a Hebrew string
 * written without spaces looks like to this function.
 */
export function clampPhrase(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const atBoundary = collapsed.slice(0, max).replace(/\s+\S*$/u, "");
  return atBoundary.length > 0 ? atBoundary : collapsed.slice(0, max);
}

/** The ceilings the schema no longer declares, enforced where the value is read. See `SceneSubjectSchema`'s header. */
function clampSubject(subject: SceneSubject): NormalisedSceneSubject {
  const entityRef = subject.entityRef === undefined ? undefined : clampPhrase(subject.entityRef, ENTITY_REF_MAX_CHARS);
  return {
    noun: clampPhrase(subject.noun, SUBJECT_NOUN_MAX_CHARS),
    ...(entityRef !== undefined && entityRef.length > 0 ? { entityRef } : {}),
    mustShow: subject.mustShow.slice(0, SUBJECT_MUST_SHOW_MAX).map((clause) => clampPhrase(clause, SUBJECT_MUST_SHOW_MAX_CHARS)),
    origin: "authored",
  };
}

/** A subject plus where it came from. `origin` is what every guard in this module keys off. */
export interface NormalisedSceneSubject extends SceneSubject {
  /** `"authored"` — the writer wrote it. `"derived"` — `deriveSubject` cut it out of `scene`. */
  origin: "authored" | "derived";
}

/** The shape every consumer reads. `why` is absent exactly when the value arrived as a legacy bare string. */
export interface NormalisedVisualNeed {
  /** What is in frame. The generation prompt, and the DECORATIVE half of the vet's question from `@6` on. */
  scene: string;
  /** WHAT MUST BE IN FRAME. Always present — authored by the writer, or derived from `scene`. */
  subject: NormalisedSceneSubject;
  /** Why the slide is weaker without it. The vet's central-vs-decorative discriminator. */
  why?: string;
  source: SceneSource;
  /** Always non-empty when `scene` is — authored, or derived by `keywordsFromScene`. */
  searchTerms: string[];
  /**
   * Where `searchTerms` came from, and the technique filter keys off it.
   *
   * An AUTHORED term is a phrase the writer chose, so dropping "long exposure"
   * whole is dropping a decision. A DERIVED list is `keywordsFromScene`'s word
   * shredding of `scene`, where every entry is one word out of a phrase —
   * dropping "close-up" from `["a", "close-up", "of", "hands", "typing", …]`
   * does not remove a treatment, it produces "a of hands typing on a laptop".
   * The filter therefore runs on authored terms only, which is also where the
   * measured defect was: karoslabs' cover authored `["server corridor", "data
   * center", "long exposure", "dark infrastructure"]`.
   */
  searchTermsOrigin: "authored" | "derived";
}

/**
 * THE ONE READER. Every step that touches `visualNeed` goes through this, so
 * the legacy string, a full brief and a model that half-regressed all arrive
 * at the same downstream code.
 *
 * It never throws. `InstagramSlideCopySchema` has already parsed this field
 * by the time the workflow calls it, so the defensive branch below is only
 * reachable from a hand-built slide in a test or a caller assembling copy
 * itself — and this function sits between the writer and every image step,
 * where a throw would fail a run over a shape the schema was supposed to
 * guarantee. An unreadable value degrades to an empty scene, which the
 * sourcing loop already handles as "nothing to search for".
 */
export function normaliseVisualNeed(slide: { visualNeed: VisualNeedField }): NormalisedVisualNeed {
  const need = slide.visualNeed;
  if (typeof need === "string") return legacyNeed(need);
  const parsed = SlideVisualNeedSchema.safeParse(need);
  if (!parsed.success) {
    const scene = typeof (need as { scene?: unknown } | null)?.scene === "string" ? (need as { scene: string }).scene : "";
    return legacyNeed(scene);
  }
  const value = parsed.data;
  const authoredTerms = value.searchTerms !== undefined && value.searchTerms.length > 0;
  const searchTerms = authoredTerms ? [...value.searchTerms!] : keywordsFromScene(value.scene);
  const subject: NormalisedSceneSubject = value.subject !== undefined ? clampSubject(value.subject) : { ...deriveSubject(value.scene), origin: "derived" };
  return { scene: value.scene, subject, why: value.why, source: value.source, searchTerms, searchTermsOrigin: authoredTerms ? "authored" : "derived" };
}

/**
 * A bare string is a scene with no stated purpose, sourced from stock — which
 * is exactly what it meant before this split, so every existing fixture and
 * checkpoint keeps its behaviour to the letter. The keyword query becomes
 * BETTER than it was: today the whole string is the query, and the truncation
 * below is what the Swedish-kiosk failure needed.
 */
function legacyNeed(scene: string): NormalisedVisualNeed {
  return { scene, subject: { ...deriveSubject(scene), origin: "derived" }, source: "stock", searchTerms: keywordsFromScene(scene), searchTermsOrigin: "derived" };
}

/**
 * How many terms an authored subject's query carries beside the noun itself.
 *
 * Two. The subject noun is already a phrase a library indexes, and every term
 * after it narrows an index that does not degrade gracefully — which is the
 * failure the whole module's header documents. Three terms was measured to be
 * where the karoslabs query stops being about server racks.
 */
const AUTHORED_SUBJECT_QUERY_TERMS = 2;

/**
 * The query string `05b-source-images` puts in `needs[].query`.
 *
 * ## Two changes in Phase 5.5, both measured on the same failure
 *
 * 1. **Authored technique terms are dropped** (`isTechniqueTerm`). karoslabs'
 *    cover asked for `["server corridor", "data center", "long exposure",
 *    "dark infrastructure"]` and got back a road tunnel whose own caption read
 *    "tunnel, underpass, light, long exposure, passage, dark, architecture,
 *    road" — the query matched on the grade. A keyword index cannot tell a
 *    treatment term from a subject term, so the term never goes in. DERIVED
 *    terms are exempt; `searchTermsOrigin`'s own comment says why.
 * 2. **An authored subject LEADS.** `subject.noun` is the phrase the writer
 *    was asked to make indexable, so it is the query and the remaining terms
 *    are the refinement, not the other way round.
 *
 * A DERIVED subject changes nothing: the query is today's term list minus the
 * technique terms. That keeps every existing fixture's query recognisable and
 * keeps the one real behaviour change tied to the one new field.
 *
 * Falls back to the raw scene only when everything above produced nothing (a
 * scene of pure punctuation) — an empty query would make the harvester return
 * its own arbitrary top results, which is the one outcome worse than a bad
 * query.
 */
export function retrievalQueryFor(need: NormalisedVisualNeed): string {
  const subjectTerms = need.searchTermsOrigin === "authored" ? need.searchTerms.filter((term) => !isTechniqueTerm(term)) : need.searchTerms;
  const terms =
    need.subject.origin === "authored"
      ? [need.subject.noun, ...subjectTerms.filter((term) => !containsAllWords(need.subject.noun, term)).slice(0, AUTHORED_SUBJECT_QUERY_TERMS)]
      : subjectTerms;
  const query = terms.join(" ").trim();
  if (query.length > 0) return query;
  // Every term was technique. The subject still names something, and a subject
  // with no refinement beats a query made of grades.
  const noun = need.subject.noun.trim();
  return noun.length > 0 ? noun : need.scene.trim();
}

/** Is every word of `term` already in `haystack`? Keeps "data center" out of a query that already says "data centre… center". */
function containsAllWords(haystack: string, term: string): boolean {
  const present = new Set(words(haystack));
  const parts = words(term);
  return parts.length > 0 && parts.every((word) => present.has(word));
}

/**
 * The prompt `image.generate` receives for this slide.
 *
 * `scene` only. `why` is the editorial justification for the picture, not
 * something a diffusion model can draw — appending it would spend prompt on
 * an instruction the generator can only misread as content ("why the slide is
 * weaker without it" becomes objects in the frame). The full scene brief IS
 * the scene; that is the field that was starved.
 */
/** The opening every entity picture brief (`draft-entities.ts` `entityPictureBrief`) carries. */
const ENTITY_BRIEF_SHAPE = /^[^:]{1,120}: the brand's own mark, a real product surface, or a press photograph of the person most identified with it\./u;

/** True when `scene` asks for a picture OF a named thing (its mark, its product, its person): retrieval can find one, a generator can never honestly draw one. */
export function isEntityPictureBrief(scene: string): boolean {
  return ENTITY_BRIEF_SHAPE.test(scene);
}

/**
 * What `image.generate` is asked to draw for a slide.
 *
 * 2026-09-24: an entity picture brief is a RETRIEVAL request. Handed to a
 * generator verbatim (Geektime, `pubsub-21255162145042672`: "GotFriends: the
 * brand's own mark, a real product surface, or a press photograph ..."), it
 * asks for a company's logo or a real person's likeness, which the vet then
 * correctly refuses, and the run spends its generation allowance on frames
 * that could never ship. A generator is asked instead for the world the slide
 * talks about, from the slide's own words, with the named thing kept out.
 */
export function generationPromptFor(
  need: NormalisedVisualNeed,
  slide?: { headline?: string; body?: string },
  options: { rewrite?: (scene: string) => boolean } = {},
): string {
  return generationRewrites(need, options) ? sceneFromSlideWords(need, slide) : need.scene;
}

/**
 * Whether the scene a generator draws for this slide is NOT the writer's
 * brief: an entity picture brief (never drawable), or a scene the caller's
 * `rewrite` predicate refuses (the workflow passes `prescribesClicheScene`:
 * KAROS, `pubsub-21255039598063450`, 2026-09-24, briefed "a desktop monitor
 * with multiple disconnected browser tabs", was drawn exactly so, and the
 * frame was then promoted to the cover: the laptop-in-a-dark-room picture the
 * owner banned, produced by our own generator). A rewritten frame is vetted
 * against the scene it was drawn to, not the writer's subject.
 */
export function generationRewrites(need: NormalisedVisualNeed, options: { rewrite?: (scene: string) => boolean } = {}): boolean {
  return isEntityPictureBrief(need.scene) || options.rewrite?.(need.scene) === true;
}

/**
 * A conceptual picture built from the slide's own words, with no logo,
 * lettering, screen or recognisable person.
 *
 * 2026-09-25, job PCjzJDH10gQW7peazB5n (karoslabs, "agent delegation
 * thresholds"): this used to ask for "the real-world setting behind" the slide
 * "as a documentary photographer would". A software idea has no real-world
 * setting once screens are forbidden, so the generator invented one: a man in
 * a dim workshop opening a door, a figure in a corridor, cables. The owner:
 * the pictures fit less and are less attractive than before. An abstract claim
 * is made visible by ONE concrete object or small arrangement that stands for
 * it, which is what editorial illustrators and magazine art directors do, so
 * the fallback now asks for that.
 */
export function sceneFromSlideWords(need: NormalisedVisualNeed, slide?: { headline?: string; body?: string }): string {
  const said = [slide?.headline, slide?.body]
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .slice(0, 220);
  const about = said.length > 0 ? `a slide that says: "${said}"` : need.why !== undefined ? `a slide about ${need.why}` : "this slide";
  return (
    `A striking conceptual editorial photograph for ${about}. Make the slide's idea visible through ONE concrete physical object or small arrangement that stands for it, ` +
    "the way a magazine art director would illustrate an abstract story: a single clear focal subject a viewer recognises in a second, a bold simple composition, crisp and well lit, contemporary. " +
    // 2026-09-25, prep batch 6: with the slide's own names in the prompt
    // ("Sarona Partners", "Geektime") the generator drew "four men at a
    // conference" and "event booklets in a convention lobby", and the vet
    // refused both. The object is the picture, so the frame is a still life.
    "A still life: no people, hands, crowds, meetings, stages, conferences or offices, and not a generic room or building. " +
    "No logos, brand names, lettering, laptops, monitors, phones or other screens, and no recognisable real people anywhere in the frame."
  );
}

/**
 * What `06-vet-images` gets per slide, alongside the headline and body it
 * already receives.
 *
 * From `instagram-image-vet@6` the payload leads with `subject` and `mustShow`
 * — the CENTRAL clauses — and `scene` follows as declared decoration. The
 * ordering is not cosmetic: @5 read `scene` first and treated everything in it
 * as a requirement, which is how four correct photographs of server racks were
 * refused for lacking a long exposure.
 */
export function vetSubjectFor(need: NormalisedVisualNeed): { subject: string; mustShow: string[]; entityRef?: string; scene: string; why?: string } {
  return {
    subject: need.subject.noun,
    mustShow: [...need.subject.mustShow],
    ...(need.subject.entityRef !== undefined ? { entityRef: need.subject.entityRef } : {}),
    scene: need.scene,
    ...(need.why !== undefined ? { why: need.why } : {}),
  };
}

/**
 * `vetSubjectFor` for a frame the pipeline DREW (2026-09-24).
 *
 * Every generation prompt forbids logos and brand marks, so a generated frame
 * can never show the named company a slide's `entityRef` points at. Graded
 * with the `entityRef`, the vet refused it for exactly that: Sitti
 * (pubsub-21255328593979584) briefed "a phone showing a payment confirmation"
 * for a Stripe slide, the frame showed that, and the vet wrote "lacks the
 * required Stripe branding" until the run's whole generation ceiling was spent
 * and the carousel shipped two pictures against a floor of three. The subject,
 * the must-shows and the scene still apply; only the brand the generator was
 * told not to draw is dropped.
 */
export function vetSubjectForGenerated(need: NormalisedVisualNeed): { subject: string; mustShow: string[]; scene: string; why?: string } {
  const { entityRef: _drawnWithoutIt, ...rest } = vetSubjectFor(need);
  return rest;
}

/**
 * Whether this slide takes part in image sourcing at all.
 *
 * Only `"none"` opts out. `"client-upload"` and `"generate"` are PREFERENCES
 * the cascade already expresses through its tiers (tier 0 is the client's own
 * files, the generate tier is the last rescue), and honouring them as
 * exclusions would mean a slide whose preferred tier came back empty gets
 * nothing — a self-inflicted downgrade of exactly the kind item M exists to
 * remove.
 */
export function needsImageSourcing(need: NormalisedVisualNeed): boolean {
  return need.source !== "none";
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 5.5, item A3 — the deterministic brief guards
//
// Every guard here is $0, pure and NON-BLOCKING. Each returns a finding the
// workflow hands back to `05` on attempts 1..n−1; on the final attempt the
// findings are recorded on the gate payload and the run ships. "Budgets adapt
// and never hold" is the owner's rule for spend; the same rule applies to a
// brief the writer got wrong, because the alternative to a mediocre subject
// line is not a better one, it is no post.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Nouns a photo library cannot return a picture OF.
 *
 * Every entry is a thing a slide can be ABOUT and nothing can be a photograph
 * of. "Precision" and "permanence" are here because they are the two words the
 * karoslabs cover's `why` used to justify a grade, and a writer asked for a
 * subject line who has been thinking in those terms will write them into
 * `subject.noun` next.
 *
 * Deliberately NOT here: "scale", "landscape", "field", "network", "chain",
 * "pipeline". Each of them names something a camera can point at, and a
 * denylist that refuses a literal reading of a word is a denylist that starts
 * costing correct briefs — the precise failure mode
 * `instagram-floor-candidates-falsified` records for three dead separators.
 */
export const ABSTRACT_NOUN_DENYLIST: readonly string[] = [
  "precision",
  "permanence",
  "trust",
  "momentum",
  "innovation",
  "synergy",
  "transformation",
  "alignment",
  "agility",
  "resilience",
  "efficiency",
  "excellence",
  "disruption",
  "empowerment",
  "connectivity",
  "complexity",
  "clarity",
  "ambition",
  "velocity",
  "credibility",
  "authority",
  "confidence",
  "mindset",
  "potential",
  "opportunity",
  "scalability",
  "productivity",
  "transparency",
  "accountability",
  "sustainability",
  "optimisation",
  "optimization",
  "digitalisation",
  "digitalization",
];

/**
 * Words that turn `why` from a claim into a mood board.
 *
 * `why` is re-specified by copy prompt `@21` as THE SLIDE'S CLAIM — the thing
 * the picture has to be evidence for. The karoslabs cover wrote *"long-exposure
 * infrastructure signals precision and permanence"*, and the vet then did
 * exactly what it was told: it read the grade as the load-bearing clause and
 * refused every photograph that lacked it, saying so in its own `reason`.
 *
 * Matched per word, with the -s/-ed/-ing forms enumerated rather than stemmed:
 * a stemmer would also catch "signal" inside "signalling equipment", which is
 * a real subject a telecoms client could legitimately brief.
 */
export const MOOD_WORD_DENYLIST: readonly string[] = [
  "signal",
  "signals",
  "signalling",
  "signaling",
  "signalled",
  "signaled",
  "evoke",
  "evokes",
  "evoking",
  "convey",
  "conveys",
  "conveying",
  "connote",
  "connotes",
  "atmosphere",
  "atmospheric",
  "mood",
  "vibe",
  "aesthetic",
  "ambience",
  "ambiance",
  "gravitas",
  "feel",
  "feeling",
];

/** Phrases, not words — "a sense of" is three tokens and is the single most common way a `why` dissolves into mood. */
export const MOOD_PHRASE_DENYLIST: readonly string[] = ["a sense of", "a feeling of", "reads as", "speaks to", "hints at", "suggests a"];

/** What a brief guard reports. Shaped like `DefaultRenderRuleFailure` so the workflow's existing finding channels carry it unchanged. */
export interface SceneBriefFinding {
  slide: number;
  /** Which guard fired — stable ids, so a gate payload can be diffed across runs. */
  ruleId: "scene:abstract-subject" | "scene:mood-why" | "scene:unresolvable-entity" | "scene:person-needs-illustration";
  /** The offending word or ref, named. A finding the writer cannot act on is a finding that costs an attempt for nothing. */
  offender: string;
  reason: string;
}

/** A `why` that reads as a mood board, or `undefined`. Exported for the test that pins the denylist against the karoslabs evidence. */
export function moodWordIn(why: string): string | undefined {
  const text = lower(why);
  const phrase = MOOD_PHRASE_DENYLIST.find((candidate) => text.includes(candidate));
  if (phrase !== undefined) return phrase;
  const set = new Set(MOOD_WORD_DENYLIST);
  return words(text).find((word) => set.has(word));
}

/** An unphotographable noun inside a subject line, or `undefined`. */
export function abstractNounIn(noun: string): string | undefined {
  const set = new Set(ABSTRACT_NOUN_DENYLIST);
  return words(noun).find((word) => set.has(word));
}

/**
 * The entity a subject line points at, or `undefined` when it points at
 * nothing this run recognised.
 *
 * DROPPED, never fabricated. A ref the entity step did not produce is a name
 * the model invented, and turning an invented name into a required search term
 * is how a post about "OpenAI's Atlas team" ends up illustrated with somebody
 * else's product — the same shape of defect `numbers-gate-fed-urls-not-content`
 * taught this repo to guard against by matching against the evidence rather
 * than trusting the draft.
 *
 * Matching is case- and whitespace-insensitive and otherwise exact: a fuzzy
 * match here would resolve "Atlas" to "Atlassian".
 */
export function resolveEntityRef(ref: string | undefined, entityNames: readonly string[]): string | undefined {
  if (ref === undefined) return undefined;
  const wanted = lower(ref);
  return entityNames.find((name) => lower(name) === wanted);
}

/**
 * Every brief guard, over one draft.
 *
 * `entityNames` is `04b3-extract-entities`' surviving output. An EMPTY list is
 * the honest "this run recognised no entity" case and is handled as such: a
 * brief that carries an `entityRef` anyway gets the unresolvable finding, not a
 * pass, because an entity route that goes and searches for a name nothing
 * corroborated is worse than no entity route.
 *
 * `illustrationDeclared` is injected rather than imported: the illustration
 * rule lives in `concept-direction.ts`, which imports half the workflow, and
 * this module imports nothing from it (see the header). `entity-imagery.ts`
 * passes `isDeclaredIllustration` through.
 */
export function checkSceneBriefs(
  copySlides: readonly SceneRuleCopyView[],
  options: {
    entityNames?: readonly string[];
    /** `(needSubjectNoun, scene) => boolean` — whether this brief actually tells the generator to DRAW. */
    illustrationDeclared?: (need: NormalisedVisualNeed) => boolean;
    /** Names of entities this run classified as a person who is not a public figure. Only these need the drawn-likeness path. */
    personEntityNames?: readonly string[];
  } = {},
): SceneBriefFinding[] {
  const entityNames = options.entityNames ?? [];
  const personNames = new Set((options.personEntityNames ?? []).map(lower));
  const findings: SceneBriefFinding[] = [];

  for (const slide of copySlides) {
    const need = normaliseVisualNeed(slide);
    if (!needsImageSourcing(need)) continue;

    // AUTHORED only. A derived noun is this module's own arithmetic, and a
    // finding sent to the writer about it would be unactionable.
    if (need.subject.origin === "authored") {
      const abstract = abstractNounIn(need.subject.noun);
      if (abstract !== undefined) {
        findings.push({
          slide: slide.n,
          ruleId: "scene:abstract-subject",
          offender: abstract,
          reason: `slide ${slide.n}'s subject is "${need.subject.noun}", and "${abstract}" is not something a photograph can be OF — name the thing in front of the camera ("server racks in a data centre"), and put what it means in the headline`,
        });
      }
    }

    if (need.why !== undefined) {
      const mood = moodWordIn(need.why);
      if (mood !== undefined) {
        findings.push({
          slide: slide.n,
          ruleId: "scene:mood-why",
          offender: mood,
          reason: `slide ${slide.n}'s "why" says "${need.why}", and "${mood}" describes an impression rather than the slide's claim — the vet reads "why" to decide which clauses are central, and a mood word there makes the GRADE central (karoslabs 2026-09-16 refused four correct photographs of server racks for lacking a long exposure)`,
        });
      }
    }

    const ref = need.subject.entityRef;
    if (ref !== undefined && resolveEntityRef(ref, entityNames) === undefined) {
      findings.push({
        slide: slide.n,
        ruleId: "scene:unresolvable-entity",
        offender: ref,
        reason: `slide ${slide.n} points its picture at "${ref}", which no fact card in this run names — the ref is dropped and the slide is sourced as ordinary stock; point it at an entity the evidence actually carries, or drop it yourself`,
      });
    }

    // Clause L9, keyed off the field instead of a regex over `scene`. A
    // photoreal generated picture of a private individual is forbidden
    // outright; a DRAWN one, with the style named in the text the generator
    // actually receives, is approved and is often the right call.
    if (need.source === "generate" && ref !== undefined && personNames.has(lower(ref)) && options.illustrationDeclared?.(need) !== true) {
      findings.push({
        slide: slide.n,
        ruleId: "scene:person-needs-illustration",
        offender: ref,
        reason: `slide ${slide.n} asks to GENERATE a picture of ${ref}, a person this run did not classify as a public figure — a generated likeness must be drawn, with the illustration style named in the scene the generator is handed, never rendered as a photograph`,
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// `default:no-image-means-device` — where items L, M and R meet
// ─────────────────────────────────────────────────────────────────────────

export const NO_IMAGE_MEANS_DEVICE_RULE_ID = "default:no-image-means-device";

/**
 * The fifth default render rule.
 *
 * Item R hands the writer a lever that removes a slide's picture entirely,
 * and a lever that cheap needs a floor under it or it becomes the cheapest
 * way to write a carousel: six slides of `source: "none"` is six headlines on
 * flat ground, which is the defect item L measures in pixels and item M
 * redesigned the archetypes to make structurally impossible. Deterministic
 * and pre-render, like its four siblings, so a carousel that breaks it goes
 * back to the writer having spent nothing.
 *
 * Shaped as a `StyleRule` (`{ id, check, description }`) without importing
 * the type — see this module's header for why nothing is imported from the
 * workflow here.
 */
export const NO_IMAGE_MEANS_DEVICE_RULE: { id: string; check: "render"; description: string } = {
  id: NO_IMAGE_MEANS_DEVICE_RULE_ID,
  check: "render",
  description:
    'A slide whose scene brief chose `source: "none"` has no image sourced for it at all, so it must carry a number device (figure, figure_pair, bars, timeline, versus, unit_grid) or render through an archetype that IS one (stat_callout, comparison_card, quote_card, list_takeaway, cover, closer). Choosing no picture and then setting a headline on bare ground is not a typographic slide, it is an empty one.',
};

/**
 * Archetypes that carry the frame on their own, by template basename.
 *
 * MIRRORS `DEVICE_TEMPLATE_BASENAMES` in `visual-qa-pre-checks.ts`, which is
 * module-private there and cannot be imported here without closing a cycle
 * (module header). `__tests__/scene-brief.test.ts` pins the two together
 * behaviourally — for every name below it asserts the real
 * `checkDefaultRenderRules` accepts that archetype as a cover with no hero
 * and no device, and that `headline-focus` and a client base template are
 * refused — so adding or removing a name on either side fails a test instead
 * of quietly widening this rule.
 *
 * `photo` and `text_only` are absent for the reason they are absent there:
 * they route to the CLIENT's own configured `slideTemplate`, a file this repo
 * does not control and cannot assume carries anything.
 */
export const DEVICE_BEARING_ARCHETYPES: ReadonlySet<string> = new Set(["stat-callout", "comparison-card", "quote-card", "list-takeaway", "cover", "closer"]);

/** `templateFileName("custom_x")` → `custom-x.html`; the prefix is the only thing a template path tells us about a model-authored archetype. */
const CUSTOM_TEMPLATE_PREFIX = "custom-";

/** Restated from `slides-data.ts`'s `INVERTED_TEMPLATE_SUFFIX` (cycle, again); pinned against the export in this module's test. */
const INVERTED_SUFFIX = "-inv";

/**
 * The archetype a rendered slide's template path names — the last segment,
 * without its extension, without the ground/fg-inversion suffix.
 *
 * Behaviourally identical to `templateBasename` in `visual-qa-pre-checks.ts`
 * and pinned against it over a table of paths in this module's test. Exported
 * ONLY so that pin can call it; every other caller should use that one.
 */
export function archetypeOfTemplate(template: string): string {
  const file = template.split(/[\\/]/).pop() ?? template;
  const stem = file.replace(/\.[^.]+$/u, "");
  return stem.endsWith(INVERTED_SUFFIX) ? stem.slice(0, -INVERTED_SUFFIX.length) : stem;
}

/** One assembled slide, as this rule reads it — structurally satisfied by `Slide` from `@agent-engine/tool-karos-publish`. */
export interface SceneRuleSlideView {
  n: number;
  template: string;
  fields?: Record<string, string>;
  images?: Record<string, string>;
  htmlFragments?: Record<string, string>;
}

/** One drafted slide, as this rule reads it — structurally satisfied by `InstagramSlideCopy`. */
export interface SceneRuleCopyView {
  n: number;
  visualNeed: VisualNeedField;
}

export interface NoImageMeansDeviceResult {
  /** Deterministic failures, each naming its slide, in `DefaultRenderRuleFailure`'s shape. */
  failures: Array<{ ruleId: string; slide: number; reason: string }>;
  /**
   * Slides code cannot decide — a model-authored `custom` archetype, whose
   * markup may well BE a device and whose template path cannot say. Returned
   * as notes rather than `StyleRule`s so the caller attaches them with its own
   * `withNote`, which is the one place the rule text and its note are joined.
   */
  residue: Array<{ slide: number; note: string }>;
}

/** Does this rendered slide put anything other than type on the canvas? */
function carriesStructure(slide: SceneRuleSlideView, archetype: string): boolean {
  const fragments = slide.htmlFragments ?? {};
  // A device, a closer's recap strip and a list's rows are all designed blocks
  // the reader looks at, and they live in `htmlFragments` for the same reason
  // (a variable number of children the renderer cannot loop over) —
  // `countContentElements` counts all three the same way.
  if ((fragments["device"] ?? "").trim().length > 0) return true;
  if ((fragments["recap"] ?? "").trim().length > 0) return true;
  if ((fragments["itemRows"] ?? "").trim().length > 0) return true;
  // A hero that arrived anyway settles the question this rule was asking. The
  // writer said "no picture" and the cascade found one (a client upload the
  // vet moved onto this slide is the realistic path); the slide is not empty,
  // and failing it here would send a draft back over a picture it HAS.
  if ((slide.images?.["hero"] ?? "").trim().length > 0) return true;
  return DEVICE_BEARING_ARCHETYPES.has(archetype);
}

/**
 * The rule's deterministic half, run on the assembled slides-data at `07h`
 * exactly like its four siblings — after `resolveLayout` has decided which
 * template each slide really renders through, and before any render is paid
 * for.
 *
 * A drafted slide with no rendered counterpart is skipped rather than failed:
 * the carousel it belongs to is the one being checked, and a missing entry is
 * `checkSlidesData`'s finding, not this rule's.
 */
export function checkNoImageMeansDevice(slides: readonly SceneRuleSlideView[], copySlides: readonly SceneRuleCopyView[]): NoImageMeansDeviceResult {
  const failures: NoImageMeansDeviceResult["failures"] = [];
  const residue: NoImageMeansDeviceResult["residue"] = [];
  const rendered = new Map(slides.map((slide) => [slide.n, slide]));

  for (const copySlide of copySlides) {
    const need = normaliseVisualNeed(copySlide);
    if (need.source !== "none") continue;
    const slide = rendered.get(copySlide.n);
    if (slide === undefined) continue;
    const archetype = archetypeOfTemplate(slide.template);
    if (archetype.startsWith(CUSTOM_TEMPLATE_PREFIX)) {
      residue.push({
        slide: copySlide.n,
        note: `slide ${copySlide.n} chose no image and renders through a model-authored custom archetype; judge whether its markup carries a designed block rather than a headline on bare ground`,
      });
      continue;
    }
    if (carriesStructure(slide, archetype)) continue;
    failures.push({
      ruleId: NO_IMAGE_MEANS_DEVICE_RULE_ID,
      slide: copySlide.n,
      reason:
        `slide ${copySlide.n} set its scene brief's source to "none", so no image is sourced for it, but it renders through "${slide.template}" with no device, no recap strip and no rows — ` +
        "give the slide a device (figure, figure_pair, bars, timeline, versus, unit_grid), set it as a stat_callout, comparison_card, quote_card or list_takeaway, or choose a real source for its scene",
    });
  }

  return { failures, residue };
}
