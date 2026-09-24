/**
 * Finding a client's logo on the client's own website (2026-09-24, stage 9 of
 * the owner's reference-looks plan: brand fidelity).
 *
 * A slide carries the client's mark only when the brand kit has a `logoUrl`
 * that downloads. Many clients have none, or one that has rotted, and those
 * clients shipped with nothing but an `@handle` where every reference account
 * carries its mark. The owner's rule is that every upgrade reaches every
 * client automatically, so a missing mark is looked for where the client
 * publishes it: its own homepage.
 *
 * Pure: HTML in, an ORDERED list of candidate URLs out. The caller downloads
 * them through the same `downloadBrandLogoOutcome` a configured logo goes
 * through (size cap, content-type check, https only) and keeps the first that
 * passes. Order is trust, most explicit first:
 *
 *   1. JSON-LD `Organization` / `Brand` `logo`: the site's own structured
 *      statement of what its logo is.
 *   2. An `<img>` (or `<source>`) whose class, id, alt or file name says
 *      "logo" AND that sits in the page's `<header>`/`<nav>`, or names the
 *      brand. A "trusted by" strip of partner logos lives further down the
 *      page and names other companies, which is why a bare "logo" match
 *      anywhere is not enough.
 *   3. `<link rel="apple-touch-icon">`, largest first: a square rendering of
 *      the mark the site itself hands to phones.
 *   4. `<link rel="icon">` declared at 128px or larger.
 *
 * A favicon smaller than that is never offered: at badge size it reads as a
 * smudge, and no mark is better than a smudge.
 */

const MAX_CANDIDATES = 6;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return m === null ? undefined : (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

function absolute(url: string, pageUrl: string): string | undefined {
  try {
    const resolved = new URL(url.replace(/&amp;/gu, "&"), pageUrl);
    // A site root is a page, not a file: Geektime's JSON-LD names its own
    // homepage as its `logo`, which would only burn one of the download slots.
    if (resolved.pathname === "/" || resolved.pathname === "") return undefined;
    return resolved.protocol === "https:" ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The first URL of a `srcset`, or the widest one when widths are given. */
function fromSrcset(srcset: string): string | undefined {
  const parts = srcset
    .split(",")
    .map((p) => p.trim().split(/\s+/u))
    .filter((p) => p[0] !== undefined && p[0].length > 0);
  if (parts.length === 0) return undefined;
  const widest = [...parts].sort((a, b) => Number.parseInt(b[1] ?? "0", 10) - Number.parseInt(a[1] ?? "0", 10))[0];
  return widest?.[0];
}

function jsonLdLogos(html: string): string[] {
  const out: string[] = [];
  const blocks = html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const type = record["@type"];
    const types = (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string");
    if (types.some((t) => /^(Organization|Corporation|Brand|LocalBusiness|Store|OnlineStore|NewsMediaOrganization)$/u.test(t))) {
      const logo = record["logo"];
      if (typeof logo === "string") out.push(logo);
      else if (logo !== null && typeof logo === "object") {
        const url = (logo as Record<string, unknown>)["url"] ?? (logo as Record<string, unknown>)["contentUrl"];
        if (typeof url === "string") out.push(url);
      }
    }
    for (const value of Object.values(record)) if (value !== null && typeof value === "object") visit(value);
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block[1] ?? ""));
    } catch {
      // A malformed block is someone else's bug and says nothing about the logo.
    }
  }
  return out;
}

/** The part of the page a site's own mark lives in: its header and nav. */
function headerRegions(html: string): string[] {
  return [...html.matchAll(/<(header|nav)\b[\s\S]*?<\/\1>/giu)].map((m) => m[0]);
}

function logoImagesIn(fragment: string): string[] {
  const out: string[] = [];
  for (const m of fragment.matchAll(/<(img|source)\b[^>]*>/giu)) {
    const tag = m[0];
    const src = attr(tag, "src") ?? attr(tag, "data-src") ?? (attr(tag, "srcset") !== undefined ? fromSrcset(attr(tag, "srcset")!) : undefined);
    if (src === undefined || src.length === 0 || src.startsWith("data:")) continue;
    const said = [attr(tag, "class"), attr(tag, "id"), attr(tag, "alt"), src].filter((v) => v !== undefined).join(" ");
    if (/logo|brand-?mark|site-?mark/iu.test(said)) out.push(src);
  }
  return out;
}

function iconLinks(html: string): { touch: Array<{ href: string; size: number }>; icons: Array<{ href: string; size: number }> } {
  const touch: Array<{ href: string; size: number }> = [];
  const icons: Array<{ href: string; size: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (href === undefined || href.length === 0) continue;
    const size = Number.parseInt(/(\d+)x\d+/u.exec(attr(tag, "sizes") ?? "")?.[1] ?? "0", 10);
    // A vector icon (`sizes="any"`, or an .svg file) renders sharp at any size,
    // so it clears the 128px bar by construction: Karos Labs publishes its
    // mark only as `/icon.svg` (2026-09-24), beside a text wordmark.
    const vector = (attr(tag, "sizes") ?? "").toLowerCase() === "any" || /\.svg(?:[?#]|$)/iu.test(href) || (attr(tag, "type") ?? "").includes("svg");
    if (rel.includes("apple-touch-icon")) touch.push({ href, size: size || 180 });
    else if (/\bicon\b/u.test(rel)) icons.push({ href, size: vector ? 512 : size });
  }
  return { touch: touch.sort((a, b) => b.size - a.size), icons: icons.filter((i) => i.size >= 128).sort((a, b) => b.size - a.size) };
}

export function logoCandidatesFromHtml(html: string, pageUrl: string, brandName?: string): string[] {
  const brandWord = (brandName ?? "")
    .toLowerCase()
    .split(/[^a-z0-9֐-׿]+/u)
    .filter((w) => w.length >= 3)[0];
  const inHeader = headerRegions(html).flatMap(logoImagesIn);
  const namingBrand = brandWord === undefined ? [] : logoImagesIn(html).filter((src) => src.toLowerCase().includes(brandWord));
  const { touch, icons } = iconLinks(html);
  const ordered = [...jsonLdLogos(html), ...inHeader, ...namingBrand, ...touch.map((t) => t.href), ...icons.map((i) => i.href)];
  const out: string[] = [];
  for (const raw of ordered) {
    const url = absolute(raw, pageUrl);
    if (url !== undefined && !out.includes(url)) out.push(url);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** The homepage to read, from whatever the client record calls its site. `undefined` for anything not an http(s) URL or bare domain. */
export function homepageUrlFor(website: string | undefined): string | undefined {
  const raw = website?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/u.test(url.protocol) || !url.hostname.includes(".")) return undefined;
    url.protocol = "https:";
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}
