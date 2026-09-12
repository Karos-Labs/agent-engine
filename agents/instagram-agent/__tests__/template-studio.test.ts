import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY_STUDIO,
} from "@agent-engine/tool-karos-templates";
import {
  KNOWN_SLOT_NAMES,
  ROLE_BY_ARCHETYPE,
  ROUTABLE_ARCHETYPE_IDS,
  SCRIPT_GLYPH_PROBE,
  SLOTS_BY_ARCHETYPE,
  STUDIO_INTEREST_MARGIN,
  STUDIO_TTL_DAYS,
  assertNoInventedMetrics,
  buildDesignBriefInput,
  buildDesignerInput,
  buildStudioSampleContent,
  STUDIO_EMPTY_SETUP_COOLDOWN_DAYS,
  checkTemplateStudio,
  classifyPostFormat,
  formatEvidenceBlock,
  interestHeadroom,
  isStudioTemplateId,
  planStudioTemplates,
  rankReferenceFormats,
  buildStudioPromotion,
  studioNote,
  studioSampleSeedFromBrief,
  studioTemplateId,
  summarizeStudio,
  StudioTemplateDraftSchema,
  type StudioReferencePost,
  type StudioTemplateValidation,
  type StudioSlideMetrics,
  type StudioSetupAttempt,
  type StudioStoredRow,
} from "../src/workflow/template-studio.js";
import { goodClientBrief } from "./test-helpers.js";

/**
 * Phase 2, item N — the pure half of the Template Studio: the lifecycle
 * check, the honest format ranking, the invented-metric refusal, the plan,
 * the code-built sample and the interest headroom.
 *
 * The claim under test throughout is honesty rather than cleverness. The
 * ranking's job is not to produce a number; it is to produce a number ONLY
 * when it was given the data to compute one, and to name what it was missing
 * the rest of the time.
 */

const post = (over: Partial<StudioReferencePost> & { username: string; excerpt: string }): StudioReferencePost => ({
  platform: "instagram",
  url: `https://instagram.test/p/${Math.abs(hash(over.excerpt + over.username))}`,
  ...over,
});

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return h;
}

const LIST = "3 ways to cut onboarding time in half";
const STAT = "63% of teams still onboard their customers by hand";
const QUOTE = '"the fastest onboarding we have ever run" — a customer, last quarter';

describe("the routing constraint: eight ids, and the slots each can actually fill", () => {
  it("names exactly the eight routable archetypes, and text_only is deliberately not one of them", () => {
    expect([...ROUTABLE_ARCHETYPE_IDS].sort()).toEqual(
      ["closer", "comparison_card", "cover", "headline_focus", "list_takeaway", "photo", "quote_card", "stat_callout"],
    );
    // `text_only` routes to the client's OWN base template, not a registry
    // row, so a studio template claiming it could never be materialised.
    expect(ROUTABLE_ARCHETYPE_IDS).not.toContain("text_only");
    expect(ROUTABLE_ARCHETYPE_IDS).not.toContain("custom");
    // Every routable id has a slot list and a role, or gate 1 and gate 2
    // would disagree about what exists.
    for (const id of ROUTABLE_ARCHETYPE_IDS) {
      expect(SLOTS_BY_ARCHETYPE[id]).toBeDefined();
      expect(ROLE_BY_ARCHETYPE[id]).toBeDefined();
    }
    expect(ROLE_BY_ARCHETYPE["cover"]).toBe("cover");
    expect(ROLE_BY_ARCHETYPE["closer"]).toBe("closer");
    expect(ROLE_BY_ARCHETYPE["headline_focus"]).toBe("interior");
  });

  it("keeps the id and the (client, archetype) uniqueness constraint the same string", () => {
    expect(studioTemplateId("acme", "cover")).toBe("studio_acme_cover");
    // The colon form is tolerated on read, so an operator following the
    // registry's other ids cannot create a row the lifecycle check ignores.
    expect(isStudioTemplateId("studio:acme:cover")).toBe(true);
    expect(isStudioTemplateId(studioTemplateId("acme", "cover"))).toBe(true);
    expect(isStudioTemplateId("bundled:cover")).toBe(false);
  });

  it("knows only slot names contentFor can supply", () => {
    expect(KNOWN_SLOT_NAMES.has("figure")).toBe(true);
    expect(KNOWN_SLOT_NAMES.has("device")).toBe(true);
    expect(KNOWN_SLOT_NAMES.has("takeaway")).toBe(true);
    expect(KNOWN_SLOT_NAMES.has("subheadDeck")).toBe(false);
    // A per-archetype set, not a global one: a quote card has no figure.
    expect(SLOTS_BY_ARCHETYPE["quote_card"]).not.toContain("figure");
    expect(SLOTS_BY_ARCHETYPE["stat_callout"]).toContain("figure");
  });
});

describe("00c-check-template-studio: three answers, one of which costs money", () => {
  const row = (over: Partial<StudioStoredRow> & { archetypeId: string }): StudioStoredRow => ({
    id: studioTemplateId("acme", over.archetypeId),
    enabled: true,
    updatedAt: Date.UTC(2026, 8, 1),
    ...over,
  });
  const now = new Date(Date.UTC(2026, 8, 10));

  it("generates when there is nothing, and says so", () => {
    const check = checkTemplateStudio({ rows: [], now });
    expect(check.action).toBe("generate");
    expect(check.reason).toContain("no studio templates for this client yet");
  });

  it("reuses a fresh approved set and spends nothing", () => {
    const check = checkTemplateStudio({ rows: [row({ archetypeId: "cover" }), row({ archetypeId: "closer" })], now });
    expect(check.action).toBe("reuse");
    expect(check.archetypeIds).toEqual(["closer", "cover"]);
    expect(check.staleArchetypeIds).toEqual([]);
  });

  it("holds at awaiting-approval rather than regenerating over the rows a human is being asked to look at", () => {
    const check = checkTemplateStudio({ rows: [row({ archetypeId: "cover", enabled: false }), row({ archetypeId: "closer", enabled: false })], now });
    expect(check.action).toBe("awaiting-approval");
    expect(check.reason).toContain("none is approved yet");
    expect(check.reason).toContain("bundled archetypes");
  });

  it("regenerates once every row is past the TTL, and treats an undatable row as stale", () => {
    const stale = row({ archetypeId: "cover", updatedAt: Date.UTC(2026, 8, 10) - (STUDIO_TTL_DAYS + 1) * 24 * 60 * 60 * 1000 });
    expect(checkTemplateStudio({ rows: [stale], now }).action).toBe("generate");

    const undatable = { id: studioTemplateId("acme", "closer"), archetypeId: "closer", enabled: true } as StudioStoredRow;
    const check = checkTemplateStudio({ rows: [undatable], now });
    expect(check.action).toBe("generate");
    expect(check.staleArchetypeIds).toEqual(["closer"]);
  });

  it("keeps reusing while ONE row is fresh — a partial set is not a reason to pay again", () => {
    const fresh = row({ archetypeId: "cover" });
    const stale = row({ archetypeId: "closer", updatedAt: Date.UTC(2025, 0, 1) });
    expect(checkTemplateStudio({ rows: [fresh, stale], now }).action).toBe("reuse");
  });

  /**
   * "NO ROWS" IS TWO DIFFERENT SITUATIONS.
   *
   * The store rows are the studio's only durable record (spec finding 11
   * deleted the manifest), so a setup that ran and stored NOTHING leaves the
   * store exactly as it found it. Read as "never tried", the next weekly run
   * re-resolves `generate` and re-pays `00c3` ($0.042) plus N x `00c4`
   * ($0.051) plus repairs, on its own meter, unbounded, against an item
   * documented twice as running "at most once per client per 120 days". Both
   * zero-store paths are reachable and both are warns that fall through: the
   * design-brief turn can fail its schema, and every candidate can be dropped
   * by the eight gates.
   *
   * The setup history under `SETUP_BUDGET_BELIEF_KEY` already records
   * `templatesStored: 0`, so the fix is to read it.
   */
  const attempt = (daysAgo: number, templatesStored: number): StudioSetupAttempt => ({
    at: new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    templatesStored,
  });

  it("does NOT re-pay the setup bill when a recent setup stored nothing — it reuses the bundled set and says when the next attempt is", () => {
    const check = checkTemplateStudio({ rows: [], now, setupHistory: [attempt(3, 0)] });
    expect(check.action).toBe("reuse");
    expect(check.reason).toContain("a setup 3 day(s) ago stored no templates");
    expect(check.reason).toContain("bundled archetypes");
    expect(check.reason).toContain(`${STUDIO_EMPTY_SETUP_COOLDOWN_DAYS - 3} day(s) away`);
    expect(check.reason).toContain("refreshTemplates");
  });

  it("tries again once the cooldown has elapsed", () => {
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS, 0)] }).action).toBe("generate");
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS - 1, 0)] }).action).toBe("reuse");
  });

  it("reads the NEWEST attempt, and only a zero-store one earns the cooldown", () => {
    // A setup that stored rows and has none now is a DELETION, not a failure,
    // and regenerating is the right answer there.
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(3, 4)] }).action).toBe("generate");
    // Newest wins whatever order the history arrives in.
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(3, 0), attempt(60, 5)] }).action).toBe("reuse");
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(60, 0), attempt(3, 5)] }).action).toBe("generate");
    // An unparseable timestamp is ignored rather than trusted, so a hand-edited
    // beliefs document cannot suppress a setup forever.
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [{ at: "not a date", templatesStored: 0 }] }).action).toBe("generate");
  });

  it("refreshTemplates overrides the cooldown, which is the operator's escape hatch after a fix", () => {
    expect(checkTemplateStudio({ rows: [], now, setupHistory: [attempt(1, 0)], refreshRequested: true }).action).toBe("generate");
  });

  it("the cooldown is shorter than the TTL, because a zero-store setup is usually a transient failure", () => {
    expect(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS).toBeLessThan(STUDIO_TTL_DAYS);
    expect(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS).toBeGreaterThan(7);
  });

  /**
   * THE TTL REFRESH MUST BE ABLE TO AUTHOR SOMETHING.
   *
   * `archetypeIds` covers every row, stale included, and the generation path
   * feeds the duplicate guard. Hand it the full list on a fully-stale set and
   * every proposal is refused as a duplicate of the very row the refresh is
   * replacing: nothing is authored, nothing is stored, the stale rows stay,
   * and the next run takes the same `stale.length === rows.length` branch and
   * re-pays the setup bill — forever, because the zero-store cooldown is
   * gated on `rows.length === 0` and can never be reached.
   *
   * `freshArchetypeIds` is what a generation path passes instead.
   */
  it("subtracts the stale rows from the duplicate guard, so a fully-stale set can actually be re-authored", () => {
    const old = (archetypeId: string) => row({ archetypeId, updatedAt: now.getTime() - (STUDIO_TTL_DAYS + 5) * 24 * 60 * 60 * 1000 });
    const check = checkTemplateStudio({ rows: [old("cover"), old("closer"), old("stat_callout"), old("photo")], now });
    expect(check.action).toBe("generate");
    expect(check.archetypeIds).toEqual(["closer", "cover", "photo", "stat_callout"]);
    expect(check.staleArchetypeIds).toEqual(["closer", "cover", "photo", "stat_callout"]);
    // The list the generation path actually uses.
    expect(check.freshArchetypeIds).toEqual([]);

    // And the guard it feeds now authors the set instead of rejecting it.
    const brief = {
      templates: check.staleArchetypeIds.map((archetypeId) => ({
        archetypeId,
        role: "interior" as const,
        formatLabel: "carousel",
        ground: "colour-block" as const,
        why: "re-authored past the TTL",
      })),
    };
    expect(planStudioTemplates(brief, { budgetTemplates: 6, existingArchetypeIds: check.archetypeIds }).templates).toHaveLength(0);
    const replanned = planStudioTemplates(brief, { budgetTemplates: 6, existingArchetypeIds: check.freshArchetypeIds });
    expect(replanned.templates.map((t) => t.archetypeId)).toEqual(["closer", "cover", "photo", "stat_callout"]);
    expect(replanned.rejected).toEqual([]);
  });

  it("keeps a FRESH row in the duplicate guard while a partial set regenerates", () => {
    const fresh = row({ archetypeId: "cover" });
    const stale = row({ archetypeId: "closer", updatedAt: Date.UTC(2025, 0, 1) });
    const check = checkTemplateStudio({ rows: [fresh, stale], now, refreshRequested: false });
    expect(check.freshArchetypeIds).toEqual(["cover"]);
  });

  it("takes NOTHING on an explicit refreshTemplates — the run asked for the whole set again", () => {
    const check = checkTemplateStudio({ rows: [row({ archetypeId: "cover" }), row({ archetypeId: "closer" })], now, refreshRequested: true });
    expect(check.action).toBe("generate");
    expect(check.archetypeIds).toEqual(["closer", "cover"]);
    expect(check.freshArchetypeIds).toEqual([]);
  });

  it("regenerates on request, and ignores bundled rows entirely", () => {
    expect(checkTemplateStudio({ rows: [row({ archetypeId: "cover" })], now, refreshRequested: true }).action).toBe("generate");
    const bundled: StudioStoredRow = { id: "bundled:cover", archetypeId: "cover", enabled: true, updatedAt: Date.UTC(2026, 8, 9) };
    expect(checkTemplateStudio({ rows: [bundled], now }).action).toBe("generate");
  });
});

describe("rankReferenceFormats: per-account z-scores, and no invented number", () => {
  it("normalises WITHIN an account, so a large account's median does not beat a small account's outlier", () => {
    const posts: StudioReferencePost[] = [
      // A big account whose every post lands identically: no spread, no
      // information, z = 0.
      ...[1, 2, 3, 4, 5].map((i) => post({ username: "big", excerpt: `${LIST} (${i})`, engagement: { likes: 1000 } })),
      // A small account whose ONE stat-led post is four times its own norm.
      ...[1, 2, 3].map((i) => post({ username: "small", excerpt: `${LIST} — take ${i}`, engagement: { likes: 10 } })),
      post({ username: "small", excerpt: STAT, engagement: { likes: 100 } }),
    ];
    const { rows } = rankReferenceFormats(posts);

    expect(rows[0]!.format).toBe("stat-led");
    expect(rows[0]!.normalisedScore!).toBeGreaterThan(1);
    expect(rows[0]!.postCount).toBe(1);
    // The absolute figures say the opposite: the big account's ordinary post
    // out-likes the small account's best by 10x. An absolute ranking would
    // simply rediscover which reference account is biggest.
    const numbered = rows.find((r) => r.format === "numbered list")!;
    expect(numbered.postCount).toBe(8);
    expect(numbered.normalisedScore!).toBeLessThan(rows[0]!.normalisedScore!);
  });

  it("gives a row NO score and a NAMED absence when no post in it carried a numeric field", () => {
    const posts = [
      post({ username: "peer", excerpt: STAT, engagement: { likes: 40 } }),
      post({ username: "peer", excerpt: STAT.replace("63", "41"), engagement: { likes: 10 } }),
      post({ username: "peer", excerpt: QUOTE }),
    ];
    const { rows } = rankReferenceFormats(posts);
    const quote = rows.find((r) => r.format === "quote")!;

    expect(quote.normalisedScore).toBeUndefined();
    expect(quote.signalsAvailable).toEqual([]);
    expect(quote.signalsAbsent).toEqual([
      "likes absent for 1 of 1 accounts (instagram/@peer)",
      "comments absent for 1 of 1 accounts (instagram/@peer)",
      "views absent for 1 of 1 accounts (instagram/@peer)",
    ]);
    // A scored row still sorts above an unscored one, and the unscored one is
    // still THERE — dropping it would hide a format from the thesis.
    expect(rows.findIndex((r) => r.format === "stat-led")).toBeLessThan(rows.findIndex((r) => r.format === "quote"));
  });

  it("names exactly which signals the provider returned and which it did not", () => {
    const posts = [
      post({ username: "a", excerpt: LIST, engagement: { likes: 100, comments: 8 } }),
      post({ username: "a", excerpt: `${LIST} again`, engagement: { likes: 20, comments: 1 } }),
      post({ username: "b", excerpt: `${LIST} once more`, engagement: { likes: 55 } }),
    ];
    const { rows } = rankReferenceFormats(posts);
    const list = rows.find((r) => r.format === "numbered list")!;

    expect(list.signalsAvailable).toEqual(["likes", "comments"]);
    expect(list.signalsAbsent).toEqual([
      "comments absent for 1 of 2 accounts (instagram/@b)",
      "views absent for 2 of 2 accounts (instagram/@a, instagram/@b)",
    ]);
    expect(list.accounts).toEqual(["instagram/@a", "instagram/@b"]);
    expect(list.exampleUrls.length).toBe(3);
  });

  it("says plainly that the ranking is qualitative when no post anywhere carried a figure", () => {
    const { rows, notes } = rankReferenceFormats([post({ username: "a", excerpt: LIST }), post({ username: "a", excerpt: STAT })]);
    expect(rows.every((r) => r.normalisedScore === undefined)).toBe(true);
    expect(notes.join(" ")).toContain("QUALITATIVE");
    expect(notes.join(" ")).toContain("must not be described as a performance ranking");
  });

  it("still ranks posts from a single account, and warns what that comparison is worth", () => {
    const posts = [
      post({ username: "solo", excerpt: STAT, engagement: { likes: 900 } }),
      post({ username: "solo", excerpt: LIST, engagement: { likes: 100 } }),
      post({ username: "solo", excerpt: `${LIST} two`, engagement: { likes: 120 } }),
      post({ username: "solo", excerpt: `${LIST} three`, engagement: { likes: 80 } }),
    ];
    const { rows, notes } = rankReferenceFormats(posts);
    expect(rows[0]!.format).toBe("stat-led");
    expect(notes.some((n) => n.includes("every post came from 1 account"))).toBe(true);
  });

  it("reports no readable posts as an absence rather than an empty ranking nobody notices", () => {
    const { rows, notes } = rankReferenceFormats([{ platform: "x", username: "ghost", url: "https://x.test/1", excerpt: "   " }]);
    expect(rows).toEqual([]);
    expect(notes[0]).toContain("no readable reference posts");
  });

  it("classifies every post somewhere, in Hebrew as well as Latin", () => {
    expect(classifyPostFormat(LIST)).toBe("numbered list");
    expect(classifyPostFormat("5 טעויות שכל מנהל שיווק עושה")).toBe("numbered list");
    expect(classifyPostFormat(STAT)).toBe("stat-led");
    expect(classifyPostFormat(QUOTE)).toBe("quote");
    expect(classifyPostFormat("How we cut onboarding in half")).toBe("how-to");
    expect(classifyPostFormat("איך קיצרנו את זמן ההטמעה")).toBe("how-to");
    expect(classifyPostFormat("What would you change first?")).toBe("question");
    expect(classifyPostFormat("Introducing the new pipeline")).toBe("announcement");
    expect(classifyPostFormat("We rebuilt the whole editorial calendar this month.")).toBe("single statement");
  });

  it("produces the same ranking twice from the same evidence", () => {
    const posts = [
      post({ username: "a", excerpt: LIST, engagement: { likes: 10, views: 900 } }),
      post({ username: "b", excerpt: STAT, engagement: { likes: 40 } }),
      post({ username: "b", excerpt: QUOTE, engagement: { likes: 4 } }),
    ];
    expect(rankReferenceFormats(posts)).toEqual(rankReferenceFormats(posts));
  });
});

describe("assertNoInventedMetrics: the block the model saw is the block the claim is checked against", () => {
  const evidence = formatEvidenceBlock(
    rankReferenceFormats([
      post({ username: "peer", excerpt: STAT, engagement: { likes: 400, comments: 20 } }),
      post({ username: "peer", excerpt: LIST, engagement: { likes: 100, comments: 4 } }),
    ]).rows,
    ["3 of 12 posts carried no engagement figures"],
  );

  it("catches a fabricated multiplier", () => {
    const verdict = assertNoInventedMetrics("stat-led covers get 3.2x more saves than a headline", evidence);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining('claims "3.2x"') });
    expect(verdict).toMatchObject({ reason: expect.stringContaining("must not be stated") });
  });

  it("passes a number that is actually in the evidence, whitespace notwithstanding", () => {
    expect(evidence).toContain("3 of 12 posts");
    expect(assertNoInventedMetrics("3 of 12 posts had no figures at all, so this rests on frequency", evidence)).toEqual({ ok: true });
    // "3.2 x" in the evidence would cover "3.2x" in a claim, and only that.
    expect(assertNoInventedMetrics("scored 3.2x", "the row scored 3.2 x higher").ok).toBe(true);
  });

  it("passes a citation with no numbers at all, which is the honest shape when nothing was measured", () => {
    expect(assertNoInventedMetrics("every top post on both accounts opens on a single figure", evidence)).toEqual({ ok: true });
  });

  it("is strict about years and counts too — a number that is right by luck is still unsourced", () => {
    expect(assertNoInventedMetrics("the 2024 benchmark says otherwise", evidence).ok).toBe(false);
  });
});

describe("planStudioTemplates: code owns the constraints, the thesis only proposes", () => {
  const proposal = (ids: string[]) => ({
    templates: ids.map((archetypeId) => ({
      archetypeId,
      role: "interior" as const,
      formatLabel: "stat-led",
      ground: "colour-block" as const,
      why: "the top posts open on a figure",
    })),
  });

  it("refuses a non-routable id with the reason, and authors the rest", () => {
    const plan = planStudioTemplates(proposal(["cover", "split_diagonal", "closer"]), { budgetTemplates: 6 });
    expect(plan.templates.map((t) => t.archetypeId)).toEqual(["cover", "closer"]);
    expect(plan.rejected[0]!.reason).toContain("not one of the eight routable archetype ids");
    expect(plan.rejected[0]!.reason).toContain("could ever route");
  });

  it("keeps at most one row per archetype, counting what this client already has", () => {
    const plan = planStudioTemplates(proposal(["cover", "cover", "stat_callout"]), { budgetTemplates: 6, existingArchetypeIds: ["stat_callout"] });
    expect(plan.templates.map((t) => t.archetypeId)).toEqual(["cover"]);
    expect(plan.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining("already has a studio template"),
      expect.stringContaining("already has a studio template"),
    ]);
  });

  it("stops at the budget's template count and records what it did not author", () => {
    const plan = planStudioTemplates(proposal(["cover", "closer", "stat_callout", "quote_card", "list_takeaway"]), { budgetTemplates: 4 });
    expect(plan.templates).toHaveLength(4);
    expect(plan.rejected[0]!.reason).toContain("the setup budget allows 4 template(s)");
  });

  it("overrides the thesis's role with the role the interest floor will actually judge at", () => {
    // A `cover` graded as an interior slide would be exempt from the one
    // clause covers exist to satisfy, which is how a headline-on-flat-ground
    // cover would have passed.
    const plan = planStudioTemplates(proposal(["cover"]), { budgetTemplates: 6 });
    expect(plan.templates[0]!.role).toBe("cover");
  });
});

describe("the sample content is built by CODE", () => {
  const brief = goodClientBrief();
  const kit = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC", "--accent": "#C8FF4D" }, palette: ["#C8FF4D"] };

  it("fills every declared slot from the client's own brief, with typical lengths", () => {
    const seed = studioSampleSeedFromBrief({ brief, kit, clientSlug: "acme" });
    const content = buildStudioSampleContent({ archetypeId: "stat_callout", slots: ["figure", "subLabel", "body", "sourceLine", "device"] }, seed);

    expect(content.fields["figure"]).toBe("63%");
    expect(content.fields["body"]).toContain("Acme runs the weekly content pipeline");
    expect(content.fields["sourceLine"]).toBe("internal data, 2026");
    expect(content.fields["accentColor"]).toBe("#C8FF4D");
    // The device slot goes through the RAW channel, so its fragment is built
    // and escaped here rather than substituted as text.
    expect(content.htmlFragments["device"]).toContain("device-figure-value");
    expect(content.imagePaths).toEqual({});
    // Standing furniture is always present, whatever the template declared.
    expect(content.fields["dir"]).toBe("ltr");
    expect(content.fields["brandHandle"]).toBe("@acme");
  });

  it("escapes a brief that contains markup, because these fragments are raw by construction", () => {
    const seed = studioSampleSeedFromBrief({
      brief: goodClientBrief({ positioning: { oneLiner: "<script>alert(1)</script> Acme ships content", whatWeSell: "x", differentiators: [] } }),
      kit,
      clientSlug: "acme",
    });
    const content = buildStudioSampleContent({ archetypeId: "list_takeaway", slots: ["headline", "itemRows"] }, seed);
    expect(content.htmlFragments["itemRows"]).not.toContain("<script>");
    expect(content.htmlFragments["itemRows"]).toContain("&lt;script&gt;");
  });

  it("only fills a hero when the caller actually has an image path — a photo ground must otherwise hold the frame itself", () => {
    const seed = studioSampleSeedFromBrief({ brief, kit, clientSlug: "acme" });
    expect(buildStudioSampleContent({ archetypeId: "cover", slots: ["title", "hero"] }, seed).imagePaths).toEqual({});
    const withHero = studioSampleSeedFromBrief({ brief, kit, clientSlug: "acme", heroPath: "fixtures/hero.png" });
    expect(buildStudioSampleContent({ archetypeId: "cover", slots: ["title", "hero"] }, withHero).imagePaths).toEqual({ hero: "fixtures/hero.png" });
  });

  it("uses the client's own words in RTL when they are in the target script, and a glyph probe when they are not", () => {
    // A Hebrew client whose brief is written in Hebrew: the sample is their
    // own text, which is the strongest possible check.
    const hebrewBrief = goodClientBrief({
      positioning: { oneLiner: "גיקטיים מסקרת את עולם ההייטק הישראלי לקהל מקצועי.", whatWeSell: "כיסוי יומי", differentiators: [] },
    });
    const own = studioSampleSeedFromBrief({ brief: hebrewBrief, kit, clientSlug: "geektime", targetLanguage: "Hebrew", dir: "rtl" });
    expect(own.headline).toContain("גיקטיים");

    // A Hebrew client whose brief happens to be in English would otherwise be
    // RTL-validated with Latin glyphs, which proves nothing about whether the
    // script font loaded — the exact defect gate 8 exists to catch.
    const probe = studioSampleSeedFromBrief({ brief, kit, clientSlug: "geektime", targetLanguage: "he-IL", dir: "rtl" });
    // Phase 4 (RFC-15 §7.4) appends a mixed-direction fragment (a Latin
    // product name, a parenthesised term, a percentage, a year range) to the
    // seed so gate 8 also exercises bidi. The probe must still LEAD the
    // string — `startsWith`, not `toContain` — because gate 8's other half
    // asks "did the script font load", and that is answered by the glyph
    // probe rendering at the head of the headline, not by it appearing
    // somewhere after a run of Latin.
    expect(probe.headline.startsWith(SCRIPT_GLYPH_PROBE["Hebrew"]!)).toBe(true);
    expect(probe.cta).toBe("שמרו את הפוסט");
    expect(probe.dir).toBe("rtl");
  });
});

describe("interestHeadroom: calibration room, and only where a threshold has any", () => {
  const thresholds = {
    largestEmptyRectCeiling: { cover: 0.22, interior: 0.28, closer: 0.22 },
    occupiedShareFloor: { cover: 0.42, interior: 0.3, closer: 0.42 },
    flatBackgroundCeiling: 0.7,
    imageryOrDeviceFloor: 0.03,
    textShareCeiling: 0.55,
  };
  const metrics = (over: Partial<StudioSlideMetrics> = {}): StudioSlideMetrics => ({
    backgroundHex: "#17181C",
    backgroundMatchesBrandGround: true,
    flatBackgroundShare: 0.5,
    inkShare: 0.06,
    occupiedShare: 0.5,
    contentOccupiedShare: 0.32,
    largestEmptyRect: { x: 0, y: 0, w: 100, h: 100 },
    largestEmptyRectShare: 0.1,
    largestEmptyContentRect: { x: 0, y: 0, w: 120, h: 120 },
    largestEmptyContentRectShare: 0.14,
    imageryShare: 0.2,
    graphicShare: 0.1,
    imageryOrDeviceShare: 0.3,
    textShare: 0.2,
    accentShare: 0.01,
    accentPresent: true,
    edgeDensity: 0.12,
    quantisedColourCount: 5,
    clippedEdgeShare: 0,
    ...over,
  });

  it("reports the tightest share clause and how much room is left", () => {
    const headroom = interestHeadroom(metrics({ largestEmptyRectShare: 0.26 }), "interior", thresholds);
    expect(headroom).toEqual({ margin: 0.02, tightest: "dead-space" });
  });

  it("treats the substance clause as the AND it is: busy is safe however flat the ground", () => {
    // Flat 0.82 is over the 0.70 ceiling, but occupied 0.46 is well over the
    // interior floor — a bold type poster, not a defect.
    const headroom = interestHeadroom(metrics({ flatBackgroundShare: 0.82, occupiedShare: 0.46 }), "interior", thresholds);
    // 0.16 of room on the occupied half, even though the flat half is 0.12
    // OVER its ceiling: the clause is `flat AND idle`, so being busy is
    // enough. A single flat-background ceiling would have failed this poster.
    expect(headroom).toEqual({ margin: 0.16, tightest: "empty" });
    expect(headroom.margin).toBeGreaterThan(STUDIO_INTEREST_MARGIN);
  });

  it("adds the device clause for a cover and a closer, and leaves interiors exempt", () => {
    const bare = metrics({ imageryOrDeviceShare: 0.01 });
    expect(interestHeadroom(bare, "interior", thresholds).tightest).not.toBe("no-device");
    expect(interestHeadroom(bare, "cover", thresholds)).toEqual({ margin: -0.02, tightest: "no-device" });
    expect(interestHeadroom(bare, "closer", thresholds).tightest).toBe("no-device");
  });

  it("never measures a margin against the two integrity thresholds, which have no room to give", () => {
    // INK_SHARE_FLOOR (0.015) and CLIPPED_EDGE_SHARE_CEILING (0.004) are so
    // close to zero that a 0.05 margin against them is arithmetically
    // impossible — and neither is about taste. `checkInterestFloor` answers
    // them as pass/fail; a margin is calibration room.
    const thin = metrics({ inkShare: 0.016, clippedEdgeShare: 0.003 });
    expect(interestHeadroom(thin, "interior", thresholds).margin).toBeGreaterThan(STUDIO_INTEREST_MARGIN);
  });

  it("holds a stored template to more room than a run's slide gets", () => {
    expect(STUDIO_INTEREST_MARGIN).toBe(0.05);
    const barelyPassing = metrics({ largestEmptyRectShare: 0.26 });
    expect(interestHeadroom(barelyPassing, "interior", thresholds).margin).toBeLessThan(STUDIO_INTEREST_MARGIN);
  });
});

describe("the inputs code hands the three setup agents", () => {
  const brief = goodClientBrief();
  const evidence = rankReferenceFormats([
    post({ username: "peer", excerpt: STAT, engagement: { likes: 400, comments: 20 } }),
    post({ username: "peer", excerpt: LIST, engagement: { likes: 100, comments: 4 } }),
  ]);

  it("assembles the design-brief call and names every gap it could not read", () => {
    const { input, gaps } = buildDesignBriefInput({ clientSlug: "acme", brief, referenceFormats: evidence, problems: ["could not read x/@dormant: 404"] }, 5);

    expect(input.templatesWanted).toBe(5);
    expect(input.routableArchetypes).toEqual(ROUTABLE_ARCHETYPE_IDS);
    expect(input.positioning).toContain("Acme runs the weekly content pipeline");
    expect(input.icp).toContain("Founders and heads of marketing");
    expect(input.forbiddenTopics).toEqual(["politics"]);
    expect(input.formatEvidence).toContain("stat-led");
    // Everything the gather step could not read reaches the model verbatim,
    // so the thesis names the same shortfalls instead of designing around a
    // hole it cannot see.
    expect(gaps).toContain("could not read x/@dormant: 404");
    expect(gaps).toContain("no brand kit on file — the templates must work on the engine's default tokens");
    expect(gaps).toContain("the client's own site could not be read");
    expect(gaps).toContain("no reference-post images were inspected — formats were ranked from post text alone");
    expect(input.gaps).toEqual(gaps);
  });

  it("gives a designer call only the slots ITS archetype can fill, plus the script's own families", () => {
    const input = buildDesignerInput({
      planned: { archetypeId: "closer", role: "closer", formatLabel: "question closer", ground: "colour-block", why: "every closing slide ends on a question" },
      brief: { thesis: "quiet cover, loud middle, calm close", setRules: ["one accent moment per slide"] },
      bundle: { clientSlug: "geektime", brief, referenceFormats: evidence, targetLanguage: "Hebrew", kit: { cssVars: { "--bg": "#0B0B0C" } } },
    });

    expect(input.availableSlots).toEqual(SLOTS_BY_ARCHETYPE["closer"]);
    expect(input.privilegedHtmlSlots).toContain("recap");
    expect(input.canvas).toEqual({ width: 1080, height: 1440 });
    expect(input.scriptFamilies).toMatchObject({ typeScale: 0.94 });
    expect(input.scriptFamilies!.display).toContain("Heebo");
    expect(input.repairFindings).toBeUndefined();
  });

  it("hands a repair call the failing gates and the previous attempt, so it is not a re-roll", () => {
    const input = buildDesignerInput({
      planned: { archetypeId: "cover", role: "cover", formatLabel: "stat-led cover", ground: "image", why: "the top posts open on a photograph" },
      brief: { thesis: "t", setRules: ["r"] },
      bundle: { clientSlug: "acme", brief },
      repair: { findings: ["gate-6-interest-floor: occupied 0.31 against a 0.42 floor [measured occupiedShare=0.31]"], previous: { bodyHtml: "<div></div>", css: ".a{}" } },
    });
    expect(input.repairFindings![0]).toContain("0.31");
    expect(input.previous!.css).toBe(".a{}");
  });
});

describe("storing the survivors, and what the reviewer is shown", () => {
  const draft = StudioTemplateDraftSchema.parse({
    archetypeId: "cover",
    name: "Acme photo cover",
    role: "cover",
    layoutType: "photo",
    ground: "image",
    slots: ["title", "hero"],
    bodyHtml: `<div class="ground">{{image:hero}}</div><h1>{{title}}</h1>`,
    css: ".ground { position: absolute; inset: 0; }",
    sample: { title: "A cover title", hero: "fixtures/hero.png" },
    derivedFrom: {
      formatLabel: "stat-led cover",
      accounts: ["instagram/@peer"],
      postCount: 9,
      normalisedScore: 1.24,
      signalsAvailable: ["likes", "comments"],
      signalsAbsent: ["views absent for 1 of 1 accounts"],
      exampleUrls: ["https://instagram.test/p/1"],
      why: "every top post on the peer account opens on a photograph",
    },
  });
  const validation: StudioTemplateValidation = {
    archetypeId: "cover",
    ok: true,
    failures: [],
    warnings: ["the sample paints only 2 distinct colour(s)"],
    ltr: {
      metrics: {
        backgroundHex: "#17181C",
        backgroundMatchesBrandGround: true,
        flatBackgroundShare: 0.31,
        inkShare: 0.09,
        occupiedShare: 0.611,
        contentOccupiedShare: 0.58,
        largestEmptyRect: { x: 0, y: 0, w: 4, h: 4 },
        largestEmptyRectShare: 0.081,
        largestEmptyContentRect: { x: 0, y: 0, w: 8, h: 8 },
        largestEmptyContentRectShare: 0.09,
        imageryShare: 0.62,
        graphicShare: 0.02,
        imageryOrDeviceShare: 0.64,
        textShare: 0.19,
        accentShare: 0.004,
        accentPresent: true,
        edgeDensity: 0.2,
        quantisedColourCount: 2,
        clippedEdgeShare: 0,
      },
      probe: { n: 1, overflow: false, overflowing: [], offscreen: [], elementCount: 9, textBoxShare: 0.2, fontFamiliesUsed: ["Fraunces"] },
      margin: 0.139,
      tightest: "dead-space",
      findings: [],
      slideUrl: "https://storage.test/studio/cover.png",
    },
  };

  it("stores disabled, at the studio score, with the numbers in the row's own note", () => {
    const promotion = buildStudioPromotion({ draft, validation, clientSlug: "acme", document: "<!doctype html>…", qualityScore: DEFAULT_QUALITY_STUDIO, now: 1_700_000_000_000 });

    expect(promotion.id).toBe(studioTemplateId("acme", "cover"));
    expect(promotion.enabled).toBe(false);
    expect(promotion.qualityScore).toBe(DEFAULT_QUALITY_STUDIO);
    expect(promotion.role).toBe("cover");
    expect(promotion.source).toBe("ai_generated");
    expect(promotion.actor).toBe("studio");
    // The evidence that let this template in is readable off the row a year
    // later, without a run trace to cross-reference.
    expect(promotion.note).toContain('from the "stat-led cover" format');
    expect(promotion.note).toContain("measured occupied 0.611, flat 0.31, floor margin 0.139");
    expect(promotion.note).toContain("disabled until a human approves it");
  });

  it("reports the set the way a reviewer needs to approve it — including what was missing", () => {
    const report = summarizeStudio({
      check: { action: "generate", reason: "no studio templates for this client yet", rows: [], archetypeIds: [], staleArchetypeIds: [], freshArchetypeIds: [] },
      stored: [{ promotion: buildStudioPromotion({ draft, validation, clientSlug: "acme", document: "<!doctype html>", qualityScore: DEFAULT_QUALITY_STUDIO, now: 1 }), validation }],
      dropped: [{ archetypeId: "closer", reason: "occupied 0.31 against a 0.42 floor after one repair" }],
      evidence: {
        rows: [{ format: "stat-led", accounts: ["instagram/@peer"], postCount: 9, normalisedScore: 1.24, signalsAvailable: ["likes"], signalsAbsent: ["views absent for 1 of 1 accounts"], exampleUrls: [] }],
        notes: ["3 of 12 posts carried no engagement figures and count toward frequency only"],
      },
      notes: ["set review: the four read as one system"],
    });

    expect(report.templates[0]).toMatchObject({ templateId: "studio_acme_cover", archetypeId: "cover", role: "cover", formatLabel: "stat-led cover", rtlChecked: false });
    expect(report.templates[0]!.measured).toMatchObject({ occupiedShare: 0.611, margin: 0.139 });
    expect(report.templates[0]!.slideUrl).toBe("https://storage.test/studio/cover.png");
    expect(report.dropped).toEqual([{ archetypeId: "closer", reason: "occupied 0.31 against a 0.42 floor after one repair" }]);
    expect(report.warnings).toEqual(["cover: the sample paints only 2 distinct colour(s)"]);
    // Kept deliberately prominent: what the whole exercise could not measure.
    expect(report.signalsAvailable).toEqual(["likes"]);
    expect(report.signalsAbsent).toEqual(["views absent for 1 of 1 accounts"]);
    expect(report.notes).toEqual(["3 of 12 posts carried no engagement figures and count toward frequency only", "set review: the four read as one system"]);

    expect(studioNote(report)).toBe(
      "template studio: 1 template(s) stored disabled pending approval, 1 dropped (closer: occupied 0.31 against a 0.42 floor after one repair)",
    );
  });

  it("says nothing was generated when nothing needed to be", () => {
    const report = summarizeStudio({
      check: { action: "reuse", reason: "4 approved studio template(s)", rows: [], archetypeIds: [], staleArchetypeIds: [], freshArchetypeIds: [] },
      stored: [],
      dropped: [],
    });
    expect(studioNote(report)).toBe("template studio: reuse — 4 approved studio template(s)");
  });
});
