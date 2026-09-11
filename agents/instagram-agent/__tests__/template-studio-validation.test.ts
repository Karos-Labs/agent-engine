import { describe, expect, it } from "vitest";
import {
  assertSafeMarkup as realAssertSafeMarkup,
  buildCustomArchetypeDocument,
  composeDocument,
} from "@agent-engine/tool-karos-templates";
import {
  STUDIO_INTEREST_MARGIN,
  StudioTemplateDraftSchema,
  formatStudioFailures,
  studioSampleSeedFromBrief,
  validateStudioTemplate,
  type StudioInterestThresholds,
  type StudioRenderOutcome,
  type StudioSlideMetrics,
  type StudioSlideProbe,
  type StudioTemplateDraft,
  type StudioValidationDeps,
} from "../src/workflow/template-studio.js";
import { goodClientBrief } from "./test-helpers.js";

/**
 * Phase 2, item N — **each of the eight gates refuses in isolation, naming
 * the offending thing.**
 *
 * This is the file that carries the owner's requirement. "Generate templates"
 * is not the feature; refusing a template that renders empty, illegible,
 * unroutable or unreadable in Hebrew is. So every gate is driven to a failure
 * on its own, with every other gate passing, and the assertion is on what the
 * refusal SAYS — a reason a repair turn can act on, with the measured number
 * in it.
 *
 * ## The two test doubles, and why they are faithful
 *
 * `assertSafeMarkup` here delegates to the REAL exported function after
 * rewriting only the privileged placeholders the caller explicitly allowed
 * into their plain `{{slot}}` form. Every real check therefore still runs
 * (forbidden tags, inline handlers, dangerous URL schemes, undeclared
 * placeholders, and the refusal of any privileged form that was NOT allowed),
 * which is precisely the contract the opt-in allowlist has.
 *
 * The interest policy is a local, spec-faithful stand-in for item L's
 * `checkInterestFloor` (clauses A-F, the same named thresholds), so this file
 * proves the STUDIO's use of the floor — the role, the margin, the RTL
 * re-check — without re-testing the floor itself, which has its own file.
 */

// ─────────────────────────────────────────────────────────────────────────
// Doubles
// ─────────────────────────────────────────────────────────────────────────

const THRESHOLDS: StudioInterestThresholds = {
  largestEmptyRectCeiling: { cover: 0.22, interior: 0.28, closer: 0.22 },
  occupiedShareFloor: { cover: 0.42, interior: 0.3, closer: 0.42 },
  flatBackgroundCeiling: 0.7,
  imageryOrDeviceFloor: 0.03,
  textShareCeiling: 0.55,
};

const INK_SHARE_FLOOR = 0.015;
const CLIPPED_EDGE_SHARE_CEILING = 0.004;

/** Item L's clauses A-F, in order, as a stand-in for `checkInterestFloor`. */
function checkFloorFixture(input: { metrics: StudioSlideMetrics; probe: StudioSlideProbe; role: "cover" | "interior" | "closer" }) {
  const { metrics, probe, role } = input;
  const findings: Array<{ kind: string; sentence: string }> = [];
  if (metrics.inkShare < INK_SHARE_FLOOR) findings.push({ kind: "render-integrity", sentence: `ink covered ${(metrics.inkShare * 100).toFixed(1)}% of the plate — the render looks broken, not boring` });
  else if (probe.overflow || metrics.clippedEdgeShare > CLIPPED_EDGE_SHARE_CEILING) findings.push({ kind: "clipped", sentence: "content is clipped at the frame edge" });
  else if (metrics.largestEmptyRectShare > THRESHOLDS.largestEmptyRectCeiling[role]) findings.push({ kind: "dead-space", sentence: `an empty rectangle covered ${(metrics.largestEmptyRectShare * 100).toFixed(0)}% of the plate` });
  else if (metrics.flatBackgroundShare > THRESHOLDS.flatBackgroundCeiling && metrics.occupiedShare < THRESHOLDS.occupiedShareFloor[role])
    findings.push({ kind: "empty", sentence: `${(metrics.flatBackgroundShare * 100).toFixed(0)}% of the pixels were the background colour and only ${(metrics.occupiedShare * 100).toFixed(0)}% of the frame was occupied` });
  else if (role !== "interior" && metrics.imageryOrDeviceShare < THRESHOLDS.imageryOrDeviceFloor)
    findings.push({ kind: "no-device", sentence: `a ${role} carries a photograph, a graphic ground or a figure device — this one measured ${(metrics.imageryOrDeviceShare * 100).toFixed(1)}%` });
  else if (metrics.textShare > THRESHOLDS.textShareCeiling) findings.push({ kind: "text-wall", sentence: `${(metrics.textShare * 100).toFixed(0)}% of the frame is glyph-bearing` });
  return { findings };
}

/** A comfortable pass on every clause, with room to spare. */
function goodMetrics(over: Partial<StudioSlideMetrics> = {}): StudioSlideMetrics {
  return {
    backgroundHex: "#17181C",
    backgroundMatchesBrandGround: true,
    flatBackgroundShare: 0.55,
    inkShare: 0.08,
    occupiedShare: 0.52,
    // The content mask: below `occupiedShare`, because the difference between
    // the two is the template's ground treatment, and comfortably over clause
    // G's floor at every role.
    contentOccupiedShare: 0.34,
    // Comfortable for BOTH role ceilings (0.22 cover/closer, 0.28 interior),
    // so a role-specific test is testing the role rather than the fixture.
    largestEmptyRect: { x: 0, y: 1180, w: 1080, h: 200 },
    largestEmptyRectShare: 0.14,
    largestEmptyContentRect: { x: 0, y: 1120, w: 1080, h: 260 },
    largestEmptyContentRectShare: 0.181,
    imageryShare: 0.18,
    graphicShare: 0.12,
    imageryOrDeviceShare: 0.3,
    textShare: 0.24,
    accentShare: 0.006,
    accentPresent: true,
    edgeDensity: 0.14,
    quantisedColourCount: 5,
    clippedEdgeShare: 0,
    ...over,
  };
}

function goodProbe(over: Partial<StudioSlideProbe> = {}): StudioSlideProbe {
  return {
    n: 1,
    overflow: false,
    overflowing: [],
    offscreen: [],
    elementCount: 14,
    textBoxShare: 0.3,
    fontFamiliesUsed: ["Fraunces", "Inter"],
    ...over,
  };
}

const KIT = { cssVars: { "--bg": "#17181C", "--fg": "#F4F2EC", "--accent": "#C8FF4D" }, palette: ["#C8FF4D"] };

interface DepsOptions {
  ltr?: StudioRenderOutcome;
  rtl?: StudioRenderOutcome;
}

function makeDeps(options: DepsOptions = {}): StudioValidationDeps & { renderCalls: Array<{ dir: string }> } {
  const renderCalls: Array<{ dir: string }> = [];
  return {
    renderCalls,
    assertSafeMarkup(bodyHtml, css, slots, opts = {}) {
      let rewritten = bodyHtml;
      for (const slot of opts.allowImageSlots ?? []) rewritten = rewritten.split(`{{image:${slot}}}`).join(`{{${slot}}}`);
      for (const slot of opts.allowHtmlSlots ?? []) rewritten = rewritten.split(`{{html:${slot}}}`).join(`{{${slot}}}`);
      return realAssertSafeMarkup(rewritten, css, slots);
    },
    // The same code-owned shell `buildStudioTemplateDocument` wraps: doctype,
    // head, font links, the :root token block, the fixed canvas, the standing
    // furniture and the __CAROUSEL_READY__ script.
    buildStudioTemplateDocument: (bodyHtml: string) => buildCustomArchetypeDocument(bodyHtml),
    composeDocument,
    async render(request) {
      renderCalls.push({ dir: request.dir });
      if (request.dir === "rtl") return options.rtl ?? { ok: true, metrics: goodMetrics(), probe: goodProbe({ fontFamiliesUsed: ["Heebo", "Assistant"] }) };
      return options.ltr ?? { ok: true, metrics: goodMetrics(), probe: goodProbe() };
    },
    interest: { check: checkFloorFixture, thresholds: THRESHOLDS },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────

const STAT_BODY = `<div class="plate">
  <p class="eyebrow">{{kicker}}</p>
  <p class="figure">{{figure}}</p>
  <p class="sub">{{subLabel}}</p>
  <p class="lede">{{body}}</p>
  <p class="src">{{sourceLine}}</p>
  {{html:device}}
</div>`;

const STAT_CSS = `.plate { padding-inline: 64px; padding-block-end: 96px; }
.figure { font-family: var(--f-display); font-size: calc(200px * var(--ts, 1)); color: var(--fg); }
.sub { color: var(--accent); }`;

function statDraft(over: Partial<StudioTemplateDraft> = {}): StudioTemplateDraft {
  return StudioTemplateDraftSchema.parse({
    archetypeId: "stat_callout",
    name: "Acme stat plate",
    role: "interior",
    layoutType: "typographic",
    ground: "colour-block",
    slots: ["figure", "subLabel", "body", "sourceLine", "device"],
    bodyHtml: STAT_BODY,
    css: STAT_CSS,
    sample: { figure: "63%", subLabel: "onboard by hand", body: "Two sentences of body copy.", sourceLine: "internal data, 2026", device: "a figure device" },
    derivedFrom: {
      formatLabel: "stat-led",
      accounts: ["instagram/@peer"],
      postCount: 6,
      normalisedScore: 1.1,
      signalsAvailable: ["likes"],
      signalsAbsent: ["views absent for 1 of 1 accounts"],
      exampleUrls: ["https://instagram.test/p/1"],
      why: "the highest-scoring posts on the peer account open on a single figure",
    },
    ...over,
  });
}

function coverDraft(over: Partial<StudioTemplateDraft> = {}): StudioTemplateDraft {
  return StudioTemplateDraftSchema.parse({
    archetypeId: "cover",
    name: "Acme photo cover",
    role: "cover",
    layoutType: "photo",
    ground: "image",
    slots: ["eyebrow", "title", "hero", "device"],
    bodyHtml: `<div class="ground">{{image:hero}}</div><div class="lockup"><p class="eyebrow">{{eyebrow}}</p><h1 class="title">{{title}}</h1>{{html:device}}</div>`,
    css: `.ground { position: absolute; inset: 0; } .lockup { position: absolute; inset-inline-start: 64px; inset-block-end: 96px; } .title { font-family: var(--f-display); font-size: calc(96px * var(--ts, 1)); }`,
    sample: { eyebrow: "playbook", title: "A cover title that wraps once", hero: "fixtures/hero.png", device: "a figure device" },
    derivedFrom: {
      formatLabel: "stat-led cover",
      accounts: ["instagram/@peer"],
      postCount: 6,
      signalsAvailable: ["likes"],
      signalsAbsent: ["views absent for 1 of 1 accounts"],
      exampleUrls: [],
      why: "every top post on the peer account opens on a photograph with a bottom-anchored lockup",
    },
    ...over,
  });
}

const SEED = studioSampleSeedFromBrief({ brief: goodClientBrief(), kit: KIT, clientSlug: "acme" });
const HEBREW_SEED = studioSampleSeedFromBrief({ brief: goodClientBrief(), kit: KIT, clientSlug: "geektime", targetLanguage: "Hebrew", dir: "rtl" });

const validate = (draft: StudioTemplateDraft, deps: StudioValidationDeps, extra: Parameters<typeof validateStudioTemplate>[0] extends infer T ? Partial<T> : never = {}) =>
  validateStudioTemplate({ draft, clientSlug: "acme", kit: KIT, seed: SEED, ...extra }, deps);

// ─────────────────────────────────────────────────────────────────────────

describe("a template that passes every gate", () => {
  it("is stored with its measured numbers, and renders exactly once", async () => {
    const deps = makeDeps();
    const result = await validate(statDraft(), deps);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(deps.renderCalls).toEqual([{ dir: "ltr" }]);
    expect(result.ltr!.margin).toBeGreaterThanOrEqual(STUDIO_INTEREST_MARGIN);
    expect(result.rtl).toBeUndefined();
    // The document is the code-owned shell with the template's own stylesheet
    // composed in — the same bytes materialization will write on every run.
    expect(result.document).toContain("__CAROUSEL_READY__");
    expect(result.document).toContain(".figure { font-family: var(--f-display)");
    expect(result.content!.htmlFragments["device"]).toContain("device-figure-value");
  });

  it("reports facts that are not refusals as warnings", async () => {
    const deps = makeDeps({ ltr: { ok: true, metrics: goodMetrics({ accentPresent: false, quantisedColourCount: 2, backgroundMatchesBrandGround: false }), probe: goodProbe() } });
    const result = await validate(statDraft(), deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      "the sample painted no accent pixels — the brand's accent moment is missing from this layout",
      "the sample paints only 2 distinct colour(s)",
      "the measured background #17181C is not the brand ground",
    ]);
  });
});

describe("gate 1 — a routable archetype id, one per client", () => {
  it("refuses an invented id, naming the eight and why a new one is a dead end", async () => {
    const result = await validate(statDraft({ archetypeId: "split_diagonal" }), makeDeps());
    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.gate === 1)!;
    expect(failure.id).toBe("gate-1-routable-archetype");
    expect(failure.reason).toContain('"split_diagonal" is not one of the eight routable ids');
    expect(failure.reason).toContain("templateForLayout");
  });

  it("refuses a duplicate for the same client, naming the id it would overwrite", async () => {
    const result = await validate(statDraft(), makeDeps(), { existingArchetypeIds: ["stat_callout"] });
    expect(result.failures.find((f) => f.gate === 1)!.reason).toContain('the id "studio_acme_stat_callout" would overwrite it');
  });

  it("short-circuits the browser: a template that fails a free gate is never rendered", async () => {
    const deps = makeDeps();
    await validate(statDraft({ archetypeId: "nope" }), deps);
    expect(deps.renderCalls).toEqual([]);
  });
});

describe("gate 2 — the slot contract", () => {
  it("refuses a read-but-undeclared placeholder", async () => {
    const result = await validate(statDraft({ slots: ["figure", "subLabel", "body", "device"] }), makeDeps());
    const failure = result.failures.find((f) => f.gate === 2 && f.reason.includes("sourceLine"))!;
    expect(failure.reason).toContain("{{sourceLine}}, which is not a declared slot");
    expect(failure.reason).toContain("renders as a hole");
  });

  it("refuses a declared-but-unread slot", async () => {
    const result = await validate(statDraft({ slots: ["figure", "subLabel", "body", "sourceLine", "device", "attribution"], sample: { figure: "63%", subLabel: "s", body: "b", sourceLine: "src", device: "d", attribution: "a" } }), makeDeps());
    expect(result.failures.find((f) => f.gate === 2)!.reason).toContain('slot "attribution" is declared but the markup never reads');
  });

  it("refuses a slot contentFor cannot supply for THAT archetype", async () => {
    // A quote card has no figure — nothing in the pipeline would ever fill it.
    const draft = statDraft({
      archetypeId: "quote_card",
      slots: ["figure", "subLabel", "body", "sourceLine", "device"],
    });
    const failure = (await validate(draft, makeDeps())).failures.find((f) => f.gate === 2)!;
    expect(failure.reason).toContain('slot "figure" is not one contentFor can supply for archetype "quote_card"');
    expect(failure.reason).toContain("nothing in the pipeline would ever fill it");
  });

  it("refuses a sample that does not demonstrate every declared slot", async () => {
    const result = await validate(statDraft({ sample: { figure: "63%", subLabel: "s", body: "b", sourceLine: "src", device: "  " } }), makeDeps());
    expect(result.failures.find((f) => f.gate === 2)!.reason).toContain('the sample does not fill declared slot "device"');
  });

  it("refuses a derivedFrom.why citing a number the evidence never had", async () => {
    const result = await validate(statDraft({ derivedFrom: { ...statDraft().derivedFrom, why: "stat covers get 3.2x more saves" } }), makeDeps(), {
      evidenceBlock: "- stat-led: 6 post(s) across 1 account(s); per-account normalised score 1.1",
    });
    expect(result.failures.find((f) => f.reason.includes("derivedFrom.why"))!.reason).toContain('claims "3.2x"');
  });
});

describe("gate 3 — safety, with the opt-in allowlist", () => {
  it("allows {{image:hero}} on a declared image ground", async () => {
    const result = await validate(coverDraft(), makeDeps());
    expect(result.failures).toEqual([]);
  });

  it("refuses {{image:hero}} when the declared ground is not an image", async () => {
    const result = await validate(coverDraft({ ground: "colour-block" }), makeDeps());
    const failure = result.failures.find((f) => f.gate === 3)!;
    expect(failure.reason).toContain('the declared ground is "colour-block"');
    expect(failure.reason).toContain("the slide has no ground when no picture is found");
  });

  it("refuses an image ground that never reads a hero — the grey screen, structurally", async () => {
    const draft = coverDraft({
      slots: ["eyebrow", "title", "device"],
      bodyHtml: `<div class="lockup"><p class="eyebrow">{{eyebrow}}</p><h1 class="title">{{title}}</h1>{{html:device}}</div>`,
      sample: { eyebrow: "playbook", title: "A cover title", device: "a device" },
    });
    const failure = (await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!;
    expect(failure.reason).toContain("never reads {{image:hero}}");
    expect(failure.reason).toContain("the grey screen this studio exists to prevent");
  });

  it("refuses an image slot nobody can fill", async () => {
    const draft = coverDraft({
      slots: ["eyebrow", "title", "hero", "device"],
      bodyHtml: `<div class="ground">{{image:banner}}{{image:hero}}</div><div class="lockup">{{eyebrow}}{{title}}{{html:device}}</div>`,
    });
    expect((await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!.reason).toContain("{{image:banner}} is not an allowed image slot");
  });

  it("refuses {{html:device}} when no device slot was declared", async () => {
    const draft = statDraft({
      slots: ["figure", "subLabel", "body", "sourceLine"],
      sample: { figure: "63%", subLabel: "s", body: "b", sourceLine: "src" },
    });
    const failure = (await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!;
    expect(failure.reason).toContain('{{html:device}} is read but "device" is not a declared slot');
    expect(failure.reason).toContain("needs an explicit declaration");
  });

  it("refuses a raw html slot nothing builds", async () => {
    const draft = statDraft({
      slots: ["figure", "subLabel", "body", "sourceLine", "device"],
      bodyHtml: STAT_BODY.replace("{{html:device}}", "{{html:device}}{{html:sidebar}}"),
    });
    expect((await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!.reason).toContain("{{html:sidebar}} is not an allowed html slot");
  });

  it("refuses a <script> in the fragment, through the package's own check", async () => {
    const draft = statDraft({ bodyHtml: STAT_BODY.replace("</div>", "<script>fetch('https://evil.test')</script></div>") });
    const failure = (await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!;
    expect(failure.reason).toContain("must not contain a <script>");
  });

  it("refuses css reaching for an external resource", async () => {
    const draft = statDraft({ css: `${STAT_CSS}\n.plate { background-image: url(https://evil.test/x.png); }` });
    expect((await validate(draft, makeDeps())).failures.find((f) => f.gate === 3)!.reason).toContain("must not contain 'javascript:', '@import', or 'url('");
  });
});

describe("gate 4 — code owns the document", () => {
  it("refuses a fragment that is actually a document", async () => {
    const draft = statDraft({ bodyHtml: `<!doctype html><html><body>${STAT_BODY}</body></html>` });
    const failure = (await validate(draft, makeDeps())).failures.find((f) => f.gate === 4)!;
    expect(failure.reason).toContain("the model authors a FRAGMENT");
    expect(failure.reason).toContain("__CAROUSEL_READY__ script the renderer waits for");
  });

  it("refuses a fragment reaching for the ready flag itself", async () => {
    const draft = statDraft({ css: `${STAT_CSS}\n/* __CAROUSEL_READY__ */` });
    expect((await validate(draft, makeDeps())).failures.find((f) => f.gate === 4)!.reason).toContain("the harness's to write");
  });
});

describe("gate 5 — a real render of code-built sample content", () => {
  it("reports a tooling failure as a refusal, never a throw", async () => {
    const deps = makeDeps({ ltr: { ok: false, reason: "chromium exited before __CAROUSEL_READY__ was set" } });
    const result = await validate(statDraft(), deps);
    expect(result.failures).toEqual([
      { gate: 5, id: "gate-5-real-render", reason: "the sample did not render: chromium exited before __CAROUSEL_READY__ was set" },
    ]);
    expect(result.ltr).toBeUndefined();
  });

  it("fills the render from CODE, so a template cannot pass by being handed flattering copy", async () => {
    const deps = makeDeps();
    // The draft's own `sample` says "63%" for the figure; the RENDER is filled
    // from the seed, which code derived from the client's brief.
    const result = await validate(statDraft({ sample: { figure: "1", subLabel: "x", body: "y", sourceLine: "z", device: "d" } }), deps);
    expect(result.content!.fields["body"]).toContain("Acme runs the weekly content pipeline");
    expect(result.content!.fields["figure"]).toBe("63%");
  });
});

describe("gate 6 — the interest floor at the declared role, with the calibration margin", () => {
  it("refuses a mostly-flat, mostly-idle plate and carries the numbers", async () => {
    const deps = makeDeps({ ltr: { ok: true, metrics: goodMetrics({ flatBackgroundShare: 0.93, occupiedShare: 0.18, largestEmptyRectShare: 0.61, imageryOrDeviceShare: 0.002 }), probe: goodProbe() } });
    const result = await validate(statDraft(), deps);
    const failure = result.failures.find((f) => f.gate === 6)!;
    expect(failure.reason).toContain("interest floor (dead-space)");
    expect(failure.measured).toMatchObject({ flatBackgroundShare: 0.93, occupiedShare: 0.18, largestEmptyRectShare: 0.61 });
    expect(formatStudioFailures(result)[0]).toContain("largestEmptyRectShare=0.61");
  });

  it("refuses a template that clears the floor BY MARGIN — 0.03 of room where 0.05 is required", async () => {
    // No finding at all: 0.25 is under the 0.28 interior ceiling. It is the
    // MARGIN that refuses it, because a stored template renders every future
    // post and a real headline two words longer would push it over.
    const deps = makeDeps({ ltr: { ok: true, metrics: goodMetrics({ largestEmptyRectShare: 0.25 }), probe: goodProbe() } });
    const result = await validate(statDraft(), deps);
    expect(result.ltr!.findings).toEqual([]);
    const failure = result.failures.find((f) => f.gate === 6)!;
    expect(failure.reason).toContain('only by 0.030 on the "dead-space" clause');
    expect(failure.reason).toContain("under the 0.05 calibration margin");
    expect(result.ltr!.margin).toBe(0.03);
  });

  it("judges a cover AS A COVER: the same metrics pass as an interior and fail the cover's device clause", async () => {
    const bare = goodMetrics({ imageryShare: 0, graphicShare: 0.01, imageryOrDeviceShare: 0.01 });
    const asInterior = await validate(statDraft(), makeDeps({ ltr: { ok: true, metrics: bare, probe: goodProbe() } }));
    expect(asInterior.ok).toBe(true);

    const asCover = await validate(coverDraft(), makeDeps({ ltr: { ok: true, metrics: bare, probe: goodProbe() } }));
    const failure = asCover.failures.find((f) => f.gate === 6)!;
    expect(failure.reason).toContain('interest floor (no-device) at role "cover"');
    expect(failure.reason).toContain("1.0%");
  });

  it("refuses a render whose ink says the page is broken rather than boring", async () => {
    const deps = makeDeps({ ltr: { ok: true, metrics: goodMetrics({ inkShare: 0.004 }), probe: goodProbe() } });
    expect((await validate(statDraft(), deps)).failures.find((f) => f.gate === 6)!.reason).toContain("render looks broken, not boring");
  });
});

describe("gate 7 — contrast and palette, free and therefore first", () => {
  it("refuses a sub-floor text pair with the ratio in the reason", async () => {
    const deps = makeDeps();
    const result = await validateStudioTemplate(
      { draft: statDraft(), clientSlug: "acme", kit: { cssVars: { "--bg": "#17181C", "--fg": "#1B1C20", "--accent": "#C8FF4D" }, palette: ["#C8FF4D"] }, seed: { ...SEED, accentHex: "#C8FF4D" } },
      deps,
    );
    const failure = result.failures.find((f) => f.gate === 7)!;
    expect(failure.reason).toContain("text (--fg on --bg) measures 1.0");
    expect(failure.reason).toContain("unreadable for every future post");
    expect(failure.measured).toMatchObject({ floor: 4.5 });
    // Free, so it runs before the browser opens.
    expect(deps.renderCalls).toEqual([]);
  });

  it("refuses an accent the brand kit's ring does not contain", async () => {
    const result = await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: { ...SEED, accentHex: "#FF00FF" } }, makeDeps());
    expect(result.failures.find((f) => f.gate === 7)!.reason).toContain("not members of the brand kit's");
  });
});

describe("gate 8 — RTL and the script fonts, when the client's language needs one", () => {
  const hebrew = { targetLanguage: "Hebrew", rtlSeed: HEBREW_SEED };

  it("does not arm for a Latin-script client", async () => {
    const deps = makeDeps();
    await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, targetLanguage: "English" }, deps);
    expect(deps.renderCalls).toEqual([{ dir: "ltr" }]);
  });

  it("renders a second time in RTL and passes when the script font actually loaded", async () => {
    const deps = makeDeps();
    const result = await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps);
    expect(deps.renderCalls).toEqual([{ dir: "ltr" }, { dir: "rtl" }]);
    expect(result.ok).toBe(true);
    expect(result.rtl!.probe.fontFamiliesUsed).toContain("Heebo");
  });

  it("refuses a Hebrew render that painted no glyphs — tofu, or a font that never loaded", async () => {
    const deps = makeDeps({ rtl: { ok: true, metrics: goodMetrics({ textShare: 0 }), probe: goodProbe({ fontFamiliesUsed: ["Heebo"] }) } });
    const failure = (await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps)).failures.find((f) => f.gate === 8)!;
    expect(failure.reason).toContain("Hebrew render painted no text pixels");
    expect(failure.measured).toEqual({ textShare: 0 });
  });

  it("refuses a Hebrew render that overflows its box, naming the elements", async () => {
    const deps = makeDeps({ rtl: { ok: true, metrics: goodMetrics(), probe: goodProbe({ overflow: true, overflowing: [".title", ".lede"], fontFamiliesUsed: ["Heebo"] }) } });
    const failure = (await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps)).failures.find((f) => f.gate === 8)!;
    expect(failure.reason).toContain(".title, .lede");
    expect(failure.reason).toContain("in-page text length breakpoint");
  });

  it("refuses a Hebrew render painted by a fallback face rather than the script stack", async () => {
    const deps = makeDeps({ rtl: { ok: true, metrics: goodMetrics(), probe: goodProbe({ fontFamiliesUsed: ["Fraunces", "Inter"] }) } });
    const failure = (await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps)).failures.find((f) => f.gate === 8)!;
    expect(failure.reason).toContain("none of the script stack (Heebo, Rubik, Assistant, Heebo) actually loaded");
  });

  it("refuses a Hebrew render that fails the floor even though the Latin one passed", async () => {
    const deps = makeDeps({ rtl: { ok: true, metrics: goodMetrics({ largestEmptyRectShare: 0.44 }), probe: goodProbe({ fontFamiliesUsed: ["Heebo"] }) } });
    const result = await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps);
    expect(result.ltr!.findings).toEqual([]);
    expect(result.failures.find((f) => f.gate === 8)!.reason).toContain("Hebrew interest floor (dead-space)");
  });

  it("reports an RTL render tooling failure as a refusal too", async () => {
    const deps = makeDeps({ rtl: { ok: false, reason: "font stylesheet 504" } });
    expect((await validateStudioTemplate({ draft: statDraft(), clientSlug: "acme", kit: KIT, seed: SEED, ...hebrew }, deps)).failures.find((f) => f.gate === 8)!.reason).toContain(
      "Hebrew sample did not render: font stylesheet 504",
    );
  });
});
