import { z } from "zod";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";

// 1.0.0 — new (2026-09-25): the client's design language, measured off its own site.
const TOOL_VERSION = "1.0.0";

/**
 * WS-04 of the owner's 2026-09-24 feedback round (#253): the boxes, buttons
 * and lines a client's OWN site draws, measured from computed styles, so the
 * carousel's panels can be drawn in that language instead of the bundled
 * accent gradient the owner called "brown and pink boxes". This first cut
 * measures boxes and buttons only (radius, pill, hairline, fill, shadow,
 * gradient); fonts and colours already come from the brand kit.
 *
 * Every token carries `provenance: "measured"`; a stated kit value always
 * outranks it at render (renderTokens > stated > measured > default).
 */

/** One box-like element as the page evaluator reports it. */
export interface MeasuredBox {
  kind: "card" | "button";
  width: number;
  height: number;
  radius: number;
  borderWidth: number;
  borderColor?: string | undefined;
  background?: string | undefined;
  /** The page's own ground behind the element. */
  ground?: string | undefined;
  hasShadow: boolean;
  hasGradient: boolean;
}

export interface DesignLanguageTokens {
  /** Corner radius of the site's boxes, px, rounded to the nearest 2. */
  boxRadius?: number;
  /** Buttons are pills (radius at least half their height). */
  pillButtons: boolean;
  /** How the site draws a box: a hairline, a fill, both, or neither. */
  boxStyle: "hairline" | "fill" | "hairline-fill" | "none";
  lineColor?: string;
  fillColor?: string;
  /** Shares of boxes that carry a shadow / a gradient. The fleet rule: nothing the client's own site does not do. */
  shadowShare: number;
  gradientShare: number;
}

export interface CaptureDesignLanguageResult {
  url: string;
  tokens: DesignLanguageTokens;
  provenance: "measured";
  evidence: { cards: number; buttons: number };
  measuredAt: string;
}

const TRANSPARENT = /^(transparent|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\))$/iu;

function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The tokens from the measured boxes. Pure, so a recorded capture can be
 * re-derived in a test without a browser.
 */
export function deriveDesignLanguage(boxes: readonly MeasuredBox[]): { tokens: DesignLanguageTokens; evidence: { cards: number; buttons: number } } {
  const cards = boxes.filter((b) => b.kind === "card");
  const buttons = boxes.filter((b) => b.kind === "button");
  const filled = (b: MeasuredBox) => b.background !== undefined && !TRANSPARENT.test(b.background) && b.background !== b.ground;
  const lined = (b: MeasuredBox) => b.borderWidth > 0 && b.borderWidth <= 2 && b.borderColor !== undefined && !TRANSPARENT.test(b.borderColor);
  const hairlineShare = cards.length > 0 ? cards.filter(lined).length / cards.length : 0;
  const fillShare = cards.length > 0 ? cards.filter(filled).length / cards.length : 0;
  const boxStyle: DesignLanguageTokens["boxStyle"] =
    hairlineShare >= 0.5 && fillShare >= 0.5 ? "hairline-fill" : hairlineShare >= 0.5 ? "hairline" : fillShare >= 0.5 ? "fill" : "none";
  const radius = median(cards.map((c) => c.radius));
  const pills = buttons.filter((b) => b.height > 0 && b.radius >= b.height / 2 - 1).length;
  const lineColor = mode(cards.filter(lined).map((c) => c.borderColor!));
  const fillColor = mode(cards.filter(filled).map((c) => c.background!));
  return {
    tokens: {
      ...(radius !== undefined ? { boxRadius: Math.round(radius / 2) * 2 } : {}),
      pillButtons: buttons.length > 0 && pills / buttons.length >= 0.5,
      boxStyle,
      ...(lineColor !== undefined ? { lineColor } : {}),
      ...(fillColor !== undefined ? { fillColor } : {}),
      shadowShare: cards.length > 0 ? Math.round((cards.filter((c) => c.hasShadow).length / cards.length) * 100) / 100 : 0,
      gradientShare: cards.length > 0 ? Math.round((cards.filter((c) => c.hasGradient).length / cards.length) * 100) / 100 : 0,
    },
    evidence: { cards: cards.length, buttons: buttons.length },
  };
}

/**
 * Runs IN the page. Cards: a visible, bounded element of at least 3% of the
 * viewport and at most 70% of its width that draws an edge (a border, a
 * shadow, a radius over a fill). Buttons: `button`, `[role=button]`, or a link
 * with a fill or a border. Consent banners, chat widgets and iframes are
 * skipped, and so is anything fixed to the viewport.
 */
export const MEASURE_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const skip = (el) => el.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[class*="chat" i],[id*="chat" i],iframe');
  const groundOf = (el) => { let p = el.parentElement; while (p) { const bg = getComputedStyle(p).backgroundColor; if (bg && !/^(transparent|rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\))$/i.test(bg)) return bg; p = p.parentElement; } return getComputedStyle(document.body).backgroundColor; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (out.length > 400) break;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed' || skip(el)) continue;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const borderWidth = parseFloat(cs.borderTopWidth) || 0;
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    const hasGradient = /gradient/i.test(cs.backgroundImage || '');
    const bg = cs.backgroundColor;
    const tag = el.tagName.toLowerCase();
    const isButton = tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'a' && (borderWidth > 0 || !/^(transparent|rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\))$/i.test(bg)) && r.height < 90);
    const area = (r.width * r.height) / (vw * vh);
    const drawsEdge = borderWidth > 0 || hasShadow || (radius > 0 && !/^(transparent|rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\))$/i.test(bg));
    const isCard = !isButton && drawsEdge && area >= 0.03 && r.width <= vw * 0.7;
    if (!isButton && !isCard) continue;
    out.push({ kind: isButton ? 'button' : 'card', width: Math.round(r.width), height: Math.round(r.height), radius, borderWidth, borderColor: borderWidth > 0 ? cs.borderTopColor : undefined, background: bg, ground: groundOf(el), hasShadow: !!hasShadow, hasGradient });
  }
  return out;
})()`;

export const CaptureDesignLanguageInputSchema = z.object({
  url: z.string().url().describe("The client's own site: its home page, or the page that best shows its product."),
  timeoutMs: z.number().int().min(5_000).max(60_000).default(25_000).describe("Navigation ceiling. A page that has not settled by then is measured as it stands."),
});
export type CaptureDesignLanguageInput = z.input<typeof CaptureDesignLanguageInputSchema>;

/** The slice of a browser this tool drives, injectable so tests never launch Chromium. */
export interface MeasuringBrowser {
  measure(url: string, timeoutMs: number): Promise<MeasuredBox[]>;
  close(): Promise<void>;
}
export type MeasuringBrowserLauncher = () => Promise<MeasuringBrowser>;

async function launchMeasuringChromium(): Promise<MeasuringBrowser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  return {
    async measure(url, timeoutMs) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        try {
          await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, timeoutMs) });
        } catch {
          /* a page that never goes quiet is measured as it stands */
        }
        await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
        await page.evaluate("window.scrollTo(0, Math.min(document.body.scrollHeight, 2400))");
        await page.waitForTimeout(600);
        return (await page.evaluate(MEASURE_SCRIPT)) as MeasuredBox[];
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}

/** Too few measured boxes to say anything: a blank page, a bot wall, a single hero. */
export const MIN_BOXES_FOR_A_LANGUAGE = 3;

export function createCaptureDesignLanguage(options: { launcher?: MeasuringBrowserLauncher | null | undefined } = {}) {
  const launcher = options.launcher === null ? undefined : (options.launcher ?? launchMeasuringChromium);
  return defineTool<CaptureDesignLanguageInput, CaptureDesignLanguageResult>({
    name: "media.captureDesignLanguage",
    description:
      "Measures the client's design language on its own site with headless Chromium: the corner radius of its boxes, whether its buttons are pills, whether boxes are drawn as hairlines or fills, and how often it uses shadows and gradients. Computed styles only; consent banners and chat widgets are skipped.",
    version: TOOL_VERSION,
    inputSchema: CaptureDesignLanguageInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof CaptureDesignLanguageInputSchema>;
      if (launcher === undefined) return notAvailable<CaptureDesignLanguageResult>("media.captureDesignLanguage: no browser launcher configured for this deployment");
      let browser: MeasuringBrowser | undefined;
      try {
        browser = await launcher();
        const boxes = await browser.measure(input.url, input.timeoutMs);
        if (boxes.length < MIN_BOXES_FOR_A_LANGUAGE) {
          return notAvailable<CaptureDesignLanguageResult>(`media.captureDesignLanguage: ${input.url} showed ${boxes.length} box(es), too few to read a language from (a blank page, a bot wall or a single hero)`);
        }
        const { tokens, evidence } = deriveDesignLanguage(boxes);
        return success<CaptureDesignLanguageResult>({ url: input.url, tokens, provenance: "measured", evidence, measuredAt: new Date().toISOString() });
      } catch (error) {
        return toolingError<CaptureDesignLanguageResult>(`media.captureDesignLanguage: ${(error as Error).message.slice(0, 200)}`);
      } finally {
        await browser?.close().catch(() => undefined);
      }
    },
  });
}
