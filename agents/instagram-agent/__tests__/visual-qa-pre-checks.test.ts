import { describe, expect, it } from "vitest";
import type { BrandLogoPlacement } from "@agent-engine/tool-karos-media";
import { ACCENT_GROUND_CONTRAST_FLOOR, TEXT_CONTRAST_FLOOR, contrastRatio } from "../src/workflow/brand-render-tokens.js";
import {
  BRAND_ASSET_INTEGRATION_CRITERION,
  COLOUR_HARMONY_CRITERION,
  COMPOSITION_RICHNESS_CRITERION,
  FONT_HIERARCHY_CRITERION,
  assessBrandAssetPresence,
  assessContrastFacts,
  buildElevatedVisualQaCriteria,
  checkPaletteWithinKit,
} from "../src/workflow/visual-qa-pre-checks.js";

/**
 * SCRUM-324 (AU40) — the deterministic pre-checks in isolation, pure and
 * model-free. The workflow-level short-circuit proof (counting
 * `router.complete` calls) lives in `visual-qa-elevated-criteria.test.ts`;
 * this file is the fast unit coverage for the functions that proof depends
 * on.
 */

function placement(overrides: Partial<BrandLogoPlacement> = {}): BrandLogoPlacement {
  return {
    decision: "place",
    corner: "top-start",
    insetBlockPx: 44,
    insetInlinePx: 44,
    widthPx: 150,
    reason: "mark clears 3:1 on #17181C at 5.00:1",
    ...overrides,
  };
}

describe("checkPaletteWithinKit — an includes() check, never a model judgment", () => {
  it("passes when every used hex is a member of the kit ring", () => {
    expect(checkPaletteWithinKit(["#ABCDEF", "#abcdef"], ["#ABCDEF", "#112233"]).ok).toBe(true);
  });

  it("passes without an opinion when the kit ring is empty — nothing to check against", () => {
    expect(checkPaletteWithinKit(["#DEADBE"], []).ok).toBe(true);
  });

  it("fails, naming the offending hex(es), when a used color is not in the ring", () => {
    const result = checkPaletteWithinKit(["#123456"], ["#ABCDEF"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("#123456");
    expect(result.reason).toContain("#ABCDEF");
    expect(result.reason).toMatch(/includes\(\)/);
  });

  it("is case-insensitive and de-duplicates before reporting", () => {
    const result = checkPaletteWithinKit(["#ff0000", "#FF0000", "#ff0000"], ["#00ff00"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Reported once, not three times.
    expect(result.reason.match(/#ff0000/gi)?.length).toBe(1);
  });
});

describe("assessBrandAssetPresence — a fact, never a gate", () => {
  it("reports not-configured when the client has no logoUrl at all", () => {
    const fact = assessBrandAssetPresence({ configuredLogoUrl: undefined, hasDownload: false, placement: undefined });
    expect(fact.present).toBe(false);
    if (fact.present) throw new Error("unreachable");
    expect(fact.reason).toMatch(/no brand logoUrl configured/);
  });

  // SCRUM-383: `rejectedLogoUrlReason` — computed upstream by
  // `deriveBrandRenderTokens`, never re-derived here — names the gs:// dead
  // end explicitly, rather than this function reporting a bare "logo
  // absent" indistinguishable from "no logo configured at all." Checked
  // ahead of `configuredLogoUrl`/`hasDownload`, matching that a rejected
  // URL never reaches a download attempt in the first place.
  it("names the gs:// dead end explicitly via rejectedLogoUrlReason, rather than a bare 'logo absent'", () => {
    const fact = assessBrandAssetPresence({
      configuredLogoUrl: undefined,
      rejectedLogoUrlReason:
        'brand logoUrl "gs://karos-brand-assets/acme/logo.svg" is a gs:// URL, not https:// — downloadBrandLogo ' +
        "(@agent-engine/tool-karos-media) fetches only https:// URLs, so this logo is rejected here at derivation " +
        "(SCRUM-383) rather than being passed through to fail silently downstream",
      hasDownload: false,
      placement: undefined,
    });
    expect(fact.present).toBe(false);
    if (fact.present) throw new Error("unreachable");
    expect(fact.reason).toContain("gs://karos-brand-assets/acme/logo.svg");
    expect(fact.reason).toMatch(/https:\/\//);
    expect(fact.reason).toMatch(/rejected here at derivation/);
  });

  it("rejectedLogoUrlReason wins even if a stale configuredLogoUrl were also passed", () => {
    const fact = assessBrandAssetPresence({
      configuredLogoUrl: "gs://karos-brand-assets/acme/logo.svg",
      rejectedLogoUrlReason: "brand logoUrl rejected for test purposes",
      hasDownload: false,
      placement: undefined,
    });
    expect(fact.present).toBe(false);
    if (fact.present) throw new Error("unreachable");
    expect(fact.reason).toBe("brand logoUrl rejected for test purposes");
  });

  it("reports a generic download failure for an https:// URL that just didn't come through", () => {
    const fact = assessBrandAssetPresence({
      configuredLogoUrl: "https://logos.example/broken.png",
      hasDownload: false,
      placement: undefined,
    });
    expect(fact.present).toBe(false);
    if (fact.present) throw new Error("unreachable");
    expect(fact.reason).toContain("https://logos.example/broken.png");
    expect(fact.reason).not.toMatch(/gs:\/\//);
  });

  it("folds AU38's contrast-floor 'omit' decision into the same non-gating fact, carrying the plan's own reason", () => {
    const omitPlan = placement({ decision: "omit", reason: "mark reaches only 1.18:1 on #17181C and no scrim color clears the floor either" });
    const fact = assessBrandAssetPresence({ configuredLogoUrl: "https://logos.example/logo.png", hasDownload: true, placement: omitPlan });
    expect(fact.present).toBe(false);
    if (fact.present) throw new Error("unreachable");
    expect(fact.reason).toBe(omitPlan.reason);
  });

  it("reports present:true with the plan's corner/scrim facts when the mark clears the floor bare", () => {
    const plan = placement({ decision: "place", groundContrast: 5.2 });
    const fact = assessBrandAssetPresence({ configuredLogoUrl: "https://logos.example/logo.png", hasDownload: true, placement: plan });
    expect(fact.present).toBe(true);
    if (!fact.present) throw new Error("unreachable");
    expect(fact.corner).toBe("top-start");
    expect(fact.scrimmed).toBe(false);
    expect(fact.groundContrast).toBe(5.2);
  });

  it("reports present:true, scrimmed:true when the mark needed AU38's plate", () => {
    const plan = placement({
      decision: "scrim",
      groundContrast: 1.18,
      scrim: { color: "#FFFFFF", contrast: 4.1, padPx: 12, radiusPx: 8 },
    });
    const fact = assessBrandAssetPresence({ configuredLogoUrl: "https://logos.example/logo.png", hasDownload: true, placement: plan });
    expect(fact.present).toBe(true);
    if (!fact.present) throw new Error("unreachable");
    expect(fact.scrimmed).toBe(true);
  });
});

describe("buildElevatedVisualQaCriteria — the model is only ever asked what code cannot answer", () => {
  it("always includes composition-richness and font-hierarchy", () => {
    const criteria = buildElevatedVisualQaCriteria({ logo: { present: false, reason: "no brand logoUrl configured" }, kitPalette: [] });
    expect(criteria).toEqual([COMPOSITION_RICHNESS_CRITERION, FONT_HIERARCHY_CRITERION]);
  });

  it("adds brand-asset-integration only when the logo fact is present", () => {
    const criteria = buildElevatedVisualQaCriteria({
      logo: { present: true, corner: "top-start", scrimmed: false },
      kitPalette: [],
    });
    expect(criteria.map((c) => c.id)).toContain(BRAND_ASSET_INTEGRATION_CRITERION.id);
    expect(criteria.map((c) => c.id)).not.toContain(COLOUR_HARMONY_CRITERION.id);
  });

  it("adds colour-harmony only when the kit has a real palette ring", () => {
    const criteria = buildElevatedVisualQaCriteria({
      logo: { present: false, reason: "no brand logoUrl configured" },
      kitPalette: ["#ABCDEF"],
    });
    expect(criteria.map((c) => c.id)).toContain(COLOUR_HARMONY_CRITERION.id);
    expect(criteria.map((c) => c.id)).not.toContain(BRAND_ASSET_INTEGRATION_CRITERION.id);
  });

  it("includes all four when both a present logo and a real palette ring exist", () => {
    const criteria = buildElevatedVisualQaCriteria({
      logo: { present: true, corner: "top-end", scrimmed: true },
      kitPalette: ["#ABCDEF", "#112233"],
    });
    expect(criteria.map((c) => c.id).sort()).toEqual(
      [COMPOSITION_RICHNESS_CRITERION.id, FONT_HIERARCHY_CRITERION.id, BRAND_ASSET_INTEGRATION_CRITERION.id, COLOUR_HARMONY_CRITERION.id].sort(),
    );
  });
});

describe("assessContrastFacts — SCRUM-393 (IGSTYLE-8): a fact, never a gate", () => {
  // sitti's real, live brand kit (Appendix D of the IGSTYLE spec):
  // #fff8d6 ground, #8a3b42 text (7.1:1, clears), #ff5b5f accent (2.8:1,
  // below ACCENT_GROUND_CONTRAST_FLOOR).
  const sittiKit = { cssVars: { "--bg": "#fff8d6", "--fg": "#8a3b42" } };

  it("returns [] when the kit has no ground/fg pair at all — nothing derivable, nothing to report", () => {
    expect(assessContrastFacts(undefined, ["#ff5b5f"])).toEqual([]);
    expect(assessContrastFacts({ cssVars: {} }, ["#ff5b5f"])).toEqual([]);
  });

  it("reports the text (--fg on --bg) fact against TEXT_CONTRAST_FLOOR", () => {
    const facts = assessContrastFacts(sittiKit, []);
    const text = facts.find((f) => f.label === "text (--fg on --bg)");
    expect(text).toBeDefined();
    expect(text!.ratio).toBeCloseTo(contrastRatio("#8a3b42", "#fff8d6"), 5);
    expect(text!.floor).toBe(TEXT_CONTRAST_FLOOR);
    expect(text!.pass).toBe(true);
  });

  it("reports a real sub-floor accent as a FAILING fact — never throws, never gates", () => {
    const facts = assessContrastFacts(sittiKit, ["#ff5b5f"]);
    const accent = facts.find((f) => f.label === "accent #ff5b5f on ground");
    expect(accent).toBeDefined();
    expect(accent!.ratio).toBeCloseTo(contrastRatio("#ff5b5f", "#fff8d6"), 5);
    expect(accent!.ratio).toBeLessThan(ACCENT_GROUND_CONTRAST_FLOOR);
    expect(accent!.floor).toBe(ACCENT_GROUND_CONTRAST_FLOOR);
    expect(accent!.pass).toBe(false);
  });

  it("reports a passing accent as a passing fact too — good numbers are reported, not just bad ones", () => {
    // geektime's real kit: #272a35 ground, #a5e82b accent, 4.8:1 — clears.
    const facts = assessContrastFacts({ cssVars: { "--bg": "#272a35", "--fg": "#f4f2ec" } }, ["#a5e82b"]);
    const accent = facts.find((f) => f.label === "accent #a5e82b on ground");
    expect(accent?.pass).toBe(true);
  });

  it("dedupes repeated accent hexes (case-insensitively) into one fact", () => {
    const facts = assessContrastFacts(sittiKit, ["#FF5B5F", "#ff5b5f", "#ff5b5f"]);
    expect(facts.filter((f) => f.label.startsWith("accent"))).toHaveLength(1);
  });

  it("still reports accent facts when there is a ground but no derivable text pair", () => {
    const facts = assessContrastFacts({ cssVars: { "--bg": "#fff8d6" } }, ["#ff5b5f"]);
    expect(facts.find((f) => f.label === "text (--fg on --bg)")).toBeUndefined();
    expect(facts.find((f) => f.label === "accent #ff5b5f on ground")).toBeDefined();
  });

  it("reports one fact per distinct accent when a kit's ring is used across several slides", () => {
    const facts = assessContrastFacts(sittiKit, ["#ff5b5f", "#111111"]);
    const accentFacts = facts.filter((f) => f.label.startsWith("accent"));
    expect(accentFacts.map((f) => f.label).sort()).toEqual(["accent #111111 on ground", "accent #ff5b5f on ground"]);
  });
});
