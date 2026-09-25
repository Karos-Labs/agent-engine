/**
 * The client's design language, measured off its own site (WS-04 of the
 * owner's 2026-09-24 feedback round, #253), stored as a client belief so
 * every run and every agent reads the same record. This module decides when
 * to measure; `media.captureDesignLanguage` measures. Templates read it in a
 * later step (WS-07); on its own this changes no pixel.
 */
export const DESIGN_LANGUAGE_BELIEF_KEY = "clientDesignLanguage";
/** How long a measurement stands. A site's box style changes with a redesign, not weekly. */
export const DESIGN_LANGUAGE_TTL_DAYS = 90;
/** How long to wait after a failed measurement before trying again. */
export const DESIGN_LANGUAGE_RETRY_DAYS = 7;

export interface StoredDesignLanguage {
  version: 1;
  measuredAt: string;
  status: "measured" | "failed";
  url?: string;
  tokens?: {
    boxRadius?: number;
    pillButtons: boolean;
    boxStyle: "hairline" | "fill" | "hairline-fill" | "none";
    lineColor?: string;
    fillColor?: string;
    shadowShare: number;
    gradientShare: number;
  };
  evidence?: { cards: number; buttons: number };
  problem?: string;
}

export function readDesignLanguage(value: unknown): StoredDesignLanguage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Partial<StoredDesignLanguage>;
  if (v.version !== 1 || typeof v.measuredAt !== "string" || (v.status !== "measured" && v.status !== "failed")) return undefined;
  if (v.status === "measured" && (v.tokens === undefined || typeof v.tokens.boxStyle !== "string")) return undefined;
  return v as StoredDesignLanguage;
}

/** `reuse` a fresh measurement, `wait` after a recent failure, `measure` otherwise. */
export function designLanguageAction(stored: StoredDesignLanguage | undefined, now: Date): "reuse" | "wait" | "measure" {
  if (stored === undefined) return "measure";
  const ageDays = (now.getTime() - new Date(stored.measuredAt).getTime()) / 86_400_000;
  if (stored.status === "failed") return ageDays < DESIGN_LANGUAGE_RETRY_DAYS ? "wait" : "measure";
  return ageDays < DESIGN_LANGUAGE_TTL_DAYS ? "reuse" : "measure";
}

/** The panels that draw a box: stat, quote, closer, the cover's field. */
const PANEL_SELECTORS = [".num-zone", ".quote-block", ".cl-panel", ".cov-field"];
/**
 * The bounded pictures whose corners follow the box radius. Placements that
 * are square or round on purpose (a side split and a carry bleed off the
 * frame edge, a circle is a circle) and a logo or cutout keep their own shape.
 */
const PICTURE_SELECTORS = [
  'html body:not([data-figure="circle"]):not([data-figure="side"]):not([data-figure="side-end"]):not([data-figure="carry-out"]):not([data-figure="carry-in"]) .sc-figure-band:not([data-kind="cutout"]):not([data-kind="mark"]):not([data-kind="mark-clear"])',
  'html body img.hero[data-kind="framed"]',
  'html body .bg[data-kind="framed"] > img',
  'html body[data-figure="inset"] .bg',
];
/** A radius past this reads as a pill on a panel the size of half a slide. */
export const DESIGN_LANGUAGE_MAX_RADIUS = 24;

/**
 * THE MEASURED LANGUAGE, PAINTED (WS-07, 2026-09-25).
 *
 * `00f1` has measured seven prep clients' sites since #302 and nothing read
 * the record, so every client's panels were the same neutral box: Sitti's
 * site draws 16px cards with a hairline, Geektime's 6px filled cards with no
 * line, XO Digital's 16px hairline cards and pill buttons, and all three got
 * 4px boxes with a hairline. The owner's rule is "nothing the client's own
 * site does not do", and the research round (#253) ruled the boxes come from
 * the measured language.
 *
 * Three things carry, and they are the ones that survive the move from the
 * site's ground to ours: the corner radius (panels and bounded pictures),
 * whether a box draws a hairline, and whether a button is a pill. The fill
 * COLOUR does not carry: it was measured against the site's own ground, and
 * on a slide ground of another tone it is a clash, not a language. The panel
 * keeps its neutral ramp of the ink colour, which the interest floor reads.
 *
 * Empty for a client with no measurement, so its render is byte-identical to
 * today's.
 */
export function designLanguageCssBlock(stored: StoredDesignLanguage | undefined): string {
  const tokens = stored?.status === "measured" ? stored.tokens : undefined;
  if (tokens === undefined) return "";
  const rules: string[] = [];
  if (tokens.boxRadius !== undefined && Number.isFinite(tokens.boxRadius)) {
    const r = Math.max(0, Math.min(DESIGN_LANGUAGE_MAX_RADIUS, Math.round(tokens.boxRadius)));
    rules.push(`${[...PANEL_SELECTORS.map((s) => `html body ${s}`), ...PICTURE_SELECTORS].join(",\n")} { border-radius: ${r}px; }`);
    if (!tokens.pillButtons) rules.push(`html body[data-cta="pill"] .cl-cta { border-radius: ${r}px; }`);
  }
  // A site whose boxes are fills or bare draws no line round them.
  if (tokens.boxStyle === "fill" || tokens.boxStyle === "none") {
    rules.push(`${PANEL_SELECTORS.map((s) => `html body ${s}`).join(", ")} { box-shadow: none; }`);
  }
  return rules.length === 0 ? "" : `<style data-design-language>\n/* The client's design language, measured off its own site (00f1). */\n${rules.join("\n")}\n</style>`;
}
