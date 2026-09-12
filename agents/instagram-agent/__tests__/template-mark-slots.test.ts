import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractSupportedFields } from "@agent-engine/tool-karos-templates";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { isChromiumInstalled } from "./test-helpers.js";

/**
 * RFC-17 §5.4 — TWIN SLOTS, and the guards that hold them together.
 *
 * Five of the eight bundled archetypes gained a twin-slot pair per prose
 * slot: a `<span class="mk-runs">` that takes the marked fragment and a
 * `<span class="mk-plain">` that takes the same copy as ordinary escaped
 * text, with one collapse rule per pair hiding the plain twin when the
 * fragment arrived.
 *
 * WHY THIS SUITE IS THE REAL VERIFICATION ON A DEV MACHINE. Every assertion
 * above the Chromium block is a SOURCE SCAN, so it runs everywhere. The
 * Chromium block self-skips where no browser is installed and CI is its
 * authority — which is the stated rule for every pixel claim in RFC-17, and
 * the reason the structural half is written to stand on its own rather than
 * as a warm-up for the render.
 *
 * The three properties this file exists to hold, all of them things a reader
 * of one template cannot check for themselves:
 *
 *   1. BOTH MEMBERS OF EVERY PAIR ARE DECLARED, and the collapse rule names
 *      the same host as the markup. A rule that names `.headlne` selects
 *      nothing, the plain twin never hides, and the slide renders its copy
 *      TWICE — a defect that is invisible in the source and obvious in the
 *      pixels, which is the worst possible place to find it.
 *   2. THE PINNED SLOT NAMES ARE SPELLED THE ONE WAY. `{{html:titleRun}}` is
 *      not a syntax error; `fillTemplate` erases it and the slide silently
 *      loses its marks for the life of the template.
 *   3. NO PAINTED GROUND WAS DELETED. This is the pixel-cost half of RFC-17
 *      finding 1 written as a test: `IMAGERY_OR_DEVICE_FLOOR`'s calibration
 *      records `cover, colour field, no hero` at 26.9% and says a photoless
 *      cover clears the 0.10 floor at 18.0-20.8% because "that figure is now
 *      a constant of the template". The constant IS `.cov-field`, and the
 *      closer's is `.cl-art`. Delete them and every photoless cover and every
 *      closer falls into the type-only band (0.2-7.0%), where clause E
 *      refuses all of them. A twin-slot edit is exactly the kind of tidy-up
 *      that would take a ground rule with it.
 */

const TEMPLATE_DIR = path.resolve(__dirname, "..", "assets", "templates", "default");

interface TwinPair {
  /** The class on the element that HOSTS the pair — the one the collapse rule must name. */
  host: string;
  /** The `{{html:...}}` slot the marked fragment arrives in. */
  runs: string;
  /** The `{{...}}` slot the plain fallback arrives in. */
  plain: string;
}

/**
 * The pairs, per file. Pinned by RFC-17 §5.4's table and NOT negotiable: the
 * fragment builder writes these exact names, so a rename here is a silent
 * loss of every mark on that archetype.
 *
 * `headline-focus.html`'s host is `.hf-headline` and not `.headline` — the
 * one file in the set whose display slot carries an archetype-prefixed class,
 * and the single likeliest place for a rule copied from a sibling template to
 * select nothing at all.
 */
const TWIN_SLOTS: Record<string, readonly TwinPair[]> = {
  "cover.html": [
    { host: "headline", runs: "titleRuns", plain: "title" },
    { host: "body-text", runs: "subtitleRuns", plain: "subtitle" },
  ],
  "slide.html": [
    { host: "headline", runs: "headlineRuns", plain: "headline" },
    { host: "body-text", runs: "bodyRuns", plain: "body" },
  ],
  "headline-focus.html": [
    { host: "hf-headline", runs: "headlineRuns", plain: "headline" },
    { host: "body-text", runs: "bodyRuns", plain: "body" },
  ],
  "closer.html": [
    { host: "headline", runs: "takeawayRuns", plain: "takeaway" },
    { host: "cl-question", runs: "questionRuns", plain: "question" },
    { host: "cl-cta", runs: "ctaRuns", plain: "cta" },
  ],
  "quote-card.html": [{ host: "quote-text", runs: "quoteRuns", plain: "quoteText" }],
};

/** The eight names, deduplicated — `headlineRuns` and `bodyRuns` are shared by two archetypes. */
const PINNED_SLOTS = [
  "bodyRuns",
  "ctaRuns",
  "headlineRuns",
  "questionRuns",
  "quoteRuns",
  "subtitleRuns",
  "takeawayRuns",
  "titleRuns",
];

/**
 * The three archetypes RFC-17 §5.4 deliberately leaves alone.
 * `list-takeaway` needs nothing (`buildListRows` already emits into
 * `itemRows`, so row marks are free); `stat-callout` and `comparison-card`
 * carry labels and figures rather than clauses, and `.num-figure` is outside
 * `DISPLAY_SELECTORS` for measurement reasons.
 */
const UNTOUCHED = ["list-takeaway.html", "stat-callout.html", "comparison-card.html"];

/**
 * The painted grounds, per file. Presence only — this guard is not trying to
 * pin a design, it is refusing a DELETION (finding 1). Each name here is a
 * selector whose rule paints the field that supplies the archetype's
 * `imageryOrDeviceShare` on a photoless render.
 */
const GROUND_SELECTORS: Record<string, readonly string[]> = {
  "cover.html": [".ground", ".cov-field"],
  "slide.html": [".ground", ".copy-art", "--gr-mark", "--gr-tile", "--gr-repeat"],
  "headline-focus.html": [".ground", ".copy-art", "body.gr-glyph"],
  "closer.html": [".ground", ".cl-art", "body.gr-glyph"],
  "quote-card.html": [".ground", ".quote-block"],
};

async function readTemplate(file: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
}

/** The `<style>` half of a template — a doc comment may legitimately quote an old selector. */
function stylesOf(html: string): string {
  return [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
}

/** The markup half, with every comment stripped, so a prose mention cannot satisfy a markup assertion. */
function markupOf(html: string): string {
  const body = html.slice(html.indexOf("</style>"));
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * THE AUDIT, FACTORED OUT SO IT CAN BE RUN AGAINST A BROKEN COPY.
 *
 * Every "break it and watch the guard refuse" case below mutates the template
 * SOURCE STRING IN MEMORY and runs this same function over it. Nothing on
 * disk is touched, which matters more than usual here: this worktree is
 * shared with other packages editing other files in it right now, and an
 * in-place break-and-restore has already silently overwritten another agent's
 * work on this project.
 */
function auditTwinSlots(html: string, pairs: readonly TwinPair[]): string[] {
  const problems: string[] = [];
  const styles = stylesOf(html);
  const markup = markupOf(html);

  for (const pair of pairs) {
    // The markup: the host element, then the two spans, adjacent, in that
    // order, with NO whitespace anywhere inside or between them. The
    // whitespace rule is not tidiness — one stray text node makes
    // `.mk-runs:not(:empty)` true on an UNMARKED render, the collapse rule
    // fires, and the slide prints nothing at all.
    const pairMarkup = new RegExp(
      `<[a-z]+[^>]*class="[^"]*\\b${escapeRe(pair.host)}\\b[^"]*"[^>]*>` +
        `<span class="mk-runs">\\{\\{html:${escapeRe(pair.runs)}\\}\\}</span>` +
        `<span class="mk-plain">\\{\\{${escapeRe(pair.plain)}\\}\\}</span>` +
        `</[a-z]+>`,
    );
    if (!pairMarkup.test(markup)) {
      problems.push(
        `${pair.host}: markup does not declare the twin pair {{html:${pair.runs}}} + {{${pair.plain}}} as two adjacent, whitespace-free spans inside one .${pair.host} element`,
      );
    }

    // The collapse rule, exactly once, naming this host.
    const collapse = new RegExp(
      `\\.${escapeRe(pair.host)}:has\\(\\.mk-runs:not\\(:empty\\)\\)\\s+\\.mk-plain\\s*\\{\\s*display:\\s*none;?\\s*\\}`,
      "g",
    );
    const hits = styles.match(collapse) ?? [];
    if (hits.length === 0) problems.push(`${pair.host}: no collapse rule — the plain twin would render alongside the runs`);
    if (hits.length > 1) problems.push(`${pair.host}: ${hits.length} collapse rules, expected exactly 1`);
  }

  // No collapse rule may name a host that is not a pair in this file. This is
  // the limb that catches a TYPO: `.headlne:has(.mk-runs...)` leaves the real
  // pair without a rule (caught above) AND leaves a rule pointing at nothing.
  const declaredHosts = new Set(pairs.map((p) => p.host));
  for (const m of styles.matchAll(/\.([A-Za-z0-9_-]+):has\(\.mk-runs:not\(:empty\)\)\s+\.mk-plain/g)) {
    if (!declaredHosts.has(m[1]!)) problems.push(`collapse rule names .${m[1]} which is not a twin-slot host in this file`);
  }

  // A twin host can never match `:empty` again — it has two element children
  // on every render. Any guard still asking that question of the HOST rather
  // than of its children has gone permanently silent, and on four of these
  // five files that guard is what withholds a painted ground from an empty
  // plate.
  for (const pair of pairs) {
    const stale = new RegExp(`\\.${escapeRe(pair.host)}:(?:not\\()?:?empty`);
    if (stale.test(styles.replace(/\/\*[\s\S]*?\*\//g, ""))) {
      problems.push(`.${pair.host} is still asked \`:empty\` directly — a twin host always has element children, so that guard is dead`);
    }
  }

  return problems;
}

describe("RFC-17 twin slots: the five changed archetypes declare both members of every pair", () => {
  for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
    it(`${file} declares ${pairs.length} twin pair(s), each with exactly one collapse rule naming its own host`, async () => {
      const html = await readTemplate(file);
      expect(auditTwinSlots(html, pairs)).toEqual([]);
    });
  }

  it("every collapse rule in the set is accounted for — no orphan rule, no missing one", async () => {
    for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
      const styles = stylesOf(await readTemplate(file));
      const rules = [...styles.matchAll(/:has\(\.mk-runs:not\(:empty\)\)\s+\.mk-plain/g)];
      expect(rules.length, `${file} has ${rules.length} collapse rules for ${pairs.length} pairs`).toBe(pairs.length);
    }
  });

  /**
   * `{{html:...}}` and not `{{...}}`, on every runs slot. An escaped runs slot
   * would render the fragment's own `<span>` tags as literal text across the
   * slide — the loudest possible version of this bug, and the one a source
   * scan is best placed to refuse because it needs no browser to see it.
   */
  it("every runs slot is a RAW html slot and every plain slot is an ESCAPED one", async () => {
    for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
      const html = await readTemplate(file);
      const markup = markupOf(html);
      for (const pair of pairs) {
        expect(markup, `${file}: ${pair.runs} must be read as {{html:${pair.runs}}}`).toContain(`{{html:${pair.runs}}}`);
        expect(markup, `${file}: ${pair.runs} must never be read as an escaped slot`).not.toContain(`{{${pair.runs}}}`);
        expect(markup, `${file}: ${pair.plain} must stay an escaped slot`).toContain(`{{${pair.plain}}}`);
        expect(markup, `${file}: ${pair.plain} must never become a raw html slot`).not.toContain(`{{html:${pair.plain}}}`);
      }
    }
  });
});

describe("RFC-17 twin slots: the eight pinned slot names, spelled one way", () => {
  it("the whole bundled set reads exactly the eight pinned *Runs slots and nothing that looks like them", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    const found = new Set<string>();
    for (const file of files) {
      const markup = markupOf(await readTemplate(file));
      for (const m of markup.matchAll(/\{\{(?:html:|image:)?([A-Za-z0-9_]+)\}\}/g)) {
        const name = m[1]!;
        // Anything that even LOOKS like a runs slot is caught, so `titleRun`,
        // `title_runs` and `titleRUNS` all land here instead of silently
        // being erased by `fillTemplate` for the life of the template.
        if (/runs?$/i.test(name)) found.add(name);
      }
    }
    expect([...found].sort()).toEqual(PINNED_SLOTS);
  });

  it("extractSupportedFields picks up all eight, so the registry reports what each template really reads", async () => {
    const seen = new Set<string>();
    for (const [file] of Object.entries(TWIN_SLOTS)) {
      for (const field of extractSupportedFields(await readTemplate(file))) seen.add(field);
    }
    for (const slot of PINNED_SLOTS) {
      expect(seen.has(slot), `extractSupportedFields does not report ${slot}`).toBe(true);
    }
  });

  it("the plain fields stay in supportedFields too — `fields` is byte-identical to what it was", async () => {
    // Finding 9's second half. `proseFieldsOf`, `contentElementCount`, the
    // topic corpus, the dedupe corpus and the reviewer's editable-fields view
    // all key off the PLAIN field names, so a swap that dropped them would be
    // invisible here and very visible in a reviewer's UI.
    for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
      const fields = extractSupportedFields(await readTemplate(file));
      for (const pair of pairs) {
        expect(fields, `${file} stopped reading {{${pair.plain}}}`).toContain(pair.plain);
      }
    }
  });

  it("the three untouched archetypes declare no runs slot and no mark markup at all", async () => {
    for (const file of UNTOUCHED) {
      const html = await readTemplate(file);
      expect(html, `${file} must not grow a *Runs slot`).not.toMatch(/\{\{html:[A-Za-z0-9_]*[Rr]uns\}\}/);
      expect(markupOf(html), `${file} must not grow twin-slot markup`).not.toContain('class="mk-plain"');
    }
  });
});

describe("RFC-17 finding 1: no painted ground was deleted", () => {
  for (const [file, selectors] of Object.entries(GROUND_SELECTORS)) {
    it(`${file} still declares every ground selector its clause-E constant depends on`, async () => {
      const styles = stylesOf(await readTemplate(file));
      for (const selector of selectors) {
        expect(styles, `${file} no longer declares ${selector}`).toContain(selector);
      }
    });
  }

  it("every field that supplies an archetype's device share still PAINTS — a selector that sets nothing is a deleted ground", async () => {
    // Presence of the class name is not enough: `.cov-field { }` would pass a
    // `toContain` and measure exactly as if the rule had been removed. Each
    // of these has to still carry a `background-image`.
    const painted: Record<string, string> = {
      "cover.html": "cov-field",
      "slide.html": "copy-art",
      "headline-focus.html": "copy-art",
      "closer.html": "cl-art",
      "quote-card.html": "quote-block",
    };
    for (const [file, klass] of Object.entries(painted)) {
      const styles = stylesOf(await readTemplate(file));
      const rules = [...styles.matchAll(new RegExp(`\\.${klass}[^{}]*\\{([^{}]*)\\}`, "g"))];
      expect(rules.length, `${file}: no rule at all for .${klass}`).toBeGreaterThan(0);
      expect(
        rules.some((r) => /background-image\s*:/.test(r[1]!) && !/background-image\s*:\s*none/.test(r[1]!)),
        `${file}: .${klass} no longer paints a background-image — the archetype's imageryOrDeviceShare constant is gone`,
      ).toBe(true);
    }
  });
});

describe("RFC-17 twin slots: BREAK IT — the guards refuse a broken template", () => {
  /**
   * Every case here takes the REAL shipped source, breaks a copy of the
   * string in memory, and requires `auditTwinSlots` to report it. A guard
   * nobody has watched refuse is not a guard.
   */
  it("removing one collapse rule is caught — the plain twin would render alongside the runs", async () => {
    const html = await readTemplate("cover.html");
    const broken = html.replace(".headline:has(.mk-runs:not(:empty)) .mk-plain { display: none; }", "");
    expect(broken).not.toBe(html);
    const problems = auditTwinSlots(broken, TWIN_SLOTS["cover.html"]!);
    expect(problems.join(" | ")).toMatch(/headline: no collapse rule/);
    // And the pair it belongs to is still perfectly well-formed in the
    // markup, which is exactly why the source scan has to look at both halves.
    expect(problems.join(" | ")).not.toMatch(/markup does not declare/);
  });

  it("a typo'd host in a collapse rule is caught twice — the pair loses its rule AND the rule names nothing", async () => {
    const html = await readTemplate("headline-focus.html");
    const broken = html.replace(".hf-headline:has(.mk-runs:not(:empty))", ".hf-headlne:has(.mk-runs:not(:empty))");
    expect(broken).not.toBe(html);
    const problems = auditTwinSlots(broken, TWIN_SLOTS["headline-focus.html"]!);
    expect(problems.join(" | ")).toMatch(/hf-headline: no collapse rule/);
    expect(problems.join(" | ")).toMatch(/collapse rule names \.hf-headlne/);
  });

  it("a STRAIGHT SWAP — the runs slot alone, no plain fallback — is caught", async () => {
    // Finding 9's failure mode: a run resumed across a deploy carries
    // checkpointed slides data with no `*Runs` field, `fillTemplate` erases
    // the slot, and this markup renders an empty headline.
    const html = await readTemplate("slide.html");
    const broken = html.replace(
      '<span class="mk-runs">{{html:headlineRuns}}</span><span class="mk-plain">{{headline}}</span>',
      "{{html:headlineRuns}}",
    );
    expect(broken).not.toBe(html);
    expect(auditTwinSlots(broken, TWIN_SLOTS["slide.html"]!).join(" | ")).toMatch(/headline: markup does not declare the twin pair/);
  });

  it("whitespace inside the twin spans is caught — it would collapse the fallback on an UNMARKED render", async () => {
    const html = await readTemplate("quote-card.html");
    const broken = html.replace('<span class="mk-runs">{{html:quoteRuns}}</span>', '<span class="mk-runs"> {{html:quoteRuns}} </span>');
    expect(broken).not.toBe(html);
    expect(auditTwinSlots(broken, TWIN_SLOTS["quote-card.html"]!).join(" | ")).toMatch(/markup does not declare the twin pair/);
  });

  it("a guard left asking `:empty` of a twin host is caught", async () => {
    const html = await readTemplate("closer.html");
    const broken = html.replace(".cl-cta:not(:has(> span:not(:empty)))", ".cl-cta:empty");
    expect(broken).not.toBe(html);
    expect(auditTwinSlots(broken, TWIN_SLOTS["closer.html"]!).join(" | ")).toMatch(/\.cl-cta is still asked `:empty` directly/);
  });

  it("the ground guard refuses a deleted field, and refuses an emptied one too", async () => {
    const html = await readTemplate("cover.html");
    const styles = stylesOf(html);
    expect(styles).toContain(".cov-field");
    // Deleted outright.
    expect(stylesOf(html.replaceAll(".cov-field", ".cov-gone"))).not.toContain(".cov-field");
    // Present but painting nothing — the case a bare `toContain` would miss.
    const hollow = styles.replace(/(\.cov-field[^{}]*\{)[^{}]*\}/g, "$1 }");
    const rules = [...hollow.matchAll(/\.cov-field[^{}]*\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => /background-image\s*:/.test(r[1]!))).toBe(false);
  });
});

/**
 * THE LENGTH LADDERS, RUN FOR REAL WITHOUT A BROWSER.
 *
 * Every one of these five templates picks its display size from the copy's
 * own character count, in a `<script>` that runs in the page. `textContent`
 * reads a `display: none` subtree, so with both twins in the DOM a naive
 * count reads the copy TWICE on a marked render and steps the type down one
 * or two classes — on exactly the slides that got marks, and only on those.
 *
 * That bug cannot be seen in the source and needs no browser to prove: the
 * helper is a pure function of a DOM-shaped object, so the test extracts the
 * SHIPPED function out of the SHIPPED template and runs it against a stub.
 * It is the real code, not a copy of it.
 */
describe("RFC-17 twin slots: the length ladders measure the visible twin", () => {
  /** Pulls `function mkLen(el) { ... }` (or closer's `var len = function (el) { ... }`) out of a template by brace-matching. */
  function extractHelper(html: string): string {
    const start = html.search(/(?:function mkLen\(el\)|var len = function \(el\))/);
    if (start === -1) throw new Error("no twin-aware length helper in this template");
    const open = html.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < html.length; i += 1) {
      if (html[i] === "{") depth += 1;
      else if (html[i] === "}") {
        depth -= 1;
        if (depth === 0) return `${html.slice(start, i + 1)}`;
      }
    }
    throw new Error("unbalanced braces in the length helper");
  }

  function compile(source: string): (el: unknown) => number {
    const body = source.startsWith("var len")
      ? `${source}; return len;`
      : `${source}; return mkLen;`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function(body)() as (el: unknown) => number;
  }

  function host(runsText: string, plainText: string): unknown {
    const runs = { textContent: runsText };
    const plain = { textContent: plainText };
    return {
      textContent: runsText + plainText,
      querySelector: (sel: string) => (sel === ".mk-runs" ? runs : sel === ".mk-plain" ? plain : null),
    };
  }

  const FILES = ["cover.html", "slide.html", "headline-focus.html", "closer.html", "quote-card.html"];

  for (const file of FILES) {
    it(`${file}'s ladder measures the copy once, marked or not`, async () => {
      const mkLen = compile(extractHelper(await readTemplate(file)));
      const copy = "Most marketing calendars fail in month two";

      // Unmarked: the runs twin is empty (fillTemplate erased the slot), the
      // plain twin carries the copy.
      expect(mkLen(host("", copy))).toBe(copy.length);
      // Marked: BOTH twins carry it, one of them hidden. The count must not
      // double — this is the assertion the whole helper exists for.
      expect(mkLen(host(copy, copy))).toBe(copy.length);
      // Everything empty.
      expect(mkLen(host("", ""))).toBe(0);
      expect(mkLen(null)).toBe(0);
    });

    it(`${file}'s ladder ignores zero-width bidi controls, so a Hebrew twin measures the same as a Latin one`, async () => {
      const mkLen = compile(extractHelper(await readTemplate(file)));
      // `iso()` wraps a Latin run inside a Hebrew field in FSI/PDI, and the
      // marked fragment isolates each of its own runs again. Those characters
      // have no width, so counting them would make the step depend on how the
      // copy was marked rather than on how long it is.
      const FSI = "\u2068";
      const PDI = "\u2069";
      const plain = `שוחרר ${FSI}Gemini 3${PDI} בגרסה חדשה`;
      const marked = `שוחרר ${FSI}Gemini${PDI} ${FSI}3${PDI} בגרסה חדשה`;
      expect(mkLen(host("", plain))).toBe(mkLen(host(marked, marked)));
    });
  }

  it("BREAK IT: a ladder that reads the host's own textContent doubles a marked count", async () => {
    // The naive version, which is what all five files shipped before this
    // change. Compiled from the same stub, so the difference is the helper
    // and nothing else.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const naive = new Function('return function (el) { return el === null ? 0 : (el.textContent || "").trim().length; };')() as (el: unknown) => number;
    const copy = "Most marketing calendars fail in month two";
    expect(naive(host("", copy))).toBe(copy.length);
    expect(naive(host(copy, copy))).toBe(copy.length * 2);

    // And the shipped one does not.
    const mkLen = compile(extractHelper(await readTemplate("cover.html")));
    expect(mkLen(host(copy, copy))).toBe(copy.length);
  });
});

/**
 * ── CHROMIUM-GATED. CI IS THE AUTHORITY FOR EVERY CLAIM BELOW. ──
 *
 * These self-skip on a machine with no Playwright Chromium, which is every
 * dev machine on this project. Report PASSED and SKIPPED separately.
 *
 * The real pipeline is used, not a stand-in: `buildMarkedRuns` builds the
 * fragment and `markCssBlock` builds the stylesheet, both imported read-only
 * from `emphasis-marks.ts`. They are loaded with a dynamic `import()` inside
 * the tests rather than at module scope so that this file's source-scan half
 * — the half that actually runs here — cannot be taken down by a module it
 * does not need.
 *
 * `publish.renderCarousel` has no head-extras input, so the mark stylesheet
 * is delivered INSIDE the runs fragment, which is raw markup by definition.
 * A `<style>` in the body applies document-wide and `probePage` skips `style`
 * elements, so it costs nothing the probe can see. It is only ever injected
 * on the MARKED render, where the runs span is non-empty anyway.
 */
describe.skipIf(!isChromiumInstalled())("RFC-17 twin slots render (Chromium)", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  let outDir = "";

  afterEach(async () => {
    if (outDir !== "") await fs.rm(outDir, { recursive: true, force: true });
  });

  const CTX = { ctx: { runId: "r", clientSlug: "smoke-test", productId: "instagram-agent", runKind: "setup" as const, metadata: {} } };

  /** Copy long enough to wrap at every scale, in both scripts, with three markable phrases in it. */
  const COPY: Record<"ltr" | "rtl", { text: string; marks: [string, string, string] }> = {
    ltr: {
      text: "Most marketing calendars fail in month two, and the pattern is always the same",
      marks: ["marketing calendars", "month two", "the same"],
    },
    rtl: {
      text: "רוב לוחות השיווק נכשלים בחודש השני, והדפוס תמיד חוזר על עצמו בדיוק",
      marks: ["לוחות השיווק", "בחודש השני", "על עצמו"],
    },
  };

  async function runsFragment(copy: { text: string; marks: readonly string[] }, dir: "ltr" | "rtl", withCss: boolean): Promise<string> {
    const { buildMarkedRuns, markCssBlock, buildMarkRing } = await import("../src/workflow/emphasis-marks.js");
    const runs: Array<{ text: string; mark?: { ordinal: number; colourIndex: number; kind: "underline" | "swish" | "double" } }> = [];
    let rest = copy.text;
    const kinds = ["underline", "swish", "double"] as const;
    copy.marks.forEach((needle, i) => {
      const at = rest.indexOf(needle);
      if (at > 0) runs.push({ text: rest.slice(0, at) });
      runs.push({ text: needle, mark: { ordinal: i, colourIndex: i, kind: kinds[i]! } });
      rest = rest.slice(at + needle.length);
    });
    if (rest !== "") runs.push({ text: rest });
    const fragment = buildMarkedRuns(runs, dir === "rtl" ? "rtl" : "ltr");
    if (!withCss) return fragment;
    const ring = buildMarkRing({ brandAccent: "#C4552F", palette: ["#2F6FC4", "#4CA37A", "#D8B14A"] }, "#17181C", "#F4F2EC", "#C4552F");
    return `${markCssBlock(dir === "rtl" ? "Hebrew" : undefined, ring)}${fragment}`;
  }

  function baseInput(file: string, fields: Record<string, string>, htmlFragments: Record<string, string>, postId: string) {
    return {
      client: "smoke-test",
      postId,
      templateDir: "agents/instagram-agent/assets/templates/default",
      outDir: path.relative(REPO_ROOT, outDir),
      repoRoot: REPO_ROOT,
      slides: [{ n: 1, template: file, fields, images: {}, htmlFragments }],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      readyFlag: "__CAROUSEL_READY__",
      probe: true,
    };
  }

  /**
   * ONE PAIR PER FILE IS RENDERED — the display pair, which is the one whose
   * length ladder runs and the one whose size the interest floor's bands were
   * calibrated against. The body pair shares the same two spans and the same
   * collapse rule shape, and the source scan above already pins both.
   */
  const DISPLAY_PAIR: Record<string, { runs: string; plain: string; extra?: Record<string, string> }> = {
    "cover.html": { runs: "titleRuns", plain: "title" },
    "slide.html": { runs: "headlineRuns", plain: "headline" },
    "headline-focus.html": { runs: "headlineRuns", plain: "headline" },
    "closer.html": { runs: "takeawayRuns", plain: "takeaway" },
    "quote-card.html": { runs: "quoteRuns", plain: "quoteText" },
  };

  for (const [file, pair] of Object.entries(DISPLAY_PAIR)) {
    for (const dir of ["ltr", "rtl"] as const) {
      for (const scale of ["s", "m", "l"] as const) {
        it(`${file} ${dir} ${scale}: a marked render is pixel-identical to an unmarked one when no mark stylesheet arrives`, async () => {
          outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-mark-slots-"));
          const copy = COPY[dir];
          const fields = {
            ...pair.extra,
            [pair.plain]: copy.text,
            accentColor: "#C4552F",
            lang: dir === "rtl" ? "he" : "en",
            dir,
            fontScale: scale,
            textAlign: "start",
          };
          const tool = createRenderCarousel();

          // THIS IS THE LINE-COUNT PROOF, and it is stronger than counting
          // lines. With no mark stylesheet the runs are bare inline spans, so
          // the marked document holds exactly the same glyphs in exactly the
          // same boxes as the unmarked one — UNLESS the collapse rule failed
          // (the copy prints twice) or the ladder measured both twins (the
          // type steps down). Either defect changes the pixels; neither can
          // hide inside a tolerance.
          const plainOut = await tool.execute(baseInput(file, fields, {}, "plain"), CTX);
          const markedOut = await tool.execute(
            baseInput(file, fields, { [pair.runs]: await runsFragment(copy, dir, false) }, "marked"),
            CTX,
          );
          if (plainOut.status !== "success" || markedOut.status !== "success") {
            throw new Error(JSON.stringify({ plainOut, markedOut }));
          }
          const plainPng = await fs.readFile(plainOut.result.rendered[0]!.path);
          const markedPng = await fs.readFile(markedOut.result.rendered[0]!.path);
          expect(markedPng.equals(plainPng), `${file} ${dir} ${scale}: marked and unmarked renders differ before any mark is painted`).toBe(true);

          // Finding 3, the half that is about the DOM rather than the pixels.
          // `fontFamiliesUsed` is the only proof a Phase 0 script font loaded,
          // and it must not move because the copy got wrapped.
          const plainProbe = plainOut.result.rendered[0]!.probe!;
          const markedProbe = markedOut.result.rendered[0]!.probe!;
          expect(markedProbe.fontFamiliesUsed).toEqual(plainProbe.fontFamiliesUsed);
          expect(markedProbe.overflow, `${file} ${dir} ${scale}: marked render overflows`).toBe(false);
          expect(plainProbe.overflow, `${file} ${dir} ${scale}: unmarked render overflows`).toBe(false);

          // `textBoxShare` is asserted as NOT COLLAPSED rather than as equal,
          // and the difference is honest arithmetic rather than a softened
          // threshold. `probePage` sums text-bearing LEAVES: unmarked, that is
          // one `.mk-plain` span; marked, it is N run spans, and an inline
          // span that wraps reports the union of its line fragments. Two runs
          // either side of a line break therefore sum to MORE than the single
          // span they replace. What finding 3 is about is the other direction
          // — the number going to ~0 because the text stopped being in a leaf
          // at all — and that is what this refuses.
          expect(markedProbe.textBoxShare).toBeGreaterThanOrEqual(plainProbe.textBoxShare * 0.98);
        }, 60_000);

        it(`${file} ${dir} ${scale}: three marks arrive and all three paint`, async () => {
          outDir = await fs.mkdtemp(path.join(REPO_ROOT, ".tmp-mark-slots-"));
          const copy = COPY[dir];
          const fields = {
            ...pair.extra,
            [pair.plain]: copy.text,
            accentColor: "#C4552F",
            lang: dir === "rtl" ? "he" : "en",
            dir,
            fontScale: scale,
            textAlign: "start",
          };
          const tool = createRenderCarousel();
          const out = await tool.execute(
            baseInput(file, fields, { [pair.runs]: await runsFragment(copy, dir, true) }, "painted"),
            CTX,
          );
          if (out.status !== "success") throw new Error(JSON.stringify(out));
          const probe = out.result.rendered[0]!.probe!;
          expect(probe.markRuns, `${file} ${dir} ${scale}: the fragment did not reach the DOM`).toBe(3);
          expect(probe.markRunsPainted, `${file} ${dir} ${scale}: the mark stylesheet did not arrive`).toBe(3);
          expect(probe.overflow, `${file} ${dir} ${scale}: a painted mark pushed the block out of its box`).toBe(false);
        }, 60_000);
      }
    }
  }
});
