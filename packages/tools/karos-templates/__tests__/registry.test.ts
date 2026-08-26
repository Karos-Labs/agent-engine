import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_ARCHETYPES,
  composeDocument,
  createBundledTemplateStore,
  createCompositeTemplateStore,
  createFirestoreTemplateStore,
  createTemplateStore,
  extractSupportedFields,
  materializeTemplates,
  MemoryTemplateStore,
  promoteTemplate,
  QUALITY_DELTA,
  resolveBest,
  reviewTemplate,
  TemplateDefinitionSchema,
  TemplateStoreError,
  type FirestoreLike,
  type TemplateDefinition,
} from "../src/index.js";

let repoRoot: string;
let bundledDir: string;

const def = (over: Partial<TemplateDefinition> & { id: string; archetypeId: string }): TemplateDefinition =>
  TemplateDefinitionSchema.parse({
    name: over.id,
    layoutType: "typographic",
    htmlTemplate: "<html><head></head><body>{{headline}}</body></html>",
    source: "curated",
    ...over,
  });

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tpl-"));
  bundledDir = path.join(repoRoot, "bundled");
  await fs.mkdir(bundledDir, { recursive: true });
  // A realistic bundled set: the client base plus two archetypes.
  await fs.writeFile(path.join(bundledDir, "slide.html"), "<html><head></head><body>{{headline}}{{image:hero}}</body></html>");
  await fs.writeFile(path.join(bundledDir, "stat-callout.html"), "<html><head></head><body>{{figure}}{{sourceLine}}</body></html>");
  await fs.writeFile(path.join(bundledDir, "list-takeaway.html"), "<html><head></head><body>{{html:itemRows}}</body></html>");
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("bundled store: the read-only floor", () => {
  it("reads the on-disk archetypes as legacy rows and derives their supported fields", async () => {
    const rows = await createBundledTemplateStore({ templateDir: bundledDir }).list();
    const byArchetype = new Map(rows.map((r) => [r.archetypeId, r]));

    expect([...byArchetype.keys()].sort()).toEqual(["list_takeaway", "photo", "stat_callout"]);
    expect(byArchetype.get("stat_callout")!.source).toBe("legacy");
    expect(byArchetype.get("stat_callout")!.supportedFields.sort()).toEqual(["figure", "sourceLine"]);
    // The `photo` archetype is the only one that consumes an image.
    expect(byArchetype.get("photo")!.layoutType).toBe("photo");
    expect(byArchetype.get("list_takeaway")!.layoutType).toBe("typographic");
    // `{{html:itemRows}}` is a real consumed slot, not markup to ignore.
    expect(byArchetype.get("list_takeaway")!.supportedFields).toEqual(["itemRows"]);
  });

  it("skips a bundled archetype whose file is absent rather than failing the whole read", async () => {
    const rows = await createBundledTemplateStore({ templateDir: bundledDir }).list();
    // quote_card / comparison_card / headline_focus were never written above.
    expect(rows.map((r) => r.archetypeId)).not.toContain("quote_card");
    expect(rows.length).toBeGreaterThan(0);
  });

  // A promotion that reported success and then vanished on the next deploy is
  // worse than one that failed loudly.
  it("refuses writes, because a container filesystem is not a database", async () => {
    const store = createBundledTemplateStore({ templateDir: bundledDir });
    await expect(store.save(def({ id: "x", archetypeId: "quote_card" }))).rejects.toThrow(TemplateStoreError);
    await expect(
      store.recordFeedback("bundled:stat_callout", { at: 1, actor: "a", verdict: "approved", note: "n" }, 5),
    ).rejects.toThrow(TemplateStoreError);
  });

  it("declares an archetype's layoutType rather than inferring it from the filename", () => {
    // Renaming a file must not silently flip whether its slides pay for image
    // sourcing, so the mapping is explicit.
    expect(BUNDLED_ARCHETYPES.find((a) => a.archetypeId === "photo")!.photo).toBe(true);
    expect(BUNDLED_ARCHETYPES.every((a) => a.archetypeId === "photo" || !a.photo)).toBe(true);
  });
});

describe("resolveBest: which template wins an archetype", () => {
  it("picks the highest quality score", () => {
    const best = resolveBest([
      def({ id: "a", archetypeId: "stat_callout", qualityScore: 40 }),
      def({ id: "b", archetypeId: "stat_callout", qualityScore: 80 }),
    ]);
    expect(best.get("stat_callout")!.id).toBe("b");
  });

  it("prefers a client-scoped template over a global one at equal score", () => {
    const best = resolveBest([
      def({ id: "global", archetypeId: "quote_card", qualityScore: 60 }),
      def({ id: "scoped", archetypeId: "quote_card", qualityScore: 60, clientSlug: "acme" }),
    ]);
    expect(best.get("quote_card")!.id).toBe("scoped");
  });

  it("breaks a full tie deterministically, so two runs of one input cannot differ", () => {
    const rows = [def({ id: "bbb", archetypeId: "x", qualityScore: 50 }), def({ id: "aaa", archetypeId: "x", qualityScore: 50 })];
    expect(resolveBest(rows).get("x")!.id).toBe("aaa");
    expect(resolveBest([...rows].reverse()).get("x")!.id).toBe("aaa");
  });

  it("ignores a retired template entirely", () => {
    const best = resolveBest([def({ id: "off", archetypeId: "x", qualityScore: 99, enabled: false })]);
    expect(best.has("x")).toBe(false);
  });
});

describe("curated client sets: what scripts/seed-client-templates.ts writes", () => {
  // The exact row shape the seeder publishes: source "curated", client-scoped,
  // EXPLICIT score above the legacy floor (70). The score is the load-bearing
  // part — resolveBest compares score FIRST and client scope only tie-breaks.
  const curated = (score: number) =>
    def({
      id: "curated__acme__stat_callout",
      archetypeId: "stat_callout",
      qualityScore: score,
      clientSlug: "acme",
      htmlTemplate: "<html><head></head><body>ACME CURATED {{figure}}</body></html>",
    });

  it("a curated row at the seeder's default 75 WINS materialization for its client over the bundled floor", async () => {
    const remote = new MemoryTemplateStore([{ ...curated(75), source: "curated" }]);
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), remote]);
    const best = resolveBest(await composite.list({ clientSlug: "acme" }));
    expect(best.get("stat_callout")!.id).toBe("curated__acme__stat_callout");
  });

  it("stays invisible to every other client — their runs keep the bundled floor", async () => {
    const remote = new MemoryTemplateStore([{ ...curated(75), source: "curated" }]);
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), remote]);
    const best = resolveBest(await composite.list({ clientSlug: "globex" }));
    expect(best.get("stat_callout")!.id).toBe("bundled:stat_callout");
  });

  it("NEGATIVE: seeded at the curated source default (60) it silently loses to the bundled 70 — the mistake the explicit score exists to prevent", async () => {
    const remote = new MemoryTemplateStore([{ ...curated(60), source: "curated" }]);
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), remote]);
    const best = resolveBest(await composite.list({ clientSlug: "acme" }));
    expect(best.get("stat_callout")!.id).toBe("bundled:stat_callout");
  });
});

describe("composite store: a remote layer can never take rendering down", () => {
  it("absorbs a failing layer and still returns the bundled floor", async () => {
    const exploding = {
      name: "exploding",
      async list(): Promise<TemplateDefinition[]> {
        throw new Error("firestore unreachable");
      },
      async get() {
        throw new Error("firestore unreachable");
      },
      async save() {},
      async recordFeedback() {},
    };
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), exploding]);
    const rows = await composite.list();
    expect(rows.map((r) => r.archetypeId)).toContain("stat_callout");
  });

  it("lets a higher-scored remote template displace the bundled one", async () => {
    const remote = new MemoryTemplateStore([
      def({ id: "remote:stat", archetypeId: "stat_callout", qualityScore: 95, htmlTemplate: "<html><head></head><body>REMOTE</body></html>" }),
    ]);
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), remote]);
    const best = resolveBest(await composite.list());
    expect(best.get("stat_callout")!.id).toBe("remote:stat");
    // And the bundled one is still present as a fallback, not overwritten.
    expect((await composite.list()).filter((r) => r.archetypeId === "stat_callout")).toHaveLength(2);
  });

  it("routes writes to the most persistent layer, never the read-only floor", async () => {
    const remote = new MemoryTemplateStore();
    const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), remote]);
    await composite.save(def({ id: "new", archetypeId: "quote_card" }));
    expect(await remote.get("new")).toBeDefined();
  });
});

describe("materializeTemplates: Approach (a)", () => {
  it("writes the winning templates into a bounds-checked per-run directory and reports what it chose", async () => {
    const store = createTemplateStore({ bundledTemplateDir: bundledDir });
    const result = await materializeTemplates({
      store,
      repoRoot,
      runId: "run_1",
      clientSlug: "acme",
      clientTemplateDir: "bundled",
      clientTemplateFile: "slide.html",
    });

    expect(result.templateDir).toBe(".template-cache/run_1");
    // The archetypes, plus the client's own base template copied alongside so
    // ONE templateDir holds everything the renderer will ask for.
    const written = (await fs.readdir(path.join(repoRoot, result.templateDir))).sort();
    expect(written).toEqual(["list-takeaway.html", "slide.html", "stat-callout.html"]);
    expect(result.files["stat_callout"]).toBe("stat-callout.html");
    expect(result.files["photo"]).toBe("slide.html");
    expect(result.typographicArchetypes.sort()).toEqual(["list_takeaway", "stat_callout"]);
    expect(result.chosen.find((c) => c.archetypeId === "stat_callout")).toMatchObject({ source: "legacy", qualityScore: 70 });
  });

  it("refuses a runId that would escape repoRoot", async () => {
    const store = createTemplateStore({ bundledTemplateDir: bundledDir });
    await expect(
      materializeTemplates({ store, repoRoot, runId: "../../escape", clientSlug: "acme" }),
    ).rejects.toThrow(/escaped repoRoot/);
  });

  it("survives a missing client base template, reporting it by omission rather than throwing", async () => {
    const store = createTemplateStore({ bundledTemplateDir: bundledDir });
    const result = await materializeTemplates({
      store,
      repoRoot,
      runId: "run_2",
      clientSlug: "acme",
      clientTemplateDir: "bundled",
      clientTemplateFile: "does-not-exist.html",
    });
    expect(result.files["photo"]).toBeUndefined();
    // The archetypes still materialized, so the run can still ship.
    expect(result.files["stat_callout"]).toBe("stat-callout.html");
  });

  it("materializes a bundled row byte-identically, so switching to the registry changes no pixels", async () => {
    const original = await fs.readFile(path.join(bundledDir, "stat-callout.html"), "utf8");
    const store = createTemplateStore({ bundledTemplateDir: bundledDir });
    const result = await materializeTemplates({ store, repoRoot, runId: "run_3", clientSlug: "acme" });
    const materialized = await fs.readFile(path.join(repoRoot, result.templateDir, result.files["stat_callout"]!), "utf8");
    expect(materialized).toBe(original);
  });

  it("picks up a template promoted after this run, with no archetypeIds filter and no code change", async () => {
    // Requirement: "04c-resolve-templates" (which calls materializeTemplates
    // with no archetypeIds filter, same as here) considers newly promoted
    // templates for FUTURE runs. Nothing about materializeTemplates/
    // resolveBest is archetype-aware — this proves a run-generated custom
    // archetype, once promoted into the SAME store, is fetched, ranked, and
    // written out by a later, independent materializeTemplates call, exactly
    // like any bundled or curated row already is.
    const store = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), new MemoryTemplateStore()]);
    await promoteTemplate({
      store,
      archetypeId: "custom_diagonal_stat",
      name: "Diagonal stat callout",
      htmlTemplate: "<html><head></head><body>{{headline}}</body></html>",
      layoutType: "typographic",
      source: "ai_generated",
      clientSlug: "acme",
      actor: "jane@karoslabs.com",
      note: "promoted from a live run",
      now: 1_700_000_000_000,
    });

    const later = await materializeTemplates({ store, repoRoot, runId: "run_later", clientSlug: "acme" });
    expect(later.files["custom_diagonal_stat"]).toBe("custom-diagonal-stat.html");
    expect(later.chosen.find((c) => c.archetypeId === "custom_diagonal_stat")).toMatchObject({ source: "ai_generated" });
    const written = await fs.readFile(path.join(repoRoot, later.templateDir, later.files["custom_diagonal_stat"]!), "utf8");
    expect(written).toContain("{{headline}}");
  });

  it("composes separate cssStyles into the document head, after the template's own style block", () => {
    const composed = composeDocument(
      def({
        id: "c",
        archetypeId: "x",
        htmlTemplate: "<html><head><style>.a{color:red}</style></head><body></body></html>",
        cssStyles: ".a{color:blue}",
      }),
    );
    // Later in the head means it wins specificity ties, which is what makes a
    // shared token sheet able to override a template's own defaults.
    expect(composed.indexOf(".a{color:blue}")).toBeGreaterThan(composed.indexOf(".a{color:red}"));
    expect(composed).toContain("</head>");
  });

  it("splices the brand head fragment LAST, so the client's brand beats both the template and the registry row", () => {
    const composed = composeDocument(
      def({
        id: "c",
        archetypeId: "x",
        htmlTemplate: "<html><head><style>.a{color:red}</style></head><body></body></html>",
        cssStyles: ".a{color:blue}",
      }),
      `<style>:root{--bg:#F5F0E4}</style>`,
    );
    expect(composed.indexOf("--bg:#F5F0E4")).toBeGreaterThan(composed.indexOf(".a{color:blue}"));
    // And with no brand fragment (or an empty one), output is byte-identical
    // to what it always was — a brandless deployment changes nothing.
    const row = def({ id: "c", archetypeId: "x", htmlTemplate: "<html><head></head><body></body></html>" });
    expect(composeDocument(row, undefined)).toBe(composeDocument(row));
    expect(composeDocument(row, "")).toBe(composeDocument(row));
  });

  it("materializes the brand head into every written file, INCLUDING the copied client base template", async () => {
    const store = createTemplateStore({ bundledTemplateDir: bundledDir });
    const brandHeadHtml = `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap" rel="stylesheet">\n<style>:root{--bg:#272A35;--fg:#F4F2EC}</style>`;
    const result = await materializeTemplates({
      store,
      repoRoot,
      runId: "run_branded",
      clientSlug: "acme",
      clientTemplateDir: "bundled",
      clientTemplateFile: "slide.html",
      brandHeadHtml,
    });

    const archetype = await fs.readFile(path.join(repoRoot, result.templateDir, result.files["stat_callout"]!), "utf8");
    expect(archetype).toContain("--bg:#272A35");
    // The base template used to be a raw fs.copyFile — a branded carousel's
    // photo slides would have stayed on the generic tokens while every
    // archetype re-themed.
    const base = await fs.readFile(path.join(repoRoot, result.templateDir, result.files["photo"]!), "utf8");
    expect(base).toContain("--bg:#272A35");
    expect(base).toContain("family=Space+Grotesk");
  });
});

describe("firestore store", () => {
  /** A plain-object Firestore double, which is the whole point of the narrowed FirestoreLike seam. */
  function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
    const rows: Record<string, Record<string, unknown>> = { ...seed };
    const db: FirestoreLike = {
      collection: () => ({
        doc: (id: string) => ({
          async get() {
            return { exists: rows[id] !== undefined, data: () => rows[id] };
          },
          async set(data: Record<string, unknown>) {
            rows[id] = { ...rows[id], ...data };
            return undefined;
          },
        }),
        async get() {
          return { docs: Object.entries(rows).map(([id, data]) => ({ id, data: () => data })) };
        },
      }),
    };
    return { db, rows };
  }

  it("round-trips a template, keeping the document id out of the body", async () => {
    const { db, rows } = fakeDb();
    const store = createFirestoreTemplateStore(db);
    await store.save(def({ id: "t1", archetypeId: "quote_card", qualityScore: 55 }));
    expect(rows["t1"]).toBeDefined();
    expect(rows["t1"]!["id"]).toBeUndefined(); // one copy of that fact, not two
    expect((await store.get("t1"))!.qualityScore).toBe(55);
  });

  it("skips a malformed row instead of failing every other template with it", async () => {
    const { db } = fakeDb({
      good: def({ id: "good", archetypeId: "quote_card" }) as unknown as Record<string, unknown>,
      broken: { archetypeId: "stat_callout" /* no name, no htmlTemplate, no source */ },
    });
    const rows = await createFirestoreTemplateStore(db).list();
    expect(rows.map((r) => r.id)).toEqual(["good"]);
  });

  it("reports a store outage as TemplateStoreError so a caller can classify it as tooling", async () => {
    const db: FirestoreLike = {
      collection: () => ({
        doc: () => ({
          async get(): Promise<never> {
            throw new Error("deadline exceeded");
          },
          async set() {
            return undefined;
          },
        }),
        async get(): Promise<never> {
          throw new Error("deadline exceeded");
        },
      }),
    };
    await expect(createFirestoreTemplateStore(db).list()).rejects.toThrow(TemplateStoreError);
  });
});

describe("promotion and review: the flywheel", () => {
  it("promotes an approved run-generated template, recording who let it in", async () => {
    const store = new MemoryTemplateStore();
    const promoted = await promoteTemplate({
      store,
      archetypeId: "stat_callout",
      name: "Tall figure variant",
      htmlTemplate: "<html><head></head><body>{{figure}}{{subLabel}}</body></html>",
      layoutType: "typographic",
      source: "ai_generated",
      actor: "jane@karoslabs.com",
      note: "the tighter figure reads better at feed size",
      now: 1_700_000_000_000,
    });

    expect(promoted.source).toBe("ai_generated");
    expect(promoted.supportedFields.sort()).toEqual(["figure", "subLabel"]);
    // A template can never exist in the registry with no record of approval.
    expect(promoted.feedback).toHaveLength(1);
    expect(promoted.feedback[0]).toMatchObject({ actor: "jane@karoslabs.com", verdict: "approved" });
    expect(await store.get(promoted.id)).toBeDefined();
  });

  // One person liking one render is evidence, not proof.
  it("opens an AI-generated template BELOW the bundled floor, so it must earn its way in", async () => {
    const store = new MemoryTemplateStore();
    const promoted = await promoteTemplate({
      store,
      archetypeId: "stat_callout",
      name: "v",
      htmlTemplate: "<html><head></head><body>{{figure}}</body></html>",
      layoutType: "typographic",
      source: "ai_generated",
      actor: "a",
      now: 1,
    });
    expect(promoted.qualityScore).toBe(40);

    const bundled = createBundledTemplateStore({ templateDir: bundledDir });
    const best = resolveBest([...(await bundled.list()), promoted]);
    // The verified bundled design still wins until the new one accumulates approvals.
    expect(best.get("stat_callout")!.source).toBe("legacy");
  });

  it("climbs on approvals and falls faster on revisions", async () => {
    const store = new MemoryTemplateStore([def({ id: "t", archetypeId: "x", qualityScore: 50 })]);
    await reviewTemplate({ store, templateId: "t", actor: "a", verdict: "approved", note: "good", now: 2 });
    expect((await store.get("t"))!.qualityScore).toBe(50 + QUALITY_DELTA.approved);
    await reviewTemplate({ store, templateId: "t", actor: "a", verdict: "revise", note: "cramped", now: 3 });
    expect((await store.get("t"))!.qualityScore).toBe(50 + QUALITY_DELTA.approved + QUALITY_DELTA.revise);
    expect((await store.get("t"))!.feedback).toHaveLength(2);
  });

  it("clamps the score to the scale, so a streak cannot make later comparisons meaningless", async () => {
    const store = new MemoryTemplateStore([def({ id: "t", archetypeId: "x", qualityScore: 98 })]);
    for (let i = 0; i < 5; i++) {
      await reviewTemplate({ store, templateId: "t", actor: "a", verdict: "approved", note: "good", now: 10 + i });
    }
    expect((await store.get("t"))!.qualityScore).toBe(100);
  });

  it("refuses feedback on a template that is not there", async () => {
    await expect(
      reviewTemplate({ store: new MemoryTemplateStore(), templateId: "ghost", actor: "a", verdict: "approved", note: "n", now: 1 }),
    ).rejects.toThrow(TemplateStoreError);
  });
});

describe("extractSupportedFields", () => {
  it("finds all three slot forms and dedupes", () => {
    expect(
      extractSupportedFields("{{headline}} {{headline}} {{html:rows}} {{image:hero}}").sort(),
    ).toEqual(["headline", "hero", "rows"]);
  });
});
