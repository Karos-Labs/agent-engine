import { describe, expect, it } from "vitest";
import type { RenderCarouselInput } from "@agent-engine/tool-karos-publish";
import { assembleSlidesData, collectDeviceIssues } from "../src/workflow/slides-data.js";
import {
  CTA_LEXICON_HEBREW,
  CTA_LEXICON_LATIN,
  DEFAULT_RENDER_RULES,
  LEADS_WITH_FIGURE,
  checkDefaultRenderRules,
  formatDefaultRenderRuleFailures,
  templateBasename,
} from "../src/workflow/visual-qa-pre-checks.js";
import type { ImageSelection, InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * Phase 0, brief item D — the deterministic half of the default render
 * rules, exercised on REAL assembled slides-data (`assembleSlidesData`, the
 * same function `07c-emit-slides-data` calls) so the checks see the templates
 * `resolveLayout` actually picked and the hero images the selections actually
 * attached — never a hand-shaped approximation of either.
 */

const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 };
const BRAND_TOKENS = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };

type SlideOverride = Partial<InstagramSlideCopy> & { hero?: boolean };

/** Six slides by default (the carousel floor), photo layout, no hero unless `hero: true`; a fixed-length list when `overrides` is given. */
function copyWith(overrides: SlideOverride[], copyOverrides: Partial<InstagramCopyOutput> = {}): { copy: InstagramCopyOutput; selections: ImageSelection[] } {
  const slides = overrides.map(({ hero: _hero, ...o }, i) => ({
    n: i + 1,
    headline: `Finding ${i + 1}`,
    body: `A plain sentence about finding ${i + 1}.`,
    visualNeed: `need ${i + 1}`,
    sourceRef: `claim ${i + 1}`,
    layout: "photo" as const,
    ...o,
  }));
  const selections: ImageSelection[] = overrides.map((o, i) => ({
    n: i + 1,
    imagePath: o.hero ? `fixtures/images/photo-${(i % 3) + 1}.png` : null,
    reason: "fixture",
    license: "CC0",
    rightsUsable: true,
    watermarkFree: true,
    // Phase 0 item F (WP0-5): every selection now carries a claim-match verdict.
    claimMatch: 5,
    claimMatchReason: "fixture — shows the claimed subject",
  }));
  return { copy: { format: "carousel", caption: "A caption with nothing asked of the reader.", slides, ...copyOverrides }, selections };
}

function assemble(copy: InstagramCopyOutput, selections: ImageSelection[]): RenderCarouselInput {
  return assembleSlidesData({ clientSlug: "acme", postId: "post_drr", repoRoot: "/repo", brandTokens: BRAND_TOKENS, copy, selections, canvas: CANVAS });
}

/** A closer that satisfies the CTA rule deterministically, so tests about OTHER rules never carry closer residue. */
const CLOSER_WITH_QUESTION: SlideOverride = { headline: "Your turn", body: "Which of these would you change first?" };
const STAT: SlideOverride = { layout: "stat_callout", stat: { figure: "42%", subLabel: "of teams", source: "internal survey" } };

function failuresFor(result: ReturnType<typeof checkDefaultRenderRules>, ruleId: string) {
  return result.failures.filter((f) => f.ruleId === ruleId);
}

describe("DEFAULT_RENDER_RULES — the four ids, all render-checkable", () => {
  it("carries exactly the spec's four ids, namespaced 'default:'", () => {
    expect(DEFAULT_RENDER_RULES.map((r) => r.id)).toEqual([
      "default:cover-carries-device",
      "default:two-elements-per-slide",
      "default:numbers-are-devices",
      "default:closer-carries-cta",
    ]);
  });
});

describe("default:cover-carries-device", () => {
  it("fails a headline_focus cover with no image (a headline on blank ground is not a cover)", () => {
    const { copy, selections } = copyWith([{ layout: "headline_focus", kicker: "THE SETUP" }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    const cover = failuresFor(result, "default:cover-carries-device");
    expect(cover).toHaveLength(1);
    expect(cover[0]).toMatchObject({ slide: 1 });
    expect(cover[0]!.reason).toContain("headline-focus.html");
    expect(cover[0]!.reason).toMatch(/not a cover/);
  });

  it("fails a photo cover whose hero never arrived (the guaranteed-delivery text_only floor)", () => {
    const { copy, selections } = copyWith([{ layout: "photo" }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(1);
  });

  it("passes a photo cover WITH a hero image", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
  });

  it("passes a stat_callout cover — a figure device is a cover", () => {
    const { copy, selections } = copyWith([STAT, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
    expect(failuresFor(result, "default:numbers-are-devices")).toHaveLength(0);
  });

  it("passes every device archetype on the cover (comparison, quote, list)", () => {
    for (const device of [
      { layout: "comparison_card", comparison: { leftLabel: "Before", leftBody: "5 rounds", rightLabel: "After", rightBody: "2 rounds" } },
      { layout: "quote_card", quote: { text: "We stopped guessing.", attribution: "Head of Ops" } },
      { layout: "list_takeaway", items: [{ title: "Automate intake" }, { title: "Measure the queue" }] },
    ] as SlideOverride[]) {
      const { copy, selections } = copyWith([device, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
      const result = checkDefaultRenderRules(assemble(copy, selections), copy);
      expect(failuresFor(result, "default:cover-carries-device"), device.layout).toHaveLength(0);
    }
  });

  /**
   * THE RULE SAYS "OR A `device` ON THE SLIDE", SO THE CHECK HAS TO LOOK AT ONE.
   *
   * `headline_focus` is deliberately absent from `DEVICE_TEMPLATE_BASENAMES`,
   * because a bare headline_focus cover IS the defect the rule refuses. But it
   * is also one of the three archetypes that actually PAINT a device (copy @14
   * §19; `DEVICE_SLOT_LAYOUTS`), and both `figureRemedyFor` ("move the figure
   * onto the cover or a headline_focus slide") and the interest floor's cover
   * steer ("a device built from the strongest number in this post") tell the
   * writer to produce exactly this slide. Failing it with "no hero image and
   * no figure device" was a statement that is untrue of the assembled slide —
   * a steer the code then refuses.
   */
  it("passes a headline_focus cover that carries a rendered device, because the rule's own text promises that", () => {
    const { copy, selections } = copyWith([
      {
        layout: "headline_focus",
        kicker: "THE SETUP",
        device: { kind: "figure", value: "42%", label: "of teams onboard by hand", source: "internal survey" },
      },
      { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    // The premise: the fragment really did reach the slide.
    expect(data.slides[0]?.htmlFragments?.["device"]).toBeTruthy();
    const result = checkDefaultRenderRules(data, copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
    // And the rule text the check now matches.
    expect(DEFAULT_RENDER_RULES.find((r) => r.id === "default:cover-carries-device")?.description).toContain("`device` on the slide");
  });

  it("still fails a headline_focus cover whose device was DROPPED rather than painted", () => {
    // `text_only` declares no device slot, so `contentFor` drops the fragment.
    // The rule reads the assembled slide, so a device the reader never sees
    // does not satisfy it.
    const { copy, selections } = copyWith([
      {
        layout: "text_only",
        device: { kind: "figure", value: "42%", label: "of teams onboard by hand", source: "internal survey" },
      },
      { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(data.slides[0]?.htmlFragments?.["device"]).toBeUndefined();
    expect(failuresFor(checkDefaultRenderRules(data, copy), "default:cover-carries-device")).toHaveLength(1);
  });

  it("recognises an IGSTYLE-10 '-inv' sibling template as the same archetype", () => {
    const { copy, selections } = copyWith([STAT, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const data = assemble(copy, selections);
    data.slides[0]!.template = "stat-callout-inv.html";
    expect(templateBasename("stat-callout-inv.html")).toBe("stat-callout");
    expect(templateBasename("some/dir/quote-card-inv.html")).toBe("quote-card");
    const result = checkDefaultRenderRules(data, copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
  });

  it("hands a model-authored custom cover to the judge as residue rather than failing it — a template path cannot see its markup", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const data = assemble(copy, selections);
    data.slides[0] = { ...data.slides[0]!, template: "custom-big-number.html", images: {}, fields: { ...data.slides[0]!.fields, figure: "3x" } };
    const result = checkDefaultRenderRules(data, copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
    const residue = result.residue.find((r) => r.id === "default:cover-carries-device");
    expect(residue).toBeDefined();
    expect(residue!.description).toMatch(/custom archetype/);
  });
});

describe("default:two-elements-per-slide", () => {
  it("hands a one-slot custom archetype to the judge as residue rather than failing it — its markup may reference shared fields the slot count cannot see", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const data = assemble(copy, selections);
    // The shape `contentFor` produces for a `custom` layout whose bodyHtml is `<h1>{{kicker}}</h1><p>{{note}}</p>` with `slots: ["note"]`.
    data.slides[1] = { ...data.slides[1]!, template: "custom-bold-diagonal.html", images: {}, fields: { note: "a supporting line the model wrote for this slide" } };
    const result = checkDefaultRenderRules(data, copy);
    expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
    const residue = result.residue.find((r) => r.id === "default:two-elements-per-slide");
    expect(residue).toBeDefined();
    expect(residue!.description).toMatch(/custom archetype/);
  });

  it("passes a headline_focus slide that has its kicker", () => {
    const { copy, selections } = copyWith([{ hero: true }, { layout: "headline_focus", kicker: "THE TURN" }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
  });

  it("passes a mid-carousel headline_focus WITHOUT a kicker — headline + body are its two elements, exactly as copy prompt §7 tells the writer", () => {
    // Review finding 2026-09-09: the kicker is "optional" in §7 and recommended
    // only for slide 1, so a prompt-compliant "turn in the middle" must not
    // fail a rule whose own description says "headline + body" is two.
    for (const position of [1, 2, 3, 4]) {
      const slides: SlideOverride[] = [{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION];
      slides[position] = { layout: "headline_focus" };
      const { copy, selections } = copyWith(slides);
      const result = checkDefaultRenderRules(assemble(copy, selections), copy);
      expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
    }
  });

  it("fails a headline_focus COVER without a kicker on this rule too — on slide 1 the statement and its sub-line are one lockup", () => {
    const { copy, selections } = copyWith([{ layout: "headline_focus" }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    const two = failuresFor(result, "default:two-elements-per-slide");
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ slide: 1 });
    expect(two[0]!.reason).toMatch(/kicker/);
    // ...and the same cover with its kicker clears THIS rule (the cover rule is judged separately).
    const withKicker = copyWith([{ layout: "headline_focus", kicker: "THE SETUP" }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    expect(failuresFor(checkDefaultRenderRules(assemble(withKicker.copy, withKicker.selections), withKicker.copy), "default:two-elements-per-slide")).toHaveLength(0);
  });

  it("passes a text_only slide (headline + body) — the guaranteed-delivery floor must never trip this rule", () => {
    const { copy, selections } = copyWith([{ hero: true }, { layout: "text_only" }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
  });

  it("counts a list's rows fragment and a quote's attribution as elements", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "list_takeaway", items: [{ title: "One" }, { title: "Two" }] },
      { layout: "quote_card", quote: { text: "It held.", attribution: "CTO" } },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
  });

  it("never counts layout metadata (accentColor, dir, fontScale, textAlign, brand furniture) as content", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const data = assemble(copy, selections);
    // A slide reduced to metadata only: every layout key present, no prose, no hero.
    data.slides[2] = { ...data.slides[2]!, images: {}, fields: { accentColor: "#ff0000", dir: "ltr", fontScale: "m", textAlign: "start", brandHandle: "@acme", seriesBadge: "SERIES" } };
    const result = checkDefaultRenderRules(data, copy);
    const two = failuresFor(result, "default:two-elements-per-slide");
    expect(two).toHaveLength(1);
    expect(two[0]!.reason).toContain("carries 0 content element(s)");
  });
});

describe("default:numbers-are-devices", () => {
  it("fails a photo slide whose body opens with '42% of teams…'", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true, body: "42% of teams still file reports by hand." }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    const numbers = failuresFor(result, "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ slide: 2 });
    expect(numbers[0]!.reason).toContain('"42%"');
    expect(numbers[0]!.reason).toContain("body");
  });

  it("passes the same body on a stat_callout", () => {
    const { copy, selections } = copyWith([{ hero: true }, { ...STAT, body: "42% of teams still file reports by hand." }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:numbers-are-devices")).toHaveLength(0);
  });

  it("passes a leading figure on a comparison_card too", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "comparison_card", headline: "5 rounds became 2", comparison: { leftLabel: "Before", leftBody: "5 rounds", rightLabel: "After", rightBody: "2 rounds" } },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:numbers-are-devices")).toHaveLength(0);
  });

  it("passes '2026 was the year…' — a bare four-digit number reads as a year", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true, body: "2026 was the year intake finally got automated." }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:numbers-are-devices")).toHaveLength(0);
  });

  it("fails '₪1,200 …' on a photo slide (currency + separators)", () => {
    const { copy, selections } = copyWith([{ hero: true }, { hero: true, headline: "₪1,200 לחודש על כלים שאף אחד לא פותח" }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    const numbers = failuresFor(result, "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]!.reason).toContain("₪1,200");
    expect(numbers[0]!.reason).toContain("headline");
  });

  it("does not test a body the template never renders (a quote card shows quote + attribution only)", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "quote_card", body: "73% said so.", quote: { text: "We stopped guessing.", attribution: "Head of Ops" } },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(failuresFor(result, "default:numbers-are-devices")).toHaveLength(0);
  });

  it("LEADS_WITH_FIGURE: the regex's own edge cases", () => {
    expect(LEADS_WITH_FIGURE.test("42% of teams")).toBe(true);
    expect(LEADS_WITH_FIGURE.test("  $1.8B in savings")).toBe(true);
    expect(LEADS_WITH_FIGURE.test("3 מיליון משתמשים")).toBe(true);
    expect(LEADS_WITH_FIGURE.test("10k signups")).toBe(true);
    expect(LEADS_WITH_FIGURE.test("2026 was the year")).toBe(false);
    expect(LEADS_WITH_FIGURE.test("Teams cut onboarding 40%")).toBe(false);
    expect(LEADS_WITH_FIGURE.test("12,000 users")).toBe(true);
    // No `g` flag: two calls in a row must agree.
    expect(LEADS_WITH_FIGURE.test("42%")).toBe(true);
    expect(LEADS_WITH_FIGURE.test("42%")).toBe(true);
  });
});

/**
 * Phase 2, item M.4 — a leading figure has to be SET as a device on the
 * slide that opens with it, on ANY archetype.
 *
 * The old rule accepted `stat-callout`/`comparison-card` by template name
 * and nothing else, which is why its text had to end with an apology:
 * `resolveLayout` allows each of those once per carousel, so the second
 * numeric fact in a post had nowhere designed to go. With `device` available
 * on every archetype the question becomes per-slide.
 */
describe("default:numbers-are-devices — the per-slide device check", () => {
  const DEVICE_FIGURE = { kind: "figure" as const, value: "42%", label: "of teams", source: "internal survey" };

  it("passes a leading figure on a headline_focus slide that carries a matching device", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "headline_focus", body: "42% of teams still file reports by hand.", device: DEVICE_FIGURE },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(data.slides[1]!.htmlFragments["device"]).toContain("dv-figure");
    expect(failuresFor(checkDefaultRenderRules(data, copy), "default:numbers-are-devices")).toHaveLength(0);
  });

  it("fails the SAME slide when the device is missing", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "headline_focus", body: "42% of teams still file reports by hand." },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const numbers = failuresFor(checkDefaultRenderRules(assemble(copy, selections), copy), "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ slide: 2 });
    expect(numbers[0]!.reason).toContain("figure_pair");
  });

  it("fails a slide whose device carries a DIFFERENT figure than the one its copy opens with", () => {
    // The old template-name test could not see this: a stat callout whose
    // body opens with a second, unrelated figure was set as prose and passed.
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "headline_focus", body: "73% said so.", device: DEVICE_FIGURE },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    expect(failuresFor(checkDefaultRenderRules(assemble(copy, selections), copy), "default:numbers-are-devices")).toHaveLength(1);
  });

  it("still passes a stat callout and a comparison card on their own structured fields", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { ...STAT, body: "42% of teams still file reports by hand." },
      {
        layout: "comparison_card",
        headline: "5 rounds became 2",
        comparison: { leftLabel: "Before", leftBody: "5 rounds", rightLabel: "After", rightBody: "2 rounds" },
      },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    expect(failuresFor(checkDefaultRenderRules(assemble(copy, selections), copy), "default:numbers-are-devices")).toHaveLength(0);
  });

  it("matches across separators and currency symbols — '₪1,200' in the copy against '₪1,200' on the device", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      {
        layout: "headline_focus",
        headline: "₪1,200 לחודש על כלים שאף אחד לא פותח",
        device: { kind: "figure" as const, value: "₪1,200", label: "לחודש", source: "סקר פנימי" },
      },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    expect(failuresFor(checkDefaultRenderRules(assemble(copy, selections), copy), "default:numbers-are-devices")).toHaveLength(0);
  });
});

describe("default:numbers-are-devices reads the fields each archetype RENDERS (items M.4 / M)", () => {
  /**
   * THE TWO SLIDES THE RULE USED TO BE BLIND ON.
   *
   * The rule read a fixed `fields.headline` / `fields.body` pair, and
   * `contentFor` emits NEITHER of those names for a cover (`eyebrow`,
   * `title`, `subtitle`) or a closer (`eyebrow`, `takeaway`, `cta` /
   * `question`). Prompt @14 §7 makes `cover` the strongest choice for slide 1
   * and `closer` for the last slide, so the post's key figure, the one §19
   * says MUST be set as a device, sat on the two slides nothing checked.
   * Under @13 slide 1 was a `photo`/`stat_callout` emitting
   * `headline`/`body` and was covered; the archetypes moved, the rule did
   * not. It now reads whatever prose fields the slide actually renders.
   */
  it("fails a COVER whose title opens with a figure and carries no device", () => {
    const { copy, selections } = copyWith([
      { layout: "cover", headline: "73% of teams file intake by hand", kicker: "THE SHIFT", hero: true },
      { hero: true },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    // The premise: the cover really does render its headline as `title`, and
    // really does emit no `headline`/`body` field at all.
    expect(templateBasename(data.slides[0]!.template)).toBe("cover");
    expect(data.slides[0]!.fields["title"]).toContain("73%");
    expect(data.slides[0]!.fields["headline"]).toBeUndefined();
    expect(data.slides[0]!.fields["body"]).toBeUndefined();

    const numbers = failuresFor(checkDefaultRenderRules(data, copy), "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ slide: 1 });
    expect(numbers[0]!.reason).toContain("title");
    expect(numbers[0]!.reason).toContain('"73%"');
    // A cover CAN carry a device, so the remedy names it.
    expect(numbers[0]!.reason).toContain("give the slide a device carrying that figure");
  });

  it("passes the same cover once the figure is set as a device", () => {
    const { copy, selections } = copyWith([
      {
        layout: "cover",
        headline: "73% of teams file intake by hand",
        kicker: "THE SHIFT",
        device: { kind: "figure", value: "73%", label: "of teams", source: "internal survey" },
      },
      { hero: true },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(data.slides[0]!.htmlFragments["device"]).toContain("dv-figure");
    expect(failuresFor(checkDefaultRenderRules(data, copy), "default:numbers-are-devices")).toHaveLength(0);
  });

  it("fails a CLOSER whose takeaway opens with a figure, and names a remedy the closer can actually perform", () => {
    // This closer has four earlier slides to recap, so its one elastic middle
    // is taken by the recap strip and `contentFor` drops a slide-level
    // device. Telling the writer to add one would be advice for the thing
    // that was just dropped.
    const { copy, selections } = copyWith([
      { hero: true },
      STAT,
      { hero: true },
      { hero: true },
      { hero: true },
      { layout: "closer", headline: "$1.8B of it never gets measured", body: "Which round would you cut first?" },
    ]);
    const data = assemble(copy, selections);
    expect(templateBasename(data.slides[5]!.template)).toBe("closer");
    expect(data.slides[5]!.fields["takeaway"]).toContain("$1.8B");
    expect(data.slides[5]!.htmlFragments["recap"]).toBeDefined();

    const numbers = failuresFor(checkDefaultRenderRules(data, copy), "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ slide: 6 });
    expect(numbers[0]!.reason).toContain("takeaway");
    expect(numbers[0]!.reason).toContain("already filled by the recap strip");
    expect(numbers[0]!.reason).not.toContain("give the slide a device carrying that figure");
  });

  it("EXEMPTS a quote card: a verbatim quotation is not restructured into a bar chart", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "quote_card", quote: { text: "73% of our intake was still on paper.", attribution: "Head of Ops, 2026" } },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(data.slides[1]!.fields["quoteText"]).toContain("73%");
    expect(failuresFor(checkDefaultRenderRules(data, copy), "default:numbers-are-devices")).toHaveLength(0);
  });

  it("names the archetype's real limitation on a slide with no device slot at all", () => {
    // `photo`/`text_only` route to the CLIENT's own `slideTemplate`, a file
    // this repo does not control and cannot assume declares
    // `{{html:device}}`. So a figure on one of those has to move or become a
    // structured archetype, and the steer says which.
    const { copy, selections } = copyWith([
      { hero: true },
      { body: "25% of the queue never gets triaged." },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const numbers = failuresFor(checkDefaultRenderRules(assemble(copy, selections), copy), "default:numbers-are-devices");
    expect(numbers).toHaveLength(1);
    expect(numbers[0]!.reason).toContain("has no device slot");
    expect(numbers[0]!.reason).toContain("set this slide as a stat_callout or a comparison_card");
  });

  it("a device declared on an archetype with no slot is REPORTED, not silently dropped", () => {
    // The other half of the same defect. §19 used to tell the writer that any
    // archetype may carry a device; six of the eight then dropped it with no
    // trace, and `default:numbers-are-devices` failed the slide for leading
    // with the figure the writer HAD given a device. The drop is now a fact
    // on the gate.
    const { copy, selections } = copyWith([
      { hero: true },
      { layout: "list_takeaway", items: [{ title: "Name the owner" }, { title: "Measure the queue" }], device: { kind: "figure", value: "42%", label: "of teams", source: "internal survey" } },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(data.slides[1]!.htmlFragments["device"]).toBeUndefined();
    expect(data.slides[1]!.fields["deviceKind"]).toBeUndefined();
    const issues = collectDeviceIssues(copy, data);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ slide: 2, kind: "figure" });
    expect(issues[0]!.reason).toContain("no device slot");
    // Without the assembled slides the drop is invisible, which is why the
    // workflow passes them.
    expect(collectDeviceIssues(copy)).toEqual([]);
  });
});

describe("cover and closer archetypes satisfy the rules that name them (item M)", () => {
  // A cover with NEITHER a hero nor a device never reaches the renderer at
  // all — `resolveLayout` degrades it (see slides-data.test.ts) — so what
  // this asserts is the other half: a cover that DOES survive is accepted by
  // the cover rule on its archetype alone, with no photograph. The pixel
  // claim that `cover.html` cannot render bare is proven where it belongs,
  // on real pixels, in interest-floor-calibration.test.ts.
  it("a `cover` with a device and no photograph satisfies the cover rule on its archetype alone", () => {
    const { copy, selections } = copyWith([
      { layout: "cover", kicker: "THE SHIFT", device: { kind: "figure", value: "42%", label: "of teams", source: "internal survey" } },
      { hero: true },
      { hero: true },
      { hero: true },
      { hero: true },
      CLOSER_WITH_QUESTION,
    ]);
    const data = assemble(copy, selections);
    expect(templateBasename(data.slides[0]!.template)).toBe("cover");
    const result = checkDefaultRenderRules(data, copy);
    expect(failuresFor(result, "default:cover-carries-device")).toHaveLength(0);
    expect(failuresFor(result, "default:two-elements-per-slide")).toHaveLength(0);
  });

  it("a `closer` counts its recap strip as a content element", () => {
    const { copy, selections } = copyWith([
      { hero: true },
      STAT,
      { hero: true },
      { hero: true },
      { hero: true },
      { layout: "closer", headline: "That is the pattern", body: "Which one would you change first?" },
    ]);
    const data = assemble(copy, selections);
    expect(templateBasename(data.slides[5]!.template)).toBe("closer");
    expect(data.slides[5]!.htmlFragments["recap"]).toContain("rc-plate");
    expect(checkDefaultRenderRules(data, copy).failures).toHaveLength(0);
  });
});

describe("default:closer-carries-cta — provable when present, never failed when absent", () => {
  const FIVE_PHOTOS: SlideOverride[] = [{ hero: true }, { hero: true }, { hero: true }, { hero: true }, { hero: true }];

  it("a closer with a question mark leaves no residue for the rule and no failure", () => {
    const { copy, selections } = copyWith([...FIVE_PHOTOS, { hero: true, body: "Which one would you drop first?" }]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(result.failures).toHaveLength(0);
    expect(result.residue.map((r) => r.id)).not.toContain("default:closer-carries-cta");
  });

  it("a closer with a lexicon CTA ('save this') passes deterministically", () => {
    const { copy, selections } = copyWith([...FIVE_PHOTOS, { hero: true, body: "Save this for your next planning cycle." }]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(result.residue.map((r) => r.id)).not.toContain("default:closer-carries-cta");
    expect(CTA_LEXICON_LATIN.test("Save this")).toBe(true);
  });

  it("a Hebrew closer 'שתפו את זה' passes deterministically", () => {
    const { copy, selections } = copyWith([...FIVE_PHOTOS, { hero: true, headline: "זה הכל להשבוע", body: "שתפו את זה עם מי שצריך לראות" }]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(result.failures).toHaveLength(0);
    expect(result.residue.map((r) => r.id)).not.toContain("default:closer-carries-cta");
    expect(CTA_LEXICON_HEBREW.test("שתפו את זה")).toBe(true);
  });

  it("a closer with neither goes to the judge as residue with the note — failures stay empty", () => {
    const { copy, selections } = copyWith([...FIVE_PHOTOS, { hero: true, body: "That is what changed this quarter." }]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(result.failures).toHaveLength(0);
    const residue = result.residue.find((r) => r.id === "default:closer-carries-cta");
    expect(residue).toBeDefined();
    expect(residue!.check).toBe("render");
    expect(residue!.description).toContain(DEFAULT_RENDER_RULES[3]!.description);
    expect(residue!.description).toContain("no question mark or lexicon CTA found; judge whether the closer invites action");
  });

  it("a 'single' post is judged on its caption, not on its one slide", () => {
    const withCaptionCta = copyWith([{ hero: true, body: "One designed image." }], { format: "single", caption: "Long caption.\nWhat would you automate first?" });
    const resultA = checkDefaultRenderRules(assemble(withCaptionCta.copy, withCaptionCta.selections), withCaptionCta.copy);
    expect(resultA.residue.map((r) => r.id)).not.toContain("default:closer-carries-cta");

    const withSlideCtaOnly = copyWith([{ hero: true, body: "Would you?" }], { format: "single", caption: "Long caption with no invitation at all." });
    const resultB = checkDefaultRenderRules(assemble(withSlideCtaOnly.copy, withSlideCtaOnly.selections), withSlideCtaOnly.copy);
    expect(resultB.residue.map((r) => r.id)).toContain("default:closer-carries-cta");
  });
});

describe("checkDefaultRenderRules — a clean carousel and the failure formatter", () => {
  it("a well-formed carousel yields no failures and no residue", () => {
    const { copy, selections } = copyWith([{ hero: true }, STAT, { hero: true }, { layout: "headline_focus", kicker: "THE TURN" }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    expect(result).toEqual({ failures: [], residue: [] });
    // ...and the same carousel with a kicker-less mid-carousel turn is just as clean.
    const plainTurn = copyWith([{ hero: true }, STAT, { hero: true }, { layout: "headline_focus" }, { hero: true }, CLOSER_WITH_QUESTION]);
    expect(checkDefaultRenderRules(assemble(plainTurn.copy, plainTurn.selections), plainTurn.copy)).toEqual({ failures: [], residue: [] });
  });

  it("formats every finding on one line for lastSelfCheckReason", () => {
    const { copy, selections } = copyWith([{ layout: "headline_focus" }, { hero: true, body: "42% of teams still file by hand." }, { hero: true }, { hero: true }, { hero: true }, CLOSER_WITH_QUESTION]);
    const result = checkDefaultRenderRules(assemble(copy, selections), copy);
    const line = formatDefaultRenderRuleFailures(result.failures);
    expect(line).toContain("default:cover-carries-device (slide 1):");
    expect(line).toContain("default:two-elements-per-slide (slide 1):");
    expect(line).toContain("default:numbers-are-devices (slide 2):");
    expect(result.failures).toHaveLength(3);
    expect(line.match(/default:[a-z-]+ \(slide \d\):/g)).toHaveLength(3);
  });

  it("an empty slides list is no failure — nothing to judge, never a manufactured one", () => {
    const { copy, selections } = copyWith([{ hero: true }]);
    const data = { ...assemble(copy, selections), slides: [] };
    expect(checkDefaultRenderRules(data, copy)).toEqual({ failures: [], residue: [] });
  });
});

// The workflow-level proofs for these rules (07h present only for a rule-less
// config, 08b's renderRules never empty, a deterministic failure on attempt 1
// costing zero QA turns) and for the run budget (the image cap as an
// adaptation; an over-target estimate adapting the plan; an over-max actual
// finishing degraded with a full deliverable — never a hold, per the owner's
// 2026-09-09 amendment) live in `run-budget-workflow.test.ts`.
