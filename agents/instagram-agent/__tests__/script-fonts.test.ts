import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { buildBrandHeadHtml, deriveBrandRenderTokens } from "../src/workflow/brand-render-tokens.js";
import {
  SCRIPT_TYPOGRAPHY,
  buildScriptFontHeadForLanguage,
  buildScriptFontHeadHtml,
  clientFamiliesFromCssVars,
  scriptTypographyFor,
} from "../src/workflow/script-fonts.js";
import type { BrandTokens } from "../src/workflow/types.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * Phase 0, item A — fonts by script. The audit's finding 5: a Hebrew client's
 * slides rendered in Chromium's system fallback because every template and
 * the brand kit only ever loaded Latin faces. These tests pin the fragment the
 * renderer now adds from the TARGET LANGUAGE alone (kit-independent), how it
 * orders client vs script families, how it composes with the templates' own
 * `--ts` reviewer scale, and that a Latin client's head is byte-identical to
 * before.
 */

const TEMPLATES = path.resolve(__dirname, "..", "assets", "templates", "default");
const baseTokens: BrandTokens = { templateDir: "t", slideTemplate: "slide.html" };

const HEBREW = SCRIPT_TYPOGRAPHY["Hebrew"]!;

describe("scriptTypographyFor: which languages get a script fragment", () => {
  it("resolves Hebrew under every spelling client.getBrand().language legitimately produces", () => {
    for (const language of ["Hebrew", "hebrew", "he", "he-IL", "iw", "עברית"]) {
      const typography = scriptTypographyFor(language);
      expect(typography?.script, language).toBe("Hebrew");
      expect(typography?.spec, language).toBe(HEBREW);
    }
  });

  it("is a no-op for Latin-script languages, unknown languages and no language at all", () => {
    expect(scriptTypographyFor("en")).toBeUndefined();
    expect(scriptTypographyFor("English")).toBeUndefined();
    expect(scriptTypographyFor("pt-BR")).toBeUndefined();
    expect(scriptTypographyFor(undefined)).toBeUndefined();
    expect(scriptTypographyFor("Klingon")).toBeUndefined();
    expect(scriptTypographyFor("")).toBeUndefined();
  });

  it("covers every non-Latin script the language gate can name, so a checkable language is always a settable one", () => {
    for (const language of ["ar", "el", "ru", "hi", "th", "hy", "ka", "ja", "ko", "zh"]) {
      expect(scriptTypographyFor(language), language).toBeDefined();
    }
    for (const spec of Object.values(SCRIPT_TYPOGRAPHY)) {
      expect(spec.display.length).toBeGreaterThan(0);
      expect(spec.body.length).toBeGreaterThan(0);
      expect(spec.mono.length).toBeGreaterThan(0);
      expect(spec.typeScale).toBeGreaterThan(0.8);
      expect(spec.typeScale).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildScriptFontHeadHtml: the Hebrew fragment", () => {
  it("client family first, script family second, template fallback last — when the client declared a face for that role", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, { display: "Fraunces" });
    expect(head).toContain("--f-display: 'Fraunces', 'Heebo', 'Rubik', Georgia, 'Times New Roman', serif;");
  });

  it("script family FIRST when the client declared nothing for that role", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, { display: "Fraunces" });
    expect(head).toContain("--f-body: 'Assistant', 'Heebo', system-ui, -apple-system, sans-serif;");
    expect(head).toContain("--f-mono: 'Rubik', ui-monospace, monospace;");
  });

  it("loads every script family through ONE css2 link, bare-named, display=swap", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, {});
    const links = head.match(/<link /g) ?? [];
    expect(links).toHaveLength(1);
    expect(head).toContain("family=Heebo");
    expect(head).toContain("family=Assistant");
    expect(head).toContain("family=Rubik");
    expect(head).toContain("display=swap");
    expect(head).not.toContain("wght@");
    // Each family exactly once in the URL, even though Heebo carries two roles.
    expect(head.match(/family=Heebo/g)).toHaveLength(1);
  });

  it("encodes multi-word families for the URL and quotes them for CSS", () => {
    const arabic = SCRIPT_TYPOGRAPHY["Arabic"]!;
    const head = buildScriptFontHeadHtml("Arabic", arabic, {});
    expect(head).toContain("family=Noto+Sans+Arabic");
    expect(head).toContain("--f-display: 'Noto Sans Arabic', 'Cairo', Georgia");
  });

  it("composes the per-script type scale with the templates' own reviewer fontScale selectors", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, {});
    expect(head).toContain("body { --ts: 0.94 }");
    expect(head).toContain("body.ts-s { --ts: calc(0.85 * 0.94) }");
    expect(head).toContain("body.ts-l { --ts: calc(1.18 * 0.94) }");
  });

  it("a typeScale of exactly 1 emits no scale rule at all — the Latin scale already fits", () => {
    const greek = SCRIPT_TYPOGRAPHY["Greek"]!;
    expect(greek.typeScale).toBe(1);
    const head = buildScriptFontHeadHtml("Greek", greek, {});
    expect(head).not.toContain("--ts");
    expect(head).toContain("family=Noto+Serif");
  });

  it("sets display and body line heights on the real template classes, never on the stat figure's lockup", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, {});
    expect(head).toMatch(/\.headline, \.hf-headline, \.quote-text, \.cmp-head[^{]*\{ line-height: 1\.12;/);
    expect(head).toMatch(/\.body-text, \.body, \.num-body[^{]*\.kicker, \.eyebrow \{ line-height: 1\.6; \}/);
    expect(head).not.toContain(".num-figure");
  });

  /**
   * THE DESCENDER ALLOWANCE TRAVELS WITH THE LEADING IT ANSWERS TO.
   *
   * A display face's glyph box is taller than a sub-1.15 line box, so a block
   * set at the Hebrew display leading reports `scrollHeight > clientHeight`,
   * which the renderer's DOM probe calls an overflowing element and clause B
   * of the interest floor fails the slide on — a false `clipped` finding
   * whose steer tells the writer to shorten a headline that fits.
   *
   * The templates each carry their own `padding-block-end` for the LATIN
   * case, sized against their own 1.2-1.3 leading, and that was the whole bug:
   * this sheet overrides all of them to 1.12 and the per-template allowance
   * then either covers the new half-leading deficit or does not. Measured in
   * Chromium with Heebo at 62px/1.12 the requirement is ~0.177em, and four of
   * the eight bundled templates shipped between 0.10em and 0.14em. So the
   * allowance is emitted HERE, by the rule that sets the leading, and this
   * test is what stops the two being separated again.
   */
  it("emits a descender allowance alongside the display leading, on the same selectors", () => {
    for (const [script, spec] of Object.entries(SCRIPT_TYPOGRAPHY)) {
      const head = buildScriptFontHeadHtml(script, spec, {});
      const rule = /\.headline, [^{]*\{ line-height: [\d.]+; padding-block-end: ([\d.]+)em; \}/.exec(head);
      expect(rule, `${script} sets a display leading with no descender allowance beside it`).not.toBeNull();
      expect(Number(rule![1]), `${script}'s descender allowance is under the ~0.177em Heebo needs at this leading`).toBeGreaterThanOrEqual(0.18);
    }
  });

  /**
   * PHASE 4, RFC-15 §7.1 — TRACKING, CASE (a).
   *
   * The bundled templates track their display type the way a Latin display
   * face wants it (`-0.008em` to `-0.04em`) and their uppercase mono eyebrows
   * the way a Latin label wants it (`+0.14em` to `+0.24em`). Both are wrong
   * for Hebrew and in opposite directions: negative tracking walks the final
   * forms (ך ן ף ץ) into the next word, and positive tracking shreds a Hebrew
   * word, which has no tradition of letter spacing at all.
   *
   * Break the emission (delete the `if (spec.letterSpacing !== undefined)`
   * block) and the Hebrew case below fails; add a `letterSpacing` row to a
   * script nobody has measured and the second case fails.
   */
  it("emits tracking on both role lists for a script whose row carries it", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, {});
    expect(HEBREW.letterSpacing).toEqual({ display: "normal", body: "normal" });
    expect(head).toMatch(/\.headline, \.hf-headline, \.quote-text, \.cmp-head[^{]*\{ letter-spacing: normal; \}/);
    expect(head).toMatch(/\.body-text, \.body, \.num-body[^{]*\.kicker, \.eyebrow \{ letter-spacing: normal; \}/);
    // The stat digit's lockup and the Latin `@handle` watermark are in
    // neither list, so neither is re-tracked.
    expect(head).not.toContain(".num-figure");
    expect(head).not.toContain(".brand-handle");
  });

  it("emits NOTHING for a script whose row has no measured tracking — absent means 'not measured', never 'normal'", () => {
    for (const [script, spec] of Object.entries(SCRIPT_TYPOGRAPHY)) {
      const head = buildScriptFontHeadHtml(script, spec, {});
      if (spec.letterSpacing === undefined) {
        expect(head, `${script} emits a tracking rule it never measured`).not.toContain("letter-spacing");
      } else {
        expect(head, `${script} carries a measured tracking row and emits no rule for it`).toContain("letter-spacing");
      }
    }
    // …and at least one row on each side of that branch, so the loop above is
    // never vacuously true.
    expect(SCRIPT_TYPOGRAPHY["Hebrew"]!.letterSpacing).toBeDefined();
    expect(SCRIPT_TYPOGRAPHY["Arabic"]!.letterSpacing).toBeUndefined();
  });

  it("drops a client family that fails the shared family-name rule rather than quoting it into the sheet", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, { display: "Fraunces'); @import url(evil" });
    expect(head).not.toContain("evil");
    expect(head).toContain("--f-display: 'Heebo', 'Rubik', Georgia");
  });

  it("dedupes a client face that is itself a script family", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, { display: "Heebo" });
    expect(head).toContain("--f-display: 'Heebo', 'Rubik', Georgia");
  });

  it("font-stack vars live on body, so the kit's own :root sheet cannot undo them whichever fragment lands first", () => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, { display: "Fraunces" });
    expect(head).toMatch(/body \{\n {2}--f-display:/);
    expect(head).not.toMatch(/:root \{[^}]*--f-display/);
  });
});

describe("clientFamiliesFromCssVars: reading the client's declared faces back out of the kit", () => {
  it("takes the leading quoted family of each --f-* stack and ignores the generic fallbacks", () => {
    const tokens = deriveBrandRenderTokens({ fonts: { heading: "Space Grotesk", body: "Open Sans" } }, baseTokens)!;
    expect(clientFamiliesFromCssVars(tokens.cssVars)).toEqual({ display: "Space Grotesk", body: "Open Sans" });
  });

  it("yields {} for no kit at all — the brandless client's shape, not an error", () => {
    expect(clientFamiliesFromCssVars(undefined)).toEqual({});
    expect(clientFamiliesFromCssVars({ "--bg": "#17181C" })).toEqual({});
  });
});

describe("composition with the bundled templates and the brand kit", () => {
  const geektimeBrand = {
    accent: "#A5E82B",
    colors: { primaryAccent: "#A5E82B", neutralDark: "#272A35", neutralLight: "#F4F2EC" },
    dominantColors: [{ hex: "#272A35", dominanceRank: 1, role: "ground" }],
    fonts: { heading: "Space Grotesk" },
    visualStyle: "Dark Mode",
  };

  it("a Hebrew headline_focus slide: the script fragment lands after the template's own </style> and carries Heebo, with the brand face kept in front", async () => {
    const raw = await fs.readFile(path.join(TEMPLATES, "headline-focus.html"), "utf8");
    const kit = deriveBrandRenderTokens(geektimeBrand, baseTokens)!;
    const scriptHead = buildScriptFontHeadForLanguage("he", kit.cssVars)!;
    const brandHead = buildBrandHeadHtml(kit);
    const composed = composeRawDocument(raw, [scriptHead, brandHead].join("\n"));

    const templateStyleEnd = composed.indexOf("</style>");
    const scriptAt = composed.indexOf("/* script typography: Hebrew */");
    expect(templateStyleEnd).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(templateStyleEnd);
    expect(composed).toContain("family=Heebo");
    // The client's own heading face stays in front for Latin loanwords; Heebo carries the Hebrew glyphs.
    expect(composed).toContain("--f-display: 'Space Grotesk', 'Heebo', 'Rubik', Georgia");
    // The template's own `body.ts-s { --ts: 0.85; }` is still there and is now overridden by the later, composed rule.
    expect(composed.indexOf("body.ts-s { --ts: 0.85; }")).toBeLessThan(composed.indexOf("body.ts-s { --ts: calc(0.85 * 0.94) }"));
    // Exactly one composed document — the head still closes once.
    expect(composed.match(/<\/head>/g)).toHaveLength(1);
  });

  it("a brandless Hebrew client (no kit at all) still gets the script fragment, script-first", () => {
    const head = buildScriptFontHeadForLanguage("he-IL", undefined)!;
    expect(head).toContain("--f-display: 'Heebo', 'Rubik', Georgia");
    expect(head).toContain("--f-body: 'Assistant', 'Heebo', system-ui");
  });

  it("regression pin: a Latin target with a kit produces exactly today's buildBrandHeadHtml output — nothing added", () => {
    const kit = deriveBrandRenderTokens(geektimeBrand, baseTokens)!;
    expect(buildScriptFontHeadForLanguage("en", kit.cssVars)).toBeUndefined();
    expect(buildScriptFontHeadForLanguage(undefined, kit.cssVars)).toBeUndefined();
    const brandHead = buildBrandHeadHtml(kit);
    const head = [buildScriptFontHeadForLanguage("en", kit.cssVars), brandHead].filter((s): s is string => s !== undefined).join("\n");
    expect(head).toBe(brandHead);
  });
});

/**
 * PHASE 4, RFC-15 §7.2 — ALIGNMENT IS PINNED, NOT CHANGED. CASE (c).
 *
 * `textAlign` already defaults to `"start"`, and every bundled template
 * declares only `body.ta-center` / `body.ta-end` — leaving `start` to CSS's
 * logical initial value, which under `dir="rtl"` is already the right edge.
 * So Phase 4 adds NO new control. What it adds is the guard that keeps that
 * true: a physical `left`/`right` on a display or body role would silently
 * pin a Hebrew slide's text to the wrong edge, and nothing measures it —
 * every pixel metric reports `ok` on a perfectly legible slide flush against
 * the wrong margin.
 *
 * The role selectors are read back OUT of the emitted sheet rather than
 * re-listed here, so this guard can never drift from the list it is meant to
 * cover.
 *
 * BREAK-THE-CODE CHECK (run 2026-09-12): add `text-align: left;` to
 * `slide.html`'s `.headline` rule and this fails, naming the file and the
 * selector.
 */
describe("alignment stays logical: no physical left/right on a display or body role", () => {
  /** `.headline`, `.hf-headline`, … — exactly the selectors the script sheet re-tracks and re-leads. */
  const roleSelectors = (): string[] => {
    const head = buildScriptFontHeadHtml("Hebrew", HEBREW, {});
    const rules = [...head.matchAll(/^([^{\n]+)\{ line-height:/gm)].map((m) => m[1]!);
    expect(rules).toHaveLength(2);
    return rules.flatMap((r) => r.split(",").map((s) => s.trim())).filter((s) => s.startsWith("."));
  };

  /**
   * A physical box/alignment keyword. `inset-inline-start`, `border-inline-start`,
   * `text-align: start|center|end` and `margin-block-*` are all logical and all fine —
   * this matches only the four-corner physical forms.
   */
  const PHYSICAL = /text-align\s*:\s*(?:left|right)\b|\b(?:margin|padding|border|inset)-(?:left|right)\b|(?:^|[;{])\s*(?:left|right)\s*:/;

  it("no bundled template carries one", async () => {
    const selectors = roleSelectors();
    expect(selectors.length).toBeGreaterThanOrEqual(10);
    const files = (await fs.readdir(TEMPLATES)).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(8);

    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATES, file), "utf8");
      const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
      for (const [, selector, declarations] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const touchesRole = selectors.some((s) => new RegExp(`\\${s}(?![\\w-])`).test(selector!));
        if (!touchesRole) continue;
        expect(declarations!, `${file}: "${selector!.trim()}" pins a display/body role to a physical edge, which lands on the wrong side in RTL`).not.toMatch(PHYSICAL);
      }
    }
  });

  it("and neither does the emitted script sheet", () => {
    for (const [script, spec] of Object.entries(SCRIPT_TYPOGRAPHY)) {
      expect(buildScriptFontHeadHtml(script, spec, {}), script).not.toMatch(PHYSICAL);
    }
  });
});

// A real Chromium, same guard the sibling render tests use. Google Fonts may
// be unreachable in a sandbox — `display=swap` means the render still
// completes, which is exactly what this asserts: a script fragment never
// turns a render into a failure.
describe.skipIf(!isChromiumInstalled())("a Hebrew slide renders through publish.renderCarousel with the script fragment spliced in", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true });
  });

  it("renders a Hebrew headline_focus slide to a PNG", async () => {
    scratch = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-script-font-render-"));
    const templateDir = path.join(scratch, "templates");
    await fs.mkdir(templateDir, { recursive: true });
    const raw = await fs.readFile(path.join(TEMPLATES, "headline-focus.html"), "utf8");
    const head = buildScriptFontHeadForLanguage("he", undefined)!;
    await fs.writeFile(path.join(templateDir, "headline-focus.html"), composeRawDocument(raw, head), "utf8");

    const outcome = await createRenderCarousel().execute(
      {
        client: "script-font-test",
        postId: "hebrew-1",
        templateDir: path.relative(REPO_ROOT, templateDir),
        outDir: path.relative(REPO_ROOT, path.join(scratch, "out")),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 1,
            template: "headline-focus.html",
            fields: {
              kicker: "גיקטיים",
              headline: "השבוע שבו הבינה המלאכותית נכנסה לחדר הישיבות",
              body: "שלושה ממצאים מסקר המנהלים החדש, ומה הם אומרים על השנה הקרובה.",
              accentColor: "#A5E82B",
              dir: "rtl",
              fontScale: "m",
              textAlign: "start",
            },
            images: {},
            htmlFragments: {},
          },
        ],
        // scale MUST be 2 — validateRenderInputs rejects anything else
        // ("the QA PNG floor depends on it"), same canvas every sibling
        // render test and every real caller uses.
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx: { runId: "r", clientSlug: "script-font-test", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    // The reason is folded into the asserted value on purpose: this test only
    // runs where Chromium is installed (CI, and a dev box that ran `npx
    // playwright install chromium`), so a bare `toBe("success")` reports
    // "expected 'tooling_error' to be 'success'" in the one place nobody can
    // reproduce it, and says nothing about which render step failed.
    expect(outcome.status === "success" ? "success" : `${outcome.status}: ${"reason" in outcome ? outcome.reason : "(no reason)"}`).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const png = await fs.readFile(outcome.result.rendered[0]!.path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 60000);
});
