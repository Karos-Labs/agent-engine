import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  composeDocument,
  composeRawDocument,
  createBundledTemplateStore,
  materializeTemplates,
  TemplateDefinitionSchema,
  type TemplateDefinition,
} from "../src/index.js";

/**
 * Phase 2, item M — the `extraHeadHtml` channel.
 *
 * The number-device stylesheet has to reach EVERY rendered document, and the
 * obvious-looking channel (fold it into the brand head fragment) is wrong for
 * exactly the clients that need it most: `buildBrandHeadHtml` only exists
 * when a client has a derivable brand kit, so a brandless client's devices
 * would have rendered as unstyled divs with nothing anywhere saying so.
 *
 * These tests pin the two properties that make the channel trustworthy: the
 * splice ORDER (which decides who wins a specificity tie) and the fact that a
 * brandless client still receives it.
 */

let repoRoot: string;
let bundledDir: string;

const DEVICE_SHEET = "<style>\n.dv-figure { white-space: nowrap; }\n</style>";
const BRAND_HEAD = "<style>\n:root { --accent: #d95f2b; }\n</style>";

const def = (over: Partial<TemplateDefinition> & { id: string; archetypeId: string }): TemplateDefinition =>
  TemplateDefinitionSchema.parse({
    name: over.id,
    layoutType: "typographic",
    htmlTemplate: "<html><head><style>.own { color: red }</style></head><body>{{headline}}</body></html>",
    source: "curated",
    ...over,
  });

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tpl-head-"));
  bundledDir = path.join(repoRoot, "bundled");
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.writeFile(path.join(bundledDir, "slide.html"), "<html><head><style>.own{}</style></head><body>{{headline}}{{image:hero}}</body></html>");
  await fs.writeFile(path.join(bundledDir, "stat-callout.html"), "<html><head><style>.own{}</style></head><body>{{figure}}</body></html>");
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("composeDocument: where extraHeadHtml lands", () => {
  it("splices after the template's own <style> and before the row's CSS and the brand head", () => {
    const html = composeDocument(def({ id: "r", archetypeId: "stat_callout", cssStyles: ".row { color: blue }" }), BRAND_HEAD, undefined, DEVICE_SHEET);

    const own = html.indexOf(".own { color: red }");
    const device = html.indexOf(".dv-figure");
    const row = html.indexOf(".row { color: blue }");
    const brand = html.indexOf("--accent: #d95f2b");

    // Later wins on an equal-specificity tie, which is the whole reason this
    // order is asserted rather than assumed: the shared sheet must be able to
    // reach a self-contained template, and must still lose to the template
    // row's own CSS and to the client's brand.
    expect(own).toBeGreaterThan(-1);
    expect(device).toBeGreaterThan(own);
    expect(row).toBeGreaterThan(device);
    expect(brand).toBeGreaterThan(row);
    expect(html.indexOf("</head>")).toBeGreaterThan(brand);
  });

  it("reaches a BRANDLESS client's document — the defect this parameter exists to prevent", () => {
    const html = composeDocument(def({ id: "r", archetypeId: "stat_callout" }), undefined, undefined, DEVICE_SHEET);
    expect(html).toContain(".dv-figure");
    expect(html).not.toContain("--accent: #d95f2b");
  });

  it("is inert when omitted, so every existing caller's output is byte-identical", () => {
    const definition = def({ id: "r", archetypeId: "stat_callout" });
    expect(composeDocument(definition, undefined, undefined, undefined)).toBe(definition.htmlTemplate);
    expect(composeDocument(definition, undefined, undefined, "   ")).toBe(definition.htmlTemplate);
    expect(composeDocument(definition, BRAND_HEAD)).toBe(composeDocument(definition, BRAND_HEAD, undefined, undefined));
  });

  it("still reaches a document with no </head> to target", () => {
    const fragmentOnly = def({ id: "r", archetypeId: "stat_callout", htmlTemplate: "<div>{{headline}}</div>" });
    expect(composeDocument(fragmentOnly, undefined, undefined, DEVICE_SHEET)).toContain(".dv-figure");
  });
});

describe("composeRawDocument: the same order for a raw file", () => {
  it("splices the shared sheet before the brand head", () => {
    const html = composeRawDocument("<html><head><style>.own{}</style></head><body></body></html>", BRAND_HEAD, undefined, DEVICE_SHEET);
    expect(html.indexOf(".dv-figure")).toBeGreaterThan(html.indexOf(".own{}"));
    expect(html.indexOf("--accent: #d95f2b")).toBeGreaterThan(html.indexOf(".dv-figure"));
  });

  it("reaches a brandless client's own base template", () => {
    const html = composeRawDocument("<html><head></head><body></body></html>", undefined, undefined, DEVICE_SHEET);
    expect(html).toContain(".dv-figure");
  });
});

describe("materializeTemplates: every written file carries it", () => {
  it("writes the shared sheet into both the registry rows and the copied client base template", async () => {
    const result = await materializeTemplates({
      store: createBundledTemplateStore({ templateDir: bundledDir }),
      repoRoot,
      runId: "run-extra-head",
      clientSlug: "acme",
      clientTemplateDir: "bundled",
      clientTemplateFile: "slide.html",
      extraHeadHtml: DEVICE_SHEET,
    });

    const written = Object.values(result.files);
    expect(written).toContain("stat-callout.html");
    expect(written).toContain("slide.html");
    for (const file of written) {
      const html = await fs.readFile(path.join(repoRoot, result.templateDir, file), "utf8");
      expect(html, `${file} lost the shared device sheet`).toContain(".dv-figure");
    }
  });

  it("omitting it leaves every written file byte-identical to the no-brand path", async () => {
    const store = createBundledTemplateStore({ templateDir: bundledDir });
    const withOut = await materializeTemplates({ store, repoRoot, runId: "a", clientSlug: "acme", clientTemplateDir: "bundled", clientTemplateFile: "slide.html" });
    const original = await fs.readFile(path.join(bundledDir, "stat-callout.html"), "utf8");
    const materialized = await fs.readFile(path.join(repoRoot, withOut.templateDir, "stat-callout.html"), "utf8");
    expect(materialized).toBe(original);
  });
});
