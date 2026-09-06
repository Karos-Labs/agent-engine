import { z } from "zod";
import { defineTool, success } from "@agent-engine/tool-common";
import { PageBlueprintSchema, type PageBlueprint } from "./types.js";

const TOOL_VERSION = "2.0.0";

/**
 * The deterministic floor for a built page (RFC-11 §5, the v2 successor of
 * ENGINE-SPEC §8's `gate.mjs`). Everything here is a string check over the
 * assembled `index.html`; nothing needs a browser (that is `landing.renderPage`)
 * and nothing is a judgment (that is the craft verdict). A `hard` violation
 * fails the page; a `warn` is carried to the reviewer.
 *
 * What it refuses, and why each one is here:
 * - structure: one `<h1>`, a `<main>`, a title/description, a viewport meta,
 *   every blueprint section present under its own id, in-page anchors that
 *   resolve. The kind of thing a model gets right 95% of the time, which is
 *   exactly the failure rate a published page cannot carry.
 * - token drift: every blueprint palette color appears in the CSS, and no
 *   pure `#000000`/`#ffffff` ground. The brand kit is law; drift here is
 *   the build quietly re-deciding the brand.
 * - font fidelity: the blueprint's families are named in the CSS. The
 *   assembler already links them; a CSS that never uses them ships the
 *   browser default.
 * - copy hygiene: no lorem/placeholder/template names, no banned phrases,
 *   the brand's glyph bans (em dash, exclamation) when the brand states them.
 * - numbers sourced: every figure in the visible copy appears either in the
 *   blueprint's `sourcedFacts[]` or in the source corpus (context docs, old
 *   site, brief). The intel-report agent already refuses invented numbers;
 *   a public landing page is the one place an invented "+40% ROI" does the
 *   most damage.
 * - resources: no external scripts or stylesheets other than Google Fonts,
 *   and every `<img src>` is either inline data, an asset the blueprint
 *   declared, or from an allowed host. A page that hotlinks a stranger's
 *   image is not the client's page.
 * - a11y basics: `alt` on every image, text or `aria-label` on every link
 *   and button.
 */

export interface PageViolation {
  severity: "hard" | "warn";
  check: string;
  message: string;
}

export interface CheckPageInputParams {
  html: string;
  blueprint: PageBlueprint;
  /** Source texts the copy may draw figures from: context docs, the captured old site's text, the brief, brand guidelines. */
  corpus: readonly string[];
  /** Hostnames (or their parent domains) images may be served from, beyond the blueprint's own assets. */
  allowedImageHosts?: readonly string[];
  lint?: { forbidEmDash?: boolean | undefined; forbidEnDash?: boolean | undefined; forbidExclamation?: boolean | undefined };
  maxBytes?: number;
}

export interface PageCheckReport {
  pass: boolean;
  hard: PageViolation[];
  warnings: PageViolation[];
  /** Numbers that were checked and found in the corpus, for the reviewer's confidence. */
  numbersSeen: string[];
}

const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /lorem ipsum/i, label: "lorem ipsum" },
  { re: /\bjohn doe\b|\bjane doe\b/i, label: "John/Jane Doe" },
  { re: /\bacme\b/i, label: "Acme" },
  { re: /\{\{[^}]*\}\}/, label: "unresolved {{template}} tag" },
  { re: /\[(insert|todo|tbd|placeholder)[^\]]*\]/i, label: "[INSERT/TODO] marker" },
  { re: /\bTODO\b|\bTBD\b|\bFIXME\b/, label: "TODO/TBD marker" },
  { re: /your (company|brand) name here/i, label: "'your company name here'" },
  { re: /placeholder\.(com|png|jpg)|via\.placeholder|picsum\.photos|unsplash\.com\/random/i, label: "placeholder image service" },
];

const SLOP_WORDS = /\b(elevate|seamless(?:ly)?|unleash|unlock the power|game-?changing|revolutioni[sz]e|supercharge|next-level|cutting-edge|synerg(?:y|ies))\b/gi;

export function stripToVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A figure is a token like `100M+`, `$50M`, `24/7`, `10+`, `2,000`, `35%`,
 * `4.9`. Years (19xx/20xx), single digits and two-digit step indices (`01`)
 * are ignored: a `© 2026` line and a numbered how-it-works are not claims.
 */
const FIGURE_RE = /(?:^|[^\w.])([$€£₪]?\d[\d,.]*(?:\s?[%+]|\s?[kKmMbB]\+?|\s?\/\s?\d+|\s?x)?)(?=$|[^\w])/g;

function normalizeFigure(raw: string): string {
  return raw.replace(/[\s,]/g, "").replace(/\.$/, "").toLowerCase();
}

function isIgnorableFigure(normalized: string): boolean {
  const digits = normalized.replace(/[^0-9]/g, "");
  if (/^(19|20)\d{2}$/.test(digits) && digits === normalized) return true; // a bare year
  if (digits.length <= 1 && !/[%$€£₪kmb+]/.test(normalized)) return true; // "3 moves", "one of 3"
  if (/^0\d$/.test(normalized)) return true; // step index 01/02
  return false;
}

export function extractFigures(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(FIGURE_RE)) {
    const norm = normalizeFigure(match[1]!);
    if (norm.length === 0 || isIgnorableFigure(norm)) continue;
    out.add(norm);
  }
  return [...out];
}

/** A figure counts as sourced when its digits+suffix appear in the corpus, tolerating spacing/commas (`100M+` vs `100 M+`, `2000` vs `2,000`). */
export function figureIsSourced(figure: string, corpusNormalized: string): boolean {
  if (corpusNormalized.includes(figure)) return true;
  // `$50m` in copy vs `+$50M in sales` or `50M+` in a source: compare the numeric core with any of the seen suffixes.
  const core = figure.replace(/^[$€£₪]/, "").replace(/[%+x]$/, "");
  if (core.length === 0) return false;
  return new RegExp(`(?<![0-9.])${core.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![0-9])`).test(corpusNormalized);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

export function checkPage(params: CheckPageInputParams): PageCheckReport {
  const { html, blueprint } = params;
  const hard: PageViolation[] = [];
  const warnings: PageViolation[] = [];
  const push = (severity: "hard" | "warn", check: string, message: string) => (severity === "hard" ? hard : warnings).push({ severity, check, message });

  const maxBytes = params.maxBytes ?? 600_000;
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) push("hard", "size", `index.html is ${bytes} bytes; the ceiling is ${maxBytes}`);

  // ── structure ──
  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count !== 1) push("hard", "structure", `expected exactly one <h1>, found ${h1Count}`);
  if (!/<main\b/i.test(html)) push("hard", "structure", "no <main> landmark");
  if (!/<title>[^<]{3,}<\/title>/i.test(html)) push("hard", "structure", "missing or empty <title>");
  if (!/<meta\s+name="description"\s+content="[^"]{10,}"/i.test(html)) push("hard", "structure", "missing meta description");
  if (!/<meta\s+name="viewport"/i.test(html)) push("hard", "structure", "missing viewport meta");
  if (!/<html[^>]*\slang="[^"]+"/i.test(html)) push("hard", "structure", "<html> has no lang attribute");

  const ids = new Set<string>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]!);
  for (const section of blueprint.sections) {
    if (!ids.has(section.id)) push("hard", "structure", `blueprint section "${section.id}" (${section.kind}) is not on the page`);
  }
  for (const m of html.matchAll(/href="#([^"]+)"/g)) {
    const target = m[1]!;
    if (target !== "main" && !ids.has(target)) push("hard", "links", `anchor "#${target}" points at no element on the page`);
  }
  if (!html.includes(`href="${blueprint.primaryCta.href}"`)) push("hard", "links", `the primary CTA href "${blueprint.primaryCta.href}" appears nowhere on the page`);

  // ── token drift ──
  const cssBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join("\n");
  const cssLower = cssBlocks.toLowerCase();
  for (const [role, hex] of Object.entries(blueprint.palette)) {
    if (typeof hex !== "string") continue;
    if (!cssLower.includes(hex.toLowerCase())) push("hard", "token-drift", `palette.${role} ${hex} does not appear in the page CSS`);
  }
  if (/#000000\b|#000\b/.test(cssLower) && /background(?:-color)?\s*:\s*#000(?:000)?\b/.test(cssLower)) push("warn", "token-drift", "a pure #000 background: use the brand's off-black instead");

  // ── font fidelity ──
  for (const [role, family] of Object.entries(blueprint.typography)) {
    if (typeof family !== "string") continue;
    if (!cssLower.includes(family.toLowerCase())) push("hard", "font-fidelity", `typography.${role} "${family}" is never used in the page CSS`);
  }

  // ── copy hygiene ──
  const text = stripToVisibleText(html);
  const textLower = text.toLowerCase();
  for (const { re, label } of PLACEHOLDER_PATTERNS) {
    if (re.test(text) || (label.includes("image") && re.test(html))) push("hard", "placeholder", `placeholder content on the page: ${label}`);
  }
  for (const phrase of blueprint.bannedPhrases) {
    if (phrase.trim().length > 0 && textLower.includes(phrase.trim().toLowerCase())) push("hard", "banned-phrase", `banned phrase "${phrase}" appears in the copy`);
  }
  const slop = [...new Set([...text.matchAll(SLOP_WORDS)].map((m) => m[0].toLowerCase()))];
  if (slop.length > 0) push("warn", "copy", `marketing filler words: ${slop.join(", ")}`);
  if (params.lint?.forbidEmDash && /—/.test(text)) push("hard", "brand-lint", "the brand forbids em dashes and the copy contains one");
  if (params.lint?.forbidEnDash && /–/.test(text)) push("hard", "brand-lint", "the brand forbids en dashes and the copy contains one");
  if (params.lint?.forbidExclamation && /!/.test(text)) push("hard", "brand-lint", "the brand forbids exclamation marks and the copy contains one");

  // ── numbers sourced ──
  const corpusNormalized = [...params.corpus, ...blueprint.sourcedFacts].join("\n").replace(/[\s,]/g, "").toLowerCase();
  const figures = extractFigures(text);
  const numbersSeen: string[] = [];
  for (const figure of figures) {
    if (figureIsSourced(figure, corpusNormalized)) numbersSeen.push(figure);
    else push("hard", "numbers-sourced", `"${figure}" appears in the copy but in no source and not in sourcedFacts[]`);
  }

  // ── resources ──
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)) push("hard", "resources", `external script "${m[1]}": the page must be self-contained`);
  for (const m of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)) {
    const host = hostOf(m[1]!);
    if (host !== "fonts.googleapis.com") push("hard", "resources", `external stylesheet "${m[1]}": only Google Fonts may be linked`);
  }
  if (/@import\s/.test(cssBlocks)) push("hard", "resources", "CSS @import is not allowed; fonts are linked by the assembler");
  const declaredAssets = new Set(blueprint.assets.map((a) => a.url));
  const allowedHosts = params.allowedImageHosts ?? [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    const src = /\ssrc="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    if (!/\salt="/i.test(attrs)) push("hard", "a11y", `<img src="${src.slice(0, 80)}"> has no alt attribute`);
    if (src.startsWith("data:") || src.length === 0) continue;
    if (declaredAssets.has(src)) continue;
    const host = hostOf(src);
    if (!host || !hostAllowed(host, allowedHosts)) push("hard", "resources", `<img src="${src.slice(0, 120)}"> is neither a declared asset nor from an allowed host`);
  }
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const inner = stripToVisibleText(m[3]!);
    const hasLabel = /aria-label="[^"]+"/i.test(m[2]!) || /aria-labelledby="/i.test(m[2]!);
    if (inner.length === 0 && !hasLabel && !/<(img|svg)\b[^>]*\b(alt|aria-label)="[^"]+"/i.test(m[3]!)) push("hard", "a11y", `an empty <${m[1]}> with no aria-label`);
  }

  return { pass: hard.length === 0, hard, warnings, numbersSeen };
}

export const CheckPageInputSchema = z.object({
  html: z.string().min(1).describe("The assembled index.html."),
  blueprint: PageBlueprintSchema.describe("The PageBlueprint the page was built from: its sections, palette, typography, assets, sourcedFacts and bannedPhrases are what the checks hold the HTML to."),
  corpus: z.array(z.string()).default([]).describe("Source texts the copy may draw figures from."),
  allowedImageHosts: z.array(z.string()).default([]).describe("Hostnames (or parent domains) images may be served from, beyond the blueprint's declared assets."),
  lint: z
    .object({ forbidEmDash: z.boolean().optional(), forbidEnDash: z.boolean().optional(), forbidExclamation: z.boolean().optional() })
    .optional()
    .describe("The brand's glyph bans, from the hand-curated brand contract's typography block."),
});
export type CheckPageInput = z.infer<typeof CheckPageInputSchema>;

export function createCheckPage() {
  return defineTool<CheckPageInput, PageCheckReport>({
    name: "landing.checkPage",
    description:
      "The deterministic floor for a built landing page: structure (one h1, main, title, meta, every blueprint section present, anchors resolve), brand token drift, font fidelity, placeholder/banned-phrase/glyph lint, every number sourced, self-contained resources, and a11y basics. content_fail on any hard violation.",
    version: TOOL_VERSION,
    inputSchema: CheckPageInputSchema,
    async execute(input) {
      const report = checkPage({
        html: input.html,
        blueprint: input.blueprint,
        corpus: input.corpus,
        allowedImageHosts: input.allowedImageHosts,
        ...(input.lint ? { lint: input.lint } : {}),
      });
      // Always `success`: the report IS the result, `pass: false` included.
      // The workflow decides what a failed floor means (one fix pass, then
      // needs_human); a `content_fail` here would throw the violation list
      // away just when the fix step needs it.
      return success(report);
    },
  });
}
