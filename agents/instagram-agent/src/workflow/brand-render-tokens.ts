import { HEX_COLOR } from "@agent-engine/core";
import {
  planBrandLogoPlacement,
  readBrandLogoInk,
  type BrandLogoDownload,
  type BrandLogoPlacement,
} from "@agent-engine/tool-karos-media";
import type { BrandTokens } from "./types.js";

/**
 * The Brand Kit's render half: turns a client's `client/brand.json` (portal-
 * authored, loose-shaped — see `ClientBrand` in karos-client's `get-brand.ts`)
 * into the CSS custom properties, font loads, and standing brand furniture
 * (logo, handle) the slide templates consume.
 *
 * Everything here is pure and deliberately conservative: a value that cannot
 * be derived with confidence is DROPPED, never guessed — the same
 * refuse-to-guess rule `renderGlobalsCss` applies in karos-landing and the
 * legacy brand-schema spelled out as "never silently invent a hex." A client
 * with no derivable ground still gets accent, fonts, logo, and handle, which
 * is most of perceived branding; a client with nothing derivable renders
 * exactly as before this module existed.
 */

/** What the render pipeline needs from a brand kit, post-derivation and post-sanitization. */
export interface BrandRenderTokens {
  /** `--bg`/`--fg`-and-friends overrides. Never contains `--accent` (see `buildBrandHeadHtml`). */
  cssVars: Record<string, string>;
  /** Google-Fonts families to load, deduped, already name-sanitized. */
  fontFamilies: string[];
  /** The brand accent, for `assembleSlidesData`'s existing accent channel — never emitted as a CSS var here. */
  brandAccent?: string;
  logoUrl?: string;
  /**
   * Set when `brand.logoUrl` WAS present but was rejected here at
   * derivation because `downloadBrandLogo` (`@agent-engine/tool-karos-media`)
   * will not fetch it — currently: a `gs://` URI (SCRUM-383). Never set
   * together with `logoUrl`.
   *
   * This is what lets a trace tell "a logo was configured but rejected"
   * apart from "no logo was configured at all" — both would otherwise
   * collapse to `logoUrl === undefined`, which is exactly the silent dead
   * end this ticket exists to close. See `assessBrandAssetPresence` in
   * `visual-qa-pre-checks.ts`, which surfaces this as a distinct
   * `present: false` reason rather than a bare "logo absent."
   */
  rejectedLogoUrlReason?: string;
  /** Normalized to exactly one leading `@`. */
  handle?: string;
  /** Which visual treatment the badge/eyebrow components use. Always present — `plain` is the no-signal default. */
  badgeStyle: BadgeStyle;
  /**
   * The accent rotation ring: kit colors only, ordered, deduped, `[0]` always
   * the brand accent so slide 0 of an unseeded carousel renders exactly as it
   * did before rotation existed. Length 1 (or 0) means this kit CANNOT vary —
   * see `paletteForSlide`, which reports that as `rotates: false` rather than
   * pretending. Built by `buildAccentRing`; never a color the kit didn't ship.
   */
  palette: string[];
}

/**
 * The badge/eyebrow style variants, implemented once in `BADGE_VARIANT_CSS`
 * below and shared by every client:
 *
 * - `pill`      — solid accent-filled rounded pill (the "PITCH SCHOOL |
 *                 LESSON 15" series-badge look).
 * - `brackets`  — mono face inside literal `{ … }` code framing with a thin
 *                 accent border (the Geektime terminal-tag look).
 * - `underline` — mono label over a short accent rule.
 * - `plain`     — the tracked-out mono eyebrow the templates always had.
 *
 * Every variant draws exclusively from the brand vars (`--accent`,
 * `--accent-ink`, `--f-mono`, ground/fg), so ANY client's badges are branded
 * the moment their brand.json exists — the variant only chooses the shape.
 */
export type BadgeStyle = "pill" | "brackets" | "underline" | "plain";
const BADGE_STYLES: readonly BadgeStyle[] = ["pill", "brackets", "underline", "plain"];

// HEX_COLOR (IGSTYLE-1): imported from `@agent-engine/core` above — this
// module used to define its own byte-identical copy; it now consumes the
// single source of truth instead, so the render-time check and the
// reviewer-input check (`StyleEditSchema`) can never drift apart.

/**
 * Space/alphanumeric only — real Google-Fonts families are, and anything
 * wider would need CSS-string AND URL escaping to be safe in both places
 * this value lands (a `font-family` declaration and a css2 URL).
 */
const FONT_FAMILY = /^[A-Za-z0-9 ]{1,60}$/;

const HANDLE = /^@?[A-Za-z0-9._]{1,40}$/;

/** The css2 origin every template's hardcoded font link already uses. */
const GOOGLE_FONTS_CSS2 = "https://fonts.googleapis.com/css2";

/** The fallback stacks the templates' own `:root` blocks declare — a brand face slots in FRONT of these, never instead of them. */
const FALLBACK_STACKS = {
  display: "Georgia, 'Times New Roman', serif",
  body: "system-ui, -apple-system, sans-serif",
  mono: "ui-monospace, monospace",
} as const;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asHex(value: unknown): string | undefined {
  const s = asString(value);
  return s !== undefined && HEX_COLOR.test(s) ? s : undefined;
}

function asFontFamily(value: unknown): string | undefined {
  const s = asString(value);
  return s !== undefined && FONT_FAMILY.test(s) ? s : undefined;
}

/** WCAG relative luminance of a #rgb/#rrggbb hex (alpha digits, if present, are ignored — ground/fg are opaque by design). */
function relativeLuminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const channel = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two hex colors, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Straight-line RGB distance, for the structural ground rule below. */
function rgbDistance(a: string, b: string): number {
  const parse = (hex: string) => {
    let h = hex.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return Math.sqrt((r1! - r2!) ** 2 + (g1! - g2!) ** 2 + (b1! - b2!) ** 2);
}

/**
 * Body text on the templates renders at ~92% fg opacity over the ground, so
 * the floor is checked on the pair as authored. 4.5:1 is WCAG AA for normal
 * text — below it, the ground/fg pair is dropped ENTIRELY (never "fixed" by
 * nudging a color the client didn't pick): unreadable slides are the render-
 * domain version of an invented hex.
 */
const CONTRAST_FLOOR = 4.5;

/**
 * Decides which neutral is the ground (slide background) and which is the
 * text color, without trusting free prose more than necessary:
 *
 * (A) STRUCTURAL — if `dominantColors` names a rank-1 hex, the neutral
 *     nearer to it in RGB space is the ground. A brand's most dominant color
 *     being its ground is a sound prior, and it uses data the palette
 *     extractor actually computed rather than words someone typed.
 * (B) LEXICAL — word-boundary match on `visualStyle`, and only when the two
 *     directions don't BOTH match ("clean light aesthetic with dark accents"
 *     is no signal, not a dark signal).
 * (C) REFUSE — no signal, no override. Accent/fonts/logo/handle still apply.
 */
function deriveGroundAndFg(brand: Record<string, unknown>): { ground: string; fg: string } | undefined {
  const colors = (brand["colors"] ?? {}) as Record<string, unknown>;
  const neutralDark = asHex(colors["neutralDark"]);
  const neutralLight = asHex(colors["neutralLight"]);
  if (neutralDark === undefined || neutralLight === undefined) return undefined;

  const darkGround = { ground: neutralDark, fg: neutralLight };
  const lightGround = { ground: neutralLight, fg: neutralDark };

  const dominant = brand["dominantColors"];
  if (Array.isArray(dominant)) {
    const rank1 = dominant
      .map((c) => c as Record<string, unknown>)
      .sort((a, b) => Number(a["dominanceRank"] ?? 99) - Number(b["dominanceRank"] ?? 99))
      .map((c) => asHex(c["hex"]))
      .find((h) => h !== undefined);
    if (rank1 !== undefined) {
      return rgbDistance(rank1, neutralDark) <= rgbDistance(rank1, neutralLight) ? darkGround : lightGround;
    }
  }

  const style = asString(brand["visualStyle"]) ?? "";
  const saysDark = /\b(dark|black|night|noir)\b/i.test(style);
  const saysLight = /\b(light|bright|airy|clean|minimal|minimalist)\b/i.test(style);
  if (saysDark !== saysLight) return saysDark ? darkGround : lightGround;

  return undefined;
}

/**
 * Which badge/eyebrow variant a client gets when nobody set
 * `renderTokens.badgeStyle` explicitly. Same refuse-to-guess ladder as the
 * colors — the signals are real brand data, and "plain" (today's look, drawn
 * from the client's own accent and mono face) is the honest floor, so every
 * client lands on SOME branded treatment.
 */
function deriveBadgeStyle(brand: Record<string, unknown>, ground: string | undefined): BadgeStyle {
  const fonts = (brand["fonts"] ?? {}) as Record<string, unknown>;
  const style = asString(brand["visualStyle"]) ?? "";
  const bodyFont = asString(fonts["body"]) ?? "";
  // A mono-leaning identity reads as the terminal/code look.
  if (/\bmono\b/i.test(bodyFont) || /\b(tech|terminal|code|developer|hacker)\b/i.test(style)) return "brackets";
  // A light ground carries a solid accent pill well; on a dark ground the
  // quiet tracked-out mono eyebrow is the safer default.
  if (ground !== undefined && relativeLuminance(ground) > 0.5) return "pill";
  return "plain";
}

// ─────────────────────────────────────────────────────────────────────────
// Seeded palette rotation across carousel slides and video covers (AU39)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The most colors the ring will carry. Past about six a rotation stops
 * reading as one identity and starts reading as a swatch dump.
 */
const ACCENT_RING_MAX = 6;

/**
 * The floor a kit color must clear AGAINST THE GROUND before the rotation is
 * allowed to promote it to an accent. 3:1 is WCAG AA for large text and
 * non-text UI, which is what an accent actually renders as here (display
 * type, rules, badge fills) — the 4.5:1 body floor above is a different job.
 *
 * This is the guard that can fail: a kit color the portal explicitly labelled
 * an accent is still refused when it would disappear into the ground. Only
 * the ANCHOR is exempt, because the anchor is the accent already shipping on
 * every slide today and dropping it would be a regression wearing a guard's
 * clothes, not a fix.
 */
const ACCENT_GROUND_CONTRAST_FLOOR = 3;

/** `brand.colors` keys that name the ground/text furniture rather than an accent. */
const NEUTRAL_COLOR_KEY = /neutral|background|ground|surface|text|ink|border|line/i;

/** `dominantColors[].role` values that describe furniture rather than an accent. */
const NON_ACCENT_ROLE = /ground|background|neutral|surface|text|ink/i;

/**
 * How far a video cover's phase sits from slide 0 of the same post, so a
 * cover and the first carousel slide of one run don't render as twins.
 */
const COVER_PHASE_OFFSET = 1;

/** Which surface a slot renders on. Covers get their own phase (`COVER_PHASE_OFFSET`). */
export type PaletteSurface = "slide" | "cover";

/** Addresses one renderable slot. Same address + same ring ⇒ same colors, always. */
export interface PaletteSlot {
  /** Zero-based position: carousel slide number, or the cover's own index. Non-finite is treated as 0. */
  index: number;
  /** Defaults to `"slide"`. */
  surface?: PaletteSurface;
  /**
   * A stable per-run string (the run's `postId` is the intended one) that
   * chooses WHERE on the ring this post starts. Omitted or empty means phase
   * 0 — the accent, exactly as before. It must be stable across a resume:
   * a clock or a random value here would make every visual regression
   * unfalsifiable, which is the whole reason this is seeded and not random.
   */
  seed?: string;
}

/** The colors one slot renders with. Both are ring members — never derived, never invented. */
export interface SlidePalette {
  accent: string;
  /** The next color on the ring, for a supporting mark. Equals `accent` only on a one-color ring. */
  secondary: string;
  /**
   * Whether this kit can actually vary. `false` means the ring holds one
   * color and every slot returns it — stated plainly so a caller never reads
   * a constant as working variation.
   */
  rotates: boolean;
}

/** FNV-1a 32-bit. Pure, no clock, no randomness — the seed is the only input. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Floor-mod, so a negative index still lands on the ring. */
function ringMod(value: number, length: number): number {
  const m = Math.trunc(value) % length;
  return m < 0 ? m + length : m;
}

/**
 * Every hex the Brand Kit actually ships, in the order the rotation should
 * prefer them: hand-authored `brandTokens.palette` first (explicit beats
 * derived, the same ladder the rest of this module uses), then the named
 * non-neutral roles in `brand.colors`, then the extracted `dominantColors`
 * most-dominant first. Anything that isn't a valid hex is DROPPED here, not
 * repaired.
 */
function kitAccentCandidates(b: Record<string, unknown>, brandTokens: BrandTokens): string[] {
  const out: string[] = [];

  for (const entry of Array.isArray(brandTokens.palette) ? brandTokens.palette : []) {
    const hex = asHex(entry);
    if (hex !== undefined) out.push(hex);
  }

  const colors = b["colors"];
  if (Array.isArray(colors)) {
    // The loose `ClientBrand.colors?: string[]` shape carries no role names,
    // so the ground/fg exclusion and the contrast floor below are the only
    // things separating an accent from a neutral here.
    for (const entry of colors) {
      const hex = asHex(entry);
      if (hex !== undefined) out.push(hex);
    }
  } else if (typeof colors === "object" && colors !== null) {
    for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
      if (NEUTRAL_COLOR_KEY.test(key)) continue;
      const hex = asHex(value);
      if (hex !== undefined) out.push(hex);
    }
  }

  const dominant = b["dominantColors"];
  if (Array.isArray(dominant)) {
    const ranked = [...dominant]
      .map((c) => c as Record<string, unknown>)
      .sort((a, z) => Number(a["dominanceRank"] ?? 99) - Number(z["dominanceRank"] ?? 99));
    for (const entry of ranked) {
      if (NON_ACCENT_ROLE.test(asString(entry["role"]) ?? "")) continue;
      const hex = asHex(entry["hex"]);
      if (hex !== undefined) out.push(hex);
    }
  }

  return out;
}

/**
 * Builds the rotation ring. The anchor (today's accent) goes first and is
 * exempt from the contrast check; every candidate after it must be a
 * different color from the ground/fg pair and must clear
 * `ACCENT_GROUND_CONTRAST_FLOOR` against the ground.
 *
 * With NO derivable ground there is nothing to check legibility against, so
 * nothing is promoted and the ring stays at the anchor — the same
 * refuse-to-guess rule the ground/fg derivation follows. A rotation is worth
 * less than an unreadable slide.
 */
function buildAccentRing(
  anchor: string | undefined,
  candidates: readonly string[],
  ground: string | undefined,
  fg: string | undefined,
): string[] {
  const ring: string[] = [];
  const seen = new Set<string>();
  const take = (hex: string): void => {
    const key = hex.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ring.push(hex);
  };

  if (anchor !== undefined) take(anchor);
  if (ground === undefined) return ring;

  const furniture = new Set([ground.toLowerCase(), ...(fg !== undefined ? [fg.toLowerCase()] : [])]);
  for (const hex of candidates) {
    if (ring.length >= ACCENT_RING_MAX) break;
    if (furniture.has(hex.toLowerCase())) continue;
    if (contrastRatio(hex, ground) < ACCENT_GROUND_CONTRAST_FLOOR) continue;
    take(hex);
  }
  return ring;
}

/**
 * The colors one slide or cover renders with — a guided walk around
 * `tokens.palette`, one step per slide, phase-shifted by the run seed and
 * again for covers.
 *
 * SEEDED, NOT RANDOM: `(ring, index, surface, seed)` is the whole input, so
 * the same run renders the same way twice and a visual diff between two runs
 * of the same post means something changed. Nothing here reads a clock or a
 * random source.
 *
 * Returns `undefined` for an empty ring (a client with no derivable kit
 * color) — the caller keeps whatever accent it already uses. A one-color
 * ring returns that color for every slot with `rotates: false`: the honest
 * report that this kit has nothing to rotate, rather than a constant dressed
 * up as variation.
 */
export function paletteForSlide(tokens: Pick<BrandRenderTokens, "palette">, slot: PaletteSlot): SlidePalette | undefined {
  const ring = tokens.palette;
  if (ring.length === 0) return undefined;

  const index = Number.isFinite(slot.index) ? slot.index : 0;
  const phase = slot.seed !== undefined && slot.seed.length > 0 ? fnv1a32(slot.seed) : 0;
  const surfaceOffset = slot.surface === "cover" ? COVER_PHASE_OFFSET : 0;
  const pos = ringMod(phase + surfaceOffset + index, ring.length);

  return {
    accent: ring[pos]!,
    secondary: ring[ringMod(pos + 1, ring.length)]!,
    rotates: ring.length > 1,
  };
}

/**
 * Derives the render tokens for one client. `brand` is `client.getBrand`'s
 * raw result (untrusted, portal-authored); `brandTokens` is the frozen
 * `instagramBrandTokens`, whose optional `renderTokens` is the explicit
 * hand-authored override that beats every derivation here.
 *
 * Returns `undefined` when there is nothing brand-derived to apply at all —
 * the caller renders exactly as it did before brand kits existed.
 */
export function deriveBrandRenderTokens(brand: unknown, brandTokens: BrandTokens): BrandRenderTokens | undefined {
  const b = (typeof brand === "object" && brand !== null ? brand : {}) as Record<string, unknown>;
  const overrides = brandTokens.renderTokens ?? {};

  const cssVars: Record<string, string> = {};
  const fontFamilies: string[] = [];

  // ── ground/fg: explicit override > derivation > refuse ──
  const explicitGround = asHex(overrides.ground);
  const explicitFg = asHex(overrides.fg);
  let ground: string | undefined;
  let fg: string | undefined;
  if (explicitGround !== undefined && explicitFg !== undefined) {
    ground = explicitGround;
    fg = explicitFg;
  } else {
    const derived = deriveGroundAndFg(b);
    ground = derived?.ground;
    fg = derived?.fg;
  }
  // The contrast floor applies to BOTH sources — it protects the explicit
  // path against a portal typo exactly as much as the derived one.
  if (ground !== undefined && fg !== undefined && contrastRatio(ground, fg) < CONTRAST_FLOOR) {
    ground = undefined;
    fg = undefined;
  }
  if (ground !== undefined && fg !== undefined) {
    cssVars["--bg"] = ground;
    cssVars["--fg"] = fg;
  }

  for (const [key, varName] of [
    ["surface", "--surface"],
    ["fg2", "--fg2"],
    ["line", "--line"],
    ["accentInk", "--accent-ink"],
  ] as const) {
    const value = asHex(overrides[key]);
    if (value !== undefined) cssVars[varName] = value;
  }

  // ── fonts: explicit override > brand.json families > none ──
  const display = asFontFamily(overrides.fontDisplay) ?? asFontFamily((b["fonts"] as Record<string, unknown> | undefined)?.["heading"]);
  const body = asFontFamily(overrides.fontBody) ?? asFontFamily((b["fonts"] as Record<string, unknown> | undefined)?.["body"]);
  const mono = asFontFamily(overrides.fontMono);
  if (display !== undefined) {
    cssVars["--f-display"] = `'${display}', ${FALLBACK_STACKS.display}`;
    fontFamilies.push(display);
  }
  if (body !== undefined) {
    cssVars["--f-body"] = `'${body}', ${FALLBACK_STACKS.body}`;
    fontFamilies.push(body);
  }
  if (mono !== undefined) {
    cssVars["--f-mono"] = `'${mono}', ${FALLBACK_STACKS.mono}`;
    fontFamilies.push(mono);
  }

  // ── accent: explicit override (IGSTYLE-3) > client/brand.json > nothing ──
  //
  // `overrides.accent` was added at IGSTYLE-1 (see this file's `renderTokens`
  // doc comment there) but deliberately left inert — this is the line that
  // actually wires it in, completing the same "explicit override beats
  // derivation" ladder every other field here already follows. Extracted for
  // `assembleSlidesData`'s EXISTING accent channel; never emitted as a var.
  const brandAccent =
    asHex(overrides.accent) ?? asHex(b["accent"]) ?? asHex((b["colors"] as Record<string, unknown> | undefined)?.["primaryAccent"]);

  // ── palette ring: the accent, then whatever else the kit legibly ships ──
  // Deliberately NOT part of `hasAnything` below: the ring is built from the
  // same sources as the fields that already decide it, so it must never be
  // the thing that turns an otherwise-empty kit into a present one.
  const palette = buildAccentRing(brandAccent, kitAccentCandidates(b, brandTokens), ground, fg);

  // ── logo: https:// only (SCRUM-383) ──
  //
  // `downloadBrandLogo` fetches nothing but https:// — it always has. This
  // used to accept `gs://` here and pass it straight through as `logoUrl`,
  // so it reached `downloadBrandLogo`, which refused it on its very first
  // line with no diagnostic. The two functions disagreeing produced a
  // silent dead end: a `gs://` logoUrl rendered no logo, no error, no held
  // run — indistinguishable from a client with no logoUrl configured at
  // all.
  //
  // Fixed here, at the source, rather than by teaching `downloadBrandLogo`
  // to resolve `gs://` to a signed https URL: this pipeline has no GCS
  // client or credentials wired into it anywhere (`brand-logo.ts`'s own
  // header is explicit about adding no dependency for the logo path), and
  // nothing today ever writes a raw `gs://` logoUrl into a BrandKit — GCS
  // is served via signed https already (see the ticket). Agreeing the two
  // functions and failing loudly is the smaller, dependency-free change,
  // and it matches `videoBrand.logoUrl`'s derivation in tiktok-agent's own
  // workflow, which already accepts only `https://` here.
  //
  // "Loudly" means `rejectedLogoUrlReason`, not a thrown error: a logo is
  // brand furniture and must never be able to hold a run (the same
  // invariant `brand-logo.ts` and this workflow's own `brandFragments`
  // state repeatedly) — so the run still completes without a logo, exactly
  // as it does for every other undownloadable logoUrl, but the REASON is
  // now a real, attributable fact in the trace instead of silence.
  //
  // Deliberately scoped to `gs://` specifically, not every non-https
  // scheme: a `javascript:`/`file://` value is not a real-world BrandKit
  // misconfiguration this ticket is about, and it keeps failing the same
  // way it always has (silently dropped, as if absent) rather than being
  // widened into a new class of "loud" rejection this ticket never asked
  // for.
  let logoUrl: string | undefined;
  let rejectedLogoUrlReason: string | undefined;
  {
    const url = asString(b["logoUrl"]);
    if (url !== undefined) {
      if (/^https:\/\//i.test(url)) {
        logoUrl = url;
      } else if (/^gs:\/\//i.test(url)) {
        rejectedLogoUrlReason =
          `brand logoUrl "${url}" is a gs:// URL, not https:// — downloadBrandLogo (@agent-engine/tool-karos-media) ` +
          "fetches only https:// URLs, so this logo is rejected here at derivation (SCRUM-383) rather than being " +
          "passed through to fail silently downstream";
      }
    }
  }

  const handle = (() => {
    const raw = asString(b["handle"]);
    if (raw === undefined || !HANDLE.test(raw)) return undefined;
    return `@${raw.replace(/^@+/, "")}`;
  })();

  const badgeStyle: BadgeStyle =
    overrides.badgeStyle !== undefined && BADGE_STYLES.includes(overrides.badgeStyle as BadgeStyle)
      ? (overrides.badgeStyle as BadgeStyle)
      : deriveBadgeStyle(b, ground);

  const hasAnything =
    Object.keys(cssVars).length > 0 ||
    fontFamilies.length > 0 ||
    brandAccent !== undefined ||
    logoUrl !== undefined ||
    // A rejected gs:// logoUrl counts too — a client whose ENTIRE brand.json
    // is a bad logoUrl still needs this function to return an object, or the
    // rejection reason has nowhere to live and is lost exactly as silently
    // as before this fix.
    rejectedLogoUrlReason !== undefined ||
    handle !== undefined;
  if (!hasAnything) return undefined;

  return {
    cssVars,
    fontFamilies: [...new Set(fontFamilies)],
    ...(brandAccent !== undefined ? { brandAccent } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(rejectedLogoUrlReason !== undefined ? { rejectedLogoUrlReason } : {}),
    ...(handle !== undefined ? { handle } : {}),
    badgeStyle,
    palette,
  };
}

/**
 * The badge/eyebrow variant styles, shared by every client. Every rule draws
 * only on the brand vars, so the SAME variant looks different — and correctly
 * branded — per client. The variant class is stamped on `.eyebrow`/`.kicker`
 * (the model-authored per-slide label) and `.brand-badge` (the standing
 * series badge) alike by the selector list below.
 */
const BADGE_VARIANT_CSS: Record<BadgeStyle, string> = {
  plain: "",
  pill: [
    ".eyebrow, .kicker, .brand-badge {",
    "  background: var(--accent); color: var(--accent-ink, var(--bg));",
    "  padding: 8px 18px; border-radius: 999px; letter-spacing: 0.14em;",
    "}",
  ].join("\n"),
  brackets: [
    ".eyebrow, .kicker, .brand-badge {",
    "  border: 1px solid var(--accent); color: var(--accent);",
    "  padding: 6px 14px; border-radius: 4px; letter-spacing: 0.14em;",
    "}",
    '.eyebrow::before, .kicker::before, .brand-badge::before { content: "{ "; }',
    '.eyebrow::after, .kicker::after, .brand-badge::after { content: " }"; }',
  ].join("\n"),
  underline: [
    ".eyebrow, .kicker, .brand-badge {",
    "  border-bottom: 3px solid var(--accent); padding-bottom: 6px;",
    "}",
  ].join("\n"),
};

/**
 * Builds the head fragment `composeDocument` splices before `</head>`:
 * one Google-Fonts `<link>` PER family (css2 fails the WHOLE request if any
 * family in a batch is unknown, so one bad family must not kill the rest;
 * bare family names, no weight axes, because an axis a family lacks also
 * 400s the request — Chromium synthesizes bold from the regular face, which
 * is worse typography than true weights and far better than no brand face
 * at all), then one `<style>` carrying the var overrides and the badge
 * variant.
 *
 * Deliberately NEVER emits `--accent`: the sheet lands after the template's
 * own `<style>` and would silently override the per-slide `{{accentColor}}`
 * channel — the accent has exactly one channel, and it is that one.
 */
export function buildBrandHeadHtml(tokens: BrandRenderTokens, options: { logo?: BrandLogoPlacement } = {}): string {
  const parts: string[] = [];

  for (const family of tokens.fontFamilies) {
    const encoded = family.replace(/ /g, "+");
    parts.push(`<link href="${GOOGLE_FONTS_CSS2}?family=${encoded}&display=swap" rel="stylesheet">`);
  }

  const varLines = Object.entries(tokens.cssVars)
    .filter(([name]) => name !== "--accent")
    .map(([name, value]) => `  ${name}: ${value};`);

  const css: string[] = [];
  if (varLines.length > 0) css.push(`:root {\n${varLines.join("\n")}\n}`);
  // Standing brand furniture: the `@handle` watermark (bottom, start side —
  // the legacy logo corner's opposite) and the series badge (top, start
  // side). An EMPTY slot must vanish completely — a `pill` variant painting
  // an accent-filled background behind zero characters would otherwise ship
  // an empty pill on every slide of a client with no badge.
  css.push(".eyebrow:empty, .kicker:empty, .brand-badge:empty, .brand-handle:empty { display: none; }");
  css.push(
    [
      ".brand-handle {",
      "  position: absolute; bottom: 44px; inset-inline-start: 44px; z-index: 6;",
      "  font-family: var(--f-mono); font-size: 19px; letter-spacing: 0.08em;",
      "  color: color-mix(in srgb, var(--fg) 55%, transparent);",
      "}",
      ".brand-badge {",
      "  position: absolute; top: 56px; inset-inline-start: var(--mx, 64px); z-index: 6;",
      "  font-family: var(--f-mono); font-weight: 600; font-size: 19px;",
      "  letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent);",
      "}",
    ].join("\n"),
  );
  const variant = BADGE_VARIANT_CSS[tokens.badgeStyle];
  if (variant.length > 0) css.push(variant);
  const logoCss = brandLogoCss(options.logo);
  if (logoCss !== undefined) css.push(logoCss);
  if (css.length > 0) parts.push(`<style>\n${css.join("\n")}\n</style>`);

  return parts.join("\n");
}

/**
 * The logo's rules, emitted from the PLAN rather than from a fixed block.
 *
 * Every number here comes out of `planBrandLogoPlacement` — the corner, the
 * insets, the width, and (when the mark would otherwise disappear into the
 * ground) the scrim plate and the ratio that plate was chosen to clear. The
 * corner is a rule, not a constant: a client with a standing series badge
 * has that badge in the start-side corner already, so the mark takes the
 * other one. That is why `.brand-badge` no longer gets shoved sideways by a
 * magic 220px — the two pieces of furniture no longer share a corner at all.
 *
 * `undefined` for an omitted plan: no rules, and the caller emits no `<img>`
 * either, so an illegible mark renders as nothing rather than as a smudge.
 */
function brandLogoCss(placement: BrandLogoPlacement | undefined): string | undefined {
  if (placement === undefined || placement.decision === "omit") return undefined;
  const side = placement.corner === "top-end" ? "inset-inline-end" : "inset-inline-start";
  const rules = [
    ".brand-logo {",
    `  position: absolute; top: ${placement.insetBlockPx}px; ${side}: ${placement.insetInlinePx}px; z-index: 6;`,
    `  width: ${placement.widthPx}px; height: auto; display: block;`,
  ];
  if (placement.scrim !== undefined) {
    // The plate goes on the <img> itself: `background` shows through the
    // transparent ground of a PNG/SVG mark, and `content-box` padding keeps
    // `width` meaning the mark's width rather than the plate's.
    rules.push(
      `  box-sizing: content-box; background: ${placement.scrim.color};`,
      `  padding: ${placement.scrim.padPx}px; border-radius: ${placement.scrim.radiusPx}px;`,
    );
  }
  rules.push("}");
  return rules.join("\n");
}

/**
 * The default templates' own `:root { --bg: #17181C }`. A client whose kit
 * derives no ground still renders on THAT, so it is the background the
 * contrast check has to run against — checking against nothing, or against a
 * guessed white, would be the check quietly not happening.
 */
export const DEFAULT_TEMPLATE_GROUND = "#17181C";

/**
 * The one place the render path decides where this run's logo goes and
 * whether it is legible there.
 *
 * The ground is the token the mark will actually land on: the kit's `--bg`
 * override when it derived one, the templates' own ground otherwise. The
 * mark's colors are read from the DOWNLOADED BYTES — not from a field
 * anybody typed — so the ratio in the returned plan is a measurement of the
 * asset, not a claim about it.
 */
export function planBrandLogo(
  tokens: BrandRenderTokens,
  download: BrandLogoDownload,
  options: { hasSeriesBadge?: boolean } = {},
): BrandLogoPlacement {
  const ink = readBrandLogoInk(download);
  return planBrandLogoPlacement({
    ground: tokens.cssVars["--bg"] ?? DEFAULT_TEMPLATE_GROUND,
    ...(ink !== undefined ? { ink } : {}),
    ...(tokens.cssVars["--fg"] !== undefined ? { fg: tokens.cssVars["--fg"] } : {}),
    ...(options.hasSeriesBadge !== undefined ? { hasSeriesBadge: options.hasSeriesBadge } : {}),
    surface: "slide",
  });
}

/**
 * The body fragment for the logo — separate from the head fragment because
 * it splices before `</body>`, not `</head>`. The logo arrives as a data URI
 * (bytes fetched and content-type-verified by the caller), NEVER as a
 * `slide.images` path: a listed image path whose file vanished on a recycled
 * instance is a run-holding `content_fail`, and brand furniture must never
 * be able to hold a run. Absent logo = absent fragment = nothing renders.
 */
export function buildBrandLogoBodyHtml(logoDataUri: string): string {
  return `<img class="brand-logo" src="${logoDataUri}" alt="" />`;
}
