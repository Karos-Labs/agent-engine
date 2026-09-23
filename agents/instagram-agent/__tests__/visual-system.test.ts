import { describe, expect, it } from "vitest";
import {
  accentSlidesFor,
  ClientVisualSystemSchema,
  DISPLAY_REGISTER_STACKS,
  DISPLAY_REGISTERS,
  fallbackClientVisualSystem,
  interiorSlides,
  pickVisualSystem,
  SYSTEM_CROSS_CLIENT_HOLD,
  SYSTEM_OWN_HOLD,
  TYPE_SCALE_PX,
  typeScaleDeclarations,
  visualSystemCssBlock,
  VISUAL_SYSTEM_CATALOG,
  type ClientVisualSystem,
} from "../src/workflow/visual-system.js";
import { assembleSlidesData, clampEyebrow, EYEBROW_MAX_CHARS } from "../src/workflow/slides-data.js";

/**
 * Phase 5.5, item C — the two layers of the visual system, and the five
 * properties the rest of the phase is allowed to assume.
 *
 * Every assertion here is on a PURE function, so this suite needs no browser,
 * no router and no fixtures. That is the point of `04p-resolve-visual-system`
 * being a `wf.step.code`: the decision that makes two clients' posts look like
 * two brands is a decision a test can prove rather than a decision a reviewer
 * has to look at eight plates to audit.
 */

const clientWith = (over: Partial<ClientVisualSystem> = {}): ClientVisualSystem => ({
  ...fallbackClientVisualSystem({ clientSlug: "acme" }),
  ...over,
});

describe("pickVisualSystem is pure and seeded", () => {
  it("returns the same systemId for the same inputs, every time and in any order", () => {
    const params = { clientSlug: "karoslabs", paletteSeed: "run-42", slideCount: 8, client: clientWith(), seriesId: "by_the_numbers" };
    const first = pickVisualSystem(params);
    // Called again after twelve unrelated picks, because a hidden module-level
    // counter would still agree on two consecutive calls and disagree here.
    for (const slug of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
      pickVisualSystem({ ...params, clientSlug: slug });
    }
    const second = pickVisualSystem(params);
    expect(second.systemId).toBe(first.systemId);
    expect(second).toEqual(first);
  });

  it("is a function of the seed ALONE — no clock, no randomness (the resume guarantee)", () => {
    // `JSON.stringify` of the whole result rather than the id: a resumed run
    // re-renders from a re-resolved system, so every field has to agree, not
    // just the one the trace prints.
    const of = (seed: string): string =>
      JSON.stringify(pickVisualSystem({ clientSlug: "geektime", paletteSeed: seed, slideCount: 8, client: clientWith() }));
    expect(of("run-1")).toBe(of("run-1"));
    expect(of("run-1")).not.toBe(of("run-1-different-enough-to-rehash"));
  });

  it("every catalog entry is reachable for some client, and no id repeats", () => {
    const ids = VISUAL_SYSTEM_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every entry must be admitted by at least one accent role, or it is a
    // system nobody can ever be given — twelve entries of which three are
    // unreachable is a catalog of nine wearing a twelve's clothes.
    for (const entry of VISUAL_SYSTEM_CATALOG) expect(entry.accentRoles.length).toBeGreaterThan(0);
  });
});

describe("the accent is emphasis, not wallpaper", () => {
  it("names at most three slides, all of them real, none of them twice", () => {
    for (const count of [4, 5, 6, 7, 8, 10]) {
      for (const seed of ["a", "b", "c", "d"]) {
        const slides = accentSlidesFor(count, "rule", seed);
        expect(slides.length).toBeGreaterThanOrEqual(1);
        expect(slides.length).toBeLessThanOrEqual(3);
        expect(slides.every((slide) => slide >= 1 && slide <= count)).toBe(true);
        expect(new Set(slides).size).toBe(slides.length);
        expect([...slides].sort((a, b) => a - b)).toEqual(slides);
      }
    }
  });

  /**
   * THE PROPERTY THE OLD CONTRACT MADE IMPOSSIBLE.
   *
   * This function used to return `[1, ceil(n/2), n]` — a pure function of the
   * slide count — and the test above used to assert that, first and last every
   * time. So every client with an eight-plate carousel marked plates 1, 4 and 8,
   * forever, and three clients rendered side by side marked the same three.
   * The owner named it: *"יש קו כתום אופקי כזה שלרוב מעיד על AI, זה בסדר אם זה
   * פעם אחת וקורה לפעמים אבל שלא יהיה קבוע"*. A mark in the same place every
   * time is not an accent, it is furniture — so the contract is now that the
   * choice MOVES, and this is the assertion the old one could never have passed.
   */
  it("moves between runs, so the mark is never in the same place twice by rule", () => {
    const seeds = ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6", "run-7", "run-8"];
    const sets = seeds.map((seed) => accentSlidesFor(8, "rule", seed).join(","));
    expect(new Set(sets).size).toBeGreaterThan(1);

    /* And the cover holds no privilege: across eight runs it is sometimes
       marked and sometimes not, which is what "occasionally" means. */
    const coverMarked = seeds.filter((seed) => accentSlidesFor(8, "rule", seed).includes(1)).length;
    expect(coverMarked).toBeGreaterThan(0);
    expect(coverMarked).toBeLessThan(seeds.length);
  });

  it("is deterministic for a given run, so two renders of one post agree", () => {
    expect(accentSlidesFor(8, "rule", "run-1")).toEqual(accentSlidesFor(8, "rule", "run-1"));
  });

  it("the `field` form takes ONE slide — a surface behind a block is loud, and twice is a pattern", () => {
    expect(accentSlidesFor(8, "field")).toEqual([8]);
  });

  it("the `none` form takes no slide at all: a `mark` client spends its colour inside the type", () => {
    expect(accentSlidesFor(8, "none")).toEqual([]);
  });

  it("holds at three even on a two-slide degenerate post, and never names a slide off the end", () => {
    const slides = accentSlidesFor(2, "rule", "seed");
    expect(slides.every((s) => s >= 1 && s <= 2)).toBe(true);
    expect(new Set(slides).size).toBe(slides.length);
  });

  it("every resolved system respects the ceiling", () => {
    for (const entry of VISUAL_SYSTEM_CATALOG) {
      for (const role of entry.accentRoles) {
        const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: entry.id, slideCount: 8, client: clientWith({ accentRole: role }) });
        expect(system.accentSlides.length).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("the pagination index is all or none, never a subset", () => {
  it("`pagination: all` names EVERY interior slide", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ pagination: "all" }) });
    expect(system.numeralSlides).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("`pagination: none` names none", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ pagination: "none" }) });
    expect(system.numeralSlides).toEqual([]);
  });

  it("is never a proper non-empty subset of the interiors — the defect the owner named", () => {
    // *"על חלק מהשקופיות כתוב מספר ועל חלק לא"*. Swept over every slide count
    // the canvas allows and both axis values, because the failure mode is a
    // length where the arithmetic happens to drop one.
    for (const count of [4, 5, 6, 7, 8]) {
      for (const pagination of ["all", "none"] as const) {
        const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: count, client: clientWith({ pagination }) });
        const interiors = interiorSlides(count);
        expect(system.numeralSlides.length === 0 || system.numeralSlides.length === interiors.length).toBe(true);
      }
    }
  });

  it("never names the cover — a role rule, not a subset", () => {
    for (const count of [4, 6, 8]) {
      const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: count, client: clientWith({ pagination: "all" }) });
      expect(system.numeralSlides).not.toContain(1);
      expect(system.numeralSlides).not.toContain(count);
    }
  });
});

describe("the eyebrow is topical and sparse, never a label on every plate", () => {
  it("never reaches the cover", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ imageryRegister: "documentary" }) });
    if (system.eyebrow.kind === "topical") expect(system.eyebrow.slides).not.toContain(1);
  });

  it("is absent entirely for a client whose pictures ARE the label", () => {
    for (const register of ["illustration", "none"] as const) {
      const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ imageryRegister: register }) });
      expect(system.eyebrow.kind).toBe("none");
    }
  });

  it("never covers every slide — that is what the series badge did", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ imageryRegister: "documentary" }) });
    if (system.eyebrow.kind === "topical") expect(system.eyebrow.slides.length).toBeLessThan(8);
  });
});

describe("the composition honours the eyebrow axis", () => {
  // The other half of the axis: `pickVisualSystem` decides WHICH slides may
  // carry one, and `contentFor` decides whether the field is emitted at all.
  // Both halves have to agree or the template renders an empty element on a
  // slide the system excluded — which is what `.brand-badge:empty` was quietly
  // papering over before this phase.
  it("clamps a long eyebrow on a word boundary rather than dropping or cutting it", () => {
    expect(clampEyebrow("FIELD NOTES")).toBe("FIELD NOTES");
    expect(clampEyebrow("  FIELD NOTES  ")).toBe("FIELD NOTES");
    const long = "THE SECOND MONTH IS WHERE EVERY CALENDAR FAILS";
    const clamped = clampEyebrow(long);
    expect(clamped.length).toBeLessThanOrEqual(EYEBROW_MAX_CHARS);
    expect(long.startsWith(clamped)).toBe(true);
    expect(clamped.endsWith(" ")).toBe(false);
  });

  it("returns a single over-long word whole rather than cutting it mid-term", () => {
    // A hard cut in the middle of a term is worse than a slightly long
    // eyebrow, and dropping it silently loses the slide's own label.
    const word = "Unternehmensberatungsgesellschaft";
    expect(clampEyebrow(word)).toBe(word);
  });

  it("emits the eyebrow only on the slides the system named", () => {
    const copy = {
      caption: "c",
      slides: [2, 3, 4].map((n) => ({ n, layout: "text_only" as const, headline: `H${n}`, body: `B${n}`, kicker: `K${n}` })),
    } as unknown as Parameters<typeof assembleSlidesData>[0]["copy"];
    const client = fallbackClientVisualSystem({ clientSlug: "acme", aesthetic: "documentary" });
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 3, client });
    const named = system.eyebrow.kind === "topical" ? new Set(system.eyebrow.slides) : new Set<number>();
    const assembled = assembleSlidesData({
      clientSlug: "acme",
      postId: "p",
      repoRoot: ".",
      brandTokens: { templateDir: "d", slideTemplate: "slide.html" },
      copy,
      selections: [],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      visualSystem: system,
    });
    for (const slide of assembled.slides) {
      const hasEyebrow = slide.fields["kicker"] !== undefined || slide.fields["eyebrow"] !== undefined;
      expect(hasEyebrow, `slide ${slide.n}: eyebrow presence disagrees with the system`).toBe(named.has(slide.n));
    }
  });

  it("with NO system every slide keeps its kicker — the pre-phase behaviour every fixture depends on", () => {
    const copy = {
      caption: "c",
      slides: [2, 3].map((n) => ({ n, layout: "text_only" as const, headline: `H${n}`, body: `B${n}`, kicker: `K${n}` })),
    } as unknown as Parameters<typeof assembleSlidesData>[0]["copy"];
    const assembled = assembleSlidesData({
      clientSlug: "acme",
      postId: "p",
      repoRoot: ".",
      brandTokens: { templateDir: "d", slideTemplate: "slide.html" },
      copy,
      selections: [],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
    });
    for (const slide of assembled.slides) expect(slide.fields["kicker"]).toBeDefined();
  });

  it("the run's ground is the system's, and one material for the whole post", () => {
    const copy = {
      caption: "c",
      slides: [1, 2, 3].map((n) => ({ n, layout: "text_only" as const, headline: `H${n}`, body: `B${n}` })),
    } as unknown as Parameters<typeof assembleSlidesData>[0]["copy"];
    const client = fallbackClientVisualSystem({ clientSlug: "acme" });
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 3, client });
    const assembled = assembleSlidesData({
      clientSlug: "acme",
      postId: "p",
      repoRoot: ".",
      brandTokens: { templateDir: "d", slideTemplate: "slide.html" },
      copy,
      selections: [],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      visualSystem: system,
    });
    expect(new Set(assembled.slides.map((slide) => slide.fields["groundStyle"]))).toEqual(new Set([system.ground]));
  });
});

describe("two clients that differ on an axis produce different posts", () => {
  it("a different accentRole on identical evidence resolves a different system", () => {
    const base = { clientSlug: "same-slug", paletteSeed: "same-seed", slideCount: 8, seriesId: "the_breakdown" };
    const information = pickVisualSystem({ ...base, client: clientWith({ accentRole: "information" }) });
    const mark = pickVisualSystem({ ...base, client: clientWith({ accentRole: "mark" }) });
    // Different system id OR a different accent form: the catalog filter is by
    // role, so the two cannot resolve the same entry unless that entry admits
    // both roles — and then the assertion below is the one that matters.
    expect(information.systemId === mark.systemId && information.accentForm === mark.accentForm && information.ground === mark.ground).toBe(false);
  });

  it("the display register is the axis that changes the face, and it is not the same for every client", () => {
    // Today every client in the fleet renders `Fraunces, Georgia, Times New
    // Roman, serif` for display — identical across the whole fleet, which on
    // its own guarantees three posts look related. Four registers, four
    // distinct stacks.
    const stacks = DISPLAY_REGISTERS.map((register) => DISPLAY_REGISTER_STACKS[register].display);
    expect(new Set(stacks).size).toBe(DISPLAY_REGISTERS.length);
  });

  it("the fallback derivation gives two differently-configured clients different axes", () => {
    const technical = fallbackClientVisualSystem({ clientSlug: "karoslabs", aesthetic: "technical, engineered", palette: ["#111", "#222", "#333"] });
    const editorial = fallbackClientVisualSystem({ clientSlug: "geektime", aesthetic: "warm editorial craft", palette: ["#ABC"] });
    expect(technical.displayRegister).not.toBe(editorial.displayRegister);
    expect(technical.accentRole).not.toBe(editorial.accentRole);
  });
});

describe("the cross-client hold pushes a system away, and never refuses one", () => {
  it("avoids a system another client shipped inside the window", () => {
    const params = { clientSlug: "acme", paletteSeed: "seed", slideCount: 8, client: clientWith() };
    const taken = pickVisualSystem(params).systemId;
    const avoided = pickVisualSystem({ ...params, recentCrossClientSystemIds: [taken] });
    expect(avoided.systemId).not.toBe(taken);
  });

  it("STILL RESOLVES when every system this client can carry is held — variety never refuses a post", () => {
    // `field` is the narrowest role in the catalog, so this is the starvation
    // case that actually exists: hold everything it admits and the pool has to
    // come back anyway. A variety rule that can return nothing is a variety
    // rule that can hold a run.
    const client = clientWith({ accentRole: "field" });
    const admitted = VISUAL_SYSTEM_CATALOG.filter((entry) => entry.accentRoles.includes("field")).map((entry) => entry.id);
    expect(admitted.length).toBeLessThanOrEqual(SYSTEM_OWN_HOLD);
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "seed", slideCount: 8, client, recentOwnSystemIds: admitted });
    expect(system.systemId.length).toBeGreaterThan(0);
    expect(admitted).toContain(system.systemId);
    expect(system.reason).toContain("hold was dropped");
  });

  it("reads at most SYSTEM_CROSS_CLIENT_HOLD entries, so an unbounded belief cannot empty the catalog", () => {
    const allIds = VISUAL_SYSTEM_CATALOG.map((entry) => entry.id);
    const held = allIds.slice(0, SYSTEM_CROSS_CLIENT_HOLD);
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "seed", slideCount: 8, client: clientWith(), recentCrossClientSystemIds: allIds });
    // Only the first five of the list bind; the entries beyond the window are
    // ignored, which is what keeps a long history from starving the pick.
    expect(held.length).toBe(SYSTEM_CROSS_CLIENT_HOLD);
    expect(system.systemId.length).toBeGreaterThan(0);
  });
});

describe("ClientVisualSystem survives a JSON round trip and a workflow resume", () => {
  it("parses back to the same object", () => {
    const client = fallbackClientVisualSystem({ clientSlug: "karoslabs", aesthetic: "bold poster", palette: ["#A", "#B", "#C"] });
    const parsed = ClientVisualSystemSchema.safeParse(JSON.parse(JSON.stringify(client)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(client);
  });

  it("every axis carries a basis — an axis frozen for 90 days with no reason is a guess", () => {
    const client = fallbackClientVisualSystem({ clientSlug: "acme" });
    for (const axis of ["accentRole", "displayRegister", "compositionGrammar", "imageryRegister", "pagination", "groundTexture"]) {
      expect(client.basis[axis], `no basis for ${axis}`).toBeTruthy();
    }
  });

  it("a resumed run re-resolves the identical system from the checkpointed inputs", () => {
    const client = fallbackClientVisualSystem({ clientSlug: "karoslabs", aesthetic: "technical" });
    const before = pickVisualSystem({ clientSlug: "karoslabs", paletteSeed: "run-7", slideCount: 8, client, seriesId: "field_notes" });
    const rehydrated = ClientVisualSystemSchema.parse(JSON.parse(JSON.stringify(client)));
    const after = pickVisualSystem({ clientSlug: "karoslabs", paletteSeed: "run-7", slideCount: 8, client: rehydrated, seriesId: "field_notes" });
    expect(after).toEqual(before);
  });
});

describe("the stylesheet says exactly what the system decided", () => {
  it("switches the accent on the named slides and nowhere else", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ accentRole: "information" }) });
    const css = visualSystemCssBlock(system);
    for (const slide of system.accentSlides) expect(css).toContain(`body[data-n="${String(slide).padStart(2, "0")}"]`);
    if (system.accentSlides.length > 0) expect(css).toContain("--fx-accent: block");
    // The switch must never be set on `:root` or on a bare `body`: that is the
    // wallpaper failure mode, written as a selector.
    //
    // `--fx-accent\s*:` and not `--fx-accent`, because the mark's GEOMETRY —
    // `--fx-accent-w` / `--fx-accent-h`, the one shape the run's `accentForm`
    // decides for every plate — is deliberately run-level and is declared on
    // `body` with the type scale. A prefix match reads that as the switch and
    // refuses the thing this phase added to stop three marks having three
    // shapes. What must never be on a bare selector is the SWITCH itself.
    expect(css).not.toMatch(/(^|\n)body\s*\{[^}]*--fx-accent\s*:/);
    expect(css).not.toMatch(/:root\s*\{[^}]*--fx-accent\s*:/);
  });

  it("emits no pagination selector at all for a `none` client", () => {
    const system = pickVisualSystem({ clientSlug: "acme", paletteSeed: "s", slideCount: 8, client: clientWith({ pagination: "none" }) });
    expect(visualSystemCssBlock(system)).not.toContain("--fx-pagination");
  });

  it("the type scale folds in --ts, so the reviewer's control still reaches every step", () => {
    for (const declaration of typeScaleDeclarations("display")) {
      expect(declaration).toMatch(/var\(--ts, 1\)/);
    }
  });

  it("the display end of the scale moves with the flavour and the reading end does not", () => {
    const display = typeScaleDeclarations("display").join("\n");
    const editorial = typeScaleDeclarations("editorial").join("\n");
    // A body paragraph that shrinks to suit a visual system is a visual system
    // charging the reader for its own variety.
    expect(display).toContain(`--t-label: calc(${TYPE_SCALE_PX.label}px`);
    expect(editorial).toContain(`--t-label: calc(${TYPE_SCALE_PX.label}px`);
    expect(editorial).not.toContain(`--t-display: calc(${TYPE_SCALE_PX.display}px`);
  });
});

// 2026-09-23 (stage 3 of the reference-looks plan): the Geektime news flash.
describe("the news-frame cover is reachable only through news mode", () => {
  it("no catalog entry carries it, so rotation can never pick it", () => {
    expect(VISUAL_SYSTEM_CATALOG.some((entry) => entry.coverForm === "news-frame")).toBe(false);
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(pickVisualSystem({ clientSlug: "geektime", paletteSeed: seed, slideCount: 1, client: clientWith() }).coverForm).not.toBe("news-frame");
    }
  });

  it("forcedCoverForm sets the cover and leaves every other axis as the seed picked it, and says why", () => {
    const plain = pickVisualSystem({ clientSlug: "geektime", paletteSeed: "run-1", slideCount: 1, client: clientWith() });
    const news = pickVisualSystem({ clientSlug: "geektime", paletteSeed: "run-1", slideCount: 1, client: clientWith(), forcedCoverForm: "news-frame" });
    expect(news.coverForm).toBe("news-frame");
    expect({ ...news, coverForm: plain.coverForm, reason: plain.reason }).toEqual(plain);
    expect(news.reason).toContain("news mode sets the cover");
  });
});
