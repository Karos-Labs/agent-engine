import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COLLISION_MIN_PX,
  COLLISION_WATCH_CLASSES,
  createRenderCarousel,
  probeGeometry,
  probePage,
  RenderCarouselInputSchema,
  RESERVED_ZONE_SELECTOR,
  SlideGeometrySchema,
  SUBJECT_BOX_GROUPS,
  type RenderCarouselInput,
  type RenderCarouselResult,
} from "../src/render-carousel.js";
import { SlideProbeSchema } from "../src/slide-metrics.js";

/**
 * RFC-22 item F4 — the probe learns to see a COLLISION.
 *
 * `probePage` has walked every element with `getBoundingClientRect()` since
 * 1.1.0 and has always been able to say that a box left its parent. It has
 * never once been able to say that two boxes are in the same pixels. That is
 * how geektime's brand disc shipped printed on top of its own series badge
 * for eight consecutive slides — clipping `{ FIELD NOTES }` to `{ FIELD` —
 * while `08a2` reported the mark as `present: true, corner: "top-start",
 * groundContrast: 7.04` and the human gate approved the post.
 *
 * Two halves, deliberately: the logic is exercised against a fake DOM so it
 * is tested on every machine, and the ONE case that actually broke (RTL, a
 * real logical-property layout) is rendered in a real Chromium, because
 * `inset-inline-start` under `dir="rtl"` is precisely the thing a hand-built
 * rect table would get wrong in the same direction as the bug.
 */

function isChromiumInstalled(): boolean {
  const cacheDir =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright"));
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith("chromium-")) continue;
      const exePath =
        process.platform === "win32"
          ? path.join(cacheDir, entry, "chrome-win", "chrome.exe")
          : process.platform === "darwin"
            ? path.join(cacheDir, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
            : path.join(cacheDir, entry, "chrome-linux", "chrome");
      if (existsSync(exePath)) return true;
    }
  } catch {
    // The cache directory does not exist: Chromium was never installed.
  }
  // `KAROS_BROWSER_CHANNEL` points the renderer at an installed Chrome
  // instead (memory: `chromium-not-installed-for-render-tests`). That browser
  // is HARSHER than CI's pinned build, so a local failure here is not
  // automatically a regression — pixel truth is CI.
  return (process.env["KAROS_BROWSER_CHANNEL"] ?? "") !== "";
}

// ─────────────────────────────────────────────────────────────────────────
// The logic, without a browser
// ─────────────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  childCount?: number;
  box?: { left: number; top: number; width: number; height: number };
  fontSize?: string;
  visibility?: string;
  ariaHidden?: string;
  /** Index into the same array. Absent = no parent. */
  parent?: number;
}

function withFakeDom<T>(elements: FakeElement[], body: () => T): T {
  const global = globalThis as unknown as Record<string, unknown>;
  const priorDocument = global["document"];
  const priorComputed = global["getComputedStyle"];
  const built = elements.map((e) => {
    const box = e.box ?? { left: 0, top: 0, width: 0, height: 0 };
    return {
      tagName: e.tagName,
      id: e.id ?? "",
      className: e.className ?? "",
      textContent: e.text ?? "",
      children: { length: e.childCount ?? 0 },
      scrollWidth: box.width,
      scrollHeight: box.height,
      clientWidth: box.width,
      clientHeight: box.height,
      getAttribute: (name: string) => (name === "aria-hidden" ? (e.ariaHidden ?? null) : null),
      getBoundingClientRect: () => ({
        left: box.left,
        top: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        width: box.width,
        height: box.height,
      }),
      parentElement: null as unknown,
      __fontSize: e.fontSize ?? "32px",
      __visibility: e.visibility ?? "visible",
    };
  });
  elements.forEach((e, i) => {
    if (e.parent !== undefined) built[i]!.parentElement = built[e.parent] ?? null;
  });
  global["document"] = { querySelectorAll: () => built };
  global["getComputedStyle"] = (element: { __fontSize: string; __visibility: string }) => ({
    fontSize: element.__fontSize,
    visibility: element.__visibility,
  });
  try {
    return body();
  } finally {
    global["document"] = priorDocument;
    global["getComputedStyle"] = priorComputed;
  }
}

// 1.6.0's second half (Phase 5.5, W2-C's clause I and the reporting-only type
// clauses) reads the canvas and the three subject groups too, so every call
// below carries them. The fake DOM in this file declares no `.hero`/`.dv`/`svg`
// boxes, so `subjectBoxes` comes back all-zero for the collision cases — which
// is the correct answer for a plate made of furniture, and is asserted as such
// in "reports what the plate is carrying" below.
const ARG = {
  n: 3,
  watch: [...COLLISION_WATCH_CLASSES],
  minOverlapPx: COLLISION_MIN_PX,
  w: 1080,
  h: 1440,
  subjects: { hero: [...SUBJECT_BOX_GROUPS.hero], device: [...SUBJECT_BOX_GROUPS.device], graphic: [...SUBJECT_BOX_GROUPS.graphic] },
};

describe("probeGeometry — collisions (driven against a fake DOM)", () => {
  it("reports two overlapping watch-list boxes with the intrusion DEPTH, and validates against its own schema", () => {
    const geometry = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 2, box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 0 },
        // The geektime geometry, in numbers: a 132px disc landing on the end
        // of a badge that starts 64px in at y=56.
        { tagName: "DIV", className: "brand-badge", text: "{ FIELD NOTES }", box: { left: 64, top: 56, width: 320, height: 26 }, parent: 1 },
        { tagName: "IMG", className: "brand-logo", box: { left: 264, top: 28, width: 132, height: 132 }, parent: 1 },
      ],
      () => probeGeometry(ARG),
    );

    expect(SlideGeometrySchema.parse(geometry)).toEqual(geometry);
    expect(geometry.n).toBe(3);
    expect(geometry.collisions).toHaveLength(1);
    // x overlap 64+320=384 vs 264 -> 120px; y overlap 56..82 vs 28..160 -> 26px.
    // The DEPTH is the smaller: 26. An area-based number would have said 3,120.
    expect(geometry.collisions[0]).toEqual({ a: "div.brand-badge", b: "img.brand-logo", overlapPx: 26 });
  });

  it("does not fire on a 3px overlap — below the measured 4px optical-hang band", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "kicker", text: "KICKER", box: { left: 64, top: 100, width: 200, height: 30 } },
        { tagName: "DIV", className: "headline", text: "A headline", box: { left: 64, top: 127, width: 800, height: 200 } },
      ],
      () => probeGeometry(ARG),
    );
    // 130 - 127 = 3px of vertical overlap: a display face's glyph box sitting
    // into its neighbour's margin, which every template in the tree does.
    expect(geometry.collisions).toEqual([]);
  });

  it("fires at 5px, so the threshold is a threshold and not an off switch", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "kicker", text: "KICKER", box: { left: 64, top: 100, width: 200, height: 30 } },
        { tagName: "DIV", className: "headline", text: "A headline", box: { left: 64, top: 125, width: 800, height: 200 } },
      ],
      () => probeGeometry(ARG),
    );
    // `a` is whichever box comes first in document order — the pair is
    // unordered, and pinning it to document order keeps the list stable
    // between two renders of the same plate.
    expect(geometry.collisions).toEqual([{ a: "div.kicker", b: "div.headline", overlapPx: 5 }]);
  });

  it("excludes aria-hidden boxes, zero-area boxes and visibility:hidden boxes — all three have rects and no pixels", () => {
    const geometry = withFakeDom(
      [
        { tagName: "IMG", className: "brand-logo", box: { left: 100, top: 100, width: 132, height: 132 } },
        { tagName: "DIV", className: "eyebrow", text: "hidden by aria", box: { left: 100, top: 100, width: 200, height: 40 }, ariaHidden: "true" },
        { tagName: "DIV", className: "kicker", text: "", box: { left: 100, top: 100, width: 0, height: 0 } },
        { tagName: "DIV", className: "figure", text: "42", box: { left: 100, top: 100, width: 200, height: 200 }, visibility: "hidden" },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.collisions).toEqual([]);
  });

  it("excludes a containment pair — a watched child inside a watched parent shares pixels by definition", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "figure", box: { left: 64, top: 300, width: 500, height: 400 } },
        { tagName: "SPAN", className: "headline", text: "72%", box: { left: 80, top: 320, width: 400, height: 300 }, parent: 0 },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.collisions).toEqual([]);
  });

  it("ignores elements outside the watch list — a collision list over the whole DOM is a list nobody reads", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "ground", box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "DIV", className: "scrim", box: { left: 0, top: 0, width: 1080, height: 1440 } },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.collisions).toEqual([]);
  });

  it("reports a reserved-zone intrusion even when the brand mark itself never rendered — thepitchbydeel has no logoUrl at all", () => {
    const geometry = withFakeDom(
      [{ tagName: "DIV", className: "brand-badge", text: "{ FIELD NOTES }", box: { left: 64, top: 56, width: 320, height: 26 } }],
      () =>
        probeGeometry({
          ...ARG,
          reserved: { x: 28, y: 28, w: 132, h: 132 },
          reservedOwners: ["brand-logo", "brand-mark"],
        }),
    );
    expect(geometry.collisions).toEqual([{ a: "div.brand-badge", b: RESERVED_ZONE_SELECTOR, overlapPx: 26 }]);
    // `probeGeometry` closes over nothing, so it emits the selector as a
    // LITERAL. This is the assertion that keeps the literal and the exported
    // constant consumers match on from drifting apart.
    expect(RESERVED_ZONE_SELECTOR).toBe("[reserved-zone]");
  });

  it("does not report the zone's OWNER as intruding into its own zone", () => {
    const geometry = withFakeDom([{ tagName: "IMG", className: "brand-logo", box: { left: 28, top: 28, width: 132, height: 132 } }], () =>
      probeGeometry({ ...ARG, reserved: { x: 28, y: 28, w: 132, h: 132 }, reservedOwners: ["brand-logo", "brand-mark"] }),
    );
    expect(geometry.collisions).toEqual([]);
  });

  it("caps the list at six, deepest first, so the cap drops the least interesting pairs", () => {
    const many: FakeElement[] = [];
    for (let i = 0; i < 8; i++) {
      // Every box overlaps every other; depth grows with i so the ordering is checkable.
      many.push({ tagName: "DIV", id: `e${i}`, className: "figure", text: "x", box: { left: 0, top: 0, width: 100 + i * 10, height: 100 + i * 10 } });
    }
    const geometry = withFakeDom(many, () => probeGeometry(ARG));
    expect(geometry.collisions).toHaveLength(6);
    const depths = geometry.collisions.map((c) => c.overlapPx);
    expect([...depths].sort((a, b) => b - a)).toEqual(depths);
  });
});

describe("probeGeometry — the distinct type-step set", () => {
  it("returns every distinct rendered size, largest first, against a hand-counted fixture", () => {
    // Hand count: 124, 46, 46, 22, 22, 32 -> four distinct steps.
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "headline", text: "A statement", box: { left: 64, top: 200, width: 900, height: 300 }, fontSize: "124px" },
        { tagName: "DIV", className: "body", text: "First line", box: { left: 64, top: 520, width: 900, height: 60 }, fontSize: "46px" },
        { tagName: "DIV", className: "body", text: "Second line", box: { left: 64, top: 600, width: 900, height: 60 }, fontSize: "46px" },
        { tagName: "DIV", className: "kicker", text: "KICKER", box: { left: 64, top: 120, width: 300, height: 26 }, fontSize: "22px" },
        { tagName: "DIV", className: "brand-handle", text: "@karoslabs", box: { left: 64, top: 1360, width: 300, height: 26 }, fontSize: "22px" },
        { tagName: "DIV", className: "eyebrow", text: "EYEBROW", box: { left: 64, top: 160, width: 300, height: 34 }, fontSize: "32px" },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.fontSizeSteps).toEqual([124, 46, 32, 22]);
  });

  it("rounds sub-pixel resolutions of ONE designed step together — `calc(19px * var(--ts))` resolves to 31.9998 and 32", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "a", text: "x", box: { left: 0, top: 0, width: 100, height: 40 }, fontSize: "31.9998px" },
        { tagName: "DIV", className: "b", text: "y", box: { left: 0, top: 100, width: 100, height: 40 }, fontSize: "32px" },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.fontSizeSteps).toEqual([32]);
  });

  it("skips a text leaf with no rendered box, so a hidden heading cannot claim the plate uses a display step", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "headline", text: "Never laid out", box: { left: 0, top: 0, width: 0, height: 0 }, fontSize: "180px" },
        { tagName: "DIV", className: "body", text: "Real copy", box: { left: 64, top: 200, width: 900, height: 60 }, fontSize: "46px" },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.fontSizeSteps).toEqual([46]);
  });

  it("agrees with probePage's displayTypeScale on the same plate — the two reads must describe the same glyph", () => {
    const elements: FakeElement[] = [
      { tagName: "DIV", className: "headline", text: "A statement", box: { left: 64, top: 200, width: 900, height: 300 }, fontSize: "124px" },
      { tagName: "DIV", className: "body", text: "Body copy", box: { left: 64, top: 520, width: 900, height: 60 }, fontSize: "46px" },
    ];
    const geometry = withFakeDom(elements, () => probeGeometry(ARG));
    const probe = withFakeDom(elements, () => probePage({ n: 3, w: 1080, h: 1440 }));
    expect(geometry.fontSizeSteps[0]).toBe(Math.round(probe.displayTypeScale * 1440));
  });

  // ── 1.6.0's second half: what the plate is CARRYING, and how many places
  //    the eye has to start reading from. Both land for Phase 5.5's clause I
  //    (the cover's subject) and its two reporting-only type clauses.

  it("reports what the plate is CARRYING by area, and does NOT count a gradient ground as a subject", () => {
    const geometry = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 3, box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 0 },
        // The boring cover, in numbers: a full-bleed gradient and a title.
        // The ground covers the WHOLE frame and must read as zero subject —
        // that is the entire reason grounds are absent from SUBJECT_BOX_GROUPS.
        { tagName: "DIV", className: "ground", box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 1 },
        { tagName: "DIV", className: "cov-field", box: { left: 0, top: 900, width: 1080, height: 540 }, parent: 1 },
        { tagName: "DIV", className: "headline", text: "A title in the lower third", box: { left: 64, top: 1000, width: 900, height: 200 }, parent: 1 },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.subjectBoxes).toEqual({ hero: 0, device: 0, graphic: 0 });

    // The same plate with a photograph on it: `.hero` at half the frame.
    const withHero = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 2, box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 0 },
        { tagName: "DIV", className: "ground", box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 1 },
        { tagName: "IMG", className: "hero", box: { left: 0, top: 0, width: 1080, height: 720 }, parent: 1 },
      ],
      () => probeGeometry(ARG),
    );
    expect(withHero.subjectBoxes.hero).toBeCloseTo(0.5, 6);
  });

  it("counts a `.dv` fragment inside `.cov-device` ONCE — one object, not two", () => {
    const geometry = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 0 },
        { tagName: "DIV", className: "cov-device", box: { left: 0, top: 0, width: 540, height: 720 }, parent: 1 },
        { tagName: "DIV", className: "dv", box: { left: 40, top: 40, width: 400, height: 400 }, parent: 2 },
      ],
      () => probeGeometry(ARG),
    );
    // 540*720 / (1080*1440) = 0.25. Counting the nested `.dv` too would have
    // said 0.3528, which is how a device gets to claim a quarter of a plate twice.
    expect(geometry.subjectBoxes.device).toBeCloseTo(0.25, 6);
  });

  it("counts alignment columns off the INLINE START edge, so a ranged-left plate reads as one column", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "kicker", text: "KICKER", box: { left: 64, top: 100, width: 200, height: 30 } },
        { tagName: "DIV", className: "headline", text: "A headline", box: { left: 64, top: 200, width: 900, height: 200 } },
        // 65px: within the 4px quantum of 64, so it is the SAME column — an
        // optical hang is not a second place to start reading from.
        { tagName: "DIV", className: "body", text: "Body copy", box: { left: 65, top: 460, width: 900, height: 120 } },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.alignmentColumns).toBe(1);
  });

  it("counts a deliberately indented block as a SECOND column", () => {
    const geometry = withFakeDom(
      [
        { tagName: "DIV", className: "headline", text: "A headline", box: { left: 64, top: 200, width: 900, height: 200 } },
        { tagName: "DIV", className: "quote", text: "An indented pull quote", box: { left: 200, top: 460, width: 700, height: 160 } },
      ],
      () => probeGeometry(ARG),
    );
    expect(geometry.alignmentColumns).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// `probe` itself is unchanged — 1.6.0 is additive
// ─────────────────────────────────────────────────────────────────────────

describe("probePage is untouched by 1.6.0", () => {
  it("still round-trips through SlideProbeSchema with no new keys", () => {
    const probe = withFakeDom(
      [
        { tagName: "HTML", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 } },
        { tagName: "BODY", childCount: 1, box: { left: 0, top: 0, width: 1080, height: 1440 }, parent: 0 },
        { tagName: "DIV", className: "copy", text: "A headline", box: { left: 64, top: 1100, width: 952, height: 180 }, parent: 1 },
      ],
      () => probePage({ n: 3, w: 1080, h: 1440 }),
    );
    // The guard the additive claim rests on: an extra key here would be
    // STRIPPED by the schema and this equality would fail.
    expect(SlideProbeSchema.parse(probe)).toEqual(probe);
    expect(Object.keys(probe)).not.toContain("collisions");
    expect(Object.keys(probe)).not.toContain("fontSizeSteps");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The case that actually broke: RTL, through a real Chromium layout
// ─────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = "__tests__/.tmp-collision-templates";
const OUT_DIR = "__tests__/.tmp-collision-out";

const GROUND = "#4A4A5A";
const FOREGROUND = "#FFFFFF";

/**
 * geektime's configuration as it shipped on 2026-09-16, reduced to the two
 * pieces of furniture that collided.
 *
 * `dir="rtl"` is not decoration here: both boxes are placed with
 * `inset-inline-start`, so under RTL they resolve to the RIGHT edge and land
 * in the same corner. `planBrandLogoPlacement` would have moved the mark to
 * the other corner had it known a badge was there — `hasSeriesBadge` was read
 * off the FROZEN tokens rather than the effective ones, so it believed there
 * was none (RFC-22 F2). The result is below, and the probe must see it.
 */
const COLLIDING_HTML = `<!doctype html>
<html dir="rtl"><head><meta charset="utf-8"><style>
  :root { --bg: ${GROUND}; --fg: ${FOREGROUND}; }
  html, body { margin: 0; width: 1080px; height: 1440px; }
  body { background: var(--bg); color: var(--fg); font-family: Georgia, serif; position: relative; }
  .brand-badge { position: absolute; top: 56px; inset-inline-start: 64px; font-size: 19px; letter-spacing: 0.14em; }
  .brand-logo { position: absolute; top: 28px; inset-inline-start: 28px; width: 132px; height: 132px; border-radius: 66px; background: #fff; display: block; }
  .headline { position: absolute; inset-inline: 64px; bottom: 130px; font-size: 74px; line-height: 1.1; }
</style></head>
<body>
  <div class="brand-badge">{{badge}}</div>
  <div class="brand-logo"></div>
  <div class="headline">{{title}}</div>
<script>window.__CAROUSEL_READY__ = true;</script></body></html>`;

/**
 * The same plate after RFC-22 §4.3: the badge is gone and the mark owns a
 * corner nothing else enters. If this one reported a collision the instrument
 * would be crying wolf, and the first thing anyone would do is switch it off.
 */
const CLEARED_HTML = `<!doctype html>
<html dir="rtl"><head><meta charset="utf-8"><style>
  :root { --bg: ${GROUND}; --fg: ${FOREGROUND}; }
  html, body { margin: 0; width: 1080px; height: 1440px; }
  body { background: var(--bg); color: var(--fg); font-family: Georgia, serif; position: relative; }
  .eyebrow { position: absolute; top: 56px; inset-inline-start: 64px; font-size: 19px; letter-spacing: 0.14em; }
  .brand-logo { position: absolute; top: 28px; inset-inline-end: 28px; width: 132px; height: 132px; border-radius: 66px; background: #fff; display: block; }
  .headline { position: absolute; inset-inline: 64px; bottom: 130px; font-size: 74px; line-height: 1.1; }
</style></head>
<body>
  <div class="eyebrow">{{badge}}</div>
  <div class="brand-logo"></div>
  <div class="headline">{{title}}</div>
<script>window.__CAROUSEL_READY__ = true;</script></body></html>`;

function input(overrides: Partial<RenderCarouselInput> = {}): RenderCarouselInput {
  return RenderCarouselInputSchema.parse({
    client: "geektime",
    postId: "post_collision",
    templateDir: TEMPLATE_DIR,
    outDir: OUT_DIR,
    repoRoot: ROOT,
    slides: [
      { n: 1, template: "colliding.html", fields: { badge: "{ FIELD NOTES }", title: "כותרת בעברית" } },
      { n: 2, template: "cleared.html", fields: { badge: "{ FIELD NOTES }", title: "כותרת בעברית" } },
    ],
    canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
    probe: true,
    ...overrides,
  });
}

async function run(payload: RenderCarouselInput): Promise<RenderCarouselResult> {
  const outcome = await createRenderCarousel().execute(payload, {
    ctx: { runId: "r_collision", clientSlug: "geektime", productId: "instagram-agent", runKind: "post", metadata: {} },
  } as never);
  expect(outcome.status, `render failed: ${JSON.stringify(outcome)}`).toBe("success");
  return (outcome as { status: "success"; result: RenderCarouselResult }).result;
}

describe.skipIf(!isChromiumInstalled())("probeGeometry against a real RTL render", () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(ROOT, TEMPLATE_DIR), { recursive: true });
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "colliding.html"), COLLIDING_HTML, "utf8");
    await fs.writeFile(path.join(ROOT, TEMPLATE_DIR, "cleared.html"), CLEARED_HTML, "utf8");
  });

  afterAll(async () => {
    await fs.rm(path.join(ROOT, TEMPLATE_DIR), { recursive: true, force: true });
    await fs.rm(path.join(ROOT, OUT_DIR), { recursive: true, force: true });
  });

  it("sees the geektime collision the pre-RFC-22 templates produce, and reports none once the mark owns its corner", async () => {
    const result = await run(input());

    const colliding = result.rendered.find((r) => r.n === 1);
    const cleared = result.rendered.find((r) => r.n === 2);

    // The defect. Without this limb the whole instrument is crying wolf or
    // blind, and there is no way to tell which.
    expect(colliding?.geometry?.collisions.length ?? 0).toBeGreaterThan(0);
    const pair = colliding!.geometry!.collisions[0]!;
    expect([pair.a, pair.b].sort()).toEqual([".brand-badge", ".brand-logo"].map((s) => `div${s}`).sort());
    expect(pair.overlapPx).toBeGreaterThan(COLLISION_MIN_PX);

    expect(cleared?.geometry?.collisions).toEqual([]);

    // And the existing reads are untouched on both plates.
    expect(colliding?.probe?.overflow).toBe(false);
    expect(cleared?.probe?.overflow).toBe(false);
    // A Chromium launch plus two renders does not fit vitest's 5s default,
    // and a timeout here would read as the instrument failing rather than the
    // harness. Same 120s the sibling render suite uses.
  }, 120_000);

  it("reports a reserved-zone intrusion on the colliding plate and none on the cleared one", async () => {
    // The mark's own zone in RTL: 132px wide, inset 28px from the TOP and
    // from the RIGHT of the 1080px canvas.
    const result = await run(input({ reservedZone: { x: 1080 - 28 - 132, y: 28, w: 132, h: 132 } }));

    const colliding = result.rendered.find((r) => r.n === 1)!;
    const cleared = result.rendered.find((r) => r.n === 2)!;

    expect(colliding.geometry!.collisions.some((c) => c.b === RESERVED_ZONE_SELECTOR && c.a === "div.brand-badge")).toBe(true);
    // `.eyebrow` sits at inset-inline-start, which in RTL is the right edge —
    // the same corner. It is cleared only because the MARK moved to
    // inset-inline-end... which in RTL is the LEFT edge. So the zone declared
    // above is the mark's zone on the colliding plate, and the cleared plate
    // must report its eyebrow against it: the zone is a property of the
    // declaration, not of where the mark happened to land.
    expect(cleared.geometry!.collisions.every((c) => c.b !== RESERVED_ZONE_SELECTOR || c.a !== "div.brand-logo")).toBe(true);
  }, 120_000);

  it("returns a distinct type-step set from a real render that matches the three sizes the template declares", async () => {
    const result = await run(input());
    const steps = result.rendered.find((r) => r.n === 1)?.geometry?.fontSizeSteps ?? [];
    // 74px headline and a 19px badge. Two text-bearing leaves, two steps.
    expect(steps).toEqual([74, 19]);
  }, 120_000);
});
