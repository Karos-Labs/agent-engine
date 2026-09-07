import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { downloadBrandLogo } from "@agent-engine/tool-karos-media";
import type { StyleCandidate } from "./types.js";

/**
 * The branded-shorts setup a client used to need an operator for, derived
 * from what the portal already holds about them.
 *
 * Until 2026-09-07 `00-brand-resolve` refused to run unless someone had put
 * three things on the client's config by hand: a `brand-profile.json` (with
 * real font files and an alpha-masked mark beside it), a `graphics-language.md`
 * and an approved-archetype list from a per-client `make_motion_repertoire.py`.
 * Every karoslabs run on prep since 2026-09-05 was `blocked_intake` on exactly
 * that, while the client's brand kit (`client.getBrand`: palette, font
 * families, logo URL, visual style, guidelines) held everything those files
 * are built from. This module builds them:
 *
 * - **colours** from the brand kit's palette, with the engine's roles
 *   (`background`/`ink` the darkest, `foreground` the lightest neutral,
 *   `accent` the stated accent);
 * - **fonts** by family name from Google Fonts (Inter, Spectral, ... are all
 *   there), written beside the profile, with the system's own faces as the
 *   fallback when a family is not served or the network is not there;
 * - **the mark** through `video.deriveMark`, which keys a flattened logo's
 *   background out and, with no logo at all, renders the brand's initial;
 * - **the graphics language** from the locked style's own prose, or from the
 *   kit's visual style and guidelines when no style was ever locked;
 * - **the approved archetypes** as the render engine's whole registry minus
 *   `platforms` (which needs per-platform icon files nobody supplied).
 *
 * Anything an operator DID configure wins: this fills gaps, it never
 * overrides. Everything derived is named in `notes`, which reach the human at
 * 10-delivery-review, so a run on a derived profile is never mistaken for a
 * run on a locked one.
 */

export interface BrandKitLike {
  name?: unknown;
  handle?: unknown;
  accent?: unknown;
  colors?: unknown;
  palette?: unknown;
  dominantColors?: unknown;
  fonts?: unknown;
  logoUrl?: unknown;
  visualStyle?: unknown;
  guidelines?: unknown;
  [key: string]: unknown;
}

export interface DerivedColors {
  background: string;
  foreground: string;
  accent: string;
  ink: string;
  surface_1: string;
  muted_foreground: string;
  border: string;
}

/** `render_overlays.py`'s registry, minus `platforms`, which needs icon files no brand kit carries. */
export const DERIVED_APPROVED_ARCHETYPES: readonly string[] = ["logo", "chart", "clock", "browser", "signoff", "callout"];

const HEX = /^#[0-9a-fA-F]{6}$/;

function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (HEX.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

function mix(a: string, b: string, t: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

/** Every hex the kit states anywhere, in the order it states them, de-duplicated. */
function collectHexes(brand: BrandKitLike): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const h = normalizeHex(v);
    if (h && !out.includes(h)) out.push(h);
  };
  push(brand.accent);
  for (const block of [brand.colors, brand.palette]) {
    if (Array.isArray(block)) block.forEach(push);
    else if (block && typeof block === "object") Object.values(block as Record<string, unknown>).forEach(push);
  }
  if (Array.isArray(brand.dominantColors)) {
    for (const entry of brand.dominantColors) {
      if (entry && typeof entry === "object") push((entry as { hex?: unknown }).hex);
    }
  }
  return out;
}

/**
 * The engine's colour roles from the kit's palette. `undefined` only when the
 * kit names no colour at all; a kit with a single accent still resolves, with
 * the engine's own neutral ink and paper filling the rest.
 */
export function deriveBrandColors(brand: BrandKitLike): DerivedColors | undefined {
  const named: Record<string, unknown> = {
    ...(brand.palette && typeof brand.palette === "object" && !Array.isArray(brand.palette) ? (brand.palette as Record<string, unknown>) : {}),
    ...(brand.colors && typeof brand.colors === "object" && !Array.isArray(brand.colors) ? (brand.colors as Record<string, unknown>) : {}),
  };
  const all = collectHexes(brand);
  if (all.length === 0) return undefined;

  const accent =
    normalizeHex(brand.accent) ??
    normalizeHex(named["primaryAccent"]) ??
    normalizeHex(named["accent"]) ??
    [...all].sort((a, b) => saturation(b) - saturation(a))[0]!;

  const darkCandidates = all.filter((h) => h !== accent && luminance(h) < 0.35);
  const namedDark = normalizeHex(named["neutralDark"]);
  const ink = namedDark && luminance(namedDark) < 0.35 ? namedDark : darkCandidates.sort((a, b) => luminance(a) - luminance(b))[0] ?? "#141414";

  const namedLight = normalizeHex(named["neutralLight"]);
  const lightCandidates = all.filter((h) => h !== accent && luminance(h) > 0.8);
  const foreground = namedLight && luminance(namedLight) > 0.8 ? namedLight : lightCandidates.sort((a, b) => luminance(b) - luminance(a))[0] ?? "#f5f5f5";

  return {
    background: ink,
    foreground,
    accent,
    ink,
    surface_1: mix(ink, foreground, 0.12),
    muted_foreground: mix(foreground, ink, 0.35),
    border: mix(ink, foreground, 0.25),
  };
}

/** The display and body families the kit names, defaulting to one open family the engine can always fetch. */
export function brandFontFamilies(brand: BrandKitLike): { display: string; body: string } {
  const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim().replace(/['"]/g, "") : undefined);
  // Kits name fonts two ways: `{heading, body}` (the portal's brand form) or a
  // plain list (`["Spectral", "Inter"]`, display first).
  if (Array.isArray(brand.fonts)) {
    const listed = brand.fonts.map(clean).filter((f): f is string => f !== undefined);
    const display = listed[0] ?? "Inter";
    return { display, body: listed[1] ?? display };
  }
  const fonts = brand.fonts && typeof brand.fonts === "object" ? (brand.fonts as Record<string, unknown>) : {};
  const display = clean(fonts["heading"]) ?? clean(fonts["display"]) ?? clean(fonts["body"]) ?? "Inter";
  const body = clean(fonts["body"]) ?? display;
  return { display, body };
}

export interface ResolvedFonts {
  /** Relative to the profile directory, as the engine reads them. */
  displayFile: string;
  bodyFile: string;
  source: "google-fonts" | "system" | "mixed";
  notes: string[];
}

/** Font weights the engine's caption system wants: body copy, and the heavier emphasis/display face. */
const BODY_WEIGHT = 500;
const DISPLAY_WEIGHT = 700;

/**
 * Google Fonts' CSS API returns TrueType `src` URLs to a client that does not
 * advertise woff2 support, which is exactly what a Pillow-driven engine needs.
 */
const GOOGLE_FONTS_UA = "Mozilla/5.0 (compatible; karos-agent-engine)";

async function fetchGoogleFontFile(fetchImpl: typeof fetch, family: string, weight: number): Promise<Uint8Array | undefined> {
  const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}`;
  try {
    const res = await fetchImpl(css, { headers: { "User-Agent": GOOGLE_FONTS_UA } });
    if (!res.ok) return undefined;
    const text = await res.text();
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(text)?.[1];
    if (!url) return undefined;
    const file = await fetchImpl(url);
    if (!file.ok) return undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bytes.byteLength > 1024 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Faces an image or a laptop is likely to carry, heavier first; scanned only when Google Fonts did not serve the family. */
const SYSTEM_FONT_CANDIDATES: Record<"display" | "body", string[]> = {
  display: [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ],
  body: [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
  ],
};

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 1024) return candidate;
    } catch {
      // not there; next
    }
  }
  return undefined;
}

export interface ResolveFontsOptions {
  fetchImpl?: typeof fetch;
  /** Overrides the system-face candidates (tests point this at a fixture). */
  systemFontCandidates?: Record<"display" | "body", string[]>;
}

/**
 * Real TTF files for the kit's families, written to `<profileDir>/fonts/`, as
 * relative paths the profile can reference. Google Fonts first; a system face
 * when the family is not served there; `undefined` when neither yields a
 * loadable file, which is the one case a derived profile cannot be built.
 */
export async function resolveBrandFonts(profileDir: string, families: { display: string; body: string }, options: ResolveFontsOptions = {}): Promise<ResolvedFonts | undefined> {
  const fontsDir = path.join(profileDir, "fonts");
  await fs.mkdir(fontsDir, { recursive: true });
  const notes: string[] = [];
  const sources = new Set<"google-fonts" | "system">();

  const resolveOne = async (family: string, weight: number, role: "display" | "body"): Promise<string | undefined> => {
    const fileName = `${family.replace(/[^A-Za-z0-9]+/g, "")}-${weight}.ttf`;
    if (options.fetchImpl) {
      const bytes = await fetchGoogleFontFile(options.fetchImpl, family, weight);
      if (bytes) {
        await fs.writeFile(path.join(fontsDir, fileName), bytes);
        sources.add("google-fonts");
        return `fonts/${fileName}`;
      }
      notes.push(`${family} ${weight} is not served by Google Fonts (or the fetch failed); using a system face for the ${role} role`);
    }
    const system = await firstExisting((options.systemFontCandidates ?? SYSTEM_FONT_CANDIDATES)[role]);
    if (system === undefined) return undefined;
    const copied = `${role}-system${path.extname(system) || ".ttf"}`;
    await fs.copyFile(system, path.join(fontsDir, copied));
    sources.add("system");
    return `fonts/${copied}`;
  };

  const displayFile = await resolveOne(families.display, DISPLAY_WEIGHT, "display");
  const bodyFile = await resolveOne(families.body, BODY_WEIGHT, "body");
  if (displayFile === undefined || bodyFile === undefined) return undefined;
  const source = sources.size === 2 ? "mixed" : (sources.values().next().value as "google-fonts" | "system");
  return { displayFile, bodyFile, source, notes };
}

/** A style candidate the human never locked, stated from the brand kit so the run can say what it assumed. */
export function deriveDefaultStyle(brand: BrandKitLike, colors: DerivedColors): StyleCandidate {
  const visualStyle = typeof brand.visualStyle === "string" && brand.visualStyle.trim() ? brand.visualStyle.trim() : "Clean, modern";
  const name = typeof brand.name === "string" && brand.name.trim() ? brand.name.trim() : "the client";
  return {
    name: "Brand default (derived, not locked)",
    description: `${visualStyle} treatment built directly from ${name}'s brand kit: dark ground, light type, one accent. Derived automatically because no style was locked through Style Exploration; a reviewer sees this note.`,
    paletteUsage: `Ground ${colors.background}, type ${colors.foreground}, emphasis and marks ${colors.accent}. Nothing outside the kit's own palette.`,
    captionTreatment: "Two-face typographic captions: body words in the body face, one to three emphasis words per line in the display face, larger, in the accent.",
    graphicsDirection: "Transparent motion graphics only: rimmed strokes, alpha glow in the accent, cubic easing, no backgrounds, no text under the caption zone.",
    endcardTreatment: "Mark centred on the brand ground, tinted to the light neutral, handle as the eyebrow in the accent.",
    paletteTokensUsed: [...new Set([colors.background, colors.foreground, colors.accent])],
  };
}

/** The graphics-language markdown the graphics agent reads, from a locked style's prose or a derived one. */
export function deriveGraphicsLanguage(brand: BrandKitLike, style: StyleCandidate, colors: DerivedColors, fonts: { display: string; body: string }): string {
  const guidelines = typeof brand.guidelines === "string" ? brand.guidelines.trim() : "";
  const lines = [
    "## Vocabulary",
    `- Palette: accent ${colors.accent} for emphasis words, marks and glows; ink ${colors.ink}; neutral ${colors.foreground}. Never a colour outside the kit.`,
    `- Type: ${fonts.display} for display and emphasis, ${fonts.body} for body copy.`,
    `- Style: ${style.description}`,
    `- Captions: ${style.captionTreatment}`,
    `- Graphics: ${style.graphicsDirection}`,
    `- Endcard: ${style.endcardTreatment}`,
    "- Production rules: transparent overlays, rimmed strokes for visibility, glow is pure-hex alpha only, cubic easing, one graphic on screen at a time, never under the caption zone.",
  ];
  if (guidelines.length > 0) {
    lines.push("", "## Brand guidelines (from the kit)", guidelines.slice(0, 2_000));
  }
  return lines.join("\n");
}

export interface DeriveBrandSetupInput {
  brand: BrandKitLike;
  /** `memory.beliefs.brandedShortsLockedStyle` as found: a real candidate, a placeholder string, or nothing. */
  lockedStyle: unknown;
  /** The run's work directory; the derived profile lands in `<workDir>/brand/`. */
  workDir: string;
  tools: AgentToolRegistry;
  ctx: AgentContext;
  fetchImpl?: typeof fetch;
  fontOptions?: ResolveFontsOptions;
  /**
   * Whether a brand-profile.json (fonts, mark) has to be produced. False when
   * the client configured one and only the style, graphics language or
   * archetypes are missing: nothing is downloaded, and a kit with no colour
   * is not a reason to block, the prose just names the engine's neutrals.
   */
  needProfile?: boolean;
}

export interface DerivedBrandSetup {
  /** Absent when `needProfile` was false: the configured profile stands. */
  profilePath?: string;
  graphicsLanguage: string;
  approvedArchetypes: string[];
  style: StyleCandidate;
  styleSource: "locked" | "derived";
  /** Everything this run assumed instead of being told; shown to the reviewer. */
  notes: string[];
}

export type DeriveBrandSetupOutcome = { ok: true; setup: DerivedBrandSetup } | { ok: false; reason: string };

function isStyleCandidate(value: unknown): value is StyleCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StyleCandidate).name === "string" &&
    typeof (value as StyleCandidate).description === "string" &&
    Array.isArray((value as StyleCandidate).paletteTokensUsed)
  );
}

/**
 * Builds the profile directory and returns what `00-brand-resolve` needs, or
 * the one reason it could not (no colour in the kit, or no loadable font from
 * anywhere). A missing or unusable logo is never a reason: the mark falls
 * back to the brand's initial.
 */
export async function deriveBrandSetup(input: DeriveBrandSetupInput): Promise<DeriveBrandSetupOutcome> {
  const { brand, tools, ctx } = input;
  const notes: string[] = [];

  const needProfile = input.needProfile ?? true;
  const derivedColors = deriveBrandColors(brand);
  if (derivedColors === undefined && needProfile) {
    return { ok: false, reason: "the client's brand kit names no colour at all, so a brand profile cannot be derived; add the palette to the client's brand in the portal, or configure brandedShortsProfilePath" };
  }
  const colors: DerivedColors = derivedColors ?? {
    background: "#141414",
    foreground: "#f5f5f5",
    accent: "#f5f5f5",
    ink: "#141414",
    surface_1: "#2a2a2a",
    muted_foreground: "#a8a8a8",
    border: "#444444",
  };
  if (derivedColors === undefined) notes.push("the brand kit names no colour; the derived style and graphics language use the engine's neutrals");

  const style: StyleCandidate = isStyleCandidate(input.lockedStyle) ? input.lockedStyle : deriveDefaultStyle(brand, colors);
  const styleSource: "locked" | "derived" = isStyleCandidate(input.lockedStyle) ? "locked" : "derived";
  if (styleSource === "derived") {
    notes.push(
      input.lockedStyle === undefined || input.lockedStyle === null
        ? "no style was ever locked for this client (Style Exploration has not run); a default style was derived from the brand kit"
        : `the locked style on file is not a style candidate (${JSON.stringify(input.lockedStyle).slice(0, 60)}); a default style was derived from the brand kit`,
    );
  }

  const families = brandFontFamilies(brand);
  if (!needProfile) {
    return {
      ok: true,
      setup: {
        graphicsLanguage: deriveGraphicsLanguage(brand, style, colors, families),
        approvedArchetypes: [...DERIVED_APPROVED_ARCHETYPES],
        style,
        styleSource,
        notes,
      },
    };
  }

  const profileDir = path.join(input.workDir, "brand");
  await fs.mkdir(profileDir, { recursive: true });

  const fonts = await resolveBrandFonts(profileDir, families, { ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}), ...input.fontOptions });
  if (fonts === undefined) {
    return {
      ok: false,
      reason: `no loadable font could be obtained for "${families.display}" / "${families.body}" (Google Fonts did not serve them and no system face was found); configure brandedShortsProfilePath with the client's own font files`,
    };
  }
  notes.push(...fonts.notes, `fonts resolved from ${fonts.source}: ${families.display} (display), ${families.body} (body)`);

  const markPath = path.join(profileDir, "marks", "mark.png");
  const mark = await deriveMark(tools, ctx, { brand, profileDir, markPath, displayFontFile: fonts.displayFile, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  if (!mark.ok) return { ok: false, reason: mark.reason };
  notes.push(mark.note);

  const handle = typeof brand.handle === "string" && brand.handle.trim() ? brand.handle.trim().replace(/^@/, "") : undefined;
  const name = typeof brand.name === "string" && brand.name.trim() ? brand.name.trim() : undefined;
  const profile = {
    _derived: {
      by: "agent-engine branded-shorts-agent",
      at: new Date().toISOString(),
      styleSource,
      notes,
    },
    color: colors,
    typography: {
      display: { family: families.display, file: fonts.displayFile },
      body: { family: families.body, file: fonts.bodyFile },
    },
    video_captions_v2: {
      body: { font_file: fonts.bodyFile, size_px_at_1920h: 62, color: "foreground" },
      emphasis: { font_file: fonts.displayFile, size_px_at_1920h: 100, color: "accent", dy_px: 6 },
    },
    endcard: {
      logo_file: path.relative(profileDir, markPath).split(path.sep).join("/"),
      logo_tint: colors.foreground,
      logo_width: 220,
      ...(name !== undefined ? { wordmark_text: name, wordmark_font_file: fonts.displayFile, wordmark_size: 64 } : {}),
      eyebrow_text: handle !== undefined ? `@${handle}` : (name ?? "").toUpperCase(),
      eyebrow_font_file: fonts.bodyFile,
      eyebrow_size: 26,
      eyebrow_tracking: 8,
    },
  };
  const profilePath = path.join(profileDir, "brand-profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");

  return {
    ok: true,
    setup: {
      profilePath,
      graphicsLanguage: deriveGraphicsLanguage(brand, style, colors, families),
      approvedArchetypes: [...DERIVED_APPROVED_ARCHETYPES],
      style,
      styleSource,
      notes,
    },
  };
}

async function deriveMark(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  input: { brand: BrandKitLike; profileDir: string; markPath: string; displayFontFile: string; fetchImpl?: typeof fetch },
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const tool = tools["video.deriveMark"];
  if (!tool) return { ok: false, reason: "video.deriveMark is not registered in this deployment, so no brand mark can be derived; configure brandedShortsProfilePath" };

  let sourcePath: string | undefined;
  const logoUrl = typeof input.brand.logoUrl === "string" ? input.brand.logoUrl : undefined;
  if (logoUrl !== undefined) {
    const download = await downloadBrandLogo(input.fetchImpl ?? fetch, logoUrl);
    if (download !== undefined && download.mime !== "image/svg+xml") {
      const ext = download.mime === "image/png" ? "png" : download.mime === "image/webp" ? "webp" : "jpg";
      sourcePath = path.join(input.profileDir, "marks", `logo-source.${ext}`);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, download.bytes);
    }
  }

  const initial = (typeof input.brand.name === "string" && input.brand.name.trim() ? input.brand.name.trim() : "K").slice(0, 1).toUpperCase();
  const attempt = async (args: Record<string, unknown>) => tool.execute(args, { ctx });

  if (sourcePath !== undefined) {
    const outcome = await attempt({ sourcePath, outputPath: input.markPath });
    if (outcome.status === "success") {
      const how = (outcome.result as { how: string }).how;
      return { ok: true, note: how === "had_alpha" ? "brand mark: the kit's logo, which already carried an alpha mask" : "brand mark: the kit's logo with its background keyed out (the file was flattened)" };
    }
    console.warn(`[branded-shorts] video.deriveMark could not use the kit's logo (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}); falling back to the brand initial`);
  }
  const glyph = await attempt({ text: initial, fontPath: path.join(input.profileDir, input.displayFontFile), outputPath: input.markPath });
  if (glyph.status !== "success") {
    return { ok: false, reason: `no brand mark could be derived: ${glyph.status}${"reason" in glyph ? ` (${glyph.reason})` : ""}` };
  }
  return { ok: true, note: logoUrl === undefined ? `brand mark: the initial "${initial}" in the display face (the kit has no logo)` : `brand mark: the initial "${initial}" in the display face (the kit's logo could not be used)` };
}

/** A default work directory for a run's derived assets, when the client configured none. */
export function defaultBrandedShortsWorkDir(runId: string): string {
  return path.join(os.tmpdir(), "branded-shorts", runId);
}
