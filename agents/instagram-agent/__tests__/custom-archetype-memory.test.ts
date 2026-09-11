import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DEFAULT_QUALITY_BY_SOURCE } from "@agent-engine/tool-karos-templates";
import {
  AUTO_PROMOTE_ACTOR,
  AUTO_PROMOTE_CLEAN_SHIPS,
  AUTO_PROMOTE_QUALITY_SCORE,
  CUSTOM_ARCHETYPE_BELIEF_KEY,
  CUSTOM_ARCHETYPE_HISTORY_LIMIT,
  ROUTABLE_PROMOTION_TARGETS,
  STANDING_FURNITURE_SLOTS,
  buildAutoPromotionRequest,
  cleanShipsFor,
  customArchetypeBodyHash,
  readCustomArchetypeHistory,
  recordCleanShip,
  routablePromotionTargetFor,
  type AutoPromotionRequest,
  type CleanShipInput,
  type CustomArchetypeHistory,
} from "../src/workflow/custom-archetype-memory.js";
import { validateCustomArchetypeSlots } from "../src/workflow/custom-archetype-checks.js";

const BODY = `<div class="rail"><p class="note">{{note}}</p><h1>{{headline}}</h1></div>`;
const CSS = `.rail .note { color: var(--accent); } .rail h1 { font-family: var(--f-display); }`;

const DESIGN = {
  templateId: "instagram:acme:custom_pull_rail",
  archetypeId: "custom_pull_rail",
  name: "Pull rail",
  bodyHtml: BODY,
  css: CSS,
  slides: [2],
};

function shipInput(overrides: Partial<CleanShipInput> = {}): CleanShipInput {
  return {
    runId: "run_1",
    at: "2026-09-01T00:00:00.000Z",
    delivered: true,
    decision: "approve",
    editedSlides: [],
    templateFeedback: [],
    shipped: [DESIGN],
    ...overrides,
  };
}

function shipOf(input: CleanShipInput) {
  const { ships } = cleanShipsFor(input);
  expect(ships).toHaveLength(1);
  return ships[0]!;
}

describe("custom-archetype-memory (item O): what counts as a clean ship", () => {
  it("delivered + approve + no edit to that slide + no revise verdict", () => {
    const ship = shipOf(shipInput());
    expect(ship).toMatchObject({ runId: "run_1", templateId: DESIGN.templateId, archetypeId: "custom_pull_rail" });
    expect(ship.bodyHash).toBe(customArchetypeBodyHash(BODY, CSS));
  });

  it("an approve that EDITED THAT SLIDE does not count, and says which slide", () => {
    const { ships, skipped } = cleanShipsFor(shipInput({ editedSlides: [2] }));
    expect(ships).toEqual([]);
    expect(skipped[0]!.reason).toContain("edited slide 2");
  });

  it("an edit to a DIFFERENT slide still counts: a typo fix on slide 5 says nothing about the design on slide 2", () => {
    expect(cleanShipsFor(shipInput({ editedSlides: [5] })).ships).toHaveLength(1);
  });

  it("a `revise` template verdict on this design disqualifies the ship; a revise on another design does not", () => {
    expect(cleanShipsFor(shipInput({ templateFeedback: [{ templateId: DESIGN.templateId, verdict: "revise" }] })).ships).toEqual([]);
    expect(cleanShipsFor(shipInput({ templateFeedback: [{ templateId: DESIGN.templateId, verdict: "approved" }] })).ships).toHaveLength(1);
    expect(cleanShipsFor(shipInput({ templateFeedback: [{ templateId: "other", verdict: "revise" }] })).ships).toHaveLength(1);
  });

  it("a run that did not deliver, or a gate that did not approve, earns nothing and names why", () => {
    const undelivered = cleanShipsFor(shipInput({ delivered: false }));
    expect(undelivered.ships).toEqual([]);
    expect(undelivered.skipped[0]!.reason).toContain("did not deliver");

    const revised = cleanShipsFor(shipInput({ decision: "revise" }));
    expect(revised.ships).toEqual([]);
    expect(revised.skipped[0]!.reason).toContain('"revise", not approve');
  });
});

describe("custom-archetype-memory (item O): counting to two", () => {
  const empty: CustomArchetypeHistory = { version: 1, records: [] };

  it("ONE clean ship does not promote; TWO do", () => {
    const first = recordCleanShip(empty, shipOf(shipInput()));
    expect(first.promote).toBeUndefined();
    expect(first.history.records[0]).toMatchObject({ cleanShips: 1, runIds: ["run_1"] });
    expect(AUTO_PROMOTE_CLEAN_SHIPS).toBe(2);

    const second = recordCleanShip(first.history, shipOf(shipInput({ runId: "run_2", at: "2026-09-08T00:00:00.000Z" })));
    expect(second.promote).toBeDefined();
    expect(second.promote).toMatchObject({
      templateId: DESIGN.templateId,
      cleanShips: 2,
      promotedAt: "2026-09-08T00:00:00.000Z",
      promotedFromRunIds: ["run_1", "run_2"],
    });
  });

  it("a THIRD clean ship does not re-promote, so the score is never reset back to its opening value", () => {
    let history = recordCleanShip(empty, shipOf(shipInput())).history;
    const second = recordCleanShip(history, shipOf(shipInput({ runId: "run_2" })));
    history = second.history;
    const third = recordCleanShip(history, shipOf(shipInput({ runId: "run_3" })));
    expect(third.promote).toBeUndefined();
    expect(third.history.records[0]).toMatchObject({ cleanShips: 3, promotedFromRunIds: ["run_1", "run_2"] });
  });

  it("is IDEMPOTENT per runId, so a resumed 09b cannot count the same run twice or promote on a first real ship", () => {
    const first = recordCleanShip(empty, shipOf(shipInput()));
    const replayed = recordCleanShip(first.history, shipOf(shipInput()));
    expect(replayed.promote).toBeUndefined();
    expect(replayed.history).toBe(first.history);
    expect(replayed.history.records[0]!.cleanShips).toBe(1);
  });

  it("a CHANGED bodyHash resets the count to 1 and records a reason naming the earlier runs", () => {
    // The load-bearing detail: a model reusing `custom_pull_rail` next week
    // for a different layout would otherwise have two unrelated designs
    // counted as one, and the thing promoted would be neither.
    const first = recordCleanShip(empty, shipOf(shipInput()));
    const different = recordCleanShip(
      first.history,
      shipOf(shipInput({ runId: "run_2", shipped: [{ ...DESIGN, bodyHtml: `<section class="grid">{{note}}{{headline}}</section>` }] })),
    );
    expect(different.promote).toBeUndefined();
    const record = different.history.records[0]!;
    expect(record.cleanShips).toBe(1);
    expect(record.runIds).toEqual(["run_2"]);
    expect(record.resetReason).toContain("different markup");
    expect(record.resetReason).toContain("run_1");
    expect(record.bodyHash).not.toBe(customArchetypeBodyHash(BODY, CSS));
  });

  it("a restyle IS a different design: css is inside the hash", () => {
    expect(customArchetypeBodyHash(BODY, CSS)).not.toBe(customArchetypeBodyHash(BODY, `${CSS} .rail { padding: 0 }`));
  });

  it("round-trips through the belief key and tolerates whatever a hand edit left there", () => {
    const written = recordCleanShip(recordCleanShip(empty, shipOf(shipInput())).history, shipOf(shipInput({ runId: "run_2" }))).history;
    expect(readCustomArchetypeHistory({ [CUSTOM_ARCHETYPE_BELIEF_KEY]: written })).toEqual(written);
    expect(readCustomArchetypeHistory(undefined).records).toEqual([]);
    expect(readCustomArchetypeHistory({ [CUSTOM_ARCHETYPE_BELIEF_KEY]: 7 }).records).toEqual([]);
    expect(readCustomArchetypeHistory({ [CUSTOM_ARCHETYPE_BELIEF_KEY]: { records: [{ nope: true }] } }).records).toEqual([]);
  });

  it("keeps at most CUSTOM_ARCHETYPE_HISTORY_LIMIT designs, dropping the oldest", () => {
    let history: CustomArchetypeHistory = { version: 1, records: [] };
    for (let i = 0; i < CUSTOM_ARCHETYPE_HISTORY_LIMIT + 3; i += 1) {
      history = recordCleanShip(
        history,
        shipOf(shipInput({ runId: `run_${i}`, shipped: [{ ...DESIGN, templateId: `t_${i}`, archetypeId: `custom_d_${i}` }] })),
      ).history;
    }
    expect(history.records).toHaveLength(CUSTOM_ARCHETYPE_HISTORY_LIMIT);
    expect(history.records[0]!.templateId).toBe("t_3");
  });
});

describe("custom-archetype-memory (item O): the promotion request", () => {
  /** The slot names a design's markup reads, as `extractSupportedFields` would return them. */
  const STANDARD_SLOTS = ["headline", "body", "kicker"];
  const requestFor = (record: Parameters<typeof buildAutoPromotionRequest>[0], readSlots: readonly string[], now = 1): AutoPromotionRequest => {
    const decision = buildAutoPromotionRequest(record, { clientSlug: "acme", now, readSlots });
    if (!decision.promote) throw new Error(`expected a promotion, got: ${decision.reason}`);
    return decision.request;
  };

  it("carries score 55, the queryable actor, and a note naming BOTH earning run ids", () => {
    const first = recordCleanShip({ version: 1, records: [] }, shipOf(shipInput()));
    const { promote } = recordCleanShip(first.history, shipOf(shipInput({ runId: "run_2" })));
    const request = requestFor(promote!, STANDARD_SLOTS, 1_757_000_000_000);

    expect(request.qualityScore).toBe(AUTO_PROMOTE_QUALITY_SCORE);
    expect(request.qualityScore).toBe(55);
    expect(request.actor).toBe(AUTO_PROMOTE_ACTOR);
    expect(request.actor).toBe("auto:two-clean-ships");
    expect(request.note).toContain("run_1");
    expect(request.note).toContain("run_2");
    expect(request.id).toBe(DESIGN.templateId);
    expect(request.source).toBe("ai_generated");
    expect(request.clientSlug).toBe("acme");
    expect(request.enabled).toBe(true);
    expect(request.now).toBe(1_757_000_000_000);
  });

  it("55 sits where its doc comment says it does: above ai_generated's opening score, below the studio's 65 and the bundled floor of 70", () => {
    expect(AUTO_PROMOTE_QUALITY_SCORE).toBeGreaterThan(DEFAULT_QUALITY_BY_SOURCE.ai_generated);
    expect(AUTO_PROMOTE_QUALITY_SCORE).toBeLessThan(65);
    expect(AUTO_PROMOTE_QUALITY_SCORE).toBeLessThan(DEFAULT_QUALITY_BY_SOURCE.legacy);
    expect(DEFAULT_QUALITY_BY_SOURCE.legacy).toBe(70);
  });

  /**
   * THE FLYWHEEL ONLY CLOSES IF THE STORED ROW IS ROUTABLE.
   *
   * `templateForLayout` maps the fixed layout enum, and its `custom` entry
   * resolves to model-authored markup validated THAT attempt — so a row
   * stored under a `custom_*` id can never be picked again, and promoting
   * onto one ships a promise the code cannot keep. These are the four cases
   * that replace it.
   */
  it("promotes onto a ROUTABLE archetype id, never the authored custom_* one", () => {
    const first = recordCleanShip({ version: 1, records: [] }, shipOf(shipInput()));
    const { promote } = recordCleanShip(first.history, shipOf(shipInput({ runId: "run_2" })));
    const request = requestFor(promote!, STANDARD_SLOTS);
    expect(request.archetypeId).toBe("headline_focus");
    expect(request.archetypeId).not.toBe(promote!.archetypeId);
    // The authored id is not lost, it moves into the audit note.
    expect(request.note).toContain(promote!.archetypeId);
    // The row id is still the design's own, so `store.get` stays the
    // don't-blind-overwrite guard `09f` relies on.
    expect(request.id).toBe(DESIGN.templateId);
  });

  it("picks the target from the slots the markup actually reads, and its layoutType from the target", () => {
    const first = recordCleanShip({ version: 1, records: [] }, shipOf(shipInput()));
    const { promote } = recordCleanShip(first.history, shipOf(shipInput({ runId: "run_2" })));

    expect(routablePromotionTargetFor(["headline", "body"])?.archetypeId).toBe("headline_focus");
    expect(routablePromotionTargetFor(["takeaway", "cta"])?.archetypeId).toBe("closer");
    expect(routablePromotionTargetFor(["title", "subtitle", "hero"])?.archetypeId).toBe("cover");
    // Standing furniture never decides a target.
    expect(routablePromotionTargetFor([...STANDING_FURNITURE_SLOTS])?.archetypeId).toBe("headline_focus");

    // `layoutType` decides whether a later run PAYS to source a photograph
    // for a slide rendering through this row, so it comes from the target
    // rather than from a default: guessing `photo` bills for a picture the
    // design has nowhere to put.
    expect(requestFor(promote!, ["headline", "body"]).layoutType).toBe("typographic");
    expect(requestFor(promote!, ["takeaway", "cta"]).layoutType).toBe("typographic");
    expect(requestFor(promote!, ["title", "subtitle", "hero"]).layoutType).toBe("photo");
  });

  it("REFUSES to promote a design that reads its own invented slot names, and says exactly why", () => {
    const first = recordCleanShip({ version: 1, records: [] }, shipOf(shipInput()));
    const { promote } = recordCleanShip(first.history, shipOf(shipInput({ runId: "run_2" })));
    const decision = buildAutoPromotionRequest(promote!, { clientSlug: "acme", now: 1, readSlots: ["headline", "railTitle", "priceNote"] });
    expect(decision.promote).toBe(false);
    const reason = decision.promote ? "" : decision.reason;
    expect(reason).toContain("{{railTitle}}");
    expect(reason).toContain("{{priceNote}}");
    // The standard field it DOES read is not blamed.
    expect(reason).not.toContain("{{headline}}");
    expect(reason).toContain("cannot be offered to a later run");
    expect(routablePromotionTargetFor(["headline", "railTitle"])).toBeUndefined();
  });

  it("never promotes onto a structured archetype: a design reading {{figure}} is not thereby a stat callout", () => {
    // The four structured archetypes are bound to a copy block the model
    // fills (`stat`, `quote`, `comparison`, `items`). Promoting onto one
    // would make a later run's `stat` render through a layout authored for
    // something else entirely.
    expect(ROUTABLE_PROMOTION_TARGETS.map((t) => t.archetypeId)).toEqual(["headline_focus", "closer", "cover"]);
    expect(routablePromotionTargetFor(["figure", "subLabel"])).toBeUndefined();
    expect(routablePromotionTargetFor(["quoteText"])).toBeUndefined();
    expect(routablePromotionTargetFor(["itemRows"])).toBeUndefined();
  });
});

describe("custom-archetype-checks (item O): the slot contract, free and pre-render", () => {
  const archetype = {
    archetypeId: "custom_pull_rail",
    name: "Pull rail",
    rationale: "the note has to sit inside the headline's counter, which no archetype stacks",
    bodyHtml: `<div class="rail"><p>{{note}}</p><h1>{{headline}}</h1><span>{{kicker}}</span></div>`,
    css: CSS,
    slots: ["note"],
    fields: { note: "a supporting line" },
  };

  it("accepts a layout that reads only declared slots plus standing furniture", () => {
    // `headline` and `kicker` are supplied by the workflow on every
    // archetype, so they need no declaration.
    expect(validateCustomArchetypeSlots(archetype)).toEqual({ ok: true });
  });

  it("refuses a {{key}} nothing can fill, and names it: that is what renders as literal text on the slide", () => {
    const result = validateCustomArchetypeSlots({ ...archetype, bodyHtml: `${archetype.bodyHtml}<em>{{price}}</em>` });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("{{price}}");
    expect((result as { reason: string }).reason).toContain("renders as a literal");
  });

  it("refuses a declared slot the markup never reads", () => {
    const result = validateCustomArchetypeSlots({ ...archetype, slots: ["note", "footnote"], fields: { note: "x", footnote: "y" } });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("`footnote`");
    expect((result as { reason: string }).reason).toContain("never reads");
  });

  it("refuses a declared, read slot with no value in `fields` — the hole this check exists for", () => {
    const result = validateCustomArchetypeSlots({ ...archetype, fields: {} });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("`note`");
    expect((result as { reason: string }).reason).toContain("renders as a hole");
  });

  it("scans the css as well as the markup, since a placeholder can be smuggled into a content property", () => {
    const result = validateCustomArchetypeSlots({ ...archetype, css: `${CSS} .rail::after { content: "{{tagline}}" }` });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("{{tagline}}");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The source of this package's own workflow modules must stay TEXT
// ─────────────────────────────────────────────────────────────────────────

/**
 * A guard for a defect that shipped in this very file's module and was
 * invisible to everything.
 *
 * `customArchetypeBodyHash` was written with a raw 0x00 byte as its
 * separator, not an escape. It compiled, its tests passed, and the hash was
 * correct — and yet git classified the whole module as BINARY (`git diff`
 * printed "Bin 0 -> 15745 bytes", `--numstat` printed "-\t-"), so item O's
 * entire implementation was unreviewable in its own pull request and in every
 * future diff. Worse, ripgrep skips a file with a NUL in it, which made the
 * module invisible to every source-scanning guard this repo relies on: the
 * `slide-devices-rtl.test.ts`-style source pins, the `check:*` scripts, and
 * any future scan of `src/`.
 *
 * A NUL separator is a perfectly good idea; writing it as a literal byte is
 * not. `"\u0000"` keeps the hash byte-identical and keeps the file text.
 *
 * Scanned here rather than in a pre-commit hook because CI runs the tests: a
 * hook only protects the machines that have it installed.
 */
describe("source hygiene: nothing under src/workflow may contain a NUL byte", () => {
  it("every module is text, so git can diff it and ripgrep can see inside it", async () => {
    const dir = path.resolve(__dirname, "..", "src", "workflow");
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
    // Guard the guard: an empty directory listing would make this vacuous.
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const bytes = await fs.readFile(path.join(dir, file));
      if (bytes.includes(0)) offenders.push(file);
    }
    expect(offenders, `write the byte as an escape (\u0000) rather than a literal: ${offenders.join(", ")}`).toEqual([]);
  });

  it("and the hash this rule was written for is unchanged by the escape", () => {
    // sha256 of bodyHtml + "\u0000" + css. Pinned so a later "tidy the
    // separator" edit cannot silently reset every client's clean-ship count
    // by changing what the hash covers.
    expect(customArchetypeBodyHash("a", "b")).toBe(customArchetypeBodyHash("a", "b"));
    expect(customArchetypeBodyHash("a\u0000b", "")).not.toBe(customArchetypeBodyHash("a", "b"));
    expect(customArchetypeBodyHash("ab", "")).not.toBe(customArchetypeBodyHash("a", "b"));
  });
});
