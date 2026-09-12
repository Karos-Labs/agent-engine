import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBundledTemplateStore,
  createCompositeTemplateStore,
  createFirestoreTemplateStore,
  DEFAULT_QUALITY_BY_SOURCE,
  DEFAULT_QUALITY_STUDIO,
  MemoryTemplateStore,
  materializeTemplates,
  promoteTemplate,
  resolveBest,
  setTemplateEnabled,
  TemplateDefinitionSchema,
  TemplateStoreError,
  type FirestoreLike,
  type TemplateDefinition,
  type TemplateDerivedFrom,
} from "../src/index.js";

/**
 * The Template Studio's storage contract (instagram-agent item N): a
 * per-client generated template is a BETTER IMPLEMENTATION OF A ROUTABLE
 * ARCHETYPE for one client, stored disabled at a score deliberately below the
 * bundled floor, carrying the evidence that justified it.
 *
 * Three claims are proved here, because all three are load-bearing and all
 * three were argued rather than measured in the design:
 *
 *  1. `enabled: false` really is the approval gate — invisible to
 *     `resolveBest` AND to `materializeTemplates`, with no new filter.
 *  2. 65 really does lose to the bundled 70, and 70 really would have WON on
 *     `beats()`'s client-scope tiebreak. That second half is why the number is
 *     65 and not "the same as bundled".
 *  3. `setTemplateEnabled` leaves both facts (the flag, the reason) on one
 *     row, and a replay leaves exactly one.
 */

const HERO_FORMAT: TemplateDerivedFrom = {
  formatLabel: "stat-led cover",
  accounts: ["instagram/@peer_one", "instagram/@peer_two"],
  postCount: 14,
  normalisedScore: 1.42,
  signalsAvailable: ["likes", "comments"],
  signalsAbsent: ["views absent for 2 of 2 accounts"],
  exampleUrls: ["https://example.com/p/1", "https://example.com/p/2"],
  why: "the highest-scoring posts on both peer accounts open on a single figure over a photograph, never on a headline alone",
};

async function studioRow(
  store: MemoryTemplateStore | ReturnType<typeof createCompositeTemplateStore>,
  over: { archetypeId?: string; clientSlug?: string; qualityScore?: number; enabled?: boolean } = {},
): Promise<TemplateDefinition> {
  return promoteTemplate({
    store,
    id: `studio:${over.clientSlug ?? "acme"}:${over.archetypeId ?? "stat_callout"}`,
    archetypeId: over.archetypeId ?? "stat_callout",
    name: "Studio stat callout",
    htmlTemplate: "<!doctype html><html><head></head><body>{{figure}}{{sourceLine}}</body></html>",
    cssStyles: ".figure { font-family: var(--f-display); }",
    layoutType: "typographic",
    source: "ai_generated",
    clientSlug: over.clientSlug ?? "acme",
    actor: "studio",
    note: "generated at setup from the stat-led cover format; awaiting approval",
    now: 1_700_000_000_000,
    qualityScore: over.qualityScore ?? DEFAULT_QUALITY_STUDIO,
    enabled: over.enabled ?? false,
    derivedFrom: HERO_FORMAT,
    role: over.archetypeId === "cover" ? "cover" : "interior",
  });
}

describe("the studio score: 65, and why not 70", () => {
  it("opens strictly below the bundled floor, and above an unvalidated run-authored fragment", () => {
    expect(DEFAULT_QUALITY_STUDIO).toBeLessThan(DEFAULT_QUALITY_BY_SOURCE.legacy);
    expect(DEFAULT_QUALITY_STUDIO).toBeGreaterThan(DEFAULT_QUALITY_BY_SOURCE.ai_generated);
  });

  it("LOSES to the bundled row of the same archetype, even enabled — a generated design never silently displaces a verified one", async () => {
    const store = new MemoryTemplateStore();
    const row = await studioRow(store, { enabled: true });
    const bundled = TemplateDefinitionSchema.parse({
      id: "bundled:stat_callout",
      archetypeId: "stat_callout",
      name: "Stat callout",
      layoutType: "typographic",
      htmlTemplate: "<html><head></head><body>{{figure}}</body></html>",
      qualityScore: DEFAULT_QUALITY_BY_SOURCE.legacy,
      source: "legacy",
    });
    expect(resolveBest([bundled, row]).get("stat_callout")!.id).toBe("bundled:stat_callout");
  });

  it("WINS when the bundled file for that archetype is absent — the studio adds reach, it does not fight the floor", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tpl-studio-"));
    try {
      // A bundled set that ships no `cover.html` for this deployment.
      await fs.writeFile(path.join(dir, "stat-callout.html"), "<html><head></head><body>{{figure}}</body></html>");
      const memory = new MemoryTemplateStore();
      const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: dir }), memory]);
      await studioRow(memory, { archetypeId: "cover", enabled: true });
      const best = resolveBest(await composite.list({ clientSlug: "acme" }));
      expect(best.get("cover")!.id).toBe("studio:acme:cover");
      expect(best.get("stat_callout")!.source).toBe("legacy");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // The negative half of the argument, asserted rather than asserted-in-prose:
  // at 70 the studio row would beat the bundled row it TIES with, because
  // `beats()` awards an equal score to the client-scoped candidate. Human
  // approval would then be decorative — the row would already be rendering.
  it("at exactly 70 it would beat the bundled row on the clientSlug tiebreak — the reason the constant is 65", async () => {
    const store = new MemoryTemplateStore();
    const at70 = await studioRow(store, { qualityScore: DEFAULT_QUALITY_BY_SOURCE.legacy, enabled: true });
    const bundled = TemplateDefinitionSchema.parse({
      id: "bundled:stat_callout",
      archetypeId: "stat_callout",
      name: "Stat callout",
      layoutType: "typographic",
      htmlTemplate: "<html><head></head><body>{{figure}}</body></html>",
      qualityScore: DEFAULT_QUALITY_BY_SOURCE.legacy,
      source: "legacy",
    });
    expect(at70.qualityScore).toBe(bundled.qualityScore);
    expect(resolveBest([bundled, at70]).get("stat_callout")!.id).toBe("studio:acme:stat_callout");
  });
});

describe("enabled: false is the approval gate", () => {
  it("is invisible to resolveBest while the row still exists for the portal to show", async () => {
    const store = new MemoryTemplateStore();
    const row = await studioRow(store);
    expect(row.enabled).toBe(false);
    expect(resolveBest([row]).has("stat_callout")).toBe(false);
    // Still readable by id, and still listable with includeDisabled — the
    // portal has to be able to show what was generated.
    expect(await store.get(row.id)).toBeDefined();
    expect((await store.list({ clientSlug: "acme", includeDisabled: true })).map((r) => r.id)).toEqual([row.id]);
    expect(await store.list({ clientSlug: "acme" })).toEqual([]);
  });

  it("is invisible to materializeTemplates, so a run before approval renders the bundled set", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-tpl-mat-"));
    try {
      const bundledDir = path.join(repoRoot, "bundled");
      await fs.mkdir(bundledDir, { recursive: true });
      await fs.writeFile(path.join(bundledDir, "stat-callout.html"), "BUNDLED {{figure}}");
      const memory = new MemoryTemplateStore();
      const composite = createCompositeTemplateStore([createBundledTemplateStore({ templateDir: bundledDir }), memory]);
      // A studio row scored ABOVE the bundled floor, so only `enabled` can be
      // what keeps it out of the render.
      await studioRow(memory, { qualityScore: 95, enabled: false });

      const before = await materializeTemplates({ store: composite, repoRoot, runId: "run_pre_approval", clientSlug: "acme" });
      expect(before.chosen.find((c) => c.archetypeId === "stat_callout")).toMatchObject({ templateId: "bundled:stat_callout" });
      expect(await fs.readFile(path.join(repoRoot, before.templateDir, "stat-callout.html"), "utf8")).toContain("BUNDLED");

      await setTemplateEnabled(memory, "studio:acme:stat_callout", true, "owner@karoslabs.com", "approved the studio set at review", 1_700_000_100_000);

      const after = await materializeTemplates({ store: composite, repoRoot, runId: "run_post_approval", clientSlug: "acme" });
      expect(after.chosen.find((c) => c.archetypeId === "stat_callout")).toMatchObject({ templateId: "studio:acme:stat_callout" });
      expect(await fs.readFile(path.join(repoRoot, after.templateDir, "stat-callout.html"), "utf8")).toContain("{{figure}}");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("derivedFrom and role: the evidence travels with the row", () => {
  it("round-trips through the memory store, including an ABSENT normalisedScore", async () => {
    const store = new MemoryTemplateStore();
    await studioRow(store);
    const read = (await store.get("studio:acme:stat_callout"))!;
    expect(read.role).toBe("interior");
    expect(read.derivedFrom).toEqual(HERO_FORMAT);

    // The honest-ranking case: no numeric engagement field existed anywhere,
    // so there is NO score and the absence is named. The schema must accept
    // this shape, because the alternative is a caller inventing a number.
    const scoreless = await promoteTemplate({
      store,
      id: "studio:acme:closer",
      archetypeId: "closer",
      name: "Studio closer",
      htmlTemplate: "<html><head></head><body>{{takeaway}}</body></html>",
      layoutType: "typographic",
      source: "ai_generated",
      clientSlug: "acme",
      actor: "studio",
      note: "generated at setup; ranking was qualitative",
      now: 1_700_000_000_000,
      qualityScore: DEFAULT_QUALITY_STUDIO,
      enabled: false,
      role: "closer",
      derivedFrom: {
        formatLabel: "question closer",
        accounts: ["reddit/@r_example"],
        postCount: 5,
        signalsAvailable: [],
        signalsAbsent: ["likes, comments and views absent for 1 of 1 accounts — the ranking is qualitative"],
        exampleUrls: [],
        why: "every closing slide on the one readable account ends on a question",
      },
    });
    expect(scoreless.derivedFrom?.normalisedScore).toBeUndefined();
    expect(scoreless.derivedFrom?.signalsAvailable).toEqual([]);
  });

  it("round-trips through Firestore's serialisation, which strips only the id", async () => {
    const rows: Record<string, Record<string, unknown>> = {};
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
    const store = createFirestoreTemplateStore(db);
    await studioRow(store as unknown as MemoryTemplateStore);
    const read = (await store.get("studio:acme:stat_callout"))!;
    expect(read.derivedFrom?.formatLabel).toBe("stat-led cover");
    expect(read.role).toBe("interior");
    expect(read.enabled).toBe(false);
  });

  it("leaves every pre-studio row byte-identical: both fields are additive and optional", () => {
    const legacy = TemplateDefinitionSchema.parse({
      id: "bundled:quote_card",
      archetypeId: "quote_card",
      name: "Quote card",
      layoutType: "typographic",
      htmlTemplate: "<html><head></head><body>{{quoteText}}</body></html>",
      source: "legacy",
    });
    expect(legacy.derivedFrom).toBeUndefined();
    expect(legacy.role).toBeUndefined();
    expect(legacy.enabled).toBe(true);
  });
});

describe("setTemplateEnabled: the flag and the reason on one row", () => {
  it("writes both the row and a feedback entry, and moves no score", async () => {
    const store = new MemoryTemplateStore();
    await studioRow(store);
    const result = await setTemplateEnabled(store, "studio:acme:stat_callout", true, "owner@karoslabs.com", "approved at the first review gate", 1_700_000_200_000);

    expect(result.changed).toBe(true);
    const read = (await store.get("studio:acme:stat_callout"))!;
    expect(read.enabled).toBe(true);
    // The generation note, then the approval — two entries, one row.
    expect(read.feedback).toHaveLength(2);
    expect(read.feedback[1]).toMatchObject({ actor: "owner@karoslabs.com", verdict: "approved", note: "approved at the first review gate", at: 1_700_000_200_000 });
    // Enabling is not a judgment about how good the design is: the studio
    // already priced that, and `reviewTemplate` is what moves it.
    expect(read.qualityScore).toBe(DEFAULT_QUALITY_STUDIO);
  });

  it("is idempotent — a replayed review step adds no second note", async () => {
    const store = new MemoryTemplateStore();
    await studioRow(store);
    await setTemplateEnabled(store, "studio:acme:stat_callout", true, "owner@karoslabs.com", "approved", 1_700_000_200_000);
    const again = await setTemplateEnabled(store, "studio:acme:stat_callout", true, "owner@karoslabs.com", "approved", 1_700_000_300_000);

    expect(again.changed).toBe(false);
    const read = (await store.get("studio:acme:stat_callout"))!;
    expect(read.feedback).toHaveLength(2);
    expect(read.updatedAt).toBe(1_700_000_200_000);
  });

  it("can retire a row again, recording that as a revise", async () => {
    const store = new MemoryTemplateStore();
    await studioRow(store, { enabled: true });
    await setTemplateEnabled(store, "studio:acme:stat_callout", false, "owner@karoslabs.com", "the cover reads too dark on mobile", 1_700_000_400_000);
    const read = (await store.get("studio:acme:stat_callout"))!;
    expect(read.enabled).toBe(false);
    expect(read.feedback.at(-1)).toMatchObject({ verdict: "revise" });
    expect(resolveBest([read]).has("stat_callout")).toBe(false);
  });

  it("refuses a template that is not there rather than creating one", async () => {
    await expect(setTemplateEnabled(new MemoryTemplateStore(), "ghost", true, "a", "n", 1)).rejects.toThrow(TemplateStoreError);
  });
});
