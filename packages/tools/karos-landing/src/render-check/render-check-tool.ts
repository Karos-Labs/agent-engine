import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const BreakpointSchema = z.object({
  label: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Breakpoint = z.infer<typeof BreakpointSchema>;

const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 800 },
];

export const RenderCheckInputSchema = z.object({
  /** The already-running dev/preview server for this client's build (e.g. `http://localhost:3005`) — starting/stopping that server is the workflow's job, not this tool's. */
  baseUrl: z.string().min(1),
  path: z.string().min(1).default("/"),
  breakpoints: z.array(BreakpointSchema).default(() => DEFAULT_BREAKPOINTS),
  /** ENGINE-SPEC §8: "no blank / near-black opener (avg luminance >= 20)", on a 0-255 scale. */
  minOpenerLuminance: z.number().min(0).max(255).default(20),
});
export type RenderCheckInput = z.infer<typeof RenderCheckInputSchema>;

export interface BreakpointCheckResult {
  label: string;
  width: number;
  height: number;
  httpStatus: number | null;
  consoleErrors: string[];
  horizontalOverflow: boolean;
  openerLuminance: number;
  nearBlackOpener: boolean;
}

export interface RenderCheckResult {
  breakpoints: BreakpointCheckResult[];
  pass: boolean;
}

/**
 * `assertHttpUrl` — the Chromium-free half of this tool's input validation
 * (mirrors `publish.renderCarousel`'s `validateRenderInputs`/`assertInside`
 * split): refuses anything that isn't a well-formed `http(s)://` URL before a
 * browser is ever launched, so a malformed/`file://`/`javascript:` base URL
 * is a fast `tooling_error`, not an opaque Playwright navigation failure.
 */
export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`baseUrl must be a well-formed URL, got "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`baseUrl must be http(s), got "${raw}"`);
  }
  return url;
}

// These callbacks run inside the Chromium page (Playwright serializes and executes them
// in-browser), never in this Node process — this package's tsconfig has no DOM lib, so
// `window`/`document` are declared `any` locally, same convention as `publish.renderCarousel`.
declare const window: { innerWidth: number; innerHeight: number };
declare const document: {
  documentElement: { scrollWidth: number };
  elementFromPoint(x: number, y: number): { parentElement: unknown } | null;
};
declare function getComputedStyle(el: unknown): { backgroundColor: string };

function hasHorizontalOverflow(): boolean {
  return document.documentElement.scrollWidth > window.innerWidth + 1;
}

/** Walks up from the element at viewport-center looking for the first non-transparent background, and returns its relative luminance (0-255) — a cheap proxy for "is the opener a near-black/blank screen" without needing to decode a screenshot. */
function computeOpenerLuminance(): number {
  let node: { parentElement: unknown } | null = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
  let bg: string | null = null;
  let guard = 0;
  while (node && guard < 12) {
    const candidate = getComputedStyle(node).backgroundColor;
    if (candidate && candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
      bg = candidate;
      break;
    }
    node = (node.parentElement as { parentElement: unknown } | null) ?? null;
    guard++;
  }
  if (!bg) return 255; // no discernible background found — treat as neutral, never a false "near-black" flag
  const match = /rgba?\(([^)]+)\)/.exec(bg);
  if (!match) return 255;
  const parts = match[1]!.split(",").map((s) => parseFloat(s.trim()));
  const [r = 0, g = 0, b = 0] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * `landing.renderCheck` (RFC-07 §7 / ENGINE-SPEC §8's render half of the
 * gate): dev-server 200, no horizontal overflow, no near-black opener
 * (avg luminance >= 20), console clean, at every configured breakpoint
 * (default `@390` + `@1280`). Playwright is imported lazily inside
 * `execute` — same reason as `publish.renderCarousel`: input validation
 * (`assertHttpUrl`) must run in environments without Playwright installed.
 */
export function createRenderCheck() {
  return defineTool<RenderCheckInput, RenderCheckResult>({
    name: "landing.renderCheck",
    version: TOOL_VERSION,
    inputSchema: RenderCheckInputSchema,
    async execute({ baseUrl, path: routePath, breakpoints, minOpenerLuminance }) {
      let url: URL;
      try {
        url = assertHttpUrl(baseUrl);
      } catch (err) {
        return toolingError(err instanceof Error ? err.message : String(err));
      }
      const target = new URL(routePath, url).toString();

      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (err) {
        return toolingError(`playwright is not installed/available: ${err instanceof Error ? err.message : String(err)}`);
      }

      const browser = await chromium.launch();
      try {
        const results: BreakpointCheckResult[] = [];
        for (const bp of breakpoints) {
          const page = await browser.newPage({ viewport: { width: bp.width, height: bp.height } });
          const consoleErrors: string[] = [];
          page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
          });
          page.on("pageerror", (err) => consoleErrors.push(String(err)));

          let httpStatus: number | null = null;
          try {
            const response = await page.goto(target, { waitUntil: "load", timeout: 30_000 });
            httpStatus = response?.status() ?? null;
          } catch (err) {
            await page.close();
            return toolingError(`navigation to "${target}" @${bp.label} failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          const horizontalOverflow = await page.evaluate(hasHorizontalOverflow);
          const openerLuminance = await page.evaluate(computeOpenerLuminance);
          await page.close();

          results.push({
            label: bp.label,
            width: bp.width,
            height: bp.height,
            httpStatus,
            consoleErrors,
            horizontalOverflow,
            openerLuminance,
            nearBlackOpener: openerLuminance < minOpenerLuminance,
          });
        }

        const failures = results.filter(
          (r) => r.httpStatus !== 200 || r.consoleErrors.length > 0 || r.horizontalOverflow || r.nearBlackOpener,
        );

        if (failures.length > 0) {
          const reasons = failures.map((f) => {
            const bits: string[] = [];
            if (f.httpStatus !== 200) bits.push(`http ${f.httpStatus}`);
            if (f.consoleErrors.length > 0) bits.push(`${f.consoleErrors.length} console error(s)`);
            if (f.horizontalOverflow) bits.push("horizontal overflow");
            if (f.nearBlackOpener) bits.push(`near-black opener (luminance ${f.openerLuminance.toFixed(1)})`);
            return `@${f.label}: ${bits.join(", ")}`;
          });
          return contentFail<RenderCheckResult>(`render check failed — ${reasons.join("; ")}`);
        }

        return success<RenderCheckResult>({ breakpoints: results, pass: true });
      } finally {
        await browser.close();
      }
    },
  });
}
