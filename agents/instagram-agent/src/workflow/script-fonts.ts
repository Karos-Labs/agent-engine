import { FALLBACK_STACKS, FONT_FAMILY, GOOGLE_FONTS_CSS2 } from "./brand-render-tokens.js";
import { resolveExpectedScript } from "./language-gate.js";

/**
 * Fonts by SCRIPT, driven by the run's target language — not by what the
 * client happened to declare in `client/brand.json`.
 *
 * The defect this closes (instagram audit 2026-09-08, finding 5): every
 * bundled template hardcodes Google Fonts `Fraunces | Inter | IBM Plex Mono`,
 * and `brand-render-tokens.ts` only ever ADDS the families a client declared.
 * Neither of those has a single Hebrew glyph, so a Hebrew client (`geektime`)
 * rendered every slide in whatever Chromium's per-glyph fallback found on the
 * render sandbox — a system sans with none of the template's weights, at a
 * Latin type scale that reads too large and too tight for Hebrew letterforms.
 *
 * Design rules:
 *
 * - KIT-INDEPENDENT. This module never touches `deriveBrandRenderTokens` or
 *   `buildBrandHeadHtml`; it produces its OWN head fragment from the target
 *   language alone, so a brandless Hebrew client (an empty brand.json, where
 *   the workflow's `brandFragments()` returns nothing at all today) still gets
 *   a Hebrew face. The workflow composes `[scriptHead, brandHead]`.
 *
 * - LATIN IS A NO-OP. `scriptTypographyFor` returns `undefined` for Latin
 *   scripts, unknown languages and no language, and the caller emits nothing
 *   — every English client's rendered document stays byte-identical to today.
 *
 * - COMPOSES WITH THE TEMPLATES, NEVER FIGHTS THEM. The templates size type as
 *   `calc(Npx * var(--ts, 1))` with `--ts` set by their own `:root{--ts:1}`
 *   and `body.ts-s / body.ts-l` rules (the reviewer's per-slide `fontScale`).
 *   The per-script scale is emitted on the SAME selectors, multiplied in, so a
 *   reviewer's "smaller" still means smaller. Font-stack vars are set on
 *   `body` rather than `:root`: a value declared on the element itself beats
 *   any inherited `:root` value regardless of sheet order, so the kit's own
 *   `:root { --f-display: … }` sheet (`buildBrandHeadHtml`) cannot undo the
 *   script stack whichever fragment `composeRawDocument` splices first.
 *
 * - STACK ORDER. Client family first, script family second, template fallback
 *   last when the client declared a family for that role (`'Fraunces',
 *   'Heebo', 'Rubik', Georgia, …`): Chromium falls back per glyph, so Latin
 *   loanwords and digits keep the brand face while Hebrew glyphs get Heebo
 *   instead of the system fallback. Script family FIRST when the client
 *   declared nothing for the role: a headline that is mostly Hebrew with a
 *   few digits should share one face's metrics rather than mix the template's
 *   Latin serif with Heebo.
 *
 * Model/cost: none. Gate: none.
 */

/** One script's typography: which Google Fonts families carry it, and how the Latin-tuned templates must be rescaled for it. */
export interface ScriptTypography {
  /** Display/headline families, first preferred. */
  readonly display: readonly string[];
  /** Body families, first preferred. */
  readonly body: readonly string[];
  /** Mono/eyebrow families, first preferred. True monospace faces are rare outside Latin; a clean sans stands in. */
  readonly mono: readonly string[];
  /** Multiplies the templates' `--ts`. `1` means the Latin scale already fits and no scale rule is emitted. */
  readonly typeScale: number;
  /** Line heights for the display and body roles — taller scripts (Arabic, Thai, Devanagari) need more leading than the templates' Latin defaults. */
  readonly lineHeight: { readonly display: number; readonly body: number };
}

/**
 * Keyed by `ExpectedScript.name` from `language-gate.ts`'s `SCRIPT_TABLE` —
 * every non-Latin script that table knows has an entry here, so a language
 * the gate can check is a language the renderer can set. Families are
 * Google Fonts names known to exist (this list is curated, not client-typed,
 * which is why ONE css2 request can carry all of them — see
 * `buildScriptFontHeadHtml`). Scales and leadings are conservative: Hebrew's
 * x-height-heavy letterforms read ~6% larger than Latin at the same size;
 * Arabic and the Indic/Thai scripts carry marks above and below the line and
 * need room for them.
 */
export const SCRIPT_TYPOGRAPHY: Readonly<Record<string, ScriptTypography>> = {
  Hebrew: { display: ["Heebo", "Rubik"], body: ["Assistant", "Heebo"], mono: ["Rubik"], typeScale: 0.94, lineHeight: { display: 1.12, body: 1.6 } },
  Arabic: {
    display: ["Noto Sans Arabic", "Cairo"],
    body: ["Noto Sans Arabic"],
    mono: ["Noto Sans Arabic"],
    typeScale: 0.92,
    lineHeight: { display: 1.25, body: 1.75 },
  },
  Greek: { display: ["Noto Serif"], body: ["Noto Sans"], mono: ["IBM Plex Mono"], typeScale: 1, lineHeight: { display: 1.05, body: 1.55 } },
  Cyrillic: { display: ["Playfair Display"], body: ["Inter"], mono: ["IBM Plex Mono"], typeScale: 1, lineHeight: { display: 1.05, body: 1.55 } },
  Devanagari: {
    display: ["Noto Sans Devanagari"],
    body: ["Noto Sans Devanagari"],
    mono: ["Noto Sans Devanagari"],
    typeScale: 0.9,
    lineHeight: { display: 1.3, body: 1.7 },
  },
  Thai: { display: ["Noto Sans Thai"], body: ["Noto Sans Thai"], mono: ["Noto Sans Thai"], typeScale: 0.9, lineHeight: { display: 1.35, body: 1.8 } },
  Armenian: {
    display: ["Noto Sans Armenian"],
    body: ["Noto Sans Armenian"],
    mono: ["Noto Sans Armenian"],
    typeScale: 0.95,
    lineHeight: { display: 1.15, body: 1.6 },
  },
  Georgian: {
    display: ["Noto Sans Georgian"],
    body: ["Noto Sans Georgian"],
    mono: ["Noto Sans Georgian"],
    typeScale: 0.95,
    lineHeight: { display: 1.15, body: 1.6 },
  },
  Japanese: { display: ["Noto Sans JP"], body: ["Noto Sans JP"], mono: ["Noto Sans JP"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
  Korean: { display: ["Noto Sans KR"], body: ["Noto Sans KR"], mono: ["Noto Sans KR"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
  Chinese: { display: ["Noto Sans SC"], body: ["Noto Sans SC"], mono: ["Noto Sans SC"], typeScale: 0.88, lineHeight: { display: 1.3, body: 1.8 } },
};

/**
 * The script typography a target language calls for, or `undefined` when
 * the renderer has nothing to add: Latin-script languages (the templates'
 * own faces already carry them), a language `SCRIPT_TABLE` has never heard
 * of (the gate has no opinion, and neither does this), and no language at
 * all. Accepts every spelling `client.getBrand().language` legitimately
 * produces — "Hebrew", "he", "he-IL" — via `resolveExpectedScript`, so the
 * gate and the renderer can never disagree about which script a language is.
 */
export function scriptTypographyFor(targetLanguage: string | undefined): { script: string; spec: ScriptTypography } | undefined {
  if (targetLanguage === undefined) return undefined;
  const script = resolveExpectedScript(targetLanguage);
  if (script === undefined || script.name === "Latin") return undefined;
  const spec = SCRIPT_TYPOGRAPHY[script.name];
  return spec === undefined ? undefined : { script: script.name, spec };
}

/** The family a client declared per role, if any — read back out of the kit's already-emitted `--f-*` stacks. */
export interface ClientFontFamilies {
  display?: string | undefined;
  body?: string | undefined;
  mono?: string | undefined;
}

/**
 * The FIRST family of a `--f-*` stack `deriveBrandRenderTokens` emitted
 * (`'Fraunces', Georgia, 'Times New Roman', serif` → `Fraunces`). Only a
 * quoted leading family counts — that is the one shape the kit writes for a
 * client-declared face, and the templates' own unquoted generic fallbacks
 * must never be mistaken for a declaration. Re-validated against
 * `FONT_FAMILY` before it is ever re-quoted into this module's sheet.
 */
function leadingFamily(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const match = /^\s*'([^']+)'/.exec(stack);
  const family = match?.[1]?.trim();
  return family !== undefined && FONT_FAMILY.test(family) ? family : undefined;
}

/** `ClientFontFamilies` from a kit's `cssVars` (`BrandRenderTokens.cssVars`); `{}` for no kit. */
export function clientFamiliesFromCssVars(cssVars: Readonly<Record<string, string>> | undefined): ClientFontFamilies {
  const display = leadingFamily(cssVars?.["--f-display"]);
  const body = leadingFamily(cssVars?.["--f-body"]);
  const mono = leadingFamily(cssVars?.["--f-mono"]);
  return {
    ...(display !== undefined ? { display } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(mono !== undefined ? { mono } : {}),
  };
}

/**
 * Display-role selectors across every bundled template (`slide.html`,
 * `headline-focus.html`, `quote-card.html`, `comparison-card.html`,
 * `list-takeaway.html`, `stat-callout.html`) plus the role names the RFC uses
 * generically (`.figure`, `.item-title`), which are inert where no such class
 * exists. `.num-figure` (the 300px stat digit) is deliberately NOT here: digits
 * are script-neutral and its `line-height: 0.95` lockup with the stat band is
 * a designed relationship, not Latin leading.
 */
const DISPLAY_SELECTORS = [".headline", ".hf-headline", ".quote-text", ".cmp-head", ".cmp-label", ".me-head", ".me-title", ".num-label", ".figure", ".item-title"];

/** Body-role selectors, same coverage rule as `DISPLAY_SELECTORS`. Eyebrows/kickers are short labels but sit on the body leading so a two-line Hebrew kicker does not collide with the headline. */
const BODY_SELECTORS = [".body-text", ".body", ".num-body", ".source-line", ".sub-label", ".quote-attr", ".cmp-body", ".cmp-foot-text", ".me-note", ".item-note", ".kicker", ".eyebrow"];

/** `'Heebo', 'Rubik'` — each family quoted, deduped case-insensitively, in the given order. */
function quoteFamilies(families: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const family of families) {
    const key = family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`'${family}'`);
  }
  return out;
}

/**
 * One role's full stack under the ordering rule in the module header: the
 * client's own face first when declared (per-glyph fallback keeps the brand
 * face for Latin loanwords), the script families next, the templates' own
 * generic fallback last. A client family that fails `FONT_FAMILY` is dropped,
 * never repaired — the same refuse-to-guess rule `deriveBrandRenderTokens`
 * applies to the same value.
 */
function stackFor(clientFamily: string | undefined, scriptFamilies: readonly string[], fallback: string): string {
  const client = clientFamily !== undefined && FONT_FAMILY.test(clientFamily) ? [clientFamily] : [];
  return [...quoteFamilies([...client, ...scriptFamilies]), fallback].join(", ");
}

/**
 * The head fragment for one script: ONE css2 `<link>` carrying every script
 * family, then a `<style>` with the three font-stack vars, the type-scale
 * rules and the line-height rules. Pure — a string function of its inputs.
 *
 * One link for all families, unlike `buildBrandHeadHtml`'s one-per-family:
 * css2 does fail a whole batch when any family in it is unknown, but that
 * guard exists for CLIENT-TYPED names. Every family here comes from the
 * curated `SCRIPT_TYPOGRAPHY` table and is known to exist, so batching is
 * safe and saves a round trip per family in the render sandbox. Bare family
 * names, no weight axes, for the same reason `buildBrandHeadHtml` gives: an
 * axis a family lacks 400s the request, and Chromium's synthesized bold is
 * far better than no face at all.
 *
 * The type-scale rules use exactly the templates' own selectors (`body`,
 * `body.ts-s`, `body.ts-l`) so the reviewer's `fontScale` still composes:
 * `body.ts-s { --ts: calc(0.85 * 0.94) }` is "smaller, in Hebrew". They win
 * because `composeRawDocument` splices this fragment before `</head>` —
 * after the template's own `<style>` — and equal specificity resolves to the
 * later rule. A `typeScale` of exactly 1 emits no scale rule at all: the
 * Latin scale already fits and the rule would only be noise.
 */
export function buildScriptFontHeadHtml(script: string, spec: ScriptTypography, clientFamilies: ClientFontFamilies): string {
  const families = [...new Set([...spec.display, ...spec.body, ...spec.mono])];
  const query = families.map((family) => `family=${family.replace(/ /g, "+")}`).join("&");
  const link = `<link href="${GOOGLE_FONTS_CSS2}?${query}&display=swap" rel="stylesheet">`;

  const css: string[] = [`/* script typography: ${script} */`];
  css.push(
    [
      "body {",
      `  --f-display: ${stackFor(clientFamilies.display, spec.display, FALLBACK_STACKS.display)};`,
      `  --f-body: ${stackFor(clientFamilies.body, spec.body, FALLBACK_STACKS.body)};`,
      `  --f-mono: ${stackFor(clientFamilies.mono, spec.mono, FALLBACK_STACKS.mono)};`,
      "}",
    ].join("\n"),
  );
  if (spec.typeScale !== 1) {
    const s = String(spec.typeScale);
    css.push(`body { --ts: ${s} }`, `body.ts-s { --ts: calc(0.85 * ${s}) }`, `body.ts-l { --ts: calc(1.18 * ${s}) }`);
  }
  // The leading AND the descender allowance, emitted together, because the
  // second is a consequence of the first.
  //
  // A display face's glyph box is taller than a sub-1.15 line box, so a block
  // set at this leading reports `scrollHeight > clientHeight` — which the
  // renderer's DOM probe calls an overflowing element, and clause B of the
  // interest floor fails a slide on `probe.overflow` alone, on a slide whose
  // type fits perfectly. The bundled templates each carry their own
  // `padding-block-end` for the Latin case, and that is the right place for
  // it there: it is a property of the template's own leading.
  //
  // It is the WRONG place for it here, and shipping it that way is what this
  // line fixes. The per-template constants were picked against Latin leadings
  // of 1.2-1.3; this rule overrides all of them to 1.12 for Hebrew, at which
  // point the allowance each template happened to choose is either enough or
  // not. Measured in real Chromium, Heebo at 1.12 needs ~0.177em
  // (padding-block-end 0 -> scrollHeight-clientHeight 11px at 62px type;
  // 0.12em -> 3px; 0.32em -> 0), and five of the ten display selectors shipped
  // between 0.10em and 0.14em: `list_takeaway`, `quote_card`,
  // `comparison_card` and the base `slide.html` reported `probe.overflow` on
  // EVERY Hebrew render, at every copy length, which put a false `clipped`
  // finding on the slide and told the writer to shorten a headline that fit.
  //
  // 0.22em rather than 0.18em: it is what the two templates that always passed
  // (`cover.html`'s `.headline`, `headline-focus.html`'s `.hf-headline`)
  // already use, and it leaves room for a script whose descenders are deeper
  // than Hebrew's. It is emitted with the leading it answers to, so a future
  // script added to `SCRIPT_TYPOGRAPHY` cannot get one without the other.
  css.push(`${DISPLAY_SELECTORS.join(", ")} { line-height: ${spec.lineHeight.display}; padding-block-end: 0.22em; }`);
  css.push(`${BODY_SELECTORS.join(", ")} { line-height: ${spec.lineHeight.body}; }`);

  return `${link}\n<style>\n${css.join("\n")}\n</style>`;
}

/**
 * The one call the workflow's `brandFragments()` makes: the script fragment
 * for this run's `targetLanguage` (02d) against the effective kit's font vars,
 * or `undefined` when the language needs nothing (Latin / unknown / none).
 * `kitCssVars` is `effectiveKit?.cssVars` — passing `undefined` for a
 * brandless client is the intended shape, not an error, and yields the
 * script-first stacks.
 */
export function buildScriptFontHeadForLanguage(targetLanguage: string | undefined, kitCssVars: Readonly<Record<string, string>> | undefined): string | undefined {
  const typography = scriptTypographyFor(targetLanguage);
  if (typography === undefined) return undefined;
  return buildScriptFontHeadHtml(typography.script, typography.spec, clientFamiliesFromCssVars(kitCssVars));
}
