import { describe, expect, it } from "vitest";
import { anchorEntityPictures, ENTITY_PICTURE_TARGET, entitiesInDraft } from "../src/workflow/draft-entities.js";
import { normaliseVisualNeed } from "../src/workflow/scene-brief.js";
import type { InstagramCopyOutput, InstagramSlideCopy, InstagramSlideLayout } from "../src/workflow/types.js";

// 2026-09-23: the karoslabs carousel of prep pubsub-21763996983218796 cited
// Qualified's 7.2% on a stat slide, briefed its three pictures as anonymous
// laptop scenes, lost all three at the vet and shipped with no picture.
const none = { scene: "Abstract dark ground, no image required", why: "the stat is the content", source: "none", subject: { noun: "data callout", mustShow: [] } };
const scene = (noun: string) => ({ scene: `${noun}, editorial`, why: "the slide needs it", source: "stock", subject: { noun, mustShow: [noun] } });
const slide = (over: Partial<InstagramSlideCopy> & { n: number }): InstagramSlideCopy =>
  ({ headline: "A headline", body: "A body.", visualNeed: none, sourceRef: "c", ...over }) as InstagramSlideCopy;
const karos = (): InstagramCopyOutput =>
  ({
    format: "carousel",
    caption: "c",
    slides: [
      slide({ n: 1, layout: "cover", visualNeed: scene("spreadsheet open on a dark laptop screen") }),
      slide({ n: 2, layout: "photo", visualNeed: scene("open paper planner with weekly grid") }),
      slide({ n: 3, layout: "stat_callout", stat: { figure: "7.2%", subLabel: "of B2B orgs respond to inbound leads within five minutes", source: "Qualified, The 2026 State of Agentic Marketing" } }),
      slide({ n: 4, layout: "list_takeaway", items: [{ title: "Chronos schedules" }, { title: "Kairos reads" }] }),
      slide({ n: 5, layout: "quote_card", quote: { text: "The moment is the product.", attribution: "Maura Rivera, CMO, Qualified" } }),
      slide({ n: 6, layout: "headline_focus" }),
      slide({ n: 7, layout: "photo", visualNeed: scene("hands navigating a content approval interface") }),
      slide({ n: 8, layout: "closer", headline: "The window Qualified measured is five minutes" }),
    ],
  }) as InstagramCopyOutput;
const layoutOf = (s: InstagramSlideCopy) => (s.layout ?? "photo") as InstagramSlideLayout;

describe("credit lines are read for names", () => {
  it("finds the company in a stat's source and the person in a quote's attribution, and no document title", () => {
    const names = entitiesInDraft(karos()).map((e) => [e.name, e.slides] as const);
    expect(names).toContainEqual(["Qualified", [3, 5, 8]]);
    expect(names.map(([n]) => n)).toContain("Maura Rivera");
    expect(names.map(([n]) => n)).not.toContain("The 2026 State of Agentic Marketing");
    expect(names.map(([n]) => n)).not.toContain("CMO");
  });
});

describe("anchorEntityPictures", () => {
  it("gives two panel slides that cite a name a band picture of it, one subject each, never the closer", () => {
    const taken = new Set<string>();
    const { copy, promoted } = anchorEntityPictures(karos(), entitiesInDraft(karos()), { taken, layoutOf });
    expect(promoted).toEqual([
      { slide: 3, entity: "Qualified" },
      { slide: 5, entity: "Maura Rivera" },
    ]);
    const need3 = normaliseVisualNeed(copy.slides[2]!);
    expect(need3.source).toBe("stock");
    expect(need3.subject.entityRef).toBe("Qualified");
    expect(need3.subject.mustShow).toEqual([]);
    expect(normaliseVisualNeed(copy.slides[4]!).subject.entityRef).toBe("Maura Rivera");
    // The closer names Qualified too, and is left alone.
    expect(normaliseVisualNeed(copy.slides[7]!).source).toBe("none");
    // The writer's own briefs are untouched.
    expect(copy.slides[0]!.visualNeed).toEqual(karos().slides[0]!.visualNeed);
    expect(taken).toEqual(new Set(["qualified", "maura rivera"]));
  });

  it("does nothing when the writer already pointed enough picture slides at names", () => {
    const base = karos();
    const already = {
      ...base,
      slides: base.slides.map((s) =>
        s.n === 1 || s.n === 2 ? { ...s, visualNeed: { ...scene("x"), subject: { noun: "Qualified", entityRef: s.n === 1 ? "Qualified" : "Maura Rivera", mustShow: [] } } } : s,
      ),
    } as InstagramCopyOutput;
    const { copy, promoted } = anchorEntityPictures(already, entitiesInDraft(already), { taken: new Set(), layoutOf });
    expect(promoted).toEqual([]);
    expect(copy).toBe(already);
  });

  it("stops at the target, and skips an entity another slide already took", () => {
    expect(ENTITY_PICTURE_TARGET).toBe(2);
    const { promoted } = anchorEntityPictures(karos(), entitiesInDraft(karos()), { taken: new Set(["qualified"]), layoutOf });
    // Qualified is taken, so slide 3 has nobody left to show; slide 5 still gets its speaker.
    expect(promoted).toEqual([{ slide: 5, entity: "Maura Rivera" }]);
  });
});
