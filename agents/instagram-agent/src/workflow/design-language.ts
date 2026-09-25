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
