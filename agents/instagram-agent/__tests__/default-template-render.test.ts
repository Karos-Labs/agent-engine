import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * A real, un-mocked Chromium render of the actual production default
 * template (agent-engine#4) — every other render-carousel test deliberately
 * stays Chromium-free (`validateRenderInputs`'s own doc comment), so this is
 * the one place "does the shipped template actually render" gets checked
 * against real Playwright, not just schema validation. Requires
 * `npx playwright install chromium` locally; CI's own image already has it
 * (`apps/agent-server/Dockerfile`'s runtime stage).
 */
/**
 * Chromium-free pin for the Brand Kit's Commit A1: the production templates
 * are fully token-driven — no color is hardcoded off `--bg`/`--fg` as an
 * `rgba()` literal, because a literal is exactly what stops a light-ground
 * brand (a cream Pitch-style client) from re-theming a scrim or a text
 * opacity when the brand token sheet overrides the vars.
 */
describe("default templates are token-driven, not literal-colored", () => {
  const TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");

  it("ships the whole routable archetype set, so a client's templateDir can hold all of it", async () => {
    // Phase 2, item M added `cover` and `closer`. `LAYOUT_TEMPLATE_FILES`
    // routes to these filenames byte-identically, so a missing file here is a
    // routing dead end that only shows up as a render tooling error.
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    expect(files.sort()).toEqual([
      "closer.html",
      "comparison-card.html",
      "cover.html",
      "headline-focus.html",
      "list-takeaway.html",
      "quote-card.html",
      "slide.html",
      "stat-callout.html",
    ]);
  });

  it("no template carries a hardcoded bg/fg-derived rgba literal", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      // Only the STYLE half matters — a doc comment describing the legacy
      // system may legitimately quote an old literal.
      const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
      expect(styles, `${file} styles a color off a literal instead of var(--bg)/var(--fg)`).not.toMatch(/rgba\(\s*23\s*,\s*24\s*,\s*28|rgba\(\s*244\s*,\s*242\s*,\s*236/);
    }
  });

  it("no template carries a bare font-size literal — every size scales off var(--ts) for the reviewer's typography controls", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
      expect(styles, `${file} sizes type off a bare px literal instead of calc(...* var(--ts, 1))`).not.toMatch(/font-size:\s*\d+px/);
    }
  });

  /**
   * The `@handle` watermark is an LTR string whose leading character is a
   * BIDI NEUTRAL, so dropped raw into a Hebrew or Arabic document it takes the
   * paragraph's own RTL embedding level and lays out as `karoslabs@` — with
   * the `@` on the wrong side, on every slide of every non-Latin run. A URL
   * and a `#hashtag` break identically, so the SLOT is isolated rather than
   * the one string.
   *
   * Asserted on the source rather than on a render because no pixel metric
   * can see it (every Hebrew calibration case reported `ok` while the plates
   * carried it) and because the renderer's DOM probe does not report computed
   * `direction`. What the source can say, and what matters, is that the slot
   * is isolated in every file that has one — including the scaffold
   * `karos-templates`' `buildTemplateShell` writes for a custom archetype.
   *
   * `dir` on the `<bdi>` and never on the `<div>`: the div's own
   * `inset-inline-start` would re-resolve with it and move the watermark to
   * the opposite corner of an RTL plate.
   */
  it("every template bidi-ISOLATES the brand handle slot, so an @handle does not reorder in an RTL document", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      expect(html, `${file} drops {{brandHandle}} into an RTL paragraph with no bidi isolation`).toContain(
        '<div class="brand-handle"><bdi dir="ltr">{{brandHandle}}</bdi></div>',
      );
      // ...and an isolated slot is never `:empty`, so the rule that hides a
      // handle-less client's watermark has to look inside it.
      const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
      expect(styles, `${file} hides an empty handle with :empty alone, which a <bdi> child defeats`).toMatch(/\.brand-handle:has\(\s*>\s*bdi:empty\s*\)/);
    }
  });

  /**
   * THE SERIES BADGE MUST NOT BE PAINTED IN A TOKEN ITS OWN GROUND SWALLOWS.
   *
   * `--accent-ink` (#141414) exists to be the text ON an accent chip —
   * `BADGE_VARIANT_CSS`'s `pill` is where it belongs. Seven of the eight
   * bundled templates therefore colour a bare `.brand-badge` in `var(--accent)`
   * and stand it on the plate's own dark ground. `cover.html` cannot: its
   * badge sits at y=56, which on a cover with no photograph is the head of
   * the field's accent ramp, where an accent-coloured badge is invisible. So
   * it is the one file that reaches for `--accent-ink` — and for exactly one
   * revision it did so UNCONDITIONALLY, on the only template whose field
   * paint is switched off when a photograph loads. Over a dark plate that
   * badge measured 1.10:1 (`.local/cover-contrast.mjs`).
   *
   * No pixel metric in this repo measures contrast and every probe case
   * rendered an empty badge, so this is asserted on the source: a template
   * may use `--accent-ink` for the badge only if it ALSO switches the value
   * on the same guards that switch its field paint off.
   */
  it("no template paints its series badge in an ink token without a branch for the ground that ink needs", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      // CSS COMMENTS STRIPPED FIRST. These sheets carry long rationale
      // comments that quote selectors verbatim — `cover.html`'s badge note
      // quotes `.brand-badge { ... }` while explaining what the brand head
      // splices in — and a scan that reads those reads prose as CSS.
      const styles = [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
      // The `.brand-badge { ... }` declaration block, not the `:empty` rule.
      const block = /\.brand-badge\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
      expect(block, `${file} has no .brand-badge rule, so a brandless render lays the badge out in normal flow`).toMatch(/color\s*:/);
      if (/--accent-ink/.test(block)) {
        expect.fail(`${file} colours .brand-badge straight off --accent-ink; that token is text ON an accent chip and this badge has no chip`);
      }
      if (/var\(\s*--badge-ink/.test(block)) {
        // The indirection is only honest if BOTH branches are declared, and
        // the guards must be the field's own — a badge whose ink outlives the
        // ground it was chosen for is the defect this test exists for.
        expect(styles, `${file} reads --badge-ink but never declares its default`).toMatch(/body\s*\{[^}]*--badge-ink\s*:/);
        expect(styles, `${file} never switches --badge-ink off the accent ramp`).toMatch(/body:has\(\.hero\)[^{]*\{[^}]*--badge-ink\s*:/);
      } else {
        expect(block, `${file} should colour a bare badge in var(--accent) like its seven siblings`).toMatch(/color\s*:\s*var\(\s*--accent\s*\)/);
      }
    }
  });

  /**
   * THE RULE THE WHOLE DIRECTORY KEEPS, pinned where it cannot rot: **a
   * ground layer may paint TONE anywhere; it may paint INK only inside a
   * region the composition occupies.**
   *
   * Every template used to carry a full-bleed `<div class="ground-art">`
   * inset 16px painting a pinstripe over the entire plate. A texture that
   * marks a cell in every position on the frame makes `occupiedShare` and
   * `largestEmptyRectShare` CONSTANTS — measured through the real
   * `measureSlidePng`, each of these files reported the same 1.5% largest
   * empty rectangle with the full copy on it and with every slot empty — so
   * the one clause `slide-metrics.ts`'s own header calls "the metric that
   * names the complaint" could not fire on any plate this directory produced.
   *
   * The pixel half of this is asserted in `interest-floor-calibration.test.ts`
   * (the empty-plate and hollow-middle cases). This is the cheap structural
   * half, and it is the one that runs without Chromium: no `.ground-art`
   * element may come back.
   */
  it("no template paints a full-bleed ink layer — ground art is bound to the composition, not to the frame", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    for (const file of files) {
      const html = await fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
      const body = html.slice(html.indexOf("<body"));
      expect(body, `${file} re-introduced a full-bleed ground-art layer; bind the texture to the block whose content justifies it`).not.toMatch(
        /class="[^"]*\bground-art\b/,
      );
      expect(body, `${file} re-introduced a full-bleed accent-rules layer; bind it to the block whose content justifies it`).not.toMatch(
        /class="[^"]*\bground-rules\b/,
      );
    }
  });
});

// AU57: this launches a real Chromium. Its sibling in workflow-e2e.test.ts
// already guards with the same check; without it this file HARD-FAILS on any
// machine without the browser installed rather than skipping, which reads as
// a broken build instead of an absent optional dependency.
describe.skipIf(!isChromiumInstalled())("instagram-agent's default template renders via publish.renderCarousel", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  // `validateRenderInputs`'s `assertInside` requires outDir/image paths to be
  // repo-relative (never an absolute/escaping path) — os.tmpdir() is outside
  // the repo, so the scratch dir has to live INSIDE REPO_ROOT instead, same
  // constraint every real caller (assembleSlidesData's own outDir) is under.
  let outDir: string;

  afterEach(async () => {
    if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  });

  it("produces a real, non-empty PNG for a slide with no hero image", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-render-test-"));
    const tool = createRenderCarousel();
    const outcome = await tool.execute(
      {
        client: "smoke-test",
        postId: "no-image-post",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 1,
            template: "slide.html",
            fields: { headline: "Most marketing calendars fail in month two", body: "Here's the pattern we keep seeing.", accentColor: "#C4552F" },
            images: {},
            htmlFragments: {},
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx: { runId: "r", clientSlug: "smoke-test", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );

    if (outcome.status !== "success") console.error("render outcome:", JSON.stringify(outcome, null, 2));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    expect(outcome.result.rendered).toHaveLength(1);
    const pngPath = outcome.result.rendered[0]!.path;
    const stat = await fs.stat(pngPath);
    expect(stat.size).toBeGreaterThan(1000); // a real screenshot, not an empty/broken file
    const bytes = await fs.readFile(pngPath);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // the PNG magic bytes
  }, 30_000);

  /**
   * THE HERO IMAGE IS ACTUALLY IN THE PIXELS.
   *
   * The test below this one has always passed while every carousel rendered
   * flat. It asserts the PNG is large and well-formed, which a text-only slide
   * also is — so it could not see that Chromium was refusing to load the
   * `file://` hero from an `about:blank` document (`page.setContent`), and that
   * the template's `onerror` was hiding the result exactly as designed for a
   * genuinely missing photo. Render succeeded, QA passed, and a live prep run
   * shipped eight flat slides with vetted images sitting unused on disk.
   *
   * Rendering the SAME slide with and without the hero and requiring the bytes
   * to DIFFER catches it without decoding a PNG: if the image is blocked, both
   * renders draw identical text on an identical background and come out
   * byte-identical. A pixel decoder would be more direct and much heavier for
   * the one bit of information that matters.
   */
  it("renders differently with a hero image than without one", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-render-test-"));
    // Solid magenta, 8x8. `object-fit: cover` blows it up to the full canvas,
    // so a loaded hero changes almost every pixel above the scrim.
    const magenta = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGP8z/CfARtgwio6aCUAkYsCDoRKzmMAAAAASUVORK5CYII=",
      "base64",
    );
    const imageAbsPath = path.join(outDir, "hero.png");
    await fs.writeFile(imageAbsPath, magenta);

    const tool = createRenderCarousel();
    const ctx = { ctx: { runId: "r", clientSlug: "smoke-test", productId: "instagram-agent", runKind: "setup" as const, metadata: {} } };
    const base = {
      client: "smoke-test",
      templateDir: "agents/instagram-agent/assets/templates/default",
      outDir: path.relative(REPO_ROOT, outDir),
      repoRoot: REPO_ROOT,
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      readyFlag: "__CAROUSEL_READY__",
      fields: { headline: "Identical copy on both", body: "Only the hero differs.", accentColor: "#2F6FC4" },
    };

    async function render(postId: string, images: Record<string, string>): Promise<Buffer> {
      const outcome = await tool.execute(
        {
          ...base,
          postId,
          slides: [{ n: 1, template: "slide.html", fields: base.fields, images, htmlFragments: {} }],
        },
        ctx,
      );
      if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
      return fs.readFile(outcome.result.rendered[0]!.path);
    }

    const withHero = await render("with-hero", { hero: path.relative(REPO_ROOT, imageAbsPath) });
    const withoutHero = await render("without-hero", {});

    expect(withHero.equals(withoutHero)).toBe(false);
    // And the hero render is the bigger one: a full-bleed photograph compresses
    // to more bytes than a flat background. Not a strict law of PNG, but with a
    // solid colour against solid colour it is a real signal, and it fails in the
    // right direction if the two ever drift apart for some other reason.
    expect(withHero.byteLength).toBeGreaterThan(withoutHero.byteLength);
  }, 60_000);

  it("produces a real, non-empty PNG for a slide WITH a hero image", async () => {
    outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-render-test-"));
    // A minimal real 1x1 PNG, decodable by Chromium — not a fabricated/broken file.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const imageAbsPath = path.join(outDir, "hero.png");
    await fs.writeFile(imageAbsPath, pngBytes);

    const tool = createRenderCarousel();
    const outcome = await tool.execute(
      {
        client: "smoke-test",
        postId: "with-image-post",
        templateDir: "agents/instagram-agent/assets/templates/default",
        outDir: path.relative(REPO_ROOT, outDir),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 1,
            template: "slide.html",
            fields: { headline: "A real photo slide", body: "This one has a hero image.", accentColor: "#2F6FC4" },
            images: { hero: path.relative(REPO_ROOT, imageAbsPath) },
            htmlFragments: {},
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx: { runId: "r", clientSlug: "smoke-test", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );

    if (outcome.status !== "success") console.error("render outcome:", JSON.stringify(outcome, null, 2));
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome));
    const stat = await fs.stat(outcome.result.rendered[0]!.path);
    expect(stat.size).toBeGreaterThan(1000);
  }, 30_000);
});
