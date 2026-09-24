import type { LicenseConfidence, MediaRoute } from "@agent-engine/tool-karos-media";
import { z } from "zod";
import { ILLUSTRATION_STYLES, L9_PHOTOREAL_CUES } from "./concept-direction.js";
import type { NormalisedVisualNeed } from "./scene-brief.js";
// The licence VOCABULARY lives in `types.ts` (see its own note) because
// `ImageSelectionSchema` needs it and this module cannot be on that file's
// import path. The POLICY — what each class is admissible for, and what it
// obliges us to print — lives here, with the commentary that justifies it.
import { LicenceClassSchema, type LicenceClass } from "./types.js";

export { LicenceClassSchema };
export type { LicenceClass };

/**
 * Phase 5.5, item A2 — THE ENTITY ROUTE.
 *
 * ## What this is, and what it is NOT
 *
 * The brief says `prompts/instagram-copy` §6 forbids naming real people and
 * brands in generated images. **It does not, and it never did.** `@20`
 * §6 says, verbatim, *"A public figure who IS the subject appears, when the
 * picture is retrieved"* and *"`source: "generate"`: a recognisable figure may
 * appear, DRAWN"*, with the `illustrationStyle` list. Only PHOTOREAL
 * generation of a real person is forbidden, and that is the correct line and
 * it stays exactly where it is.
 *
 * So the policy is already right and **the plumbing is what is missing**. A
 * post about ChatGPT was never refused permission to show ChatGPT; nothing
 * ever went and got a picture of it. `media.harvestArticleImages` and
 * `media.screenshotPage` have been registered in `karos-media` the whole time
 * and the Instagram workflow calls neither — `grep -c` over
 * `create-instagram-agent-workflow.ts` returns 0 for both. Meanwhile
 * `MEDIA_ROUTES` is `["named_venue", "mood", "default"]`: there has never been
 * a route whose job is "a picture OF this named thing".
 *
 * This module is the decision half of that route: which entities a run
 * recognised, which of them survive being checked against the evidence, in
 * what order their pictures are looked for, and what licence class each
 * candidate arrives under. It is pure — no clock, no I/O, no randomness — for
 * the same reason `style-lock.ts` is: the workflow steps that execute the plan
 * are the part that can fail, and the part that DECIDES should be replayable
 * from a checkpoint and testable without a network.
 *
 * ## The rights policy, stated once, in the place a reader will look for it
 *
 * - **Trademarks and product surfaces.** Showing a real product, interface or
 *   logo as the SUBJECT OF COMMENTARY is nominative use and needs no consent
 *   record. Generating a brand mark INTO a scene still requires
 *   `permittedMarks` from `consent.json`. Unchanged by this phase.
 * - **Public figures.** Retrieved editorial photography is admissible for
 *   commentary. `editorial-only` is therefore a licence class we CARRY rather
 *   than one we refuse — but it is inadmissible on a post the client brief
 *   marks promotional, which is what `licenceAdmissible` decides.
 * - **Attribution.** An `attributable` selection MUST render its credit. The
 *   vet has recorded `license` per selection since the parity audit and
 *   nothing has ever printed it; `creditLineFor` is the line, and it goes into
 *   the slide's existing `sourceLine` slot. That is a live rights defect, not
 *   a nicety.
 * - **Generated likeness.** Photoreal generation of a real person stays
 *   forbidden, forever. A DRAWN likeness with a declared style from
 *   `ILLUSTRATION_STYLES` is approved. `00e-check-likeness-consent` narrows to
 *   what it is actually for — see `needsLikenessConsent`.
 */

// ─────────────────────────────────────────────────────────────────────────
// What `04b3-extract-entities` returns
// ─────────────────────────────────────────────────────────────────────────

/**
 * The six kinds, and the list is closed on purpose: each one routes
 * differently. A `person` gates the likeness path, a `place` is the one kind
 * `google_places` can answer, a `work` (a paper, a film, a report) is the one
 * kind whose best picture is usually its own cover.
 */
export const ENTITY_KINDS = ["product", "company", "person", "event", "place", "work"] as const;
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const RecognisedEntitySchema = z.object({
  /** As the evidence writes it. `groundEntities` requires this string to appear verbatim in a card or the angle. */
  name: z.string().min(1).max(80),
  kind: EntityKindSchema,
  /**
   * The entity's own site, when a fact card cited it. NEVER guessed — a
   * guessed domain is a request this pipeline would then make to a stranger,
   * and `openai.com` guessed for "OpenAI" is right exactly often enough to
   * make the wrong ones invisible.
   */
  officialDomain: z.string().max(120).optional(),
  /**
   * True only for a person the cards describe in a public role. Drives the
   * likeness path and nothing else: a `false` here is what turns
   * `00e-check-likeness-consent` back on.
   */
  isPublicFigure: z.boolean(),
  /** Which fact card(s) name it. An entity with no card is dropped by CODE after parse, never by the model's own say-so. */
  cardIds: z.array(z.string().min(1)).min(1).max(8),
  /** 5 = the post is about this thing; 1 = it is mentioned once in passing. Orders the sourcing queue and nothing else. */
  salience: z.number().int().min(1).max(5),
});
export type RecognisedEntity = z.infer<typeof RecognisedEntitySchema>;

/**
 * Eight is the ceiling because the step is a cheap extraction over fact cards,
 * not a knowledge-graph build: past eight the model starts listing every
 * proper noun in the evidence, and `topEntities` only ever carries three
 * forward anyway.
 */
export const EntitySetSchema = z.object({ entities: z.array(RecognisedEntitySchema).max(8).default([]) });
export type EntitySet = z.infer<typeof EntitySetSchema>;

/** How many entities travel into `05` as `namedEntities`. Three: a cover, a turn and a closer is the most a carousel can actually be about. */
export const MAX_ENTITIES_INTO_COPY = 3;

/** One piece of evidence, as the grounding guard reads it. An `AngleFactCard` satisfies it structurally. */
export interface EntityEvidenceCard {
  id?: string;
  claim?: string;
  quote?: string;
  sourceTitle?: string;
}

export interface GroundedEntities {
  kept: RecognisedEntity[];
  /** Every drop, with the name, so a gate payload can show what the model claimed and the evidence did not carry. */
  dropped: Array<{ name: string; why: string }>;
}

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * THE POST-PARSE CODE GUARD.
 *
 * An entity whose `name` does not appear verbatim somewhere in the fact cards
 * or the chosen angle is dropped. This is the same guard shape
 * `numbers-gate-fed-urls-not-content` taught this repo to write: the model is
 * asked to READ the evidence, and code checks that what came back is in it —
 * because the failure mode of an extraction step is not a wrong answer, it is
 * a plausible one.
 *
 * Substring, case- and whitespace-folded, and deliberately not fuzzy. "GPT-5"
 * has to be in the text as "GPT-5"; a fuzzy match would resolve "Atlas" to
 * "Atlassian" and then go and search for the wrong company's press kit.
 */
export function groundEntities(entities: readonly RecognisedEntity[], evidence: { cards?: readonly EntityEvidenceCard[]; angle?: string }): GroundedEntities {
  const haystack = fold(
    [...(evidence.cards ?? []).flatMap((card) => [card.claim ?? "", card.quote ?? "", card.sourceTitle ?? ""]), evidence.angle ?? ""].join("  "),
  );
  const kept: RecognisedEntity[] = [];
  const dropped: GroundedEntities["dropped"] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    const name = fold(entity.name);
    if (name.length === 0) continue;
    if (seen.has(name)) {
      dropped.push({ name: entity.name, why: "named twice in one extraction" });
      continue;
    }
    seen.add(name);
    if (!haystack.includes(name)) {
      dropped.push({ name: entity.name, why: "no fact card and no angle names it — an entity the run cannot cite is an entity it must not go looking for pictures of" });
      continue;
    }
    kept.push(entity);
  }
  return { kept, dropped };
}

/** The entities that travel into `05`, most salient first, ties broken by extraction order so the selection is replayable. */
export function topEntities(entities: readonly RecognisedEntity[], limit: number = MAX_ENTITIES_INTO_COPY): RecognisedEntity[] {
  return entities
    .map((entity, index) => ({ entity, index }))
    .sort((a, b) => b.entity.salience - a.entity.salience || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entity);
}

/**
 * Does `00e-check-likeness-consent` have anything to say about this run?
 *
 * Today it fires unconditionally and prints, on every post including ones that
 * name no person at all, that *"drawing another party's mark or a real
 * person's likeness requires an explicit, recorded, named permission"* — which
 * is true, blocking-sounding, and irrelevant to a post about a pricing change.
 * A note that appears on every run is a note a reviewer stops reading, which
 * is the opposite of what a consent check is for.
 *
 * It narrows to the case it is actually for: a person this run did NOT
 * classify as public — a private individual, or the client's own staff.
 */
export function needsLikenessConsent(entities: readonly RecognisedEntity[]): boolean {
  return entities.some((entity) => entity.kind === "person" && !entity.isPublicFigure);
}

/**
 * Does this brief tell the generator to DRAW?
 *
 * Both halves, exactly as `isDeclaredIllustration` requires them for a
 * concept: a style from `ILLUSTRATION_STYLES` has to be named in the text the
 * diffusion model actually receives (`generationPromptFor` is `scene`), and no
 * photoreal cue may sit beside it. Restated here against a scene brief rather
 * than a `Concept` because a visual need has no `illustrationStyle` field —
 * the declaration IS the scene.
 */
export function sceneDeclaresIllustration(need: Pick<NormalisedVisualNeed, "scene">): boolean {
  const scene = fold(need.scene);
  if (!ILLUSTRATION_STYLES.some((style) => scene.includes(fold(style)))) return false;
  return !L9_PHOTOREAL_CUES.some((cue) => scene.includes(fold(cue)));
}

// ─────────────────────────────────────────────────────────────────────────
// Licence classes — what the gate payload shows a human
// ─────────────────────────────────────────────────────────────────────────

/** Licence texts that say "editorial use only" in the several ways the providers write it. */
const EDITORIAL_ONLY_CUES: readonly string[] = ["publisher-owned editorial", "editorial use", "editorial only", "editorial-only", "not for commercial use", "non-commercial", "noncommercial", " nc ", "cc by-nc"];

/**
 * The class for one candidate, from the provider's own `licenseConfidence`
 * plus the licence text it shipped with.
 *
 * The text is read SECOND and can only narrow: a provider that says `blanket`
 * while its own licence line says "editorial use only" is describing its
 * catalogue, not this asset, and the asset wins.
 */
export function licenceClassFor(confidence: LicenseConfidence | string | undefined, licenseText: string | undefined): LicenceClass {
  const text = ` ${fold(licenseText ?? "")} `;
  if (EDITORIAL_ONLY_CUES.some((cue) => text.includes(cue))) return "editorial-only";
  switch (confidence) {
    case "client-supplied":
    case "generated":
    case "blanket":
      return "blanket";
    case "attributable":
      return "attributable";
    default:
      return "unknown";
  }
}

/** What the post is doing with the picture. The client brief's own framing; `commentary` is the default and the honest one for a carousel that analyses a story. */
export type PostUsage = "commentary" | "promotional";

/**
 * May this class ship on this post?
 *
 * `unknown` is refused on both, unchanged — provenance that was never
 * established cannot become established by being needed.
 */
export function licenceAdmissible(licenceClass: LicenceClass, usage: PostUsage): boolean {
  if (licenceClass === "unknown") return false;
  if (licenceClass === "editorial-only") return usage === "commentary";
  return true;
}

/**
 * The credit line an `attributable` selection MUST render, or `undefined` when
 * the class needs none.
 *
 * Routed into the slide's existing `sourceLine` field, which every archetype
 * already sets at `t-micro`. Capped, because `sourceLine` is one line of 22px
 * type and a CC record can carry a paragraph.
 */
export const CREDIT_LINE_MAX_CHARS = 90;

export function creditLineFor(selection: { licenceClass?: LicenceClass | undefined; license?: string | undefined; credit?: string | undefined }): string | undefined {
  // 2026-09-24 (owner ruling): a publisher's own article photograph runs WITH
  // a credit. `instagram-image-vet@10` writes its licence as
  // `Publisher-owned editorial image, credit "<domain>"`; no credit parsed
  // means no line, never a guessed one.
  if (selection.licenceClass === "editorial-only" && /publisher-owned/iu.test(selection.license ?? "")) {
    const publisher = readableCredit(selection.license ?? "");
    return publisher !== undefined && publisher.length <= CREDIT_LINE_MAX_CHARS ? publisher : undefined;
  }
  if (selection.licenceClass !== "attributable") return undefined;
  const basis = (selection.credit ?? readableCredit(selection.license ?? "") ?? selection.license ?? "").replace(/\s+/gu, " ").trim();
  if (basis.length === 0) return undefined;
  return basis.length <= CREDIT_LINE_MAX_CHARS ? basis : `${basis.slice(0, CREDIT_LINE_MAX_CHARS - 1).replace(/\s+\S*$/u, "")}…`;
}

/**
 * The provider's licence record, rewritten as the line a reader expects under
 * a photograph: `Photo: Chris Rand · CC BY-SA 4.0`.
 *
 * Wikimedia and Openverse both record `<licence> — <note>, credit "<name>"`
 * (`karos-media/src/providers/{wikimedia,openverse}.ts`), and the vet copies
 * that string into `license`. Printed raw it reads as a database row
 * (`CC BY-ND 2.0 — commercial use permitted, credit "…"`); the reference
 * accounts print the name and the licence and nothing else. `undefined` when
 * the record is not in that shape, so the caller falls back to the raw text
 * rather than guessing.
 */
function readableCredit(license: string): string | undefined {
  const text = license.replace(/\s+/gu, " ").trim();
  const credit = /credit\s+["“]([^"”]+)["”]/iu.exec(text)?.[1]?.trim();
  if (credit === undefined || credit.length === 0) return undefined;
  const licence = /\b(CC0|CC[\s-]?BY(?:[\s-](?:NC-SA|NC-ND|SA|ND|NC))?(?:\s+\d(?:\.\d)?)?|Public domain)\b/iu.exec(text)?.[1];
  const normalisedLicence = licence?.replace(/^CC[\s-]?BY/iu, "CC BY").replace(/\s+/gu, " ");
  return normalisedLicence ? `Photo: ${credit} · ${normalisedLicence}` : `Photo: ${credit}`;
}

// ─────────────────────────────────────────────────────────────────────────
// The sourcing plan — order matters more than any single source
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which recognised entity a comparison column is about, when it names one
 * (2026-09-23: the Karos Labs reference's Pepsi vs Coca-Cola, each column under
 * its own mark). Only kinds that HAVE a mark, and only a whole-word match: a
 * column labelled "In-house" is nobody, and "Coke" is not "Coca-Cola" unless
 * the evidence named it "Coke". Longest name first, so "OpenAI Codex" beats
 * "OpenAI" for a column that says the former.
 */
export function markEntityForLabel(label: string, entities: readonly RecognisedEntity[]): RecognisedEntity | undefined {
  const text = ` ${fold(label).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return [...entities]
    .filter((e) => e.kind === "company" || e.kind === "product" || e.kind === "work")
    .sort((a, b) => b.name.length - a.name.length)
    .find((e) => {
      const name = fold(e.name).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return name.length > 0 && text.includes(` ${name} `);
    });
}

/** The paths an entity's own public assets actually live behind. Ordered by how likely each is to hold a usable image rather than a PDF. */
export const ENTITY_PRESS_PATHS: readonly string[] = ["/press", "/newsroom", "/media", "/brand"];

export const ENTITY_SOURCE_TIERS = ["media-library", "official-assets", "cited-article", "commons", "stock"] as const;
export type EntitySourceTier = (typeof ENTITY_SOURCE_TIERS)[number];

export interface EntitySourceStep {
  tier: EntitySourceTier;
  /** 0-based, and it is the execution order. The workflow stops as soon as `ENTITY_CANDIDATES_WANTED` candidates exist. */
  order: number;
  /** The keyword query, when this tier searches. */
  query?: string;
  /** The pages to harvest images from, when this tier harvests. */
  urls?: string[];
  /** The `media.findImages` route, when this tier searches an image index. */
  route?: MediaRoute;
  /** A term every hit must NAME. The identification test; see `find-images.ts`'s own `requireTerm`. */
  requireTerm?: string;
  /** False for a person the run did not classify as public — see the ladder's own comment. */
  allowUnknownLicence: boolean;
  /** Why this tier sits here. Carried to the gate payload so a sourcing decision is readable without this file. */
  why: string;
  /**
   * Runs even when earlier tiers already filled the slide's quota. Set on the
   * FACE tier only: a company's mark and its leader's photograph are two
   * different pictures of one subject, and a quota met by three logos would
   * otherwise never let the vet choose between them.
   */
  always?: boolean;
  /**
   * 2026-09-23: this rung searches for the entity's MARK (logo, wordmark),
   * not for a photograph of it. Its candidates render whole on a card
   * (`heroKind: "mark"`), never cropped full-bleed: on 2026-09-23 a black
   * Anthropic wordmark on a transparent ground was picked as a full-bleed hero
   * on a dark slide and the reader saw an empty plate.
   */
  mark?: boolean;
}

/**
 * Two, not one. A single candidate is a candidate the vet has to accept or
 * leave the slide empty, which is the position that produced every one of the
 * 2026-09-16 text plates.
 */
export const ENTITY_CANDIDATES_WANTED = 2;

/**
 * Appended to a mark-rung candidate's description (2026-09-23). The vet reads
 * it (`instagram-image-vet@9` §1b); nothing parses it back — the workflow
 * tracks mark paths itself.
 */
export const MARK_CANDIDATE_TAG = "[kind: brand mark — a logo or wordmark, not a photograph]";

/**
 * A mark that may ship with no credit line: blanket-licensed, or a licence
 * line that says public domain / CC0 (Wikimedia and Openverse file most
 * wordmarks as `attributable` while their licence line reads PD-textlogo).
 * A badge is furniture, and furniture carries no caption.
 */
/**
 * Whether a "<name> logo" search result IS a mark (2026-09-23). The search
 * matches the name, not the kind of picture: on the karoslabs carousel of
 * prep `pubsub-21248870282578044` the badge for a named source held a small
 * photograph, because the first credit-free hit was a photo whose page
 * mentioned the name. A badge needs the provider's own title to call it a
 * logo, wordmark, emblem or icon, or the file to be a vector.
 */
export function looksLikeMark(c: { path: string; description: string }): boolean {
  if (/\.svg$/iu.test(c.path)) return true;
  const title = c.description.split("[")[0] ?? "";
  // A PHOTOGRAPH of a logo is not a logo: the 2026-09-23 karoslabs cover's
  // badge was a Google Places "photo of 'ChatGPT logo'", a street sign.
  if (/photo of|google places|geo-verified/iu.test(title)) return false;
  return /\b(logo|logos|logotype|wordmark|emblem|brand ?mark|icon|symbol)\b/iu.test(title);
}

export function isCreditFreeMark(c: { licenseConfidence?: string; description: string }): boolean {
  return c.licenseConfidence === "blanket" || /\[licence:\s*(?:public domain|pd|cc0)/iu.test(c.description);
}

export interface EntitySourcingInput {
  entity: RecognisedEntity;
  /** The URLs this slide's own fact cards already cite. Tier 2's whole input, and it costs nothing — the run has them. */
  citedUrls?: readonly string[];
  /** Whether this client has a media library to filter at all. Skips tier 0 cleanly rather than planning a lookup against nothing. */
  hasMediaLibrary?: boolean;
  /** The slide's own non-entity search terms, appended to the stock query so the last tier is not the entity name alone. */
  sceneTerms?: readonly string[];
  /**
   * The people a company or product is recognised by, from Wikidata's CEO and
   * founded-by statements (`research.entityPeople`), never from a model's
   * memory. Absent or empty plans exactly the ladder it did before.
   */
  associatedPeople?: ReadonlyArray<{ name: string; role: string }>;
}

/**
 * The ordered tiers for one entity, cheapest and most-identified first.
 *
 * The ranking principle is the one `named_venue` already uses and the one the
 * vet actually scores on: **identification beats licence**. A correctly
 * identified picture of the thing the slide names, needing a credit, is worth
 * more than a beautifully licensed picture of something else — because the
 * second one is the defect the owner named, and the credit is a line of 22px
 * type we can print.
 *
 * - **0 `media-library`** — the client's own files, filtered by entity name.
 *   Free, owned outright, and for a client like geektime it is where the
 *   photographs of their own conference live.
 * - **1 `official-assets`** — the entity's own press/newsroom/media/brand
 *   pages, found with ONE ScrappyCoco `web.search_web` and harvested with
 *   `media.harvestArticleImages`. A real product surface, a real mark in situ.
 *   Only when a fact card gave us the domain: this tier never guesses one.
 * - **2 `cited-article`** — the lead image of the article the slide ALREADY
 *   cites. This is the direct answer to "a post about ChatGPT should show
 *   ChatGPT": the post is built on an article about ChatGPT, and that article
 *   has a picture of it at the top. Same tool execution as tier 1, so $0 more.
 * - **3 `commons`** — the `entity` route (Wikimedia/Openverse first), with the
 *   entity name as a REQUIRED term. Commons is the only source in the chain
 *   whose records name the person, product or event in the file's own
 *   metadata, which is exactly what makes `requireTerm` a real filter there
 *   and a lottery anywhere else.
 * - **4 `stock`** — the ordinary `default` route, entity name first. The
 *   floor, not the answer.
 *
 * `allowUnknownLicence` is false for a person the run did not classify as
 * public, on every tier. An unidentified web image of a private individual is
 * the one candidate class where being wrong is not an editorial mistake.
 */
export function planEntitySourcing(input: EntitySourcingInput): EntitySourceStep[] {
  const { entity } = input;
  const allowUnknownLicence = !(entity.kind === "person" && !entity.isPublicFigure);
  const steps: EntitySourceStep[] = [];
  const push = (step: Omit<EntitySourceStep, "order" | "allowUnknownLicence">): void => {
    steps.push({ ...step, order: steps.length, allowUnknownLicence });
  };

  if (input.hasMediaLibrary === true) {
    push({ tier: "media-library", query: entity.name, why: `the client's own files, filtered by "${entity.name}" — owned outright and free` });
  }

  if (entity.officialDomain !== undefined && entity.officialDomain.trim().length > 0) {
    const domain = entity.officialDomain.trim().replace(/\/+$/u, "");
    push({
      tier: "official-assets",
      query: `${entity.name} press kit`,
      urls: ENTITY_PRESS_PATHS.map((path) => `${domain}${path}`),
      why: `${entity.name}'s own press assets, from the domain a fact card cited — a real product surface rather than a picture of one`,
    });
  }

  const cited = [...new Set((input.citedUrls ?? []).map((url) => url.trim()).filter((url) => url.length > 0))];
  if (cited.length > 0) {
    push({
      tier: "cited-article",
      urls: cited,
      why: "the lead image of the article this slide already cites — the post is built on a story about this entity, and that story has a picture of it",
    });
  }

  // ── A BRAND'S MARK, BEFORE A STRANGER'S PHOTO OF ITS PRODUCT. ──
  //
  // prep `pubsub-21926643455584277` (karoslabs, 2026-09-21) ran this ladder
  // for Coca-Cola and returned, in order: "Share a Coke with ... James -
  // Pershore Road, Stirchley", "one of the Share a Coke cans I bought",
  // "coke", "Coke". Four photographs of a can, from Openverse and Wikimedia,
  // every one honestly matching the query — which was the bare name.
  //
  // The owner: *"אם מדברים על קוקה קולה זה קלאסי לשים את הלוגו שלהם"*, and he
  // is describing how the trade actually works. A post about a company shows
  // that company's MARK; a stranger's snapshot of its packaging is what you
  // reach for when you cannot get the mark.
  //
  // The mark was reachable the whole time. Wikimedia carries brand wordmarks,
  // frequently as `PD-textlogo` — a lettering-only mark is below the
  // threshold of originality for copyright — and this module's own rights
  // policy says the rest: showing a logo as the SUBJECT OF COMMENTARY is
  // nominative use and needs no consent record. Nothing forbade it. Nothing
  // asked for it.
  //
  // Only for the kinds that HAVE a mark. A person does not, an event rarely
  // does, and a query for "Andrej Karpathy logo" would return noise ranked
  // above the press photograph the next rung finds.
  if (entity.kind === "company" || entity.kind === "product" || entity.kind === "work") {
    push({
      tier: "commons",
      query: `${entity.name} logo`,
      route: "entity",
      requireTerm: entity.name,
      mark: true,
      why: `${entity.name}'s own mark — what a reader recognises the company BY, and nominative use as the subject of commentary. Ahead of the bare-name search, which returns photographs of products rather than the brand`,
    });
  }

  // ── AND THE FACE THE COMPANY IS KNOWN BY (2026-09-23). ──
  //
  // The owner, on a post about ChatGPT that shipped a desk-lamp stock photo:
  // *"you can add a picture of them or of Sam Altman"*. A company's mark is
  // what a reader recognises it BY; its leader is who the story is often
  // really about. The names come from Wikidata's CEO and founded-by
  // statements, so this is a record rather than a guess, and it runs even
  // when the mark already filled the quota: the vet chooses between two
  // kinds of picture instead of never seeing the second.
  if (entity.kind === "company" || entity.kind === "product") {
    for (const person of (input.associatedPeople ?? []).slice(0, 1)) {
      steps.push({
        tier: "commons",
        query: person.name,
        route: "entity",
        requireTerm: person.name,
        // A company's CEO or founder holds a public office by definition.
        allowUnknownLicence: true,
        order: steps.length,
        always: true,
        why: `${person.name}, ${entity.name}'s ${person.role} (Wikidata), the face the story is recognised by; searched even when ${entity.name}'s mark already filled the slide, so the vet can choose between the two`,
      });
    }
  }

  push({
    tier: "commons",
    query: entity.name,
    route: "entity",
    requireTerm: entity.name,
    why: "Wikimedia/Openverse name their subjects in the file's own metadata, which is what makes a required term a filter rather than a lottery",
  });

  const sceneTerms = (input.sceneTerms ?? []).filter((term) => term.trim().length > 0).slice(0, 2);
  push({
    tier: "stock",
    query: [entity.name, ...sceneTerms].join(" "),
    route: "default",
    why: "the floor: ordinary stock with the entity name leading the query, so a generic frame at least argues for the right subject",
  });

  return steps;
}

// ─────────────────────────────────────────────────────────────────────────
// Baked-in text — the deel keyboard, refused for $0
// ─────────────────────────────────────────────────────────────────────────

/**
 * `media.inspectImages` already writes what it can read in the frame into the
 * candidate description, as `text in image: A / B / C`. Nothing has ever read
 * it back.
 *
 * thepitchbydeel's slide 4 of 2026-09-16 shipped a stock photograph of a neon
 * keyboard whose screen reads `UPTIME: 5:34:22:11`, `CONNECTION: SECURE`,
 * `DATA PACKETS`, and — under the headline — `ENTER COMMAND:`. Invented words
 * in somebody else's picture, at display size, on a slide about scoring
 * criteria.
 */
export function legibleTextIn(description: string): string[] {
  const match = /text in image:\s*([^\]\n]+)/iu.exec(description);
  if (match === null) return [];
  // `;` separates the vision note's own FIELDS — a real note reads
  // `…; text in image: A / B; screenshot/document` — so the strings end at the
  // first one. Without this cut, "screenshot/document" arrives as two more
  // pieces of legible text and the screen starts refusing candidates for an
  // annotation rather than for anything in the frame.
  const field = (match[1] ?? "").split(";")[0] ?? "";
  return field
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Text we are happy to see: the entity's own wordmark, or the client's.
 *
 * Folded and compared BOTH ways — a frame reading "OPENAI" under an entity
 * called "OpenAI" is a match, and so is a frame reading "NETGEAR" under an
 * entity called "Netgear". A mark that is a substring of the legible text
 * counts, because a photograph of a product shows the product's name as part
 * of a longer label far more often than alone.
 */
function isWordmark(text: string, allowedMarks: readonly string[]): boolean {
  const folded = fold(text);
  return allowedMarks.some((mark) => {
    const foldedMark = fold(mark);
    return foldedMark.length > 0 && (folded.includes(foldedMark) || foldedMark.includes(folded));
  });
}

export interface TextScreenVerdict<T> {
  kept: T[];
  /** Refused, each with the string in the frame that refused it. */
  refused: Array<{ candidate: T; text: string }>;
  /**
   * True when EVERY candidate carried foreign text and the pool would
   * otherwise be empty, so the screen demoted instead of refusing.
   *
   * This limb is not a softening, it is the rule that keeps the screen from
   * becoming the defect it exists to fix: an empty pool is a text plate, and a
   * text plate is what the owner complained about. A screen that can empty a
   * pool is a screen that trades one defect for a worse one.
   */
  keptAsLastResort: boolean;
}

/**
 * Refuse every candidate whose frame carries legible text that is not a
 * wordmark we accept — unless that would leave nothing, in which case the
 * pool is kept and the caller is told.
 */
export function screenLegibleText<T extends { description: string }>(candidates: readonly T[], allowedMarks: readonly string[]): TextScreenVerdict<T> {
  const kept: T[] = [];
  const refused: Array<{ candidate: T; text: string }> = [];

  for (const candidate of candidates) {
    const foreign = legibleTextIn(candidate.description).find((text) => !isWordmark(text, allowedMarks));
    if (foreign === undefined) kept.push(candidate);
    else refused.push({ candidate, text: foreign });
  }

  if (kept.length === 0 && refused.length > 0) {
    return { kept: refused.map((row) => row.candidate), refused: [], keptAsLastResort: true };
  }
  return { kept, refused, keptAsLastResort: false };
}
