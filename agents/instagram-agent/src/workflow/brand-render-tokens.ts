import { HEX_COLOR } from "@agent-engine/core";
import {
  planBrandLogoPlacement,
  readBrandLogoInk,
  type BrandLogoDownload,
  type BrandLogoPlacement,
} from "@agent-engine/tool-karos-media";
import type { BrandTokens, StyleOverrides } from "./types.js";
import {
  BRAND_MARK_MAX_WIDTH_PX,
  BRAND_MARK_QUIET_OPACITY,
  BRAND_MARK_ZONE,
  clientVisualSystemCss,
  CONDENSED_DISPLAY_FONT_FAMILY,
  REGISTER_DISPLAY_FONT_FAMILY,
  displayFaceForScript,
  resolveDisplayRegisterForScript,
  type ClientVisualSystem,
} from "./visual-system.js";

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
 *
 * Exported for `script-fonts.ts`, which reads a client's already-emitted
 * `--f-*` stacks back out of the kit and must apply the SAME acceptance rule
 * before re-quoting a family into its own sheet — one rule, two emitters.
 */
export const FONT_FAMILY = /^[A-Za-z0-9 ]{1,60}$/;

const HANDLE = /^@?[A-Za-z0-9._]{1,40}$/;

/** The css2 origin every template's hardcoded font link already uses. */
export const GOOGLE_FONTS_CSS2 = "https://fonts.googleapis.com/css2";

/**
 * The fallback stacks the templates' own `:root` blocks declare — a brand
 * face slots in FRONT of these, never instead of them. Exported so the
 * script-font sheet (`script-fonts.ts`) ends its stacks on exactly the same
 * generic families the templates and this module do.
 */
export const FALLBACK_STACKS = {
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
 *
 * Exported (SCRUM-393/IGSTYLE-8): `visual-qa-pre-checks.ts`'s
 * `assessContrastFacts` reports against this exact floor rather than
 * re-declaring the number, so the fact-reporting half and the
 * gating/derivation half can never quietly drift apart.
 */
export const TEXT_CONTRAST_FLOOR = 4.5;

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
 *
 * Exported (SCRUM-393/IGSTYLE-8): `visual-qa-pre-checks.ts`'s
 * `assessContrastFacts` reports every USED accent against this same floor —
 * the anchor exemption above governs which colors are allowed INTO the
 * ring, not whether a low-contrast anchor is worth telling a human about
 * once it's there. See that ticket for why the anchor's exemption from
 * gating must not also exempt it from being reported.
 */
export const ACCENT_GROUND_CONTRAST_FLOOR = 3;

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
 * prefer them: the config's own `brandTokens.accentColor` first, then the
 * hand-authored `brandTokens.palette` (explicit beats derived, the same
 * ladder the rest of this module uses), then the named non-neutral roles in
 * `brand.colors`, then the extracted `dominantColors` most-dominant first.
 * Anything that isn't a valid hex is DROPPED here, not repaired.
 *
 * `brandTokens.accentColor` is a candidate at all because of a real prep
 * hold (run `pubsub-21634455753345065`, 2026-09): the config said `#ff6b2c`,
 * `client/brand.json` said `#d95f2b`, and the two sources of truth never
 * met — the ring was built from brand.json alone while the slides were
 * painted from the config, so `checkPaletteWithinKit` failed every attempt
 * and burned $0.86 on a disagreement no human had made. Both hexes are now
 * ring members, and the anchor below is the one that actually paints.
 */
function kitAccentCandidates(b: Record<string, unknown>, brandTokens: BrandTokens): string[] {
  const out: string[] = [];

  const configAccent = asHex(brandTokens.accentColor);
  if (configAccent !== undefined) out.push(configAccent);

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
  if (ground !== undefined && fg !== undefined && contrastRatio(ground, fg) < TEXT_CONTRAST_FLOOR) {
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

  // ── fonts: explicit override > brand kit, in every spelling a kit uses > none ──
  //
  // THIS READ WAS TOO NARROW AND A REAL CLIENT LOST ITS DISPLAY FACE TO IT.
  //
  // Measured on `karoslabs`, 2026-09-15. The portal's client record carries
  // `brandingGuidelines.fontHeading = "Space Grotesk"`; `client/brand.json`,
  // which is what this function is handed, carries `fonts.heading = "Inter"`.
  // Every headline the agent has ever rendered for that client has been Inter,
  // and the owner's complaint — *"you didn't use the company's fonts"* — is
  // exactly right.
  //
  // **The value is lost before it reaches this repo**, in whatever writes
  // `client/brand.json` from the client record, and that is where the real fix
  // belongs. What is wrong HERE is narrower and still worth fixing: this read
  // knew ONE spelling. A kit that says `fontHeading` at its root, or
  // `fonts.display`, or `typography.heading` — all shapes the portal and the
  // branding agents have used — silently produced no face at all and fell back
  // to the bundled stack, with no warning anywhere.
  //
  // So it reads every spelling, most specific first. A kit that carries none
  // still renders on the fallback stack exactly as before; a kit that carries
  // any of them now paints it.
  const brandFont = (...paths: Array<[string] | [string, string]>): string | undefined => {
    for (const path of paths) {
      const raw = path.length === 1 ? b[path[0]] : (b[path[0]] as Record<string, unknown> | undefined)?.[path[1]!];
      const family = asFontFamily(raw);
      if (family !== undefined) return family;
    }
    return undefined;
  };
  const display =
    asFontFamily(overrides.fontDisplay) ??
    brandFont(["fonts", "heading"], ["fonts", "display"], ["fontHeading"], ["fontDisplay"], ["typography", "heading"], ["typography", "display"]);
  const body = asFontFamily(overrides.fontBody) ?? brandFont(["fonts", "body"], ["fontBody"], ["typography", "body"]);
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

  // ── accent: explicit override (IGSTYLE-3) > config accentColor > client/brand.json > nothing ──
  //
  // `overrides.accent` was added at IGSTYLE-1 (see this file's `renderTokens`
  // doc comment there) but deliberately left inert — this is the line that
  // actually wires it in, completing the same "explicit override beats
  // derivation" ladder every other field here already follows. Extracted for
  // `assembleSlidesData`'s EXISTING accent channel; never emitted as a var.
  //
  // `brandTokens.accentColor` sits SECOND, above brand.json, because this
  // precedence must be the one the slides are actually painted with:
  // `assembleSlidesData` has always read `brandTokens.accentColor ??
  // brandAccentFallback`, so a ring anchored on brand.json while the config
  // disagreed put a hex on every slide that the ring never contained (see
  // `kitAccentCandidates`). The anchor is the single source of truth for
  // "what colour is slide 0", and it is now the same answer both places give.
  const brandAccent =
    asHex(overrides.accent) ??
    asHex(brandTokens.accentColor) ??
    asHex(b["accent"]) ??
    asHex((b["colors"] as Record<string, unknown> | undefined)?.["primaryAccent"]);

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
 * IGSTYLE-7's learned prior (Layer 1) filtered against the brand kit's own
 * accent ring BEFORE it is applied: a learned `accent` that is not a ring
 * member is DROPPED from `applied` and reported in `notes`; `ground`/`fg`
 * pass through untouched (they have their own contrast-floor refusal path in
 * `effectiveBrandKit`, and a ring says nothing about neutrals).
 *
 * Why a note and never an application: the ring is the single source of
 * truth for which accents this client's kit legally ships (`buildAccentRing`),
 * and a reviewer's past "loved the orange" vote must not be able to widen it
 * — a hex outside the ring is exactly what `checkPaletteWithinKit` exists to
 * refuse, so applying it here would set up the render to fail its own gate
 * three attempts later (the `pubsub-21634455753345065` hold, ~$0.30 per
 * three-attempt hold). Recording the preference instead keeps the signal
 * visible to the reviewer (the caller turns each note into a `StyleRefusal`
 * on the gate payload) with a one-line remedy: add the hex to the kit
 * palette and it becomes legal on the next run.
 *
 * An EMPTY ring means the kit has no opinion (a brandless client, or one
 * with no derivable accent), so nothing is filtered — the same refuse-to-
 * guess rule `checkPaletteWithinKit` applies to an empty kit. Membership is
 * case-insensitive, matching `buildAccentRing`'s own dedupe key. Pure;
 * `learned` is never mutated.
 */
export function filterLearnedStyleToRing(learned: StyleOverrides, ring: readonly string[]): { applied: StyleOverrides; notes: string[] } {
  const accent = asHex(learned.accent);
  if (accent === undefined || ring.length === 0) return { applied: { ...learned }, notes: [] };

  const members = new Set(ring.map((h) => h.toLowerCase()));
  if (members.has(accent.toLowerCase())) return { applied: { ...learned }, notes: [] };

  const { accent: _dropped, ...rest } = learned;
  return {
    applied: rest,
    notes: [
      `learned accent ${accent} is outside the brand kit's accent ring [${ring.join(", ")}] — recorded for the reviewer, ` +
        "not applied; add it to the kit palette to make it legal",
    ],
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
    // The badge follows the template's `--badge-ink` for the same reason the
    // base rule above does — a bracketed badge in the accent is just as
    // invisible on an accent ramp head as a plain one (1.51:1, measured). The
    // border moves with it so the variant still reads as one object. Where no
    // template declares the token, both fall back to the accent and the
    // variant is unchanged.
    ".brand-badge { border-color: var(--badge-ink, var(--accent)); color: var(--badge-ink, var(--accent)); }",
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
export function buildBrandHeadHtml(
  tokens: BrandRenderTokens,
  options: {
    logo?: BrandLogoPlacement;
    system?: ClientVisualSystem;
    /**
     * The run's target SCRIPT (`"Hebrew"`, `"Arabic"`, … — the names in
     * `language-gate.ts`'s `SCRIPT_TABLE`), or absent for every Latin run.
     *
     * Passed down to `clientVisualSystemCss`, which withholds the display
     * register's Latin face, tracking and face bleed on a script that face
     * cannot set. See `DISPLAY_REGISTER_SCRIPTS`: without it, a Hebrew geektime
     * carousel took Oswald's `-0.004em` tracking over the `normal` that
     * `script-fonts.ts` measured for Hebrew, and — in any composition where the
     * script sheet is absent — Oswald itself, for the Latin words only.
     */
    script?: string | undefined;
  } = {},
): string {
  const parts: string[] = [];

  const families = [...tokens.fontFamilies];
  // Phase 5.5, item D — the client's display register, when it needs a family
  // the bundled templates do not already load. One `<link>` of its own and
  // never appended to the templates' existing three-family request: css2 fails
  // the WHOLE request when any family in a batch is unknown, which is the same
  // reason this loop emits one link per family rather than one batched link.
  //
  // And only when the register is actually going to be USED: on a script
  // Oswald cannot set, `clientVisualSystemCss` withholds the face, so fetching
  // it would be one more css2 round trip in the render sandbox for a family no
  // selector names.
  const registerFamily =
    options.system !== undefined ? REGISTER_DISPLAY_FONT_FAMILY[options.system.displayRegister] : undefined;
  if (
    registerFamily !== undefined &&
    options.system !== undefined &&
    resolveDisplayRegisterForScript(options.system.displayRegister, options.script).covers &&
    !families.includes(registerFamily)
  ) {
    families.push(registerFamily);
  }
  // ── AND THE FACE THE REGISTER SETS WHEN ITS OWN CANNOT SET THE SCRIPT. ──
  // The other side of the same rule: on a script the register's Latin family
  // has no glyph for, `displayFaceForScript` names ONE face that carries both
  // scripts (see `DISPLAY_REGISTER_SCRIPT_FACES`) and the sheet below sets it,
  // so the family has to be fetched. `undefined` on every Latin run, so no
  // English document gains a link.
  const substitutedDisplay = options.system !== undefined ? displayFaceForScript(options.system.displayRegister, options.script) : undefined;
  if (substitutedDisplay !== undefined && !families.includes(substitutedDisplay.family)) {
    families.push(substitutedDisplay.family);
  }
  for (const family of families) {
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
  // `.brand-handle:has(> bdi:empty)` rides along with `:empty`, because the
  // bundled templates isolate the handle slot: `<div class="brand-handle"><bdi
  // dir="ltr">{{brandHandle}}</bdi></div>`. An `@handle`, a URL and a
  // `#hashtag` are LTR strings whose leading character is a bidi NEUTRAL, so
  // in a Hebrew or Arabic document they take the paragraph's own RTL
  // embedding level and lay out as `karoslabs@`. With the `<bdi>` in place the
  // div is never `:empty` again, and without this second selector a client
  // with no handle would ship an empty — but `pill`-painted — watermark box.
  css.push(".eyebrow:empty, .kicker:empty, .brand-badge:empty, .brand-handle:empty, .brand-handle:has(> bdi:empty) { display: none; }");
  // ── AND THE TWO SIZES BELOW ARE STEPS, NOT LITERALS, FOR THE SAME REASON
  //    THE INK IS THE TEMPLATE'S TO NAME. ──
  //
  // This block lands after the template's own <style>, so a `font-size: 19px`
  // here won against every template's `font-size: var(--t-micro)` in every
  // BRANDED run — which is every run that reaches this function. The result is
  // a guard that cannot fail: `template-furniture.test.ts` asserts that the
  // handle, the badge and the index are a step of the scale in all eight
  // files, all eight files comply, and the document a client actually receives
  // set two of the three at a hard 19px anyway. Measured through the
  // production composition on this tree: `bdi` (the handle's isolate) reports
  // 19px on every plate at every `fontScale`, while the index beside it —
  // which this sheet does not override — reports 22 / 18.7 / 26 as the
  // reviewer's control moves. One piece of standing furniture, two sizes, and
  // the smaller one deaf to the type scale.
  //
  // `var(--t-micro, 22px)` keeps the kit in charge of everything a kit should
  // own and takes the scale step where the scale has one; the literal stays as
  // the fallback, so a document composed without a run sheet still resolves to
  // exactly what this line used to say.
  css.push(
    [
      ".brand-handle {",
      "  position: absolute; bottom: 44px; inset-inline-start: 44px; z-index: 6;",
      "  font-family: var(--f-mono); font-size: var(--t-micro, 19px); letter-spacing: 0.08em;",
      "  color: color-mix(in srgb, var(--fg) 55%, transparent);",
      "}",
      ".brand-badge {",
      "  position: absolute; top: 56px; inset-inline-start: var(--mx, 64px); z-index: 6;",
      "  font-family: var(--f-mono); font-weight: 600; font-size: var(--t-micro, 19px);",
      // THE INK IS THE TEMPLATE'S TO NAME, AND THIS LINE IS WHY.
      //
      // This block lands AFTER the template's own <style> (`composeDocument`
      // splices the brand head last, so a kit beats a template on a
      // specificity tie — the whole point of a brand kit). A bare
      // `color: var(--accent)` here therefore won against every template's
      // own badge rule in every branded run, and on `cover.html` — the one
      // template whose badge stands on an ACCENT ramp head rather than on the
      // plate's dark ground — that painted accent on accent: measured 1.51:1
      // on the ramp head and 1.63:1 over a light photograph, orange on orange
      // and unreadable at the masthead, while the template's own fix sat
      // inert underneath it (`.local/fx-badge-kit.mts` renders the document
      // production composes, with and without this fragment; the badge note
      // in `cover.html` carries the whole table).
      //
      // `var(--badge-ink, var(--accent))` keeps the kit in charge of
      // everything a kit should own and lets the template name the one thing
      // only the template knows: what colour the badge's own ground is.
      // Seven of the eight bundled templates declare no `--badge-ink`, so the
      // fallback resolves to `var(--accent)` and their badges are
      // byte-identical to before.
      "  letter-spacing: 0.14em; text-transform: uppercase; color: var(--badge-ink, var(--accent));",
      "}",
    ].join("\n"),
  );
  const variant = BADGE_VARIANT_CSS[tokens.badgeStyle];
  if (variant.length > 0) css.push(variant);
  // Phase 5.5 — the per-CLIENT half of the visual system (the display face and
  // its weight/tracking, the composition grammar, the ground texture's alpha).
  // Here rather than in `visualSystemCssBlock` because a display face IS a
  // brand decision and because this fragment already owns the Google Fonts
  // `<link>` a non-default family needs. A client with no kit reaches none of
  // this and keeps the templates' own `--f-display`, which is the correct
  // degradation: the fleet default is a real face, just a shared one.
  if (options.system !== undefined) css.push(clientVisualSystemCss(options.system, { script: options.script }));
  // ── ONE HEADLINE, ONE TYPEFACE, ON A SCRIPT THE REGISTER CANNOT SET. ──
  //
  // `clientVisualSystemCss` withholds the register's Latin face on such a run
  // and leaves `script-fonts.ts`'s stack standing. That stack leads with the
  // CLIENT's own family, on purpose, so a Latin loanword keeps the brand face —
  // and on a headline that is two typefaces in one line, which the round-1
  // review names as a Major defect and which the owner's probe measures on
  // every display host of a Hebrew carousel.
  //
  // So the register names one face that carries both scripts and it is set
  // HERE rather than in that function, for two reasons that both matter:
  //
  //   * ON `body`, NOT `:root`. The script sheet declares `--f-display` on
  //     `body`, and a `:root` declaration loses to it on every element inside
  //     the body however late it is composed. The register's own note records
  //     that as the reason its axis was inert on Hebrew; this is the selector
  //     that is not.
  //   * IN THIS FRAGMENT. `clientVisualSystemCss` is pinned by
  //     `visual-system-axes-render.test.ts` to emit NO `--f-display` on a
  //     non-covering script, and that pin is right: what it must not emit is
  //     the register's LATIN face. This is a different declaration making the
  //     opposite claim — one face, for the script — and it belongs with the
  //     `<link>` that fetches it, which this fragment owns.
  //
  // Only the DISPLAY role moves. `--f-body` and `--f-mono` keep the script
  // pack's client-first order: a paragraph is read, not seen, and the brand's
  // face on its Latin runs there costs a reader nothing.
  if (substitutedDisplay !== undefined) {
    css.push(`body {\n  /* ${options.system?.displayRegister} set aside for ${options.script}: one face for the whole line. */\n  --f-display: ${substitutedDisplay.stack};\n}`);
  }
  // THE BRAND MARK'S RESERVED ZONE, from ONE partial, so the eight templates
  // cannot drift apart on it. Emitted even when the mark itself is omitted:
  // the zone rules are all `var(--logo-zone-*, 0px)` arithmetic, so with no
  // mark every one of them resolves to the layout the templates already had.
  css.push(brandMarkZoneCss(options.logo));
  // The headline's own measured contrast against the ground the mark also
  // lands on — the comparison `brandLogoCss` quiets an over-loud mark against.
  // Falls back to the templates' own `:root` pair, because that is what a
  // client with no derived tokens actually renders on; checking against a
  // guessed white would be the check quietly not happening.
  const headlineContrast = contrastRatio(tokens.cssVars["--fg"] ?? DEFAULT_TEMPLATE_FOREGROUND, tokens.cssVars["--bg"] ?? DEFAULT_TEMPLATE_GROUND);
  const logoCss = brandLogoCss(options.logo, Number.isFinite(headlineContrast) ? headlineContrast : undefined);
  if (logoCss !== undefined) css.push(logoCss);
  if (css.length > 0) parts.push(`<style>\n${css.join("\n")}\n</style>`);

  return parts.join("\n");
}

/**
 * ── ITEM F: THE MARK OWNS A ZONE, NOT A CORNER PREFERENCE. ──
 *
 * The owner: *"יש למעלה לוגו שלהם שזה מעולה, זה מבחינתי ממש טוב לכולם, אבל הוא
 * דורס כותרת"* — the mark is wanted on every client's slides, and it must stop
 * landing on top of things.
 *
 * `planBrandLogoPlacement` has only ever expressed a corner PREFERENCE, and it
 * computed that preference from the client's STANDING badge
 * (`hasSeriesBadge: frozen.brandTokens.seriesBadge !== undefined`) while the
 * SERIES badge was written later in the same run. For geektime the standing
 * badge was absent, so the mark chose `top-start` — the corner the series
 * badge then took. Two pieces of furniture, one corner, and nothing in the
 * system knew.
 *
 * Three things fix it, and this function is the third. The series badge is
 * deleted outright from all eight templates (the cause). The integrator passes
 * the EFFECTIVE badge rather than the frozen one (the belt). And the mark now
 * declares a zone in CSS that the top-band furniture is laid out AROUND
 * (the braces) — so a client template that grows a new top-corner element
 * inherits the clearance instead of rediscovering the collision.
 *
 * `--logo-zone-start` / `--logo-zone-end`: exactly one of them is the zone's
 * width and the other is zero, which is what lets the rules below be
 * corner-agnostic arithmetic rather than a pair of mirrored branches.
 * `--logo-zone-inset` is the zone's own offset from the frame, which an
 * IN-FLOW consumer needs in order to work out how far past the zone's inline
 * edge it has to start.
 */
function brandMarkZoneCss(placement: BrandLogoPlacement | undefined): string {
  const occupied = placement !== undefined && placement.decision !== "omit";
  const width = occupied ? BRAND_MARK_ZONE.size : 0;
  const start = occupied && placement.corner === "top-start" ? width : 0;
  const end = occupied && placement.corner === "top-end" ? width : 0;
  return [
    ":root {",
    `  --logo-zone-start: ${start}px;`,
    `  --logo-zone-end: ${end}px;`,
    `  --logo-zone-block: ${occupied ? BRAND_MARK_ZONE.size : 0}px;`,
    `  --logo-zone-inset: ${occupied ? BRAND_MARK_ZONE.inset : 0}px;`,
    "}",
    // ── THE ZONE'S CONSUMERS, AND THE PREMISE THAT WAS WRONG ABOUT THEM. ──
    //
    // This selector used to be `.brand-badge, .brand-zone-avoid` alone, on the
    // stated premise that *"`.eyebrow` and `.kicker` … sit IN FLOW inside the
    // composition, well below the top band"*. The render refutes it. Measured
    // through the production composition (`planBrandLogoPlacement` returning
    // `top-start`, the mark capped at `BRAND_MARK_MAX_WIDTH_PX` so its box is
    // 44,44 65x65, the zone x28 y28 132x132):
    //
    //   stat-callout / comparison-card / list-takeaway  .eyebrow  64,96
    //   quote-card                                      .eyebrow  80,96
    //   headline-focus (.kicker) / closer                         64,104
    //
    // Every one of those is INSIDE the zone — by 45x13px of direct overlap
    // with the mark itself on four plates and 45x5px on two, i.e. six of the
    // eight plates of every carousel, at every `fontScale`, in both scripts.
    // The premise was also self-sealing: `.brand-badge` and `.brand-zone-avoid`
    // match NO element in any of the eight bundled templates (the badge slot is
    // deleted by this phase and the opt-in was never taken up), so the
    // clearance this function exists to apply was applied to nothing.
    //
    // Two rules, because the two kinds of consumer move differently:
    //
    //   * `.brand-badge` is ABSOLUTELY POSITIONED, so its clearance is an
    //     inset. Unchanged.
    //   * `.eyebrow` / `.kicker` / `.brand-zone-avoid` are IN FLOW, so their
    //     clearance is a margin — and it is the SMALLEST margin that takes the
    //     box clear of the zone's inline edge, not the zone's whole width:
    //     `inset + size - --mx`, which is 28 + 132 - 64 = 96px on the bundled
    //     set. The `max(0px, …)` is what makes it self-cancelling: with no mark
    //     both zone tokens are 0 and the expression is negative, so every
    //     document without a brand mark is byte-identical to before.
    //
    // The margin narrows the line's measure by the same 96px, which is the
    // correct trade for a one-line uppercase label and is why the rule is
    // scoped to the two label classes rather than to the head container.
    ".brand-badge {",
    "  inset-inline-start: calc(var(--mx, 64px) + var(--logo-zone-start, 0px));",
    "  max-inline-size: calc(100% - (var(--mx, 64px) * 2) - var(--logo-zone-start, 0px) - var(--logo-zone-end, 0px));",
    "}",
    ".eyebrow, .kicker, .brand-zone-avoid {",
    "  margin-inline-start: max(0px, calc(var(--logo-zone-inset, 0px) + var(--logo-zone-start, 0px) - var(--mx, 64px)));",
    "  margin-inline-end: max(0px, calc(var(--logo-zone-inset, 0px) + var(--logo-zone-end, 0px) - var(--mx, 64px)));",
    "}",
    // ── AND THE ONE PLATE WHERE THE LABEL IS NOT IN THE TOP BAND. ──
    // `cover.html` carries its eyebrow inside `.cov-field`, the masthead band,
    // measured at y=527 — 367px below the zone's lower edge. Indenting it there
    // would be the *"fix applied to the wrong element"* the note above was
    // right to warn about, so the cover opts out by the same mechanism a client
    // template would: one class, named for what it asserts.
    ".brand-zone-clear { margin-inline-start: 0; margin-inline-end: 0; }",
    // The pagination index sits in the FOOT, opposite the `@handle`, so it can
    // never enter a top-corner zone at all. The rule is here rather than only
    // in the templates so that a client's own template gets the same clearance
    // for free.
    ".pg-index { inset-block-end: 40px; inset-inline-end: 44px; }",
  ].join("\n");
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
function brandLogoCss(placement: BrandLogoPlacement | undefined, headlineContrast?: number): string | undefined {
  if (placement === undefined || placement.decision === "omit") return undefined;
  const side = placement.corner === "top-end" ? "inset-inline-end" : "inset-inline-start";
  /**
   * ── ITEM F3: PRESENT, NOT DOMINANT. ──
   *
   * `planBrandLogoPlacement` asks for 150px — 13.9% of the 1080px canvas —
   * and on geektime's 2026-09-16 post the white disc was the brightest and
   * largest non-type object on every one of the eight plates. Capped here at
   * `BRAND_MARK_MAX_WIDTH_PX` (6% of canvas width, 65px).
   *
   * Clamped at the EMITTER rather than in `planBrandLogoPlacement`, and that
   * is deliberate: `brand-logo.ts` is shared with `tiktok-agent`'s video
   * cover surface, where the 150px is correct for a 1080x1920 frame with a
   * top bar; narrowing the planner would silently shrink another product's
   * mark. `Math.min` rather than an override, so a planner that ever returns
   * something SMALLER (a mark that needed a scrim, say) keeps its own number.
   */
  const widthPx = Math.min(placement.widthPx, BRAND_MARK_MAX_WIDTH_PX);
  const rules = [
    ".brand-logo {",
    `  position: absolute; top: ${placement.insetBlockPx}px; ${side}: ${placement.insetInlinePx}px; z-index: 6;`,
    `  width: ${widthPx}px; height: auto; display: block;`,
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
  /**
   * ── ITEM F3, THE SECOND HALF: READING ORDER, NOT GEOMETRY. ──
   *
   * When the mark out-contrasts the HEADLINE against the same ground, the eye
   * lands on the logo before it lands on the sentence — which is the owner's
   * *"הוא דורס כותרת"* read as an art-direction problem rather than as an
   * overlap. geektime's mark is a white disc measuring 16.8:1 against their
   * ground while the headline's own foreground measures 13.9:1, so the
   * brightest thing on the plate was the logo on all eight slides and nothing
   * had overlapped anything.
   *
   * 0.9, not lower: the mark must stay legible brand furniture. This is a
   * nudge in the reading order, and it only fires on the marks that earned it
   * — a logo that is already quieter than the type is untouched.
   *
   * `groundContrast` is `undefined` when the mark's ink could not be read from
   * its bytes (a JPEG/WebP logo). No measurement, no rule: inventing a
   * contrast number for an asset nobody decoded is the mocked "passes" the
   * whole of `brand-logo.ts` exists to avoid.
   */
  if (headlineContrast !== undefined && placement.groundContrast !== undefined && placement.groundContrast > headlineContrast) {
    rules.push(`  opacity: ${BRAND_MARK_QUIET_OPACITY};`);
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

/** The templates' own `:root { --fg }`, the other half of the pair a headline's contrast is measured across. Same argument as `DEFAULT_TEMPLATE_GROUND`: a client with no derived tokens renders on THIS. */
export const DEFAULT_TEMPLATE_FOREGROUND = "#F4F2EC";

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
