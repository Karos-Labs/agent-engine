import { describe, expect, it } from "vitest";
import { checkTokenDrift } from "../src/gate/token-drift.js";
import { checkFontFidelity } from "../src/gate/font-fidelity.js";
import { checkBrandLint } from "../src/gate/brand-lint.js";
import { checkStructure } from "../src/gate/structure.js";
import { checkCarryForward } from "../src/gate/carry-forward.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("checkTokenDrift", () => {
  it("passes when every brand color is present in globals.css", () => {
    const result = checkTokenDrift({ colors: { ember: "#FF4D00", ink: "#0B0B0C" } }, "body { color: #FF4D00; background: #0B0B0C; }", "/site");
    expect(result.violations).toHaveLength(0);
    expect(result.colorCount).toBe(2);
  });

  it("flags a color missing from globals.css as a hard violation", () => {
    const result = checkTokenDrift({ colors: { ember: "#FF4D00" } }, "body { color: #000000; }", "/site");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule).toBe("token-drift");
  });

  it("flags entirely absent globals.css", () => {
    const result = checkTokenDrift({ colors: {} }, "", "/site");
    expect(result.violations.some((v) => v.rule === "no-globals")).toBe(true);
  });

  it("matches case-insensitively", () => {
    const result = checkTokenDrift({ colors: { ember: "#FF4D00" } }, "body { color: #ff4d00; }", "/site");
    expect(result.violations).toHaveLength(0);
  });
});

describe("checkFontFidelity", () => {
  it("warns when fonts are declared but not wired via --font-*", () => {
    const result = checkFontFidelity({ display: "Clash Display", body: "Inter" }, "body { color: red; }", "/site");
    expect(result.violations).toHaveLength(1);
    expect(result.families).toEqual(["Clash Display", "Inter"]);
  });

  it("is clean when --font-display/sans/mono are mapped", () => {
    const result = checkFontFidelity({ display: "Clash Display", body: "Inter" }, "@theme { --font-display: 'Clash Display'; }", "/site");
    expect(result.violations).toHaveLength(0);
  });

  it("strips a weight/usage suffix from the family name", () => {
    const result = checkFontFidelity({ display: "Clash Display (heavy grotesque)", body: "Inter" }, "@theme { --font-display: x; }", "/site");
    expect(result.families).toEqual(["Clash Display", "Inter"]);
  });
});

describe("checkBrandLint", () => {
  it("is permissive by default — an unconfigured brand allows em dashes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brand-lint-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "export const x = 'a — b';");
    const result = await checkBrandLint({ client: "x", tokens: { colors: {} }, fonts: { display: "A", body: "B" }, brandLaw: [], carryForward: [], references: [] }, [file], "/site");
    expect(result.hard).toHaveLength(0);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fails on an em dash when typography.forbidEmDash is explicitly set", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brand-lint-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "export const x = 'a — b';");
    const result = await checkBrandLint(
      { client: "x", tokens: { colors: {} }, fonts: { display: "A", body: "B" }, brandLaw: [], typography: { forbidEmDash: true }, carryForward: [], references: [] },
      [file],
      "/site",
    );
    expect(result.hard).toHaveLength(1);
    expect(result.hard[0]!.rule).toBe("em-dash");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("derives forbidEmDash from brandLaw prose when typography is unset", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brand-lint-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "export const x = 'a — b';");
    const result = await checkBrandLint(
      { client: "x", tokens: { colors: {} }, fonts: { display: "A", body: "B" }, brandLaw: ["No em dashes, ever."], carryForward: [], references: [] },
      [file],
      "/site",
    );
    expect(result.hard).toHaveLength(1);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("ignores an em dash inside a comment", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brand-lint-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "// a comment with an em dash — right here\nexport const x = 1;");
    const result = await checkBrandLint(
      { client: "x", tokens: { colors: {} }, fonts: { display: "A", body: "B" }, brandLaw: [], typography: { forbidEmDash: true }, carryForward: [], references: [] },
      [file],
      "/site",
    );
    expect(result.hard).toHaveLength(0);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe("checkStructure", () => {
  it("flags a component file with no export as a hard violation", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "structure-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "function Hero() { return <div />; }");
    const result = await checkStructure([file], "/site");
    expect(result.hard).toHaveLength(1);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("passes a well-formed exported component", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "structure-"));
    const file = path.join(tmp, "hero.tsx");
    await fs.writeFile(file, "export function Hero() { return (<div />); }");
    const result = await checkStructure([file], "/site");
    expect(result.hard).toHaveLength(0);
    expect(result.warn).toHaveLength(0);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe("checkCarryForward", () => {
  it("passes a placed item when its own section's content region shows structural evidence", () => {
    const placements = [{ what: "Coaching assistant that answers questions", section: "footer" }];
    const contentSource = 'footer: { carryForward: [{ type: "chatbot", label: "Coach" }] }, nav: {}';
    const result = checkCarryForward([{ type: "chatbot", what: "Coaching assistant that answers questions" }], placements, contentSource, undefined, undefined, "/site");
    expect(result.missing).toHaveLength(0);
  });

  it("passes a placed item when enough significant label words appear inside its own section's region", () => {
    const placements = [{ what: "Progress-tracking chart - weekly training volume over time", section: "signatureShowcase" }];
    const contentSource = "signatureShowcase: { caption: \"FORGE's progress graph, tracking volume over time\" }, hero: {}";
    const result = checkCarryForward(
      [{ type: "interactive-graph", what: "Progress-tracking chart - weekly training volume over time" }],
      placements,
      contentSource,
      undefined,
      undefined,
      "/site",
    );
    expect(result.missing).toHaveLength(0);
  });

  it("FAILS a placed item whose own section's content shows no evidence, even if the text appears elsewhere in the file", () => {
    const placements = [{ what: "Custom pricing configurator widget from the old dashboard", section: "offering" }];
    // the evidence lives in "hero", not the claimed "offering" section — must not leak across regions.
    const contentSource = 'offering: { plans: [] }, hero: { note: "Custom pricing configurator widget from the old dashboard" }';
    const result = checkCarryForward(
      [{ type: "configurator", what: "Custom pricing configurator widget from the old dashboard" }],
      placements,
      contentSource,
      undefined,
      undefined,
      "/site",
    );
    expect(result.missing).toEqual(["Custom pricing configurator widget from the old dashboard"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule).toBe("carry-forward-missing");
  });

  it("passes an unplaced item via a page.tsx floating-widget reference", () => {
    const pageTsxSource = 'const coach = c.carryForward?.find((w) => w.type === "chatbot"); return <>{coach && <CoachChatbot label={coach.label} />}</>;';
    const result = checkCarryForward([{ type: "chatbot", what: "Coaching launcher" }], [], undefined, pageTsxSource, undefined, "/site");
    expect(result.missing).toHaveLength(0);
  });

  it("FAILS an unplaced item when page.tsx merely mentions the type string with no JSX consumer nearby", () => {
    const pageTsxSource = '// TODO: someday wire up "chatbot" support';
    const result = checkCarryForward([{ type: "chatbot", what: "Coaching launcher" }], [], undefined, pageTsxSource, undefined, "/site");
    expect(result.missing).toEqual(["Coaching launcher"]);
  });

  it("falls back to a whole-site fuzzy scan only when no placement file exists at all (legacy/hand-authored sites)", () => {
    const allSiteText = 'carryForward: [{ type: "chatbot", label: "Coach" }]';
    const result = checkCarryForward([{ type: "chatbot", what: "Coaching assistant that answers questions" }], undefined, undefined, undefined, allSiteText, "/site");
    expect(result.missing).toHaveLength(0);
  });

  it("does NOT use the whole-site fallback once a placement file exists — closes the original vacuous-sidecar loophole", () => {
    // A placements array is present (even if empty) — this IS pipeline output, so the legacy
    // whole-site scan must never be consulted, even though the text is right there.
    const allSiteText = 'carryForward: [{ type: "chatbot", label: "Coach" }]';
    const result = checkCarryForward([{ type: "chatbot", what: "Coaching assistant that answers questions" }], [], undefined, undefined, allSiteText, "/site");
    expect(result.missing).toEqual(["Coaching assistant that answers questions"]);
  });

  it("FAILS the gate when a carry-forward item is nowhere in the output", () => {
    const result = checkCarryForward(
      [{ type: "configurator", what: "Custom pricing configurator widget from the old dashboard" }],
      [],
      undefined,
      undefined,
      undefined,
      "/site",
    );
    expect(result.missing).toEqual(["Custom pricing configurator widget from the old dashboard"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule).toBe("carry-forward-missing");
  });

  it("reports every missing item, not just the first", () => {
    const result = checkCarryForward(
      [
        { type: "chatbot", what: "Totally absent coaching widget" },
        { type: "graph", what: "Totally absent progress chart" },
      ],
      [],
      undefined,
      undefined,
      undefined,
      "/site",
    );
    expect(result.missing).toHaveLength(2);
  });
});
