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
  /** Normalized to exactly one leading `@`. */
  handle?: string;
  /** Which visual treatment the badge/eyebrow components use. Always present — `plain` is the no-signal default. */
  badgeStyle: BadgeStyle;
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

/**
 * Exactly 3/4/6/8 hex digits — `#12345` and `#1234567` are invalid CSS colors
 * and must not reach a stylesheet.
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

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

  // ── accent: extracted for assembleSlidesData's EXISTING channel, never a var ──
  const brandAccent = asHex(b["accent"]) ?? asHex((b["colors"] as Record<string, unknown> | undefined)?.["primaryAccent"]);

  const logoUrl = (() => {
    const url = asString(b["logoUrl"]);
    if (url === undefined) return undefined;
    return /^https:\/\//i.test(url) || /^gs:\/\//i.test(url) ? url : undefined;
  })();

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
    handle !== undefined;
  if (!hasAnything) return undefined;

  return {
    cssVars,
    fontFamilies: [...new Set(fontFamilies)],
    ...(brandAccent !== undefined ? { brandAccent } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(handle !== undefined ? { handle } : {}),
    badgeStyle,
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
export function buildBrandHeadHtml(tokens: BrandRenderTokens, options: { logoDataUri?: string } = {}): string {
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
  if (options.logoDataUri !== undefined) {
    css.push(
      [
        ".brand-logo {",
        "  position: absolute; top: 44px; inset-inline-start: 44px; z-index: 6;",
        "  width: 150px; height: auto; display: block;",
        "}",
        // The badge shares the logo's corner; with a logo present it slides
        // past the 150px mark plus a margin instead of painting over it.
        ".brand-badge { inset-inline-start: 220px; top: 62px; }",
      ].join("\n"),
    );
  }
  if (css.length > 0) parts.push(`<style>\n${css.join("\n")}\n</style>`);

  return parts.join("\n");
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
