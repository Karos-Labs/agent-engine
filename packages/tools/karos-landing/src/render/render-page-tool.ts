import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { RenderBreakpointReport, RenderReport } from "../page/types.js";

const TOOL_VERSION = "2.0.0";

export const RenderBreakpointSchema = z.object({
  label: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const DEFAULT_BREAKPOINTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1440, height: 900 },
];

export const RenderPageInputSchema = z.object({
  html: z.string().min(1).describe("The assembled index.html to render."),
  runId: z.string().min(1).describe("This run's id; screenshots land under landing/<clientSlug>/<runId>/ in the artifact store."),
  clientSlug: z.string().min(1).describe("Which client the render belongs to (the artifact path segment)."),
  fontFamilies: z.array(z.string().min(1)).default([]).describe("Families the CSS relies on; each is checked against document.fonts after load."),
  breakpoints: z.array(RenderBreakpointSchema).default(() => DEFAULT_BREAKPOINTS).describe("Viewports to render at. Defaults to mobile 390x844 and desktop 1440x900."),
  minOpenerLuminance: z.number().min(0).max(255).default(20).describe("ENGINE-SPEC §8: no blank / near-black opener; average luminance floor on a 0-255 scale."),
  minContrast: z.number().min(1).default(4.5).describe("Body text contrast floor (WCAG AA). Large text uses 3:1 automatically."),
  variant: z.string().min(1).default("v1").describe("Screenshot label suffix, so a re-render after the fix pass does not overwrite the first (v1, v2)."),
});
export type RenderPageInput = z.infer<typeof RenderPageInputSchema>;

export interface RenderPageDeps {
  artifactStore?: GcsArtifactStoreLike;
  loadChromium?: () => Promise<typeof import("playwright").chromium | null>;
}

/* ─────────── in-page metrics (runs inside Chromium) ─────────── */

declare const document: any;
declare const window: any;
declare function getComputedStyle(el: unknown): any;

interface InPageMetrics {
  horizontalOverflow: boolean;
  openerLuminance: number;
  pageHeight: number;
  fontsLoaded: boolean;
  missingFonts: string[];
  h1Count: number;
  brokenImages: number;
  minContrast: number;
  lowContrastSamples: string[];
}

async function measureInPage(args: { fontFamilies: string[]; minContrast: number }): Promise<InPageMetrics> {
  const parseRgb = (s: string): [number, number, number, number] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1]!.split(",").map((x) => parseFloat(x.trim()));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p.length > 3 ? (p[3] as number) : 1];
  };
  const luminance = (rgb: [number, number, number]): number => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const effectiveBackground = (start: any): [number, number, number] | null => {
    let node = start;
    let guard = 0;
    while (node && guard++ < 25) {
      const bg = parseRgb(getComputedStyle(node).backgroundColor ?? "");
      if (bg && bg[3] > 0.5) return [bg[0], bg[1], bg[2]];
      node = node.parentElement;
    }
    const bodyBg = parseRgb(getComputedStyle(document.body).backgroundColor ?? "");
    return bodyBg && bodyBg[3] > 0 ? [bodyBg[0], bodyBg[1], bodyBg[2]] : [255, 255, 255];
  };

  await document.fonts.ready;
  const missingFonts = args.fontFamilies.filter((family) => !document.fonts.check(`16px "${family}"`));

  const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
  const pageHeight = document.documentElement.scrollHeight;

  // Opener: the element at the viewport center at scroll 0, walking up for a painted background.
  let openerLuminance = 255;
  const center = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
  const openerBg = center ? effectiveBackground(center) : null;
  if (openerBg) openerLuminance = 0.2126 * openerBg[0] + 0.7152 * openerBg[1] + 0.0722 * openerBg[2];

  const h1Count = document.querySelectorAll("h1").length;
  let brokenImages = 0;
  for (const img of Array.from(document.querySelectorAll("img")) as any[]) {
    if (img.complete && img.naturalWidth === 0 && !(img.getAttribute("src") ?? "").startsWith("data:")) brokenImages++;
  }

  let minContrast = 21;
  const lowContrastSamples: string[] = [];
  let sampled = 0;
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,p,li,a,button,span,label,dt,dd,blockquote,figcaption")) as any[]) {
    if (sampled++ > 600) break;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 3) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity ?? "1") < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const fg = parseRgb(cs.color ?? "");
    if (!fg || fg[3] < 0.5) continue;
    const bg = effectiveBackground(el);
    if (!bg) continue;
    const l1 = luminance([fg[0], fg[1], fg[2]]);
    const l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const fontSize = parseFloat(cs.fontSize ?? "16");
    const weight = parseInt(cs.fontWeight ?? "400", 10);
    const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
    const floor = large ? 3 : args.minContrast;
    if (ratio < minContrast) minContrast = ratio;
    if (ratio < floor && lowContrastSamples.length < 8) lowContrastSamples.push(`${el.tagName.toLowerCase()} "${text.slice(0, 40)}" ${ratio.toFixed(2)}:1`);
  }

  return { horizontalOverflow, openerLuminance, pageHeight, fontsLoaded: missingFonts.length === 0, missingFonts, h1Count, brokenImages, minContrast, lowContrastSamples };
}

async function defaultLoadChromium(): Promise<typeof import("playwright").chromium | null> {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return null;
  }
}

/**
 * `landing.renderPage` (RFC-11 §5, GATE layer 2): renders the assembled HTML
 * in headless Chromium at each breakpoint and reports what only a browser
 * can know: console errors and failed requests, horizontal overflow, the
 * opener's luminance, whether the declared fonts actually loaded, broken
 * images, and the lowest text/background contrast sampled across the page.
 * Takes full-page screenshots and uploads them when an artifact store is
 * configured; the human reviewer sees those in the gate, and the portal
 * asset gets the desktop one as its cover.
 *
 * `page.setContent`, not a dev server: v2 ships a self-contained
 * `index.html`, so there is nothing to serve. The v1 tool needed an
 * already-running Next.js preview that no deployment ever had, which is why
 * its render check was skipped on every real run.
 */
export function createRenderPage(deps: RenderPageDeps = {}) {
  const loadChromium = deps.loadChromium ?? defaultLoadChromium;

  return defineTool<RenderPageInput, RenderReport>({
    name: "landing.renderPage",
    description:
      "Renders the assembled index.html in headless Chromium at mobile and desktop widths: console errors, failed requests, horizontal overflow, opener luminance, fonts loaded, broken images, minimum text contrast, plus full-page screenshots uploaded to the artifact store.",
    version: TOOL_VERSION,
    inputSchema: RenderPageInputSchema,
    async execute({ html, runId, clientSlug, fontFamilies, breakpoints, minOpenerLuminance, minContrast, variant }) {
      const chromium = await loadChromium();
      if (!chromium) return toolingError("playwright/chromium is not available in this runtime");

      const browser = await chromium.launch();
      try {
        const reports: RenderBreakpointReport[] = [];
        for (const bp of breakpoints) {
          const page = await browser.newPage({ viewport: { width: bp.width, height: bp.height } });
          const consoleErrors: string[] = [];
          const failedRequests: string[] = [];
          page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
          });
          page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 300)));
          page.on("requestfailed", (req) => failedRequests.push(`${req.url().slice(0, 160)} (${req.failure()?.errorText ?? "failed"})`));

          try {
            await page.setContent(html, { waitUntil: "load", timeout: 45_000 });
            // Give fonts and any intersection-driven reveals a moment; then reset to the top so the opener is measured, not a mid-page band.
            await page.waitForTimeout(600);
            await page.evaluate(async () => {
              const step = 800;
              for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
                window.scrollTo(0, y);
                await new Promise((r) => setTimeout(r, 60));
              }
              window.scrollTo(0, 0);
            });
            await page.waitForTimeout(300);
          } catch (err) {
            await page.close();
            return toolingError(`rendering @${bp.label} failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          const metrics = (await page.evaluate(measureInPage, { fontFamilies, minContrast })) as InPageMetrics;

          let screenshot: RenderBreakpointReport["screenshot"];
          if (deps.artifactStore) {
            const png = await page.screenshot({ fullPage: true, type: "png" });
            const objectPath = `landing/${clientSlug}/${runId}/render-${variant}-${bp.label}.png`;
            const uploaded = await deps.artifactStore.upload(objectPath, Buffer.from(png), { contentType: "image/png" });
            screenshot = { ...(uploaded.signedUrl ? { url: uploaded.signedUrl } : {}), gcsUri: uploaded.gcsUri };
          }
          await page.close();

          reports.push({
            label: bp.label,
            width: bp.width,
            height: bp.height,
            consoleErrors,
            failedRequests,
            ...metrics,
            ...(screenshot ? { screenshot } : {}),
          });
        }

        const violations: string[] = [];
        for (const r of reports) {
          if (r.consoleErrors.length > 0) violations.push(`@${r.label}: ${r.consoleErrors.length} console error(s): ${r.consoleErrors[0]}`);
          if (r.horizontalOverflow) violations.push(`@${r.label}: horizontal overflow`);
          if (r.openerLuminance < minOpenerLuminance) violations.push(`@${r.label}: near-black opener (luminance ${r.openerLuminance.toFixed(1)})`);
          if (!r.fontsLoaded) violations.push(`@${r.label}: fonts did not load: ${r.missingFonts.join(", ")}`);
          if (r.h1Count !== 1) violations.push(`@${r.label}: ${r.h1Count} <h1> elements rendered`);
          if (r.brokenImages > 0) violations.push(`@${r.label}: ${r.brokenImages} broken image(s)`);
          if (r.lowContrastSamples.length > 0) violations.push(`@${r.label}: low text contrast: ${r.lowContrastSamples.slice(0, 3).join("; ")}`);
          const externalFailures = r.failedRequests.filter((f) => !f.startsWith("about:blank"));
          if (externalFailures.length > 0) violations.push(`@${r.label}: ${externalFailures.length} failed request(s): ${externalFailures[0]}`);
        }

        return success<RenderReport>({ breakpoints: reports, pass: violations.length === 0, violations });
      } finally {
        await browser.close();
      }
    },
  });
}
