import { z } from "zod";
import { defineTool, success, contentFail, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { SiteCapture } from "../page/types.js";

const TOOL_VERSION = "1.0.0";

export const CaptureSiteInputSchema = z.object({
  url: z.string().url().describe("The client's current site (https://...). Rendered in a headless browser; falls back to a plain fetch when the browser cannot load it."),
  runId: z.string().min(1).describe("This run's id; screenshots land under landing/<clientSlug>/<runId>/ in the artifact store."),
  clientSlug: z.string().min(1).describe("Which client the capture belongs to (the artifact path segment)."),
  timeoutMs: z.number().int().positive().max(90_000).default(45_000).describe("Per-attempt navigation/fetch ceiling in milliseconds."),
});
export type CaptureSiteInput = z.infer<typeof CaptureSiteInputSchema>;

export interface CaptureSiteDeps {
  /** Screenshots upload here when present (`landing/<slug>/<runId>/old-site-<label>.png`). */
  artifactStore?: GcsArtifactStoreLike;
  fetchImpl?: typeof fetch;
  /** Test seam: `null` forces the fetch-only path. */
  loadChromium?: () => Promise<typeof import("playwright").chromium | null>;
}

const MAX_TEXT_BLOCKS = 80;
const MAX_IMAGES = 40;

/* ─────────── the in-page extractor (runs inside Chromium; no closures over Node state) ─────────── */

declare const document: {
  title: string;
  documentElement: { lang: string };
  querySelector(sel: string): { getAttribute(name: string): string | null } | null;
  querySelectorAll(sel: string): ArrayLike<any>;
  body: any;
};
declare function getComputedStyle(el: unknown): { color: string; backgroundColor: string; fontFamily: string; display: string; visibility: string };

interface ExtractedPage {
  title: string;
  description: string | undefined;
  lang: string | undefined;
  headings: Array<{ level: number; text: string }>;
  navLinks: Array<{ text: string; href: string }>;
  ctas: string[];
  textBlocks: string[];
  images: Array<{ src: string; alt: string; width?: number; height?: number }>;
  colors: string[];
  fonts: string[];
  embeds: string[];
}

function extractInPage(): ExtractedPage {
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const meta = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;

  const headings: Array<{ level: number; text: string }> = [];
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3"))) {
    const text = clean(el.textContent);
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 200) });
  }

  const navLinks: Array<{ text: string; href: string }> = [];
  for (const el of Array.from(document.querySelectorAll("nav a[href], header a[href]"))) {
    const text = clean(el.textContent);
    if (text && navLinks.length < 30) navLinks.push({ text: text.slice(0, 60), href: el.href ?? el.getAttribute("href") ?? "" });
  }

  const ctas = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("a,button"))) {
    const text = clean(el.textContent);
    const cls = String(el.className ?? "").toLowerCase();
    const role = String(el.getAttribute("role") ?? "");
    if (text && text.length <= 40 && (el.tagName === "BUTTON" || cls.includes("btn") || cls.includes("button") || cls.includes("cta") || role === "button")) ctas.add(text);
  }

  const textBlocks: string[] = [];
  for (const el of Array.from(document.querySelectorAll("p,li,blockquote,figcaption,dt,dd,h4,h5,h6"))) {
    const text = clean(el.textContent);
    if (text.length >= 20 && text.length <= 600) textBlocks.push(text);
  }

  const images: Array<{ src: string; alt: string; width?: number; height?: number }> = [];
  for (const el of Array.from(document.querySelectorAll("img[src]"))) {
    const src: string = el.currentSrc || el.src;
    if (!src || src.startsWith("data:")) continue;
    images.push({ src, alt: clean(el.getAttribute("alt")), width: el.naturalWidth || undefined, height: el.naturalHeight || undefined });
  }

  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();
  let sampled = 0;
  for (const el of Array.from(document.querySelectorAll("body, body *"))) {
    if (sampled++ > 1500) break;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    for (const c of [cs.color, cs.backgroundColor]) {
      if (!c || c === "rgba(0, 0, 0, 0)" || c === "transparent") continue;
      colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
    }
    const family = cs.fontFamily.split(",")[0]?.replace(/["']/g, "").trim();
    if (family) fontCounts.set(family, (fontCounts.get(family) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);

  const embeds = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("iframe[src], script[src]"))) {
    try {
      const host = new URL(el.src).hostname;
      if (host && host !== location.hostname && !/google|gstatic|cloudflare|jsdelivr|unpkg|vercel|nextjs|gtm|analytics|facebook\.net|hotjar|clarity/i.test(host)) embeds.add(host);
    } catch {
      /* relative or malformed src: not an embed */
    }
  }

  return {
    title: clean(document.title),
    description: meta ? clean(meta) : undefined,
    lang: document.documentElement.lang || undefined,
    headings,
    navLinks,
    ctas: [...ctas].slice(0, 20),
    textBlocks,
    images,
    colors: top(colorCounts, 12),
    fonts: top(fontCounts, 6),
    embeds: [...embeds],
  };
}
declare const location: { hostname: string };

/* ─────────── fetch-only fallback ─────────── */

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFromHtml(html: string, base: string): ExtractedPage {
  const abs = (href: string): string => {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  };
  const headings: Array<{ level: number; text: string }> = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(m[2]!);
    if (text) headings.push({ level: Number(m[1]), text: text.slice(0, 200) });
  }
  const navBlock = /<(?:nav|header)\b[\s\S]*?<\/(?:nav|header)>/i.exec(html)?.[0] ?? "";
  const navLinks: Array<{ text: string; href: string }> = [];
  for (const m of navBlock.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]!);
    if (text) navLinks.push({ text: text.slice(0, 60), href: abs(m[1]!) });
  }
  const textBlocks: string[] = [];
  for (const m of html.matchAll(/<(p|li|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2]!);
    if (text.length >= 20 && text.length <= 600) textBlocks.push(text);
  }
  const images: Array<{ src: string; alt: string }> = [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const src = /\ssrc="([^"]+)"/i.exec(m[1]!)?.[1];
    if (!src || src.startsWith("data:")) continue;
    images.push({ src: abs(src), alt: stripTags(/\salt="([^"]*)"/i.exec(m[1]!)?.[1] ?? "") });
  }
  const ctas = new Set<string>();
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[3]!);
    if (text && text.length <= 40 && (m[1]!.toLowerCase() === "button" || /class="[^"]*(btn|button|cta)/i.test(m[2]!))) ctas.add(text);
  }
  return {
    title: stripTags(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""),
    description: /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1],
    lang: /<html[^>]*\slang="([^"]+)"/i.exec(html)?.[1],
    headings,
    navLinks,
    ctas: [...ctas].slice(0, 20),
    textBlocks,
    images,
    colors: [],
    fonts: [],
    embeds: [],
  };
}

async function defaultLoadChromium(): Promise<typeof import("playwright").chromium | null> {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return null;
  }
}

/**
 * `landing.captureSite` (RFC-11 §3, phase 0 INTAKE): what the client's
 * current site actually says and shows, so the new page can carry forward
 * what works and never contradict what is published. Renders the URL in
 * headless Chromium (already in the runtime image for `landing.renderPage`)
 * and pulls the visible copy, headings, nav, CTAs, images, the observed
 * palette/fonts, third-party embeds, and full-page screenshots at desktop
 * and mobile widths. When the browser cannot load the page (bot walls,
 * timeouts) it falls back to a plain fetch + HTML strip, and says so in
 * `method`, so the blueprint step knows it is working from text alone.
 *
 * No vendor scraper: a client's own homepage is public, static enough, and
 * the one page this engine should never drop for want of an API key.
 */
export function createCaptureSite(deps: CaptureSiteDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const loadChromium = deps.loadChromium ?? defaultLoadChromium;

  return defineTool<CaptureSiteInput, SiteCapture>({
    name: "landing.captureSite",
    description:
      "Captures the client's current website for carry-forward: visible copy, headings, nav links, CTAs, images, observed colors/fonts, third-party embeds, and desktop+mobile screenshots. Browser-rendered when possible, plain fetch otherwise (reported in `method`).",
    version: TOOL_VERSION,
    inputSchema: CaptureSiteInputSchema,
    async execute({ url, runId, clientSlug, timeoutMs }) {
      const screenshots: SiteCapture["screenshots"] = [];
      const upload = async (label: string, png: Buffer) => {
        if (!deps.artifactStore) return;
        const objectPath = `landing/${clientSlug}/${runId}/old-site-${label}.png`;
        const result = await deps.artifactStore.upload(objectPath, png, { contentType: "image/png" });
        screenshots.push({ label, ...(result.signedUrl ? { url: result.signedUrl } : {}), gcsUri: result.gcsUri });
      };

      const chromium = await loadChromium();
      if (chromium) {
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch();
          const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
          const response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => null);
          if (response && response.status() < 400) {
            // Let lazy sections mount before reading: scroll through once.
            await page.evaluate(async () => {
              const step = 700;
              for (let y = 0; y < (document.body as any).scrollHeight; y += step) {
                window.scrollTo(0, y);
                await new Promise((r) => setTimeout(r, 120));
              }
              window.scrollTo(0, 0);
            });
            const extracted = (await page.evaluate(extractInPage)) as ExtractedPage;
            const desktop = await page.screenshot({ fullPage: true, type: "png" }).catch(() => undefined);
            if (desktop) await upload("desktop", Buffer.from(desktop));
            await page.setViewportSize({ width: 390, height: 844 });
            const mobile = await page.screenshot({ fullPage: true, type: "png" }).catch(() => undefined);
            if (mobile) await upload("mobile", Buffer.from(mobile));
            const finalUrl = page.url();
            await browser.close();
            return success<SiteCapture>(finish(url, finalUrl, "browser", extracted, screenshots));
          }
          await browser.close();
        } catch (err) {
          await browser?.close().catch(() => undefined);
          console.error(`landing.captureSite: browser capture of ${url} failed, falling back to fetch: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let html: string;
      let finalUrl = url;
      try {
        const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Mozilla/5.0 (compatible; KarosLandingBuilder/1.0)" } });
        if (!res.ok) return contentFail<SiteCapture>(`the client's site at ${url} answered HTTP ${res.status}`);
        finalUrl = res.url || url;
        html = await res.text();
      } catch (err) {
        return toolingError(`could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return success<SiteCapture>(finish(url, finalUrl, "fetch", extractFromHtml(html, finalUrl), screenshots));
    },
  });
}
declare const window: { scrollTo(x: number, y: number): void };

function finish(url: string, finalUrl: string, method: SiteCapture["method"], e: ExtractedPage, screenshots: SiteCapture["screenshots"]): SiteCapture {
  const textBlocks = dedupe(e.textBlocks).slice(0, MAX_TEXT_BLOCKS);
  const wordCount = [...e.headings.map((h) => h.text), ...textBlocks].join(" ").split(/\s+/).filter(Boolean).length;
  return {
    url,
    finalUrl,
    method,
    ...(e.title ? { title: e.title } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.lang ? { lang: e.lang } : {}),
    headings: e.headings.slice(0, 60),
    navLinks: e.navLinks,
    ctas: e.ctas,
    textBlocks,
    images: dedupeBy(e.images, (i) => i.src).slice(0, MAX_IMAGES),
    colors: e.colors,
    fonts: e.fonts,
    screenshots,
    embeds: e.embeds,
    wordCount,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
