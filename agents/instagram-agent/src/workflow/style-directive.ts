import { z } from "zod";
import { HEX_COLOR, resolveModelPolicy, type ModelPolicy, type ModelRouter } from "@agent-engine/core";
import type { StyleEdit } from "@agent-engine/core";
import { contrastRatio } from "./brand-render-tokens.js";
import type { StyleOverrides } from "./types.js";

/**
 * IGSTYLE-2 — turns a reviewer's instruction (a structured `edits.style`
 * pick, free-text `feedback`, or both) into a `StyleOverrides` patch this
 * run's revision can actually apply, WITHOUT ever inventing a colour the
 * client's kit didn't ship (`resolveNamedColor` below is kit-first, exactly
 * like `buildAccentRing`'s own "never a color the kit didn't ship") and
 * WITHOUT ever silently discarding an instruction that would break the
 * 4.5:1 text-contrast floor (a `StyleRefusal`, not a silent no-op).
 *
 * Three tiers, cheapest first:
 *
 *   Tier 0 — structured. `edits.style` is authoritative; no parsing at all.
 *   Tier 1 — a small, pure, closed-vocabulary parser. No clock, no RNG, no
 *            I/O — see `runDeterministicParser`, unit-testable directly.
 *   Tier 2 — one model call, ONLY when Tier 0/1 produced nothing AND the
 *            free text plausibly concerns style at all (`looksStyleRelated`
 *            below) — "love it, ship it" must never reach the model.
 *
 * This module never wires `ledger.appendEvent` or a gate payload field —
 * that's IGSTYLE-3's job, wiring this module's `StyleDirectiveResult` into
 * `04g-style-directive` and `styleDirectiveOutcome`. This module only ever
 * returns facts about what it did (or refused to do); it never throws and
 * never has a side effect.
 */

export interface StyleIntent {
  role: "ground" | "fg" | "accent";
  direction: "darker" | "lighter" | "more-contrast" | "hue";
  hue?: string;
}

export interface StyleRefusal {
  role: keyof StyleOverrides | "pair";
  requested: string;
  reason: string;
  contrastRatio?: number;
}

export interface StyleDirectiveResult {
  overrides: StyleOverrides;
  applied: string[];
  intents: StyleIntent[];
  refusals: StyleRefusal[];
  source: "structured" | "parsed" | "model" | "none";
}

/**
 * What a directive is resolved AGAINST: the ground/fg pair the parser's
 * `darker`/`lighter`/`more-contrast` rules adjust relative to, and the kit's
 * own ring of legal colours `resolveNamedColor` prefers over any generic
 * named-colour table. Callers (IGSTYLE-3's `effectiveBrandKit`) pass the kit
 * state the directive should be resolved against — normally Layers 0+1
 * merged, i.e. before this run's own directive is applied.
 */
export interface StyleDirectiveContext {
  ground?: string;
  fg?: string;
  /** Deduped kit ring colours, e.g. `BrandRenderTokens.palette`. */
  ring: readonly string[];
}

export interface StyleDirectiveInput {
  /** Tier 0 — a structured pick from `ReviewEditsSchema.style`. Bypasses parsing entirely. */
  style?: StyleEdit;
  /** Free text a reviewer typed — a `revise` gate's `feedback`. */
  feedback?: string;
}

export interface StyleDirectiveDeps {
  router: ModelRouter;
}

/**
 * A local, private mirror of `brand-render-tokens.ts`'s own `CONTRAST_FLOOR`
 * (4.5 — WCAG AA for normal text). Not imported: that constant is private to
 * that module and this ticket's file list does not touch it. This is a
 * best-effort front door, not the security boundary — `deriveBrandRenderTokens`
 * re-checks the SAME 4.5 the moment IGSTYLE-3 actually re-derives with this
 * module's patch, and is the enforcement that can never be bypassed. Refusing
 * here too just means a doomed pair never reaches that point disguised as a
 * silent success.
 */
const TEXT_CONTRAST_FLOOR = 4.5;

/** `"more contrast"`'s target — distinct from, and higher than, the floor above. */
const MORE_CONTRAST_TARGET = 7;

/** `shade()`'s step size for `darker`/`lighter`, and each step of `pushContrast`'s walk. */
const SHADE_STEP_PERCENT = 12;

/** How many `SHADE_STEP_PERCENT` steps `pushContrast` will take before giving up. */
const MAX_CONTRAST_STEPS = 8;

/** How close (in degrees, on a 0–360 hue wheel) a kit colour must sit to a named colour's hue to count as "that colour, in this kit." */
const HUE_WINDOW_DEGREES = 40;

const GROUND_WORDS = ["background", "ground", "bg"];
const FG_WORDS = ["text", "copy", "foreground", "fg"];
const ACCENT_WORDS = ["accent", "highlight"];
const DARKER_WORDS = ["darker", "darken", "deeper"];
const LIGHTER_WORDS = ["lighter", "brighten"];

/** A small, deliberately short named-colour table — the fallback ONLY when nothing in the kit's ring is close enough (`resolveNamedColor`). */
const NAMED_COLORS: Record<string, string> = {
  orange: "#FFA500",
  red: "#FF0000",
  blue: "#0000FF",
  green: "#008000",
  yellow: "#FFFF00",
  purple: "#800080",
  pink: "#FFC0CB",
  white: "#FFFFFF",
  black: "#000000",
  gray: "#808080",
  grey: "#808080",
  teal: "#008080",
  navy: "#000080",
  coral: "#FF7F50",
  gold: "#FFD700",
  cream: "#FFFDD0",
  brown: "#8B4513",
};

const STYLE_SIGNAL = new RegExp(
  `#[0-9a-f]{3,8}\\b|\\b(${[
    ...GROUND_WORDS,
    ...FG_WORDS,
    ...ACCENT_WORDS,
    ...DARKER_WORDS,
    ...LIGHTER_WORDS,
    "contrast",
    "color",
    "colour",
    ...Object.keys(NAMED_COLORS),
  ].join("|")})\\b`,
  "i",
);

function wordBoundary(words: readonly string[]): RegExp {
  return new RegExp(`\\b(${words.join("|")})\\b`, "i");
}

const GROUND_RE = wordBoundary(GROUND_WORDS);
const FG_RE = wordBoundary(FG_WORDS);
const ACCENT_RE = wordBoundary(ACCENT_WORDS);
const DARKER_RE = wordBoundary(DARKER_WORDS);
const LIGHTER_RE = wordBoundary(LIGHTER_WORDS);
const MORE_CONTRAST_RE = /\bmore\s+contrast\b/i;
const HEX_TOKEN_RE = /#[0-9a-fA-F]{3,8}\b/;

/** Splits free text into small clauses so "darker background AND orange text" resolves each half independently, never cross-wiring role/colour pairs from opposite ends of a sentence. */
function splitClauses(text: string): string[] {
  return text
    .split(/\band\b|[,;]/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** Does this free text plausibly concern style at all? Gates Tier 2 — "love it, ship it" must reach here and stop. */
function looksStyleRelated(text: string): boolean {
  return STYLE_SIGNAL.test(text);
}

/** WCAG relative luminance — a local, minimal copy; see the `TEXT_CONTRAST_FLOOR` comment for why this file doesn't import `brand-render-tokens.ts`'s private one. */
function relativeLuminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const channel = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function hexToHue(hex: string): number | undefined {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return undefined; // achromatic — grey/white/black carry no hue to match against
  const d = max - min;
  let hue: number;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return hue;
}

function hueDelta(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 360 - raw);
}

/**
 * Shifts a hex colour toward black (negative `percent`) or white (positive),
 * channel by channel. Pure arithmetic — no palette lookup, no I/O. Preserves
 * an alpha suffix (4/8-digit forms) verbatim.
 */
function shade(hex: string, percent: number): string {
  let h = hex.slice(1);
  const hadShortAlpha = h.length === 4;
  const hadLongAlpha = h.length === 8;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const alpha = hadShortAlpha || hadLongAlpha ? h.slice(6, 8) : "";
  const p = percent / 100;
  const adjust = (c: number): number => {
    const next = p < 0 ? c * (1 + p) : c + (255 - c) * p;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}${alpha}`;
}

/**
 * Resolves a colour word against the client's kit FIRST — the nearest ring
 * member within `HUE_WINDOW_DEGREES` of the named colour's own hue — and
 * only falls back to `NAMED_COLORS` when nothing in the ring is close
 * enough. Mirrors `buildAccentRing`'s own ethos: never invent a colour the
 * kit didn't ship when a legal one will do.
 */
function resolveNamedColor(word: string, ring: readonly string[]): { hex: string; fromKit: boolean } | undefined {
  const named = NAMED_COLORS[word.toLowerCase()];
  if (named === undefined) return undefined;

  const targetHue = hexToHue(named);
  if (targetHue !== undefined) {
    let best: { hex: string; delta: number } | undefined;
    for (const hex of ring) {
      const hue = hexToHue(hex);
      if (hue === undefined) continue;
      const delta = hueDelta(hue, targetHue);
      if (delta <= HUE_WINDOW_DEGREES && (best === undefined || delta < best.delta)) {
        best = { hex, delta };
      }
    }
    if (best !== undefined) return { hex: best.hex, fromKit: true };
  }
  return { hex: named, fromKit: false };
}

/** Is `ground` visually closer to black than to white? Reuses the already-exported `contrastRatio` rather than a second luminance-based rule, so "which side to push toward" can never disagree with the ratio the rest of this module reasons about. */
function groundIsDark(ground: string): boolean {
  return contrastRatio(ground, "#000000") < contrastRatio(ground, "#FFFFFF");
}

/** "more contrast" — pushes `fg` away from `ground` in `SHADE_STEP_PERCENT` steps until `MORE_CONTRAST_TARGET` is cleared or the walk stops improving ("exhausts" the room it has). */
function pushContrast(fg: string, ground: string): { hex: string; ratio: number } {
  const towardWhite = groundIsDark(ground);
  let current = fg;
  let ratio = contrastRatio(current, ground);
  for (let step = 0; step < MAX_CONTRAST_STEPS && ratio < MORE_CONTRAST_TARGET; step++) {
    const next = shade(current, towardWhite ? SHADE_STEP_PERCENT : -SHADE_STEP_PERCENT);
    const nextRatio = contrastRatio(next, ground);
    if (nextRatio <= ratio) break; // no more room — exhausted
    current = next;
    ratio = nextRatio;
  }
  return { hex: current, ratio };
}

/** Direct "#rrggbb + role word" matches in one clause — verbatim, no shading, no intent (per IGSTYLE-2's own table: intent column is "none" for this row). */
function matchExplicitHex(clause: string): { role: "ground" | "fg" | "accent"; hex: string } | undefined {
  const hexMatch = HEX_TOKEN_RE.exec(clause);
  if (hexMatch === null) return undefined;
  const hex = hexMatch[0];
  if (!HEX_COLOR.test(hex)) return undefined;
  if (GROUND_RE.test(clause)) return { role: "ground", hex };
  if (FG_RE.test(clause)) return { role: "fg", hex };
  if (ACCENT_RE.test(clause)) return { role: "accent", hex };
  return undefined;
}

/** Everything else in the table — darker/lighter ground, colour+fg, colour+accent — expressed as `StyleIntent`s so Tier 1 and Tier 2 share ONE resolver (`applyIntents`). */
function matchIntent(clause: string): StyleIntent | undefined {
  if (GROUND_RE.test(clause) && DARKER_RE.test(clause)) return { role: "ground", direction: "darker" };
  if (GROUND_RE.test(clause) && LIGHTER_RE.test(clause)) return { role: "ground", direction: "lighter" };

  if (FG_RE.test(clause)) {
    const colour = findColourWord(clause);
    if (colour !== undefined) return { role: "fg", direction: "hue", hue: colour };
  }
  if (ACCENT_RE.test(clause)) {
    const colour = findColourWord(clause);
    if (colour !== undefined) return { role: "accent", direction: "hue", hue: colour };
  }
  return undefined;
}

function findColourWord(clause: string): string | undefined {
  const lower = clause.toLowerCase();
  for (const name of Object.keys(NAMED_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return name;
  }
  return undefined;
}

/**
 * Resolves `StyleIntent[]` into an actual `StyleOverrides` patch — the ONE
 * place hexes get computed from an intent, shared verbatim by Tier 1's
 * closed-vocabulary parser and Tier 2's model output, so a model-produced
 * intent is "re-validated through the same regex and kit-first rule" simply
 * by construction rather than by a second, easy-to-drift implementation.
 */
function applyIntents(
  intents: readonly StyleIntent[],
  context: StyleDirectiveContext,
): { overrides: Partial<Record<"ground" | "fg" | "accent", string>>; applied: string[]; refusals: StyleRefusal[] } {
  const overrides: Partial<Record<"ground" | "fg" | "accent", string>> = {};
  const applied: string[] = [];
  const refusals: StyleRefusal[] = [];

  for (const intent of intents) {
    if (overrides[intent.role] !== undefined) continue; // first resolved instruction per role wins

    if (intent.role === "ground") {
      if (context.ground === undefined) {
        refusals.push({ role: "ground", requested: intent.direction, reason: "no baseline ground to adjust — nothing to shade" });
        continue;
      }
      if (intent.direction === "darker") {
        overrides.ground = shade(context.ground, -SHADE_STEP_PERCENT);
        applied.push("ground/darker");
      } else if (intent.direction === "lighter") {
        overrides.ground = shade(context.ground, SHADE_STEP_PERCENT);
        applied.push("ground/lighter");
      }
      continue;
    }

    if (intent.role === "fg" && intent.direction === "more-contrast") {
      if (context.ground === undefined || context.fg === undefined) {
        refusals.push({ role: "fg", requested: "more contrast", reason: "no ground/fg baseline to push apart" });
        continue;
      }
      const pushed = pushContrast(context.fg, context.ground);
      overrides.fg = pushed.hex;
      applied.push(`fg/more-contrast → ${pushed.ratio.toFixed(2)}:1`);
      continue;
    }

    if ((intent.role === "fg" || intent.role === "accent") && intent.direction === "hue") {
      if (intent.hue === undefined) continue;
      const resolved = resolveNamedColor(intent.hue, context.ring);
      if (resolved === undefined) {
        refusals.push({ role: intent.role, requested: intent.hue, reason: `"${intent.hue}" is not a recognized colour` });
        continue;
      }
      overrides[intent.role] = resolved.hex;
      if (!resolved.fromKit) {
        applied.push(`${intent.hue}: no kit colour matched, used ${resolved.hex} (not a brand colour)`);
      }
    }
  }

  return { overrides, applied, refusals };
}

/**
 * Tier 1 — the deterministic parser. Pure: no clock, no RNG, no I/O, and
 * directly unit-testable on its own (the "Tier 1 is pure" acceptance line).
 * Returns `source: "none"` when the closed vocabulary matches nothing at
 * all, which is how the top-level `parseStyleDirective` decides whether
 * Tier 2 is even worth considering.
 */
export function runDeterministicParser(text: string, context: StyleDirectiveContext): StyleDirectiveResult {
  const clauses = splitClauses(text);
  const overrides: Partial<Record<"ground" | "fg" | "accent", string>> = {};
  const applied: string[] = [];
  const intents: StyleIntent[] = [];

  for (const clause of clauses) {
    const explicit = matchExplicitHex(clause);
    if (explicit !== undefined && overrides[explicit.role] === undefined) {
      overrides[explicit.role] = explicit.hex;
      continue;
    }
    const intent = matchIntent(clause);
    if (intent !== undefined) intents.push(intent);
  }

  if (MORE_CONTRAST_RE.test(text) && overrides.fg === undefined && !intents.some((i) => i.role === "fg")) {
    intents.push({ role: "fg", direction: "more-contrast" });
  }

  const resolved = applyIntents(
    intents.filter((intent) => overrides[intent.role] === undefined),
    context,
  );
  for (const [role, hex] of Object.entries(resolved.overrides)) {
    if (overrides[role as "ground" | "fg" | "accent"] === undefined) overrides[role as "ground" | "fg" | "accent"] = hex;
  }

  const hasAnything = Object.keys(overrides).length > 0 || intents.length > 0 || resolved.refusals.length > 0;
  if (!hasAnything) {
    return { overrides: {}, applied: [], intents: [], refusals: [], source: "none" };
  }

  return finalize(overrides, [...applied, ...resolved.applied], intents, resolved.refusals, context, "parsed");
}

/** Applies the shared 4.5:1 pair floor (`TEXT_CONTRAST_FLOOR`) to whatever ground/fg this tier is about to hand back, and stamps every returned hex as `HEX_COLOR`-valid by construction. */
function finalize(
  overrides: Partial<Record<"ground" | "fg" | "accent", string>>,
  applied: string[],
  intents: StyleIntent[],
  refusals: StyleRefusal[],
  context: StyleDirectiveContext,
  source: "structured" | "parsed" | "model",
): StyleDirectiveResult {
  const out: Partial<Record<"ground" | "fg" | "accent", string>> = { ...overrides };
  const allRefusals = [...refusals];

  const effGround = out.ground ?? context.ground;
  const effFg = out.fg ?? context.fg;
  if (effGround !== undefined && effFg !== undefined) {
    const ratio = contrastRatio(effGround, effFg);
    if (ratio < TEXT_CONTRAST_FLOOR) {
      allRefusals.push({
        role: "pair",
        requested: `${effGround} / ${effFg}`,
        reason: `the resulting ground/fg pair falls below the ${TEXT_CONTRAST_FLOOR}:1 contrast floor`,
        contrastRatio: ratio,
      });
      delete out.ground;
      delete out.fg;
    }
  }

  return {
    overrides: out as StyleOverrides,
    applied,
    intents,
    refusals: allRefusals,
    source: Object.keys(out).length > 0 ? source : allRefusals.length > 0 ? source : "none",
  };
}

const ModelDirectiveSchema = z.object({
  intents: z
    .array(
      z.object({
        role: z.enum(["ground", "fg", "accent"]),
        direction: z.enum(["darker", "lighter", "more-contrast", "hue"]),
        hue: z.string().min(1).max(40).optional(),
      }),
    )
    .max(8)
    .default([]),
});

/**
 * `commodity`, not `pinned`: extracting "darker"/"lighter"/a colour word
 * from a sentence the closed-vocabulary parser already tried and failed on
 * is not a brand-voice judgment call — it's structured-output extraction,
 * the same class of task `haiku` model already serves elsewhere in this
 * repo (see `create-model-router-from-env.ts`'s own `haiku` alias).
 */
function tier2Policy(): ModelPolicy {
  return resolveModelPolicy("style-directive", { policy: "commodity", model: "claude-haiku-4-5-20251001" });
}

/**
 * Tier 2 — one model call, extracting `StyleIntent[]` from free text the
 * closed vocabulary couldn't parse. The model NEVER produces a hex directly:
 * its intents are resolved through the exact same `applyIntents` Tier 1
 * uses, so a model-invented colour name still only ever resolves to a real
 * kit colour or a `NAMED_COLORS` fallback, never an arbitrary hex the model
 * made up. Any failure — a thrown error, a schema mismatch, an empty result
 * — degrades to `{ overrides: {}, source: "none" }` plus a refusal. Never
 * throws.
 */
async function runModelTier(
  text: string,
  context: StyleDirectiveContext,
  router: ModelRouter,
): Promise<StyleDirectiveResult> {
  try {
    const prompt = [
      "A person reviewing an Instagram carousel post left this feedback about its VISUAL STYLE only",
      "(ignore anything about the copy/wording/claims — a separate step handles that).",
      "",
      `Feedback: "${text.replace(/"/g, "'")}"`,
      "",
      "Extract which of the post's ground (background), fg (text), and/or accent colours the person",
      "wants changed, and in what direction: darker, lighter, more-contrast (fg only), or hue (naming",
      "a colour word — put the colour word itself in `hue`, e.g. \"orange\", not a hex code).",
      "If the feedback says nothing about visual style at all, return an empty `intents` array.",
    ].join("\n");

    const result = await router.complete(prompt, ModelDirectiveSchema, tier2Policy());
    const intents = result.output.intents as StyleIntent[];
    if (intents.length === 0) {
      return { overrides: {}, applied: [], intents: [], refusals: [], source: "none" };
    }
    const resolved = applyIntents(intents, context);
    return finalize(resolved.overrides, resolved.applied, intents, resolved.refusals, context, "model");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      overrides: {},
      applied: [],
      intents: [],
      refusals: [{ role: "pair", requested: text, reason: `style-directive model call failed: ${message}` }],
      source: "none",
    };
  }
}

/**
 * The top-level resolver — Tier 0, then Tier 1, then (only if warranted)
 * Tier 2. This is the function `04g-style-directive` (IGSTYLE-3) calls.
 */
export async function parseStyleDirective(
  input: StyleDirectiveInput,
  context: StyleDirectiveContext,
  deps: StyleDirectiveDeps,
): Promise<StyleDirectiveResult> {
  // Tier 0 — structured, authoritative, bypasses parsing entirely.
  if (input.style !== undefined && Object.keys(input.style).length > 0) {
    const style = input.style;
    // The pair-floor check below only reasons about ground/fg; the other four
    // roles pass through untouched — they don't participate in the text-
    // contrast floor at all (see `brand-render-tokens.ts`'s own cssVars split).
    const pairRoles: Partial<Record<"ground" | "fg" | "accent", string>> = {};
    if (style.ground !== undefined) pairRoles.ground = style.ground;
    if (style.fg !== undefined) pairRoles.fg = style.fg;
    if (style.accent !== undefined) pairRoles.accent = style.accent;

    const result = finalize(pairRoles, [], [], [], context, "structured");
    return {
      ...result,
      overrides: {
        ...result.overrides,
        ...(style.surface !== undefined ? { surface: style.surface } : {}),
        ...(style.fg2 !== undefined ? { fg2: style.fg2 } : {}),
        ...(style.line !== undefined ? { line: style.line } : {}),
        ...(style.accentInk !== undefined ? { accentInk: style.accentInk } : {}),
      } as StyleOverrides,
    };
  }

  const text = input.feedback?.trim();
  if (text === undefined || text.length === 0) {
    return { overrides: {}, applied: [], intents: [], refusals: [], source: "none" };
  }

  // Tier 1 — deterministic, closed vocabulary.
  const tier1 = runDeterministicParser(text, context);
  if (tier1.source !== "none") return tier1;

  // Tier 2 — only when free text plausibly concerns style at all. "love it,
  // ship it" must never reach the model.
  if (!looksStyleRelated(text)) {
    return { overrides: {}, applied: [], intents: [], refusals: [], source: "none" };
  }
  return runModelTier(text, context, deps.router);
}
