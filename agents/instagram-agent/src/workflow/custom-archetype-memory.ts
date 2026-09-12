import { createHash } from "node:crypto";

/**
 * RFC-13 Phase 2, item O — THE POOL THAT GROWS.
 *
 * `customArchetype` stops being "a rare tool" (see `instagram-copy@14` §20),
 * which means runs will now author layouts regularly. The half that makes
 * that worth doing is this one: a design that shipped through the HUMAN gate
 * twice without an edit is promoted into that client's template pool, so the
 * next run can pick it the ordinary way instead of re-authoring it from
 * scratch. That is the "generator that updates the pool" the owner asked for.
 *
 * ## No parallel scoring mechanism
 *
 * Promotion goes through the EXISTING `promoteTemplate`, at a score set here
 * and justified below, and `reviewTemplate`/`QUALITY_DELTA` move it from
 * there exactly as they move a human-promoted row. This module decides ONLY
 * *whether* and *at what score*; it holds no store handle and performs no
 * write, so it is pure and testable without a registry.
 *
 * ## Why `bodyHash` is load-bearing
 *
 * `archetypeId` is model-authored. A run reusing `custom_pull_rail` next week
 * for a completely different layout would otherwise have two unrelated
 * designs counted as one, and the thing promoted would be neither of them.
 * The hash covers `bodyHtml` + `css`, which is the whole design; a mismatch
 * resets the count to 1 and records `resetReason`, which surfaces on the
 * gate so a reviewer can see why a design they liked twice was not promoted.
 */

/** The beliefs key the per-client custom-archetype ledger lives under. Sibling of `RUN_BUDGET_BELIEF_KEY` and `SKELETON_BELIEF_KEY` in the same document. */
export const CUSTOM_ARCHETYPE_BELIEF_KEY = "instagramCustomArchetypes";

/**
 * How many clean ships earn a promotion.
 *
 * Two. One approval is a person not objecting; two approvals of the same
 * design, with no edit to its slide either time, is a person choosing it. One
 * would make every authored layout permanent, which is exactly how a pool
 * fills with designs nobody actually wanted.
 */
export const AUTO_PROMOTE_CLEAN_SHIPS = 2;

/**
 * The opening score an auto-promoted design gets.
 *
 * Above `DEFAULT_QUALITY_BY_SOURCE.ai_generated` (40), which prices a
 * layout one reviewer ticked once: two clean human ships is more evidence
 * than one tick. Below a Template Studio row's 65 (item N), because a studio
 * row was designed against measured formats and validated in RTL against the
 * interest floor with margin, while this one only survived two live gates.
 * Below the bundled floor of 70, because the bundled set is the only one
 * whose rendering has been verified end to end.
 */
export const AUTO_PROMOTE_QUALITY_SCORE = 55;

/**
 * Deliberately queryable. `actor` is stored on the promotion's feedback row,
 * so a human can ask the registry which designs nobody explicitly chose —
 * which is the mitigation for the one real risk here (a reviewer who always
 * approves promotes faster than one who edits).
 */
export const AUTO_PROMOTE_ACTOR = "auto:two-clean-ships";

/**
 * How many designs are tracked per client.
 *
 * Twenty: enough that a client with a few live custom designs never loses a
 * half-earned one to a burst of one-off experiments, small enough that the
 * beliefs document stays a document. Oldest-shipped is dropped first, and a
 * design already promoted is kept (its record is the audit trail).
 */
export const CUSTOM_ARCHETYPE_HISTORY_LIMIT = 20;

export interface CustomArchetypeRecord {
  /** The registry id, `customArchetypeTemplateId(clientSlug, archetypeId)` — the same id `persistReviewFeedback` uses. */
  templateId: string;
  archetypeId: string;
  name: string;
  /** sha256 of `bodyHtml` + `css`. See this module's header for why. */
  bodyHash: string;
  cleanShips: number;
  /** The runs that earned the current count, oldest first. */
  runIds: string[];
  lastShippedAt: string;
  promotedAt?: string;
  /** The run ids named in the promotion's note. Present once promoted. */
  promotedFromRunIds?: string[];
  /** Why the count went back to 1. Surfaced on the gate. */
  resetReason?: string;
}

export interface CustomArchetypeHistory {
  version: 1;
  /** Oldest `lastShippedAt` first. */
  records: CustomArchetypeRecord[];
}

export const EMPTY_CUSTOM_ARCHETYPE_HISTORY: Readonly<CustomArchetypeHistory> = { version: 1, records: [] };

/** One design that shipped clean on one run. */
export interface CleanShip {
  runId: string;
  at: string;
  templateId: string;
  archetypeId: string;
  name: string;
  bodyHash: string;
}

/** A design that rendered on this run, and where. */
export interface ShippedCustomArchetype {
  templateId: string;
  archetypeId: string;
  name: string;
  bodyHtml: string;
  css: string;
  /** Every slide number this design rendered on this run. */
  slides: number[];
}

/** What `09b` knows about the round that just shipped. */
export interface CleanShipInput {
  runId: string;
  at: string;
  /** The run actually delivered. A held or failed run earns nothing. */
  delivered: boolean;
  /** The gate decision. Only `approve` counts — a `revise` round is not a ship. */
  decision: string;
  /**
   * Slide numbers the reviewer edited a FIELD on.
   *
   * Per-slide rather than the boolean `hasReviewEdits`, deliberately: a
   * reviewer fixing a typo on slide 5 has said nothing about the custom
   * design on slide 2, and counting that as evidence against it would make
   * the bar unreachable on any post anyone touched. A caption edit is not a
   * slide edit and does not appear here at all.
   */
  editedSlides: readonly number[];
  /** The reviewer's per-template verdicts. A `revise` on this design's id disqualifies the ship outright. */
  templateFeedback: readonly { templateId: string; verdict: string }[];
  shipped: readonly ShippedCustomArchetype[];
}

/** sha256 of the design itself, hex. `css` is included because a restyle IS a different design. */
export function customArchetypeBodyHash(bodyHtml: string, css: string): string {
  return createHash("sha256").update(bodyHtml).update("\u0000").update(css).digest("hex");
}

/**
 * Which of this run's custom designs shipped CLEAN, and why the others did
 * not.
 *
 * A clean ship is all four of: the run delivered, the gate decision was
 * `approve`, the reviewer edited no field of that design's slide, and no
 * `templateFeedback` entry for that `templateId` carried `revise`.
 *
 * The `skipped` reasons are returned rather than dropped so the gate can say
 * "this design is at 1 of 2 clean ships because slide 2 was edited" instead
 * of silently never promoting.
 */
export function cleanShipsFor(input: CleanShipInput): { ships: CleanShip[]; skipped: { templateId: string; reason: string }[] } {
  const ships: CleanShip[] = [];
  const skipped: { templateId: string; reason: string }[] = [];
  if (!input.delivered) {
    return { ships, skipped: input.shipped.map((s) => ({ templateId: s.templateId, reason: "the run did not deliver" })) };
  }
  if (input.decision !== "approve") {
    return { ships, skipped: input.shipped.map((s) => ({ templateId: s.templateId, reason: `the gate decision was "${input.decision}", not approve` })) };
  }
  const edited = new Set(input.editedSlides);
  const revised = new Set(input.templateFeedback.filter((f) => f.verdict === "revise").map((f) => f.templateId));
  for (const design of input.shipped) {
    const touched = design.slides.filter((n) => edited.has(n));
    if (touched.length > 0) {
      skipped.push({ templateId: design.templateId, reason: `the reviewer edited slide ${touched.join(", ")}, which this design renders` });
      continue;
    }
    if (revised.has(design.templateId)) {
      skipped.push({ templateId: design.templateId, reason: "the reviewer's template verdict on this design was revise" });
      continue;
    }
    ships.push({
      runId: input.runId,
      at: input.at,
      templateId: design.templateId,
      archetypeId: design.archetypeId,
      name: design.name,
      bodyHash: customArchetypeBodyHash(design.bodyHtml, design.css),
    });
  }
  return { ships, skipped };
}

/** Reads the ledger back out of a beliefs document, tolerating anything a past version or a hand edit left there — same contract as `readBudgetHistory`. */
export function readCustomArchetypeHistory(beliefs: unknown): CustomArchetypeHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[CUSTOM_ARCHETYPE_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { version: 1, records: [] };
  const rows = (raw as Record<string, unknown>)["records"];
  const records = Array.isArray(rows)
    ? rows.flatMap((row): CustomArchetypeRecord[] => {
        if (row === null || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        if (typeof r["templateId"] !== "string" || typeof r["bodyHash"] !== "string") return [];
        const runIds = Array.isArray(r["runIds"]) ? (r["runIds"] as unknown[]).filter((s): s is string => typeof s === "string") : [];
        const promotedFrom = Array.isArray(r["promotedFromRunIds"])
          ? (r["promotedFromRunIds"] as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined;
        const cleanShips = typeof r["cleanShips"] === "number" && Number.isFinite(r["cleanShips"]) ? Math.max(0, Math.floor(r["cleanShips"])) : runIds.length;
        return [
          {
            templateId: r["templateId"],
            archetypeId: typeof r["archetypeId"] === "string" ? r["archetypeId"] : "",
            name: typeof r["name"] === "string" ? r["name"] : "",
            bodyHash: r["bodyHash"],
            cleanShips,
            runIds,
            lastShippedAt: typeof r["lastShippedAt"] === "string" ? r["lastShippedAt"] : "",
            ...(typeof r["promotedAt"] === "string" ? { promotedAt: r["promotedAt"] } : {}),
            ...(promotedFrom !== undefined && promotedFrom.length > 0 ? { promotedFromRunIds: promotedFrom } : {}),
            ...(typeof r["resetReason"] === "string" ? { resetReason: r["resetReason"] } : {}),
          },
        ];
      })
    : [];
  return { version: 1, records: records.slice(-CUSTOM_ARCHETYPE_HISTORY_LIMIT) };
}

/**
 * The ledger after one more clean ship, plus the design to promote when this
 * ship was the one that earned it.
 *
 * Pure and IDEMPOTENT ON `runId`: `09b`/`09f` are checkpointed steps whose
 * belief write is best-effort, so a resumed delivery replays them. Without
 * this a resume would count the same run twice and could promote a design on
 * its FIRST real ship. `promotedAt` is the second half of the same guard: a
 * design already promoted never promotes again, so the third clean ship
 * moves the score through `reviewTemplate`'s ordinary delta rather than
 * resetting it.
 */
export function recordCleanShip(
  history: CustomArchetypeHistory,
  ship: CleanShip,
): { history: CustomArchetypeHistory; promote?: CustomArchetypeRecord } {
  const existing = history.records.find((r) => r.templateId === ship.templateId);
  const others = history.records.filter((r) => r.templateId !== ship.templateId);

  if (existing === undefined) {
    const record: CustomArchetypeRecord = {
      templateId: ship.templateId,
      archetypeId: ship.archetypeId,
      name: ship.name,
      bodyHash: ship.bodyHash,
      cleanShips: 1,
      runIds: [ship.runId],
      lastShippedAt: ship.at,
    };
    return { history: { version: 1, records: [...others, record].slice(-CUSTOM_ARCHETYPE_HISTORY_LIMIT) } };
  }

  // Already counted — a replayed 09b. Nothing changes, and in particular
  // nothing promotes a second time.
  if (existing.runIds.includes(ship.runId)) return { history };

  if (existing.bodyHash !== ship.bodyHash) {
    const record: CustomArchetypeRecord = {
      templateId: ship.templateId,
      archetypeId: ship.archetypeId,
      name: ship.name,
      bodyHash: ship.bodyHash,
      cleanShips: 1,
      runIds: [ship.runId],
      lastShippedAt: ship.at,
      resetReason:
        `"${ship.archetypeId}" shipped with different markup than the ${existing.cleanShips} earlier clean ship(s) ` +
        `(${existing.runIds.join(", ")}), so this counts as a new design at 1 of ${AUTO_PROMOTE_CLEAN_SHIPS}`,
      ...(existing.promotedAt !== undefined ? { promotedAt: existing.promotedAt } : {}),
      ...(existing.promotedFromRunIds !== undefined ? { promotedFromRunIds: existing.promotedFromRunIds } : {}),
    };
    return { history: { version: 1, records: [...others, record].slice(-CUSTOM_ARCHETYPE_HISTORY_LIMIT) } };
  }

  const runIds = [...existing.runIds, ship.runId];
  const cleanShips = existing.cleanShips + 1;
  const alreadyPromoted = existing.promotedAt !== undefined;
  const earnsPromotion = !alreadyPromoted && cleanShips >= AUTO_PROMOTE_CLEAN_SHIPS;
  const promotion = earnsPromotion
    ? { promotedAt: ship.at, promotedFromRunIds: runIds }
    : existing.promotedAt !== undefined
      ? { promotedAt: existing.promotedAt, ...(existing.promotedFromRunIds !== undefined ? { promotedFromRunIds: existing.promotedFromRunIds } : {}) }
      : {};
  const record: CustomArchetypeRecord = {
    templateId: existing.templateId,
    archetypeId: ship.archetypeId,
    name: ship.name,
    bodyHash: ship.bodyHash,
    cleanShips,
    runIds,
    lastShippedAt: ship.at,
    ...promotion,
  };
  const next: CustomArchetypeHistory = { version: 1, records: [...others, record].slice(-CUSTOM_ARCHETYPE_HISTORY_LIMIT) };
  return earnsPromotion ? { history: next, promote: record } : { history: next };
}

/**
 * Everything `promoteTemplate` needs that is a POLICY decision, as one
 * object.
 *
 * `htmlTemplate`/`cssStyles`/`store` stay with the caller (`09f`), which
 * already holds the composed document and the store handle; the score, the
 * actor, the `enabled` flag and the note come from here so there is exactly
 * one place that decides what an auto-promotion is worth. Spread it:
 *
 *     await promoteTemplate({ store, htmlTemplate, cssStyles, ...request });
 *
 * `qualityScore` and `enabled` are `PromoteOptions` overrides added by item
 * N (`packages/tools/karos-templates/src/promote.ts`); until that lands in
 * this package's built `dist/`, `09f` cannot pass them, and a promotion
 * would land at `ai_generated`'s 40 instead of 55.
 */
export interface AutoPromotionRequest {
  id: string;
  archetypeId: string;
  name: string;
  layoutType: "photo" | "typographic";
  source: "ai_generated";
  clientSlug: string;
  enabled: true;
  qualityScore: number;
  actor: string;
  note: string;
  now: number;
}

/**
 * THE ROUTING CONSTRAINT, and why a promotion has to change the archetype id.
 *
 * A promoted row is only ever picked again if `templateForLayout` can route
 * to it, and that function maps the FIXED layout enum: `custom` is the one
 * entry that does not map to a stored file, because it resolves to
 * `templateFileName(slide.customArchetype.archetypeId)` and `resolveLayout`
 * only honours it when `validateCustomArchetypes` has validated
 * model-authored markup THIS attempt. So a row stored under a
 * `custom_pull_rail` id is unreachable forever: nothing in the layout enum
 * names it, and nothing feeds a stored design back into the copy prompt.
 * (Spec finding 7 states the same constraint for the Template Studio, which
 * is why studio rows reuse the eight routable ids.)
 *
 * A promotion therefore stores the design AS one of the routable archetypes —
 * this client's own implementation of it — and that is only honest when the
 * design reads nothing the archetype's `contentFor` case cannot supply. A
 * layout whose markup reads `{{railTitle}}` cannot become a `headline_focus`,
 * because `contentFor` would hand it `headline`/`body` and the rail would
 * render as a hole. Those designs are recorded and NOT promoted, with the
 * reason on the gate, which is the honest outcome: the alternative is a
 * stored row that either cannot be picked or renders wrong when it is.
 *
 * The `supplies` lists are `contentFor`'s own per-archetype outputs
 * (`slides-data.ts`), not a guess, and `default-template-render.test.ts`'s
 * source scan over the bundled templates is what catches a drift.
 */
export const STANDING_FURNITURE_SLOTS: readonly string[] = [
  "accentColor",
  "dir",
  "fontScale",
  "textAlign",
  "kicker",
  "brandHandle",
  "seriesBadge",
  "groundStyle",
  "slideIndex",
  "deviceFigures",
  "deviceKind",
];

/**
 * The routable archetypes an auto-promotion may land on, best first.
 *
 * `headline_focus` first because it is the typographic floor every degrade
 * path ends at, so a better per-client implementation of it is worth the most;
 * then `closer` and `cover`, the two positional archetypes. The four
 * structured archetypes (`stat_callout`, `quote_card`, `comparison_card`,
 * `list_takeaway`) are deliberately absent: each is bound to a copy block the
 * model fills (`stat`, `quote`, …) and a design that happens to read
 * `{{figure}}` is not thereby a stat callout — promoting onto one would make
 * a run's `stat` render through a layout authored for something else. `photo`
 * is absent because it routes to the client's own configured `slideTemplate`,
 * which a registry row does not replace.
 */
export const ROUTABLE_PROMOTION_TARGETS: readonly { archetypeId: string; layoutType: "photo" | "typographic"; supplies: readonly string[] }[] = [
  { archetypeId: "headline_focus", layoutType: "typographic", supplies: ["headline", "body", "device"] },
  { archetypeId: "closer", layoutType: "typographic", supplies: ["eyebrow", "takeaway", "cta", "question", "recap"] },
  { archetypeId: "cover", layoutType: "photo", supplies: ["eyebrow", "title", "subtitle", "hero", "device"] },
];

/**
 * Which routable archetype this design could BE, from the slot names its
 * markup actually reads (`extractSupportedFields(bodyHtml + css)`).
 *
 * A design qualifies for a target when every name it reads is either standing
 * furniture or something that target's `contentFor` case supplies. Reading
 * FEWER than the target supplies is fine — a layout that uses only
 * `{{headline}}` is a perfectly good `headline_focus`.
 */
export function routablePromotionTargetFor(
  readSlots: readonly string[],
): { archetypeId: string; layoutType: "photo" | "typographic" } | undefined {
  const furniture = new Set(STANDING_FURNITURE_SLOTS);
  for (const target of ROUTABLE_PROMOTION_TARGETS) {
    const supplies = new Set([...furniture, ...target.supplies]);
    if (readSlots.every((name) => supplies.has(name))) return { archetypeId: target.archetypeId, layoutType: target.layoutType };
  }
  return undefined;
}

/** Either the promotion `09f` should perform, or why this design cannot be offered to a later run. */
export type AutoPromotionDecision = { promote: true; request: AutoPromotionRequest } | { promote: false; reason: string };

export function buildAutoPromotionRequest(
  record: CustomArchetypeRecord,
  opts: {
    clientSlug: string;
    now: number;
    /**
     * The `{{name}}`s the design's markup and CSS actually read —
     * `extractSupportedFields(bodyHtml + "\n" + css)` at the call site, so
     * this module stays free of the templates package.
     */
    readSlots: readonly string[];
  },
): AutoPromotionDecision {
  const target = routablePromotionTargetFor(opts.readSlots);
  if (target === undefined) {
    // Only the names NO routable archetype supplies are named as the reason.
    // A design reading `{{headline}}` alongside `{{railTitle}}` is blocked by
    // the rail, not by the headline, and blaming both would send a reviewer
    // looking in the wrong place.
    const known = new Set([...STANDING_FURNITURE_SLOTS, ...ROUTABLE_PROMOTION_TARGETS.flatMap((t) => t.supplies)]);
    const ownSlots = opts.readSlots.filter((name) => !known.has(name));
    const offenders =
      ownSlots.length > 0
        ? `reads its own slot name(s) ${ownSlots.map((n) => `{{${n}}}`).join(", ")}, which no routable archetype's fields supply`
        : `mixes fields from more than one archetype (${opts.readSlots.filter((n) => !new Set(STANDING_FURNITURE_SLOTS).has(n)).join(", ")}), so no single archetype supplies all of them`;
    return {
      promote: false,
      reason:
        `"${record.archetypeId}" earned promotion (${record.cleanShips} clean ships) but ${offenders} — ` +
        "a stored row is only ever picked through the fixed layout enum, so this design is recorded but cannot be offered to a later run. " +
        "A design that reads only one archetype's standard fields is promoted the ordinary way.",
    };
  }
  const runIds = record.promotedFromRunIds ?? record.runIds;
  return {
    promote: true,
    request: {
      id: record.templateId,
      // NOT `record.archetypeId`: see this section's header. The row is
      // stored as the routable archetype the design can actually fill, which
      // is what makes `resolveBest` able to pick it and `templateForLayout`
      // able to route to it.
      archetypeId: target.archetypeId,
      name: record.name,
      // From the target, not a guess: `layoutType` decides whether a later
      // run PAYS to source a photograph for a slide rendering through this
      // row, so claiming `photo` for a typographic design bills for a picture
      // it has nowhere to put.
      layoutType: target.layoutType,
      source: "ai_generated",
      clientSlug: opts.clientSlug,
      enabled: true,
      qualityScore: AUTO_PROMOTE_QUALITY_SCORE,
      actor: AUTO_PROMOTE_ACTOR,
      note:
        `auto-promoted after ${record.cleanShips} clean ships (${runIds.join(", ")}) as this client's "${target.archetypeId}": approved at the human gate ` +
        `with no edit to the slide this design renders and no revise verdict on the design itself. Authored as "${record.archetypeId}".`,
      now: opts.now,
    },
  };
}
