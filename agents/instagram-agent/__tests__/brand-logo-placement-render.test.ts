import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { composeRawDocument } from "@agent-engine/tool-karos-templates";
import { BRAND_LOGO_CONTRAST_FLOOR, brandLogoDataUri, contrastRatio, parseBrandLogoDataUri } from "@agent-engine/tool-karos-media";
import {
  DEFAULT_TEMPLATE_GROUND,
  buildBrandHeadHtml,
  buildBrandLogoBodyHtml,
  deriveBrandRenderTokens,
  planBrandLogo,
} from "../src/workflow/brand-render-tokens.js";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * AU38 (SCRUM-322) — the client's logo, on a real rendered slide, with the
 * contrast enforcement measured rather than asserted.
 *
 * Two halves, both necessary:
 *
 * 1. The Chromium-free half proves the CSS the render path emits is derived
 *    from a REAL contrast computation against the slide's `--bg` token — the
 *    planted low-contrast pairing (a black mark on the templates' own
 *    `#17181C` ground, 1.18:1) is caught, and the emitted rules change
 *    because of it.
 * 2. The real-Chromium half proves the mark reaches the PIXELS, and that the
 *    enforcement reaches them too: the same mark rendered with and without
 *    its enforced scrim must produce DIFFERENT bytes. If the guard were a
 *    no-op the two renders would be byte-identical, which is exactly the
 *    failure mode a "contrast: passes" boolean would hide.
 */

/**
 * Two 16x16 solid RGBA PNGs, generated with `zlib.deflateSync` over real
 * filtered scanlines (see `karos-media/__tests__/brand-logo-contrast.test.ts`
 * for the encoder). Solid, so the decoded ink is unambiguous: exactly
 * `#000000` and exactly `#FFFFFF`.
 */
const BLACK_MARK_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR4nGNgYGD4TyEeNWDUgFEDhocBAJvM/wGi6G+mAAAAAElFTkSuQmCC";
const WHITE_MARK_PNG = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==";

function markDataUri(base64: string): string {
  return brandLogoDataUri({ bytes: new Uint8Array(Buffer.from(base64, "base64")), mime: "image/png" });
}

/**
 * The kit a client with no derivable ground gets: accent and handle only, so
 * `cssVars` carries no `--bg` override and the slide renders on the default
 * templates' own `#17181C`. That is the ground the mark has to survive, and
 * it is the ground the plan is required to check against.
 */
function darkGroundKit() {
  const tokens = deriveBrandRenderTokens({ accent: "#C4552F", handle: "@acme" }, {} as never);
  expect(tokens, "the fixture kit must derive something").toBeDefined();
  expect(tokens!.cssVars["--bg"], "this kit must NOT derive a ground, so the template default applies").toBeUndefined();
  return tokens!;
}

function planFor(base64: string) {
  const download = parseBrandLogoDataUri(markDataUri(base64));
  expect(download).toBeDefined();
  return planBrandLogo(darkGroundKit(), download!);
}

describe("the logo's placement and contrast are computed, not prompted", () => {
  it("measures a real WCAG ratio against the ground token the slide actually renders on", () => {
    const plan = planFor(WHITE_MARK_PNG);
    expect(plan.decision).toBe("place");
    // The number is the real one for #FFFFFF on #17181C — recomputed here
    // from the published formula rather than read back off the plan.
    expect(plan.groundContrast).toBeCloseTo(contrastRatio("#FFFFFF", DEFAULT_TEMPLATE_GROUND), 12);
    expect(plan.groundContrast).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);

    const css = buildBrandHeadHtml(darkGroundKit(), { logo: plan });
    expect(css).toContain(".brand-logo {");
    expect(css).toContain("inset-inline-start: 44px");
    expect(css).not.toContain("box-sizing: content-box"); // no plate: it did not need one
  });

  it("CATCHES the planted low-contrast case — a black mark on #17181C is never emitted as a bare mark", () => {
    // The plant, stated as a real number before the plan is even asked.
    const measured = contrastRatio("#000000", DEFAULT_TEMPLATE_GROUND);
    expect(measured).toBeCloseTo(1.18, 2);
    expect(measured).toBeLessThan(BRAND_LOGO_CONTRAST_FLOOR);

    const plan = planFor(BLACK_MARK_PNG);
    expect(plan.decision).not.toBe("place");
    expect(plan.groundContrast).toBeCloseTo(measured, 12);
    expect(plan.scrim?.contrast).toBeGreaterThanOrEqual(BRAND_LOGO_CONTRAST_FLOOR);

    const css = buildBrandHeadHtml(darkGroundKit(), { logo: plan });
    // The enforcement is IN the stylesheet, and it is the plan's own color.
    expect(css).toContain(`background: ${plan.scrim!.color}`);
    expect(css).toContain("box-sizing: content-box");
    expect(css).toContain(`padding: ${plan.scrim!.padPx}px`);
  });

  it("places the mark by rule, out of the series badge's corner", () => {
    const download = parseBrandLogoDataUri(markDataUri(WHITE_MARK_PNG))!;
    const withBadge = planBrandLogo(darkGroundKit(), download, { hasSeriesBadge: true });
    expect(withBadge.corner).toBe("top-end");
    expect(buildBrandHeadHtml(darkGroundKit(), { logo: withBadge })).toContain("inset-inline-end: 44px");
    // The old fixed `.brand-badge { inset-inline-start: 220px }` shove is gone:
    // the two pieces of furniture no longer share a corner to fight over.
    expect(buildBrandHeadHtml(darkGroundKit(), { logo: withBadge })).not.toContain("220px");
  });
});

// A real Chromium, same guard the sibling render tests use.
describe.skipIf(!isChromiumInstalled())("the logo, and its enforcement, reach the rendered pixels", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  const TEMPLATE = path.resolve(__dirname, "..", "assets", "templates", "default", "slide.html");
  let scratch: string;

  afterEach(async () => {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  });

  /** Renders the real default template, branded exactly the way the workflow brands it, and returns the PNG bytes. */
  async function render(postId: string, head: string, body: string | undefined): Promise<Buffer> {
    const templateDir = path.join(scratch, postId);
    await fs.mkdir(templateDir, { recursive: true });
    const raw = await fs.readFile(TEMPLATE, "utf8");
    await fs.writeFile(path.join(templateDir, "slide.html"), composeRawDocument(raw, head, body), "utf8");

    const outcome = await createRenderCarousel().execute(
      {
        client: "logo-test",
        postId,
        templateDir: path.relative(REPO_ROOT, templateDir),
        outDir: path.relative(REPO_ROOT, path.join(scratch, "out", postId)),
        repoRoot: REPO_ROOT,
        slides: [
          {
            n: 1,
            template: "slide.html",
            fields: { headline: "Identical copy on every render", body: "Only the brand furniture differs.", accentColor: "#C4552F" },
            images: {},
            htmlFragments: {},
          },
        ],
        canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
        readyFlag: "__CAROUSEL_READY__",
      },
      { ctx: { runId: "r", clientSlug: "logo-test", productId: "instagram-agent", runKind: "setup", metadata: {} } },
    );
    if (outcome.status !== "success") throw new Error(`render failed: ${JSON.stringify(outcome)}`);
    return fs.readFile(outcome.result.rendered[0]!.path);
  }

  it("puts the client's logo in the pixels, and the enforced scrim changes them again", async () => {
    scratch = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-logo-render-"));
    const kit = darkGroundKit();
    const uri = markDataUri(BLACK_MARK_PNG);
    const plan = planFor(BLACK_MARK_PNG);
    expect(plan.decision).toBe("scrim"); // the planted case, again, at the render boundary

    const noLogo = await render("no-logo", buildBrandHeadHtml(kit, {}), undefined);
    const enforced = await render("enforced", buildBrandHeadHtml(kit, { logo: plan }), buildBrandLogoBodyHtml(uri));
    // The same plan with its scrim stripped — what the render WOULD have been
    // if the contrast check had waved the mark through.
    const { scrim: _dropped, ...withoutScrim } = plan;
    const unenforced = await render("unenforced", buildBrandHeadHtml(kit, { logo: { ...withoutScrim, decision: "place" } }), buildBrandLogoBodyHtml(uri));

    for (const [name, bytes] of [["no-logo", noLogo], ["enforced", enforced], ["unenforced", unenforced]] as const) {
      expect(bytes.subarray(0, 8).toString("hex"), name).toBe("89504e470d0a1a0a"); // real PNGs
      expect(bytes.byteLength, name).toBeGreaterThan(1000);
    }

    // The mark is genuinely composited: a slide with it differs from one without.
    expect(enforced.equals(noLogo)).toBe(false);
    // ...and the enforcement is genuinely load-bearing: waving the mark
    // through would have produced different pixels from what actually ships.
    // A no-op guard makes these two renders byte-identical.
    expect(enforced.equals(unenforced)).toBe(false);
  }, 90_000);
});
