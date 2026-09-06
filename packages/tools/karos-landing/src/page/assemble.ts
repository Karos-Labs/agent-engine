import type { PageBlueprint, PageParts } from "./types.js";

/**
 * Turns the build step's `PageParts` into the one `index.html` that ships.
 *
 * The assembler, not the model, owns the document shell: `<html lang dir>`,
 * charset, viewport, `<title>`/description/Open Graph from the blueprint's
 * `meta`, the Google Fonts `<link>` for the blueprint's families, and the
 * `<style>`/`<script>` placement. Those are the parts a model gets subtly
 * wrong often enough (a missing viewport meta, a title left as a placeholder,
 * fonts named in CSS but never loaded) that generating them from the
 * blueprint is cheaper than checking them.
 *
 * Sections land in blueprint order. A section whose id the blueprint calls
 * `nav`/`header` renders before `<main>`, one called `footer` after it, and
 * everything else inside `<main>`, so the landmark structure is guaranteed
 * regardless of what the build wrote around its sections.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The Google Fonts CSS2 URL for the blueprint's families, weights chosen for display/body/mono roles. */
export function googleFontsHref(typography: PageBlueprint["typography"]): string {
  const families = new Map<string, string>();
  families.set(typography.display, "wght@400;500;600;700;800");
  if (!families.has(typography.body)) families.set(typography.body, "wght@400;500;600");
  if (typography.mono && !families.has(typography.mono)) families.set(typography.mono, "wght@400;500");
  const params = [...families.entries()].map(([family, axes]) => `family=${encodeURIComponent(family).replace(/%20/g, "+")}:${axes}`);
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

export interface AssembleOptions {
  /** Absolute URL the page will live at, for `<link rel=canonical>` and `og:url`. Omitted on a preview. */
  canonicalUrl?: string;
  /** An https:// image URL for `og:image`; the blueprint's logo when nothing better exists. */
  ogImageUrl?: string;
  faviconUrl?: string;
}

/** The only styling the shell owns: the skip link the assembler adds for keyboard users. Everything else is the build's. */
const SHELL_CSS = `.skip-link{position:absolute;left:-999px;top:0;padding:.5rem .75rem;background:#000;color:#fff;z-index:1000}.skip-link:focus{left:.5rem;top:.5rem}`;

const HEADER_IDS = new Set(["nav", "header", "site-nav", "site-header", "top"]);
const FOOTER_IDS = new Set(["footer", "site-footer"]);

export function assemblePage(blueprint: PageBlueprint, parts: PageParts, options: AssembleOptions = {}): string {
  const order = new Map(blueprint.sections.map((s, i) => [s.id, i] as const));
  const sections = [...parts.sections].sort((a, b) => (order.get(a.id) ?? 1_000) - (order.get(b.id) ?? 1_000));

  const header = sections.filter((s) => HEADER_IDS.has(s.id)).map((s) => s.html.trim());
  const footer = sections.filter((s) => FOOTER_IDS.has(s.id)).map((s) => s.html.trim());
  const main = sections.filter((s) => !HEADER_IDS.has(s.id) && !FOOTER_IDS.has(s.id)).map((s) => s.html.trim());

  const title = escapeHtml(blueprint.meta.title);
  const description = escapeHtml(blueprint.meta.description);
  const fonts = googleFontsHref(blueprint.typography);

  const headLines = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    ...(options.canonicalUrl ? [`<link rel="canonical" href="${escapeHtml(options.canonicalUrl)}">`, `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}">`] : []),
    ...(options.ogImageUrl ? [`<meta property="og:image" content="${escapeHtml(options.ogImageUrl)}">`] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    ...(options.faviconUrl ? [`<link rel="icon" href="${escapeHtml(options.faviconUrl)}">`] : []),
    `<meta name="theme-color" content="${blueprint.palette.ground}">`,
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="${fonts}">`,
    `<style>\n${SHELL_CSS}\n${parts.css.trim()}\n</style>`,
  ];

  const body = [
    `<a class="skip-link" href="#main">Skip to content</a>`,
    ...header,
    `<main id="main">`,
    ...main,
    `</main>`,
    ...footer,
    ...(parts.script.trim().length > 0 ? [`<script>\n${parts.script.trim()}\n</script>`] : []),
  ];

  return [
    `<!doctype html>`,
    `<html lang="${escapeHtml(blueprint.language)}" dir="${blueprint.direction}">`,
    `<head>`,
    ...headLines.map((l) => `  ${l}`),
    `</head>`,
    `<body>`,
    ...body.map((l) => `  ${l}`),
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
