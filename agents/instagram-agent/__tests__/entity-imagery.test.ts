import { describe, expect, it } from "vitest";
import {
  creditLineFor,
  ENTITY_PRESS_PATHS,
  EntitySetSchema,
  groundEntities,
  legibleTextIn,
  licenceAdmissible,
  licenceClassFor,
  MAX_ENTITIES_INTO_COPY,
  needsLikenessConsent,
  planEntitySourcing,
  RecognisedEntitySchema,
  sceneDeclaresIllustration,
  screenLegibleText,
  topEntities,
  type RecognisedEntity,
} from "../src/workflow/entity-imagery.js";

/**
 * Phase 5.5, item A2 — THE ENTITY ROUTE.
 *
 * Every fact card, candidate description and vision note quoted here is
 * VERBATIM from the three judged prep runs of 2026-09-16
 * (`pubsub-21868183257380937` karoslabs, `pubsub-21864573169935321`
 * thepitchbydeel, `pubsub-21868533047825082` geektime). The point of using the
 * real strings is that the guards below have to survive what the pipeline
 * actually produces, not what a fixture author would have produced.
 */

/** `04b-research-extract-facts`, karoslabs, verbatim. */
const KAROSLABS_CARDS = [
  { id: "k1", claim: "Karos Labs operates as an AI-powered marketing team that replaces or augments the CMO function for companies." },
  { id: "k2", claim: "Generative Engine Optimization (GEO) optimizes for visibility inside AI-generated answers from tools like ChatGPT and Gemini." },
  { id: "k3", claim: "Only 7.2% of organizations respond to inbound leads within five minutes, meaning fewer than 1 in 14 companies engage buyers at the exact moment their interest is highest." },
];

/** `04b2-dedupe-fact-cards`, geektime, verbatim (Hebrew and English rows as the run produced them). */
const GEEKTIME_CARDS = [
  { id: "g1", claim: "גיקטיים - אתר הטכנולוגיה וההייטק של ישראל | גיקטיים", sourceTitle: "geektime.co.il" },
  { id: "g2", claim: "Geektime - Products, Competitors, Financials, Employees, Headquarters Locations", sourceTitle: "cbinsights.com" },
  { id: "g3", claim: "Annual Report 2016: Startups and Venture Capital in Israel", sourceTitle: "geektime.co.il" },
];

const entity = (over: Partial<RecognisedEntity> & Pick<RecognisedEntity, "name">): RecognisedEntity => ({
  kind: "company",
  isPublicFigure: false,
  cardIds: ["k1"],
  salience: 3,
  ...over,
});

describe("the post-parse code guard — an entity the evidence does not carry is dropped", () => {
  it("keeps ChatGPT and OpenAI-shaped names the karoslabs cards really contain", () => {
    const { kept, dropped } = groundEntities([entity({ name: "ChatGPT", kind: "product", cardIds: ["k2"], salience: 5 }), entity({ name: "Gemini", kind: "product", cardIds: ["k2"], salience: 4 }), entity({ name: "Karos Labs", cardIds: ["k1"], salience: 5 })], {
      cards: KAROSLABS_CARDS,
      angle: "Buyers are forming opinions inside AI-generated answers before they ever reach you.",
    });
    expect(kept.map((e) => e.name)).toEqual(["ChatGPT", "Gemini", "Karos Labs"]);
    expect(dropped).toEqual([]);
  });

  it("drops a name no card and no angle contains, however confident the model was about its cardIds", () => {
    const { kept, dropped } = groundEntities(
      [
        entity({ name: "ChatGPT", kind: "product", cardIds: ["k2"], salience: 5 }),
        // Plausible, adjacent, and nowhere in the evidence — the shape of
        // extraction failure that a schema can never catch, because the model
        // fills in `cardIds` as confidently for this one as for the real one.
        entity({ name: "Anthropic", cardIds: ["k2"], salience: 4 }),
      ],
      { cards: KAROSLABS_CARDS, angle: "Buyers are forming opinions inside AI-generated answers." },
    );
    expect(kept.map((e) => e.name)).toEqual(["ChatGPT"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.name).toBe("Anthropic");
    expect(dropped[0]!.why).toContain("no fact card");
  });

  it("grounds a Hebrew name and an English one from the same geektime card set, and drops the invented event", () => {
    const { kept, dropped } = groundEntities(
      [
        entity({ name: "Geektime", cardIds: ["g2"], salience: 5 }),
        entity({ name: "גיקטיים", cardIds: ["g1"], salience: 5 }),
        entity({ name: "Israel", kind: "place", cardIds: ["g3"], salience: 2 }),
        // The conference the pipeline would LIKE to illustrate. No card names
        // it, so it does not go looking for pictures of it.
        entity({ name: "Geektime Code 2026", kind: "event", cardIds: ["g1"], salience: 5 }),
      ],
      { cards: GEEKTIME_CARDS },
    );
    expect(kept.map((e) => e.name)).toEqual(["Geektime", "גיקטיים", "Israel"]);
    expect(dropped.map((d) => d.name)).toEqual(["Geektime Code 2026"]);
  });

  it("carries at most three into 05, most salient first, ties by extraction order", () => {
    const ordered = topEntities([entity({ name: "a", salience: 2 }), entity({ name: "b", salience: 5 }), entity({ name: "c", salience: 5 }), entity({ name: "d", salience: 4 })]);
    expect(ordered.map((e) => e.name)).toEqual(["b", "c", "d"]);
    expect(ordered).toHaveLength(MAX_ENTITIES_INTO_COPY);
  });

  it("the schema requires at least one cardId, so the model's claim is always checkable", () => {
    expect(RecognisedEntitySchema.safeParse({ name: "ChatGPT", kind: "product", isPublicFigure: false, cardIds: [], salience: 5 }).success).toBe(false);
    expect(EntitySetSchema.parse({}).entities).toEqual([]);
  });
});

describe("the sourcing ladder — the entity route is consulted before ordinary stock", () => {
  const chatgpt = entity({ name: "ChatGPT", kind: "product", officialDomain: "openai.com", cardIds: ["k2"], salience: 5 });

  it("orders media library, official assets, the cited article, commons, then stock", () => {
    const plan = planEntitySourcing({ entity: chatgpt, hasMediaLibrary: true, citedUrls: ["https://example.com/openai-ships-gpt"], sceneTerms: ["laptop", "long exposure"] });
    expect(plan.map((s) => s.tier)).toEqual(["media-library", "official-assets", "cited-article", "commons", "stock"]);
    expect(plan.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);

    // The `entity` route runs BEFORE `default`, which is the whole change:
    // Commons names its subjects in the file's own metadata, and stock does
    // not, so identification gets the first look.
    const commons = plan.find((s) => s.tier === "commons")!;
    const stock = plan.find((s) => s.tier === "stock")!;
    expect(commons.route).toBe("entity");
    expect(commons.requireTerm).toBe("ChatGPT");
    expect(stock.route).toBe("default");
    expect(commons.order).toBeLessThan(stock.order);

    // The entity name leads the stock query too — a generic frame should at
    // least argue for the right subject.
    expect(stock.query!.startsWith("ChatGPT")).toBe(true);
  });

  it("goes to the entity's own press pages only when a card gave us the domain, and never guesses one", () => {
    const withDomain = planEntitySourcing({ entity: chatgpt });
    const official = withDomain.find((s) => s.tier === "official-assets")!;
    expect(official.urls).toEqual(ENTITY_PRESS_PATHS.map((p) => `openai.com${p}`));

    const noDomain = planEntitySourcing({ entity: entity({ name: "Karos Labs", cardIds: ["k1"], salience: 5 }) });
    expect(noDomain.map((s) => s.tier)).not.toContain("official-assets");
  });

  it("reads the article the slide ALREADY cites — the direct answer to 'a post about ChatGPT should show ChatGPT'", () => {
    const plan = planEntitySourcing({ entity: chatgpt, citedUrls: ["https://a.example/x", "https://a.example/x", " "] });
    const cited = plan.find((s) => s.tier === "cited-article")!;
    // Deduped and blank-stripped: the same URL twice is one harvest.
    expect(cited.urls).toEqual(["https://a.example/x"]);
  });

  it("a person the run did NOT classify as public may never take an unknown-provenance candidate, on any tier", () => {
    const priv = entity({ name: "Dana Levi", kind: "person", isPublicFigure: false, salience: 4 });
    expect(planEntitySourcing({ entity: priv }).every((s) => s.allowUnknownLicence === false)).toBe(true);

    const figure = entity({ name: "Sam Altman", kind: "person", isPublicFigure: true, salience: 5 });
    expect(planEntitySourcing({ entity: figure }).every((s) => s.allowUnknownLicence === true)).toBe(true);

    // And every non-person entity is unaffected — a product's provenance
    // question is a licence question, not a likeness one.
    expect(planEntitySourcing({ entity: chatgpt }).every((s) => s.allowUnknownLicence === true)).toBe(true);
  });
});

describe("likeness consent narrows to the case it is for", () => {
  it("stays quiet on a post that names no private person", () => {
    // On 2026-09-16 `00e-check-likeness-consent` printed, on all three runs,
    // "drawing another party's mark or a real person's likeness requires an
    // explicit, recorded, named permission" — true, blocking-sounding, and
    // irrelevant to every one of them. A note on every run is a note nobody
    // reads.
    expect(needsLikenessConsent([entity({ name: "ChatGPT", kind: "product" }), entity({ name: "Sam Altman", kind: "person", isPublicFigure: true })])).toBe(false);
  });

  it("fires for a person the run did not classify as public", () => {
    expect(needsLikenessConsent([entity({ name: "Dana Levi", kind: "person", isPublicFigure: false })])).toBe(true);
  });

  it("a generated likeness must be DRAWN, with the style in the text the generator receives", () => {
    expect(sceneDeclaresIllustration({ scene: "a flat vector portrait of a founder at her desk" })).toBe(true);
    expect(sceneDeclaresIllustration({ scene: "a portrait of a founder at her desk" })).toBe(false);
    // Declared and then undeclared in the same sentence — the exact shape L9
    // exists to catch.
    expect(sceneDeclaresIllustration({ scene: "a photorealistic flat vector portrait of a founder" })).toBe(false);
  });
});

describe("licence classes — carried, not refused", () => {
  it("classifies the real licence lines the providers shipped on 2026-09-16", () => {
    expect(licenceClassFor("blanket", "Unsplash License — free for commercial use, no attribution required")).toBe("blanket");
    expect(licenceClassFor("attributable", 'CC BY-ND 2.0 — commercial use permitted, credit "THE Holy Hand Grenade!"')).toBe("attributable");
    expect(licenceClassFor("unknown", "UNKNOWN — web search result, licence not established; verify before commercial use")).toBe("unknown");
    expect(licenceClassFor("client-supplied", "client-owned asset")).toBe("blanket");
  });

  it("the licence TEXT can only narrow the provider's own confidence, never widen it", () => {
    // A provider that says `blanket` while the asset's own line says editorial
    // use is describing its catalogue, not this file.
    expect(licenceClassFor("blanket", "Getty editorial use only")).toBe("editorial-only");
    expect(licenceClassFor("attributable", "CC BY-NC 4.0")).toBe("editorial-only");
  });

  it("editorial-only ships on commentary and not on a promotional post; unknown ships on neither", () => {
    expect(licenceAdmissible("editorial-only", "commentary")).toBe(true);
    expect(licenceAdmissible("editorial-only", "promotional")).toBe(false);
    expect(licenceAdmissible("unknown", "commentary")).toBe(false);
    expect(licenceAdmissible("blanket", "promotional")).toBe(true);
    expect(licenceAdmissible("attributable", "promotional")).toBe(true);
  });

  it("an attributable selection produces the credit that nothing has ever printed", () => {
    // The real Openverse line from the karoslabs pool, which fits whole.
    expect(creditLineFor({ licenceClass: "attributable", license: 'CC BY-ND 2.0 — commercial use permitted, credit "THE Holy Hand Grenade!"' })).toBe(
      'CC BY-ND 2.0 — commercial use permitted, credit "THE Holy Hand Grenade!"',
    );
    // `sourceLine` is one line of 22px type and a CC record can carry a
    // paragraph, so a long one is cut at a word boundary rather than dropped.
    const long = creditLineFor({ licenceClass: "attributable", license: "Creative Commons Attribution-NoDerivatives 4.0 International, credit the United States Embassy and Consulates in Canada" })!;
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);

    expect(creditLineFor({ licenceClass: "blanket", license: "Unsplash License" })).toBeUndefined();
    expect(creditLineFor({ licenceClass: "attributable", license: "" })).toBeUndefined();
  });
});

describe("baked-in text — the deel keyboard, refused for $0", () => {
  /** `05c-inspect-candidates-attempt-3`, thepitchbydeel, slide 4 — the picture that shipped. Verbatim. */
  const DEEL_KEYBOARD =
    "slide 4 candidate — Close-up of a glowing laptop keypad with digital interface, representing futuristic technology. (photo by Rafael Minguet Delgado on Pexels) [licence: Pexels License — free for commercial use, no attribution required] [vision: A low-angle shot focusing on a backlit computer keyboard, with a glowing screen in the background displaying a command-line interface and some graphical data.; subjects: backlit keyboard, computer screen, command line interface, UI elements, data visualization; text in image: DATABASE / CONFIG / LOGOUT / UPTIME: 124:32:00 / CONNECTION: SECURE / DATA PACKETS: 89323 / >> ENTER COMMAND: | / Tab; screenshot/document]";

  /** Same run, slide 6 — the yellow gantry, and the picture the owner meant by "cranes". */
  const DEEL_CONVEYOR =
    "slide 6 candidate — overhead conveyor, industry, nature, plant, conveyor technology, assembly line (photo by schrott on Pixabay) [licence: Pixabay Content License] [vision: An interior view of a warehouse.; subjects: warehouse, factory; text in image: RRDTA / 17 / 18]";

  /** karoslabs, slide 1 — one of the four correct server-rack photographs, carrying vendor labels. */
  const KAROSLABS_RACKS =
    'slide 1 candidate — Server Closet SSL 2 (by THE Holy Hand Grenade! via flickr on Openverse) [licence: CC BY-ND 2.0] [vision: Three tall, busy server racks are shown in a utility room.; subjects: server racks, servers, cables; text in image: NETGEAR / APC / HP]';

  /** karoslabs, slide 1 — a clean one. */
  const KAROSLABS_CLEAN =
    "slide 1 candidate — cable network (photo by Taylor Vick on Unsplash) [licence: Unsplash License] [vision: Two server racks with mesh doors are visible, filled with numerous network cables and blinking lights.; subjects: server racks, mesh doors, network cables, lights]";

  it("reads the strings the vision note already reported and nothing has ever read back", () => {
    expect(legibleTextIn(DEEL_KEYBOARD)).toEqual(["DATABASE", "CONFIG", "LOGOUT", "UPTIME: 124:32:00", "CONNECTION: SECURE", "DATA PACKETS: 89323", ">> ENTER COMMAND: |", "Tab"]);
    // The `; screenshot/document` trailer is another vision FIELD, not text in
    // the frame, and must not arrive as two more strings.
    expect(legibleTextIn(DEEL_KEYBOARD)).not.toContain("screenshot");
    expect(legibleTextIn(KAROSLABS_CLEAN)).toEqual([]);
  });

  it("refuses the keyboard and the gantry, and keeps the clean rack photograph", () => {
    const verdict = screenLegibleText([{ description: DEEL_KEYBOARD }, { description: DEEL_CONVEYOR }, { description: KAROSLABS_CLEAN }], []);
    expect(verdict.kept).toEqual([{ description: KAROSLABS_CLEAN }]);
    expect(verdict.refused.map((r) => r.text)).toEqual(["DATABASE", "RRDTA"]);
    expect(verdict.keptAsLastResort).toBe(false);
  });

  it("allows an entity's own wordmark, in either direction", () => {
    const verdict = screenLegibleText([{ description: KAROSLABS_RACKS }], ["Netgear", "APC", "HP"]);
    expect(verdict.refused).toEqual([]);
    expect(verdict.kept).toHaveLength(1);
  });

  /**
   * The limb that keeps the screen from becoming the defect it exists to fix.
   * An empty pool is a text plate, and a text plate is what the owner
   * complained about; a screen that can empty a pool trades one defect for a
   * worse one.
   */
  it("keeps a wholly-refused pool rather than emptying it, and says that it did", () => {
    const verdict = screenLegibleText([{ description: DEEL_KEYBOARD }, { description: DEEL_CONVEYOR }], []);
    expect(verdict.kept).toHaveLength(2);
    expect(verdict.refused).toEqual([]);
    expect(verdict.keptAsLastResort).toBe(true);
  });
});
