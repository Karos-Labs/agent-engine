import { describe, expect, it, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { extractSupportedFields } from "@agent-engine/tool-karos-templates";
import { createRenderCarousel } from "@agent-engine/tool-karos-publish";
import { MARK_HOST_INK_ALPHA } from "../src/workflow/emphasis-marks.js";
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
  /**
   * The host's `id`, where it has one. THIS IS NOT DECORATION. Four of the
   * five files withhold their painted ground from an empty plate through a
   * rule written against the ID rather than the class —
   * `body:not(:has(#title > span:not(:empty))) .cov-field { background-image: none; }`
   * is the cover's, and `#headline` / `#takeaway` carry the other three. Those
   * are precisely the rules a twin-slot edit turns into permanent no-ops if it
   * rewrites them carelessly, so the staleness limb has to ask about the id
   * form too, not just `.host:empty`.
   */
  id?: string;
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
    { host: "headline", runs: "titleRuns", plain: "title", id: "title" },
    { host: "body-text", runs: "subtitleRuns", plain: "subtitle" },
  ],
  "slide.html": [
    { host: "headline", runs: "headlineRuns", plain: "headline", id: "headline" },
    { host: "body-text", runs: "bodyRuns", plain: "body" },
  ],
  "headline-focus.html": [
    { host: "hf-headline", runs: "headlineRuns", plain: "headline", id: "headline" },
    { host: "body-text", runs: "bodyRuns", plain: "body" },
  ],
  "closer.html": [
    { host: "headline", runs: "takeawayRuns", plain: "takeaway", id: "takeaway" },
    { host: "cl-question", runs: "questionRuns", plain: "question" },
    { host: "cl-cta", runs: "ctaRuns", plain: "cta" },
  ],
  "quote-card.html": [{ host: "quote-text", runs: "quoteRuns", plain: "quoteText", id: "quote" }],
  // Added by the integrator, closing the gap the "one known gap" assertion
  // below used to pin. `slides-data.ts` has always emitted `headlineRuns` for
  // `list_takeaway`; this file simply had nowhere for it to land. Its ROWS are
  // still not a twin pair and never will be — `buildListRows` inlines their
  // marks into `{{html:itemRows}}` itself.
  "list-takeaway.html": [{ host: "me-head", runs: "headlineRuns", plain: "headline", id: "head" }],
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
 * The two archetypes RFC-17 §5.4 deliberately leaves alone: `stat-callout`
 * and `comparison-card` carry labels and figures rather than clauses, and
 * `.num-figure` is outside `DISPLAY_SELECTORS` for measurement reasons.
 *
 * `list-takeaway` was in this list and should not have been. §5.4's "row
 * marks are free" is true — `buildListRows` inlines them into `itemRows` —
 * but it says nothing about the HEADLINE, which `slides-data.ts` routes
 * through `headlineRuns` like every other archetype's and which this file had
 * no slot for. It now carries one twin pair and lives in `TWIN_SLOTS`.
 */
const UNTOUCHED = ["stat-callout.html", "comparison-card.html"];

/**
 * The grounds RFC-20 KEEPS, per file. Presence only — this guard is not
 * trying to pin a design, it is refusing a DELETION. Each name here is a
 * selector whose rule paints the field that supplies the archetype's
 * `imageryOrDeviceShare` on a photoless render.
 *
 * ── RFC-20 §5.2 REMOVED FOUR NAMES FROM THIS TABLE, AND THAT IS THE PHASE ──
 *
 * `.cov-field`, `.copy-art` (twice) and `.cl-art` were here, and RFC-17
 * finding 1 was right that deleting them would drop a photoless cover and the
 * closer into the type-only band. RFC-20 Part 5 measured the other half of
 * that trade and it is worse: those layers are FULL-BLEED, and under the
 * instrument `covered` implies `carriesInk`, so anything visible to clause E
 * is also visible to clauses C and D. MEASURED, the shipped 45-degree screen
 * on `headline-focus` alone takes `contentOccupiedShare` to 0.3128,
 * `occupiedShare` to 0.6426 and `largestEmptyRectShare` to **0.0000** — and a
 * properly composed plate and the owner's grey screen then measure 0.6688 vs
 * 0.6324 and BOTH PASS. A bar that cannot refuse the thing it was built for
 * is worthless, so the layers come out and the share they were carrying is
 * paid by bounded, content-guarded objects instead (§5.3, §5.5).
 *
 * Deleting a pin is not free, so it is replaced rather than dropped: the
 * "those four must not come back" half is the guard below, and the general
 * rule — no full-bleed layer may carry ink, at all, in any template — is G2
 * in `interest-floor-calibration.test.ts`, which renders every archetype with
 * every copy slot empty.
 */
const GROUND_SELECTORS: Record<string, readonly string[]> = {
  "cover.html": [".ground"],
  "slide.html": [".ground"],
  "headline-focus.html": [".ground"],
  "closer.html": [".ground"],
  "quote-card.html": [".ground", ".quote-block"],
  // Added with the twin pair above. `.lt-head`'s column ruling is withheld
  // from an empty plate by `body:has(#head > span:not(:empty))`, and that
  // `> span` is the whole reason the twin edit is safe: `#head` now always
  // CONTAINS two spans, so the `#head:not(:empty)` form it replaced would
  // have been permanently true and painted the ruling on a blank plate.
  "list-takeaway.html": [".ground", ".lt-head"],
};

async function readTemplate(file: string): Promise<string> {
  return fs.readFile(path.join(TEMPLATE_DIR, file), "utf8");
}

/** The `<style>` half of a template — a doc comment may legitimately quote an old selector. */
function stylesOf(html: string): string {
  return [...html.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");
}

/** The markup half, with every comment stripped, so a prose mention cannot satisfy a markup assertion. */
/** The plate's inline script — the fit ladder, which is generated into every
 *  template between the `@ds:fit-start` / `@ds:fit-end` markers. */
function scriptOf(html: string): string {
  const body = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) ?? ["", ""])[1]!;
  /* Comments stripped: these guards read CODE. The ladder's own doc comment
     names `textContent` as the thing it replaced, and a scan that cannot tell
     an explanation from a call fails on the explanation — which it did. */
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function markupOf(html: string): string {
  const body = html.slice(html.indexOf("</style>"));
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every raw-fragment token this file spells more than once, as
 * `"<file>: <token> xN"`. Reads the RAW source on purpose — `markupOf` strips
 * comments, and a comment is precisely where the second occurrence hides.
 */
function duplicateRawTokens(file: string, html: string): string[] {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/\{\{html:[A-Za-z0-9_]*\}\}/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([token, n]) => `${file}: ${token} x${n}`);
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

  }

  // ── ONE COLLAPSE RULE FOR THE WHOLE SET, NOT ONE PER HOST. ──
  //
  // This used to require `.<host>:has(.mk-runs:not(:empty)) .mk-plain` once per
  // twin pair — sixteen near-identical rules across eight files, each naming a
  // class, each a place to make a typo, and the limb below existed only to
  // catch that typo. The shared sheet states the relationship between the two
  // TWINS rather than between a host and a twin, so one adjacent-sibling rule
  // covers every pair in the set and cannot name a host wrongly because it
  // names no host at all.
  const sharedCollapse = styles.match(/\.mk-runs:not\(:empty\)\s*\+\s*\.mk-plain\s*\{\s*display:\s*none;?\s*\}/g) ?? [];
  if (sharedCollapse.length === 0) {
    problems.push("no shared twin collapse rule — the plain twin would render alongside the runs");
  }
  if (sharedCollapse.length > 1) {
    problems.push(`${sharedCollapse.length} shared twin collapse rules, expected exactly 1`);
  }

  // No collapse rule may name a host that is not a pair in this file. This is
  // the limb that catches a TYPO: `.headlne:has(.mk-runs...)` leaves the real
  // pair without a rule (caught above) AND leaves a rule pointing at nothing.
  // A per-host collapse rule coming BACK is the drift this consolidation
  // removed, so it is a problem in its own right rather than merely redundant:
  // two mechanisms for one relationship is how the set drifted to begin with,
  // and the host-named one is the fragile half.
  for (const m of styles.matchAll(/\.([A-Za-z0-9_-]+):has\(\.mk-runs:not\(:empty\)\)\s+\.mk-plain/g)) {
    problems.push(`per-host collapse rule for .${m[1]} — the set has one shared rule; delete this one`);
  }

  // A twin host can never match `:empty` again — it has two element children
  // on every render. Any guard still asking that question of the HOST rather
  // than of its children has gone permanently silent, and on four of these
  // five files that guard is what withholds a painted ground from an empty
  // plate.
  const liveStyles = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const pair of pairs) {
    const stale = new RegExp(`\\.${escapeRe(pair.host)}:(?:not\\()?:?empty`);
    if (stale.test(liveStyles)) {
      problems.push(`.${pair.host} is still asked \`:empty\` directly — a twin host always has element children, so that guard is dead`);
    }
    if (pair.id !== undefined) {
      // The ID form, which is the one four of these five files actually use to
      // withhold a painted ground from an empty plate. `#title:empty` is never
      // true again once the twins are in the DOM, so a rule written that way
      // paints the ground on a slide that says nothing — finding 1 inverted.
      // The only correct shape is `#title > span:not(:empty)`, which asks the
      // CHILDREN and is true iff one of the twins carries copy.
      const staleId = new RegExp(`#${escapeRe(pair.id)}:(?:not\\()?:?empty`);
      if (staleId.test(liveStyles)) {
        problems.push(`#${pair.id} is still asked \`:empty\` directly — a twin host always has element children, so that guard is dead`);
      }
      // And the id has to actually be on the host, or the rules that name it
      // select nothing at all.
      const onHost = new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${escapeRe(pair.host)}\\b[^"]*"[^>]*id="${escapeRe(pair.id)}"`);
      const onHostReversed = new RegExp(`<[a-z]+[^>]*id="${escapeRe(pair.id)}"[^>]*class="[^"]*\\b${escapeRe(pair.host)}\\b`);
      if (!onHost.test(markup) && !onHostReversed.test(markup)) {
        problems.push(`#${pair.id} is not on the .${pair.host} element — every ground rule written against it selects nothing`);
      }
    }
  }

  return problems;
}

describe("RFC-17 twin slots: the six changed archetypes declare both members of every pair", () => {
  for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
    it(`${file} declares ${pairs.length} twin pair(s), each with exactly one collapse rule naming its own host`, async () => {
      const html = await readTemplate(file);
      expect(auditTwinSlots(html, pairs)).toEqual([]);
    });
  }
  it("the set carries exactly one collapse rule per file, whatever its pair count", async () => {
    /* The accounting used to be "one rule per PAIR" — sixteen rules across the
       set, each naming a host, and this limb existed to catch one going
       missing or one naming a host that is not a pair. The shared rule states
       the relationship between the two TWINS instead, so the count no longer
       tracks the pair count: one rule serves a file with three pairs exactly as
       it serves a file with one, and a per-host rule reappearing is reported as
       drift by `auditTwinSlots`. */
    for (const [file, pairs] of Object.entries(TWIN_SLOTS)) {
      const styles = stylesOf(await readTemplate(file));
      const shared = [...styles.matchAll(/\.mk-runs:not\(:empty\)\s*\+\s*\.mk-plain/g)];
      expect(shared.length, `${file} has ${shared.length} shared collapse rules, serving ${pairs.length} pair(s)`).toBe(1);
      const perHost = [...styles.matchAll(/:has\(\.mk-runs:not\(:empty\)\)\s+\.mk-plain/g)];
      expect(perHost.length, `${file} still carries ${perHost.length} per-host collapse rule(s)`).toBe(0);
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

/**
 * RFC-20 §6 — `MARK_HOST_INK_ALPHA` IS A CLAIM ABOUT THESE FILES, SO THESE
 * FILES ARE WHAT CHECKS IT.
 *
 * `block` admission asks whether the ink reads at 4.5:1 ON the swatch. The ink
 * a reader gets is not `var(--fg)`: every bundled archetype softens its body
 * ink with `color-mix(in srgb, var(--fg) N%, transparent)`, and over a block
 * swatch that composites the glyphs TOWARD the swatch — i.e. toward the very
 * colour they have to contrast with. `emphasis-marks.ts` therefore measures
 * the composited ink at `MARK_HOST_INK_ALPHA`, and that constant is only
 * correct while it is the MINIMUM alpha any mark-bearing host paints.
 *
 * A template edit that softened one host to 85% would silently make the
 * admission optimistic again, with no symptom anywhere: the ring would still
 * build, the mark would still paint, and the contrast would just be wrong. So
 * the scan reads the alpha off every element that hosts a `*Runs` slot and
 * fails on the first one under the constant, naming it.
 *
 * BROKEN BEFORE IT WAS TRUSTED: setting `MARK_HOST_INK_ALPHA` to 0.95 turns
 * this red on `stat-callout.html` (0.90), `cover.html`, `headline-focus.html`
 * and `slide.html` (0.92); dropping any host's `92%` to `85%` turns it red on
 * that host alone.
 */
describe("RFC-20 §6: MARK_HOST_INK_ALPHA is the worst case the bundled templates actually paint", () => {
  it("no mark-bearing host softens its ink below the constant block admission composites with", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    const offenders: string[] = [];
    let hostsSeen = 0;
    for (const file of files) {
      const html = await readTemplate(file);
      const styles = stylesOf(html);
      const markup = markupOf(html);
      // The classes on elements that actually host a runs slot in THIS file.
      for (const match of markup.matchAll(/class="([^"]*)"[^>]*>\s*<span class="mk-runs">/g)) {
        for (const cls of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
          // Every declaration of `color: color-mix(… var(--fg) N%, transparent)`
          // on a rule that names this class. A host with no softened ink is
          // painting `--fg` neat, which is alpha 1 and never an offender.
          for (const decl of styles.matchAll(new RegExp(String.raw`\.${cls}\b[^{]*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)`, "g"))) {
            hostsSeen += 1;
            const alpha = Number(decl[1]) / 100;
            if (alpha < MARK_HOST_INK_ALPHA) offenders.push(`${file} .${cls} paints its ink at ${decl[1]}%, under MARK_HOST_INK_ALPHA ${MARK_HOST_INK_ALPHA * 100}%`);
          }
        }
      }
    }
    // The scan has to have FOUND something, or it is asserting over an empty
    // set and would stay green through a wholesale rename of `mk-runs`.
    expect(hostsSeen, "the scan matched no softened mark host at all — the selector or the markup shape moved").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
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

  /**
   * A DOC COMMENT IS A SUBSTITUTION SITE, AND THAT IS NOT A STYLE OPINION.
   *
   * `fillTemplate` (`render-carousel.ts:230`) is
   * `filled.replaceAll(\`{{html:${"${key}"}}}\`, fragment)` over the WHOLE
   * file. It has no parser and no idea what a comment is. Every one of the
   * six mark-bearing templates shipped its `*Runs` token TWICE — once in the
   * real slot and once spelled out in a doc comment living inside `<style>` —
   * so the mark fragment was substituted into the stylesheet as well. The
   * mark sheet the workflow splices in carries its own `<style>` block, and
   * that block's `</style>` closed the HOST stylesheet early: measured on all
   * six files, `insideAStyleEl` went 3 -> 0 and the rendered plate came back
   * covered top to bottom in the template's own source prose set as body copy.
   *
   * Every existing assertion in this file reads `markupOf`, which strips
   * comments — which is exactly why none of them could see it. This one reads
   * the RAW file, deliberately.
   *
   * The escaped `{{key}}` form is NOT covered here and does not need to be:
   * `escapeHtmlText` runs before substitution, so a plain field cannot carry
   * `<` and cannot close an element. Only the raw form can.
   */
  it("every raw-fragment token appears EXACTLY ONCE per file — a comment must never be a second substitution site", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    const offenders: string[] = [];
    for (const file of files) offenders.push(...duplicateRawTokens(file, await readTemplate(file)));
    expect(offenders, "drop the braces in the prose — write `html:titleRuns`, not the token").toEqual([]);
  });

  /**
   * AND THE SAME TRAP ONE LEVEL UP: a `<style>` tag spelled out in prose.
   *
   * Not hypothetical — the paragraph documenting the duplicate-token bug
   * quoted a literal closing style tag while explaining it, inside the very
   * stylesheet it was explaining. Chromium closed `cover.html`'s stylesheet
   * there, every collapse rule below it stopped being CSS, and the two tests
   * above this one went red. A style element in this directory is opened and
   * closed exactly once, in the markup, and a comment describes one in words.
   */
  it("no template opens or closes a style element outside the one real pair", async () => {
    const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith(".html"));
    const offenders: string[] = [];
    for (const file of files) {
      const html = await readTemplate(file);
      const opens = (html.match(/<style[\s>]/gi) ?? []).length;
      const closes = (html.match(/<\/style\s*>/gi) ?? []).length;
      if (opens !== 1 || closes !== 1) offenders.push(`${file}: ${opens} open, ${closes} close`);
    }
    expect(offenders, "write the tag in words inside a comment — a literal one is parsed, comment or not").toEqual([]);
  });

  it("BREAK IT: a style tag spelled out in a comment is caught", async () => {
    const shipped = await readTemplate("cover.html");
    // Injected into a comment INSIDE the stylesheet, which is where the real
    // one was written. The anchor moved to the shared sheet's own banner when
    // the eight per-template blocks became one generated block; what the case
    // proves is unchanged — a `</style>` spelled out in a CSS comment ends the
    // sheet early and every rule after it stops being CSS.
    const anchor = "THE DESIGN SYSTEM — one source of truth for all eight plates.";
    expect(shipped, "the anchor this break-it hangs on is gone").toContain(anchor);
    const broken = shipped.replace(anchor, "the fragment's own </style> closes this one. " + anchor);
    expect(broken, "the break-it mutation did not apply").not.toBe(shipped);
    expect((broken.match(/<\/style\s*>/gi) ?? []).length).toBe(2);
    // And it is not a cosmetic complaint: the collapse rules stop being CSS.
    expect(stylesOf(broken)).not.toContain(".mk-plain { display: none; }");
    expect(stylesOf(shipped)).toContain(".mk-plain { display: none; }");
  });

  it("BREAK IT: a token spelled out in a doc comment is caught", async () => {
    // The exact shape that shipped: the real slot, plus the same token quoted
    // in a `<style>` comment. Run through the SAME function the guard above
    // uses, so a guard that stopped looking fails here too.
    const shipped = await readTemplate("cover.html");
    expect(duplicateRawTokens("cover.html", shipped)).toEqual([]);
    const broken = shipped.replace("</style>", "/* `.headline` takes {{html:titleRuns}} */\n</style>");
    expect(broken, "the break-it mutation did not apply").not.toBe(shipped);
    expect(duplicateRawTokens("cover.html", broken)).toEqual(["cover.html: {{html:titleRuns}} x2"]);
  });

  it("the three untouched archetypes declare no runs slot and no mark markup at all", async () => {
    for (const file of UNTOUCHED) {
      const html = await readTemplate(file);
      expect(html, `${file} must not grow a *Runs slot`).not.toMatch(/\{\{html:[A-Za-z0-9_]*[Rr]uns\}\}/);
      expect(markupOf(html), `${file} must not grow twin-slot markup`).not.toContain('class="mk-plain"');
    }
  });
});

/**
 * THE OTHER HALF OF THE CONTRACT, AND THE ONE NO TEMPLATE CAN CHECK ALONE.
 *
 * Everything above proves the five templates declare their slots. It cannot
 * prove the slots are the ones `slides-data.ts` actually FILLS. Those are two
 * independent lists maintained in two files, and `fillTemplate` reconciles
 * them SILENTLY: a fragment whose `{{html:...}}` slot does not exist in the
 * target template is simply never substituted and is dropped on the floor.
 * No error, no empty render, no probe signal — the marks were computed, paid
 * for in output tokens, counted in `marksAccepted`, and thrown away.
 *
 * So this reads BOTH sides out of the real source. The layout-to-file map and
 * the `runsSlot(...)` calls are parsed out of `slides-data.ts` rather than
 * restated here, because a restated copy of a map is a guard that passes
 * forever while the thing it mirrors moves.
 */
describe("RFC-17 twin slots: every runs fragment slides-data emits has a slot to land in", () => {
  const SLIDES_DATA = path.resolve(__dirname, "..", "src", "workflow", "slides-data.ts");

  /** `photo` and `text_only` take the client's configured `slideTemplate`, whose schema default is `slide.html`. `custom` resolves to a per-client generated file that is not in this directory. */
  const NON_MAPPED: Record<string, string | null> = { photo: "slide.html", text_only: "slide.html", custom: null };

  async function parseSource(): Promise<{ files: Map<string, string | null>; emits: Map<string, Set<string>> }> {
    const src = await fs.readFile(SLIDES_DATA, "utf8");

    const mapBlock = /const LAYOUT_TEMPLATE_FILES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    if (mapBlock === null) throw new Error("LAYOUT_TEMPLATE_FILES no longer parses — this guard is reading the wrong shape");
    const files = new Map<string, string | null>(Object.entries(NON_MAPPED));
    for (const m of mapBlock[1]!.matchAll(/^\s*([a-z_]+):\s*"([^"]+)"/gm)) files.set(m[1]!, m[2]!);

    /**
     * THE PARSE IS ANCHORED, AND THIS IS NOT A DETAIL.
     *
     * `slides-data.ts` holds TWO switches over `slide.layout`: a validation
     * one that decides whether a layout has the content it needs, and the
     * field builder below it. Both use the same ten case labels, and the
     * validation one is full of deliberate fallthroughs
     * (`case "cover": case "photo": case "text_only": case "headline_focus":`
     * share a body). Read without an anchor, those fallthroughs propagate
     * across the wrong switch and hand `cover` the names belonging to
     * `headline_focus` — which is exactly what this guard did on its first
     * run, silently reporting `cover.html` as missing two slots it plainly
     * declares. `runsSlot` is a local in the builder, so a case that can
     * possibly call it is a case declared after it.
     */
    const anchor = src.indexOf("const runsSlot =");
    if (anchor === -1) throw new Error("`const runsSlot =` is gone — this guard is anchored to a shape that no longer exists");
    const region = src.slice(anchor);

    // Only the layouts are considered, so an unrelated switch elsewhere in the
    // region cannot inject a phantom case.
    const layouts = new Set(files.keys());
    const cases = [...region.matchAll(/case "([a-z_]+)":/g)].filter((m) => layouts.has(m[1]!));
    const dupes = cases.map((m) => m[1]!).filter((l, i, a) => a.indexOf(l) !== i);
    if (dupes.length > 0) throw new Error(`a second layout switch appeared after \`runsSlot\` (${dupes.join(", ")}) — the anchor no longer isolates one switch`);
    const emits = new Map<string, Set<string>>();
    const order: string[] = [];
    const fellThrough: boolean[] = [];
    cases.forEach((m, i) => {
      const start = m.index!;
      const end = i + 1 < cases.length ? cases[i + 1]!.index! : region.length;
      const block = region.slice(start, end);
      const names = new Set<string>();
      for (const call of block.matchAll(/runsSlot\(([\s\S]*?)markRuns\(/g)) {
        // The closer picks its second slot with a ternary
        // (`... ? "questionRuns" : "ctaRuns"`), so BOTH arms are collected —
        // both are reachable and both need a slot.
        for (const q of call[1]!.matchAll(/"([A-Za-z0-9_]+Runs)"/g)) names.add(q[1]!);
      }
      order.push(m[1]!);
      emits.set(m[1]!, names);
      fellThrough.push(!/\breturn\b/.test(block));
    });
    // `case "photo": case "text_only": case "headline_focus":` share one body.
    for (let i = order.length - 2; i >= 0; i -= 1) {
      if (fellThrough[i] === true) emits.set(order[i]!, emits.get(order[i + 1]!)!);
    }
    return { files, emits };
  }

  /**
   * VERIFY THE INSTRUMENT BEFORE TRUSTING WHAT IT SAYS. A parser that matched
   * nothing would make every assertion below vacuously true, which is the
   * exact shape of a guard that cannot fail. So the parse is pinned first:
   * all ten layouts, and the eight distinct names, recovered from source.
   */
  it("the source parse actually finds both sides — ten layouts and all eight pinned names", async () => {
    const { files, emits } = await parseSource();
    expect([...files.keys()].sort()).toEqual([
      "closer",
      "comparison_card",
      "cover",
      "custom",
      "headline_focus",
      "list_takeaway",
      "photo",
      "quote_card",
      "stat_callout",
      "text_only",
    ]);
    const all = new Set<string>();
    for (const names of emits.values()) for (const n of names) all.add(n);
    expect([...all].sort()).toEqual(PINNED_SLOTS);
    // The fallthrough limb specifically: `photo` and `text_only` carry no body
    // of their own and must inherit `headline_focus`'s two names.
    expect([...emits.get("photo")!].sort()).toEqual(["bodyRuns", "headlineRuns"]);
    expect([...emits.get("text_only")!].sort()).toEqual(["bodyRuns", "headlineRuns"]);
    // And the archetypes RFC-17 leaves deliberately unmarked emit nothing.
    expect([...emits.get("stat_callout")!]).toEqual([]);
    expect([...emits.get("comparison_card")!]).toEqual([]);
  });

  it("every emitted fragment lands in a declared slot — no exceptions", async () => {
    const { files, emits } = await parseSource();
    const dropped: string[] = [];
    for (const [layout, names] of emits) {
      const file = files.get(layout);
      if (file === null || file === undefined) continue;
      const markup = markupOf(await readTemplate(file));
      for (const name of names) {
        if (!markup.includes(`{{html:${name}}}`)) dropped.push(`${layout} -> ${file}: {{html:${name}}}`);
      }
    }

    /**
     * THE GAP THIS USED TO PIN IS CLOSED — the entry read
     * `"list_takeaway -> list-takeaway.html: {{html:headlineRuns}}"`.
     *
     * `slides-data.ts` routes a list slide's HEADLINE marks through
     * `headlineRuns` ("like every other archetype's", says its own comment at
     * the `list_takeaway` case), but `list-takeaway.html` rendered its
     * headline as a bare `{{headline}}` in `.me-head` and declared no runs
     * slot, so `fillTemplate` built the fragment, the run paid for it in
     * output tokens, `marksAccepted` counted it, and it was dropped on the
     * floor. It now carries the twin pair, and `rf-11` — the dense reference
     * list, this archetype's own reference slide — gets the marked headline
     * it should always have had.
     *
     * The row marks were never part of this and are not now: `buildListRows`
     * inlines them into `itemRows` itself, which is what RFC-17 §5.4 means by
     * "row marks are free".
     *
     * KEEP THIS AN EQUALITY AGAINST THE EMPTY ARRAY, never a floor. A
     * `toHaveLength(0)` reads the same and behaves the same; a
     * `expect(dropped.length).toBeLessThanOrEqual(n)` does not, and is how a
     * silently-dropped fragment gets grandfathered in next time.
     */
    expect(dropped.sort()).toEqual([]);
  });

  it("BREAK IT: a template that loses a slot slides-data still fills is caught", async () => {
    // Proving the limb above has teeth, on a file this package does own. The
    // check is re-run against a mutated COPY of the cover's markup; nothing on
    // disk is touched, which matters in a worktree shared with live packages.
    const { emits } = await parseSource();
    const markup = markupOf(await readTemplate("cover.html")).replace("{{html:subtitleRuns}}", "");
    const dropped = [...emits.get("cover")!].filter((n) => !markup.includes(`{{html:${n}}}`));
    expect(dropped).toEqual(["subtitleRuns"]);
  });
});

describe("RFC-20 §5.0: the Ground Rule, as a source scan", () => {
  for (const [file, selectors] of Object.entries(GROUND_SELECTORS)) {
    it(`${file} still declares every ground selector its clause-E constant depends on`, async () => {
      const styles = stylesOf(await readTemplate(file));
      for (const selector of selectors) {
        expect(styles, `${file} no longer declares ${selector}`).toContain(selector);
      }
    });
  }

  it("the bounded object that survives still PAINTS — a selector that sets nothing is a deleted ground", async () => {
    // Presence of the class name is not enough: `.quote-block { }` would pass
    // a `toContain` and measure exactly as if the rule had been removed, so
    // it has to still carry a `background-image`.
    //
    // `quote-card` is the one entry left of five, and it is here because
    // RFC-20 §5.2 measured it and left it alone: MEASURED-EDGE the four panel
    // archetypes (`quote-card` 47.30, `stat-callout` 34.59, `list-takeaway`
    // 33.58, `comparison-card` 19.39) are unchanged to 2 dp with all ground
    // paint suppressed, so their clause-E share was never coming from a
    // full-bleed layer in the first place. `.lt-head` is deliberately NOT
    // asserted as painting: its 2px/9px ruling is the same shape as the
    // screens below and it sits on a `flex: 1 1 auto` box that absorbs
    // leftover space, which is what §5.3 forbids — whether it survives as a
    // bounded object is Part 5's call and not this file's to pre-empt.
    const painted: Record<string, string> = {
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
  // ── THE DELETED-SCREEN SCAN TRAVELLED OUT OF THIS PR WITH ITS SUBJECTS. ──
  //
  // It pinned three rows: `.copy-art` on `headline-focus.html` and on
  // `slide.html`, and `.cl-art` on `closer.html`. RFC-20 Part 11 reverted all
  // three files to `origin/main`, so every row was asserting that a screen
  // stays deleted in a file this PR does not change — which it does not.
  //
  // The rule that sent them back is one sentence and it is worth more than the
  // three cases: **an archetype gets the material ground only when its own
  // composition clears the floor without paint, and a plate with an unearned
  // hole keeps today's behaviour.** On CI renders every one of these plates has
  // a hole the screen was painting over — `slide` `LER` up to 0.3750,
  // `closer` 0.2278/0.2306 at `(0,0)`. **The holes were always there.**
  //
  // Not weakened, not deleted: RFC-20 §11.4 lists this case with the guards, and
  // it returns in the same PR as the bounded object that lets the screens go.
  // The measurements that justified each deletion are preserved verbatim in
  // §5.2's table, so a reviewer who wants a layer back still has to argue with a
  // number rather than with a preference.
  // ── THE PANEL-FURNITURE SCAN TRAVELLED OUT TOO, AND NOT AS AN EMPTY LOOP. ──
  //
  // It held five rows across `stat-callout.html` and `comparison-card.html`:
  //
  //   stat-callout.html    .sc-rail   withheld when .eyebrow is empty
  //   stat-callout.html    .stat-band withheld when #figure is empty
  //   comparison-card.html .cmp-rail  withheld when .eyebrow is empty
  //   comparison-card.html .cmp-rule  withheld when .cmp-label is empty
  //   comparison-card.html .cmp-col   withheld when .cmp-label is empty
  //
  // Both files reverted to `origin/main` with RFC-20 Part 11, so the scan had
  // no subject. It is removed rather than left looping over an empty table,
  // because a loop with nothing in it PASSES, and a green case that asserts
  // nothing is worse than no case at all — it is the same defect as a guard
  // left behind testing work that is not there.
  //
  // THE GUARDS WERE RIGHT, AND THEY ARE WHAT EXPOSED THE REAL DEFECT. With
  // `.sc-rail` withheld from a plate with no eyebrow, `stat-callout` reports a
  // 0.2750 rectangle at `(0,0)` — the rail had been breaking up a hole rather
  // than the composition filling it — and `comparison-card` falls to `occ`
  // 0.2857, 0.95x its floor. **The holes were always there.** RFC-20 §11.4
  // lists these five rows by name; they come back with the composition that
  // earns them, unweakened.


  /**
   * THE COVER IS THE OTHER HALF OF THE SAME RULE, and it is the interesting
   * one.
   *
   * `.cov-field` did not go away — RFC-20 §5.2 deletes its full-bleed hairline
   * SCREEN, and §5.5 keeps the bounded accent RAMP that is the cover's one
   * object. So "the class is gone" would be the wrong pin here and "it still
   * paints" would be the wrong pin too. The Ground Rule's clause (b) is the
   * right one, and it has two limbs, both checkable in the source:
   *
   *   BOUNDED IN EXTENT — an explicit block-axis length and `no-repeat`. A
   *   screen is a `repeating-*-gradient` tiled over the plate; a ramp is one
   *   pass of a fixed height. MEASURED, the deleted screen was solely
   *   responsible for taking `largestEmptyRectShare` 40.00 -> 7.50 while
   *   carrying 0.22 points of clause E, and deleting it RAISED `iod` 14.09 ->
   *   17.12 because its hairlines were adding a fourth distinct colour to the
   *   ramp's own cells and pushing them out of the `graphic` bucket.
   *
   *   SWITCHED OFF WHEN ITS CONTENT IS ABSENT — the `body:not(:has(#title >
   *   span:not(:empty)))` guard. Without it the cover paints a ramp on a plate
   *   with nothing on it, which is precisely the empty-plate case G2 renders.
   *
   * BREAK IT: give `.cov-field` a `repeating-linear-gradient` back, or drop
   * the empty-title guard. One limb each.
   */
  it("the cover's surviving ground is BOUNDED and content-guarded, not a screen", async () => {
    const styles = stylesOf(await readTemplate("cover.html"));
    const painting = [...styles.matchAll(/\.cov-field[^{}]*\{([^{}]*)\}/g)].filter(
      (r) => /background-image\s*:/.test(r[1]!) && !/background-image\s*:\s*none/.test(r[1]!),
    );
    expect(painting.length, "cover.html: nothing paints .cov-field at all — the cover has lost its only object").toBeGreaterThan(0);
    for (const rule of painting) {
      const body = rule[1]!;
      expect(body, `cover.html: .cov-field paints a REPEATING gradient — that is the screen RFC-20 §5.2 deleted, not the ramp §5.5 keeps`).not.toMatch(
        /repeating-(linear|radial|conic)-gradient/,
      );
      expect(body, "cover.html: .cov-field's paint has no `background-repeat: no-repeat` — an unbounded tile is a screen").toMatch(
        /background-repeat\s*:\s*no-repeat/,
      );
      // ── THE BOUND MOVED FROM THE PAINT TO THE BOX, AND IT IS STILL A BOUND. ──
      //
      // The rule used to be "`background-size` must declare a block-axis
      // LENGTH", because `.cov-field` was the elastic item and a `100%` there
      // meant "the leftover space" — an unbounded screen wearing a ramp's name.
      // Phase 5.5 swapped which item is elastic: on the no-photograph path the
      // field is `block-size: var(--cover-band, 600px)` and the LOCKUP grows, so
      // the band is sized by the composition and the paint fills exactly it.
      // That is a stronger bound, not a weaker one — the extent is now a
      // declared number on the element rather than a number on a paint that
      // could outlive the element's own height — so the scan asks for either.
      const paintBound = /background-size\s*:[^;]*\d+(px|%)\s+\d+px/.test(body);
      const boxBound = /body:not\(:has\(\.hero\)\) \.cov-field \{[^}]*block-size:\s*var\(--cover-band,\s*\d+px\)/.test(styles);
      expect(
        paintBound || boxBound,
        "cover.html: .cov-field's ramp is bounded by neither its own `background-size` nor a declared `block-size` on the no-photograph field — its extent is the leftover space rather than a fixed band",
      ).toBe(true);
    }
    expect(
      styles.replace(/\s+/g, " "),
      "cover.html: the empty-title guard on .cov-field is gone — the ramp now paints on a plate with no title, which is the empty-plate case G2 refuses",
    ).toContain("body:not(:has(#title > span:not(:empty))) .cov-field");
  });
});

describe("RFC-17 twin slots: BREAK IT — the guards refuse a broken template", () => {
  /**
   * Every case here takes the REAL shipped source, breaks a copy of the
   * string in memory, and requires `auditTwinSlots` to report it. A guard
   * nobody has watched refuse is not a guard.
   */
  it("removing the shared collapse rule is caught — the plain twin would render alongside the runs", async () => {
    const html = await readTemplate("cover.html");
    const broken = html.replace(".mk-runs:not(:empty) + .mk-plain { display: none; }", "");
    expect(broken, "the shared collapse rule is not in cover.html to remove").not.toBe(html);
    const problems = auditTwinSlots(broken, TWIN_SLOTS["cover.html"]!);
    expect(problems.join(" | ")).toMatch(/no shared twin collapse rule/);
    // And the pairs it serves are still perfectly well-formed in the markup,
    // which is exactly why the source scan has to look at both halves.
    expect(problems.join(" | ")).not.toMatch(/markup does not declare/);
  });

  /**
   * THE TYPO CASE, INVERTED.
   *
   * There used to be a case here for a misspelt HOST in a per-host collapse
   * rule (`.headlne:has(…)`), which left the real pair unruled and the rule
   * pointing at nothing. The shared rule names no host, so that typo cannot be
   * written any more — and the failure mode that replaces it is a per-host rule
   * coming BACK, which is the drift this consolidation removed. Two mechanisms
   * for one relationship is how the set drifted to begin with.
   */
  it("a per-host collapse rule coming back is caught as drift", async () => {
    const html = await readTemplate("cover.html");
    const broken = html.replace(
      ".mk-runs:not(:empty) + .mk-plain { display: none; }",
      `.mk-runs:not(:empty) + .mk-plain { display: none; }
.headline:has(.mk-runs:not(:empty)) .mk-plain { display: none; }`,
    );
    expect(broken).not.toBe(html);
    const problems = auditTwinSlots(broken, TWIN_SLOTS["cover.html"]!);
    expect(problems.join(" | ")).toMatch(/per-host collapse rule for \.headline/);
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

  it("a ground rule rewritten to ask `#id:empty` is caught — it would paint the ground on a slide that says nothing", async () => {
    // The inverse of finding 1, and the likelier of the two mistakes: nobody
    // deletes `.cov-field`, but plenty of people would "simplify"
    // `body:not(:has(#title > span:not(:empty)))` to `body:has(#title:empty)`
    // while touching this markup. Twin slots make `#title:empty` permanently
    // false, so the withholding rule stops firing and an empty cover renders
    // its full painted field — imagery share the plate has not earned.
    const html = await readTemplate("cover.html");
    const broken = html.replace("body:not(:has(#title > span:not(:empty))) .cov-field", "body:has(#title:empty) .cov-field");
    expect(broken).not.toBe(html);
    expect(auditTwinSlots(broken, TWIN_SLOTS["cover.html"]!).join(" | ")).toMatch(/#title is still asked `:empty` directly/);
  });

  it("moving the id off the twin host is caught — every ground rule naming it would select nothing", async () => {
    const html = await readTemplate("closer.html");
    const broken = html.replace('class="headline r-display" id="takeaway"', 'class="headline r-display"');
    expect(broken).not.toBe(html);
    expect(auditTwinSlots(broken, TWIN_SLOTS["closer.html"]!).join(" | ")).toMatch(/#takeaway is not on the \.headline element/);
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
/**
 * ── THE LADDER NO LONGER READS TEXT, SO IT CANNOT MISCOUNT IT. ──
 *
 * Every plate used to carry its own ladder that picked a size from
 * `textContent.length`, and the cases here unit-tested the helper each one
 * needed in order to count the copy ONCE: `textContent` reads a `display: none`
 * subtree, so a marked render counted its copy twice and a 30-character
 * headline scored 60 and took a step it did not need. A second helper stripped
 * the zero-width bidi controls an isolated Hebrew run carries, so that a step
 * did not depend on how the copy was marked.
 *
 * `_ds-fit.js` measures the LAID-OUT BOX instead. Geometry only sees the
 * visible twin, a zero-width character occupies no width by definition, and
 * there is no threshold table to keep in sync with eight files or with the
 * reviewer's type scale. The property those cases asserted is now structural,
 * so what is left to guard is that nobody reintroduces a text-counting ladder.
 */
describe("RFC-17 twin slots: the fit ladder measures geometry, not text", () => {
  it("reads no text from the plate at all", async () => {
    for (const file of Object.keys(TWIN_SLOTS)) {
      const script = scriptOf(await readTemplate(file));
      expect(script, `${file}'s ladder reads textContent — a hidden twin counts twice`).not.toMatch(/textContent/);
      expect(script, `${file}'s ladder reads innerText`).not.toMatch(/innerText/);
      expect(script, `${file}'s ladder measures string length`).not.toMatch(/\.length\s*[><]/);
    }
  });

  it("measures the field and the hosts, which is what a reader sees", async () => {
    for (const file of Object.keys(TWIN_SLOTS)) {
      const script = scriptOf(await readTemplate(file));
      expect(script, `${file}'s ladder never measures a laid-out box`).toMatch(/getBoundingClientRect|scrollHeight/);
    }
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
    // Added with the twin pair. Rendered WITHOUT `itemRows`: the rows panel is
    // a separate element behind its own `.me-rows:not(:empty)` guard, and what
    // is under test here is the head — the collapse rule firing and `mkLen`
    // reading the visible twin, neither of which has any pixel signature an
    // interest-floor clause would catch if it broke. A failed collapse prints
    // the headline twice and reads as legitimate type.
    "list-takeaway.html": { runs: "headlineRuns", plain: "headline", extra: { kicker: "FIELD NOTES" } },
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
          // The SELECTORS, not just the boolean: "something overflowed" on a
          // sweep of 36 renders is a fact nobody can act on, and the probe
          // already names up to six boxes.
          expect(markedProbe.overflow, `${file} ${dir} ${scale}: marked render overflows: ${markedProbe.overflowing.join(", ")}`).toBe(false);
          expect(plainProbe.overflow, `${file} ${dir} ${scale}: unmarked render overflows: ${plainProbe.overflowing.join(", ")}`).toBe(false);

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
          expect(probe.overflow, `${file} ${dir} ${scale}: a painted mark pushed the block out of its box: ${probe.overflowing.join(", ")}`).toBe(false);
        }, 60_000);
      }
    }
  }
});
