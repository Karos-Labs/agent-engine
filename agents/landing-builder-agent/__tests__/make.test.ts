import { describe, expect, it } from "vitest";
import { renderGlobalsCss, renderPageTsx, renderContentModule, patchLayoutMetadata } from "../src/workflow/make.js";
import type { BrandJson } from "@agent-engine/tool-karos-landing";

function forgeBrand(overrides: Partial<BrandJson["tokens"]> = {}): BrandJson {
  return {
    client: "forge",
    tokens: {
      colors: { ink: "#0B0B0C", "ink-2": "#15151A", bone: "#F2F0EC", ember: "#FF4D00" },
      roles: { ground: "ink", ground2: "ink-2", fg: "bone", accent: "ember" },
      ...overrides,
    },
    fonts: { display: "Clash Display (heavy grotesque)", body: "Inter", mono: "JetBrains Mono" },
    brandLaw: [],
    carryForward: [],
    references: [],
  };
}

describe("renderGlobalsCss", () => {
  it("embeds every brand color verbatim, satisfying landing.gate's token-drift check", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css).toContain("#FF4D00");
    expect(css).toContain("#0B0B0C");
  });

  it("maps --font-display/sans/mono, satisfying landing.gate's font-fidelity check", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css).toMatch(/--font-display:\s*"Clash Display"/);
    expect(css).toMatch(/--font-sans:\s*"Inter"/);
    expect(css).toMatch(/--font-mono:\s*"JetBrains Mono"/);
  });

  it("strips a weight/usage suffix from the family name", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css).not.toContain("heavy grotesque");
  });

  it("emits @import \"tailwindcss\" — without it no utility classes generate at all", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css.trim().startsWith('@import "tailwindcss";')).toBe(true);
  });

  it("maps tokens.roles onto the semantic --ground/--fg/--accent variables real components' Tailwind classes consume", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css).toMatch(/--ground:\s*#0B0B0C;/);
    expect(css).toMatch(/--fg:\s*#F2F0EC;/);
    expect(css).toMatch(/--accent:\s*#FF4D00;/);
    expect(css).toMatch(/--ground-2:\s*#15151A;/); // explicit role value used, not derived
    expect(css).toContain("--color-ground: var(--ground);");
    expect(css).toContain("--color-accent: var(--accent);");
  });

  it("derives an unspecified -2/muted/edge variant instead of requiring every role", () => {
    const css = renderGlobalsCss(forgeBrand());
    expect(css).toMatch(/--fg-2:\s*#[0-9A-Fa-f]{6};/);
    expect(css).toMatch(/--muted:\s*#[0-9A-Fa-f]{6};/);
    expect(css).toMatch(/--edge:\s*#[0-9A-Fa-f]{6};/);
  });

  it("throws when tokens.roles is missing — never guesses which color plays which semantic role", () => {
    const brand = forgeBrand();
    const { roles: _roles, ...tokensWithoutRoles } = brand.tokens as Record<string, unknown>;
    expect(() => renderGlobalsCss({ ...brand, tokens: tokensWithoutRoles } as BrandJson)).toThrow(/tokens\.roles is required/);
  });

  it("throws when a role names a color key that isn't in tokens.colors", () => {
    const brand = forgeBrand({ roles: { ground: "nonexistent", fg: "bone", accent: "ember" } } as never);
    expect(() => renderGlobalsCss(brand)).toThrow(/not present in tokens\.colors/);
  });
});

describe("renderPageTsx", () => {
  it("renders required sections (nav/hero/footer) unconditionally with their own declared prop names", () => {
    const tsx = renderPageTsx(["nav", "hero", "footer"], "@/content/generated");
    expect(tsx).toContain("<SiteNav nav={content.nav} />");
    expect(tsx).toContain("<Hero hero={content.hero} />");
    expect(tsx).toContain("<SiteFooter footer={content.footer} />");
    expect(tsx).not.toContain("{content.hero &&"); // required sections are never conditionally guarded
  });

  it("renders optional sections conditionally, each with its own declared prop name — not a uniform `data` prop for proofStrip", () => {
    const tsx = renderPageTsx(["nav", "hero", "proofStrip", "footer"], "@/content/generated");
    expect(tsx).toContain("{content.proofStrip && <ProofStrip proof={content.proofStrip} />}");
  });

  it("renders the other optional sections conditionally with the uniform `data` prop, matching the real kit", () => {
    const tsx = renderPageTsx(["nav", "hero", "offering", "faq", "footer"], "@/content/generated");
    expect(tsx).toContain("{content.offering && <Offering data={content.offering} />}");
    expect(tsx).toContain("{content.faq && <Faq data={content.faq} />}");
  });

  it("imports every rendered section's component from the real kit's file naming", () => {
    const tsx = renderPageTsx(["nav", "hero", "offering", "footer"], "@/content/generated");
    expect(tsx).toContain('import { Hero } from "@/components/hero";');
    expect(tsx).toContain('import { Offering } from "@/components/offering";');
    expect(tsx).toContain('import { content } from "@/content/generated";');
  });

  it("de-duplicates a section that somehow appears twice in the manifest", () => {
    const tsx = renderPageTsx(["nav", "hero", "hero", "footer"], "@/content/generated");
    expect(tsx.split("import { Hero }").length - 1).toBe(1);
  });
});

describe("renderContentModule", () => {
  it("emits a typed .ts module, not an untyped JSON blob", () => {
    const source = renderContentModule({ lang: "en-US", hero: { headline: "x" } });
    expect(source).toContain('import type { LandingContent } from "@/lib/content-schema";');
    expect(source).toContain("export const content: LandingContent = {");
    expect(source).toContain('"headline": "x"');
  });
});

describe("patchLayoutMetadata", () => {
  const templateLayout = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Template placeholder title",
  description: "Template placeholder description.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="antialiased">
      <body>{children}</body>
    </html>
  );
}
`;

  it("replaces the placeholder metadata with the client's real title/description", () => {
    const patched = patchLayoutMetadata(templateLayout, { lang: "en-US", title: "FORGE · Train like an athlete", description: "An adaptive strength program." });
    expect(patched).toContain('title: "FORGE · Train like an athlete"');
    expect(patched).toContain('description: "An adaptive strength program."');
    expect(patched).not.toContain("Template placeholder title");
  });

  it("updates the <html lang> attribute", () => {
    const patched = patchLayoutMetadata(templateLayout, { lang: "en-US", title: "x", description: "y" });
    expect(patched).toContain('lang="en-US"');
    expect(patched).not.toMatch(/lang="en"/);
  });

  it("leaves everything else (font imports, body wrapper) untouched", () => {
    const patched = patchLayoutMetadata(templateLayout, { lang: "en-US", title: "x", description: "y" });
    expect(patched).toContain('import "./globals.css";');
    expect(patched).toContain("<body>{children}</body>");
  });

  it("leaves the file unchanged if no metadata export is found, rather than guessing where to insert one", () => {
    const noMetadata = `export default function RootLayout() { return null; }`;
    expect(patchLayoutMetadata(noMetadata, { lang: "en-US", title: "x", description: "y" })).toBe(noMetadata);
  });
});
