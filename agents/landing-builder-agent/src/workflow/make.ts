import type { BrandJson, BrandColorRoles, LandingSection } from "@agent-engine/tool-karos-landing";
import { GENERATED_CONTENT_RELATIVE_PATH, GENERATED_MANIFEST_RELATIVE_PATH, GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH, GENERATED_LAYOUT_RELATIVE_PATH } from "@agent-engine/tool-karos-landing";

/**
 * Taxonomy id -> the FORGE-proven template kit's own component file AND the
 * exact prop name that component declares (ENGINE-SPEC §7/§12 — verified
 * directly against `engine/template/src/components/`'s real signatures,
 * e.g. `Hero({ hero }: { hero: HeroContent })`, `SiteNav({ nav })`,
 * `ProofStrip({ proof })`, `SiteFooter({ footer })` — every *required*
 * section plus `proofStrip` takes a section-specific prop name; every other
 * optional section takes a uniform `data` prop. The Deep Parity Audit found
 * the original generator passed `data` to every component uniformly,
 * including the four that don't accept it — a straight prop-type mismatch
 * against the real kit, not a style nit. `team` has no entry: no `team.tsx`
 * exists anywhere in the real kit or any shipped fixture (see
 * `LANDING_SECTION_TAXONOMY`'s own doc comment in the tool package).
 */
const SECTION_COMPONENT: Record<LandingSection, { file: string; component: string; prop: string }> = {
  nav: { file: "site-nav", component: "SiteNav", prop: "nav" },
  hero: { file: "hero", component: "Hero", prop: "hero" },
  proofStrip: { file: "proof-strip", component: "ProofStrip", prop: "proof" },
  flagshipProof: { file: "flagship-proof", component: "FlagshipProof", prop: "data" },
  howItWorks: { file: "how-it-works", component: "HowItWorks", prop: "data" },
  offering: { file: "offering", component: "Offering", prop: "data" },
  signatureShowcase: { file: "signature-showcase", component: "SignatureShowcase", prop: "data" },
  faq: { file: "faq", component: "Faq", prop: "data" },
  footer: { file: "site-footer", component: "SiteFooter", prop: "footer" },
};

const REQUIRED_SECTIONS = new Set<LandingSection>(["nav", "hero", "footer"]);

function famName(s: unknown): string {
  return String(s ?? "").split("(")[0]!.trim();
}

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function hexToRgb(hex: string): [number, number, number] {
  const match = HEX_RE.exec(hex);
  if (!match) return [0, 0, 0];
  const int = parseInt(match[1]!, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Lightens (positive `percent`) or darkens (negative) a hex color by moving each channel toward 255/0 — a cheap, dependency-free stand-in for a real color-space shift, used only to derive a `-2`/`muted`/`edge` variant a brand contract didn't explicitly name. */
function deriveShade(hex: string, percent: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = Math.abs(percent) / 100;
  const target = percent >= 0 ? 255 : 0;
  return rgbToHex(r + (target - r) * t, g + (target - g) * t, b + (target - b) * t);
}

function hexToRgbTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

/**
 * The deterministic half of the token/font skin lever (ENGINE-SPEC §13 lever
 * 2). Two things this MUST get right for the real kit's components to
 * render at all (both flagged by the Deep Parity Audit as previously
 * missing): every component only ever uses the *semantic role* Tailwind
 * utilities (`bg-ground`, `text-fg`, `text-accent`, `border-edge`, ...), so
 * `brand.tokens.colors`' arbitrary per-client keys (`ink`, `bone`, `ember`,
 * ...) must be mapped onto those fixed roles via `brand.tokens.roles`
 * (`BrandColorRolesSchema`) — there is no way to guess this mapping
 * reliably from color names or free-text prose alone; and `@import
 * "tailwindcss";` must actually be emitted, or Tailwind's utility classes
 * never generate in the first place.
 *
 * Also guarantees, by construction, that `landing.gate`'s token-drift check
 * (every `brand.tokens.colors` value present in `globals.css`) and
 * font-fidelity check (`--font-display/sans/mono` mapped) both pass.
 */
export function renderGlobalsCss(brand: BrandJson): string {
  const roles = brand.tokens.roles;
  if (!roles) {
    throw new Error(
      "renderGlobalsCss: brand.tokens.roles is required — MAKE cannot guess which brand color (ground/fg/accent) plays which semantic CSS role without guessing, and a guess here would silently ship an unstyled or mis-themed site",
    );
  }
  const colors = brand.tokens.colors;
  const resolve = (key: string, roleLabel: string): string => {
    const hex = colors[key];
    if (!hex) throw new Error(`renderGlobalsCss: tokens.roles.${roleLabel} names color key "${key}", which is not present in tokens.colors`);
    return hex;
  };

  const ground = resolve(roles.ground, "ground");
  const fg = resolve(roles.fg, "fg");
  const accent = resolve(roles.accent, "accent");
  const ground2 = roles.ground2 ? resolve(roles.ground2, "ground2") : deriveShade(ground, 8);
  const fg2 = roles.fg2 ? resolve(roles.fg2, "fg2") : deriveShade(fg, -12);
  const accent2 = roles.accent2 ? resolve(roles.accent2, "accent2") : deriveShade(accent, 15);
  const muted = roles.muted ? resolve(roles.muted, "muted") : deriveShade(ground, 18);
  const edge = roles.edge ? resolve(roles.edge, "edge") : deriveShade(ground, 12);

  const display = famName(brand.fonts.display) || "sans-serif";
  const body = famName(brand.fonts.body) || "sans-serif";
  const mono = famName(brand.fonts.mono) || "monospace";

  return [
    `@import "tailwindcss";`,
    ``,
    `:root {`,
    `  --ground: ${ground};`,
    `  --ground-2: ${ground2};`,
    `  --fg: ${fg};`,
    `  --fg-2: ${fg2};`,
    `  --accent: ${accent};`,
    `  --accent-2: ${accent2};`,
    `  --muted: ${muted};`,
    `  --edge: ${edge};`,
    `  --accent-rgb: ${hexToRgbTriplet(accent)};`,
    `  --fg-rgb: ${hexToRgbTriplet(fg)};`,
    `}`,
    ``,
    `@theme inline {`,
    `  --color-ground: var(--ground);`,
    `  --color-ground-2: var(--ground-2);`,
    `  --color-fg: var(--fg);`,
    `  --color-fg-2: var(--fg-2);`,
    `  --color-accent: var(--accent);`,
    `  --color-accent-2: var(--accent-2);`,
    `  --color-muted: var(--muted);`,
    `  --color-edge: var(--edge);`,
    ``,
    `  --font-display: "${display}";`,
    `  --font-sans: "${body}";`,
    `  --font-mono: "${mono}";`,
    `}`,
    ``,
    `body {`,
    `  background: var(--ground);`,
    `  color: var(--fg);`,
    `  font-family: var(--font-sans), system-ui, sans-serif;`,
    `}`,
    ``,
  ].join("\n");
}

export interface CarryForwardWidgetRef {
  type: string;
  section: string;
}

/**
 * Renders `page.tsx`'s section manifest (ENGINE-SPEC §7 lever 1: "compose /
 * omit / reorder content-driven sections"), matching the real kit's actual
 * composition shape: required sections (`nav`/`hero`/`footer`) render
 * unconditionally with their own named prop; every optional section renders
 * conditionally (`content.<section> && <Component .../>`), also with its own
 * declared prop name — never a uniform `data` prop, and never a `team`
 * import (excluded from the taxonomy entirely).
 */
export function renderPageTsx(manifest: readonly LandingSection[], contentModuleImportPath: string): string {
  const uniqueSections = [...new Set(manifest)];
  const imports = uniqueSections
    .map((s) => `import { ${SECTION_COMPONENT[s].component} } from "@/components/${SECTION_COMPONENT[s].file}";`)
    .join("\n");

  const renderSection = (s: LandingSection): string => {
    const { component, prop } = SECTION_COMPONENT[s];
    const element = `<${component} ${prop}={content.${s}} />`;
    return REQUIRED_SECTIONS.has(s) ? element : `{content.${s} && ${element}}`;
  };

  const nav = uniqueSections.filter((s) => s === "nav").map(renderSection);
  const footer = uniqueSections.filter((s) => s === "footer").map(renderSection);
  const mainSections = uniqueSections.filter((s) => s !== "nav" && s !== "footer").map(renderSection);

  const body = [...nav, `<main className="flex-1">`, ...mainSections.map((s) => `  ${s}`), `</main>`, ...footer].map((line) => `      ${line}`).join("\n");

  return [`import { content } from "${contentModuleImportPath}";`, imports, ``, `export default function Page() {`, `  return (`, `    <>`, body, `    </>`, `  );`, `}`, ``].join(
    "\n",
  );
}

/**
 * Serializes the flat `LandingContent`-shaped object (top-level `lang`,
 * `meta`, one key per composed section, plus an optional `carryForward[]`)
 * into a typed `.ts` module — not the untyped, default-imported `.json` the
 * Deep Parity Audit flagged as dropping the real kit's compile-time
 * contract. A plain `JSON.stringify` object literal is valid TypeScript
 * syntax (quoted keys are legal), so no bespoke serializer is needed; the
 * `LandingContent` type import is what makes a field-shape mistake a real
 * compile error again.
 */
export function renderContentModule(content: Record<string, unknown>): string {
  return `import type { LandingContent } from "@/lib/content-schema";\n\nexport const content: LandingContent = ${JSON.stringify(content, null, 2)};\n`;
}

/**
 * Surgically patches the copied template's `layout.tsx` — updates only
 * `<html lang="...">` and the `export const metadata: Metadata = {...}`
 * block to this client's real `lang`/`title`/`description`, leaving
 * everything else (the `next/font/google` imports, the body wrapper) alone.
 * The Deep Parity Audit found the original pipeline never touched
 * `layout.tsx` at all, shipping the template's own placeholder metadata
 * next to the client's real body content.
 *
 * A best-effort text patch (brace-balanced for the metadata object, a
 * plain regex for the `lang` attribute) rather than a full AST edit —
 * consistent with this generator's existing style, and scoped to exactly
 * the two fields RFC-07's remediation asked for.
 */
export function patchLayoutMetadata(layoutSource: string, meta: { lang: string; title: string; description: string }): string {
  let patched = layoutSource.replace(/lang="[^"]*"/, `lang="${meta.lang}"`);

  const metadataKeyMatch = /export\s+const\s+metadata\s*:\s*Metadata\s*=\s*\{/.exec(patched);
  if (!metadataKeyMatch) return patched; // no metadata export to patch — leave the file untouched rather than guessing where to insert one

  const openBraceIndex = metadataKeyMatch.index + metadataKeyMatch[0].length - 1;
  let depth = 0;
  let closeIndex = -1;
  for (let i = openBraceIndex; i < patched.length; i++) {
    if (patched[i] === "{") depth++;
    else if (patched[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) return patched;

  const replacement = `export const metadata: Metadata = {\n  title: ${JSON.stringify(meta.title)},\n  description: ${JSON.stringify(meta.description)},\n}`;
  patched = patched.slice(0, metadataKeyMatch.index) + replacement + patched.slice(closeIndex + 1);
  return patched;
}

export const contentModuleRelativePath = GENERATED_CONTENT_RELATIVE_PATH;
export const manifestFileRelativePath = GENERATED_MANIFEST_RELATIVE_PATH;
export const carryForwardPlacementRelativePath = GENERATED_CARRY_FORWARD_PLACEMENT_RELATIVE_PATH;
export const layoutTsxRelativePath = GENERATED_LAYOUT_RELATIVE_PATH;
export const pageTsxRelativePath = "src/app/page.tsx";
export const globalsCssRelativePath = "src/app/globals.css";

/** The `@/content/...` import specifier `page.tsx`/needs for the generated content module (drops the `.ts` extension, matching the real kit's own import style). */
export function contentModuleImportSpecifier(): string {
  return `@/${contentModuleRelativePath.replace(/^src\//, "").replace(/\.ts$/, "")}`;
}

export type { BrandColorRoles };
