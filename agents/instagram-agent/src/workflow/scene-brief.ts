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

/**
 * The scene brief itself.
 *
 * `why` is REQUIRED and it is not decoration. It is the field the vet reads
 * to decide which clauses of `scene` are central and which are decorative
 * (`instagram-image-vet@4` §1), and it is the only place the writer states
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

/** The shape every consumer reads. `why` is absent exactly when the value arrived as a legacy bare string. */
export interface NormalisedVisualNeed {
  /** What is in frame. The generation prompt, and the subject half of the vet's question. */
  scene: string;
  /** Why the slide is weaker without it. The vet's central-vs-decorative discriminator. */
  why?: string;
  source: SceneSource;
  /** Always non-empty when `scene` is — authored, or derived by `keywordsFromScene`. */
  searchTerms: string[];
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
  const searchTerms = value.searchTerms !== undefined && value.searchTerms.length > 0 ? [...value.searchTerms] : keywordsFromScene(value.scene);
  return { scene: value.scene, why: value.why, source: value.source, searchTerms };
}

/**
 * A bare string is a scene with no stated purpose, sourced from stock — which
 * is exactly what it meant before this split, so every existing fixture and
 * checkpoint keeps its behaviour to the letter. The keyword query becomes
 * BETTER than it was: today the whole string is the query, and the truncation
 * below is what the Swedish-kiosk failure needed.
 */
function legacyNeed(scene: string): NormalisedVisualNeed {
  return { scene, source: "stock", searchTerms: keywordsFromScene(scene) };
}

/**
 * The query string `05b-source-images` puts in `needs[].query`.
 *
 * Falls back to the raw scene only when tokenisation produced nothing at all
 * (a scene of pure punctuation) — an empty query would make the harvester
 * return its own arbitrary top results, which is the one outcome worse than
 * a bad query.
 */
export function retrievalQueryFor(need: NormalisedVisualNeed): string {
  const query = need.searchTerms.join(" ").trim();
  return query.length > 0 ? query : need.scene.trim();
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
export function generationPromptFor(need: NormalisedVisualNeed): string {
  return need.scene;
}

/** What `06-vet-images` gets per slide, alongside the headline and body it already receives. */
export function vetSubjectFor(need: NormalisedVisualNeed): { scene: string; why?: string } {
  return need.why === undefined ? { scene: need.scene } : { scene: need.scene, why: need.why };
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
